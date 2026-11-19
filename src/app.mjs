import { browse, retrieve, retrieveRelations } from './source.mjs';
import { interpret } from './interpret.mjs';
import { assess, summarize } from './receiving.mjs';
import { interpretRelations, cycleFor } from './relations.mjs';
import { negotiateBody, negotiateAppendix } from './history.mjs';

export async function preview(client) {
  const manifest = await browse(client);
  const entries = [];
  for (const ref of manifest.references) {
    const document = await retrieve(client, ref);
    entries.push(interpret(document.raw));
  }
  return { context: manifest.context, entries };
}

export async function collect(client, archive, scope, operator) {
  const manifest = await browse(client);
  const outcomes = [];
  for (const reference of manifest.references) {
    let digest;
    try {
      const document = await retrieve(client, reference);
      digest = await archive.preserve(document);
      const record = interpret(document.raw);
      const prior = archive.records(scope).filter(item => item.decision.status === 'accepted').map(item => item.record);
      const decision = assess(record, prior, scope);
      if (operator && decision.status === 'accepted') decision.portal = await operator(record);
      archive.put(scope, decision.key ?? reference.identity, digest, record, decision);
      outcomes.push({ reference: reference.identity, digest, ...decision });
    } catch (error) {
      outcomes.push({ reference: reference.identity, digest, status: 'error', reason: error.message });
    }
  }
  return { context: manifest.context, ...summarize(outcomes) };
}

// 按订单时点成套协商历史资料：
// 1) 周期由站点关联资料声明，订单时点不在任何周期内 -> outside-cycle，不抓当前页顶替；
// 2) 正文经全部归档来源协商，周期内多版只拿到近版 -> ambiguous；
// 3) 附表按正文明确引用的 page+edition 钉版协商，缺档/错版不得用新版替换；
// 4) 每次协商（含失败）只追加留痕；已保存原件按摘要寻址，任何失败都不覆盖既有原件。
export async function collectHistory(client, archive, scope, order) {
  const requestedAt = new Date().toISOString();
  const identity = order.page;
  const key = order.orderId;
  const base = { scope, orderId: order.orderId, page: identity, orderAt: order.orderAt, requestedAt };

  const manifest = await browse(client);
  const reference = manifest.references.find(item => item.identity === identity);
  if (!reference) return { ...base, status: 'error', reason: '目录中不存在该页面身份', components: [] };

  let relationsRaw;
  try {
    relationsRaw = await retrieveRelations(client, identity);
  } catch (error) {
    // 404/403/503 等缺件不解释为“当时没有该条款”，只报告关联资料不可得。
    return { ...base, status: 'unavailable', reason: '关联资料无法取得：' + error.message, components: [] };
  }
  const relations = interpretRelations(relationsRaw);
  const cycle = cycleFor(relations, order.orderAt);
  if (!cycle) {
    return { ...base, status: 'outside-cycle', reason: '订单时点不属于站点声明的任何发布周期', components: [] };
  }

  const current = await retrieve(client, reference);
  const targetUrl = current.raw.url;
  const components = [];

  // 对每个来源的协商结果：成功则把已校验原件按摘要落盘（矛盾/分歧双方都保留），
  // 留痕统一剔除 bytes，只保留摘要、来源与三种时间字段。
  async function settle(entries, kind, key2) {
    const digests = new Map();
    for (const entry of entries) {
      if (entry.status === 'succeeded') {
        const { document, ...trace } = entry;
        digests.set(entry.source, await archive.preserve(document));
        archive.recordNegotiation(scope, key, kind + key2, trace);
      } else {
        archive.recordNegotiation(scope, key, kind + key2, entry);
      }
    }
    return digests;
  }

  const bodyOutcome = await negotiateBody(client, relations.archives, targetUrl, order.orderAt, cycle);
  await settle(bodyOutcome.entries, 'body', '');
  const body = { kind: 'body', page: identity, status: bodyOutcome.status, reason: bodyOutcome.reason };
  if (bodyOutcome.chosen) {
    const chosen = bodyOutcome.chosen;
    Object.assign(body, {
      url: chosen.record.url,
      edition: chosen.record.edition ?? null,
      observedAt: chosen.record.observedAt,
      retrievedAt: chosen.retrievedAt,
      source: chosen.source,
      digest: chosen.digest,
    });
  }
  components.push(body);

  // 附表引用以关联资料中来源声明的 page+edition 为准；正文引用的版本不可被近版替换。
  for (const ref of relations.references) {
    const component = { kind: 'appendix', page: ref.page, expectedEdition: ref.edition, status: 'unavailable' };
    const appendixUrl = new URL(ref.page, targetUrl).href;
    const outcome = await negotiateAppendix(client, relations.archives, appendixUrl, order.orderAt, cycle, ref.edition);
    await settle(outcome.entries, 'appendix:', ref.page);
    component.status = outcome.status;
    component.reason = outcome.reason;
    if (outcome.chosen) {
      const chosen = outcome.chosen;
      Object.assign(component, {
        url: chosen.record.url,
        edition: chosen.record.edition,
        observedAt: chosen.record.observedAt,
        retrievedAt: chosen.retrievedAt,
        source: chosen.source,
        digest: chosen.digest,
      });
    }
    components.push(component);
  }

  const issues = components
    .filter(component => component.status !== 'succeeded')
    .map(component => ({ kind: component.kind, page: component.page, status: component.status, reason: component.reason }));
  const pkg = {
    ...base,
    context: manifest.context,
    targetUrl,
    cycle,
    archives: relations.archives.map(item => item.source),
    status: issues.length === 0 ? 'complete' : 'incomplete',
    components,
    issues,
  };
  archive.savePackage(scope, key, pkg);
  return pkg;
}

import { browse, retrieve } from './source.mjs';
import { interpret } from './interpret.mjs';
import { assess, summarize } from './receiving.mjs';
import { SourceError } from './http.mjs';
import { text } from './validation.mjs';
import {
  interpretRelations,
  suitableObservation,
  groupObservations,
  assessAnnex,
  decidePackage,
} from './historical.mjs';
import { negotiate, negotiateEdition } from './timegate.mjs';

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

function observationProblem(observation, scope, page, orderedAt) {
  if (observation.page !== page || observation.record.page !== page) return '历史观察的页面身份与订单不符';
  if (observation.site !== scope || observation.record.site !== scope) return '历史观察的站点与订单范围不符';
  if (!suitableObservation(observation, orderedAt)) return '归档返回了订单发布周期之外的观察';
  return null;
}

function editionProblem(edition, scope, reference) {
  if (edition.page !== reference.page || edition.record.page !== reference.page) return '附表观察的页面身份与引用不符';
  if (edition.edition !== reference.edition) return '附表版本与正文引用不符';
  if (edition.site !== scope || edition.record.site !== scope) return '附表观察的站点与订单范围不符';
  return null;
}

// 按订单时点采集历史包：正文观察与其明确引用的附表版本。
// 协商失败只形成新的失败包，不回退领取当前页，也不覆盖既有历史原文。
export async function collectHistorical(client, archive, scope, order) {
  const orderId = text(order?.id, 'order.id');
  const page = text(order?.page, 'order.page');
  const orderedAt = text(order?.orderedAt, 'order.orderedAt');
  if (!Number.isFinite(Date.parse(orderedAt))) throw new Error('订单时点无效');

  const failures = [];
  const empties = [];
  const obtained = [];
  let relations = null;
  let discovery = null;
  try {
    const document = await client.get('/web/current/relations/' + encodeURIComponent(page));
    relations = interpretRelations(document.raw);
    discovery = {
      digest: await archive.preserve(document),
      acquiredAt: document.observedAt,
    };
  } catch (error) {
    failures.push({ archive: null, reason: '无法取得关联资料：' + error.message });
  }

  for (const archivePath of relations?.archives ?? []) {
    let result;
    try {
      result = await negotiate(client, archivePath, page, orderedAt);
    } catch (error) {
      if (error instanceof SourceError && error.status === 404) empties.push(archivePath);
      else failures.push({ archive: archivePath, reason: error.message });
      continue;
    }
    const problem = observationProblem(result.observation, scope, page, orderedAt);
    if (problem) {
      failures.push({ archive: archivePath, reason: problem });
      continue;
    }
    const digest = await archive.preserve({
      bytes: result.document.bytes,
      location: result.document.location,
      observedAt: result.observation.observedAt,
    });
    obtained.push({ observation: result.observation, digest, acquiredAt: result.document.observedAt });
  }

  const groups = groupObservations(obtained);
  const references = new Map();
  for (const group of groups) {
    for (const reference of group.references) {
      const key = reference.page + '|' + reference.edition;
      if (!references.has(key)) references.set(key, { reference, citedBy: new Set() });
      references.get(key).citedBy.add(group.observedAt);
    }
  }

  const annexes = [];
  for (const { reference, citedBy } of references.values()) {
    const hits = [];
    const annexFailures = [];
    for (const archivePath of relations?.archives ?? []) {
      try {
        const result = await negotiateEdition(client, archivePath, reference.page, reference.edition);
        const problem = editionProblem(result.edition, scope, reference);
        if (problem) {
          annexFailures.push({ archive: archivePath, reason: problem });
          continue;
        }
        const digest = await archive.preserve({
          bytes: result.document.bytes,
          location: result.document.location,
          observedAt: result.edition.observedAt,
        });
        hits.push({ edition: result.edition, digest, acquiredAt: result.document.observedAt });
      } catch (error) {
        if (!(error instanceof SourceError && error.status === 404)) annexFailures.push({ archive: archivePath, reason: error.message });
      }
    }
    annexes.push(assessAnnex(reference, citedBy, hits, annexFailures));
  }

  const { status, issues, caveats } = decidePackage({ groups, annexes, failures, empties });
  const manifest = {
    kind: 'historical-package',
    scope,
    order: { id: orderId, page, orderedAt },
    assembledAt: new Date().toISOString(),
    status,
    discovery,
    content: groups.map((group) => ({
      observedAt: group.observedAt,
      period: [group.period.start, group.period.end],
      record: group.record,
      references: group.references,
      sources: group.sources.map((source) => ({
        source: source.source,
        digest: source.digest,
        acquiredAt: source.acquiredAt,
        withheld: source.withheld,
      })),
    })),
    annexes,
    issues,
    caveats,
  };
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2));
  const digest = await archive.preserve({ bytes, location: 'package:' + scope + '/' + orderId, observedAt: manifest.assembledAt });
  archive.put(
    scope,
    'order:' + orderId,
    digest,
    { kind: 'historical-package', order: manifest.order, assembledAt: manifest.assembledAt, status },
    { status, issues, caveats },
  );
  return { digest, ...manifest };
}

// 查询某订单的全部历史包：每个包如实携带实际取得时间与归档来源。
export async function historicalReport(archive, scope, orderId) {
  const rows = archive.records(scope).filter((row) => row.business_key === 'order:' + orderId);
  const packages = [];
  for (const row of rows) packages.push(JSON.parse((await archive.original(row.digest)).toString('utf8')));
  packages.sort((a, b) => Date.parse(a.assembledAt) - Date.parse(b.assembledAt));
  return { scope, order: orderId, packages };
}

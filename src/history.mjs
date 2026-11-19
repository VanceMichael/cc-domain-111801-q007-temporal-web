import { createHash } from 'node:crypto';
import { text } from './validation.mjs';

export function digestOf(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// 历史观察（memento）记录解释。observedAt 是归档站声明的实际捕获时刻，
// 不是本次协商请求的时间；url 必须保留正文当时的历史网址。
export function interpretMemento(raw, { requireEdition = false } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('历史观察记录不是对象');
  const observedAt = text(raw.observedAt, 'observedAt');
  if (!Number.isFinite(Date.parse(observedAt))) throw new Error('观察时间无效');
  const url = new URL(text(raw.url, 'url'));
  const record = {
    page: text(raw.page, 'page'),
    site: text(raw.site, 'site'),
    url: url.href,
    observedAt,
    title: text(raw.title, 'title'),
    body: text(raw.body, 'body'),
  };
  if (typeof raw.edition === 'string' && raw.edition.trim()) record.edition = raw.edition.trim();
  if (requireEdition && !record.edition) throw new Error('附表观察缺少版本标识');
  return record;
}

function gateQuery(archivePath, targetUrl, orderAt, edition) {
  const path = archivePath
    + '?url=' + encodeURIComponent(targetUrl)
    + '&at=' + encodeURIComponent(orderAt)
    + (edition ? '&edition=' + encodeURIComponent(edition) : '');
  return path;
}

function inWindow(observedAt, cycle) {
  const at = Date.parse(observedAt);
  return at >= Date.parse(cycle.start + 'T00:00:00Z')
    && at < Date.parse(cycle.end + 'T00:00:00Z');
}

function interpretGate(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('协商响应结构无效');
  const source = text(raw.source, 'source');
  const location = text(raw.location, 'location');
  const candidates = [];
  if (!Array.isArray(raw.candidates)) throw new Error('协商响应缺少候选观察');
  for (const item of raw.candidates) {
    const observedAt = text(item.observedAt, 'candidate.observedAt');
    if (!Number.isFinite(Date.parse(observedAt))) throw new Error('候选观察时间无效');
    candidates.push({ observedAt });
  }
  return { source, location, candidates };
}

// 与单个归档来源协商一次历史观察。
// requestedAt/retrievedAt 严格区分：前者是协商请求时间，后者是实际取得原文的时间；
// observedAt 只能来自归档站对该观察的声明，禁止用请求时间顶替。
export async function negotiateOne(client, archive, targetUrl, orderAt, cycle, { edition = null } = {}) {
  const requestedAt = new Date().toISOString();
  const gatePath = gateQuery(archive.timegate, targetUrl, orderAt, edition ?? undefined);
  const gate = await client.get(gatePath);
  const offer = interpretGate(gate.raw);
  if (offer.source !== archive.source) throw new Error('归档来源身份与关联资料不符');
  const document = await client.get(offer.location);
  const retrievedAt = document.observedAt;
  const record = interpretMemento(document.raw, { requireEdition: Boolean(edition) });
  const entry = {
    source: archive.source,
    gate: { path: gatePath, requestedAt, gateRetrievedAt: gate.observedAt, candidates: offer.candidates },
    location: document.location,
    retrievedAt,
    digest: digestOf(document.bytes),
    record,
  };
  const reject = (status, reason, extra = {}) => ({
    ...entry, ...extra, status, reason,
    // 校验未通过的观察不落原件，留痕中也绝不夹带原文字节。
  });
  if (record.url !== targetUrl) {
    return reject('identity-mismatch', '历史网址在当前重定向到其他身份，不能作为历史身份依据');
  }
  if (!inWindow(record.observedAt, cycle)) {
    return reject('out-of-window', '观察时刻不在订单所属发布周期内');
  }
  if (edition && record.edition !== edition) {
    return reject('edition-rejected', '附表版本与正文引用不一致，禁止以不同版本顶替', { expectedEdition: edition });
  }
  // 仅校验通过的观察携带文档，交由编排层按摘要落盘。
  return { ...entry, document, status: 'succeeded', ambiguous: offer.candidates.length > 1 };
}

const FAILURE_ORDER = {
  'identity-mismatch': 4,
  'out-of-window': 3,
  'edition-rejected': 2,
  'unavailable': 1,
};

// 汇总同一观察点在多个归档来源的协商结果。
// 同观察时刻不同内容 = 矛盾（conflict）；不同观察时刻 = 分歧（divergent）。
// 全部来源失败时不推断“当时没有该条款”，只如实报告不可得。
export function synthesize(entries, { edition = null } = {}) {
  const valid = entries.filter(entry => entry.status === 'succeeded');
  const failures = entries.filter(entry => entry.status !== 'succeeded');
  if (valid.length === 0) {
    const first = failures.slice().sort((a, b) => (FAILURE_ORDER[b.status] ?? 0) - (FAILURE_ORDER[a.status] ?? 0))[0];
    return { status: edition ? 'appendix-missing' : 'unavailable', reason: first ? first.reason : '没有归档来源给出观察', entries };
  }
  const moments = new Set(valid.map(entry => entry.record.observedAt));
  const contents = new Set(valid.map(entry => entry.digest));
  const chosen = valid[0];
  if (moments.size > 1) {
    return {
      status: 'divergent',
      reason: '不同归档来源给出的观察时刻不一致，无法相互印证',
      chosen,
      entries,
    };
  }
  if (contents.size > 1) {
    return {
      status: 'conflict',
      reason: '同一观察时刻的页面内容在不同归档来源相互矛盾',
      chosen,
      entries,
    };
  }
  if (valid.some(entry => entry.ambiguous)) {
    return {
      status: 'ambiguous',
      reason: '同一发布周期内存在多版正文，归档站仅返回较近一版，不能声称另一版不存在',
      chosen,
      entries,
    };
  }
  return { status: 'succeeded', chosen, entries };
}

export async function negotiateBody(client, archives, targetUrl, orderAt, cycle) {
  const entries = await Promise.all(archives.map(async archive => {
    try {
      return await negotiateOne(client, archive, targetUrl, orderAt, cycle);
    } catch (error) {
      return { source: archive.source, status: 'unavailable', reason: describeFailure(error) };
    }
  }));
  return synthesize(entries);
}

export async function negotiateAppendix(client, archives, targetUrl, orderAt, cycle, edition) {
  const entries = await Promise.all(archives.map(async archive => {
    try {
      return await negotiateOne(client, archive, targetUrl, orderAt, cycle, { edition });
    } catch (error) {
      return { source: archive.source, status: 'unavailable', reason: describeFailure(error) };
    }
  }));
  return synthesize(entries, { edition });
}

// HTTP 缺件（404/403/503 等）只描述来源状态，不解释成业务上的“条款不存在”。
function describeFailure(error) {
  const status = error?.status ? `（来源状态 ${error.status}）` : '';
  return (error?.message ?? '协商失败') + status;
}

import { text } from './validation.mjs';
import { interpret } from './interpret.mjs';

function time(value, name) {
  const result = text(value, name);
  if (!Number.isFinite(Date.parse(result))) throw new Error('时间无效：' + name);
  return result;
}

function period(raw) {
  if (!Array.isArray(raw) || raw.length !== 2) throw new Error('发布周期结构无效');
  const start = time(raw[0], 'period.start');
  const end = time(raw[1], 'period.end');
  if (!(Date.parse(start) < Date.parse(end))) throw new Error('发布周期边界无效');
  return { start, end };
}

function references(raw) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error('引用结构无效');
  return raw.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('引用结构无效');
    return { page: text(entry.page, 'references.page'), edition: text(entry.edition, 'references.edition') };
  });
}

export function interpretRelations(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('关联资料不是对象');
  const archives = [];
  if (raw.archive !== undefined) archives.push(text(raw.archive, 'archive'));
  if (raw.archives !== undefined) {
    if (!Array.isArray(raw.archives)) throw new Error('归档入口结构无效');
    for (const entry of raw.archives) archives.push(text(entry, 'archives'));
  }
  const unique = [...new Set(archives)];
  if (unique.length === 0) throw new Error('关联资料缺少归档入口');
  for (const entry of unique) if (!entry.startsWith('/')) throw new Error('归档入口必须是同源路径');
  return { archives: unique, period: raw.period === undefined ? null : period(raw.period), references: references(raw.references) };
}

export function interpretObservation(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('历史观察不是对象');
  const withheld = raw.withheld === undefined ? [] : raw.withheld;
  if (!Array.isArray(withheld)) throw new Error('保留版本结构无效');
  return {
    page: text(raw.page, 'page'),
    site: text(raw.site, 'site'),
    source: text(raw.source, 'source'),
    observedAt: time(raw.observedAt, 'observedAt'),
    period: period(raw.period),
    record: interpret(raw.record),
    references: references(raw.references),
    withheld: withheld.map((entry) => ({ observedAt: time(entry?.observedAt, 'withheld.observedAt') })),
  };
}

export function interpretEdition(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('附表观察不是对象');
  return {
    page: text(raw.page, 'page'),
    site: text(raw.site, 'site'),
    source: text(raw.source, 'source'),
    edition: text(raw.edition, 'edition'),
    observedAt: time(raw.observedAt, 'observedAt'),
    record: interpret(raw.record),
  };
}

export function withinPeriod(bounds, moment) {
  return Date.parse(bounds.start) <= Date.parse(moment) && Date.parse(moment) < Date.parse(bounds.end);
}

export function suitableObservation(observation, orderedAt) {
  return withinPeriod(observation.period, orderedAt) && withinPeriod(observation.period, observation.observedAt);
}

export function canonical(record) {
  const sorted = {};
  for (const key of Object.keys(record).sort()) sorted[key] = record[key];
  return JSON.stringify(sorted);
}

export function groupObservations(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.observation.observedAt + '|' + canonical(item.observation.record);
    if (!groups.has(key)) {
      groups.set(key, {
        observedAt: item.observation.observedAt,
        period: item.observation.period,
        record: item.observation.record,
        references: item.observation.references,
        sources: [],
      });
    }
    groups.get(key).sources.push({
      source: item.observation.source,
      digest: item.digest,
      acquiredAt: item.acquiredAt,
      withheld: item.observation.withheld,
    });
  }
  return [...groups.values()].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
}

function findConflicts(groups) {
  const byTime = new Map();
  for (const group of groups) {
    if (!byTime.has(group.observedAt)) byTime.set(group.observedAt, []);
    byTime.get(group.observedAt).push(group);
  }
  const conflicts = [];
  for (const [observedAt, variants] of byTime) {
    if (variants.length < 2) continue;
    conflicts.push({
      observedAt,
      variants: variants.map((variant) => ({
        sources: variant.sources.map((source) => source.source),
        digests: variant.sources.map((source) => source.digest),
      })),
    });
  }
  return conflicts;
}

export function assessAnnex(reference, citedBy, hits, failures) {
  const obtained = hits.map((hit) => ({
    source: hit.edition.source,
    observedAt: hit.edition.observedAt,
    digest: hit.digest,
    acquiredAt: hit.acquiredAt,
    record: hit.edition.record,
  }));
  const conflict = new Set(hits.map((hit) => canonical(hit.edition.record))).size > 1;
  let status = 'missing';
  if (obtained.length > 0) status = 'obtained';
  else if (failures.length > 0) status = 'failed';
  const entry = { reference, citedBy: [...citedBy], status, conflict, obtained };
  if (status === 'failed') entry.reason = failures.map((failure) => failure.reason).join('；');
  return entry;
}

export function decidePackage({ groups, annexes, failures, empties }) {
  const issues = [];
  const caveats = [];
  for (const group of groups) {
    for (const source of group.sources) {
      if (source.withheld.length > 0) {
        caveats.push({
          kind: 'withheld-versions',
          source: source.source,
          page: group.record.page,
          observedAts: source.withheld.map((entry) => entry.observedAt),
          detail: '归档确认同一周期存在其他版本，仅返回较近一版；不得据此声称其他版本不存在',
        });
      }
    }
  }
  if (groups.length === 0) {
    if (empties.length > 0) {
      issues.push({
        kind: 'content-no-observation',
        archives: empties,
        detail: '订单时点未落入任何已归档发布周期；资料空缺不等于当时没有该条款',
      });
      for (const failure of failures) {
        caveats.push({ kind: 'source-unavailable', archive: failure.archive, reason: failure.reason, detail: '该归档源本次未能协商，结论仅基于已答复的来源' });
      }
      return { status: 'content-no-observation', issues, caveats };
    }
    for (const failure of failures) {
      issues.push({ kind: 'source-failed', archive: failure.archive, reason: failure.reason, detail: '协商未完成，不能据此推断当时条款状态' });
    }
    return { status: 'negotiation-failed', issues, caveats };
  }
  for (const failure of failures) {
    caveats.push({ kind: 'source-unavailable', archive: failure.archive, reason: failure.reason, detail: '该归档源本次未能协商，结论仅基于已取得来源' });
  }
  for (const empty of empties) {
    caveats.push({ kind: 'source-empty', archive: empty, detail: '该归档源在订单所属周期无观察' });
  }
  const conflicts = findConflicts(groups);
  for (const conflict of conflicts) {
    issues.push({ kind: 'content-conflict', ...conflict, detail: '不同归档来源对同一观察时刻给出了不同正文' });
  }
  for (const annex of annexes) {
    if (annex.conflict) issues.push({ kind: 'annex-conflict', reference: annex.reference, detail: '不同归档来源对同一附表版本给出了不同内容' });
    if (annex.status === 'missing') issues.push({ kind: 'annex-missing', reference: annex.reference, detail: '正文明确引用的附表版本在所有声明归档源均未取得；不得以时间更近的不同版替换' });
    if (annex.status === 'failed') issues.push({ kind: 'annex-failed', reference: annex.reference, reason: annex.reason, detail: '附表协商未完成，是否缺档未知' });
  }
  let status = 'complete';
  if (conflicts.length > 0 || annexes.some((annex) => annex.conflict)) status = 'source-conflict';
  else if (annexes.some((annex) => annex.status === 'missing')) status = 'annex-missing';
  else if (annexes.some((annex) => annex.status === 'failed')) status = 'negotiation-failed';
  return { status, issues, caveats };
}

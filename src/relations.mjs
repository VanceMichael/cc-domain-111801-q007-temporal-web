import { text } from './validation.mjs';

function isoDate(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || Number.isNaN(Date.parse(value + 'T00:00:00Z'))) {
    throw new Error('日期字段无效：' + name);
  }
  return value;
}

// 关联资料解释：保留来源声明的发布周期、归档来源与正文引用关系。
// 兼容早期单周期字段 period/archive，统一归一为 periods/archives。
export function interpretRelations(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('关联资料不是对象');
  const archives = [];
  if (Array.isArray(raw.archives)) {
    for (const entry of raw.archives) {
      archives.push({
        source: text(entry.source, 'archive.source'),
        timegate: text(entry.timegate, 'archive.timegate'),
      });
    }
  }
  const periods = [];
  if (Array.isArray(raw.periods)) {
    for (const entry of raw.periods) {
      const start = isoDate(entry.start, 'period.start');
      const end = isoDate(entry.end, 'period.end');
      if (Date.parse(start + 'T00:00:00Z') >= Date.parse(end + 'T00:00:00Z')) {
        throw new Error('发布周期起止无效');
      }
      const period = { start, end };
      if (typeof entry.timegate === 'string' && entry.timegate.trim()) period.timegate = entry.timegate.trim();
      periods.push(period);
    }
  }
  if (periods.length === 0 && Array.isArray(raw.period) && raw.period.length === 2) {
    const start = isoDate(raw.period[0], 'period.0');
    const end = isoDate(raw.period[1], 'period.1');
    if (Date.parse(start + 'T00:00:00Z') < Date.parse(end + 'T00:00:00Z')) periods.push({ start, end });
  }
  if (periods.length === 0) throw new Error('关联资料缺少发布周期');
  if (archives.length === 0 && typeof raw.archive === 'string' && raw.archive.trim()) {
    archives.push({ source: 'legacy-archive', timegate: raw.archive.trim() });
  }
  if (archives.length === 0) throw new Error('关联资料缺少归档来源');
  const references = [];
  if (Array.isArray(raw.references)) {
    for (const ref of raw.references) {
      references.push({ page: text(ref.page, 'reference.page'), edition: text(ref.edition, 'reference.edition') });
    }
  }
  return { periods, archives, references };
}

// 周期为半开区间 [start, end)；订单时点恰好落在边界日时归入下一周期。
export function cycleFor(relations, orderAt) {
  const at = Date.parse(orderAt);
  if (!Number.isFinite(at)) throw new Error('订单时点无效');
  return relations.periods.find((period) => {
    const start = Date.parse(period.start + 'T00:00:00Z');
    const end = Date.parse(period.end + 'T00:00:00Z');
    return at >= start && at < end;
  }) ?? null;
}

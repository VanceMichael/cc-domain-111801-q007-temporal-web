export function assess(record, previous, scope) {
  if (record.site !== scope) return { status: 'outside', reason: '不属于选定站点' };
           const prior = previous.find(item => item.page === record.page && item.observedAt === record.observedAt && item.body !== record.body);
           if (prior) return { status: 'conflict', reason: '同一观察时刻的页面内容不一致' };
           return { status: 'accepted', key: record.page + ':' + record.observedAt, facts: { page: record.page, url: record.url, observedAt: record.observedAt, title: record.title } };
}

export function summarize(outcomes) {
  const counts = {};
  for (const outcome of outcomes) counts[outcome.status] = (counts[outcome.status] ?? 0) + 1;
  return { complete: outcomes.length > 0 && outcomes.every(outcome => outcome.status === 'accepted'), counts, outcomes };
}

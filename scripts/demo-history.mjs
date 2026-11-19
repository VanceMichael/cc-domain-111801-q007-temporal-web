import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceClient } from '../src/http.mjs';
import { Archive } from '../src/archive.mjs';
import { fixtureSource } from '../src/fixture-source.mjs';
import { collect, collectHistory } from '../src/app.mjs';
import { historySourceFixture } from '../src/history-fixture.mjs';

// 一、常规当天资料领取（保留原有演示）
const fixture = JSON.parse(await readFile(new URL('../fixtures/source.json', import.meta.url), 'utf8'));
const source = await fixtureSource(fixture);

const directory = await mkdtemp(join(tmpdir(), 'temporal-web-'));
const archive = await new Archive(directory).start();
try {
  const result = await collect(new SourceClient(source.url), archive, fixture.scope);
  console.log('== 当天资料领取 ==');
  console.log(JSON.stringify(result, null, 2));
} finally { await source.close(); }

// 二、按订单时点协商历史包（两个归档来源、两个发布周期）
// 关联资料静态声明：正文引用附表 zones 的 v4 版；周期边界为每月一日。
const historyFixture = historySourceFixture({
  cycles: [
    { start: '2026-10-01', end: '2026-11-01' },
    { start: '2026-11-01', end: '2026-12-01' },
  ],
  archives: [
    { source: 'archive-a', gate: '/archive/a/gate' },
    { source: 'archive-b', gate: '/archive/b/gate' },
  ],
  bodyHolds: {
    'archive-a': [
      { observedAt: '2026-10-05T08:00:00Z', body: '十月运费正文（早版）' },
      { observedAt: '2026-10-20T08:00:00Z', body: '十月运费正文（修订版）' },
      { observedAt: '2026-11-06T08:00:00Z', body: '十一月运费正文' },
    ],
    'archive-b': [
      { observedAt: '2026-10-05T08:00:00Z', body: '十月运费正文（早版）' },
      { observedAt: '2026-10-20T08:00:00Z', body: '十月运费正文（修订版）' },
      { observedAt: '2026-11-06T08:00:00Z', body: '十一月运费正文' },
    ],
  },
  zoneHolds: {
    // archive-a：十月持有 v4，十一月只剩 v5（v4 缺档，v5 不得顶替）
    'archive-a': [
      { observedAt: '2026-10-02T08:00:00Z', edition: 'v4', body: '地区附表 v4' },
      { observedAt: '2026-11-03T08:00:00Z', edition: 'v5', body: '地区附表 v5' },
    ],
    // archive-b：十月持有 v4，十一月无任何附表
    'archive-b': [
      { observedAt: '2026-10-02T08:00:00Z', edition: 'v4', body: '地区附表 v4' },
    ],
  },
});
const historySource = await fixtureSource(historyFixture);
const orders = [
  { orderId: 'OCT-001', orderAt: '2026-10-15T10:00:00Z', expect: '十月周期两版正文只给近版 -> ambiguous；v4 附表两站互证 -> 成套性受歧义限制' },
  { orderId: 'OCT-002', orderAt: '2026-10-25T10:00:00Z', expect: '同一周期另一订单独立留痕' },
  { orderId: 'NOV-003', orderAt: '2026-11-10T10:00:00Z', expect: '十一月单版正文；引用的 v4 已缺档，v5 不得顶替 -> appendix-missing' },
];
try {
  const client = new SourceClient(historySource.url);
  for (const order of orders) {
    const pkg = await collectHistory(client, archive, historyFixture.scope, { page: historyFixture.page, ...order });
    console.log('\n== 历史订单 ' + order.orderId + '：' + order.expect + ' ==');
    console.log(JSON.stringify({
      status: pkg.status,
      cycle: pkg.cycle,
      archives: pkg.archives,
      targetUrl: pkg.targetUrl,
      requestedAt: pkg.requestedAt,
      components: pkg.components.map(c => ({
        kind: c.kind, page: c.page, status: c.status, reason: c.reason,
        edition: c.edition ?? c.expectedEdition ?? null,
        observedAt: c.observedAt ?? null, retrievedAt: c.retrievedAt ?? null,
        source: c.source ?? null, digest: c.digest ?? null,
      })),
    }, null, 2));
  }
  const traces = orders.reduce((sum, order) => sum + archive.negotiations(historyFixture.scope, order.orderId).length, 0);
  console.log('\n协商留痕条数：', traces);
  console.log('历史包数量：', archive.packages(historyFixture.scope).length);
} finally {
  archive.close(); await historySource.close();
  await rm(directory, { recursive: true, force: true });
}

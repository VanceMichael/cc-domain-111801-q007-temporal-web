import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceClient } from '../src/http.mjs';
import { fixtureSource } from '../src/fixture-source.mjs';
import { Archive } from '../src/archive.mjs';
import { collectHistory } from '../src/app.mjs';
import { historySourceFixture } from '../src/history-fixture.mjs';
import { interpretRelations, cycleFor } from '../src/relations.mjs';
import { interpretMemento, negotiateOne, synthesize, digestOf } from '../src/history.mjs';

const cycles = [
  { start: '2026-09-01', end: '2026-10-01' },
  { start: '2026-10-01', end: '2026-11-01' },
  { start: '2026-11-01', end: '2026-12-01' },
];
const archives = [
  { source: 'archive-a', gate: '/archive/a/gate' },
  { source: 'archive-b', gate: '/archive/b/gate' },
];
const zoneV4 = { observedAt: '2026-10-02T08:00:00Z', edition: 'v4', body: '地区附表v4' };

async function harness(fixture) {
  const source = await fixtureSource(fixture);
  const directory = await mkdtemp(join(tmpdir(), 'history-'));
  const archive = await new Archive(directory).start();
  const client = new SourceClient(source.url);
  return {
    source, archive, client,
    async run(orderId, orderAt) {
      return collectHistory(client, archive, fixture.scope, { orderId, page: fixture.page, orderAt });
    },
    async close() { archive.close(); await source.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

test('完整历史包：正文与钉版附表成套，时间与来源均可说明', async () => {
  const fixture = historySourceFixture({
    cycles, archives,
    bodyHolds: {
      'archive-a': [{ observedAt: '2026-10-05T08:00:00Z', body: '十月运费正文' }],
      'archive-b': [{ observedAt: '2026-10-05T08:00:00Z', body: '十月运费正文' }],
    },
    zoneHolds: { 'archive-a': [zoneV4], 'archive-b': [zoneV4] },
  });
  const h = await harness(fixture);
  try {
    const pkg = await h.run('O-1', '2026-10-15T10:00:00Z');
    assert.equal(pkg.status, 'complete');
    assert.equal(pkg.cycle.start, '2026-10-01');
    assert.deepEqual(pkg.archives, ['archive-a', 'archive-b']);
    const [body, appendix] = pkg.components;
    assert.equal(body.status, 'succeeded');
    assert.equal(body.observedAt, '2026-10-05T08:00:00Z');
    assert.equal(appendix.status, 'succeeded');
    assert.equal(appendix.edition, 'v4');
    // 实际取得时间晚于订单时点，且不与观察时刻混用
    assert.ok(Date.parse(body.retrievedAt) > Date.parse(body.observedAt));
    assert.notEqual(body.retrievedAt, body.observedAt);
    assert.ok(pkg.requestedAt.startsWith('2026-11-19'));
    // 原件可按摘要取回，内容与声明一致
    const original = JSON.parse((await h.archive.original(body.digest)).toString());
    assert.equal(original.observedAt, body.observedAt);
    assert.equal(original.url, 'https://shop.invalid/terms');
    // 协商轨迹按来源逐条留痕
    const rows = h.archive.negotiations(fixture.scope, 'O-1');
    assert.equal(rows.length, 4);
    assert.deepEqual([...new Set(rows.map(r => r.source))].sort(), ['archive-a', 'archive-b']);
    for (const row of rows) assert.ok(row.requested_at, '每次协商都记录请求时间');
  } finally { await h.close(); }
});

test('周期内前后两版只返回近版：标记 ambiguous，不声称另一版不存在', async () => {
  const fixture = historySourceFixture({
    cycles, archives,
    bodyHolds: {
      'archive-a': [
        { observedAt: '2026-10-05T08:00:00Z', body: '早期版本' },
        { observedAt: '2026-10-20T08:00:00Z', body: '较近版本' },
      ],
      'archive-b': [
        { observedAt: '2026-10-05T08:00:00Z', body: '早期版本' },
        { observedAt: '2026-10-20T08:00:00Z', body: '较近版本' },
      ],
    },
    zoneHolds: { 'archive-a': [zoneV4], 'archive-b': [zoneV4] },
  });
  const h = await harness(fixture);
  try {
    const pkg = await h.run('O-2', '2026-10-15T10:00:00Z');
    assert.equal(pkg.status, 'incomplete');
    const body = pkg.components[0];
    assert.equal(body.status, 'ambiguous');
    assert.match(body.reason, /不能声称另一版不存在/);
    // 近版被实际取回并保存，供资料人员判断
    assert.equal(body.observedAt, '2026-10-20T08:00:00Z');
    assert.ok(body.digest);
    assert.deepEqual(pkg.issues[0], { kind: 'body', page: 'PAGE1', status: 'ambiguous', reason: body.reason });
  } finally { await h.close(); }
});

test('附表缺档与版本顶替被拒绝，不拿时间更近的不同版替换', async () => {
  const fixture = historySourceFixture({
    cycles, archives,
    bodyHolds: {
      'archive-a': [{ observedAt: '2026-10-05T08:00:00Z', body: '正文' }],
      'archive-b': [{ observedAt: '2026-10-05T08:00:00Z', body: '正文' }],
    },
    // 两站都只有 v5，正文引用的是 v4
    zoneHolds: {
      'archive-a': [{ observedAt: '2026-10-25T08:00:00Z', edition: 'v5', body: '新附表' }],
      'archive-b': [{ observedAt: '2026-10-25T08:00:00Z', edition: 'v5', body: '新附表' }],
    },
  });
  const h = await harness(fixture);
  try {
    const pkg = await h.run('O-3', '2026-10-15T10:00:00Z');
    assert.equal(pkg.status, 'incomplete');
    const appendix = pkg.components.find(c => c.kind === 'appendix');
    assert.equal(appendix.status, 'appendix-missing');
    assert.equal(appendix.expectedEdition, 'v4');
    // v5 没有被保存为该订单的依据
    assert.equal(appendix.digest, undefined);
    assert.equal(appendix.status, 'appendix-missing');
  } finally { await h.close(); }
});

test('仅部分来源持有钉版附表：可用来源成套，缺口如实标注', async () => {
  const fixture = historySourceFixture({
    cycles, archives,
    bodyHolds: {
      'archive-a': [{ observedAt: '2026-10-05T08:00:00Z', body: '正文' }],
      'archive-b': [{ observedAt: '2026-10-05T08:00:00Z', body: '正文' }],
    },
    zoneHolds: { 'archive-a': [zoneV4], 'archive-b': [] },
  });
  const h = await harness(fixture);
  try {
    const pkg = await h.run('O-4', '2026-10-15T10:00:00Z');
    assert.equal(pkg.status, 'complete');
    const appendix = pkg.components.find(c => c.kind === 'appendix');
    assert.equal(appendix.status, 'succeeded');
    assert.equal(appendix.source, 'archive-a');
    const rows = h.archive.negotiations(fixture.scope, 'O-4').filter(r => r.kind.startsWith('appendix'));
    assert.equal(rows.find(r => r.source === 'archive-b').outcome, 'unavailable');
    assert.equal(rows.find(r => r.source === 'archive-a').outcome, 'succeeded');
  } finally { await h.close(); }
});

test('协商失败后重新协商不覆盖既有原件与已完成历史包', async () => {
  const fixture = historySourceFixture({
    cycles, archives,
    bodyHolds: {
      'archive-a': [{ observedAt: '2026-10-05T08:00:00Z', body: '正文' }],
      'archive-b': [{ observedAt: '2026-10-05T08:00:00Z', body: '正文' }],
    },
    zoneHolds: { 'archive-a': [zoneV4], 'archive-b': [zoneV4] },
  });
  const h = await harness(fixture);
  try {
    const first = await h.run('O-5', '2026-10-15T10:00:00Z');
    assert.equal(first.status, 'complete');
    const evidenceBefore = h.archive.records(fixture.scope);
    const digest = first.components[0].digest;
    // 两站的 timegate 同时故障，且当前页被换成新条款
    h.source.fail('/archive/a/gate', 503, 5);
    h.source.fail('/archive/b/gate', 503, 5);
    h.source.replace('/web/current/records/PAGE1', {
      body: { page: 'PAGE1', site: 'shop-a', url: 'https://shop.invalid/terms', observedAt: '2026-11-18T00:00:00Z', title: '运输说明', body: '新条款（不应覆盖历史）' },
    });
    const second = await h.run('O-5', '2026-10-15T10:00:00Z');
    assert.equal(second.status, 'incomplete');
    // 已保存的历史包与原件保持不变
    const stored = h.archive.package(fixture.scope, 'O-5');
    assert.equal(stored.status, 'complete');
    assert.equal(stored.components[0].digest, digest);
    const original = JSON.parse((await h.archive.original(digest)).toString());
    assert.equal(original.body, '正文');
    assert.deepEqual(h.archive.records(fixture.scope), evidenceBefore);
    // 失败协商同样留痕，且原件数量不减少
    assert.ok(h.archive.negotiations(fixture.scope, 'O-5').length > 4);
  } finally { await h.close(); }
});

test('当前重定向不构成历史身份依据：身份不符被明确拒绝', async () => {
  const fixture = historySourceFixture({
    cycles,
    archives: [{ source: 'archive-a', gate: '/archive/a/gate' }],
    bodyHolds: { 'archive-a': [{ observedAt: '2026-10-05T08:00:00Z', body: '正文' }] },
    zoneHolds: { 'archive-a': [zoneV4] },
    bodyRedirect: { source: 'archive-a', location: 'https://new-brand.invalid/terms' },
  });
  const h = await harness(fixture);
  try {
    const pkg = await h.run('O-6', '2026-10-15T10:00:00Z');
    const body = pkg.components[0];
    assert.equal(body.status, 'unavailable');
    assert.match(body.reason, /重定向|历史身份/);
    assert.equal(body.digest, undefined);
  } finally { await h.close(); }
});

test('memento 位置本身重定向同样被拒绝，不静默跟随到新品牌页面', async () => {
  const fixture = historySourceFixture({
    cycles,
    archives: [{ source: 'archive-a', gate: '/archive/a/gate' }],
    bodyHolds: { 'archive-a': [{ observedAt: '2026-10-05T08:00:00Z', body: '正文' }] },
    zoneHolds: { 'archive-a': [zoneV4] },
  });
  const source = await fixtureSource(fixture);
  const directory = await mkdtemp(join(tmpdir(), 'history-redir-'));
  const archive = await new Archive(directory).start();
  try {
    source.replace('/archive/archive-a/memento/body/2026-10-05T08:00:00Z', {
      status: 302, headers: { location: 'https://new-brand.invalid/terms' }, body: {},
    });
    const pkg = await collectHistory(new SourceClient(source.url), archive, fixture.scope,
      { orderId: 'O-6b', page: fixture.page, orderAt: '2026-10-15T10:00:00Z' });
    const body = pkg.components[0];
    assert.equal(body.status, 'unavailable');
    assert.match(body.reason, /重定向/);
    assert.equal(body.digest, undefined);
  } finally { archive.close(); await source.close(); await rm(directory, { recursive: true, force: true }); }
});

test('不同归档来源同观察时刻内容矛盾：conflict 且双方原件都保留', async () => {
  const fixture = historySourceFixture({
    cycles, archives,
    bodyHolds: {
      'archive-a': [{ observedAt: '2026-10-05T08:00:00Z', body: '甲版本正文' }],
      'archive-b': [{ observedAt: '2026-10-05T08:00:00Z', body: '乙版本正文' }],
    },
    zoneHolds: { 'archive-a': [zoneV4], 'archive-b': [zoneV4] },
  });
  const h = await harness(fixture);
  try {
    const pkg = await h.run('O-7', '2026-10-15T10:00:00Z');
    const body = pkg.components[0];
    assert.equal(body.status, 'conflict');
    assert.match(body.reason, /矛盾/);
    const rows = h.archive.negotiations(fixture.scope, 'O-7').filter(r => r.kind === 'body');
    assert.deepEqual(rows.map(r => r.outcome).sort(), ['succeeded', 'succeeded']);
    const digests = new Set(rows.map(r => r.digest));
    assert.equal(digests.size, 2);
    // 矛盾双方的原件都按摘要落盘、都可取回，任何一方都不被覆盖
    for (const digest of digests) {
      const original = JSON.parse((await h.archive.original(digest)).toString());
      assert.match(original.body, /版本正文/);
    }
    // 留痕只保存摘要与元数据，不夹带原文字节
    for (const row of rows) assert.ok(!JSON.stringify(row.detail).includes('"bytes"'));
  } finally { await h.close(); }
});

test('不同归档来源给出不同观察时刻：divergent 分歧而非静默择一', async () => {
  const fixture = historySourceFixture({
    cycles, archives,
    bodyHolds: {
      'archive-a': [{ observedAt: '2026-10-05T08:00:00Z', body: '同一内容' }],
      'archive-b': [{ observedAt: '2026-10-12T08:00:00Z', body: '同一内容' }],
    },
    zoneHolds: { 'archive-a': [zoneV4], 'archive-b': [zoneV4] },
  });
  const h = await harness(fixture);
  try {
    const pkg = await h.run('O-8', '2026-10-15T10:00:00Z');
    assert.equal(pkg.components[0].status, 'divergent');
    assert.match(pkg.components[0].reason, /观察时刻不一致/);
  } finally { await h.close(); }
});

test('观察时刻落在周期窗口外：out-of-window，不用当前页顶替', async () => {
  const fixture = historySourceFixture({
    cycles, archives,
    // 只在九月周期有观察，订单在十月周期
    bodyHolds: {
      'archive-a': [{ observedAt: '2026-09-10T08:00:00Z', body: '九月正文' }],
      'archive-b': [{ observedAt: '2026-09-10T08:00:00Z', body: '九月正文' }],
    },
    zoneHolds: {
      'archive-a': [{ observedAt: '2026-09-02T08:00:00Z', edition: 'v4', body: '九月附表' }],
      'archive-b': [{ observedAt: '2026-09-02T08:00:00Z', edition: 'v4', body: '九月附表' }],
    },
  });
  const h = await harness(fixture);
  try {
    const pkg = await h.run('O-9', '2026-10-15T10:00:00Z');
    assert.equal(pkg.components[0].status, 'unavailable');
    assert.equal(pkg.components[0].digest, undefined);
  } finally { await h.close(); }
});

test('订单时点不属于任何发布周期：outside-cycle 且不发起归档协商', async () => {
  const fixture = historySourceFixture({
    cycles, archives,
    bodyHolds: { 'archive-a': [{ observedAt: '2026-10-05T08:00:00Z', body: '正文' }] },
    zoneHolds: { 'archive-a': [zoneV4] },
  });
  const h = await harness(fixture);
  try {
    const pkg = await h.run('O-10', '2026-08-15T10:00:00Z');
    assert.equal(pkg.status, 'outside-cycle');
    assert.equal(pkg.components.length, 0);
    assert.ok(!h.source.accesses.some(a => a.path.includes('/gate')));
  } finally { await h.close(); }
});

test('来源空缺不推断条款不存在：404 只报告不可得，且留痕', async () => {
  const fixture = historySourceFixture({
    cycles,
    archives: [{ source: 'archive-a', gate: '/archive/a/gate' }],
    bodyHolds: { 'archive-a': [] },
    zoneHolds: { 'archive-a': [] },
  });
  const h = await harness(fixture);
  try {
    const pkg = await h.run('O-11', '2026-10-15T10:00:00Z');
    assert.equal(pkg.components[0].status, 'unavailable');
    const appendix = pkg.components.find(c => c.kind === 'appendix');
    assert.equal(appendix.status, 'appendix-missing');
    const rows = h.archive.negotiations(fixture.scope, 'O-11');
    assert.equal(rows.length, 2);
    assert.ok(rows.every(r => r.outcome !== 'succeeded'));
  } finally { await h.close(); }
});

test('时间诚实：observedAt 取自归档声明，不被协商请求时间伪装', async () => {
  const record = interpretMemento({
    page: 'PAGE1', site: 'shop-a', url: 'https://shop.invalid/terms',
    observedAt: '2026-10-05T08:00:00Z', title: 't', body: 'b',
  });
  assert.equal(record.observedAt, '2026-10-05T08:00:00Z');
  assert.throws(() => interpretMemento({ ...record, observedAt: 'not-a-date' }), /观察时间/);
  assert.throws(() => interpretMemento({ ...record, edition: '' }, { requireEdition: true }), /版本/);

  const now = new Date().toISOString();
  const a = { status: 'succeeded', source: 'a', digest: 'd1', record: { observedAt: '2026-10-05T08:00:00Z' }, retrievedAt: now };
  const b = { status: 'succeeded', source: 'b', digest: 'd1', record: { observedAt: '2026-10-05T08:00:00Z' }, retrievedAt: now };
  assert.equal(synthesize([a, b]).status, 'succeeded');
  // 同摘要内容相互印证
  assert.equal(digestOf(Buffer.from('x')), digestOf(Buffer.from('x')));
});

test('关联资料解释：兼容旧版 period/archive，周期为半开区间', () => {
  const legacy = interpretRelations({
    period: ['2026-10-01', '2026-11-01'],
    archive: '/archive/timegate',
    references: [{ page: 'zones', edition: 'v4' }],
  });
  assert.equal(legacy.archives[0].timegate, '/archive/timegate');
  assert.equal(legacy.periods.length, 1);
  assert.equal(legacy.references[0].edition, 'v4');
  const relations = interpretRelations({
    periods: [{ start: '2026-10-01', end: '2026-11-01' }],
    archives: [{ source: 's', timegate: '/g' }],
    references: [],
  });
  // 边界日归入下一周期（半开）
  assert.ok(cycleFor(relations, '2026-10-01T00:00:00Z'));
  assert.equal(cycleFor(relations, '2026-11-01T00:00:00Z'), null);
  assert.equal(cycleFor(relations, '2026-09-30T23:59:59Z'), null);
  assert.throws(() => interpretRelations({ references: [] }), /周期/);
  assert.throws(() => interpretRelations({ periods: [{ start: 'bad', end: '2026-11-01' }], archives: [], references: [] }), /日期/);
});

test('negotiateOne 保留候选清单与实际取得时间，窗口与版本逐项校验', async () => {
  const fixture = historySourceFixture({
    cycles,
    archives: [{ source: 'archive-a', gate: '/archive/a/gate' }],
    bodyHolds: { 'archive-a': [{ observedAt: '2026-10-05T08:00:00Z', body: '正文' }] },
    zoneHolds: { 'archive-a': [zoneV4] },
  });
  const source = await fixtureSource(fixture);
  try {
    const client = new SourceClient(source.url);
    const cycle = cycles[1];
    const entry = await negotiateOne(client, { source: 'archive-a', timegate: '/archive/a/gate' },
      'https://shop.invalid/terms', '2026-10-15T10:00:00Z', cycle);
    assert.equal(entry.status, 'succeeded');
    assert.deepEqual(entry.gate.candidates, [{ observedAt: '2026-10-05T08:00:00Z' }]);
    assert.ok(entry.gate.requestedAt);
    assert.ok(entry.retrievedAt);
    assert.notEqual(entry.gate.requestedAt, entry.record.observedAt);
    // 钉版协商版本不符
    const wrong = await negotiateOne(client, { source: 'archive-a', timegate: '/archive/a/gate' },
      new URL('zones', 'https://shop.invalid/terms').href, '2026-10-15T10:00:00Z', cycle, { edition: 'v9' }).catch(e => ({ status: 'unavailable', reason: e.message }));
    assert.equal(wrong.status, 'unavailable');
  } finally { await source.close(); }
});

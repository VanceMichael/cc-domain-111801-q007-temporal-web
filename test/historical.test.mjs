import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceClient } from '../src/http.mjs';
import { fixtureSource } from '../src/fixture-source.mjs';
import { archiveHandlers } from '../src/fixture-archive.mjs';
import { Archive } from '../src/archive.mjs';
import { collectHistorical, historicalReport } from '../src/app.mjs';
import { interpretRelations, interpretObservation } from '../src/historical.mjs';

const fixture = JSON.parse(await readFile(new URL('../fixtures/source.json', import.meta.url), 'utf8'));
const scope = fixture.scope;

async function setup(custom = fixture, handlers) {
  const source = await fixtureSource(custom, { handlers: handlers ?? archiveHandlers(custom) });
  const directory = await mkdtemp(join(tmpdir(), 'historical-'));
  const archive = await new Archive(directory).start();
  return { source, archive, directory, client: new SourceClient(source.url) };
}

async function teardown(env) {
  env.archive.close();
  await env.source.close();
  await rm(env.directory, { recursive: true, force: true });
}

test('同一周期两版正文取较近版并披露保留版本，附表按引用版本取得', async () => {
  const env = await setup();
  try {
    const packet = await collectHistorical(env.client, env.archive, scope, { id: 'ORD-1', page: 'PAGE1', orderedAt: '2026-10-30T10:00:00Z' });
    assert.equal(packet.status, 'complete');
    assert.equal(packet.content.length, 1);
    assert.equal(packet.content[0].observedAt, '2026-10-20T09:00:00Z');
    assert.deepEqual(packet.content[0].period, ['2026-10-01', '2026-11-01']);
    assert.equal(packet.content[0].sources[0].source, 'archive-alpha');
    assert.ok(Date.parse(packet.content[0].sources[0].acquiredAt));
    const withheld = packet.caveats.find((caveat) => caveat.kind === 'withheld-versions');
    assert.deepEqual(withheld.observedAts, ['2026-10-05T09:00:00Z']);
    assert.equal(packet.annexes.length, 1);
    assert.equal(packet.annexes[0].reference.edition, 'v4');
    assert.equal(packet.annexes[0].status, 'obtained');
    assert.equal(packet.annexes[0].obtained[0].observedAt, '2026-10-18T09:05:00Z');
    const queries = env.source.accesses.filter((access) => access.path === '/archive/timegate').map((access) => access.query);
    assert.ok(queries.some((query) => query.edition === 'v4'));
    assert.ok(!queries.some((query) => query.edition === 'v5'));
    assert.notEqual(packet.annexes[0].obtained[0].observedAt, packet.content[0].observedAt);
  } finally { await teardown(env); }
});

test('同一周期内较早订单取得较早版本及其引用的附表版本', async () => {
  const env = await setup();
  try {
    const packet = await collectHistorical(env.client, env.archive, scope, { id: 'ORD-2', page: 'PAGE1', orderedAt: '2026-10-08T10:00:00Z' });
    assert.equal(packet.status, 'complete');
    assert.equal(packet.content[0].observedAt, '2026-10-05T09:00:00Z');
    assert.equal(packet.content[0].record.body, '十月第一版：本地区运费以订单确认页为准');
    assert.equal(packet.annexes[0].reference.edition, 'v3');
    assert.equal(packet.annexes[0].obtained[0].record.body, 'v3：一区 5.00，二区 8.00');
    const withheld = packet.caveats.find((caveat) => caveat.kind === 'withheld-versions');
    assert.deepEqual(withheld.observedAts, ['2026-10-20T09:00:00Z']);
  } finally { await teardown(env); }
});

test('订单周期外无合适观察，不从资料空缺推断当时没有该条款', async () => {
  const env = await setup();
  try {
    const packet = await collectHistorical(env.client, env.archive, scope, { id: 'ORD-3', page: 'PAGE1', orderedAt: '2026-09-15T10:00:00Z' });
    assert.equal(packet.status, 'content-no-observation');
    assert.equal(packet.content.length, 0);
    assert.equal(packet.issues[0].kind, 'content-no-observation');
    assert.match(packet.issues[0].detail, /不等于当时没有该条款/);
    assert.ok(!env.source.accesses.some((access) => access.query?.edition));
  } finally { await teardown(env); }
});

test('引用附表缺档时标记缺档，不用时间更近的不同版替换', async () => {
  const custom = structuredClone(fixture);
  custom.archives.alpha.versions.PAGE1[1].references = [{ page: 'zones', edition: 'v9' }];
  const env = await setup(custom);
  try {
    const packet = await collectHistorical(env.client, env.archive, scope, { id: 'ORD-4', page: 'PAGE1', orderedAt: '2026-10-30T10:00:00Z' });
    assert.equal(packet.status, 'annex-missing');
    assert.equal(packet.annexes[0].status, 'missing');
    assert.equal(packet.annexes[0].obtained.length, 0);
    assert.equal(packet.issues[0].kind, 'annex-missing');
    assert.ok(!env.source.accesses.some((access) => access.query?.edition === 'v5'));
  } finally { await teardown(env); }
});

test('不同归档来源对同一观察时刻给出不同正文时标记矛盾', async () => {
  const custom = structuredClone(fixture);
  custom.resources['/web/current/relations/PAGE1'] = {
    body: {
      period: ['2026-10-01', '2026-11-01'],
      archives: ['/archive/timegate', '/archive/mirror'],
      references: [{ page: 'zones', edition: 'v4' }],
    },
  };
  custom.archives.mirror = {
    basePath: '/archive/mirror',
    identity: 'archive-mirror',
    versions: {
      PAGE1: [
        {
          observedAt: '2026-10-20T09:00:00Z',
          period: ['2026-10-01', '2026-11-01'],
          record: {
            page: 'PAGE1',
            site: 'shop-a',
            url: 'https://shop.invalid/terms',
            observedAt: '2026-10-20T09:00:00Z',
            title: '运输说明',
            body: '另一来源保存的不同正文',
          },
          references: [{ page: 'zones', edition: 'v4' }],
        },
      ],
    },
    editions: {},
  };
  const env = await setup(custom);
  try {
    const packet = await collectHistorical(env.client, env.archive, scope, { id: 'ORD-5', page: 'PAGE1', orderedAt: '2026-10-30T10:00:00Z' });
    assert.equal(packet.status, 'source-conflict');
    assert.equal(packet.content.length, 2);
    assert.equal(packet.issues[0].kind, 'content-conflict');
    assert.equal(packet.issues[0].observedAt, '2026-10-20T09:00:00Z');
    for (const group of packet.content) {
      for (const source of group.sources) assert.ok(await env.archive.original(source.digest));
    }
  } finally { await teardown(env); }
});

test('历史网址的当前重定向不构成身份依据，协商不跟随重定向', async () => {
  const custom = structuredClone(fixture);
  custom.resources['/web/current/relations/PAGE1'] = {
    body: { archives: ['/archive/timegate', '/archive/mirror'] },
  };
  const handlers = {
    ...archiveHandlers(custom),
    '/archive/mirror': () => ({ status: 301, headers: { location: '/web/current/records/PAGE1' }, body: { error: '已迁移至新品牌页' } }),
  };
  const env = await setup(custom, handlers);
  try {
    const packet = await collectHistorical(env.client, env.archive, scope, { id: 'ORD-6', page: 'PAGE1', orderedAt: '2026-10-30T10:00:00Z' });
    assert.equal(packet.status, 'complete');
    const caveat = packet.caveats.find((entry) => entry.kind === 'source-unavailable');
    assert.equal(caveat.archive, '/archive/mirror');
    assert.ok(!env.source.accesses.some((access) => access.path === '/web/current/records/PAGE1'));
  } finally { await teardown(env); }
});

test('协商失败保留既有历史原文与收据，不写入最新页', async () => {
  const env = await setup();
  try {
    const order = { id: 'ORD-7', page: 'PAGE1', orderedAt: '2026-10-30T10:00:00Z' };
    const first = await collectHistorical(env.client, env.archive, scope, order);
    assert.equal(first.status, 'complete');
    const contentDigest = first.content[0].sources[0].digest;
    const before = env.archive.records(scope).length;
    env.source.fail('/archive/timegate', 503, 10);
    const second = await collectHistorical(env.client, env.archive, scope, order);
    assert.equal(second.status, 'negotiation-failed');
    assert.equal(second.content.length, 0);
    const original = JSON.parse((await env.archive.original(contentDigest)).toString('utf8'));
    assert.equal(original.observedAt, '2026-10-20T09:00:00Z');
    assert.equal(original.record.body, '十月第二版：本地区运费以地区附表为准');
    const report = await historicalReport(env.archive, scope, 'ORD-7');
    assert.equal(report.packages.length, 2);
    assert.equal(report.packages[0].status, 'complete');
    assert.equal(report.packages[1].status, 'negotiation-failed');
    assert.ok(env.archive.records(scope).length > before);
  } finally { await teardown(env); }
});

test('查询返回实际取得时间与归档来源，不伪装页面发布时间', async () => {
  const env = await setup();
  try {
    await collectHistorical(env.client, env.archive, scope, { id: 'ORD-8', page: 'PAGE1', orderedAt: '2026-10-30T10:00:00Z' });
    const report = await historicalReport(env.archive, scope, 'ORD-8');
    assert.equal(report.packages.length, 1);
    const item = report.packages[0].content[0];
    assert.equal(item.observedAt, '2026-10-20T09:00:00Z');
    assert.equal(item.sources[0].source, 'archive-alpha');
    assert.ok(Date.parse(item.sources[0].acquiredAt));
    assert.notEqual(item.sources[0].acquiredAt, item.observedAt);
    assert.ok(Date.parse(report.packages[0].assembledAt));
  } finally { await teardown(env); }
});

test('归档返回订单周期外的观察时拒绝采纳', async () => {
  const custom = structuredClone(fixture);
  const handlers = {
    '/archive/timegate': () => ({
      status: 200,
      body: {
        page: 'PAGE1',
        site: 'shop-a',
        source: 'archive-alpha',
        observedAt: '2026-09-01T09:00:00Z',
        period: ['2026-09-01', '2026-10-01'],
        record: {
          page: 'PAGE1',
          site: 'shop-a',
          url: 'https://shop.invalid/terms',
          observedAt: '2026-09-01T09:00:00Z',
          title: '运输说明',
          body: '上一周期的旧版正文',
        },
        references: [],
        withheld: [],
      },
    }),
  };
  const env = await setup(custom, handlers);
  try {
    const packet = await collectHistorical(env.client, env.archive, scope, { id: 'ORD-9', page: 'PAGE1', orderedAt: '2026-10-30T10:00:00Z' });
    assert.equal(packet.status, 'negotiation-failed');
    assert.equal(packet.content.length, 0);
    assert.match(packet.issues[0].reason, /周期之外/);
  } finally { await teardown(env); }
});

test('关联资料与历史观察的字段校验', () => {
  assert.throws(() => interpretRelations({}), /归档入口/);
  assert.throws(() => interpretRelations({ archive: 'http://outside.invalid/x' }), /同源路径/);
  const relations = interpretRelations({ archive: '/archive/timegate', period: ['2026-10-01', '2026-11-01'], references: [{ page: 'zones', edition: 'v4' }] });
  assert.deepEqual(relations.archives, ['/archive/timegate']);
  assert.equal(relations.period.start, '2026-10-01');
  assert.throws(() => interpretObservation({
    page: 'PAGE1',
    site: 'shop-a',
    source: 'archive-alpha',
    observedAt: '2026-10-20T09:00:00Z',
    period: ['2026-11-01', '2026-10-01'],
    record: {},
  }), /周期/);
});

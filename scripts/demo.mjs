import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceClient } from '../src/http.mjs';
import { Archive } from '../src/archive.mjs';
import { fixtureSource } from '../src/fixture-source.mjs';
import { archiveHandlers } from '../src/fixture-archive.mjs';
import { collect, collectHistorical, historicalReport } from '../src/app.mjs';

const fixture = JSON.parse(await readFile(new URL('../fixtures/source.json', import.meta.url), 'utf8'));
const source = await fixtureSource(fixture, { handlers: archiveHandlers(fixture) });

const directory = await mkdtemp(join(tmpdir(), 'temporal-web-'));
const archive = await new Archive(directory).start();
try {
  const client = new SourceClient(source.url);
  const result = await collect(client, archive, fixture.scope);
  console.log(JSON.stringify(result, null, 2));
  console.log('已保存原文与收件记录：', archive.records(fixture.scope).length);

  const orders = [
    { id: 'ORD-2026-10-08', page: 'PAGE1', orderedAt: '2026-10-08T10:00:00Z' },
    { id: 'ORD-2026-10-30', page: 'PAGE1', orderedAt: '2026-10-30T10:00:00Z' },
  ];
  for (const order of orders) {
    const packet = await collectHistorical(client, archive, fixture.scope, order);
    console.log('历史包 ' + order.id + ' 状态：' + packet.status);
    console.log(JSON.stringify(packet, null, 2));
  }
  const report = await historicalReport(archive, fixture.scope, 'ORD-2026-10-08');
  console.log('订单 ORD-2026-10-08 可查历史包：', report.packages.length);

  if (!result.complete) process.exitCode = 1;
} finally { archive.close(); await source.close();  await rm(directory, { recursive: true, force: true }); }

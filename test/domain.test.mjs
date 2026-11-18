import test from 'node:test';
import assert from 'node:assert/strict';
import { interpret } from '../src/interpret.mjs';
import { assess, summarize } from '../src/receiving.mjs';
const raw = {"page": "PAGE1", "site": "shop-a", "url": "https://shop.invalid/terms", "observedAt": "2026-11-01T09:00:00Z", "title": "运输说明", "body": "本地区运费以订单确认页为准"};
const scope = "shop-a";

test('领域记录保留明确的来源上下文', () => {
  const actual = interpret(raw);
  assert.equal(actual.site, raw.site);
  assert.equal(assess(actual, [actual], scope).status, 'accepted');
});
test('同一业务依据发生矛盾时不能覆盖接收', () => {
  const first = interpret(raw);
  const changed = interpret({"page": "PAGE1", "site": "shop-a", "url": "https://shop.invalid/terms", "observedAt": "2026-11-01T09:00:00Z", "title": "运输说明", "body": "另一个正文"});
  assert.equal(assess(changed, [first], scope).status, 'conflict');
});
test('空目录与范围外内容不声明完成', () => {
  assert.equal(summarize([]).complete, false);
  const outcome = assess(interpret(raw), [], 'other-scope');
  assert.equal(summarize([outcome]).complete, false);
  assert.equal(summarize([outcome]).counts.outside, 1);
});

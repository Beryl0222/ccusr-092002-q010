import assert from "node:assert/strict";
import test from "node:test";

import { stableBucket, stableUnit } from "../src/hash.js";

test("稳定哈希：相同输入跨调用一致", () => {
  assert.equal(stableUnit("exp|user-1"), stableUnit("exp|user-1"));
});

test("稳定哈希：不同输入大概率不同且落在 [0,1)", () => {
  const values = new Set();
  for (let i = 0; i < 500; i++) values.add(stableUnit(`exp|u${i}`));
  assert.equal(values.size, 500);
  for (const value of values) {
    assert.ok(value >= 0 && value < 1);
  }
});

test("分桶：结果稳定且覆盖桶空间", () => {
  const seen = new Set();
  for (let i = 0; i < 1000; i++) seen.add(stableBucket(`e|${i}`, 100));
  assert.ok(seen.size > 90, `只覆盖了 ${seen.size} 个桶，分布异常`);
  for (const bucket of seen) assert.ok(Number.isInteger(bucket) && bucket >= 0 && bucket < 100);
  assert.equal(stableBucket("e|u1", 100), stableBucket("e|u1", 100));
});

test("分桶参数非法时报错", () => {
  assert.throws(() => stableBucket("x", 0), /正整数/);
  assert.throws(() => stableBucket("x", 1.5), /正整数/);
});

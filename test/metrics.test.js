import assert from "node:assert/strict";
import test from "node:test";

import { newcombeDiff, recommendDecision, wilsonInterval } from "../src/metrics.js";

test("Wilson 区间：n=0 返回 null，否则覆盖点估计且在 [0,1]", () => {
  assert.equal(wilsonInterval(0, 0), null);
  const ci = wilsonInterval(3, 10);
  assert.equal(ci.value, 0.3);
  assert.ok(ci.ci_low <= 0.3 && 0.3 <= ci.ci_high);
  assert.ok(ci.ci_low >= 0 && ci.ci_high <= 1);
  assert.deepEqual(
    { numerator: ci.numerator, denominator: ci.denominator },
    { numerator: 3, denominator: 10 },
  );
});

test("Wilson：极端比例不越界，小样本区间更宽", () => {
  const all = wilsonInterval(10, 10);
  assert.ok(all.ci_low > 0 && all.ci_high === 1);
  const small = wilsonInterval(5, 10);
  const large = wilsonInterval(500, 1000);
  assert.ok(small.ci_high - small.ci_low > large.ci_high - large.ci_low);
});

test("Newcombe 差值：无显著差异时区间跨 0", () => {
  const diff = newcombeDiff(15, 33, 15, 27);
  assert.ok(diff.ci_low < 0 && diff.ci_high > 0);
  assert.ok(Math.abs(diff.diff - (15 / 33 - 15 / 27)) < 1e-12);
});

test("Newcombe：样本为 0 时返回 null", () => {
  assert.equal(newcombeDiff(1, 0, 0, 0), null);
});

test("决策建议：显著改善且护栏无恶化 => promote", () => {
  const report = {
    metric_definition: { objective: "minimize" },
    comparisons: { treat: { suppressed: false, control_arm: "control", diff: -0.2, ci_low: -0.3, ci_high: -0.05 } },
    arms: {
      control: { primary: { metrics: { bad_debt_rate: { suppressed: false, numerator: 1, denominator: 50 } } } },
      treat: { primary: { metrics: { bad_debt_rate: { suppressed: false, numerator: 1, denominator: 50 } } } },
    },
  };
  const rec = recommendDecision(report, ["bad_debt_rate"]);
  assert.equal(rec.treat.decision, "promote");
});

test("决策建议：主指标显著恶化 => rollback", () => {
  const report = {
    metric_definition: { objective: "minimize" },
    comparisons: { treat: { suppressed: false, control_arm: "control", diff: 0.2, ci_low: 0.05, ci_high: 0.3 } },
    arms: { control: { primary: { metrics: {} } }, treat: { primary: { metrics: {} } } },
  };
  assert.equal(recommendDecision(report, []).treat.decision, "rollback");
});

test("决策建议：区间跨 0 => observe", () => {
  const report = {
    metric_definition: { objective: "minimize" },
    comparisons: { treat: { suppressed: false, control_arm: "control", diff: -0.01, ci_low: -0.1, ci_high: 0.08 } },
    arms: { control: { primary: { metrics: {} } }, treat: { primary: { metrics: {} } } },
  };
  assert.equal(recommendDecision(report, []).treat.decision, "observe");
});

test("决策建议：主指标变好但护栏坏账显著恶化 => 不允许 promote", () => {
  const report = {
    metric_definition: { objective: "minimize" },
    comparisons: { treat: { suppressed: false, control_arm: "control", diff: -0.2, ci_low: -0.3, ci_high: -0.05 } },
    arms: {
      control: { primary: { metrics: { bad_debt_rate: { suppressed: false, numerator: 0, denominator: 50, ci_low: 0, ci_high: 0.02, value: 0 } } } },
      treat: { primary: { metrics: { bad_debt_rate: { suppressed: false, numerator: 10, denominator: 50, ci_low: 0.1, ci_high: 0.3, value: 0.2 } } } },
    },
  };
  const rec = recommendDecision(report, ["bad_debt_rate"]);
  assert.equal(rec.treat.decision, "observe");
  assert.ok(rec.treat.reasons.some((r) => r.includes("bad_debt_rate")));
});

test("决策建议：隐私掩码 => observe", () => {
  const report = {
    metric_definition: { objective: "minimize" },
    comparisons: { treat: { suppressed: true } },
    arms: {},
  };
  assert.equal(recommendDecision(report, []).treat.decision, "observe");
});

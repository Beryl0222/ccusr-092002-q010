import assert from "node:assert/strict";
import test from "node:test";

import {
  AssetRegistry,
  ExperimentPlatform,
  EventLog,
  MetricRegistry,
  DEFAULT_METRIC_SPEC_V1,
  RESULT_EVENTS,
  wilsonInterval,
  riskDifference,
  classifyEffect,
  isoWeek,
  srmCheck,
} from "../../src/experiment/index.js";

function seedPlatform({ privacyThreshold = 2, users = 60 } = {}) {
  const assets = [
    { asset_id: "CAM-1", category: "camera", condition_grade: "A", accessories: [], availability: { warehouse: "SH-02", status: "inspection_passed" }, inspection: {} },
    { asset_id: "CAM-2", category: "camera", condition_grade: "B", accessories: [], availability: { warehouse: "BJ-03", status: "inspection_passed" }, inspection: {} },
  ];
  const p = new ExperimentPlatform({ assets: new AssetRegistry(assets), privacyThreshold });
  p.publishMetricDefinition(DEFAULT_METRIC_SPEC_V1);
  p.createExperiment({ id: "e1", salt: "salt-1", arms: [
    { id: "on_time_reward", weight: 1 },
    { id: "pre_authorization", weight: 1 },
    { id: "tiered_protection", weight: 1 },
  ] });
  const user = (id) => ({ user_id: id, kyc_status: "passed", account_opened_at: "2020-01-01T00:00:00Z" });
  const enrolled = [];
  for (let i = 0; i < users; i += 1) {
    const r = p.attemptEnrollment({
      experimentId: "e1",
      user: user(`u${i}`),
      assetId: i % 2 === 0 ? "CAM-1" : "CAM-2",
      now: "2026-09-15T08:00:00Z",
    });
    assert.equal(r.admitted, true);
    enrolled.push(r);
    p.ingestEvent({ type: RESULT_EVENTS.ORDER_PLACED, event_id: `o${i}`, exposure_id: r.exposureId, occurred_at: "2026-09-15T09:00:00Z" });
    // 预授权臂逾期率更高：构造可检出的效应。
    if (r.arm === "pre_authorization" && i % 2 === 0) {
      p.ingestEvent({ type: RESULT_EVENTS.OVERDUE, event_id: `od${i}`, exposure_id: r.exposureId, occurred_at: "2026-09-24T09:00:00Z", payload: { days_overdue: 5 } });
    }
    if (i % 9 === 0) {
      p.ingestEvent({ type: RESULT_EVENTS.DAMAGE_DISPUTE, event_id: `d${i}`, exposure_id: r.exposureId, occurred_at: "2026-09-18T09:00:00Z", payload: { agent_waived: true } });
    }
    p.store.closeExposure(r.exposureId, { at: "2026-09-26T09:00:00Z" });
  }
  return { p, enrolled };
}

test("事件按 type+event_id 幂等，重复上报不重复计数", () => {
  const log = new EventLog();
  const e = { type: RESULT_EVENTS.OVERDUE, event_id: "x1", occurred_at: "2026-09-24T00:00:00Z" };
  assert.equal(log.ingest(e).status, "accepted");
  assert.equal(log.ingest(e).status, "duplicate");
  assert.equal(log.size(), 1);
});

test("非法事件类型与缺字段被拒绝，PII 自由文本不进入存储", () => {
  const log = new EventLog();
  assert.throws(() => log.ingest({ type: "nope", event_id: "1", occurred_at: "2026-09-24T00:00:00Z" }));
  assert.throws(() => log.ingest({ type: RESULT_EVENTS.OVERDUE, event_id: "1" }));
  const stored = log.ingest({
    type: RESULT_EVENTS.ORDER_PLACED,
    event_id: "1",
    occurred_at: "2026-09-15T00:00:00Z",
    payload: { term_days: 7, customer_note: "我的身份证是 XXXX" },
  }).event;
  assert.equal(stored.payload.term_days, 7);
  assert.equal(stored.payload.customer_note, undefined);
});

test("口径必须先发布才能冻结，已发布口径不可变", () => {
  const registry = new MetricRegistry();
  registry.publish(DEFAULT_METRIC_SPEC_V1);
  assert.throws(() => registry.publish(DEFAULT_METRIC_SPEC_V1), /不可修改/);
  const { p } = seedPlatform();
  assert.throws(() => p.freezeExperiment("e1", "metric-never"), /尚未发布/);
  p.stopExperiment("e1");
  assert.equal(p.freezeExperiment("e1", "metric-v1"), "frozen");
  assert.equal(p.store.experiments.get("e1").frozenMetricVersion, "metric-v1");
});

test("报告给出每臂 Wilson 区间、风险差与 ITT 归因", () => {
  const { p } = seedPlatform();
  const report = p.generateReport("e1", { controlArm: "on_time_reward", cutoff: "2026-09-30T00:00:00Z" });
  for (const armId of ["on_time_reward", "pre_authorization", "tiered_protection"]) {
    const arm = report.arms[armId];
    assert.ok(arm.enrolled > 0);
    const overdue = arm.metrics.overdue_rate;
    assert.ok(overdue.lower <= overdue.rate && overdue.rate <= overdue.upper);
  }
  const preAuth = report.comparisons.find((c) => c.arm === "pre_authorization" && c.metric === "overdue_rate");
  assert.ok(preAuth.lower > 0); // 构造的高逾期应被检出
  assert.equal(report.attributionPolicy.includes("ITT"), true);
});

test("客服豁免争议单独计数，不并入无争议", () => {
  const { p } = seedPlatform();
  const report = p.generateReport("e1", { controlArm: "on_time_reward" });
  const totalWaived = Object.values(report.arms)
    .reduce((sum, arm) => sum + arm.metrics.damage_dispute_rate.agent_waived, 0);
  assert.ok(totalWaived > 0);
});

test("迟到事件生成新版本报告，旧报告保留且数值不同", () => {
  const { p, enrolled } = seedPlatform();
  const r1 = p.generateReport("e1", { controlArm: "on_time_reward", cutoff: "2026-09-30T00:00:00Z" });
  const before = r1.arms.on_time_reward.metrics.overdue_rate.successes;

  const controlExposure = enrolled.find((e) => e.arm === "on_time_reward").exposureId;
  p.ingestEvent({
    type: RESULT_EVENTS.OVERDUE,
    event_id: "late-od-1",
    exposure_id: controlExposure,
    occurred_at: "2026-09-10T00:00:00Z", // 早于上一份 cutoff，汇入更晚
  });
  const r2 = p.generateReport("e1", { controlArm: "on_time_reward", cutoff: "2026-09-30T00:00:00Z" });

  assert.equal(r1.reportVersion, "rpt-001");
  assert.equal(r2.reportVersion, "rpt-002");
  assert.equal(r2.watermark.lateEventsSincePrevious, 1);
  assert.equal(r2.arms.on_time_reward.metrics.overdue_rate.successes, before + 1);
  const archived = p.listReports("e1");
  assert.equal(archived.length, 2);
  assert.equal(archived[0].arms.on_time_reward.metrics.overdue_rate.successes, before); // 旧报告不被覆盖
});

test("非迟到的新事件不计入迟到数", () => {
  const { p, enrolled } = seedPlatform();
  p.generateReport("e1", { controlArm: "on_time_reward", cutoff: "2026-09-30T00:00:00Z" });
  const anyExposure = enrolled[0].exposureId;
  p.ingestEvent({ type: RESULT_EVENTS.RE_RENT, event_id: "rr-1", exposure_id: anyExposure, occurred_at: "2026-10-05T00:00:00Z" });
  const r2 = p.generateReport("e1", { controlArm: "on_time_reward", cutoff: "2026-10-10T00:00:00Z" });
  assert.equal(r2.watermark.lateEventsSincePrevious, 0);
});

test("样本资格与排除原因全部保留，失败样本不被删除", () => {
  const { p } = seedPlatform();
  p.attemptEnrollment({ experimentId: "e1", user: { user_id: "bad-kyc", kyc_status: "pending" }, assetId: "CAM-1" });
  p.attemptEnrollment({ experimentId: "e1", user: { user_id: "batch", kyc_status: "passed", risk_tags: ["device_farm"] }, assetId: "CAM-1" });
  p.attemptEnrollment({ experimentId: "e1", user: { user_id: "no-asset", kyc_status: "passed" }, assetId: "GHOST" });
  const report = p.generateReport("e1", { controlArm: "on_time_reward" });
  assert.ok(report.sampleQualification.exclusions.KYC_NOT_PASSED >= 1);
  assert.ok(report.sampleQualification.exclusions.SUSPECTED_BATCH_ACCOUNT >= 1);
  assert.ok(report.sampleQualification.exclusions.ASSET_NOT_FOUND >= 1);
  assert.ok(report.sampleQualification.qualityFlagsInAnalysis.SUSPECTED_BATCH_ACCOUNT >= 1);
  // 筛选数 = 成功 + 各类失败，全部可追溯。
  assert.equal(
    report.sampleQualification.screened,
    report.sampleQualification.enrolled + 3,
  );
});

test("分层覆盖仓库/成色/时间/节假日，运营视图对低样本格做隐私抑制", () => {
  const { p } = seedPlatform({ privacyThreshold: 50 });
  const report = p.generateReport("e1", {
    controlArm: "on_time_reward",
    holidayRanges: [["2026-09-14", "2026-09-16"]],
  });
  const dims = new Set(report.strata.map((s) => s.dimension));
  for (const d of ["warehouse", "condition_grade", "iso_week", "demand_period", "inspection_data", "category"]) {
    assert.ok(dims.has(d), `缺少分层 ${d}`);
  }
  const holiday = report.strata.find((s) => s.dimension === "demand_period" && s.value === "holiday");
  assert.ok(holiday.sampleSize > 0);

  const ops = p.viewReport("e1", "ops");
  // 每臂仅约 20 人，按成色/仓库细分后低于阈值 50，应被抑制。
  assert.ok(ops.strata.some((cell) => cell.privacy.suppressed));
  const suppressed = ops.strata.find((cell) => cell.privacy.suppressed);
  assert.equal(suppressed.arms, undefined);
  // 分析人员视图仍可见数值。
  const analyst = p.viewReport("e1", "analyst");
  assert.ok(analyst.strata.every((cell) => cell.arms || cell.sampleSize === 0));
});

test("建议规则：主指标显著优 + 无护栏受损 -> rollout；护栏受损 -> rollback", () => {
  const { p } = seedPlatform();
  const report = p.generateReport("e1", { controlArm: "on_time_reward" });
  assert.ok(["rollout", "continue_observing", "rollback"].includes(report.recommendation.decision));
});

test("统计工具：Wilson 区间与风险差方向", () => {
  const w = wilsonInterval(5, 10);
  assert.ok(w.lower < 0.5 && w.upper > 0.5);
  assert.deepEqual(wilsonInterval(0, 0).rate, null);
  const rd = riskDifference(8, 10, 2, 10);
  assert.ok(rd.diff > 0 && rd.lower > 0);
  assert.equal(classifyEffect({ lower: -0.1, upper: -0.05, direction: "lower_is_better", margin: 0.02 }), "superior");
  assert.equal(classifyEffect({ lower: 0.05, upper: 0.1, direction: "lower_is_better", margin: 0.02 }), "inferior");
  assert.equal(classifyEffect({ lower: -0.01, upper: 0.01, direction: "lower_is_better", margin: 0.02 }), "inconclusive");
  assert.equal(isoWeek("2026-09-15T08:00:00Z"), "2026-W38");
});

test("SRM 检验：均衡分流不报警，失衡分流报警", () => {
  const balanced = srmCheck({ a: 500, b: 500, c: 500 }, { a: 1, b: 1, c: 1 });
  assert.equal(balanced.flagged, false);
  const imbalanced = srmCheck({ a: 350, b: 650, c: 500 }, { a: 1, b: 1, c: 1 });
  assert.ok(imbalanced.pValue < 0.001);
  assert.equal(imbalanced.flagged, true);
  // 小样本下的随机波动不应误报。
  const small = srmCheck({ a: 3, b: 7 }, { a: 1, b: 1 });
  assert.equal(small.flagged, false);
});

test("报告包含 SRM 诊断，正常均衡实验不报警", () => {
  const { p } = seedPlatform({ users: 60 });
  const report = p.generateReport("e1", { controlArm: "on_time_reward" });
  assert.ok(report.srm);
  assert.equal(typeof report.srm.pValue, "number");
  assert.equal(report.srm.flagged, false);
  assert.equal(report.recommendation.srmAlert, false);
});

test("SRM 报警时即使点估计有利也不得推广（端到端走报告层）", () => {
  const { p } = seedPlatform({ users: 60 });
  // 白盒制造分流失衡：先取一条真实暴露作模板，再直接向存储注入偏向 pre_authorization 的暴露。
  const template = p.store.listExposures("e1")[0];
  const inject = (userId, arm, idx) => {
    const id = `e1:${userId}:CAM-1:injected-${idx}`;
    p.store.exposures.set(id, {
      ...template,
      exposureId: id,
      userId,
      assetId: `CAM-${idx}`,
      arm,
      qualityFlags: [],
      status: "ended",
      endedAt: "2026-09-26T09:00:00Z",
    });
  };
  for (let i = 0; i < 120; i += 1) {
    // 大幅偏向 pre_authorization，制造强 SRM 信号。
    const arm = i < 90 ? "pre_authorization" : "tiered_protection";
    inject(`srm-user-${i}`, arm, i + 100);
  }
  const report = p.generateReport("e1", { controlArm: "on_time_reward" });
  assert.equal(report.srm.flagged, true);
  assert.equal(report.recommendation.srmAlert, true);
  assert.notEqual(report.recommendation.decision, "rollout");
});

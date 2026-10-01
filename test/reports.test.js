import assert from "node:assert/strict";
import test from "node:test";

import { createStandardExperiment, makeService, metricDefinition, user } from "./helpers.js";

const ASSETS = [
  "CAM-R50-0018",
  "CAM-R50-0021",
  "CAM-M6-0007",
  "DRN-AV2-0104",
  "TNT-4P-0210",
  "TNT-4P-0215",
  "PRJ-4K-0050",
  "PRJ-4K-0052",
];

function seed(service, { n = 16, overdueEvery = 2 } = {}) {
  createStandardExperiment(service);
  for (let i = 1; i <= n; i++) {
    service.assign({
      experiment_id: "e1",
      user: user(`u${i}`),
      asset_id: ASSETS[i % ASSETS.length],
      rental_id: `r${i}`,
      at: `2026-09-${String((i % 28) + 1).padStart(2, "0")}T10:00:00+08:00`,
    });
    service.ingestEvent({ event_id: `o${i}`, type: "order", rental_id: `r${i}`, occurred_at: `2026-09-${String((i % 28) + 1).padStart(2, "0")}T11:00:00+08:00` });
    if (i % overdueEvery === 0) {
      service.ingestEvent({ event_id: `od${i}`, type: "overdue", rental_id: `r${i}`, occurred_at: "2026-09-25T11:00:00+08:00" });
    }
  }
}

test("冻结门禁：未发布指标口径不能冻结，也不能出报告", async () => {
  const service = await makeService();
  createStandardExperiment(service);
  assert.throws(() => service.freezeExperiment("e1"), (err) => err.code === "metric_definition_missing");
  assert.throws(() => service.recompute("e1"), (err) => err.code === "metric_definition_missing");

  assert.throws(
    () => service.publishMetricDefinition({ experiment_id: "e1", primary_metric: "nope", metrics: ["nope"] }),
    (err) => err.code === "invalid_metric_definition",
  );
});

test("口径版本化：重复版本号被拒绝，冻结后不可变更", async () => {
  const service = await makeService();
  createStandardExperiment(service);
  service.publishMetricDefinition(metricDefinition("e1", { version: 1 }));
  assert.throws(
    () => service.publishMetricDefinition(metricDefinition("e1", { version: 1 })),
    (err) => err.code === "metric_version_exists",
  );
  service.publishMetricDefinition(metricDefinition("e1", { privacy_threshold: 3, note: "收紧阈值" }));
  assert.equal(service.currentMetricDefinition("e1").version, 2);

  service.freezeExperiment("e1");
  assert.throws(
    () => service.publishMetricDefinition(metricDefinition("e1", { privacy_threshold: 2 })),
    (err) => err.code === "experiment_frozen",
  );
});

test("报告不可变：迟到事件生成新版本，旧报告原样保留", async () => {
  const service = await makeService();
  seed(service);
  service.publishMetricDefinition(metricDefinition());
  const v1Snapshot = service.recompute("e1", { trigger: "manual" });
  service.freezeExperiment("e1");

  const v1Overdue = (() => {
    const arms = Object.values(v1Snapshot.content.arms);
    return arms.reduce((s, a) => s + a.primary.metrics.overdue_rate.numerator, 0);
  })();

  // 一条落在已报告窗口内的迟到逾期事件
  service.ingestEvent({ event_id: "od-late", type: "overdue", rental_id: "r1", occurred_at: "2026-09-20T11:00:00+08:00" });

  const versions = service.listReports("e1");
  assert.deepEqual(versions.map((v) => v.trigger), ["manual", "late_event"]);

  const v1Fetched = service.getReport("e1", 1);
  const v1FetchedOverdue = Object.values(v1Fetched.content.arms).reduce(
    (s, a) => s + a.primary.metrics.overdue_rate.numerator,
    0,
  );
  assert.equal(v1FetchedOverdue, v1Overdue, "旧报告不被覆盖");

  const v2 = service.getReport("e1", 2);
  const v2Overdue = Object.values(v2.content.arms).reduce(
    (s, a) => s + a.primary.metrics.overdue_rate.numerator,
    0,
  );
  assert.equal(v2Overdue, v1Overdue + 1, "新版本包含迟到事件");
});

test("报告包含资格、排除原因、分层、不确定性与决策建议", async () => {
  const service = await makeService();
  seed(service, { n: 16 });
  // 制造排除留痕
  service.assign({
    experiment_id: "e1",
    user: user("x1", { credit_status: "blocked", credit_score: 300 }),
    asset_id: "CAM-R50-0018",
    rental_id: "rx1",
    at: "2026-09-15T10:00:00+08:00",
  });
  service.assign({
    experiment_id: "e1",
    user: user("x2"),
    asset_id: "TNT-2P-0088",
    rental_id: "rx2",
    at: "2026-09-15T10:00:00+08:00",
  });

  service.publishMetricDefinition(metricDefinition());
  const report = service.recompute("e1").content;

  assert.ok(report.cohort.excluded.credit_blocked >= 1);
  assert.ok(report.cohort.excluded.asset_not_rentable >= 1);

  const treat = report.arms.treat.primary;
  const overdue = treat.metrics.overdue_rate;
  assert.equal(overdue.suppressed, false);
  assert.ok(overdue.ci_low <= overdue.value && overdue.value <= overdue.ci_high);

  const strata = report.arms.treat.strata;
  assert.ok(Object.keys(strata.warehouse).length >= 1);
  assert.ok(Object.keys(strata.month).length >= 1);
  assert.ok(Object.keys(strata.condition_grade).length >= 1);

  const recommendation = report.recommendations.treat;
  assert.ok(["promote", "rollback", "observe"].includes(recommendation.decision));
  assert.ok(recommendation.scope_note.includes("不得用于干预单笔租赁"));
  assert.ok(recommendation.basis.sample.denominator > 0);
});

test("隐私阈值：低于 k 的臂/分层单元掩码，运营只看掩码结果", async () => {
  const service = await makeService();
  createStandardExperiment(service);
  // 仅 2 个曝光，阈值 5
  for (let i = 1; i <= 2; i++) {
    service.assign({
      experiment_id: "e1",
      user: user(`u${i}`),
      asset_id: ASSETS[i],
      rental_id: `r${i}`,
      at: "2026-09-10T10:00:00+08:00",
    });
  }
  service.publishMetricDefinition(metricDefinition("e1", { privacy_threshold: 5 }));
  service.recompute("e1");
  service.freezeExperiment("e1");

  const analyst = service.viewReport("e1", { role: "analyst" });
  for (const arm of Object.values(analyst.content.arms)) {
    assert.equal(arm.primary.metrics.overdue_rate.suppressed, true);
  }

  const operator = service.viewReport("e1", { role: "operator" });
  assert.equal(operator.data_quality.quarantined_event_count === undefined, false);
  for (const arm of Object.values(operator.arms)) {
    assert.equal(arm.primary.metrics.overdue_rate.suppressed, true);
    // 运营视图不含 clean_only 等敏感细节
    assert.equal(arm.clean_only, undefined);
  }
});

test("运营在实验冻结前看不到报告", async () => {
  const service = await makeService();
  seed(service, { n: 8 });
  service.publishMetricDefinition(metricDefinition());
  service.recompute("e1");
  assert.throws(
    () => service.viewReport("e1", { role: "operator" }),
    (err) => err.code === "report_not_published",
  );
  // 分析师可以看预览
  assert.ok(service.viewReport("e1", { role: "analyst" }));
});

test("停止后的续租曝光不进入主分析窗口，但计入 post_stop 计数", async () => {
  const service = await makeService();
  createStandardExperiment(service);
  const first = service.assign({
    experiment_id: "e1",
    user: user("u1"),
    asset_id: "CAM-R50-0018",
    rental_id: "r1",
    at: "2026-09-05T10:00:00+08:00",
  });
  service.stopExperiment("e1", "2026-09-20T00:00:00+08:00");
  service.assign({
    experiment_id: "e1",
    user: user("u1"),
    asset_id: "CAM-R50-0018",
    rental_id: "r1b",
    renewal_of: first.exposure_id,
    at: "2026-09-22T10:00:00+08:00",
  });
  service.publishMetricDefinition(metricDefinition());
  const report = service.recompute("e1").content;
  assert.equal(report.cohort.eligible_exposures, 1);
  assert.equal(report.cohort.post_stop_renewal_segments, 1);
});

test("三种策略实验在同一互斥组并存：资产归还后可依次参与", async () => {
  const service = await makeService();
  const arms = [
    { id: "control", name: "对照", allocation: [0, 340] },
    { id: "strategy", name: "策略", allocation: [340, 1000] },
  ];
  for (const [id, name] of [
    ["preauth", "提前预授权"],
    ["tiered", "分层保障计划"],
    ["reward", "按时归还奖励"],
  ]) {
    service.createExperiment({ id, name, mutex_group: "rental_strategy", arms, starts_at: "2026-09-01T00:00:00+08:00" });
  }

  const inPreauth = service.assign({
    experiment_id: "preauth",
    user: user("u1"),
    asset_id: "CAM-R50-0018",
    rental_id: "r1",
    at: "2026-09-03T10:00:00+08:00",
  });
  assert.equal(inPreauth.eligible, true);

  for (const otherId of ["tiered", "reward"]) {
    const blocked = service.assign({
      experiment_id: otherId,
      user: user("u1"),
      asset_id: "CAM-R50-0018",
      rental_id: `r-${otherId}`,
      at: "2026-09-04T10:00:00+08:00",
    });
    assert.equal(blocked.eligible, false);
  }

  service.ingestEvent({ event_id: "ret1", type: "return", rental_id: "r1", occurred_at: "2026-09-10T10:00:00+08:00" });
  const inReward = service.assign({
    experiment_id: "reward",
    user: user("u1"),
    asset_id: "CAM-R50-0018",
    rental_id: "r2",
    at: "2026-09-11T10:00:00+08:00",
  });
  assert.equal(inReward.eligible, true);
});

test("续租新 rental_id 的结果事件归并回原曝光，且不产生新曝光", async () => {
  const service = await makeService();
  createStandardExperiment(service);
  const first = service.assign({
    experiment_id: "e1",
    user: user("u1"),
    asset_id: "CAM-R50-0018",
    rental_id: "r1",
    at: "2026-09-05T10:00:00+08:00",
  });
  const renewed = service.assign({
    experiment_id: "e1",
    user: user("u1"),
    asset_id: "CAM-R50-0018",
    rental_id: "r1-renew",
    renewal_of: first.exposure_id,
    at: "2026-09-15T10:00:00+08:00",
  });
  assert.equal(renewed.arm_id, first.arm_id);

  // 用续租合同号汇入的逾期事件，应落在原曝光上
  service.ingestEvent({
    event_id: "od-renew",
    type: "overdue",
    rental_id: "r1-renew",
    occurred_at: "2026-09-18T10:00:00+08:00",
  });
  service.publishMetricDefinition(metricDefinition("e1", { privacy_threshold: 1 }));
  const report = service.recompute("e1").content;
  assert.equal(report.cohort.eligible_exposures, 1, "续租不新增曝光");
  assert.equal(report.arms[first.arm_id].primary.metrics.overdue_rate.numerator, 1);
});

test("冻结后到达的新事件（晚于窗口）同样生成新版本报告 trigger=post_freeze_event", async () => {
  const service = await makeService();
  seed(service);
  service.publishMetricDefinition(metricDefinition());
  service.recompute("e1", { trigger: "manual" });
  service.freezeExperiment("e1");

  // 晚于已报告事件窗口的真实新事件
  service.ingestEvent({
    event_id: "new-after-freeze",
    type: "damage_dispute",
    payload: { resolved_with_loss: true },
    rental_id: "r1",
    occurred_at: "2026-12-01T11:00:00+08:00",
  });
  const triggers = service.listReports("e1").map((v) => v.trigger);
  assert.deepEqual(triggers, ["manual", "post_freeze_event"]);
  const v2 = service.getReport("e1", 2).content;
  const badDebt = Object.values(v2.arms).reduce(
    (sum, arm) => sum + (arm.primary.metrics.bad_debt_rate.numerator ?? 0),
    0,
  );
  assert.ok(badDebt >= 1, "新版本应纳入冻结后新事件");
});

test("运营视图：总体与分层低于阈值的计数被掩码为 suppressed", async () => {
  const service = await makeService();
  createStandardExperiment(service);
  for (let i = 1; i <= 2; i++) {
    service.assign({
      experiment_id: "e1",
      user: user(`u${i}`),
      asset_id: i === 1 ? "CAM-R50-0018" : "CAM-R50-0021",
      rental_id: `r${i}`,
      at: "2026-09-10T10:00:00+08:00",
    });
  }
  // 制造 2 个排除原因，低于默认阈值 5
  service.assign({
    experiment_id: "e1",
    user: user("x1", { credit_status: "blocked", credit_score: 300 }),
    asset_id: "CAM-R50-0018",
    rental_id: "rx1",
    at: "2026-09-10T10:00:00+08:00",
  });
  service.assign({
    experiment_id: "e1",
    user: user("x2", { credit_status: "blocked", credit_score: 300 }),
    asset_id: "CAM-R50-0018",
    rental_id: "rx2",
    at: "2026-09-10T10:00:00+08:00",
  });

  service.publishMetricDefinition(metricDefinition("e1", { privacy_threshold: 5 }));
  service.recompute("e1");
  service.freezeExperiment("e1");

  const operator = service.viewReport("e1", { role: "operator" });
  assert.equal(operator.cohort.eligible_exposures, "suppressed");
  assert.equal(operator.cohort.excluded.credit_blocked, "suppressed");
  for (const arm of Object.values(operator.arms)) {
    assert.equal(arm.primary.exposures, "suppressed");
    assert.equal(arm.primary.metrics.overdue_rate.suppressed, true);
  }
});

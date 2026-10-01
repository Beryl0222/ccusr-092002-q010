import assert from "node:assert/strict";
import test from "node:test";

import { createStandardExperiment, makeService, metricDefinition, T0, user } from "./helpers.js";

const RENTABLE_ASSETS = [
  "CAM-R50-0018",
  "CAM-R50-0021",
  "CAM-M6-0007",
  "DRN-AV2-0104",
  "TNT-4P-0210",
  "TNT-4P-0215",
  "PRJ-4K-0050",
  "PRJ-4K-0052",
  "PRJ-HD-0019",
  "CAM-R50-0021",
];

function seedCohort(service, { n = 20, experimentId = "e1" } = {}) {
  for (let i = 1; i <= n; i++) {
    const assigned = service.assign({
      experiment_id: experimentId,
      user: user(`u${i}`),
      asset_id: RENTABLE_ASSETS[i % RENTABLE_ASSETS.length],
      rental_id: `r${i}`,
      at: `2026-09-${String((i % 28) + 1).padStart(2, "0")}T10:00:00+08:00`,
    });
    assert.equal(assigned.eligible, true, `用户 u${i} 应当入组：${assigned.reasons ?? ""}`);
  }
}

test("事件幂等：重复 event_id 不重复计数", async () => {
  const service = await makeService();
  createStandardExperiment(service);
  service.assign({
    experiment_id: "e1",
    user: user("u1"),
    asset_id: "CAM-R50-0018",
    rental_id: "r1",
    at: T0,
  });
  const first = service.ingestEvent({
    event_id: "ev1",
    type: "order",
    rental_id: "r1",
    occurred_at: "2026-09-10T11:00:00+08:00",
  });
  assert.equal(first.duplicate, false);
  const again = service.ingestEvent({
    event_id: "ev1",
    type: "order",
    rental_id: "r1",
    occurred_at: "2026-09-10T11:00:00+08:00",
  });
  assert.equal(again.duplicate, true);

  service.publishMetricDefinition(metricDefinition());
  const report = service.recompute("e1").content;
  // 全部曝光都算 cancel_rate 的分母，仅 1 个曝光且未取消；order 不影响指标分子
  assert.equal(report.cohort.eligible_exposures, 1);
});

test("未知事件类型被拒绝", async () => {
  const service = await makeService();
  createStandardExperiment(service);
  assert.throws(
    () =>
      service.ingestEvent({ event_id: "x", type: "explode", rental_id: "r1", occurred_at: T0 }),
    (err) => err.code === "unknown_event_type",
  );
});

test("匹配不到曝光的事件进入隔离区，不丢弃，曝光出现后自动补配", async () => {
  const service = await makeService();
  createStandardExperiment(service);
  const early = service.ingestEvent({
    event_id: "early-overdue",
    type: "overdue",
    rental_id: "late-rental",
    occurred_at: "2026-09-12T00:00:00+08:00",
  });
  assert.equal(early.quarantined, true);

  const assigned = service.assign({
    experiment_id: "e1",
    user: user("u1"),
    asset_id: "CAM-R50-0018",
    rental_id: "late-rental",
    at: T0,
  });

  service.publishMetricDefinition(metricDefinition("e1", { privacy_threshold: 1 }));
  const report = service.recompute("e1").content;
  assert.equal(report.data_quality.quarantined_event_count, 0, "补配后隔离区清空");
  assert.equal(report.arms[assigned.arm_id].primary.metrics.overdue_rate.numerator, 1);
  assert.equal(report.arms[assigned.arm_id].primary.metrics.overdue_rate.denominator, 1);
});

test("质量标志：批量账号/客服豁免/缺验机样本保留在主口径，clean_only 可对照", async () => {
  const service = await makeService();
  createStandardExperiment(service);
  // 6 个干净样本 + 2 个标记样本
  for (let i = 1; i <= 6; i++) {
    service.assign({
      experiment_id: "e1",
      user: user(`u${i}`),
      asset_id: "CAM-R50-0018",
      rental_id: `r${i}`,
      at: T0,
    });
  }
  // 缺验机样本
  service.assign({
    experiment_id: "e1",
    user: user("u7"),
    asset_id: "DRN-AV2-0110",
    rental_id: "r7",
    at: T0,
  });
  // 干净样本，事后被客服豁免
  service.assign({
    experiment_id: "e1",
    user: user("u8"),
    asset_id: "CAM-R50-0021",
    rental_id: "r8",
    at: T0,
  });
  service.ingestEvent({ event_id: "cs8", type: "cs_exemption", rental_id: "r8", occurred_at: T0 });
  // 另一个干净样本，事后被标记为异常批量账号
  service.assign({
    experiment_id: "e1",
    user: user("u9"),
    asset_id: "CAM-R50-0021",
    rental_id: "r9",
    at: T0,
  });
  service.ingestEvent({
    event_id: "flag9",
    type: "account_flag",
    payload: { flag: "bulk_account_suspect" },
    rental_id: "r9",
    occurred_at: T0,
  });

  service.publishMetricDefinition(metricDefinition("e1", { privacy_threshold: 1 }));
  const report = service.recompute("e1").content;
  assert.equal(report.cohort.eligible_exposures, 9, "主口径保留全部 9 个样本");
  assert.equal(report.cohort.quality_flagged.missing_inspection, 1);
  assert.equal(report.cohort.quality_flagged.cs_exemption, 1);
  assert.equal(report.cohort.quality_flagged.bulk_account_suspect, 1);

  const totalClean = Object.values(report.arms).reduce(
    (sum, arm) => sum + arm.clean_only.exposures,
    0,
  );
  assert.equal(totalClean, 6, "clean_only 仅作敏感性视图，少掉的 3 个可在 flagged 中查到");
});

test("逾期/取消/损伤争议(含坏账)/复租折叠为指标", async () => {
  const service = await makeService();
  createStandardExperiment(service);
  const rentals = [
    { id: "r1", events: [["order"], ["overdue"]] },
    { id: "r2", events: [["order"], ["cancel"]] },
    { id: "r3", events: [["order"], ["damage_dispute", { resolved_with_loss: true }]] },
    { id: "r4", events: [["order"], ["damage_dispute", { resolved_with_loss: false }]] },
    { id: "r5", events: [["order"], ["overdue"], ["rerent"]] },
    { id: "r6", events: [["order"]] },
  ];
  rentals.forEach((r, idx) => {
    service.assign({
      experiment_id: "e1",
      user: user(`u${idx}`),
      asset_id: RENTABLE_ASSETS[idx],
      rental_id: r.id,
      at: T0,
    });
    r.events.forEach(([type, payload], j) => {
      service.ingestEvent({
        event_id: `${r.id}-${j}`,
        type,
        payload,
        rental_id: r.id,
        occurred_at: "2026-09-20T10:00:00+08:00",
      });
    });
  });

  service.publishMetricDefinition(metricDefinition("e1", { privacy_threshold: 1 }));
  const report = service.recompute("e1").content;
  const aggregate = (metric, view = "primary") => {
    const arms = Object.values(report.arms);
    return arms.reduce(
      (acc, arm) => {
        const cell = arm[view].metrics[metric];
        if (!cell.suppressed) {
          acc.n += cell.numerator;
          acc.d += cell.denominator;
        }
        return acc;
      },
      { n: 0, d: 0 },
    );
  };
  assert.deepEqual(aggregate("cancel_rate"), { n: 1, d: 6 });
  assert.deepEqual(aggregate("overdue_rate"), { n: 2, d: 5 }, "取消样本不进入履约类分母");
  assert.deepEqual(aggregate("bad_debt_rate"), { n: 1, d: 5 }, "仅 resolved_with_loss 的争议计坏账");
  assert.deepEqual(aggregate("damage_dispute_rate"), { n: 2, d: 5 });
  assert.deepEqual(aggregate("rerent_rate"), { n: 1, d: 5 });
});

import assert from "node:assert/strict";
import test from "node:test";

import { createStandardExperiment, makeService, T0, THREE_ARMS, TWO_ARMS, user } from "./helpers.js";

test("分组稳定：同一用户多次请求得到同一臂，且幂等", async () => {
  const service = await makeService();
  createStandardExperiment(service);
  const first = service.assign({
    experiment_id: "e1",
    user: user("u1"),
    asset_id: "CAM-R50-0018",
    rental_id: "r1",
    at: T0,
  });
  const again = service.assign({
    experiment_id: "e1",
    user: user("u1"),
    asset_id: "CAM-R50-0018",
    rental_id: "r1",
    at: T0,
  });
  assert.equal(first.arm_id, again.arm_id);
  assert.equal(again.idempotent, true);
  assert.equal(first.bucket, again.bucket);
});

test("分组不依赖当天库存与资产：同用户换一台可租设备仍是同一臂", async () => {
  const service = await makeService();
  createStandardExperiment(service);
  const a = service.assign({
    experiment_id: "e1",
    user: user("u2"),
    asset_id: "CAM-R50-0018",
    rental_id: "r1",
    at: T0,
  });
  // r1 结束后同一用户另一笔租赁、不同资产
  service.ingestEvent({ event_id: "ret1", type: "return", rental_id: "r1", occurred_at: "2026-09-12T10:00:00+08:00" });
  const b = service.assign({
    experiment_id: "e1",
    user: user("u2"),
    asset_id: "DRN-AV2-0104",
    rental_id: "r2",
    at: "2026-09-13T10:00:00+08:00",
  });
  assert.equal(a.arm_id, b.arm_id);
});

test("不合格样本给出完整排除原因且不分租", async () => {
  const service = await makeService();
  createStandardExperiment(service);

  const blocked = service.assign({
    experiment_id: "e1",
    user: user("b1", { credit_status: "blocked", credit_score: 300 }),
    asset_id: "CAM-R50-0018",
    rental_id: "rb1",
    at: T0,
  });
  assert.equal(blocked.eligible, false);
  assert.ok(blocked.reasons.includes("credit_blocked"));
  assert.equal(blocked.assigned, undefined);

  const maintenance = service.assign({
    experiment_id: "e1",
    user: user("b2"),
    asset_id: "CAM-R50-0025",
    rental_id: "rb2",
    at: T0,
  });
  assert.deepEqual(maintenance.reasons, ["asset_not_rentable"]);

  const noIdentity = service.assign({
    experiment_id: "e1",
    user: { user_id: "b3", compliance: { credit_score: 800 } },
    asset_id: "CAM-R50-0018",
    rental_id: "rb3",
    at: T0,
  });
  assert.ok(noIdentity.reasons.includes("identity_unverified"));

  const missingCredit = service.assign({
    experiment_id: "e1",
    user: { user_id: "b4", compliance: { identity_verified: true } },
    asset_id: "CAM-R50-0018",
    rental_id: "rb4",
    at: T0,
  });
  assert.ok(missingCredit.reasons.includes("credit_data_missing"));

  const lowScore = service.assign({
    experiment_id: "e1",
    user: user("b5", { credit_score: 400 }),
    asset_id: "CAM-R50-0018",
    rental_id: "rb5",
    at: T0,
  });
  assert.ok(lowScore.reasons.includes("credit_score_below_threshold"));

  const unknownAsset = service.assign({
    experiment_id: "e1",
    user: user("b6"),
    asset_id: "NOPE",
    rental_id: "rb6",
    at: T0,
  });
  assert.deepEqual(unknownAsset.reasons, ["asset_not_found"]);

  // 留痕可查
  const reasons = service.eligibilityTrail("e1").map((e) => e.reasons);
  assert.equal(reasons.length, 6);
});

test("窗口外分组被拒：未开始 / 已停止", async () => {
  const service = await makeService();
  createStandardExperiment(service);
  const before = service.assign({
    experiment_id: "e1",
    user: user("u0"),
    asset_id: "CAM-R50-0018",
    rental_id: "r0",
    at: "2026-08-30T10:00:00+08:00",
  });
  assert.deepEqual(before.reasons, ["before_start"]);

  service.stopExperiment("e1", "2026-09-20T00:00:00+08:00");
  const after = service.assign({
    experiment_id: "e1",
    user: user("u9"),
    asset_id: "CAM-R50-0018",
    rental_id: "r9",
    at: "2026-09-21T10:00:00+08:00",
  });
  assert.deepEqual(after.reasons, ["after_stop"]);
});

test("定向条件：类别 / 成色 / 仓", async () => {
  const service = await makeService();
  service.createExperiment({
    id: "cam_a",
    name: "仅A成色相机",
    mutex_group: "g2",
    arms: TWO_ARMS,
    starts_at: "2026-09-01T00:00:00+08:00",
    targeting: { categories: ["camera"], condition_grades: ["A"], warehouses: ["SH-02"] },
  });
  const tent = service.assign({
    experiment_id: "cam_a",
    user: user("t1"),
    asset_id: "TNT-4P-0210",
    rental_id: "rt",
    at: T0,
  });
  assert.deepEqual(tent.reasons, ["category_not_targeted"]);

  const gradeC = service.assign({
    experiment_id: "cam_a",
    user: user("t2"),
    asset_id: "CAM-M6-0007",
    rental_id: "rc",
    at: T0,
  });
  assert.deepEqual(gradeC.reasons.sort(), ["condition_grade_not_targeted", "warehouse_not_targeted"].sort());

  const ok = service.assign({
    experiment_id: "cam_a",
    user: user("t3"),
    asset_id: "CAM-R50-0018",
    rental_id: "ra",
    at: T0,
  });
  assert.equal(ok.eligible, true);
});

test("缺验机数据：可入组但带 missing_inspection 标志，不被删除", async () => {
  const service = await makeService();
  createStandardExperiment(service);
  const result = service.assign({
    experiment_id: "e1",
    user: user("u7"),
    asset_id: "DRN-AV2-0110",
    rental_id: "r7",
    at: T0,
  });
  assert.equal(result.eligible, true);
  assert.deepEqual(result.quality_flags, ["missing_inspection"]);
});

test("互斥：同一用户不能同时进入同组的其他实验", async () => {
  const service = await makeService();
  createStandardExperiment(service, { id: "e1" });
  createStandardExperiment(service, { id: "e2", name: "分层保障计划" });

  const inE1 = service.assign({
    experiment_id: "e1",
    user: user("u1"),
    asset_id: "CAM-R50-0018",
    rental_id: "r1",
    at: T0,
  });
  assert.equal(inE1.eligible, true);

  const blocked = service.assign({
    experiment_id: "e2",
    user: user("u1"),
    asset_id: "CAM-R50-0021",
    rental_id: "r2",
    at: "2026-09-11T10:00:00+08:00",
  });
  assert.equal(blocked.eligible, false);
  assert.deepEqual(blocked.reasons, ["mutex_user_busy"]);
  assert.equal(blocked.mutex_conflict.experiment_id, "e1");
});

test("互斥：同一资产不能同时租给同组其他实验的用户", async () => {
  const service = await makeService();
  createStandardExperiment(service, { id: "e1" });
  createStandardExperiment(service, { id: "e2", name: "分层保障计划" });

  service.assign({
    experiment_id: "e1",
    user: user("u1"),
    asset_id: "CAM-R50-0018",
    rental_id: "r1",
    at: T0,
  });
  const blocked = service.assign({
    experiment_id: "e2",
    user: user("u2"),
    asset_id: "CAM-R50-0018",
    rental_id: "r2",
    at: "2026-09-11T10:00:00+08:00",
  });
  assert.deepEqual(blocked.reasons, ["mutex_asset_busy"]);

  // 归还后互斥解除
  service.ingestEvent({ event_id: "ret", type: "return", rental_id: "r1", occurred_at: "2026-09-12T10:00:00+08:00" });
  const allowed = service.assign({
    experiment_id: "e2",
    user: user("u2"),
    asset_id: "CAM-R50-0018",
    rental_id: "r3",
    at: "2026-09-13T10:00:00+08:00",
  });
  assert.equal(allowed.eligible, true);
});

test("不同互斥组的实验互不干扰", async () => {
  const service = await makeService();
  createStandardExperiment(service, { id: "e1" });
  service.createExperiment({
    id: "other",
    name: "其他业务实验",
    mutex_group: "different_group",
    arms: TWO_ARMS,
    starts_at: "2026-09-01T00:00:00+08:00",
  });
  service.assign({
    experiment_id: "e1",
    user: user("u1"),
    asset_id: "CAM-R50-0018",
    rental_id: "r1",
    at: T0,
  });
  const ok = service.assign({
    experiment_id: "other",
    user: user("u1"),
    asset_id: "CAM-R50-0018",
    rental_id: "r2",
    at: "2026-09-11T10:00:00+08:00",
  });
  assert.equal(ok.eligible, true);
});

test("续租：保留原分组与暴露区间，停止后续租打 post_stop", async () => {
  const service = await makeService();
  createStandardExperiment(service, { arms: THREE_ARMS });
  const original = service.assign({
    experiment_id: "e1",
    user: user("u1"),
    asset_id: "CAM-R50-0018",
    rental_id: "r1",
    at: T0,
  });
  service.stopExperiment("e1", "2026-09-20T00:00:00+08:00");

  const renewed = service.assign({
    experiment_id: "e1",
    user: user("u1"),
    asset_id: "CAM-R50-0018",
    rental_id: "r1-renew",
    renewal_of: original.exposure_id,
    at: "2026-09-25T10:00:00+08:00",
  });
  assert.equal(renewed.arm_id, original.arm_id);
  assert.equal(renewed.arm_preserved, true);
  assert.equal(renewed.post_stop, true);
  assert.equal(renewed.exposed_through, "2026-09-25T10:00:00+08:00");
  assert.equal(renewed.started_at, T0, "起始暴露时间不变");

  // 续租不能换人、不能换资产
  assert.throws(
    () =>
      service.assign({
        experiment_id: "e1",
        user: user("u2"),
        asset_id: "CAM-R50-0018",
        rental_id: "x",
        renewal_of: original.exposure_id,
        at: "2026-09-26T10:00:00+08:00",
      }),
    (err) => err.code === "renewal_user_mismatch",
  );
  assert.throws(
    () =>
      service.assign({
        experiment_id: "e1",
        user: user("u1"),
        asset_id: "CAM-R50-0021",
        rental_id: "y",
        renewal_of: original.exposure_id,
        at: "2026-09-26T10:00:00+08:00",
      }),
    (err) => err.code === "renewal_asset_mismatch",
  );
});

test("跨仓调拨：改变后续分组仓位，历史曝光快照不动", async () => {
  const service = await makeService();
  createStandardExperiment(service);
  const before = service.assign({
    experiment_id: "e1",
    user: user("u1"),
    asset_id: "PRJ-4K-0052",
    rental_id: "r1",
    at: T0,
  });
  assert.equal(before.origin.warehouse, "BJ-01");

  service.ingestEvent({ event_id: "ret", type: "return", rental_id: "r1", occurred_at: "2026-09-12T10:00:00+08:00" });
  service.recordTransfer({ asset_id: "PRJ-4K-0052", to_warehouse: "SH-02", at: "2026-09-15T08:00:00+08:00" });

  const after = service.assign({
    experiment_id: "e1",
    user: user("u2"),
    asset_id: "PRJ-4K-0052",
    rental_id: "r2",
    at: "2026-09-16T10:00:00+08:00",
  });
  assert.equal(after.origin.warehouse, "SH-02");

  const exposures = service.listExposures("e1");
  assert.equal(exposures[0].origin.warehouse, "BJ-01", "历史快照不被调拨改写");
  assert.equal(exposures[1].origin.warehouse, "SH-02");
});

test("实验配置：流量区间必须连续且覆盖整个桶空间", async () => {
  const service = await makeService();
  assert.throws(
    () =>
      service.createExperiment({
        id: "bad",
        name: "x",
        mutex_group: "g",
        arms: [
          { id: "control", allocation: [0, 400] },
          { id: "treat", allocation: [500, 1000] },
        ],
        starts_at: T0,
      }),
    /连续/,
  );
});

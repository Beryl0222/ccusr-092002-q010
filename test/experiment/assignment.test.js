import assert from "node:assert/strict";
import test from "node:test";

import {
  AssetRegistry,
  ExperimentPlatform,
  EXPERIMENT_STATUS,
  pickArm,
  stableHash32,
} from "../../src/experiment/index.js";

const assets = [
  { asset_id: "CAM-1", category: "camera", condition_grade: "A", accessories: [], availability: { warehouse: "SH-02", status: "inspection_passed" }, inspection: {} },
  { asset_id: "CAM-2", category: "camera", condition_grade: "B", accessories: [], availability: { warehouse: "BJ-03", status: "inspection_passed" }, inspection: {} },
];

const user = (id, overrides = {}) => ({
  user_id: id,
  kyc_status: "passed",
  account_opened_at: "2020-01-01T00:00:00Z",
  region: "CN",
  ...overrides,
});

function platform() {
  const p = new ExperimentPlatform({ assets: new AssetRegistry(assets) });
  p.createExperiment({ id: "e1", name: "E1", salt: "salt-1", arms: [
    { id: "pre_authorization", weight: 1 },
    { id: "tiered_protection", weight: 1 },
    { id: "on_time_reward", weight: 1 },
  ] });
  p.createExperiment({ id: "e2", name: "E2", salt: "salt-2", arms: [
    { id: "control", weight: 1 },
    { id: "treatment", weight: 1 },
  ] });
  return p;
}

test("稳定分组：同盐值同用户永远同臂，且不依赖仓库/资产/时间", () => {
  const arms = [
    { id: "a", weight: 1 },
    { id: "b", weight: 1 },
    { id: "c", weight: 1 },
  ];
  const first = pickArm({ salt: "s", userId: "user-7", arms });
  for (let i = 0; i < 20; i += 1) {
    assert.equal(pickArm({ salt: "s", userId: "user-7", arms }), first);
  }
  assert.equal(typeof stableHash32("x"), "number");
  // 不同盐值得以重新随机（不同实验互不相关）。
  const otherSalt = pickArm({ salt: "different", userId: "user-7", arms });
  assert.ok(["a", "b", "c"].includes(otherSalt));
});

test("三策略都实际分到用户（权重相等时）", () => {
  const arms = [
    { id: "pre_authorization", weight: 1 },
    { id: "tiered_protection", weight: 1 },
    { id: "on_time_reward", weight: 1 },
  ];
  const seen = new Set();
  for (let i = 0; i < 300; i += 1) seen.add(pickArm({ salt: "s", userId: `u${i}`, arms }));
  assert.deepEqual([...seen].sort(), ["on_time_reward", "pre_authorization", "tiered_protection"]);
});

test("同一用户/资产在暴露未结束时不能进入另一个实验", () => {
  const p = platform();
  const r1 = p.attemptEnrollment({ experimentId: "e1", user: user("u1"), assetId: "CAM-1" });
  assert.equal(r1.admitted, true);
  const r2 = p.attemptEnrollment({ experimentId: "e2", user: user("u1"), assetId: "CAM-1" });
  assert.equal(r2.admitted, false);
  assert.ok(r2.reasons.includes("ALREADY_ENROLLED_OTHER_EXPERIMENT"));
  assert.ok(r2.reasons.includes("ASSET_IN_PARALLEL_EXPERIMENT"));
});

test("暴露未结束时重复下单被拒绝，不产生第二条暴露", () => {
  const p = platform();
  const r1 = p.attemptEnrollment({ experimentId: "e1", user: user("u1"), assetId: "CAM-1" });
  const r2 = p.attemptEnrollment({ experimentId: "e1", user: user("u1"), assetId: "CAM-1" });
  assert.equal(r2.admitted, false);
  assert.ok(r2.reasons.includes("DUPLICATE_ENROLLMENT_REQUEST"));
  assert.equal(p.store.listExposures("e1").length, 1);
});

test("续租不改分组，只延长暴露并记录次数", () => {
  const p = platform();
  const r1 = p.attemptEnrollment({ experimentId: "e1", user: user("u1"), assetId: "CAM-1" });
  p.renew(r1.exposureId, { at: "2026-09-20T00:00:00Z" });
  p.renew(r1.exposureId, { at: "2026-09-21T00:00:00Z" });
  const exposure = p.store.listExposures("e1")[0];
  assert.equal(exposure.renewals, 2);
  assert.equal(exposure.arm, r1.arm);
});

test("跨仓调拨不改分组，仓库变化进入时间线", () => {
  const p = platform();
  const r1 = p.attemptEnrollment({ experimentId: "e1", user: user("u1"), assetId: "CAM-1" });
  p.transfer(r1.exposureId, "BJ-03", { at: "2026-09-20T00:00:00Z" });
  p.transfer(r1.exposureId, "BJ-03", { at: "2026-09-21T00:00:00Z" }); // 同仓不重复记录
  p.transfer(r1.exposureId, "HZ-01", { at: "2026-09-22T00:00:00Z" });
  const exposure = p.store.listExposures("e1")[0];
  assert.deepEqual(exposure.warehouseTimeline.map((w) => w.warehouse), ["SH-02", "BJ-03", "HZ-01"]);
  assert.equal(exposure.arm, r1.arm);
});

test("复租：暴露结束后再入组沿用首次分组", () => {
  const p = platform();
  const r1 = p.attemptEnrollment({ experimentId: "e1", user: user("u1"), assetId: "CAM-1" });
  p.store.closeExposure(r1.exposureId, { at: "2026-09-20T00:00:00Z" });
  const r2 = p.attemptEnrollment({ experimentId: "e1", user: user("u1"), assetId: "CAM-1", now: "2026-09-21T00:00:00Z" });
  assert.equal(r2.admitted, true);
  assert.equal(r2.arm, r1.arm);
  assert.notEqual(r2.exposureId, r1.exposureId);
});

test("策略中途停止：旧暴露保留归因，新入组被拒", () => {
  const p = platform();
  const r1 = p.attemptEnrollment({ experimentId: "e1", user: user("u1"), assetId: "CAM-1" });
  p.stopExperiment("e1", "2026-09-20T00:00:00Z");
  assert.equal(p.store.experiments.get("e1").status, EXPERIMENT_STATUS.STOPPED);
  const stillOpen = p.store.getOpenExposureByUser("u1");
  assert.equal(stillOpen.exposureId, r1.exposureId);
  assert.equal(stillOpen.arm, r1.arm);
  const r2 = p.attemptEnrollment({ experimentId: "e1", user: user("u2"), assetId: "CAM-2" });
  assert.equal(r2.admitted, false);
  assert.ok(r2.reasons.includes("EXPERIMENT_NOT_ENROLLING"));
});

test("停止后的旧暴露仍可记录续租与调拨", () => {
  const p = platform();
  const r1 = p.attemptEnrollment({ experimentId: "e1", user: user("u1"), assetId: "CAM-1" });
  p.stopExperiment("e1");
  assert.ok(p.transfer(r1.exposureId, "HZ-01"));
  assert.ok(p.renew(r1.exposureId));
});

test("暴露结束后释放用户与资产，可进入另一实验（互斥仅限同时）", () => {
  const p = platform();
  const r1 = p.attemptEnrollment({ experimentId: "e1", user: user("u1"), assetId: "CAM-1" });
  p.store.closeExposure(r1.exposureId, { at: "2026-09-20T00:00:00Z" });
  const r2 = p.attemptEnrollment({ experimentId: "e2", user: user("u1"), assetId: "CAM-1", now: "2026-09-21T00:00:00Z" });
  assert.equal(r2.admitted, true);
});

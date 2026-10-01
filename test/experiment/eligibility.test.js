import assert from "node:assert/strict";
import test from "node:test";

import {
  AssetRegistry,
  categoryFromId,
  evaluateEligibility,
  EXCLUSION_REASONS,
  QUALITY_FLAGS,
} from "../../src/experiment/index.js";

const asset = (overrides = {}) => ({
  asset_id: "CAM-1",
  category: "camera",
  condition_grade: "A",
  accessories: ["电池"],
  availability: { warehouse: "SH-02", status: "inspection_passed" },
  inspection: { result: "pass" },
  ...overrides,
});

const user = (overrides = {}) => ({
  user_id: "u1",
  kyc_status: "passed",
  account_opened_at: "2020-01-01T00:00:00Z",
  region: "CN",
  ...overrides,
});

test("类别可由资产编号前缀推断，显式 category 优先", () => {
  assert.equal(categoryFromId("DRN-AV2-1"), "drone");
  assert.equal(categoryFromId("TNT-4P-1"), "tent");
  assert.equal(categoryFromId("WEIRD-1"), "unknown");
  assert.equal(new AssetRegistry([asset({ category: "custom" })]).get("CAM-1").category, "custom");
});

test("只有 inspection_passed 才视为可租", () => {
  const registry = new AssetRegistry([
    asset(),
    asset({ asset_id: "CAM-2", availability: { warehouse: "SH-02", status: "rented_out" } }),
    asset({ asset_id: "CAM-3", availability: { warehouse: "SH-02", status: "inspection_pending" } }),
  ]);
  assert.equal(registry.isRentable("CAM-1"), true);
  assert.equal(registry.isRentable("CAM-2"), false);
  assert.equal(registry.isRentable("CAM-3"), false);
  assert.equal(registry.isRentable("MISSING"), false);
});

test("契约 assets 列表与单条 sample 均可加载，且不重复归一化", () => {
  const fromList = AssetRegistry.fromContract({ assets: [asset()] });
  assert.equal(fromList.get("CAM-1").warehouse, "SH-02");
  assert.equal(fromList.get("CAM-1").status, "inspection_passed");
  const fromSample = AssetRegistry.fromContract({ sample: asset() });
  assert.equal(fromSample.get("CAM-1").warehouse, "SH-02");
});

test("合规用户 + 可租资产才合格", () => {
  const result = evaluateEligibility({ user: user(), asset: asset() });
  assert.equal(result.eligible, true);
  assert.deepEqual(result.exclusionReasons, []);
});

test("未通过实名、被风控拦截、账龄不足分别给出原因码", () => {
  assert.ok(evaluateEligibility({ user: user({ kyc_status: "pending" }), asset: asset() })
    .exclusionReasons.includes(EXCLUSION_REASONS.KYC_NOT_PASSED));
  assert.ok(evaluateEligibility({ user: user({ risk_tags: ["fraud"] }), asset: asset() })
    .exclusionReasons.includes(EXCLUSION_REASONS.COMPLIANCE_BLOCKED));
  const recent = evaluateEligibility({
    user: user({ account_opened_at: new Date().toISOString() }),
    asset: asset(),
  });
  assert.ok(recent.exclusionReasons.includes(EXCLUSION_REASONS.ACCOUNT_TOO_NEW));
});

test("资产不存在或不可租给出对应原因码", () => {
  assert.ok(evaluateEligibility({ user: user(), asset: null })
    .exclusionReasons.includes(EXCLUSION_REASONS.ASSET_NOT_FOUND));
  const notRentable = asset({ availability: { warehouse: "SH-02", status: "rented_out" } });
  assert.ok(evaluateEligibility({ user: user(), asset: notRentable })
    .exclusionReasons.includes(EXCLUSION_REASONS.ASSET_NOT_RENTABLE));
});

test("批量账号：拦截入组但打质量标记，样本信息保留", () => {
  const byTag = evaluateEligibility({ user: user({ risk_tags: ["batch_registration"] }), asset: asset() });
  assert.equal(byTag.eligible, false);
  assert.ok(byTag.exclusionReasons.includes(EXCLUSION_REASONS.SUSPECTED_BATCH_ACCOUNT));
  assert.ok(byTag.qualityFlags.includes(QUALITY_FLAGS.SUSPECTED_BATCH_ACCOUNT));
  const byFlag = evaluateEligibility({ user: user({ suspected_batch_account: true }), asset: asset() });
  assert.ok(byFlag.qualityFlags.includes(QUALITY_FLAGS.SUSPECTED_BATCH_ACCOUNT));
});

test("人工客服豁免：仍可入组，但单独打标", () => {
  const result = evaluateEligibility({
    user: user({ agent_exemptions: [{ case_id: "CS-1", scope: "deposit" }] }),
    asset: asset(),
  });
  assert.equal(result.eligible, true);
  assert.ok(result.qualityFlags.includes(QUALITY_FLAGS.AGENT_EXEMPTION));
});

test("验机数据缺失：不拒绝，单独打 MISSING_INSPECTION_DATA 标记", () => {
  const result = evaluateEligibility({ user: user(), asset: asset({ inspection: null }) });
  assert.equal(result.eligible, true);
  assert.deepEqual(result.qualityFlags, [QUALITY_FLAGS.MISSING_INSPECTION_DATA]);
  // 契约里完全没有 inspection 字段时同样视为缺失而非报错。
  const { inspection, ...noField } = asset();
  const result2 = evaluateEligibility({ user: user(), asset: noField });
  assert.ok(result2.qualityFlags.includes(QUALITY_FLAGS.MISSING_INSPECTION_DATA));
});

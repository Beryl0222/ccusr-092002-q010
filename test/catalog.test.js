import assert from "node:assert/strict";
import test from "node:test";

import { Catalog } from "../src/catalog.js";

test("目录加载：读取类别、成色、配件与所在仓", async () => {
  const catalog = await Catalog.load();
  const asset = catalog.getAsset("CAM-R50-0018");
  assert.equal(asset.category, "camera");
  assert.equal(asset.condition_grade, "A");
  assert.deepEqual(asset.accessories, ["镜头", "电池", "充电器"]);
  assert.equal(asset.availability.warehouse, "SH-02");
  assert.equal(catalog.isRentable(asset), true);
});

test("维护中与退役资产不可租", async () => {
  const catalog = await Catalog.load();
  assert.equal(catalog.isRentable(catalog.getAsset("CAM-R50-0025")), false); // maintenance
  assert.equal(catalog.isRentable(catalog.getAsset("TNT-2P-0088")), false); // retired
  assert.equal(catalog.isRentable(catalog.getAsset("MISSING")), false);
});

test("验机状态三分类：缺失既非通过也不删除", async () => {
  const catalog = await Catalog.load();
  assert.equal(catalog.inspectionState(catalog.getAsset("CAM-R50-0018")), "passed");
  assert.equal(catalog.inspectionState(catalog.getAsset("CAM-R50-0025")), "failed");
  assert.equal(catalog.inspectionState(catalog.getAsset("DRN-AV2-0110")), "missing");
});

test("目录契约缺 assets 或 asset_id 重复时报错", () => {
  assert.throws(() => new Catalog({}), /assets 目录/);
  assert.throws(
    () => new Catalog({ assets: [{ asset_id: "a" }, { asset_id: "a" }] }),
    /asset_id 重复/,
  );
});

import { readFile } from "node:fs/promises";

export const RENTABLE_STATUS = "rentable";

const DEFAULT_CONTRACT_URL = new URL("../contracts/rental_asset.json", import.meta.url);

/**
 * 资产目录：从 rental_asset.json 读取设备类别、成色、配件与所在仓。
 * 目录是实验分组唯一的事实来源，分组时不接受调用方口头声明的“可租”。
 */
export class Catalog {
  constructor(data) {
    if (!data || !Array.isArray(data.assets)) {
      throw new Error("资产契约缺少 assets 目录");
    }
    this.raw = data;
    this.assets = new Map();
    for (const asset of data.assets) {
      if (!asset || typeof asset.asset_id !== "string") {
        throw new Error("资产目录中存在缺少 asset_id 的记录");
      }
      if (this.assets.has(asset.asset_id)) {
        throw new Error(`资产目录中 asset_id 重复：${asset.asset_id}`);
      }
      this.assets.set(asset.asset_id, asset);
    }
  }

  static async load(fileUrl = DEFAULT_CONTRACT_URL) {
    const raw = await readFile(fileUrl, "utf8");
    return new Catalog(JSON.parse(raw));
  }

  getAsset(assetId) {
    return this.assets.get(assetId) ?? null;
  }

  isRentable(asset) {
    return Boolean(asset && asset.availability && asset.availability.status === RENTABLE_STATUS);
  }

  /**
   * 验机状态三分类：passed / failed / missing。
   * missing（没有验机记录）不是“合格”，也不能直接丢弃，只能带标志入组。
   */
  inspectionState(asset) {
    if (!asset || asset.inspection == null) return "missing";
    return asset.inspection.passed ? "passed" : "failed";
  }
}

// 资产目录：从 rental_asset.json 读取设备类别、成色、配件与所在仓。
// 只做读取与规整，不持有租赁过程中的可变状态（运行期状态由实验平台维护）。

export const RENTABLE_STATUSES = new Set(["inspection_passed"]);

// 资产编号前缀到设备类别的兜底映射；契约中显式给出 category 时优先使用显式值。
const PREFIX_CATEGORY = {
  CAM: "camera",
  DRN: "drone",
  PRJ: "projector",
  SPK: "speaker",
  TNT: "tent",
  LMP: "lamp",
};

export function categoryFromId(assetId = "") {
  const prefix = String(assetId).split("-")[0].toUpperCase();
  return PREFIX_CATEGORY[prefix] ?? "unknown";
}

export function normalizeAsset(record) {
  if (!record || !record.asset_id) {
    throw new Error("资产记录缺少 asset_id");
  }
  const availability = record.availability ?? {};
  return {
    asset_id: record.asset_id,
    category: record.category ?? categoryFromId(record.asset_id),
    condition_grade: record.condition_grade ?? "U",
    accessories: Array.isArray(record.accessories) ? [...record.accessories] : [],
    warehouse: availability.warehouse ?? "UNKNOWN",
    status: availability.status ?? "unknown",
    // 验机数据可能缺失：缺失不是错误，登记为 null，由资格环节打标记而不是剔除。
    inspection: record.inspection === undefined ? null : record.inspection,
  };
}

export class AssetRegistry {
  constructor(records = []) {
    this.records = new Map();
    for (const record of records) this.add(record);
  }

  static fromContract(data) {
    let list = Array.isArray(data.assets) ? data.assets : null;
    if (!list || list.length === 0) {
      // 兼容只有单条 sample 的旧契约。
      list = data.sample ? [data.sample] : [];
    }
    return new AssetRegistry(list);
  }

  add(record) {
    const asset = normalizeAsset(record);
    this.records.set(asset.asset_id, asset);
    return asset;
  }

  get(assetId) {
    return this.records.get(assetId) ?? null;
  }

  isRentable(assetId) {
    const asset = this.get(assetId);
    return Boolean(asset && RENTABLE_STATUSES.has(asset.status));
  }

  list() {
    return [...this.records.values()];
  }
}

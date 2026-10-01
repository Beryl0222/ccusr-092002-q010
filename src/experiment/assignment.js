// 稳定分组与暴露区间。
// 分组由 (实验盐值 + 用户编号) 的确定性哈希决定：同一实验内同一用户永远落到同一策略，
// 不依赖下单时间、仓库或资产，保证可复现。用户/资产在任一时刻只能进入一个实验，
// 续租与跨仓调拨不改变分组，只延长/标注原暴露区间；策略中途停止后旧暴露继续可归因。

export const EXPERIMENT_STATUS = Object.freeze({
  ENROLLING: "enrolling", // 可入组
  STOPPED: "stopped", // 停止新入组，旧暴露继续
  FROZEN: "frozen", // 分析口径发布后冻结
});

// FNV-1a 32 位：无外部依赖、确定性、跨进程一致。
export function stableHash32(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function pickArm({ salt, userId, arms }) {
  const totalWeight = arms.reduce((sum, arm) => sum + arm.weight, 0);
  if (totalWeight <= 0) throw new Error("策略权重之和必须为正");
  const point = stableHash32(`${salt}|${userId}`) % totalWeight;
  let cursor = 0;
  for (const arm of arms) {
    cursor += arm.weight;
    if (point < cursor) return arm.id;
  }
  return arms[arms.length - 1].id;
}

export class Experiment {
  constructor({ id, name, salt, arms, startedAt, frozenMetricVersion = null }) {
    if (!id || !salt) throw new Error("实验必须提供 id 与 salt");
    if (!Array.isArray(arms) || arms.length < 2) throw new Error("实验至少需要两个策略臂");
    this.id = id;
    this.name = name ?? id;
    this.salt = salt;
    this.arms = arms.map((arm) => ({ id: arm.id, name: arm.name ?? arm.id, weight: arm.weight ?? 1 }));
    this.startedAt = startedAt ? new Date(startedAt).toISOString() : null;
    this.status = EXPERIMENT_STATUS.ENROLLING;
    this.stoppedAt = null;
    this.frozenMetricVersion = frozenMetricVersion;
  }

  stop(now = new Date().toISOString()) {
    if (this.status === EXPERIMENT_STATUS.ENROLLING) {
      this.status = EXPERIMENT_STATUS.STOPPED;
      this.stoppedAt = now;
    }
    return this.status;
  }

  freeze(metricVersion, now = new Date().toISOString()) {
    // 冻结只能发生在停止入组之后，且必须绑定已发布的指标口径版本。
    if (!metricVersion) throw new Error("冻结必须指定已发布的指标口径版本");
    if (this.status === EXPERIMENT_STATUS.ENROLLING) this.stop(now);
    this.status = EXPERIMENT_STATUS.FROZEN;
    this.frozenMetricVersion = metricVersion;
    return this.status;
  }
}

// 内存型存储；接口刻意保持最小，生产环境可换成事务型数据库实现。
export class ExperimentStore {
  constructor() {
    this.experiments = new Map();
    // experimentId -> userId -> { arm, firstAssignedAt }（实验内粘性）
    this.enrollments = new Map();
    this.exposures = new Map(); // exposureId -> exposure
    // 用户/资产与开放暴露的占用关系，用于跨实验互斥。
    this.userOpenExposure = new Map(); // userId -> exposureId
    this.assetOpenExposure = new Map(); // assetId -> exposureId
    this.screeningLog = [];
  }

  addExperiment(experiment) {
    this.experiments.set(experiment.id, experiment);
    this.enrollments.set(experiment.id, new Map());
    return experiment;
  }

  logScreening(entry) {
    this.screeningLog.push({ at: new Date().toISOString(), ...entry });
  }

  // 入组并开启一个暴露区间。
  enroll({ experimentId, user, asset, eligibility, now = new Date().toISOString() }) {
    const experiment = this.experiments.get(experimentId);
    if (!experiment) return { ok: false, reasons: ["EXPERIMENT_NOT_FOUND"] };
    if (experiment.status !== EXPERIMENT_STATUS.ENROLLING) {
      return { ok: false, reasons: ["EXPERIMENT_NOT_ENROLLING"] };
    }
    if (!eligibility.eligible) return { ok: false, reasons: eligibility.exclusionReasons };

    const reasons = [];
    const userOpen = this.userOpenExposure.has(user.user_id)
      ? this.exposures.get(this.userOpenExposure.get(user.user_id))
      : null;
    const assetOpen = this.assetOpenExposure.has(asset.asset_id)
      ? this.exposures.get(this.assetOpenExposure.get(asset.asset_id))
      : null;
    if (userOpen) {
      reasons.push(userOpen.experimentId === experimentId
        ? "DUPLICATE_ENROLLMENT_REQUEST" // 同一租赁未结束，不能重复下单
        : "ALREADY_ENROLLED_OTHER_EXPERIMENT");
    }
    if (assetOpen) {
      reasons.push(assetOpen.experimentId === experimentId
        ? "ASSET_ALREADY_ON_RENT" // 资产尚未归还
        : "ASSET_IN_PARALLEL_EXPERIMENT");
    }
    if (reasons.length > 0) return { ok: false, reasons };

    const armById = new Map(experiment.arms.map((arm) => [arm.id, arm]));
    let enrollment;
    const sticky = this.enrollments.get(experimentId).get(user.user_id);
    if (sticky) {
      // 复租（上一段暴露已结束）：沿用首次分组，绝不重新随机。
      enrollment = sticky;
    } else {
      const armId = pickArm({ salt: experiment.salt, userId: user.user_id, arms: experiment.arms });
      enrollment = { arm: armId, firstAssignedAt: now };
      this.enrollments.get(experimentId).set(user.user_id, enrollment);
    }
    if (!armById.has(enrollment.arm)) {
      throw new Error(`内部分组指向不存在的策略臂: ${enrollment.arm}`);
    }

    const exposureId = `${experimentId}:${user.user_id}:${asset.asset_id}:${now}`;
    const exposure = {
      exposureId,
      experimentId,
      userId: user.user_id,
      assetId: asset.asset_id,
      category: asset.category,
      conditionGrade: asset.condition_grade,
      arm: enrollment.arm,
      qualityFlags: eligibility.qualityFlags,
      assignedAt: now,
      startedAt: null,
      endedAt: null,
      status: "assigned", // assigned -> active -> ended
      warehouseAtAssignment: asset.warehouse,
      warehouseTimeline: [{ warehouse: asset.warehouse, at: now, reason: "assignment" }],
      renewals: 0,
      orderId: null,
    };
    this.exposures.set(exposureId, exposure);
    this.userOpenExposure.set(user.user_id, exposureId);
    this.assetOpenExposure.set(asset.asset_id, exposureId);
    return { ok: true, arm: enrollment.arm, exposureId, exposure };
  }

  getOpenExposureByUser(userId) {
    const id = this.userOpenExposure.get(userId);
    return id ? this.exposures.get(id) ?? null : null;
  }

  getOpenExposureByAsset(assetId) {
    const id = this.assetOpenExposure.get(assetId);
    return id ? this.exposures.get(id) ?? null : null;
  }

  // 续租：保持同一暴露与分组，延长区间。
  renew(exposureId, { at = new Date().toISOString() } = {}) {
    const exposure = this.exposures.get(exposureId);
    if (!exposure) return null;
    exposure.renewals += 1;
    exposure.warehouseTimeline.push({ warehouse: exposure.warehouseTimeline.at(-1).warehouse, at, reason: "renewal" });
    return exposure;
  }

  // 跨仓调拨：不改分组，只在暴露时间线上记录仓库变化。
  transfer(exposureId, warehouse, { at = new Date().toISOString() } = {}) {
    const exposure = this.exposures.get(exposureId);
    if (!exposure) return null;
    const last = exposure.warehouseTimeline.at(-1);
    if (!last || last.warehouse !== warehouse) {
      exposure.warehouseTimeline.push({ warehouse, at, reason: "transfer" });
    }
    return exposure;
  }

  // 正常或提前结束暴露（归还、策略停止后的自然到期等）。
  closeExposure(exposureId, { at = new Date().toISOString(), reason = "closed" } = {}) {
    const exposure = this.exposures.get(exposureId);
    if (!exposure || exposure.status === "ended") return exposure ?? null;
    exposure.status = "ended";
    exposure.endedAt = at;
    exposure.endReason = reason;
    if (this.userOpenExposure.get(exposure.userId) === exposureId) this.userOpenExposure.delete(exposure.userId);
    if (this.assetOpenExposure.get(exposure.assetId) === exposureId) this.assetOpenExposure.delete(exposure.assetId);
    return exposure;
  }

  listExposures(experimentId = null) {
    const all = [...this.exposures.values()];
    return experimentId ? all.filter((e) => e.experimentId === experimentId) : all;
  }
}

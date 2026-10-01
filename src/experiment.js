import { stableBucket } from "./hash.js";
import { buildReport, recommendDecision, knownMetricIds } from "./metrics.js";

export class DomainError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const ASSIGNABLE_EVENTS = new Set([
  "order",
  "cancel",
  "overdue",
  "damage_dispute",
  "rerent",
  "return",
  "cs_exemption",
  "account_flag",
]);

function nowIso(clock) {
  return clock().toISOString();
}

/**
 * 租赁策略实验服务。
 *
 * 关键不变量：
 * 1. 分组由 (experiment_id, user_id) 稳定哈希决定，不看当天库存、不看随机数；
 * 2. 只有“资产可租 + 用户合规 + 命中定向 + 在窗内 + 互斥不冲突”才分组，全部判定留痕；
 * 3. 同一用户 / 同一资产在同一互斥组内同时只能有一个在租实验；
 * 4. 续租沿用原曝光，跨仓调拨只影响新曝光的快照，策略停止后不产生新分组；
 * 5. 结果事件按 event_id 幂等；异常样本打标志保留，绝不静默删除；
 * 6. 指标口径未发布不能冻结；迟到事件只追加新版本报告，旧报告永不被覆盖。
 */
export class ExperimentService {
  constructor(catalog, { clock = () => new Date() } = {}) {
    this.catalog = catalog;
    this.clock = clock;
    this.state = {
      experiments: new Map(),
      eligibilityLog: [],
      exposures: new Map(),
      byRental: new Map(),
      events: new Map(), // event_id -> 事件记录（含应用状态）
      userIndex: new Map(), // user_id -> exposure_id[]
      assetIndex: new Map(), // asset_id -> exposure_id[]
      metricDefinitions: new Map(), // experiment_id -> 版本数组
      reports: new Map(), // experiment_id -> 不可变报告版本数组
      quarantined: new Map(), // event_id -> 找不到曝光的事件
      transfers: [],
    };
  }

  // ---------- 实验配置 ----------

  createExperiment(config) {
    const required = ["id", "name", "mutex_group", "arms", "starts_at"];
    for (const field of required) {
      if (config[field] === undefined || config[field] === null) {
        throw new DomainError("invalid_config", `实验配置缺少字段：${field}`, { field });
      }
    }
    if (this.state.experiments.has(config.id)) {
      throw new DomainError("experiment_exists", `实验已存在：${config.id}`);
    }
    const bucketCount = config.bucket_count ?? 1000;
    const arms = config.arms.map((arm) => ({ ...arm }));
    let cursor = 0;
    for (const arm of arms) {
      const [lo, hi] = arm.allocation;
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 0 || hi > bucketCount || lo >= hi) {
        throw new DomainError("invalid_allocation", `臂 ${arm.id} 的流量区间非法`);
      }
      if (lo !== cursor) {
        throw new DomainError("invalid_allocation", "臂流量区间必须连续且覆盖整个桶空间");
      }
      cursor = hi;
    }
    if (cursor !== bucketCount) {
      throw new DomainError("invalid_allocation", "臂流量区间未覆盖整个桶空间");
    }
    const experiment = {
      bucket_count: bucketCount,
      stops_at: null,
      status: "running",
      targeting: { categories: null, condition_grades: null, warehouses: null, ...(config.targeting ?? {}) },
      eligibility: { min_credit_score: 600, ...(config.eligibility ?? {}) },
      ...config,
      arms,
    };
    this.state.experiments.set(experiment.id, experiment);
    return this.publicExperiment(experiment);
  }

  getExperiment(experimentId) {
    const experiment = this.state.experiments.get(experimentId);
    if (!experiment) throw new DomainError("experiment_not_found", `实验不存在：${experimentId}`);
    return experiment;
  }

  listExperiments() {
    return [...this.state.experiments.values()].map((e) => this.publicExperiment(e));
  }

  publicExperiment(experiment) {
    return {
      id: experiment.id,
      name: experiment.name,
      mutex_group: experiment.mutex_group,
      status: experiment.status,
      starts_at: experiment.starts_at,
      stops_at: experiment.stops_at,
      bucket_count: experiment.bucket_count,
      arms: experiment.arms,
      targeting: experiment.targeting,
    };
  }

  stopExperiment(experimentId, at = nowIso(this.clock)) {
    const experiment = this.getExperiment(experimentId);
    if (experiment.status === "frozen") {
      throw new DomainError("experiment_frozen", "实验已冻结，不能修改停止时间");
    }
    experiment.status = "stopped";
    experiment.stops_at = at;
    return this.publicExperiment(experiment);
  }

  // ---------- 资产动态状态（跨仓调拨） ----------

  /**
   * 记录跨仓调拨：只改变后续分组看到的仓位，历史曝光快照不动。
   */
  recordTransfer({ asset_id, to_warehouse, at = nowIso(this.clock) }) {
    const asset = this.catalog.getAsset(asset_id);
    if (!asset) throw new DomainError("asset_not_found", `资产不存在：${asset_id}`);
    if (!this.catalog.raw.warehouses?.some((w) => w.code === to_warehouse)) {
      throw new DomainError("warehouse_not_found", `目标仓不存在：${to_warehouse}`);
    }
    const movement = { asset_id, from_warehouse: this.effectiveWarehouse(asset_id), to_warehouse, at };
    this.state.transfers.push(movement);
    asset.availability = { ...asset.availability, warehouse: to_warehouse };
    return movement;
  }

  effectiveWarehouse(assetId) {
    return this.catalog.getAsset(assetId)?.availability?.warehouse ?? null;
  }

  // ---------- 资格判定与分组 ----------

  /**
   * 纯判定：收集所有不满足的原因，不做短路——分析人员需要完整的排除构成。
   * 返回 { eligible, reasons, assetSnapshot, compliance, qualityFlags }。
   */
  evaluateEligibility({ experiment, user, assetId, at }) {
    const reasons = [];
    const asset = this.catalog.getAsset(assetId);
    const qualityFlags = [];

    if (!asset) {
      reasons.push("asset_not_found");
    } else {
      if (!this.catalog.isRentable(asset)) reasons.push("asset_not_rentable");
      const t = experiment.targeting;
      if (t.categories && !t.categories.includes(asset.category)) reasons.push("category_not_targeted");
      if (t.condition_grades && !t.condition_grades.includes(asset.condition_grade)) {
        reasons.push("condition_grade_not_targeted");
      }
      const warehouse = asset.availability.warehouse;
      if (t.warehouses && !t.warehouses.includes(warehouse)) reasons.push("warehouse_not_targeted");
      if (this.catalog.inspectionState(asset) === "missing") qualityFlags.push("missing_inspection");
    }

    const compliance = user?.compliance ?? {};
    if (compliance.identity_verified !== true) reasons.push("identity_unverified");
    if (compliance.credit_status === "blocked") {
      reasons.push("credit_blocked");
    } else if (typeof compliance.credit_score !== "number") {
      // 无法核实信用 ≠ 合规通过：缺数据只能排除，不能默认放行。
      reasons.push("credit_data_missing");
    } else if (compliance.credit_score < (experiment.eligibility.min_credit_score ?? 0)) {
      reasons.push("credit_score_below_threshold");
    }
    if (user == null || user.compliance == null) {
      reasons.push("compliance_data_missing");
    }
    if (Array.isArray(user?.quality_flags)) qualityFlags.push(...user.quality_flags);

    if (experiment.status === "frozen") reasons.push("experiment_frozen");
    if (at < experiment.starts_at) reasons.push("before_start");
    if (experiment.stops_at && at > experiment.stops_at) reasons.push("after_stop");

    return {
      eligible: reasons.length === 0,
      reasons,
      assetSnapshot: asset
        ? {
            asset_id: asset.asset_id,
            category: asset.category,
            condition_grade: asset.condition_grade,
            accessories: [...asset.accessories],
            warehouse: asset.availability.warehouse,
            availability_status: asset.availability.status,
            inspection_state: this.catalog.inspectionState(asset),
          }
        : null,
      compliance: {
        identity_verified: compliance.identity_verified === true,
        credit_status: compliance.credit_status ?? "unknown",
        credit_score: compliance.credit_score ?? null,
      },
      qualityFlags: [...new Set(qualityFlags)],
    };
  }

  activeExposure(exposureId) {
    const exposure = this.state.exposures.get(exposureId);
    return exposure && exposure.closed_at == null ? exposure : null;
  }

  /** 互斥：同一互斥组内，用户维度与资产维度都不能与“其他实验”的在租曝光重叠。 */
  findMutexConflict({ experiment, userId, assetId }) {
    const check = (index, key, dimension) => {
      for (const exposureId of index.get(key) ?? []) {
        const exposure = this.activeExposure(exposureId);
        if (!exposure) continue;
        const other = this.getExperiment(exposure.experiment_id);
        if (other.id === experiment.id) continue;
        if (other.mutex_group === experiment.mutex_group) {
          return { dimension, exposure_id: exposureId, experiment_id: other.id };
        }
      }
      return null;
    };
    return check(this.state.userIndex, userId, "user") ?? check(this.state.assetIndex, assetId, "asset");
  }

  armForUser(experiment, userId) {
    const bucket = stableBucket(`${experiment.id}|${userId}`, experiment.bucket_count);
    const matched = experiment.arms.find((candidate) => {
      const [lo, hi] = candidate.allocation;
      return bucket >= lo && bucket < hi;
    });
    if (!matched) throw new DomainError("allocation_gap", `桶 ${bucket} 未落入任何臂`);
    return { arm: matched, bucket };
  }

  /**
   * 分组入口。
   *
   * - 续租（renewal_of 指向既有曝光）：无条件沿用原臂，只延长暴露区间；
   *   即使实验已停止也保留原分组，新区间打 post_stop 标志。
   * - 同一 rental_id 重复请求：幂等返回原分组。
   * - 新请求：先资格、再互斥，全部判定写入资格留痕。
   */
  assign({ experiment_id, user, asset_id, rental_id, renewal_of, at = nowIso(this.clock) }) {
    if (!user?.user_id) throw new DomainError("invalid_request", "缺少 user.user_id");
    if (!asset_id) throw new DomainError("invalid_request", "缺少 asset_id");
    if (!rental_id) throw new DomainError("invalid_request", "缺少 rental_id");
    const experiment = this.getExperiment(experiment_id);

    if (renewal_of) {
      return this.applyRenewal({ exposureId: renewal_of, user, asset_id, rental_id, at });
    }
    const existingByRental = this.state.byRental.get(rental_id);
    if (existingByRental) {
      const exposure = this.state.exposures.get(existingByRental);
      return this.assignmentResponse(exposure, { idempotent: true });
    }

    const evaluation = this.evaluateEligibility({ experiment, user, assetId: asset_id, at });
    const logEntry = {
      at,
      experiment_id,
      user_id: user.user_id,
      asset_id,
      rental_id,
      eligible: evaluation.eligible,
      reasons: evaluation.reasons,
      quality_flags: evaluation.qualityFlags,
    };
    this.state.eligibilityLog.push(logEntry);

    if (!evaluation.eligible) {
      return {
        eligible: false,
        reasons: evaluation.reasons,
        asset_snapshot: evaluation.assetSnapshot,
        compliance: evaluation.compliance,
        quality_flags: evaluation.qualityFlags,
      };
    }

    const conflict = this.findMutexConflict({ experiment, userId: user.user_id, assetId: asset_id });
    if (conflict) {
      logEntry.eligible = false;
      logEntry.reasons.push(`mutex_${conflict.dimension}_busy`);
      logEntry.mutex_conflict = conflict;
      return {
        eligible: false,
        reasons: [`mutex_${conflict.dimension}_busy`],
        mutex_conflict: conflict,
        asset_snapshot: evaluation.assetSnapshot,
        compliance: evaluation.compliance,
        quality_flags: evaluation.qualityFlags,
      };
    }

    const { arm, bucket } = this.armForUser(experiment, user.user_id);
    const exposureId = `exp:${experiment.id}:${rental_id}`;
    if (this.state.exposures.has(exposureId)) {
      // 理论上被 rental_id 索引覆盖，保留一层防御性幂等。
      return this.assignmentResponse(this.state.exposures.get(exposureId), { idempotent: true });
    }
    const exposure = {
      exposure_id: exposureId,
      experiment_id: experiment.id,
      rental_id,
      user_id: user.user_id,
      asset_id,
      arm_id: arm.id,
      arm_name: arm.name,
      bucket,
      origin: {
        warehouse: evaluation.assetSnapshot.warehouse,
        category: evaluation.assetSnapshot.category,
        condition_grade: evaluation.assetSnapshot.condition_grade,
      },
      started_at: at,
      exposed_through: at,
      ordered_at: null,
      closed_at: null,
      post_stop: false,
      quality_flags: evaluation.qualityFlags,
      renewal_segments: [],
    };
    this.state.exposures.set(exposureId, exposure);
    this.state.byRental.set(rental_id, exposureId);
    this.indexPush(this.state.userIndex, user.user_id, exposureId);
    this.indexPush(this.state.assetIndex, asset_id, exposureId);
    this.tryMatchQuarantined(exposure);
    return this.assignmentResponse(exposure, { assigned: true });
  }

  applyRenewal({ exposureId, user, asset_id, rental_id, at }) {
    const original =
      this.state.exposures.get(exposureId) ??
      (this.state.byRental.has(exposureId) ? this.state.exposures.get(this.state.byRental.get(exposureId)) : null);
    if (!original) throw new DomainError("exposure_not_found", `续租找不到原曝光：${exposureId}`);
    if (original.user_id !== user.user_id) {
      throw new DomainError("renewal_user_mismatch", "续租必须由原租赁用户发起");
    }
    if (original.asset_id !== asset_id) {
      throw new DomainError("renewal_asset_mismatch", "续租不允许更换资产；换资产属于新租赁");
    }
    const experiment = this.getExperiment(original.experiment_id);
    const segmentPostStop = Boolean(experiment.stops_at && at > experiment.stops_at);
    // 只追加续期段、延长暴露区间末端；原曝光的入窗身份永不被续租改写。
    original.exposed_through = at;
    original.closed_at = null;
    original.renewal_segments.push({ rental_id, at, post_stop: segmentPostStop });
    // 续租租期内的结果事件用新 rental_id 汇入，需映射回同一曝光。
    this.state.byRental.set(rental_id, original.exposure_id);
    this.tryMatchQuarantined(original);
    // post_stop 由 assignmentResponse 按续期段聚合，extra 不再单独传。
    return this.assignmentResponse(original, { renewed: true, arm_preserved: true });
  }

  assignmentResponse(exposure, extra = {}) {
    const postStopSegments = exposure.renewal_segments.filter((segment) => segment.post_stop).length;
    return {
      eligible: true,
      assigned: true,
      exposure_id: exposure.exposure_id,
      rental_id: exposure.rental_id,
      experiment_id: exposure.experiment_id,
      arm_id: exposure.arm_id,
      arm_name: exposure.arm_name,
      bucket: exposure.bucket,
      started_at: exposure.started_at,
      exposed_through: exposure.exposed_through,
      origin: exposure.origin,
      quality_flags: exposure.quality_flags,
      post_stop: exposure.post_stop || postStopSegments > 0,
      post_stop_renewal_segments: postStopSegments,
      ...extra,
    };
  }

  indexPush(index, key, value) {
    if (!index.has(key)) index.set(key, []);
    const list = index.get(key);
    if (!list.includes(value)) list.push(value);
  }

  // ---------- 结果事件 ----------

  /**
   * 幂等汇入结果事件。
   * 重复 event_id：原样返回，不重复计数。
   * 找不到曝光：隔离留痕（quarantine），绝不丢弃；曝光日后出现时自动补配。
   */
  ingestEvent(event, { receivedAt = nowIso(this.clock) } = {}) {
    const { event_id, type, occurred_at } = event;
    if (!event_id) throw new DomainError("invalid_request", "事件缺少 event_id");
    if (!ASSIGNABLE_EVENTS.has(type)) {
      throw new DomainError("unknown_event_type", `不支持的事件类型：${type}`, { known: [...ASSIGNABLE_EVENTS] });
    }
    if (!occurred_at) throw new DomainError("invalid_request", "事件缺少 occurred_at");

    const duplicate = this.state.events.get(event_id);
    if (duplicate) return { accepted: false, duplicate: true, event_id, exposure_id: duplicate.exposure_id };

    const exposureId = event.exposure_id ?? (event.rental_id ? this.state.byRental.get(event.rental_id) : null);
    const exposure = exposureId ? this.state.exposures.get(exposureId) : null;

    const record = {
      ...event,
      received_at: receivedAt,
      exposure_id: exposure?.exposure_id ?? null,
      applied: false,
      late: false,
    };

    if (!exposure) {
      record.quarantine_reason = "unknown_exposure";
      this.state.quarantined.set(event_id, record);
      this.state.events.set(event_id, record);
      return { accepted: true, quarantined: true, reason: "unknown_exposure", event_id };
    }

    return this.applyEvent(record, exposure);
  }

  applyEvent(record, exposure) {
    const experiment = this.getExperiment(exposure.experiment_id);
    const latestReport = this.latestReport(experiment.id);
    if (latestReport) {
      const cutoff = latestReport.content.event_cutoff;
      // 落在已报告窗口内 = 迟到事件；晚于窗口的新事件同样要在冻结后触发新版本。
      record.late = record.occurred_at <= cutoff;
    }
    const wasFrozenWithReport = experiment.status === "frozen" && latestReport !== null;
    record.applied = true;
    record.exposure_id = exposure.exposure_id;

    switch (record.type) {
      case "order":
        if (!exposure.ordered_at) exposure.ordered_at = record.occurred_at;
        exposure.exposed_through = record.occurred_at > exposure.exposed_through
          ? record.occurred_at
          : exposure.exposed_through;
        break;
      case "cancel":
        exposure.closed_at = record.occurred_at;
        break;
      case "return":
        exposure.closed_at = record.occurred_at;
        exposure.exposed_through = record.occurred_at;
        break;
      case "cs_exemption":
        if (!exposure.quality_flags.includes("cs_exemption")) exposure.quality_flags.push("cs_exemption");
        break;
      case "account_flag": {
        const flag = record.payload?.flag ?? "bulk_account_suspect";
        if (!exposure.quality_flags.includes(flag)) exposure.quality_flags.push(flag);
        break;
      }
      case "overdue":
      case "damage_dispute":
      case "rerent":
        break; // 结果在报告阶段折叠
    }

    this.state.events.set(record.event_id, record);
    this.state.quarantined.delete(record.event_id);

    if (wasFrozenWithReport) {
      this.recompute(experiment.id, {
        trigger: record.late ? "late_event" : "post_freeze_event",
        at: record.received_at,
      });
    }
    return {
      accepted: true,
      duplicate: false,
      quarantined: false,
      late: record.late,
      exposure_id: exposure.exposure_id,
      arm_id: exposure.arm_id,
    };
  }

  /** 曝光出现后尝试补配此前被隔离的事件（按 rental_id / exposure_id / user+asset 无法泛配，仅前两者）。 */
  tryMatchQuarantined(exposure) {
    for (const [eventId, record] of this.state.quarantined) {
      const matches =
        record.exposure_id === exposure.exposure_id ||
        record.rental_id === exposure.rental_id;
      if (matches) this.applyEvent(record, exposure);
    }
  }

  // ---------- 指标口径与冻结 ----------

  publishMetricDefinition(definition, { at = nowIso(this.clock) } = {}) {
    const experiment = this.getExperiment(definition.experiment_id);
    if (experiment.status === "frozen") {
      throw new DomainError("experiment_frozen", "实验已冻结，指标口径不可再变更");
    }
    const metrics = definition.metrics;
    if (!Array.isArray(metrics) || metrics.length === 0) {
      throw new DomainError("invalid_metric_definition", "metrics 必须为非空数组");
    }
    const allowed = new Set(knownMetricIds());
    for (const metricId of metrics) {
      if (!allowed.has(metricId)) {
        throw new DomainError("invalid_metric_definition", `未知指标：${metricId}`, { known: [...allowed] });
      }
    }
    if (!definition.primary_metric || !allowed.has(definition.primary_metric)) {
      throw new DomainError("invalid_metric_definition", "primary_metric 缺失或未知");
    }
    if (!metrics.includes(definition.primary_metric)) {
      throw new DomainError("invalid_metric_definition", "主指标必须包含在 metrics 列表中");
    }
    const privacyThreshold = definition.privacy_threshold ?? 10;
    if (!Number.isInteger(privacyThreshold) || privacyThreshold < 1) {
      throw new DomainError("invalid_metric_definition", "privacy_threshold 必须为正整数");
    }
    const versions = this.state.metricDefinitions.get(experiment.id) ?? [];
    const version = definition.version ?? versions.length + 1;
    if (versions.some((v) => v.version === version)) {
      throw new DomainError("metric_version_exists", `指标口径版本已存在：v${version}`);
    }
    const stored = {
      experiment_id: experiment.id,
      version,
      primary_metric: definition.primary_metric,
      metrics,
      guardrails: definition.guardrails ?? [],
      privacy_threshold: privacyThreshold,
      published_by: definition.published_by ?? "analyst",
      published_at: at,
      note: definition.note ?? "",
    };
    versions.push(stored);
    this.state.metricDefinitions.set(experiment.id, versions);
    return stored;
  }

  currentMetricDefinition(experimentId) {
    const versions = this.state.metricDefinitions.get(experimentId) ?? [];
    return versions[versions.length - 1] ?? null;
  }

  /** 冻结门禁：分析人员发布指标口径后才能冻结实验。 */
  freezeExperiment(experimentId, { at = nowIso(this.clock) } = {}) {
    const experiment = this.getExperiment(experimentId);
    const definition = this.currentMetricDefinition(experimentId);
    if (!definition) {
      throw new DomainError("metric_definition_missing", "指标口径尚未发布，不能冻结实验");
    }
    if (experiment.status === "frozen") {
      return { frozen: true, idempotent: true, frozen_at: experiment.frozen_at, metric_version: definition.version };
    }
    experiment.status = "frozen";
    experiment.stops_at = experiment.stops_at ?? at;
    experiment.frozen_at = at;
    return { frozen: true, frozen_at: at, metric_version: definition.version };
  }

  // ---------- 报告（版本化、不覆盖） ----------

  recompute(experimentId, { trigger = "manual", at = nowIso(this.clock), triggeredBy = "analyst" } = {}) {
    const experiment = this.getExperiment(experimentId);
    const definition = this.currentMetricDefinition(experimentId);
    if (!definition) {
      throw new DomainError("metric_definition_missing", "指标口径尚未发布，无法生成报告");
    }

    const exposures = [...this.state.exposures.values()].filter((e) => e.experiment_id === experimentId);
    const eventsByExposure = new Map();
    let eventCutoff = experiment.starts_at;
    for (const record of this.state.events.values()) {
      if (!record.applied || record.exposure_id == null) continue;
      const exposure = this.state.exposures.get(record.exposure_id);
      if (!exposure || exposure.experiment_id !== experimentId) continue;
      if (!eventsByExposure.has(record.exposure_id)) eventsByExposure.set(record.exposure_id, []);
      eventsByExposure.get(record.exposure_id).push(record);
      if (record.occurred_at > eventCutoff) eventCutoff = record.occurred_at;
    }

    const exclusions = this.state.eligibilityLog.filter(
      (entry) => entry.experiment_id === experimentId && !entry.eligible,
    );
    const quarantined = [...this.state.quarantined.values()];

    const content = buildReport({
      experiment,
      exposures,
      eventsByExposure,
      metricDefinition: definition,
      privacyThreshold: definition.privacy_threshold,
      exclusions,
      quarantinedEvents: quarantined,
    });
    content.event_cutoff = eventCutoff;
    content.generated_at = at;
    content.frozen = experiment.status === "frozen";
    content.recommendations = recommendDecision(content, definition.guardrails);
    // 建议附样本资格摘要，负责人能看到每个建议背后的样本规模。
    for (const [armId, recommendation] of Object.entries(content.recommendations)) {
      const cell = content.arms[armId]?.primary.metrics[definition.primary_metric];
      recommendation.basis = {
        primary_metric: definition.primary_metric,
        sample: cell?.suppressed
          ? { suppressed: true, privacy_threshold: definition.privacy_threshold }
          : { numerator: cell.numerator, denominator: cell.denominator },
      };
      recommendation.scope_note =
        "结论仅用于策略层推广/回滚/继续观察，不得用于干预单笔租赁；详见分层与排除留痕。";
    }

    const versions = this.state.reports.get(experimentId) ?? [];
    const reportVersion = versions.length + 1;
    const snapshot = {
      report_version: reportVersion,
      trigger,
      triggered_by: triggeredBy,
      created_at: at,
      metric_definition_version: definition.version,
      content,
    };
    Object.freeze(snapshot);
    Object.freeze(content);
    versions.push(snapshot);
    this.state.reports.set(experimentId, versions);
    return snapshot;
  }

  latestReport(experimentId) {
    const versions = this.state.reports.get(experimentId) ?? [];
    return versions[versions.length - 1] ?? null;
  }

  getReport(experimentId, version) {
    const versions = this.state.reports.get(experimentId) ?? [];
    if (version == null) {
      const latest = versions[versions.length - 1];
      if (!latest) throw new DomainError("report_not_found", "尚无报告版本");
      return latest;
    }
    const found = versions.find((v) => v.report_version === version);
    if (!found) throw new DomainError("report_not_found", `报告版本不存在：v${version}`);
    return found;
  }

  listReports(experimentId) {
    return (this.state.reports.get(experimentId) ?? []).map((v) => ({
      report_version: v.report_version,
      trigger: v.trigger,
      created_at: v.created_at,
      metric_definition_version: v.metric_definition_version,
    }));
  }

  /**
   * 角色视图：analyst 看到完整报告；operator（运营）只看到满足隐私阈值的分组结果，
   * 拿不到事件级标识，冻结前的预览报告也不对运营开放。
   */
  viewReport(experimentId, { role = "operator", version } = {}) {
    const snapshot = this.getReport(experimentId, version);
    // 可见性以实验当前状态为准：实验一旦冻结，其全部历史版本报告都可向运营开放。
    const currentlyFrozen = this.getExperiment(experimentId).status === "frozen";
    if (role === "operator" && !currentlyFrozen) {
      throw new DomainError("report_not_published", "实验冻结前不对运营开放报告");
    }
    if (role === "analyst") return snapshot;

    const content = snapshot.content;
    const k = content.privacy_threshold;
    // 低于隐私阈值的计数一律以 "suppressed" 呈现，避免小样本反推出个人或分组规模。
    const maskCount = (count) => (count < k ? "suppressed" : count);
    const maskCountMap = (map) =>
      Object.fromEntries(Object.entries(map ?? {}).map(([key, count]) => [key, maskCount(count)]));
    const maskBlock = (block) => {
      if (!block) return block;
      const maskedMetrics = {};
      let allSuppressed = true;
      for (const [metricId, metric] of Object.entries(block.metrics)) {
        if (metric.suppressed) {
          maskedMetrics[metricId] = { suppressed: true, reason: "privacy_threshold" };
        } else {
          allSuppressed = false;
          maskedMetrics[metricId] = metric;
        }
      }
      return {
        // 整块都低于阈值时，连队列规模也不对外给具体数。
        exposures: allSuppressed ? "suppressed" : block.exposures,
        metrics: maskedMetrics,
      };
    };
    const arms = {};
    for (const [armId, arm] of Object.entries(content.arms)) {
      arms[armId] = {
        name: arm.name,
        primary: maskBlock(arm.primary),
        strata: Object.fromEntries(
          Object.entries(arm.strata).map(([dim, keys]) => [
            dim,
            Object.fromEntries(Object.entries(keys).map(([key, block]) => [key, maskBlock(block)])),
          ]),
        ),
      };
    }
    return {
      report_version: snapshot.report_version,
      created_at: snapshot.created_at,
      experiment_id: content.experiment_id,
      experiment_name: content.experiment_name,
      status: content.status,
      metric_definition_version: snapshot.metric_definition_version,
      privacy_threshold: content.privacy_threshold,
      cohort: {
        eligible_exposures: maskCount(content.cohort.eligible_exposures),
        excluded: maskCountMap(content.cohort.excluded),
        quality_flagged: maskCountMap(content.cohort.quality_flagged),
      },
      arms,
      comparisons: content.comparisons,
      recommendations: content.recommendations,
      data_quality: { quarantined_event_count: content.data_quality.quarantined_event_count },
    };
  }

  // 调试 / 留痕查询
  eligibilityTrail(experimentId) {
    return this.state.eligibilityLog.filter((entry) => entry.experiment_id === experimentId);
  }

  listExposures(experimentId) {
    return [...this.state.exposures.values()].filter((e) => e.experiment_id === experimentId);
  }
}

// 租赁策略实验平台门面：串联资产、资格、分组、互斥、事件、口径与报告。
// 所有失败的入组尝试都进入筛选日志（带原因码与质量标记），不允许静默丢弃样本。

import { AssetRegistry } from "./assets.js";
import { evaluateEligibility, DEFAULT_POLICY } from "./eligibility.js";
import { Experiment, ExperimentStore, EXPERIMENT_STATUS } from "./assignment.js";
import { EventLog } from "./events.js";
import { MetricRegistry, DEFAULT_METRIC_SPEC_V1 } from "./metrics.js";
import { ReportArchive, DEFAULT_PRIVACY_THRESHOLD } from "./reports.js";

export class ExperimentPlatform {
  constructor({ assets = [], policy = DEFAULT_POLICY, privacyThreshold = DEFAULT_PRIVACY_THRESHOLD } = {}) {
    this.registry = Array.isArray(assets) ? new AssetRegistry(assets) : assets;
    this.policy = policy;
    this.privacyThreshold = privacyThreshold;
    this.store = new ExperimentStore();
    this.eventLog = new EventLog();
    this.metrics = new MetricRegistry();
    this.reports = new ReportArchive();
  }

  createExperiment(config) {
    const experiment = new Experiment(config);
    this.store.addExperiment(experiment);
    return experiment;
  }

  // 一次入组尝试：无论成功失败都留下筛选记录。
  // 返回 { admitted: true, ... } 或 { admitted: false, reasons }。
  attemptEnrollment({ experimentId, user, assetId, now }) {
    const experiment = this.store.experiments.get(experimentId);
    const at = now ?? new Date().toISOString();
    const asset = this.registry.get(assetId);

    // 实验状态优先判定（停止/冻结后不再接纳新入组，旧暴露保留）。
    if (!experiment) {
      this.store.logScreening({ experimentId, userId: user?.user_id ?? null, assetId, eligible: false, reasons: ["EXPERIMENT_NOT_FOUND"] });
      return { admitted: false, reasons: ["EXPERIMENT_NOT_FOUND"] };
    }
    if (experiment.status !== EXPERIMENT_STATUS.ENROLLING) {
      this.store.logScreening({ experimentId, userId: user?.user_id ?? null, assetId, eligible: false, reasons: ["EXPERIMENT_NOT_ENROLLING"] });
      return { admitted: false, reasons: ["EXPERIMENT_NOT_ENROLLING"] };
    }

    const eligibility = evaluateEligibility({ user, asset, policy: this.policy, now: new Date(at).getTime() });
    if (!eligibility.eligible) {
      this.store.logScreening({
        experimentId,
        userId: user?.user_id ?? null,
        assetId,
        eligible: false,
        reasons: eligibility.exclusionReasons,
        qualityFlags: eligibility.qualityFlags,
      });
      return { admitted: false, reasons: eligibility.exclusionReasons, qualityFlags: eligibility.qualityFlags };
    }

    const result = this.store.enroll({ experimentId, user, asset, eligibility, now: at });
    if (!result.ok) {
      this.store.logScreening({
        experimentId,
        userId: user.user_id,
        assetId,
        eligible: false,
        reasons: result.reasons,
        qualityFlags: eligibility.qualityFlags,
      });
      return { admitted: false, reasons: result.reasons, qualityFlags: eligibility.qualityFlags };
    }

    this.store.logScreening({
      experimentId,
      userId: user.user_id,
      assetId,
      exposureId: result.exposureId,
      eligible: true,
      reasons: [],
      qualityFlags: eligibility.qualityFlags,
    });
    return { admitted: true, arm: result.arm, exposureId: result.exposureId, exposure: result.exposure };
  }

  // 幂等汇入结果事件；重复 event_id 返回 duplicate 而不是重复计数。
  ingestEvent(raw, options) {
    return this.eventLog.ingest(raw, options);
  }

  renew(exposureId, options) {
    return this.store.renew(exposureId, options);
  }

  transfer(exposureId, warehouse, options) {
    return this.store.transfer(exposureId, warehouse, options);
  }

  stopExperiment(experimentId, at) {
    const experiment = this.store.experiments.get(experimentId);
    if (!experiment) throw new Error(`实验不存在: ${experimentId}`);
    return experiment.stop(at);
  }

  publishMetricDefinition(definition) {
    return this.metrics.publish(definition);
  }

  // 冻结：只有指标口径已经发布才允许；冻结时固定口径版本。
  freezeExperiment(experimentId, metricVersion, at) {
    const experiment = this.store.experiments.get(experimentId);
    if (!experiment) throw new Error(`实验不存在: ${experimentId}`);
    if (!this.metrics.isPublished(metricVersion)) {
      throw new Error(`指标口径尚未发布，不能冻结实验: ${metricVersion}`);
    }
    return experiment.freeze(metricVersion, at);
  }

  // 生成一份不可变报告。迟到事件（occurred_at 早于上一份报告水位）自动计数，
  // 结果以新版本报告保存，旧报告原样保留。
  generateReport(experimentId, { cutoff, holidayRanges, controlArm, role = "analyst" } = {}) {
    const experiment = this.store.experiments.get(experimentId);
    if (!experiment) throw new Error(`实验不存在: ${experimentId}`);
    const metricVersion = experiment.frozenMetricVersion
      ?? [...this.metrics.versions.keys()].at(-1);
    const definition = this.metrics.get(metricVersion);
    if (!definition) throw new Error("尚无已发布的指标口径，无法出报告");

    const experimentEvents = this.eventLog.listByExperiment(
      this.store.listExposures(experimentId).map((e) => e.exposureId),
    );
    this.reports.publish({
      experiment,
      store: this.store,
      events: experimentEvents,
      metricDefinition: definition,
      options: { cutoff, holidayRanges, controlArm, privacyThreshold: this.privacyThreshold },
    });
    return this.reports.viewForRole(experimentId, role, { privacyThreshold: this.privacyThreshold });
  }

  listReports(experimentId) {
    return this.reports.list(experimentId);
  }

  viewReport(experimentId, role = "analyst") {
    return this.reports.viewForRole(experimentId, role, { privacyThreshold: this.privacyThreshold });
  }
}

export { DEFAULT_METRIC_SPEC_V1, EXPERIMENT_STATUS };

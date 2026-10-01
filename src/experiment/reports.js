// 版本化报告：按已发布口径计算指标，产出不可变报告；迟到事件触发新版本重算，旧报告保留。
// 每份报告附：样本资格与排除原因、质量标记、仓库/成色/时间/节假日分层、Wilson 与风险差区间，
// 以及推广/回滚/继续观察的规则化建议。运营视图对低于隐私阈值的分组做抑制。

import { RESULT_EVENTS } from "./events.js";
import { isoWeek, riskDifference, wilsonInterval, classifyEffect, srmCheck, Z_95 } from "./stats.js";

export const DEFAULT_PRIVACY_THRESHOLD = 30; // 任一策略臂在单元格内的最小样本量

function summarizeExposure(exposure, events) {
  const mine = events.filter((event) => event.exposureId === exposure.exposureId);
  const has = (type) => mine.some((event) => event.type === type);
  const disputes = mine.filter((event) => event.type === RESULT_EVENTS.DAMAGE_DISPUTE);
  return {
    exposure,
    ordered: has(RESULT_EVENTS.ORDER_PLACED),
    cancelled: has(RESULT_EVENTS.ORDER_CANCELLED),
    overdue: has(RESULT_EVENTS.OVERDUE),
    damageDispute: disputes.length > 0,
    agentWaivedDamage: disputes.some((event) => event.payload.agent_waived === true),
    reRent: has(RESULT_EVENTS.RE_RENT),
    ended: exposure.status === "ended",
  };
}

function rateRows(rows, metricDefs, controlArm) {
  const byArm = new Map();
  for (const row of rows) {
    if (!byArm.has(row.exposure.arm)) byArm.set(row.exposure.arm, []);
    byArm.get(row.exposure.arm).push(row);
  }
  const arms = {};
  for (const [arm, armRows] of byArm) {
    const enrolled = armRows.length;
    const orderedRows = armRows.filter((row) => row.ordered);
    const endedRows = armRows.filter((row) => row.ended);
    const counts = {
      order_rate: [orderedRows.length, enrolled],
      cancel_rate: [armRows.filter((row) => row.cancelled).length, orderedRows.length],
      overdue_rate: [armRows.filter((row) => row.overdue).length, orderedRows.length],
      damage_dispute_rate: [armRows.filter((row) => row.damageDispute).length, orderedRows.length],
      re_rent_rate: [armRows.filter((row) => row.reRent).length, endedRows.length],
    };
    const metrics = {};
    for (const key of Object.keys(metricDefs)) {
      const [successes, n] = counts[key] ?? [0, 0];
      metrics[key] = { ...wilsonInterval(successes, n) };
    }
    // 客服豁免的损伤争议单列，绝不并入"无争议"。
    metrics.damage_dispute_rate.agent_waived = armRows.filter((row) => row.agentWaivedDamage).length;
    arms[arm] = {
      enrolled,
      ordered: orderedRows.length,
      ended: endedRows.length,
      metrics,
    };
  }

  const comparisons = [];
  for (const arm of Object.keys(arms)) {
    if (arm === controlArm) continue;
    for (const [key, def] of Object.entries(metricDefs)) {
      const t = arms[arm].metrics[key];
      const c = arms[controlArm]?.metrics[key];
      if (!c) continue;
      const rd = riskDifference(t.successes, t.n, c.successes, c.n);
      comparisons.push({
        arm,
        control: controlArm,
        metric: key,
        ...rd,
        verdict: classifyEffect({ lower: rd.lower, upper: rd.upper, direction: def.direction, margin: def.practicalMargin }),
        guardrail: def.guardrail === true,
        primary: def.primary === true,
      });
    }
  }
  return { arms, comparisons };
}

function buildStrata(rows, metricDefs, controlArm, holidayRanges) {
  const buckets = new Map();
  const add = (dimension, value, row) => {
    const key = `${dimension}|${value}`;
    if (!buckets.has(key)) buckets.set(key, { dimension, value: String(value), rows: [] });
    buckets.get(key).rows.push(row);
  };
  for (const row of rows) {
    const exposure = row.exposure;
    add("warehouse", exposure.warehouseAtAssignment, row);
    add("condition_grade", exposure.conditionGrade, row);
    add("iso_week", isoWeek(exposure.assignedAt), row);
    add("category", exposure.category, row);
    const missingInspection = exposure.qualityFlags.includes("MISSING_INSPECTION_DATA");
    add("inspection_data", missingInspection ? "missing" : "present", row);
    add(
      "agent_exemption",
      exposure.qualityFlags.includes("AGENT_EXEMPTION") ? "exempted" : "standard",
      row,
    );
    if (holidayRanges && inHolidayRange(exposure.assignedAt, holidayRanges)) {
      add("demand_period", "holiday", row);
    } else if (holidayRanges) {
      add("demand_period", "normal", row);
    }
  }
  return [...buckets.values()].map((bucket) => {
    const { arms, comparisons } = rateRows(bucket.rows, metricDefs, controlArm);
    return { dimension: bucket.dimension, value: bucket.value, sampleSize: bucket.rows.length, arms, comparisons };
  });
}

function inHolidayRange(isoString, ranges) {
  const t = new Date(isoString).getTime();
  return ranges.some(([start, end]) => {
    const s = new Date(start).getTime();
    const e = new Date(end).getTime();
    return t >= s && t <= e;
  });
}

// 只判定一个分层格是否达到隐私阈值，不移除数据。
function evaluatePrivacy(cell, armIds, threshold) {
  const minimumArmN = Math.min(...armIds.map((id) => cell.arms[id]?.enrolled ?? 0));
  if (minimumArmN < threshold) {
    return { suppressed: true, threshold, reason: "分组样本量低于隐私阈值", minimumArmN };
  }
  return { suppressed: false, threshold, minimumArmN };
}

// 运营视图：把被抑制格的数值整体移除，只保留维度与样本量。
function stripSuppressed(strata) {
  return strata.map((cell) => {
    if (!cell.privacy.suppressed) return cell;
    return {
      dimension: cell.dimension,
      value: cell.value,
      sampleSize: cell.sampleSize,
      privacy: cell.privacy,
    };
  });
}

function recommend(comparisons, treatmentArms, srm) {
  const reasons = [];
  let rollback = false;
  let candidate = null;

  const srmAlert = Boolean(srm?.flagged);
  if (srmAlert) {
    reasons.push(`样本比例失衡检验报警（χ²=${srm.chiSquare.toFixed(2)}, p=${srm.pValue.toExponential(2)}）：随机化或互斥可能被污染，推广结论不可信`);
  }

  for (const arm of treatmentArms) {
    const armComparisons = comparisons.filter((c) => c.arm === arm);
    const guardrailHit = armComparisons.find((c) => c.guardrail && c.verdict === "inferior");
    const primary = armComparisons.find((c) => c.primary);
    if (guardrailHit) {
      rollback = true;
      reasons.push(`${arm} 护栏指标 ${guardrailHit.metric} 显著劣于对照（区间 ${fmt(guardrailHit.lower)}, ${fmt(guardrailHit.upper)}），应回滚该策略`);
      continue;
    }
    if (primary && primary.verdict === "inferior") {
      rollback = true;
      reasons.push(`${arm} 主指标 ${primary.metric} 显著劣于对照（区间 ${fmt(primary.lower)}, ${fmt(primary.upper)}），坏账风险升高，应回滚该策略`);
      continue;
    }
    if (primary && primary.verdict === "superior") {
      if (!candidate) candidate = arm;
      reasons.push(`${arm} 主指标 ${primary.metric} 显著优于对照（区间 ${fmt(primary.lower)}, ${fmt(primary.upper)}）`);
    } else if (primary) {
      reasons.push(`${arm} 主指标 ${primary.metric} 尚不确定（区间 ${fmt(primary.lower)}, ${fmt(primary.upper)}）`);
    }
  }

  // 护栏受损优先回滚（即使存在 SRM 报警，也不应让疑似有害策略继续）。
  if (rollback) return { decision: "rollback", reasons, srmAlert };
  // SRM 报警时不得推广：降级为继续观察。
  if (candidate && !srmAlert) return { decision: "rollout", arm: candidate, reasons, srmAlert: false };
  if (candidate) return { decision: "continue_observing", arm: candidate, reasons, srmAlert };
  return { decision: "continue_observing", reasons, srmAlert };
}

function fmt(x) {
  return x === null ? "n/a" : (x * 100).toFixed(2) + "pp";
}

export class ReportArchive {
  constructor() {
    this.reports = new Map(); // experimentId -> [report]（不可变，按版本升序）
  }

  publish({
    experiment,
    store,
    events,
    metricDefinition,
    options = {},
  }) {
    if (!metricDefinition) throw new Error("报告必须引用已发布的指标口径");
    const privacyThreshold = options.privacyThreshold ?? DEFAULT_PRIVACY_THRESHOLD;
    const controlArm = options.controlArm ?? experiment.arms[0].id;
    if (!experiment.arms.some((arm) => arm.id === controlArm)) {
      throw new Error("对照组策略臂不存在");
    }
    const treatmentArms = experiment.arms.map((arm) => arm.id).filter((id) => id !== controlArm);

    const exposures = store.listExposures(experiment.id);
    const rows = exposures.map((exposure) => summarizeExposure(exposure, events));
    const { arms, comparisons } = rateRows(rows, metricDefinition.metrics, controlArm);
    const strata = buildStrata(rows, metricDefinition.metrics, controlArm, options.holidayRanges ?? null)
      .map((cell) => ({ ...cell, privacy: evaluatePrivacy(cell, experiment.arms.map((arm) => arm.id), privacyThreshold) }));

    // 样本比例失衡检验：分组偏离预设权重即视为随机化污染信号。
    const weights = Object.fromEntries(experiment.arms.map((arm) => [arm.id, arm.weight]));
    const observed = Object.fromEntries(
      experiment.arms.map((arm) => [arm.id, arms[arm.id]?.enrolled ?? 0]),
    );
    const srm = srmCheck(observed, weights);

    // 样本资格：筛选日志中的每一条都被计数，排除原因对外可见。
    const screening = store.screeningLog.filter((entry) => entry.experimentId === experiment.id);
    const exclusions = {};
    for (const entry of screening) {
      for (const reason of entry.reasons ?? []) {
        exclusions[reason] = (exclusions[reason] ?? 0) + 1;
      }
    }
    const qualityFlags = {};
    for (const row of rows) {
      for (const flag of row.exposure.qualityFlags) {
        qualityFlags[flag] = (qualityFlags[flag] ?? 0) + 1;
      }
    }
    // 被资格环节拦下的质量可疑样本同样单列（如批量账号）；成功入组样本的标记
    // 已在上方从暴露行计数，这里只统计被拒绝条目，避免重复。
    for (const entry of screening) {
      if (entry.eligible) continue;
      for (const flag of entry.qualityFlags ?? []) {
        qualityFlags[flag] = (qualityFlags[flag] ?? 0) + 1;
      }
    }

    // 迟到事件：上一份报告生成之后才汇入、但业务发生时间落在上一份报告截止线之前。
    // 水位用单调摄入序号（而非墙钟），避免把正常的历史事件误判为迟到。
    const prior = this.reports.get(experiment.id) ?? [];
    const previous = prior.at(-1) ?? null;
    const cutoff = options.cutoff ?? new Date().toISOString();
    const lastEventSeq = events.reduce((max, event) => Math.max(max, event.ingestSeq ?? 0), 0);
    const lateEvents = previous
      ? events.filter((event) =>
        (event.ingestSeq ?? 0) > previous.watermark.lastEventSeq &&
        event.occurredAt <= previous.watermark.cutoff)
      : [];

    const recommendation = recommend(comparisons, treatmentArms, srm);
    const report = Object.freeze({
      experimentId: experiment.id,
      reportVersion: `rpt-${(prior.length + 1).toString().padStart(3, "0")}`,
      metricVersion: metricDefinition.version,
      generatedAt: new Date().toISOString(),
      status: experiment.status,
      z: Z_95,
      srm,
      watermark: {
        cutoff,
        eventsConsidered: events.length,
        lastEventSeq,
        lateEventsSincePrevious: lateEvents.length,
      },
      sampleQualification: {
        screened: screening.length,
        enrolled: exposures.length,
        exclusions, // 原因码 -> 次数；保留全部失败样本
        qualityFlagsInAnalysis: qualityFlags,
      },
      arms,
      comparisons,
      strata,
      recommendation,
      attributionPolicy: "ITT：按首次稳定分组归因；取消、争议、续租均不改变分组",
    });

    const next = [...prior, report];
    this.reports.set(experiment.id, next);
    return report;
  }

  list(experimentId) {
    return this.reports.get(experimentId) ?? [];
  }

  latest(experimentId) {
    return this.list(experimentId).at(-1) ?? null;
  }

  // 运营只能看到满足隐私阈值的分组；分析人员可见全量（带抑制标记，便于核对）。
  viewForRole(experimentId, role, { privacyThreshold = DEFAULT_PRIVACY_THRESHOLD } = {}) {
    const report = this.latest(experimentId);
    if (!report) return null;
    if (role === "ops") {
      // 阈值可在查看时调整：按该阈值重新计算每个格的抑制状态后再剥离数值。
      const armIds = Object.keys(report.arms);
      const strata = stripSuppressed(report.strata.map((cell) => ({
        ...cell,
        privacy: evaluatePrivacy(cell, armIds, privacyThreshold),
      })));
      return { ...report, strata };
    }
    return report;
  }
}

// 指标计算：全部为纯函数，输入是曝光队列与事件，输出可直接序列化的报告。
// 设计原则：失败样本不允许被静默删除——被标记样本始终计入主口径，
// 只额外提供 clean_only 敏感性视图；任何低于隐私阈值的单元一律掩码。

export const DEFAULT_Z = 1.96;

/** Wilson 得分区间，小样本下比正态近似更可靠；n=0 时返回 null。 */
export function wilsonInterval(successes, trials, z = DEFAULT_Z) {
  if (trials <= 0) return null;
  const phat = successes / trials;
  const denom = 1 + (z * z) / trials;
  const center = (phat + (z * z) / (2 * trials)) / denom;
  const margin =
    (z * Math.sqrt((phat * (1 - phat) + z * z / (4 * trials)) / trials)) / denom;
  return {
    value: phat,
    ci_low: Math.max(0, center - margin),
    ci_high: Math.min(1, center + margin),
    numerator: successes,
    denominator: trials,
  };
}

/**
 * Newcombe 区间（Wilson 配对法），用于两比例之差。
 * 对照组在前、处理组在后：diff = p_treatment - p_control。
 */
export function newcombeDiff(successesT, trialsT, successesC, trialsC, z = DEFAULT_Z) {
  const t = wilsonInterval(successesT, trialsT, z);
  const c = wilsonInterval(successesC, trialsC, z);
  if (!t || !c) return null;
  const diff = t.value - c.value;
  return {
    diff,
    ci_low: diff - Math.sqrt((t.value - t.ci_low) ** 2 + (c.ci_high - c.value) ** 2),
    ci_high: diff + Math.sqrt((t.ci_high - t.value) ** 2 + (c.value - c.ci_low) ** 2),
  };
}

const METRIC_SPECS = {
  // id => 取数规则：numerator 计数、denominator 队列、优化方向
  cancel_rate: { numerator: "cancelled", denominator: "all", objective: "minimize" },
  overdue_rate: { numerator: "overdue", denominator: "non_cancelled", objective: "minimize" },
  bad_debt_rate: { numerator: "bad_debt", denominator: "non_cancelled", objective: "minimize" },
  damage_dispute_rate: { numerator: "damage_dispute", denominator: "non_cancelled", objective: "minimize" },
  rerent_rate: { numerator: "rerent", denominator: "non_cancelled", objective: "maximize" },
};

export function knownMetricIds() {
  return Object.keys(METRIC_SPECS);
}

function monthOf(iso) {
  return iso.slice(0, 7); // YYYY-MM，时间分层
}

function exposureOutcomes(exposure, events) {
  // 一个曝光对应一次租赁；事件幂等汇入后在此折叠为布尔/计数结果。
  const result = {
    cancelled: false,
    overdue: false,
    bad_debt: false,
    damage_dispute: false,
    rerent: false,
  };
  for (const event of events) {
    switch (event.type) {
      case "cancel":
        result.cancelled = true;
        break;
      case "overdue":
        result.overdue = true;
        break;
      case "damage_dispute":
        result.damage_dispute = true;
        if (event.payload && event.payload.resolved_with_loss === true) {
          result.bad_debt = true;
        }
        break;
      case "rerent":
        result.rerent = true;
        break;
      case "order":
      default:
        break;
    }
  }
  return result;
}

function metricCell(cohort, eventsByExposure, metricId) {
  const spec = METRIC_SPECS[metricId];
  const scored = cohort.filter((e) =>
    spec.denominator === "all" ? true : !exposureOutcomes(e, eventsByExposure.get(e.exposure_id) ?? []).cancelled,
  );
  let numerator = 0;
  for (const exposure of scored) {
    const outcomes = exposureOutcomes(exposure, eventsByExposure.get(exposure.exposure_id) ?? []);
    if (outcomes[spec.numerator]) numerator += 1;
  }
  return { numerator, denominator: scored.length, cohort_size: cohort.length };
}

function suppressIfBelowPrivacy(cell, k) {
  if (cell.denominator < k) {
    return {
      suppressed: true,
      reason: "privacy_threshold",
      privacy_threshold: k,
      denominator: cell.denominator,
    };
  }
  const interval = wilsonInterval(cell.numerator, cell.denominator);
  return { suppressed: false, ...interval };
}

function armBlock(exposures, eventsByExposure, metricIds, k, includeFlagged) {
  // clean_only 视图必须真实剔除被标记样本，块级计数也以过滤后的队列为准。
  const cohort = exposures.filter((e) => includeFlagged || e.quality_flags.length === 0);
  const metrics = {};
  for (const metricId of metricIds) {
    metrics[metricId] = suppressIfBelowPrivacy(metricCell(cohort, eventsByExposure, metricId), k);
  }
  return { exposures: cohort.length, metrics };
}

function strataBlocks(exposures, eventsByExposure, metricIds, k, includeFlagged) {
  const groups = new Map();
  for (const exposure of exposures) {
    const keys = {
      warehouse: `仓:${exposure.origin.warehouse}`,
      condition_grade: `成色:${exposure.origin.condition_grade}`,
      category: `类别:${exposure.origin.category}`,
      month: `月:${monthOf(exposure.started_at)}`,
    };
    for (const [dimension, key] of Object.entries(keys)) {
      if (!groups.has(dimension)) groups.set(dimension, new Map());
      const byKey = groups.get(dimension);
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(exposure);
    }
  }
  const out = {};
  for (const [dimension, byKey] of groups) {
    out[dimension] = {};
    for (const [key, list] of byKey) {
      const block = armBlock(list, eventsByExposure, metricIds, k, includeFlagged);
      // 分层单元除隐私掩码外，额外标出主指标单元规模，方便阅读不确定性。
      out[dimension][key] = block;
    }
  }
  return out;
}

/**
 * 生成一份不可变报告（纯函数；版本号、触发原因由服务层附加）。
 *
 * @param {object} args
 * @param {object} args.experiment        实验配置
 * @param {Array}  args.exposures         全部曝光（含被标记、含 post_stop）
 * @param {Map}    args.eventsByExposure  exposure_id -> 去重后事件数组
 * @param {object} args.metricDefinition  已发布的指标口径
 * @param {number} args.privacyThreshold  最小单元样本量 k
 * @param {Array}  args.exclusions        资格判定留痕 [{reasons}]
 * @param {Array}  args.quarantinedEvents 未能匹配曝光的迟到/异常事件
 */
export function buildReport({
  experiment,
  exposures,
  eventsByExposure,
  metricDefinition,
  privacyThreshold,
  exclusions,
  quarantinedEvents,
}) {
  const k = privacyThreshold;
  const metricIds = metricDefinition.metrics; // 已发布口径中为指标 id 字符串数组
  const controlArmId = experiment.arms[0].id;
  const inWindow = exposures.filter((e) => !e.post_stop);
  // 原曝光一旦在窗内产生即永久保留；停止后续租只作为续期段计数，不产生新分组。
  const postStopSegments = exposures.reduce(
    (sum, e) => sum + (e.renewal_segments ?? []).filter((segment) => segment.post_stop).length,
    0,
  );

  const byArm = new Map();
  for (const arm of experiment.arms) byArm.set(arm.id, []);
  for (const exposure of inWindow) {
    if (byArm.has(exposure.arm_id)) byArm.get(exposure.arm_id).push(exposure);
  }

  const excludedSummary = {};
  for (const record of exclusions) {
    for (const reason of record.reasons) {
      excludedSummary[reason] = (excludedSummary[reason] ?? 0) + 1;
    }
  }

  const flaggedSummary = {};
  for (const exposure of inWindow) {
    for (const flag of exposure.quality_flags) {
      flaggedSummary[flag] = (flaggedSummary[flag] ?? 0) + 1;
    }
  }

  const arms = {};
  for (const arm of experiment.arms) {
    const list = byArm.get(arm.id);
    arms[arm.id] = {
      name: arm.name,
      primary: armBlock(list, eventsByExposure, metricIds, k, true),
      clean_only: armBlock(list, eventsByExposure, metricIds, k, false),
      strata: strataBlocks(list, eventsByExposure, metricIds, k, true),
    };
  }

  // 处理组相对对照组的主指标差值与不确定性（比较一律用主口径，即保留标记样本）。
  const comparisons = {};
  const controlExposures = byArm.get(controlArmId);
  const controlCell = metricCell(controlExposures, eventsByExposure, metricDefinition.primary_metric);
  for (const arm of experiment.arms) {
    if (arm.id === controlArmId) continue;
    const treatmentCell = metricCell(byArm.get(arm.id), eventsByExposure, metricDefinition.primary_metric);
    if (treatmentCell.denominator < k || controlCell.denominator < k) {
      comparisons[arm.id] = { suppressed: true, reason: "privacy_threshold", privacy_threshold: k };
      continue;
    }
    const diff = newcombeDiff(
      treatmentCell.numerator,
      treatmentCell.denominator,
      controlCell.numerator,
      controlCell.denominator,
    );
    comparisons[arm.id] = { suppressed: false, control_arm: controlArmId, ...diff };
  }

  return {
    experiment_id: experiment.id,
    experiment_name: experiment.name,
    status: experiment.status,
    metric_definition_version: metricDefinition.version,
    metric_definition: {
      primary_metric: metricDefinition.primary_metric,
      objective: METRIC_SPECS[metricDefinition.primary_metric].objective,
      metrics: metricIds,
    },
    privacy_threshold: k,
    cohort: {
      eligible_exposures: inWindow.length,
      excluded: excludedSummary,
      quality_flagged: flaggedSummary,
      post_stop_renewal_segments: postStopSegments,
      note: "quality_flagged 样本保留在主口径中，clean_only 仅为敏感性视图，不得作为主结论。",
    },
    arms,
    comparisons,
    data_quality: {
      quarantined_event_count: quarantinedEvents.length,
      quarantined_events: quarantinedEvents.map((e) => ({
        event_id: e.event_id,
        type: e.type,
        reason: e.quarantine_reason,
      })),
    },
  };
}

/**
 * 给出推广/回滚/继续观察的机器化建议——仅供负责人决策，服务不直接干预单笔租赁。
 * 规则完全确定：看主指标差值的 95% CI 是否跨过 0，并要求所有护栏指标不显著恶化。
 */
export function recommendDecision(report, guardrailMetricIds = []) {
  const objective = report.metric_definition.objective;
  const recommendations = {};
  for (const [armId, comparison] of Object.entries(report.comparisons)) {
    if (comparison.suppressed) {
      recommendations[armId] = { decision: "observe", reasons: ["分组结果低于隐私阈值，无法比较"] };
      continue;
    }
    const { ci_low, ci_high } = comparison;
    const goodDirection = objective === "maximize" ? 1 : -1;
    const significantlyGood = goodDirection === 1 ? ci_low > 0 : ci_high < 0;
    const significantlyBad = goodDirection === 1 ? ci_high < 0 : ci_low > 0;

    const guardrailAlerts = [];
    for (const metricId of guardrailMetricIds) {
      const armMetric = report.arms[armId].primary.metrics[metricId];
      const controlMetric = report.arms[report.comparisons[armId].control_arm].primary.metrics[metricId];
      if (armMetric.suppressed || controlMetric.suppressed) continue;
      const guard = newcombeDiff(
        armMetric.numerator,
        armMetric.denominator,
        controlMetric.numerator,
        controlMetric.denominator,
      );
      // 护栏一律按“越小越好”处理（坏账、逾期、争议）。
      if (guard && guard.ci_low > 0) {
        guardrailAlerts.push({ metric: metricId, diff_ci: [guard.ci_low, guard.ci_high] });
      }
    }

    if (significantlyGood && guardrailAlerts.length === 0) {
      recommendations[armId] = { decision: "promote", reasons: ["主指标区间显著且方向正确，护栏未恶化"] };
    } else if (significantlyBad) {
      recommendations[armId] = { decision: "rollback", reasons: ["主指标区间显著且方向错误"] };
    } else {
      recommendations[armId] = {
        decision: "observe",
        reasons: [
          ci_low <= 0 && ci_high >= 0 ? "主指标差值置信区间跨过 0，功效不足" : "效果幅度未达可判定条件",
          ...guardrailAlerts.map((g) => `护栏指标 ${g.metric} 显著恶化`),
        ],
      };
    }
  }
  return recommendations;
}

// 指标口径注册：分析人员必须先发布带版本的指标口径，实验才能冻结。
// 口径一旦发布即不可变；重算只能引用新版本或沿用已冻结版本，杜绝"边看结果边改定义"。

export class MetricRegistry {
  constructor() {
    this.versions = new Map(); // version -> definition（不可变）
  }

  publish(definition) {
    if (!definition || !definition.version) throw new Error("指标口径必须包含 version");
    if (this.versions.has(definition.version)) {
      throw new Error(`指标口径版本已存在且不可修改: ${definition.version}`);
    }
    const frozen = Object.freeze({
      version: definition.version,
      publishedAt: definition.publishedAt ?? new Date().toISOString(),
      publishedBy: definition.publishedBy ?? "analyst",
      // 每个指标声明：主键、口径说明、方向、是否护栏、是否主指标、实际显著性边际。
      metrics: Object.freeze(Object.fromEntries(
        Object.entries(definition.metrics).map(([key, metric]) => [
          key,
          Object.freeze({
            key,
            description: metric.description ?? key,
            direction: metric.direction ?? "lower_is_better", // lower_is_better | higher_is_better
            guardrail: metric.guardrail === true,
            primary: metric.primary === true,
            practicalMargin: metric.practicalMargin ?? 0,
            ...metric,
          }),
        ]),
      )),
    });
    this.versions.set(frozen.version, frozen);
    return frozen;
  }

  get(version) {
    return this.versions.get(version) ?? null;
  }

  isPublished(version) {
    return this.versions.has(version);
  }
}

// v1 默认口径：以逾期率为主指标（坏账的前置代理），损伤争议与取消为护栏，
// 下单转化与复租为收益侧指标。所有比率均按意向性处理（ITT）：按首次分组归因，取消/争议不剔臂。
export const DEFAULT_METRIC_SPEC_V1 = Object.freeze({
  version: "metric-v1",
  publishedBy: "risk-analytics",
  metrics: {
    order_rate: {
      description: "下单转化率 = 下单事件数 / 入组暴露数（ITT）",
      direction: "higher_is_better",
      practicalMargin: 0.01,
    },
    cancel_rate: {
      description: "取消率 = 取消事件数 / 下单事件数",
      direction: "lower_is_better",
      guardrail: true,
      practicalMargin: 0.01,
    },
    overdue_rate: {
      description: "逾期率 = 逾期事件数 / 下单事件数（坏账前置代理，ITT 归因）",
      direction: "lower_is_better",
      primary: true,
      practicalMargin: 0.02,
    },
    damage_dispute_rate: {
      description: "损伤争议率 = 损伤争议事件数 / 下单事件数（客服豁免单独标记，不静默剔除）",
      direction: "lower_is_better",
      guardrail: true,
      practicalMargin: 0.01,
    },
    re_rent_rate: {
      description: "复租率 = 已结束暴露中出现复租事件的比例",
      direction: "higher_is_better",
      practicalMargin: 0.01,
    },
  },
});

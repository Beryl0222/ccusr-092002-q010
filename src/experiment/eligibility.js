// 资格与合规：只有资产可租且用户满足合规条件时才允许进入随机分组。
// 任何不满足都返回结构化原因码；质量可疑样本（批量账号、客服豁免、验机缺失）
// 单独打标记并保留在筛选记录里，绝不从样本中静默删除。

export const EXCLUSION_REASONS = {
  ASSET_NOT_FOUND: "ASSET_NOT_FOUND",
  ASSET_NOT_RENTABLE: "ASSET_NOT_RENTABLE",
  KYC_NOT_PASSED: "KYC_NOT_PASSED",
  COMPLIANCE_BLOCKED: "COMPLIANCE_BLOCKED",
  ACCOUNT_TOO_NEW: "ACCOUNT_TOO_NEW",
  REGION_UNSUPPORTED: "REGION_UNSUPPORTED",
  SUSPECTED_BATCH_ACCOUNT: "SUSPECTED_BATCH_ACCOUNT",
  EXPERIMENT_NOT_ENROLLING: "EXPERIMENT_NOT_ENROLLING",
  ALREADY_ENROLLED_OTHER_EXPERIMENT: "ALREADY_ENROLLED_OTHER_EXPERIMENT",
  ASSET_IN_PARALLEL_EXPERIMENT: "ASSET_IN_PARALLEL_EXPERIMENT",
  ASSET_ALREADY_ON_RENT: "ASSET_ALREADY_ON_RENT",
  DUPLICATE_ENROLLMENT_REQUEST: "DUPLICATE_ENROLLMENT_REQUEST",
};

export const QUALITY_FLAGS = {
  MISSING_INSPECTION_DATA: "MISSING_INSPECTION_DATA",
  SUSPECTED_BATCH_ACCOUNT: "SUSPECTED_BATCH_ACCOUNT",
  AGENT_EXEMPTION: "AGENT_EXEMPTION",
};

const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_POLICY = Object.freeze({
  minAccountAgeDays: 30,
  supportedRegions: null, // null 表示不限制
  blockedRiskTags: Object.freeze(["fraud", "blocklist", "identity_mismatch"]),
  batchRiskTags: Object.freeze(["batch_registration", "device_farm"]),
});

function isBatchAccount(user, policy) {
  if (user.suspected_batch_account === true) return true;
  const tags = user.risk_tags ?? [];
  return policy.batchRiskTags.some((tag) => tags.includes(tag));
}

// 评估一次下单请求的入组资格。
// user: { user_id, kyc_status, risk_tags, account_opened_at, region, agent_exemptions }
// 返回 { eligible, exclusionReasons, qualityFlags }
export function evaluateEligibility({ user, asset, policy = DEFAULT_POLICY, now = Date.now() }) {
  const exclusionReasons = [];
  const qualityFlags = [];

  // 同时兼容归一化资产（顶层 status/warehouse）与契约原始形状（嵌套 availability）。
  const rawStatus = asset ? (asset.status ?? asset.availability?.status) : undefined;
  if (!asset) {
    exclusionReasons.push(EXCLUSION_REASONS.ASSET_NOT_FOUND);
  } else if (rawStatus !== "inspection_passed") {
    exclusionReasons.push(EXCLUSION_REASONS.ASSET_NOT_RENTABLE);
  }

  if (!user || user.kyc_status !== "passed") {
    exclusionReasons.push(EXCLUSION_REASONS.KYC_NOT_PASSED);
  }

  if (user) {
    const tags = user.risk_tags ?? [];
    if (policy.blockedRiskTags.some((tag) => tags.includes(tag))) {
      exclusionReasons.push(EXCLUSION_REASONS.COMPLIANCE_BLOCKED);
    }
    if (isBatchAccount(user, policy)) {
      // 批量账号不进入实验，但记录被保留、原因可见。
      exclusionReasons.push(EXCLUSION_REASONS.SUSPECTED_BATCH_ACCOUNT);
      qualityFlags.push(QUALITY_FLAGS.SUSPECTED_BATCH_ACCOUNT);
    }
    if (user.account_opened_at) {
      const ageDays = (now - new Date(user.account_opened_at).getTime()) / DAY_MS;
      if (Number.isFinite(ageDays) && ageDays < policy.minAccountAgeDays) {
        exclusionReasons.push(EXCLUSION_REASONS.ACCOUNT_TOO_NEW);
      }
    }
    if (
      policy.supportedRegions &&
      (!user.region || !policy.supportedRegions.includes(user.region))
    ) {
      exclusionReasons.push(EXCLUSION_REASONS.REGION_UNSUPPORTED);
    }
    if (Array.isArray(user.agent_exemptions) && user.agent_exemptions.length > 0) {
      qualityFlags.push(QUALITY_FLAGS.AGENT_EXEMPTION);
    }
  }

  if (asset && asset.inspection == null) {
    // 验机数据缺失：保留样本并打标，供分析做敏感性分层，而不是直接丢弃。
    qualityFlags.push(QUALITY_FLAGS.MISSING_INSPECTION_DATA);
  }

  return {
    eligible: exclusionReasons.length === 0,
    exclusionReasons,
    qualityFlags: [...new Set(qualityFlags)],
  };
}

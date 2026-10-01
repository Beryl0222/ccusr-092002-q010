// 统计工具：二项比例的 Wilson 区间，以及两比例差值（风险差）的 Wald 区间。
// 全部不确定性随报告一起给出，禁止只展示点估计。

export const Z_95 = 1.959963984540054;

export function wilsonInterval(successes, n, { z = Z_95 } = {}) {
  if (n <= 0) return { rate: null, lower: null, upper: null, n: 0, successes: 0 };
  const phat = successes / n;
  const denom = 1 + (z * z) / n;
  const center = (phat + (z * z) / (2 * n)) / denom;
  const spread = (z * Math.sqrt((phat * (1 - phat) + (z * z) / (4 * n)) / n)) / denom;
  return {
    rate: phat,
    lower: Math.max(0, center - spread),
    upper: Math.min(1, center + spread),
    n,
    successes,
  };
}

// 风险差 = p1 - p0（处理组减对照组），返回差值与 95% 区间。
// 采用 Newcombe 混合评分法（Wilson 第 10 版）：在 0/0、100%/100% 等边界情形下
// 仍给出非退化的不确定性，优于 Wald 区间。
export function riskDifference(s1, n1, s0, n0, { z = Z_95 } = {}) {
  if (n1 <= 0 || n0 <= 0) {
    return { diff: null, lower: null, upper: null, p1: null, p0: null };
  }
  const t = wilsonInterval(s1, n1, { z });
  const c = wilsonInterval(s0, n0, { z });
  const diff = t.rate - c.rate;
  const lower = diff - Math.sqrt((t.rate - t.lower) ** 2 + (c.upper - c.rate) ** 2);
  const upper = diff + Math.sqrt((t.upper - t.rate) ** 2 + (c.rate - c.lower) ** 2);
  return { diff, lower: Math.max(-1, lower), upper: Math.min(1, upper), p1: t.rate, p0: c.rate };
}

// 依据指标方向与实际显著性边际判定优劣。
// lower_is_better: diff = 处理 - 对照，显著为负才算优；显著为正为护栏受损。
export function classifyEffect({ lower, upper, direction, margin }) {
  if (lower === null || upper === null) return "inconclusive";
  if (direction === "lower_is_better") {
    if (upper < -margin) return "superior";
    if (lower > margin) return "inferior";
    return "inconclusive";
  }
  // higher_is_better
  if (lower > margin) return "superior";
  if (upper < -margin) return "inferior";
  return "inconclusive";
}

// ISO 周标签（YYYY-Www），用于时间分层；周一为一周起点，UTC 口径。
export function isoWeek(isoString) {
  const date = new Date(isoString);
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = (utc.getUTCDay() + 6) % 7;
  utc.setUTCDate(utc.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(utc.getUTCFullYear(), 0, 4));
  const firstDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
  const week = 1 + Math.round((utc - firstThursday) / (7 * 24 * 60 * 60 * 1000));
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// 样本比例失衡（SRM）检验：实际入组量与策略权重之比是否一致。
// 若显著失衡，说明随机化或互斥环节被污染，任何效果结论都应打问号。
// 返回卡方统计量与 p 值（上侧概率）。
export function srmCheck(observedByArm, weightsByArm) {
  const arms = Object.keys(observedByArm);
  const totalWeight = arms.reduce((sum, arm) => sum + (weightsByArm[arm] ?? 1), 0);
  const totalN = arms.reduce((sum, arm) => sum + observedByArm[arm], 0);
  let chiSquare = 0;
  const expected = {};
  for (const arm of arms) {
    const expectedN = (totalN * (weightsByArm[arm] ?? 1)) / totalWeight;
    expected[arm] = expectedN;
    if (expectedN > 0) chiSquare += ((observedByArm[arm] - expectedN) ** 2) / expectedN;
  }
  const dof = arms.length - 1;
  const pValue = dof === 0 ? 1 : chiSquareSurvival(chiSquare, dof);
  return { observed: observedByArm, expected, chiSquare, dof, pValue, flagged: pValue < 0.001 };
}

// 卡方上侧概率 Q(dof/2, x/2)：正则化上不完全伽马（Numerical Recipes 实现）。
function chiSquareSurvival(stat, dof) {
  return gammaQ(dof / 2, stat / 2);
}

function logGamma(x) {
  const coef = [
    76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155,
    0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const c of coef) {
    y += 1;
    ser += c / y;
  }
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

function gammaSeries(a, x) {
  let A = a;
  let sum = 1 / a;
  let delta = 1 / a;
  for (let n = 0; n < 200; n += 1) {
    A += 1;
    delta *= x / A;
    sum += delta;
    if (Math.abs(delta) < Math.abs(sum) * 1e-12) break;
  }
  return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
}

function gammaCF(a, x) {
  let b = x + 1 - a;
  let c = 1e300;
  let d = 1 / b;
  let h = d;
  for (let n = 1; n <= 200; n += 1) {
    const an = -n * (n - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-12) break;
  }
  return Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
}

function gammaQ(a, x) {
  if (x <= 0 || a <= 0) return 1;
  return x < a + 1 ? 1 - gammaSeries(a, x) : gammaCF(a, x);
}

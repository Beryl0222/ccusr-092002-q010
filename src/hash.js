import { createHash } from "node:crypto";

const TWO_POW_64 = Number(2n ** 64n);

/**
 * 稳定哈希：相同输入在任意进程、任意时间得到相同 [0,1) 取值。
 * 分组绝不能依赖随机数或当天库存，否则同一用户刷新一次就换组。
 */
export function stableUnit(input) {
  const digest = createHash("sha256").update(String(input), "utf8").digest();
  return Number(digest.readBigUInt64BE(0)) / TWO_POW_64;
}

/** 把任意输入稳定映射到 [0, bucketCount) 的整数桶。 */
export function stableBucket(input, bucketCount) {
  if (!Number.isInteger(bucketCount) || bucketCount <= 0) {
    throw new Error("bucketCount 必须为正整数");
  }
  return Math.floor(stableUnit(input) * bucketCount);
}

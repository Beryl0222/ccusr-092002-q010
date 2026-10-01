import http from "node:http";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";

import { AssetRegistry, ExperimentPlatform, DEFAULT_METRIC_SPEC_V1 } from "./experiment/index.js";
import { createExperimentRouter } from "./experiment/http.js";

export const serviceId = "circular-rental";
export const serviceName = "循环租用履约风控";

const DEFAULT_CONTRACT_URL = new URL("../contracts/rental_asset.json", import.meta.url);

export function healthPayload() {
  return { status: "ok", service: serviceId, name: serviceName };
}

// 三种待比较策略：提前预授权 / 分层保障计划 / 按时归还奖励（后者作为对照基准）。
export const STRATEGY_EXPERIMENT = Object.freeze({
  id: "rental-strategy-2026q4",
  name: "免押租赁策略对比（提前预授权 / 分层保障 / 按时归还奖励）",
  salt: "rental-strategy-2026q4",
  arms: [
    { id: "pre_authorization", name: "提前预授权", weight: 1 },
    { id: "tiered_protection", name: "分层保障计划", weight: 1 },
    { id: "on_time_reward", name: "按时归还奖励", weight: 1 },
  ],
});

export async function loadAssets(contractUrl = DEFAULT_CONTRACT_URL) {
  const raw = await readFile(contractUrl, "utf8");
  return AssetRegistry.fromContract(JSON.parse(raw));
}

export async function createPlatform({ assets = null, publishDefaultMetrics = true } = {}) {
  const registry = assets ?? (await loadAssets());
  const platform = new ExperimentPlatform({ assets: registry });
  if (publishDefaultMetrics) platform.publishMetricDefinition(DEFAULT_METRIC_SPEC_V1);
  return platform;
}

export async function createServer({ platform = null } = {}) {
  const activePlatform = platform ?? (await createPlatform());
  const routeExperiment = createExperimentRouter(activePlatform);

  return http.createServer(async (request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(healthPayload()));
      return;
    }
    await routeExperiment(request, response);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--check")) {
    if (healthPayload().service !== serviceId) process.exit(1);
    const registry = await loadAssets();
    if (registry.list().length === 0) {
      console.error("基础检查失败：未读到任何资产");
      process.exit(1);
    }
    console.log(`基础检查通过（已载入 ${registry.list().length} 项资产）`);
  } else {
    const portIndex = process.argv.indexOf("--port");
    const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 8000;
    const server = await createServer();
    server.listen(port, "0.0.0.0");
    console.log(`${serviceName} 实验服务监听 :${port}`);
  }
}

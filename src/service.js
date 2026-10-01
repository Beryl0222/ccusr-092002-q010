import http from "node:http";
import { pathToFileURL } from "node:url";

import { createExperimentServer } from "./api.js";
import { Catalog } from "./catalog.js";
import { ExperimentService } from "./experiment.js";

export const serviceId = "circular-rental";
export const serviceName = "循环租用履约风控";

export function healthPayload() {
  return { status: "ok", service: serviceId, name: serviceName };
}

/**
 * 兼容旧入口：只含 /health 的最小服务器。
 */
export function createServer() {
  return http.createServer((request, response) => {
    if (request.url !== "/health") {
      response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "未找到资源" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(healthPayload()));
  });
}

/**
 * 完整服务：从 rental_asset.json 加载资产目录，挂载租赁策略实验 API。
 * 状态保存在内存中——进程内即实验台；生产部署可在 ExperimentService.state 后接持久化适配器。
 */
export async function createAppServer({ catalog } = {}) {
  const loadedCatalog = catalog ?? (await Catalog.load());
  const experimentService = new ExperimentService(loadedCatalog);
  return createExperimentServer(experimentService);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--check")) {
    if (healthPayload().service !== serviceId) process.exit(1);
    // 同时自检资产目录可加载，避免实验服务带着坏契约启动。
    const catalog = await Catalog.load();
    if (catalog.assets.size === 0) {
      console.error("资产目录为空");
      process.exit(1);
    }
    console.log(`基础检查通过（资产目录 ${catalog.assets.size} 台设备）`);
  } else {
    const portIndex = process.argv.indexOf("--port");
    const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 8000;
    const server = await createAppServer();
    server.listen(port, "0.0.0.0", () => {
      console.log(`${serviceName} · 租赁策略实验服务监听 :${port}`);
    });
  }
}

// 实验服务 HTTP 适配层：把路由与 JSON 编解码同领域逻辑隔离。
// 角色通过 ?role= 提供（ops 触发隐私抑制）；生产环境应替换为鉴权中间件。

import { ALL_EVENT_TYPES } from "./events.js";

function send(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_048_576) {
        reject(new Error("请求体过大"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("请求体不是合法 JSON"));
      }
    });
    request.on("error", reject);
  });
}

const json = (handler) => async (request, response, params) => {
  let body = {};
  try {
    body = await readBody(request);
  } catch (error) {
    send(response, 400, { error: error.message });
    return;
  }
  try {
    const result = await handler(body, params, request, response);
    if (!response.writableEnded) send(response, result?.status ?? 200, result?.body ?? result ?? { ok: true });
  } catch (error) {
    send(response, error.statusCode ?? 422, { error: error.message });
  }
};

// method + 简单路径模式 -> handler。
export function createExperimentRouter(platform) {
  const routes = [
    ["GET", /^\/assets$/, () => ({
      body: { assets: platform.registry.list() },
    })],

    ["POST", /^\/experiments$/, json((body) => {
      const experiment = platform.createExperiment(body);
      return { status: 201, body: { id: experiment.id, status: experiment.status, arms: experiment.arms } };
    })],

    ["POST", /^\/experiments\/([^/]+)\/enroll$/, json((body, [experimentId]) => {
      const result = platform.attemptEnrollment({
        experimentId,
        user: body.user,
        assetId: body.asset_id,
        now: body.at,
      });
      return { status: result.admitted ? 200 : 409, body: result };
    })],

    ["POST", /^\/experiments\/([^/]+)\/stop$/, json((body, [experimentId]) => {
      const status = platform.stopExperiment(experimentId, body.at);
      return { body: { id: experimentId, status } };
    })],

    ["POST", /^\/metrics$/, json((body) => {
      const definition = platform.publishMetricDefinition(body);
      return { status: 201, body: { version: definition.version, publishedAt: definition.publishedAt } };
    })],

    ["POST", /^\/experiments\/([^/]+)\/freeze$/, json((body, [experimentId]) => {
      const status = platform.freezeExperiment(experimentId, body.metric_version, body.at);
      return { body: { id: experimentId, status, frozenMetricVersion: body.metric_version } };
    })],

    ["POST", /^\/events$/, json((body) => {
      const events = Array.isArray(body.events) ? body.events : [body];
      if (events.some((event) => !ALL_EVENT_TYPES.includes(event.type))) {
        throw new Error(`事件类型必须是: ${ALL_EVENT_TYPES.join(", ")}`);
      }
      const results = events.map((event) => platform.ingestEvent(event));
      return { status: 202, body: { results } };
    })],

    ["POST", /^\/exposures\/([^/]+)\/renew$/, json((body, [exposureId]) => {
      const exposure = platform.renew(exposureId, { at: body.at });
      if (!exposure) throw Object.assign(new Error("暴露区间不存在"), { statusCode: 404 });
      return { body: { exposureId, renewals: exposure.renewals, arm: exposure.arm } };
    })],

    ["POST", /^\/exposures\/([^/]+)\/transfer$/, json((body, [exposureId]) => {
      if (!body.warehouse) throw new Error("调拨必须指定 warehouse");
      const exposure = platform.transfer(exposureId, body.warehouse, { at: body.at });
      if (!exposure) throw Object.assign(new Error("暴露区间不存在"), { statusCode: 404 });
      return { body: { exposureId, warehouseTimeline: exposure.warehouseTimeline, arm: exposure.arm } };
    })],

    ["POST", /^\/exposures\/([^/]+)\/close$/, json((body, [exposureId]) => {
      const exposure = platform.store.closeExposure(exposureId, { at: body.at, reason: body.reason });
      if (!exposure) throw Object.assign(new Error("暴露区间不存在"), { statusCode: 404 });
      return { body: { exposureId, status: exposure.status, endedAt: exposure.endedAt, arm: exposure.arm } };
    })],

    ["POST", /^\/experiments\/([^/]+)\/reports$/, json((body, [experimentId]) => {
      const role = body.role ?? "analyst";
      if (!["analyst", "ops"].includes(role)) throw new Error("角色必须是 analyst 或 ops");
      const report = platform.generateReport(experimentId, {
        cutoff: body.cutoff,
        holidayRanges: body.holiday_ranges,
        controlArm: body.control_arm,
        role,
      });
      return { status: 201, body: report };
    })],

    ["GET", /^\/experiments\/([^/]+)\/reports$/, (_request, _response, [experimentId], url) => {
      const role = url.searchParams.get("role") === "ops" ? "ops" : "analyst";
      if (role === "ops") {
        const latest = platform.viewReport(experimentId, "ops");
        return latest ? { body: { reports: [latest] } } : { status: 404, body: { error: "尚无报告" } };
      }
      const reports = platform.listReports(experimentId);
      return { body: { reports } };
    }],
  ];

  return async function route(request, response) {
    const url = new URL(request.url, "http://localhost");
    for (const [method, pattern, handler] of routes) {
      if (request.method !== method) continue;
      const match = url.pathname.match(pattern);
      if (!match) continue;
      const outcome = await handler(request, response, match.slice(1), url);
      if (!response.writableEnded) {
        send(response, outcome?.status ?? 200, outcome?.body ?? outcome ?? { ok: true });
      }
      return;
    }
    send(response, 404, { error: "未找到资源" });
  };
}

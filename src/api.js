import http from "node:http";

import { DomainError } from "./experiment.js";

const STATUS_BY_CODE = {
  invalid_request: 400,
  invalid_config: 400,
  invalid_allocation: 400,
  unknown_event_type: 400,
  invalid_metric_definition: 400,
  warehouse_not_found: 400,
  experiment_exists: 409,
  metric_version_exists: 409,
  experiment_frozen: 409,
  renewal_user_mismatch: 409,
  renewal_asset_mismatch: 409,
  experiment_not_found: 404,
  asset_not_found: 404,
  report_not_found: 404,
  exposure_not_found: 404,
  report_not_published: 403,
  forbidden: 403,
};

function send(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function sendError(response, error) {
  if (error instanceof DomainError) {
    const status = STATUS_BY_CODE[error.code] ?? 500;
    send(response, status, { error: error.message, code: error.code, details: error.details });
    return;
  }
  send(response, 500, { error: "服务内部错误", code: "internal_error" });
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new DomainError("invalid_request", "请求体不是合法 JSON");
  }
}

function roleOf(request, url) {
  return request.headers["x-role"] || url.searchParams.get("role") || "operator";
}

function requireAnalyst(request, url) {
  if (roleOf(request, url) !== "analyst") {
    throw new DomainError("forbidden", "该操作仅分析人员可执行");
  }
}

/**
 * 实验服务 HTTP 路由。
 * 角色：analyst（分析人员：配置/口径/冻结/完整报告）、operator（运营：只读掩码报告）；
 * 分组与事件汇入为系统对接接口，不区分角色。
 */
export function createExperimentServer(service) {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const path = url.pathname;
    try {
      if (request.method === "GET" && path === "/health") {
        send(response, 200, {
          status: "ok",
          service: "circular-rental",
          name: "循环租用履约风控",
          component: "rental-strategy-experiment",
        });
        return;
      }

      // ---------- 实验配置 ----------
      if (request.method === "POST" && path === "/v1/experiments") {
        requireAnalyst(request, url);
        const body = await readJson(request);
        send(response, 201, service.createExperiment(body));
        return;
      }
      if (request.method === "GET" && path === "/v1/experiments") {
        send(response, 200, { experiments: service.listExperiments() });
        return;
      }

      const expMatch = path.match(/^\/v1\/experiments\/([^/]+)(?:\/(.+))?$/);
      if (expMatch) {
        const experimentId = decodeURIComponent(expMatch[1]);
        const sub = expMatch[2] ?? "";

        if (request.method === "GET" && sub === "") {
          send(response, 200, service.publicExperiment(service.getExperiment(experimentId)));
          return;
        }
        if (request.method === "POST" && sub === "stop") {
          requireAnalyst(request, url);
          const body = await readJson(request);
          send(response, 200, service.stopExperiment(experimentId, body.at));
          return;
        }
        if (request.method === "POST" && sub === "freeze") {
          requireAnalyst(request, url);
          send(response, 200, service.freezeExperiment(experimentId));
          return;
        }
        if (request.method === "POST" && sub === "assignments") {
          const body = await readJson(request);
          const result = service.assign({ experiment_id: experimentId, ...body });
          send(response, result.eligible ? 200 : 422, result);
          return;
        }
        if (request.method === "POST" && sub === "metrics/definitions") {
          requireAnalyst(request, url);
          const body = await readJson(request);
          send(response, 201, service.publishMetricDefinition({ experiment_id: experimentId, ...body }));
          return;
        }
        if (request.method === "POST" && sub === "reports/recompute") {
          requireAnalyst(request, url);
          const body = await readJson(request);
          send(response, 201, service.recompute(experimentId, { trigger: body.trigger ?? "manual" }));
          return;
        }
        if (request.method === "GET" && sub === "reports") {
          send(response, 200, { reports: service.listReports(experimentId) });
          return;
        }
        if (request.method === "GET" && /^reports\/(latest|versions\/\d+)$/.test(sub)) {
          const version = sub.startsWith("reports/latest")
            ? null
            : Number(sub.slice("reports/versions/".length));
          send(
            response,
            200,
            service.viewReport(experimentId, { role: roleOf(request, url), version }),
          );
          return;
        }
        if (request.method === "GET" && sub === "exposures") {
          requireAnalyst(request, url);
          send(response, 200, { exposures: service.listExposures(experimentId) });
          return;
        }
        if (request.method === "GET" && sub === "eligibility-trail") {
          requireAnalyst(request, url);
          send(response, 200, { trail: service.eligibilityTrail(experimentId) });
          return;
        }
      }

      // ---------- 事件（支持批量，逐条返回结果） ----------
      if (request.method === "POST" && path === "/v1/events") {
        const body = await readJson(request);
        const isBatch = Array.isArray(body.events);
        const events = isBatch ? body.events : [body];
        const results = events.map((event) => {
          try {
            return service.ingestEvent(event, { receivedAt: body.received_at });
          } catch (error) {
            if (error instanceof DomainError) {
              return { accepted: false, error: error.message, code: error.code, event_id: event?.event_id ?? null };
            }
            throw error;
          }
        });
        send(response, 200, isBatch ? { results } : results[0]);
        return;
      }

      // ---------- 跨仓调拨 ----------
      const transferMatch = path.match(/^\/v1\/assets\/([^/]+)\/transfers$/);
      if (request.method === "POST" && transferMatch) {
        const body = await readJson(request);
        send(
          response,
          201,
          service.recordTransfer({ asset_id: decodeURIComponent(transferMatch[1]), ...body }),
        );
        return;
      }

      send(response, 404, { error: "未找到资源", code: "not_found" });
    } catch (error) {
      sendError(response, error);
    }
  });
}

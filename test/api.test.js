import assert from "node:assert/strict";
import test from "node:test";

import { createExperimentServer } from "../src/api.js";
import { Catalog } from "../src/catalog.js";
import { ExperimentService } from "../src/experiment.js";

async function startServer() {
  const catalog = await Catalog.load();
  const service = new ExperimentService(catalog);
  const server = createExperimentServer(service);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const request = async (method, path, body, headers = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await response.json().catch(() => ({}));
    return { status: response.status, json };
  };
  return { server, request, service };
}

test("HTTP：健康检查含实验组件标识", async () => {
  const { server, request } = await startServer();
  try {
    const { status, json } = await request("GET", "/health");
    assert.equal(status, 200);
    assert.equal(json.component, "rental-strategy-experiment");
  } finally {
    server.close();
  }
});

test("HTTP：角色控制——运营不能建实验/冻结，分析师可以走完整流程", async () => {
  const { server, request } = await startServer();
  try {
    const config = {
      id: "exp_preauth",
      name: "提前预授权",
      mutex_group: "rental_strategy",
      arms: [
        { id: "control", name: "对照", allocation: [0, 500] },
        { id: "preauth", name: "提前预授权", allocation: [500, 1000] },
      ],
      starts_at: "2026-09-01T00:00:00+08:00",
    };
    let res = await request("POST", "/v1/experiments", config);
    assert.equal(res.status, 403);

    res = await request("POST", "/v1/experiments", config, { "x-role": "analyst" });
    assert.equal(res.status, 201);

    // 分组
    res = await request("POST", "/v1/experiments/exp_preauth/assignments", {
      user: { user_id: "u1", compliance: { identity_verified: true, credit_score: 720 } },
      asset_id: "CAM-R50-0018",
      rental_id: "r-1",
      at: "2026-09-10T10:00:00+08:00",
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.eligible, true);

    // 不合格 422
    res = await request("POST", "/v1/experiments/exp_preauth/assignments", {
      user: { user_id: "u2", compliance: { identity_verified: false, credit_score: 720 } },
      asset_id: "CAM-R50-0018",
      rental_id: "r-2",
      at: "2026-09-10T10:00:00+08:00",
    });
    assert.equal(res.status, 422);
    assert.ok(res.json.reasons.includes("identity_unverified"));

    // 批量事件幂等
    res = await request("POST", "/v1/events", {
      events: [
        { event_id: "e1", type: "order", rental_id: "r-1", occurred_at: "2026-09-10T11:00:00+08:00" },
        { event_id: "e1", type: "order", rental_id: "r-1", occurred_at: "2026-09-10T11:00:00+08:00" },
      ],
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.results[0].duplicate, false);
    assert.equal(res.json.results[1].duplicate, true);

    // 冻结前运营与分析师都看不到已发布报告（运营 403）
    res = await request("POST", "/v1/experiments/exp_preauth/metrics/definitions", {
      primary_metric: "overdue_rate",
      metrics: ["overdue_rate", "bad_debt_rate"],
      privacy_threshold: 1,
    }, { "x-role": "analyst" });
    assert.equal(res.status, 201);

    res = await request("POST", "/v1/experiments/exp_preauth/reports/recompute", {}, { "x-role": "analyst" });
    assert.equal(res.status, 201);

    res = await request("GET", "/v1/experiments/exp_preauth/reports/latest");
    assert.equal(res.status, 403);

    // 冻结后运营可见
    res = await request("POST", "/v1/experiments/exp_preauth/freeze", {}, { "x-role": "analyst" });
    assert.equal(res.status, 200);
    res = await request("GET", "/v1/experiments/exp_preauth/reports/latest");
    assert.equal(res.status, 200);
    assert.equal(res.json.arms.preauth.name, "提前预授权");
    assert.equal(res.json.clean_only, undefined, "运营视图是裁剪版");

    // 冻结是幂等的
    res = await request("POST", "/v1/experiments/exp_preauth/freeze", {}, { "x-role": "analyst" });
    assert.equal(res.status, 200);
  } finally {
    server.close();
  }
});

test("HTTP：未知路由 404，坏 JSON 400", async () => {
  const { server, request } = await startServer();
  try {
    const notFound = await request("GET", "/v1/nope");
    assert.equal(notFound.status, 404);

    const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

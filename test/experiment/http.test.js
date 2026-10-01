import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";

import { healthPayload, serviceId, createPlatform } from "../../src/service.js";
import { createExperimentRouter } from "../../src/experiment/http.js";

async function startClient(platform) {
  const server = createServer(createExperimentRouter(platform));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  async function request(method, path, body) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }
  async function raw(method, path, text) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: text,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }
  return { request, raw, base, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function seededClient() {
  const platform = await createPlatform();
  platform.createExperiment({
    id: "http-demo",
    salt: "http-demo",
    arms: [{ id: "on_time_reward" }, { id: "pre_authorization" }, { id: "tiered_protection" }],
  });
  return startClient(platform);
}

test("健康检查身份稳定", () => {
  assert.equal(healthPayload().service, serviceId);
});

test("GET /assets 返回契约资产且嵌套 availability 正确解析", async () => {
  const client = await seededClient();
  try {
    const res = await client.request("GET", "/assets");
    assert.equal(res.status, 200);
    assert.ok(res.body.assets.length >= 9);
    assert.equal(res.body.assets[0].warehouse, "SH-02");
    assert.equal(res.body.assets[0].status, "inspection_passed");
  } finally {
    await client.close();
  }
});

test("入组成功与失败分别返回 200/409", async () => {
  const client = await seededClient();
  try {
    const ok = await client.request("POST", "/experiments/http-demo/enroll", {
      user: { user_id: "http-u1", kyc_status: "passed", account_opened_at: "2020-01-01" },
      asset_id: "CAM-R50-0018",
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.admitted, true);
    const bad = await client.request("POST", "/experiments/http-demo/enroll", {
      user: { user_id: "http-u2", kyc_status: "no" },
      asset_id: "CAM-R50-0018",
    });
    assert.equal(bad.status, 409);
    assert.equal(bad.body.admitted, false);
  } finally {
    await client.close();
  }
});

test("事件汇入 202 且重复提交幂等", async () => {
  const client = await seededClient();
  try {
    const enroll = await client.request("POST", "/experiments/http-demo/enroll", {
      user: { user_id: "http-u3", kyc_status: "passed", account_opened_at: "2020-01-01" },
      asset_id: "DRN-AV2-0031",
    });
    const event = {
      type: "order_placed",
      event_id: "evt-1",
      exposure_id: enroll.body.exposureId,
      occurred_at: "2026-09-15T00:00:00Z",
    };
    const first = await client.request("POST", "/events", event);
    assert.equal(first.status, 202);
    assert.equal(first.body.results[0].status, "accepted");
    const again = await client.request("POST", "/events", event);
    assert.equal(again.body.results[0].status, "duplicate");
  } finally {
    await client.close();
  }
});

test("ops 角色出报告，未知路由 404，非法 JSON 返回 400", async () => {
  const client = await seededClient();
  try {
    const res = await client.request("POST", "/experiments/http-demo/reports", {
      control_arm: "on_time_reward",
      role: "ops",
    });
    assert.equal(res.status, 201);
    assert.ok(Array.isArray(res.body.strata));
    const missing = await client.request("GET", "/nope");
    assert.equal(missing.status, 404);
    const badJson = await client.raw("POST", "/experiments/http-demo/enroll", "{not json");
    assert.equal(badJson.status, 400);
  } finally {
    await client.close();
  }
});

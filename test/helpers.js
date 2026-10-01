import { Catalog } from "../src/catalog.js";
import { ExperimentService } from "../src/experiment.js";

export async function makeService() {
  const catalog = await Catalog.load();
  return new ExperimentService(catalog);
}

export const TWO_ARMS = [
  { id: "control", name: "对照", allocation: [0, 500] },
  { id: "treat", name: "策略", allocation: [500, 1000] },
];

export const THREE_ARMS = [
  { id: "control", name: "对照", allocation: [0, 340] },
  { id: "preauth", name: "提前预授权", allocation: [340, 670] },
  { id: "reward", name: "按时归还奖励", allocation: [670, 1000] },
];

export function user(id, overrides = {}) {
  return {
    user_id: id,
    compliance: { identity_verified: true, credit_status: "ok", credit_score: 720, ...overrides },
  };
}

export const T0 = "2026-09-10T10:00:00+08:00";

export function createStandardExperiment(service, { id = "e1", name = "提前预授权", arms = TWO_ARMS } = {}) {
  return service.createExperiment({
    id,
    name,
    mutex_group: "rental_strategy",
    arms,
    starts_at: "2026-09-01T00:00:00+08:00",
  });
}

export function metricDefinition(experimentId = "e1", overrides = {}) {
  return {
    experiment_id: experimentId,
    primary_metric: "overdue_rate",
    metrics: ["cancel_rate", "overdue_rate", "bad_debt_rate", "damage_dispute_rate", "rerent_rate"],
    guardrails: ["bad_debt_rate", "damage_dispute_rate"],
    privacy_threshold: 5,
    ...overrides,
  };
}

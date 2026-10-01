// 结果事件汇入：下单、取消、逾期、损伤争议、复租。
// 全部事件按 (事件类型, 事件编号) 幂等去重，重复上报不会重复计数；
// 允许迟到（事件时间早于已处理时间），迟到数据由报告层触发版本化重算，绝不就地覆盖旧报告。

export const RESULT_EVENTS = Object.freeze({
  ORDER_PLACED: "order_placed",
  ORDER_CANCELLED: "order_cancelled",
  OVERDUE: "overdue",
  DAMAGE_DISPUTE: "damage_dispute",
  RE_RENT: "re_rent",
});

export const ALL_EVENT_TYPES = Object.freeze(Object.values(RESULT_EVENTS));

export class EventLog {
  constructor() {
    this.events = new Map(); // `${type}:${eventId}` -> event
    this.ordered = []; // 按接受顺序保存，携带单调摄入序号
    this.seq = 0;
  }

  static key(type, eventId) {
    return `${type}:${eventId}`;
  }

  // 返回 { status: "accepted"|"duplicate", event }
  ingest(raw, { ingestedAt = new Date().toISOString() } = {}) {
    const event = normalizeEvent(raw, ingestedAt);
    const key = EventLog.key(event.type, event.event_id);
    const existing = this.events.get(key);
    if (existing) {
      return { status: "duplicate", event: existing };
    }
    this.seq += 1;
    const stored = { ...event, ingestSeq: this.seq };
    this.events.set(key, stored);
    this.ordered.push(stored);
    return { status: "accepted", event: stored };
  }

  get(type, eventId) {
    return this.events.get(EventLog.key(type, eventId)) ?? null;
  }

  // 数据时间早于给定水位即迟到事件。
  listLate(watermark) {
    return [...this.events.values()].filter((e) => e.occurredAt < watermark);
  }

  listByExposure(exposureId) {
    return [...this.events.values()]
      .filter((e) => e.exposureId === exposureId)
      .sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : 1));
  }

  listByExperiment(exposureIds) {
    const wanted = new Set(exposureIds);
    return [...this.events.values()].filter((e) => wanted.has(e.exposureId));
  }

  size() {
    return this.events.size;
  }
}

function normalizeEvent(raw, ingestedAt) {
  if (!raw || !raw.type || !raw.event_id) {
    throw new Error("事件必须包含 type 与 event_id");
  }
  if (!ALL_EVENT_TYPES.includes(raw.type)) {
    throw new Error(`未知结果事件类型: ${raw.type}`);
  }
  if (!raw.occurred_at) throw new Error("事件必须包含 occurred_at");
  const occurredAt = new Date(raw.occurred_at).toISOString(); // 非法日期直接抛错
  return {
    type: raw.type,
    event_id: String(raw.event_id),
    exposureId: raw.exposure_id ?? null,
    orderId: raw.order_id ?? null,
    userId: raw.user_id ?? null,
    assetId: raw.asset_id ?? null,
    occurredAt,
    ingestedAt: new Date(ingestedAt).toISOString(),
    ingestedAsLate: raw.ingested_as_late === true,
    payload: sanitizePayload(raw.type, raw.payload ?? {}),
  };
}

// 只保留分析需要的字段，避免自由文本 PII 进入分析存储。
const PAYLOAD_FIELDS = {
  order_placed: ["amount", "term_days", "warehouse", "channel"],
  order_cancelled: ["reason", "amount_refunded", "cancel_stage"],
  overdue: ["days_overdue", "amount_outstanding", "resolved"],
  damage_dispute: ["damage_category", "claimed_amount", "resolution", "agent_waived"],
  re_rent: ["days_since_return", "term_days", "warehouse"],
};

function sanitizePayload(type, payload) {
  const allowed = PAYLOAD_FIELDS[type] ?? [];
  const out = {};
  for (const field of allowed) {
    if (payload[field] !== undefined) out[field] = payload[field];
  }
  return out;
}

import { createHmac, timingSafeEqual } from "node:crypto";
import { parseHspSignatureHeader } from "@kohaku/core/hsp-node";
import type { Db } from "../db.ts";

export const WEBHOOK_TOLERANCE_SECONDS = 300;

export interface WebhookEvent {
  id: string;
  status: string;
  cartMandateId?: string;
  paymentRequestId?: string;
  txHash?: string;
}

export type WebhookResult = { ok: true; duplicate: boolean; event: WebhookEvent } | { ok: false; status: 400 | 401; reason: string };

/**
 * HSP webhook intake, in HashKey Merchant's format: `X-Signature: t=<unix>,v1=<hex>` where
 * v1 = HMAC-SHA256(app secret, `${t}.${rawBody}`). Authenticated, fresh (within five
 * minutes) and processed exactly once (event ids are recorded before anything acts on
 * them; a replay is acknowledged and ignored). The webhook only *triggers* verification:
 * the settlement is still checked against HSP's status endpoint and the chain.
 */
export function acceptWebhook(
  db: Db,
  secret: string,
  headers: Record<string, string | string[] | undefined>,
  rawBody: string,
  now = Date.now(),
): WebhookResult {
  const parsed = parseHspSignatureHeader(String(headers["x-signature"] ?? ""));
  if (!parsed || !/^\d+$/.test(parsed.ts) || !/^[0-9a-f]{64}$/i.test(parsed.v1)) return { ok: false, status: 401, reason: "missing or malformed X-Signature" };
  const expected = createHmac("sha256", secret).update(`${parsed.ts}.${rawBody}`).digest();
  const given = Buffer.from(parsed.v1, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, status: 401, reason: "bad signature" };
  if (Math.abs(now / 1000 - Number(parsed.ts)) > WEBHOOK_TOLERANCE_SECONDS) return { ok: false, status: 401, reason: "stale webhook" };

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return { ok: false, status: 400, reason: "body is not JSON" };
  }
  const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : undefined);
  const status = str("status");
  if (!status || (!str("cart_mandate_id") && !str("payment_request_id"))) return { ok: false, status: 400, reason: "status and an order id are required" };
  const id = str("request_id") ?? str("event_id") ?? `${str("payment_request_id") ?? str("cart_mandate_id")}:${status}`;

  const inserted = db.run(
    "INSERT INTO webhook_events(id, received_at, type, payload) VALUES (?,?,?,?) ON CONFLICT(id) DO NOTHING",
    id,
    now,
    status,
    rawBody,
  );
  return {
    ok: true,
    duplicate: Number(inserted.changes) === 0,
    event: { id, status, cartMandateId: str("cart_mandate_id"), paymentRequestId: str("payment_request_id"), txHash: str("tx_signature") },
  };
}

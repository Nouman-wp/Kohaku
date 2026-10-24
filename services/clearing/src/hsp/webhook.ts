import { createHmac, timingSafeEqual } from "node:crypto";
import type { Db } from "../db.ts";

export const WEBHOOK_TOLERANCE_SECONDS = 300;

export type WebhookResult =
  | { ok: true; duplicate: boolean; event: { id: string; type: string; paymentId?: string; txHash?: string; status?: string } }
  | { ok: false; status: 400 | 401; reason: string };

/**
 * HSP webhook intake: authenticated (HMAC-SHA256 over `${timestamp}.${rawBody}`), fresh
 * (timestamp within 5 minutes) and processed exactly once (event ids are recorded before
 * anything acts on them; a replay is acknowledged and ignored).
 */
export function acceptWebhook(
  db: Db,
  secret: string,
  headers: Record<string, string | string[] | undefined>,
  rawBody: string,
  now = Date.now(),
): WebhookResult {
  const ts = String(headers["x-hsp-timestamp"] ?? "");
  const sig = String(headers["x-hsp-signature"] ?? "");
  if (!/^\d+$/.test(ts) || !/^[0-9a-f]{64}$/i.test(sig)) return { ok: false, status: 401, reason: "missing or malformed signature headers" };
  const expected = createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest();
  const given = Buffer.from(sig, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, status: 401, reason: "bad signature" };
  if (Math.abs(now / 1000 - Number(ts)) > WEBHOOK_TOLERANCE_SECONDS) return { ok: false, status: 401, reason: "stale webhook" };

  let event: { id?: unknown; type?: unknown; paymentId?: unknown; txHash?: unknown; status?: unknown };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return { ok: false, status: 400, reason: "body is not JSON" };
  }
  if (typeof event.id !== "string" || typeof event.type !== "string") return { ok: false, status: 400, reason: "event id and type are required" };

  const inserted = db.run(
    "INSERT INTO webhook_events(id, received_at, type, payload) VALUES (?,?,?,?) ON CONFLICT(id) DO NOTHING",
    event.id,
    now,
    event.type,
    rawBody,
  );
  return {
    ok: true,
    duplicate: Number(inserted.changes) === 0,
    event: {
      id: event.id,
      type: event.type,
      paymentId: typeof event.paymentId === "string" ? event.paymentId : undefined,
      txHash: typeof event.txHash === "string" ? event.txHash : undefined,
      status: typeof event.status === "string" ? event.status : undefined,
    },
  };
}

export function signWebhook(secret: string, rawBody: string, ts = Math.floor(Date.now() / 1000)): { ts: string; sig: string } {
  return { ts: String(ts), sig: createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex") };
}

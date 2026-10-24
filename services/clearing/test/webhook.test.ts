import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Db } from "../src/db.ts";
import { acceptWebhook, signWebhook } from "../src/hsp/webhook.ts";

const SECRET = "test-secret-0123456789";

function fresh() {
  return new Db(mkdtempSync(join(tmpdir(), "kohaku-wh-")));
}

function headers(body: string, ts?: number, secret = SECRET) {
  const s = signWebhook(secret, body, ts);
  return { "x-hsp-timestamp": s.ts, "x-hsp-signature": s.sig };
}

describe("HSP webhooks", () => {
  const body = JSON.stringify({ id: "evt_1", type: "payment.settled", paymentId: "0xabc", status: "SETTLED" });

  it("accepts an authentic, fresh webhook once", () => {
    const db = fresh();
    const first = acceptWebhook(db, SECRET, headers(body), body);
    expect(first.ok && !first.duplicate).toBe(true);
    const replay = acceptWebhook(db, SECRET, headers(body), body);
    expect(replay.ok && replay.duplicate).toBe(true);
  });

  it("rejects a forged signature", () => {
    const r = acceptWebhook(fresh(), SECRET, headers(body, undefined, "attacker-secret-xxxx"), body);
    expect(r.ok).toBe(false);
  });

  it("rejects a tampered body", () => {
    const h = headers(body);
    const r = acceptWebhook(fresh(), SECRET, h, body.replace("SETTLED", "FAILED"));
    expect(r.ok).toBe(false);
  });

  it("rejects a stale webhook", () => {
    const old = Math.floor(Date.now() / 1000) - 3600;
    const r = acceptWebhook(fresh(), SECRET, headers(body, old), body);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/stale/);
  });

  it("rejects missing headers", () => {
    const r = acceptWebhook(fresh(), SECRET, {}, body);
    expect(r.ok).toBe(false);
  });
});

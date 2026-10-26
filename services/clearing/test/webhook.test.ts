import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { signHspWebhook } from "@kohaku/core/hsp-node";
import { Db } from "../src/db.ts";
import { acceptWebhook } from "../src/hsp/webhook.ts";

const SECRET = "test-secret-0123456789";

function fresh() {
  return new Db(mkdtempSync(join(tmpdir(), "kohaku-wh-")));
}

function headers(body: string, ts?: number, secret = SECRET) {
  return { "x-signature": signHspWebhook(secret, body, ts) };
}

describe("HSP webhooks (HashKey Merchant format)", () => {
  // the fields of HashKey's webhook sample that Kohaku reads
  const payload = {
    event_type: "payment",
    payment_request_id: "PAY-REQ-01",
    request_id: "20261025010203000007",
    cart_mandate_id: "KOHAKU-133-abcd1234-E7-A3",
    amount: "0.0172",
    order_amount: "0.0172",
    token: "USDC",
    chain: "eip155:133",
    network: "hashkey-testnet",
    status: "payment-safe",
    tx_signature: "0x" + "ab".repeat(32),
  };
  const body = JSON.stringify(payload);

  it("accepts an authentic, fresh webhook once", () => {
    const db = fresh();
    const first = acceptWebhook(db, SECRET, headers(body), body);
    expect(first.ok && !first.duplicate).toBe(true);
    if (first.ok) expect(first.event.cartMandateId).toBe("KOHAKU-133-abcd1234-E7-A3");
    const replay = acceptWebhook(db, SECRET, headers(body), body);
    expect(replay.ok && replay.duplicate).toBe(true);
  });

  it("rejects a forged signature", () => {
    const r = acceptWebhook(fresh(), SECRET, headers(body, undefined, "attacker-secret-xxxx"), body);
    expect(r.ok).toBe(false);
  });

  it("rejects a tampered body", () => {
    const h = headers(body);
    const r = acceptWebhook(fresh(), SECRET, h, body.replace("payment-safe", "payment-failed"));
    expect(r.ok).toBe(false);
  });

  it("rejects a stale webhook", () => {
    const old = Math.floor(Date.now() / 1000) - 3600;
    const r = acceptWebhook(fresh(), SECRET, headers(body, old), body);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/stale/);
  });

  it("rejects missing headers and bodies without an order id", () => {
    expect(acceptWebhook(fresh(), SECRET, {}, body).ok).toBe(false);
    const noId = JSON.stringify({ status: "payment-safe" });
    expect(acceptWebhook(fresh(), SECRET, headers(noId), noId).ok).toBe(false);
  });

  it("treats each status of one payment as its own event", () => {
    const db = fresh();
    const seen = ["payment-included", "payment-safe", "payment-finalized"].map((status) => {
      const b = JSON.stringify({ ...payload, status });
      return acceptWebhook(db, SECRET, headers(b), b);
    });
    expect(seen.map((r) => r.ok && !r.duplicate)).toEqual([true, true, true]);
    expect(seen.map((r) => r.ok && r.event.id)).toEqual(["20261025010203000007:payment-included", "20261025010203000007:payment-safe", "20261025010203000007:payment-finalized"]);
  });

  it("acknowledges and ignores events that are not payments", () => {
    const b = JSON.stringify({ ...payload, event_type: "refund" });
    expect(acceptWebhook(fresh(), SECRET, headers(b), b)).toMatchObject({ ok: true, ignored: true });
  });

  it("derives a stable event id when HSP sends none", () => {
    const db = fresh();
    const b = JSON.stringify({ cart_mandate_id: "C1", payment_request_id: "P1", status: "payment-included" });
    const a = acceptWebhook(db, SECRET, headers(b), b);
    expect(a.ok && a.event.id).toBe("P1:payment-included");
    expect(acceptWebhook(db, SECRET, headers(b), b)).toMatchObject({ ok: true, duplicate: true });
  });
});

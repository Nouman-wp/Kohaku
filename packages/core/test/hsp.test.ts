import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  decimalToUnits,
  decodeX402,
  encodeX402,
  hspCanonical,
  hspHash,
  hspPaymentDetailsId,
  hspStatusClass,
  unitsToDecimal,
  type HspCartContents,
} from "../src/hsp.ts";
import {
  checkHspRequest,
  hspRequestHeaders,
  merchantAuthorization,
  merchantKey,
  userAuthorization,
  verifyEs256k,
  verifyHs256,
} from "../src/hsp-node.ts";

const contents: HspCartContents = {
  id: "KOHAKU-133-abcd1234-E7-A3",
  user_cart_confirmation_required: true,
  payment_request: {
    method_data: [
      {
        supported_methods: "https://www.x402.org/",
        data: { x402Version: 2, network: "hashkey-testnet", chain_id: 133, contract_address: "0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6", pay_to: "0x0000000000000000000000000000000000000B0B", coin: "USDC" },
      },
    ],
    details: { id: "PAY-REQ-01", display_items: [], total: { label: "Total", amount: { currency: "USD", value: "0.0123" } } },
  },
  cart_expiry: "2026-11-01T00:00:00.000Z",
  merchant_name: "Kohaku",
};

describe("HSP amounts", () => {
  it("round-trips integer units exactly, sub-cent included", () => {
    for (const u of [0n, 1n, 9n, 10_000n, 12_300n, 1_000_000n, 123_456_789n]) expect(decimalToUnits(unitsToDecimal(u))).toBe(u);
    expect(unitsToDecimal(12_300n)).toBe("0.0123");
    expect(unitsToDecimal(1_000_000n)).toBe("1.00");
    expect(unitsToDecimal(10_000n)).toBe("0.01");
  });
  it("refuses more precision than the token has", () => {
    expect(() => decimalToUnits("0.0000001")).toThrow();
    expect(decimalToUnits("0.1000000")).toBe(100_000n);
    expect(() => decimalToUnits("1e3")).toThrow();
  });
});

describe("HSP canonical hashing", () => {
  it("is independent of key order", () => {
    const { merchant_name, ...rest } = contents;
    const shuffled = { merchant_name, ...rest };
    expect(hspCanonical(shuffled)).toBe(hspCanonical(contents));
    expect(hspHash(contents)).toMatch(/^[0-9a-f]{64}$/);
  });
  it("x402 payloads survive base64", () => {
    const p = { x402Version: 2, payload: { signature: "0x01" }, accepted: { scheme: "exact" } } as never;
    expect(decodeX402(encodeX402(p))).toEqual(p);
  });
  it("classifies HSP statuses", () => {
    expect(hspStatusClass("payment-successful")).toBe("success");
    expect(hspStatusClass("payment-included")).toBe("pending");
    expect(hspStatusClass("payment-failed")).toBe("failed");
    expect(hspPaymentDetailsId(new Date(Date.UTC(2026, 9, 25, 1, 2, 3)), 7)).toBe("20261025010203000007");
  });
});

describe("HSP signatures", () => {
  it("merchant_authorization is an ES256K JWT committing to cart_hash", () => {
    const key = merchantKey("0x" + "11".repeat(32));
    const jwt = merchantAuthorization(contents, "Kohaku", key);
    const claims = verifyEs256k(jwt, key);
    expect(claims?.cart_hash).toBe(hspHash(contents));
    expect(claims?.aud).toBe("HashkeyMerchant");
    const other = merchantKey("0x" + "22".repeat(32));
    expect(verifyEs256k(jwt, other)).toBeNull();
  });
  it("accepts a PEM merchant key too", () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "secp256k1" });
    const pem = privateKey.export({ type: "sec1", format: "pem" }).toString();
    const key = merchantKey(pem);
    expect(verifyEs256k(merchantAuthorization(contents, "Kohaku", key), key)).not.toBeNull();
  });
  it("user_authorization binds both mandates to the payer", () => {
    const payer = "0x00000000000000000000000000000000000A11CE";
    const pmc = { payment_mandate_id: "PAY-REQ-01" };
    const jwt = userAuthorization({ payer, cartContents: contents, paymentContents: pmc, expiresAt: Math.floor(Date.now() / 1000) + 600 });
    const claims = verifyHs256(jwt, Buffer.from(payer));
    expect(claims?.iss).toBe(payer);
    expect(claims?.transaction_data).toEqual([hspHash(contents), hspHash(pmc)]);
    expect(verifyHs256(jwt, Buffer.from("0x0000000000000000000000000000000000000BAD"))).toBeNull();
  });
  it("HMAC request signatures verify, and reject tampering and replays", () => {
    const creds = { appKey: "k", appSecret: "s".repeat(32) };
    const body = hspCanonical({ cart_mandate: { contents } });
    const h = hspRequestHeaders({ method: "POST", path: "/api/v1/merchant/orders", body, ...creds });
    const headers = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
    const seen = new Set<string>();
    expect(checkHspRequest(headers, { method: "POST", path: "/api/v1/merchant/orders", query: "", body }, creds, Date.now(), seen)).toBeNull();
    expect(checkHspRequest(headers, { method: "POST", path: "/api/v1/merchant/orders", query: "", body }, creds, Date.now(), seen)).toMatch(/replayed/);
    expect(checkHspRequest(headers, { method: "POST", path: "/api/v1/merchant/orders", query: "", body: body + " " }, creds)).toMatch(/signature/);
    expect(checkHspRequest(headers, { method: "POST", path: "/api/v1/merchant/orders", query: "", body }, creds, Date.now() + 600_000)).toMatch(/stale/);
  });
});

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPublicClient, http, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  EIP3009_TYPES,
  HSP_X402_METHOD,
  encodeX402,
  hspPaymentDetailsId,
  localChain,
  type HspCartContents,
  type HspPaymentMandateContents,
} from "@kohaku/core";
import { merchantAuthorization, merchantKey, userAuthorization } from "@kohaku/core/hsp-node";
import { Db } from "../src/db.ts";
import { LocalHspGateway } from "../src/hsp/gateway.ts";

const TOKEN = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as const;
const POOL = "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9" as const;
const merchant = merchantKey("0x" + "42".repeat(32));
const payer = privateKeyToAccount(("0x" + "a1".repeat(32)) as Hex);
const thief = privateKeyToAccount(("0x" + "b2".repeat(32)) as Hex);

function gateway() {
  const db = new Db(mkdtempSync(join(tmpdir(), "kohaku-gw-")));
  const client = createPublicClient({ chain: localChain, transport: http("http://127.0.0.1:9") }) as PublicClient;
  return new LocalHspGateway(db, client, {
    chain: localChain,
    rpcUrl: "http://127.0.0.1:9",
    network: "local",
    token: { address: TOKEN, name: "Kohaku Test USDC", symbol: "tUSDC", version: "2", decimals: 6 },
    relayerKey: ("0x" + "c3".repeat(32)) as Hex,
    merchant: { appKey: "k", appSecret: "s".repeat(32), publicKey: merchant, webhookUrl: "http://127.0.0.1:9/webhook" },
    publicUrl: "http://localhost/hsp",
  });
}

function cart(id = "KOHAKU-31337-cf7ed3ac-E1-A1", value = "0.0172", token: string = TOKEN): HspCartContents {
  return {
    id,
    user_cart_confirmation_required: true,
    payment_request: {
      method_data: [{ supported_methods: HSP_X402_METHOD, data: { x402Version: 2, network: "local", chain_id: 31337, contract_address: token as Hex, pay_to: POOL, coin: "USDC" } }],
      details: { id: "PAY-REQ-01", display_items: [], total: { label: "Total", amount: { currency: "USD", value } } },
    },
    cart_expiry: new Date(Date.now() + 3_600_000).toISOString(),
    merchant_name: "Kohaku",
  };
}

async function payment(c: HspCartContents, o: { signer?: typeof payer; value?: bigint; claimFrom?: Hex; bindTo?: HspCartContents } = {}) {
  const signer = o.signer ?? payer;
  const from = o.claimFrom ?? signer.address;
  const value = o.value ?? 17_200n;
  const now = Math.floor(Date.now() / 1000);
  const auth = { from, to: POOL, value: value.toString(), validAfter: String(now - 30), validBefore: String(now + 300), nonce: ("0x" + "77".repeat(32)) as Hex };
  const signature = await signer.signTypedData({
    domain: { name: "Kohaku Test USDC", version: "2", chainId: 31337, verifyingContract: TOKEN },
    types: EIP3009_TYPES,
    primaryType: "TransferWithAuthorization",
    message: { ...auth, value, validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore) },
  });
  const payload = encodeX402({
    x402Version: 2,
    payload: { signature, authorization: auth },
    accepted: { scheme: "exact", network: "eip155:31337", asset: TOKEN, amount: value.toString(), payTo: POOL, maxTimeoutSeconds: 3600, extra: { protocol: "eip3009", name: "Kohaku Test USDC", version: "2" } },
  });
  const contents: HspPaymentMandateContents = {
    payment_mandate_id: c.payment_request.details.id,
    payment_details_id: hspPaymentDetailsId(),
    payment_details_total: { label: "Total", amount: c.payment_request.details.total.amount, pending: false },
    payment_response: { request_id: c.payment_request.details.id, method_name: HSP_X402_METHOD, details: { payment_payload: payload }, shipping_address: null, shipping_option: null, payer_name: null, payer_email: null, payer_phone: null },
    merchant_agent: "HashkeyMerchant",
    timestamp: new Date().toISOString(),
  };
  const user_authorization = userAuthorization({ payer: from, cartContents: o.bindTo ?? c, paymentContents: contents, expiresAt: now + 600 });
  return { payment_mandate_contents: contents, user_authorization };
}

function open(gw: LocalHspGateway, c: HspCartContents) {
  const r = gw.createOrder({ cart_mandate: { contents: c, merchant_authorization: merchantAuthorization(c, "Kohaku", merchant) } });
  expect(r.code).toBe(0);
  return (r.data as { flow_id: string }).flow_id;
}

describe("local HSP gateway", () => {
  it("opens an order only with a valid merchant signature over this exact cart", () => {
    const gw = gateway();
    const c = cart();
    const forged = merchantAuthorization(c, "Kohaku", merchantKey("0x" + "13".repeat(32)));
    expect(gw.createOrder({ cart_mandate: { contents: c, merchant_authorization: forged } }).code).not.toBe(0);
    const sig = merchantAuthorization(c, "Kohaku", merchant);
    expect(gw.createOrder({ cart_mandate: { contents: cart(undefined, "9.99"), merchant_authorization: sig } }).code).not.toBe(0);
    expect(gw.createOrder({ cart_mandate: { contents: cart("X", "0.01", POOL), merchant_authorization: merchantAuthorization(cart("X", "0.01", POOL), "Kohaku", merchant) } }).code).not.toBe(0);
    const first = gw.createOrder({ cart_mandate: { contents: c, merchant_authorization: sig } });
    expect(first.code).toBe(0);
    // idempotent for the same cart, refused for a different cart under the same id
    expect(gw.createOrder({ cart_mandate: { contents: c, merchant_authorization: sig } }).data).toEqual(first.data);
    const other = cart(c.id, "0.02");
    expect(gw.createOrder({ cart_mandate: { contents: other, merchant_authorization: merchantAuthorization(other, "Kohaku", merchant) } }).code).toBe(40901);
  });

  it("refuses an authorization for a different amount than the cart", async () => {
    const gw = gateway();
    const c = cart();
    const flow = open(gw, c);
    const r = await gw.payMandate({ flow_id: flow, payment_mandate: await payment(c, { value: 1n }) });
    expect(r.code).toBe(40016);
  });

  it("refuses a payer claiming someone else's wallet", async () => {
    const gw = gateway();
    const c = cart();
    const flow = open(gw, c);
    const r = await gw.payMandate({ flow_id: flow, payment_mandate: await payment(c, { signer: thief, claimFrom: payer.address }) });
    expect(r.code).toBe(40106);
  });

  it("refuses a user_authorization bound to another cart", async () => {
    const gw = gateway();
    const c = cart();
    const flow = open(gw, c);
    const r = await gw.payMandate({ flow_id: flow, payment_mandate: await payment(c, { bindTo: cart("KOHAKU-OTHER") }) });
    expect(r.code).toBe(40104);
  });

  it("reports payment status in HashKey Merchant's shape", () => {
    const gw = gateway();
    const c = cart();
    open(gw, c);
    const r = gw.payments({ cart_mandate_id: c.id });
    expect(r.code).toBe(0);
    expect((r.data as { status: string; cart_mandate_id: string }[])[0]).toMatchObject({ status: "payment-required", cart_mandate_id: c.id, amount: "17200" });
    expect(gw.payments({}).code).not.toBe(0);
  });
});

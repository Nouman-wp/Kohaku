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
  const client = createPublicClient({ chain: localChain, transport: http("http://127.0.0.1:9", { retryCount: 0 }) }) as PublicClient;
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

function cart(id = "KOHAKU-31337-cf7ed3ac-E1-A1", value = "0.0172", token: string = TOKEN, requestId = `PAY-REQ-${id}`): HspCartContents {
  return {
    id,
    user_cart_confirmation_required: true,
    payment_request: {
      method_data: [{ supported_methods: HSP_X402_METHOD, data: { x402Version: 2, network: "local", chain_id: 31337, contract_address: token as Hex, pay_to: POOL, coin: "USDC" } }],
      details: { id: requestId, display_items: [{ label: "Net settlement", amount: { currency: "USD", value } }], total: { label: "Total", amount: { currency: "USD", value } } },
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
  // HSP answers with the checkout URL; the flow id is its last segment
  return (r.data as { payment_url: string }).payment_url.split("/").at(-1)!;
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
    expect(first).toMatchObject({ code: 0, data: { payment_request_id: c.payment_request.details.id, multi_pay: false } });
  });

  it("checks the cart's amounts the way HSP does", () => {
    const gw = gateway();
    const c = cart();
    c.payment_request.details.display_items = [{ label: "A", amount: { currency: "USD", value: "0.01" } }];
    expect(gw.createOrder({ cart_mandate: { contents: c, merchant_authorization: merchantAuthorization(c, "Kohaku", merchant) } }).code).toBe(10001);
    const eur = cart("KOHAKU-EUR");
    eur.payment_request.details.total.amount.currency = "EUR";
    expect(gw.createOrder({ cart_mandate: { contents: eur, merchant_authorization: merchantAuthorization(eur, "Kohaku", merchant) } }).code).toBe(10001);
  });

  it("never reuses a cart mandate id or a payment request id, as HSP does", () => {
    const gw = gateway();
    const c = cart();
    open(gw, c);
    const again = gw.createOrder({ cart_mandate: { contents: c, merchant_authorization: merchantAuthorization(c, "Kohaku", merchant) } });
    expect(again.code).toBe(40001);
    const sameRequest = cart("KOHAKU-31337-cf7ed3ac-E1-A1-R1", "0.0172", TOKEN, c.payment_request.details.id);
    expect(gw.createOrder({ cart_mandate: { contents: sameRequest, merchant_authorization: merchantAuthorization(sameRequest, "Kohaku", merchant) } }).code).toBe(10004);
    const retry = cart("KOHAKU-31337-cf7ed3ac-E1-A1-R1", "0.0172", TOKEN, `${c.payment_request.details.id}-R1`);
    expect(gw.createOrder({ cart_mandate: { contents: retry, merchant_authorization: merchantAuthorization(retry, "Kohaku", merchant) } }).code).toBe(0);
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

  it("reports payment records in HashKey Merchant's shape", () => {
    const gw = gateway();
    const c = cart();
    const flow = open(gw, c);
    const r = gw.payments({ cart_mandate_id: c.id });
    expect(r.code).toBe(0);
    expect((r.data as object[])[0]).toMatchObject({
      status: "payment-required",
      content_id: c.id,
      payment_request_id: c.payment_request.details.id,
      flow_id: flow,
      order_amount: "0.0172",
      pay_amount: "0.0172",
      usd_amount: "0.0172",
      token: "USDC",
      token_address: TOKEN,
      to_pay_address: POOL,
      chain: "eip155:31337",
      network: "local",
      extra_protocol: "eip3009",
      gas_fee_advanced: true,
    });
    // by payment request id or flow id: one record, not a list
    expect(gw.payments({ flow_id: flow }).data).toMatchObject({ content_id: c.id });
    expect(gw.payments({ payment_request_id: c.payment_request.details.id }).data).toMatchObject({ flow_id: flow });
    expect(gw.payments({ flow_id: "nope" }).code).toBe(10003);
    expect(gw.payments({}).code).toBe(10001);
  });

  it("records the payer's line item and a failure HSP could not relay", async () => {
    const gw = gateway();
    const c = cart();
    const flow = open(gw, c);
    const pm = await payment(c);
    // the chain is unreachable, so the relay's dry run fails
    const r = await gw.payMandate({ flow_id: flow, payment_mandate: pm });
    expect(r.code).toBe(40020);
    expect(gw.payments({ flow_id: flow }).data).toMatchObject({
      status: "payment-failed",
      request_id: pm.payment_mandate_contents.payment_details_id,
      payer_address: payer.address,
    });
  });
});

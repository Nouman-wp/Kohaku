import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, parseAbiItem, type Hex, type PublicClient } from "viem";
import { settlementOrderRef, type HspPaymentRecord } from "@kohaku/core";
import { merchantKey } from "@kohaku/core/hsp-node";
import { HspApiError, HspMerchantClient, MerchantHsp } from "../src/hsp/merchant.ts";
import { HspOrderIdTaken, type HspOrder } from "../src/hsp/port.ts";

const TOKEN = "0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6" as const;
const POOL = "0xa4f5f3F30E43182285A1EFAbbA8513103efA6730" as const;
const PAYER = "0x00000000000000000000000000000000000a11ce" as const;
const TX = ("0x" + "cd".repeat(32)) as Hex;
const CART = "KOHAKU-133-a4f5f3f3-E7-A3";

const order: HspOrder = {
  id: "7:3",
  epoch: 7n,
  agentId: 3n,
  amount: 17_200n,
  payer: PAYER,
  payTo: POOL,
  token: TOKEN,
  orderRef: settlementOrderRef(133, POOL, 7n, 3n, 17_200n),
  attempt: 0,
};

/** HashKey's record for this order, as its payments query returns it. */
function record(over: Partial<HspPaymentRecord> = {}): HspPaymentRecord {
  return {
    content_id: CART,
    payment_request_id: `PAY-REQ-${order.orderRef.slice(2)}`,
    request_id: "20261025010203000007",
    flow_id: "b660fdc3-ac04-437f-921f-efbfb8d089f7",
    product_amount: "0.0172",
    order_amount: "0.0172",
    pay_amount: "0.0172",
    token: "USDC",
    token_address: TOKEN,
    payer_address: PAYER,
    to_pay_address: POOL,
    chain: "eip155:133",
    network: "hashkey-testnet",
    extra_protocol: "eip3009",
    status: "payment-safe",
    tx_signature: TX,
    ...over,
  };
}

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const USED = parseAbiItem("event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)");

/** A chain whose only transaction is the debtor's exact transfer into the pool. */
const chain = {
  getTransactionReceipt: async () => ({
    status: "success",
    blockNumber: 10n,
    logs: [
      { address: TOKEN, topics: encodeEventTopics({ abi: [TRANSFER], args: { from: PAYER, to: POOL } }), data: encodeAbiParameters([{ type: "uint256" }], [17_200n]) },
      { address: TOKEN, topics: encodeEventTopics({ abi: [USED], args: { authorizer: PAYER, nonce: order.orderRef } }), data: "0x" },
    ],
  }),
} as unknown as PublicClient;

function hsp(api: Partial<Pick<HspMerchantClient, "payments" | "createOrder">>) {
  const client = new HspMerchantClient({ baseUrl: "https://merchant-qa.hashkeymerchant.com", appKey: "k", appSecret: "s", merchantName: "Kohaku", merchantKey: merchantKey("0x" + "42".repeat(32)) });
  Object.assign(client, api);
  return new MerchantHsp(chain, client, { mode: "merchant", chainId: 133, network: "hashkey-testnet", coin: "USDC", decimals: 6, payerGatewayUrl: "", cartTtlSeconds: 7200, note: "" });
}

describe("HashKey Merchant settlement checks", () => {
  it("waits while HSP has the payment included but not yet safe", async () => {
    const v = await hsp({ payments: async () => [record({ status: "payment-included" })] }).verify(order, CART, null);
    expect(v).toMatchObject({ outcome: "RETRYABLE", status: "payment-included" });
  });

  it("accepts a safe payment whose record and transfer are exactly this debt", async () => {
    const v = await hsp({ payments: async () => [record()] }).verify(order, CART, { cartMandateId: CART, flowId: "f", paymentDetailsId: "20261025010203000007" });
    expect(v).toMatchObject({ outcome: "ACCEPT", status: "payment-safe", txHash: TX });
    expect(v.receiptHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("refuses a record that pays someone else, in another token, or another amount", async () => {
    for (const bad of [{ to_pay_address: PAYER }, { token_address: POOL }, { order_amount: "0.0171" }, { content_id: "KOHAKU-OTHER" }]) {
      const v = await hsp({ payments: async () => [record(bad)] }).verify(order, CART, null);
      expect(v.outcome).toBe("POLICY");
    }
  });

  it("passes a failure on so the debtor can retry", async () => {
    const v = await hsp({ payments: async () => [record({ status: "payment-failed", status_reason: "timeout reconciliation", tx_signature: "" })] }).verify(order, CART, null);
    expect(v).toMatchObject({ outcome: "PERMANENT", reason: "timeout reconciliation" });
  });

  it("opens re-tried orders under fresh ids and reports ids HSP already has", async () => {
    const bodies: { contents: { id: string; payment_request: { details: { id: string } } } }[] = [];
    const opened = await hsp({
      createOrder: async (cart) => {
        bodies.push(cart as never);
        return { payment_request_id: cart.contents.payment_request.details.id, payment_url: "https://pay.hashkey.com/flow/abc123", multi_pay: false };
      },
    }).open({ ...order, attempt: 1 });
    expect(opened).toMatchObject({ cartMandateId: `${CART}-R1`, paymentRequestId: `PAY-REQ-${order.orderRef.slice(2)}-R1`, flowId: "abc123" });
    expect(bodies[0]!.contents.payment_request.details.id).toBe(opened.paymentRequestId);

    const taken = hsp({ createOrder: async () => Promise.reject(new HspApiError("HSP POST /api/v1/merchant/orders: HTTP 400 code 40001", false, 40001)) });
    await expect(taken.open(order)).rejects.toBeInstanceOf(HspOrderIdTaken);
  });
});

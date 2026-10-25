import { randomBytes, type KeyObject } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  createWalletClient,
  http,
  isAddressEqual,
  recoverTypedDataAddress,
  type Address,
  type Chain as ViemChain,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  EIP3009_TYPES,
  HSP_AUDIENCE,
  HSP_X402_METHOD,
  decimalToUnits,
  decodeX402,
  hspHash,
  nonceManager,
  sendWithNonceRetry,
  type HspCartMandate,
  type HspPaymentMandate,
  type HspPaymentRecord,
} from "@kohaku/core";
import { checkHspRequest, signHspWebhook, verifyEs256k, verifyHs256 } from "@kohaku/core/hsp-node";
import { mockUsdcAbi } from "@kohaku/core/abis";
import type { Db } from "../db.ts";
import { log } from "../bus.ts";

export interface GatewayToken {
  address: Address;
  symbol: string;
  name: string;
  version: string;
  decimals: number;
}

export interface GatewayOptions {
  chain: ViemChain;
  rpcUrl: string;
  network: string;
  token: GatewayToken;
  relayerKey: Hex;
  merchant: { appKey: string; appSecret: string; publicKey: KeyObject; webhookUrl: string };
  /** public base of the gateway, for payment_url */
  publicUrl: string;
}

interface FlowRow {
  flow_id: string;
  cart_mandate_id: string;
  payment_request_id: string;
  cart_json: string;
  amount: string;
  status: string;
  status_reason: string | null;
  payer: string | null;
  payment_details_id: string | null;
  tx: string | null;
  created_at: number;
  updated_at: number;
}

type Reply = { code: number; msg: string; data?: unknown };
const ok = (data: unknown): Reply => ({ code: 0, msg: "success", data });
const fail = (code: number, msg: string): Reply => ({ code, msg });

/**
 * Kohaku's local HSP gateway. It serves the HashKey Merchant API surface Kohaku uses
 * (merchant orders and payment status, HMAC-authenticated; the checkout's cart-mandate,
 * chain-config and pay-mandate endpoints) and does what HSP does with a payment mandate:
 * verify the merchant's cart signature, the payer's user_authorization and its EIP-3009
 * authorization against the cart, relay the authorization on chain, and report the result
 * by signed webhook and on the status endpoint.
 *
 * It runs only when HSP_MODE=local, is labelled "HSP local gateway" everywhere, and is not
 * operated by HashKey. Transfers it relays are real on-chain token transfers. Set
 * HSP_MODE=merchant (with HashKey Merchant credentials) to settle through HashKey instead;
 * the clearing service and the agents use the same code against either.
 */
export class LocalHspGateway {
  private readonly relayer;
  private readonly wallet;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly seenNonces = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly client: PublicClient,
    readonly o: GatewayOptions,
  ) {
    this.relayer = privateKeyToAccount(o.relayerKey, { nonceManager });
    this.wallet = createWalletClient({ chain: o.chain, transport: http(o.rpcUrl), account: this.relayer, pollingInterval: o.chain.id === 31337 ? 250 : 1_000 });
    // its flows live in hsp_gateway_flows (db.ts)
  }

  get relayerAddress(): Address {
    return this.relayer.address;
  }

  private flow(where: "flow_id" | "cart_mandate_id" | "payment_request_id", v: string): FlowRow | undefined {
    return this.db.get<FlowRow>(`SELECT * FROM hsp_gateway_flows WHERE ${where} = ? ORDER BY created_at DESC LIMIT 1`, v);
  }

  private record(f: FlowRow): HspPaymentRecord {
    const cart = JSON.parse(f.cart_json) as HspCartMandate;
    const m = cart.contents.payment_request.method_data[0]!.data;
    return {
      payment_request_id: f.payment_request_id,
      cart_mandate_id: f.cart_mandate_id,
      flow_id: f.flow_id,
      payment_details_id: f.payment_details_id ?? undefined,
      status: f.status,
      status_reason: f.status_reason,
      amount: f.amount,
      token: m.coin,
      token_address: m.contract_address,
      chain_id: m.chain_id,
      payer_address: f.payer ?? undefined,
      pay_to: m.pay_to,
      tx_signature: f.tx,
      payment_url: `${this.o.publicUrl}/checkout/${f.flow_id}`,
      created_at: new Date(f.created_at).toISOString(),
      updated_at: new Date(f.updated_at).toISOString(),
    };
  }

  private setStatus(flowId: string, status: string, extra: { reason?: string | null; tx?: string; payer?: string; detailsId?: string } = {}): void {
    this.db.run(
      `UPDATE hsp_gateway_flows SET status = ?, status_reason = ?, tx = COALESCE(?, tx), payer = COALESCE(?, payer),
         payment_details_id = COALESCE(?, payment_details_id), updated_at = ? WHERE flow_id = ?`,
      status,
      extra.reason ?? null,
      extra.tx ?? null,
      extra.payer ?? null,
      extra.detailsId ?? null,
      Date.now(),
      flowId,
    );
    const f = this.flow("flow_id", flowId);
    if (f) void this.webhook(f);
  }

  private async webhook(f: FlowRow): Promise<void> {
    const body = JSON.stringify({ request_id: `evt_${f.flow_id.slice(0, 12)}_${f.status}`, ...this.record(f) });
    try {
      await fetch(this.o.merchant.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-signature": signHspWebhook(this.o.merchant.appSecret, body) },
        body,
        signal: AbortSignal.timeout(5_000),
      });
    } catch (err) {
      log("warn", "hsp", `gateway webhook delivery failed: ${(err as Error).message}`);
    }
  }

  // ---------------------------------------------------------------- merchant API

  createOrder(body: { cart_mandate?: HspCartMandate; redirect_url?: string }): Reply {
    const cart = body.cart_mandate;
    if (!cart?.contents || typeof cart.merchant_authorization !== "string") return fail(40001, "cart_mandate.contents and merchant_authorization are required");
    const claims = verifyEs256k(cart.merchant_authorization, this.o.merchant.publicKey);
    if (!claims) return fail(40101, "merchant_authorization signature is invalid");
    if (claims.aud !== HSP_AUDIENCE) return fail(40102, "merchant_authorization audience must be HashkeyMerchant");
    if (claims.cart_hash !== hspHash(cart.contents)) return fail(40103, "cart_hash does not match the cart contents");
    if (typeof claims.exp === "number" && claims.exp < Date.now() / 1000) return fail(40104, "merchant_authorization expired");
    const c = cart.contents;
    const m = c.payment_request?.method_data?.find((x) => x.supported_methods === HSP_X402_METHOD);
    if (!m) return fail(40002, "no x402 method data");
    if (m.data.chain_id !== this.o.chain.id || m.data.network !== this.o.network) return fail(40003, `unsupported network ${m.data.network} (${m.data.chain_id})`);
    if (!isAddressEqual(m.data.contract_address, this.o.token.address)) return fail(40004, `unsupported token ${m.data.contract_address}`);
    let amount: bigint;
    try {
      amount = decimalToUnits(c.payment_request.details.total.amount.value, this.o.token.decimals);
    } catch (err) {
      return fail(40005, (err as Error).message);
    }
    if (amount <= 0n) return fail(40005, "total must be positive");

    const existing = this.flow("cart_mandate_id", c.id);
    if (existing) {
      if (hspHash((JSON.parse(existing.cart_json) as HspCartMandate).contents.payment_request) !== hspHash(c.payment_request)) return fail(40901, "cart_mandate_id already used for a different cart");
      return ok({ payment_url: this.record(existing).payment_url, flow_id: existing.flow_id, cart_mandate_id: c.id, payment_request_id: existing.payment_request_id });
    }
    const flowId = randomBytes(16).toString("hex");
    const now = Date.now();
    this.db.run(
      "INSERT INTO hsp_gateway_flows(flow_id, cart_mandate_id, payment_request_id, cart_json, amount, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
      flowId,
      c.id,
      c.payment_request.details.id,
      JSON.stringify(cart),
      amount.toString(),
      "payment-required",
      now,
      now,
    );
    return ok({ payment_url: `${this.o.publicUrl}/checkout/${flowId}`, flow_id: flowId, cart_mandate_id: c.id, payment_request_id: c.payment_request.details.id });
  }

  payments(q: Record<string, string | undefined>): Reply {
    const keys = (["cart_mandate_id", "payment_request_id", "flow_id"] as const).filter((k) => q[k]);
    if (keys.length !== 1) return fail(40006, "exactly one of cart_mandate_id, payment_request_id, flow_id is required");
    const k = keys[0]!;
    const rows = this.db.all<FlowRow>(`SELECT * FROM hsp_gateway_flows WHERE ${k} = ? ORDER BY created_at DESC`, q[k]!);
    return ok(rows.map((f) => this.record(f)));
  }

  // ---------------------------------------------------------------- checkout API (payer side)

  chainConfig(): Reply {
    const t = this.o.token;
    return ok([
      {
        chain_id: this.o.chain.id,
        network: this.o.network,
        name: this.o.chain.name,
        tokens: [{ address: t.address, symbol: t.symbol, name: t.name, version: t.version, decimals: t.decimals, is_stablecoin: true, protocol: "eip3009" }],
      },
    ]);
  }

  cartByFlow(flowId: string): Reply {
    const f = this.flow("flow_id", flowId);
    if (!f) return fail(40401, "unknown flow");
    return ok({ flow_id: f.flow_id, status: f.status, cartmandate: JSON.parse(f.cart_json) as HspCartMandate });
  }

  flowStatus(flowId: string): Reply {
    const f = this.flow("flow_id", flowId);
    return f ? ok(this.record(f)) : fail(40401, "unknown flow");
  }

  async payMandate(body: { flow_id?: string; payment_mandate?: HspPaymentMandate }): Promise<Reply> {
    const f = body.flow_id ? this.flow("flow_id", body.flow_id) : undefined;
    if (!f) return fail(40401, "unknown flow");
    if (f.status !== "payment-required" && f.status !== "payment-failed") return fail(40902, `payment already ${f.status}`);
    const pm = body.payment_mandate;
    if (!pm?.payment_mandate_contents || typeof pm.user_authorization !== "string") return fail(40010, "payment_mandate_contents and user_authorization are required");
    const cart = JSON.parse(f.cart_json) as HspCartMandate;
    const method = cart.contents.payment_request.method_data[0]!.data;
    const pmc = pm.payment_mandate_contents;
    if (pmc.payment_mandate_id !== cart.contents.payment_request.details.id) return fail(40011, "payment_mandate_id does not match the cart's payment request");
    if (pmc.payment_response?.method_name !== HSP_X402_METHOD) return fail(40012, "unsupported payment method");
    if (pmc.payment_details_total?.amount?.value !== cart.contents.payment_request.details.total.amount.value) return fail(40013, "payment total does not match the cart");
    if (new Date(cart.contents.cart_expiry).getTime() < Date.now()) return fail(40014, "cart expired");

    let x;
    try {
      x = decodeX402(pmc.payment_response.details.payment_payload);
    } catch {
      return fail(40015, "payment_payload is not a base64 x402 payload");
    }
    const a = x.payload?.authorization;
    const amount = BigInt(f.amount);
    const checks: [boolean, string][] = [
      [x.x402Version === 2 && x.accepted?.scheme === "exact", "x402 v2 exact scheme required"],
      [x.accepted?.network === `eip155:${method.chain_id}`, "wrong network"],
      [!!a && isAddressEqual(x.accepted.asset, method.contract_address), "wrong asset"],
      [!!a && isAddressEqual(x.accepted.payTo, method.pay_to) && isAddressEqual(a.to, method.pay_to), "authorization does not pay the merchant's pay_to"],
      [!!a && BigInt(x.accepted.amount) === amount && BigInt(a.value) === amount, "authorization amount does not match the cart total"],
    ];
    for (const [pass, msg] of checks) if (!pass) return fail(40016, msg);

    // user_authorization: HS256 keyed with the payer's address, binding both mandates
    const ua = verifyHs256(pm.user_authorization, Buffer.from(a!.from));
    if (!ua) return fail(40102, "user_authorization signature is invalid");
    const td = ua.transaction_data as unknown;
    if (ua.aud !== HSP_AUDIENCE || String(ua.iss).toLowerCase() !== a!.from.toLowerCase()) return fail(40103, "user_authorization issuer/audience mismatch");
    if (!Array.isArray(td) || td[0] !== hspHash(cart.contents) || td[1] !== hspHash(pmc)) return fail(40104, "user_authorization does not commit to these mandates");
    if (typeof ua.exp === "number" && ua.exp < Date.now() / 1000) return fail(40105, "user_authorization expired");

    // the EIP-3009 signature itself
    const domain = { name: this.o.token.name, version: this.o.token.version, chainId: method.chain_id, verifyingContract: method.contract_address };
    const message = { from: a!.from, to: a!.to, value: BigInt(a!.value), validAfter: BigInt(a!.validAfter), validBefore: BigInt(a!.validBefore), nonce: a!.nonce };
    let signer: Address;
    try {
      signer = await recoverTypedDataAddress({ domain, types: EIP3009_TYPES, primaryType: "TransferWithAuthorization", message, signature: x.payload.signature });
    } catch {
      return fail(40106, "authorization signature is malformed");
    }
    if (!isAddressEqual(signer, a!.from)) return fail(40106, "authorization is not signed by its payer");

    // relay it, as HSP does: the payer needs no gas
    const args = [message.from, message.to, message.value, message.validAfter, message.validBefore, message.nonce, x.payload.signature] as const;
    try {
      await this.client.simulateContract({ address: method.contract_address, abi: mockUsdcAbi, functionName: "transferWithAuthorization", args, account: this.relayer });
    } catch (err) {
      this.setStatus(f.flow_id, "payment-failed", { reason: shortError(err), payer: a!.from, detailsId: pmc.payment_details_id });
      return fail(40020, `authorization would not settle: ${shortError(err)}`);
    }
    this.setStatus(f.flow_id, "payment-submitted", { payer: a!.from, detailsId: pmc.payment_details_id });
    let hash: Hex;
    try {
      const relay = () =>
        sendWithNonceRetry(this.relayer.address, this.o.chain.id, () =>
          this.wallet.writeContract({ address: method.contract_address, abi: mockUsdcAbi, functionName: "transferWithAuthorization", args, account: this.relayer, chain: this.o.chain }),
        );
      hash = (await (this.queue = this.queue.then(relay, relay))) as Hex;
    } catch (err) {
      this.setStatus(f.flow_id, "payment-failed", { reason: shortError(err) });
      return fail(50001, `relay failed: ${shortError(err)}`);
    }
    void this.confirm(f.flow_id, hash);
    return ok({ flow_id: f.flow_id, status: "payment-submitted", payment_details_id: pmc.payment_details_id, tx_signature: hash });
  }

  private async confirm(flowId: string, hash: Hex): Promise<void> {
    try {
      const r = await this.client.waitForTransactionReceipt({ hash, timeout: 180_000 });
      if (r.status !== "success") {
        this.setStatus(flowId, "payment-failed", { reason: "transfer reverted", tx: hash });
        return;
      }
      this.setStatus(flowId, "payment-included", { tx: hash });
      this.setStatus(flowId, "payment-successful", { tx: hash });
    } catch (err) {
      this.setStatus(flowId, "payment-failed", { reason: `not confirmed: ${shortError(err)}`, tx: hash });
    }
  }

  // ---------------------------------------------------------------- HTTP

  mount(app: FastifyInstance, prefix = "/hsp"): void {
    const auth = (req: FastifyRequest, path: string) => {
      const url = new URL(req.url, "http://x");
      return checkHspRequest(
        req.headers,
        { method: req.method, path, query: url.searchParams.toString(), body: req.rawBody ?? "" },
        { appKey: this.o.merchant.appKey, appSecret: this.o.merchant.appSecret },
        Date.now(),
        this.seenNonces,
      );
    };
    app.post(`${prefix}/api/v1/merchant/orders`, async (req, reply) => {
      const err = auth(req, "/api/v1/merchant/orders");
      if (err) return reply.status(401).send(fail(40100, err));
      return this.createOrder(req.body as never);
    });
    app.get(`${prefix}/api/v1/merchant/payments`, async (req, reply) => {
      const err = auth(req, "/api/v1/merchant/payments");
      if (err) return reply.status(401).send(fail(40100, err));
      return this.payments(req.query as Record<string, string>);
    });
    app.get(`${prefix}/api/v1/payment/chain-config`, async () => this.chainConfig());
    app.get(`${prefix}/api/v1/payment/cart-mandate/flow/:flowId`, async (req) => this.cartByFlow((req.params as { flowId: string }).flowId));
    app.get(`${prefix}/api/v1/payment/flow/:flowId`, async (req) => this.flowStatus((req.params as { flowId: string }).flowId));
    app.post(`${prefix}/api/v1/payment/pay-mandate`, async (req) => this.payMandate(req.body as never));
    app.get(`${prefix}/checkout/:flowId`, async (req, reply) => {
      const f = this.flow("flow_id", (req.params as { flowId: string }).flowId);
      if (!f) return reply.status(404).send("unknown flow");
      const r = this.record(f);
      reply.type("text/html").send(
        `<!doctype html><meta charset="utf-8"><title>HSP local gateway</title><body style="font:15px system-ui;background:#030014;color:#f4f0ff;padding:32px">` +
          `<h2>HSP local gateway (Kohaku)</h2><p>Not operated by HashKey. Same API as HashKey Merchant.</p>` +
          `<pre>${escapeHtml(JSON.stringify(r, null, 2))}</pre></body>`,
      );
    });
  }
}

function shortError(err: unknown): string {
  const e = err as { shortMessage?: string; message?: string };
  return (e.shortMessage ?? e.message ?? String(err)).split("\n")[0]!.slice(0, 200);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
}

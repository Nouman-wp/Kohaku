import type { KeyObject } from "node:crypto";
import { isAddressEqual, keccak256, stringToHex, type Address, type Hex, type PublicClient } from "viem";
import {
  HSP_X402_METHOD,
  HSP_X402_VERSION,
  decimalToUnits,
  hspCanonical,
  hspCartMandateId,
  hspPaymentRequestId,
  hspRecordCartId,
  hspRecordRequestId,
  hspStatusClass,
  unitsToDecimal,
  type HspCartContents,
  type HspMode,
  type HspPaymentRecord,
  type PaymentReport,
} from "@kohaku/core";
import { hspRequestHeaders, merchantAuthorization } from "@kohaku/core/hsp-node";
import { checkTransfer } from "./onchain.ts";
import { HspOrderIdTaken, type HspInfo, type HspOrder, type HspPort, type HspVerification, type OpenedOrder } from "./port.ts";

/** HSP error codes for an id it has already seen: cart mandate id (40001), payment request id (10004). */
const ID_TAKEN = new Set([40001, 10004]);

export interface MerchantCredentials {
  /** API base, e.g. https://merchant-qa.hashkeymerchant.com (HashKey) or <clearing>/hsp (local gateway) */
  baseUrl: string;
  appKey: string;
  appSecret: string;
  merchantName: string;
  merchantKey: KeyObject;
}

export class HspApiError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly code?: number,
  ) {
    super(message);
  }
}

/**
 * Client for the HashKey Merchant API (https://hashkey-merchant.github.io), HSP's merchant
 * surface. Every call is HMAC-signed (X-App-Key / X-Timestamp / X-Nonce / X-Signature over
 * sha256 of the canonical JSON body); bodies are sent as that same canonical JSON.
 */
export class HspMerchantClient {
  lastOkAt = 0;
  lastError: string | null = null;

  constructor(readonly creds: MerchantCredentials) {}

  async request<T>(method: "GET" | "POST", path: string, opts: { query?: Record<string, string>; body?: unknown } = {}): Promise<T> {
    const query = new URLSearchParams(opts.query ?? {}).toString();
    const body = opts.body === undefined ? "" : hspCanonical(opts.body);
    const headers = hspRequestHeaders({ method, path, query, body, appKey: this.creds.appKey, appSecret: this.creds.appSecret });
    let res: Response;
    try {
      res = await fetch(`${this.creds.baseUrl}${path}${query ? `?${query}` : ""}`, {
        method,
        headers: { "content-type": "application/json", accept: "application/json", ...headers },
        body: body || undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      this.lastError = (err as Error).message;
      throw new HspApiError(`HSP unreachable: ${this.lastError}`, true);
    }
    const text = await res.text();
    let json: { code?: number; msg?: string; message?: string; data?: unknown };
    try {
      json = JSON.parse(text);
    } catch {
      this.lastError = `HTTP ${res.status}: non-JSON response`;
      throw new HspApiError(`HSP ${method} ${path}: ${this.lastError}`, res.status >= 500 || res.status === 429 || res.status === 403);
    }
    if (!res.ok || (json.code !== undefined && json.code !== 0)) {
      this.lastError = `HTTP ${res.status} code ${json.code}: ${json.msg ?? json.message ?? ""}`;
      throw new HspApiError(`HSP ${method} ${path}: ${this.lastError}`, res.status >= 500 || res.status === 429, json.code);
    }
    this.lastOkAt = Date.now();
    this.lastError = null;
    return json.data as T;
  }

  createOrder(cartMandate: { contents: HspCartContents; merchant_authorization: string }, redirectUrl?: string) {
    return this.request<{ payment_url?: string; payment_request_id?: string; multi_pay?: boolean; flow_id?: string }>("POST", "/api/v1/merchant/orders", {
      body: { cart_mandate: cartMandate, ...(redirectUrl ? { redirect_url: redirectUrl } : {}) },
    });
  }

  async payments(query: { cart_mandate_id: string } | { payment_request_id: string } | { flow_id: string }): Promise<HspPaymentRecord[]> {
    const data = await this.request<HspPaymentRecord[] | HspPaymentRecord | null>("GET", "/api/v1/merchant/payments", { query: query as Record<string, string> });
    if (!data) return [];
    return Array.isArray(data) ? data : [data];
  }
}

export function flowIdFromUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const seg = new URL(url).pathname.split("/").filter(Boolean);
    return seg.at(-1) ?? null;
  } catch {
    return null;
  }
}

export interface MerchantHspOptions {
  mode: HspMode;
  chainId: number;
  network: string;
  coin: string;
  decimals: number;
  /** where payers reach HSP's payment endpoints (pay-mandate, cart-mandate lookup) */
  payerGatewayUrl: string;
  redirectUrl?: string;
  cartTtlSeconds: number;
  note: string;
}

/**
 * Kohaku's HSP port. The clearing service is the HSP merchant: for every net debt it opens a
 * cart mandate naming the clearing pool as `pay_to` and the exact net amount as the total.
 * The debtor agent pays it with an EIP-3009 authorization (nonce = settlement order ref)
 * that HSP relays. A settlement is accepted only when HSP reports the payment safe (or
 * final) for this order, payee, token and amount, *and* Kohaku sees, on chain, that exact
 * transfer consuming that exact authorization.
 *
 * In `merchant` mode this talks to HashKey's Merchant API. In `local` mode it talks to
 * Kohaku's own gateway (./gateway.ts), which serves the same endpoints; nothing here
 * differs between the two.
 */
export class MerchantHsp implements HspPort {
  constructor(
    private readonly client: PublicClient,
    readonly api: HspMerchantClient,
    private readonly o: MerchantHspOptions,
  ) {}

  get mode(): HspMode {
    return this.o.mode;
  }

  info(): HspInfo {
    return { mode: this.o.mode, gatewayUrl: this.o.payerGatewayUrl, merchantName: this.api.creds.merchantName, network: this.o.network, note: this.o.note };
  }

  async health(): Promise<boolean> {
    if (Date.now() - this.api.lastOkAt < 60_000) return true;
    try {
      // a status query for an id that does not exist: cheap, signed, exercises auth
      await this.api.payments({ cart_mandate_id: "KOHAKU-HEALTHCHECK" });
      return true;
    } catch (err) {
      return !(err as HspApiError).retryable;
    }
  }

  cartContents(order: HspOrder, cartMandateId: string, paymentRequestId: string): HspCartContents {
    const value = unitsToDecimal(order.amount, this.o.decimals);
    return {
      id: cartMandateId,
      user_cart_confirmation_required: true,
      payment_request: {
        method_data: [
          {
            supported_methods: HSP_X402_METHOD,
            data: {
              x402Version: HSP_X402_VERSION,
              network: this.o.network,
              chain_id: this.o.chainId,
              contract_address: order.token,
              pay_to: order.payTo,
              coin: this.o.coin,
            },
          },
        ],
        details: {
          id: paymentRequestId,
          display_items: [{ label: `Kohaku net settlement, epoch ${order.epoch}, agent #${order.agentId}`, amount: { currency: "USD", value } }],
          total: { label: "Total", amount: { currency: "USD", value } },
        },
      },
      cart_expiry: new Date(Date.now() + this.o.cartTtlSeconds * 1000).toISOString(),
      merchant_name: this.api.creds.merchantName,
    };
  }

  async open(order: HspOrder): Promise<OpenedOrder> {
    const base = hspCartMandateId(this.o.chainId, order.payTo, order.epoch, order.agentId);
    const cartMandateId = order.attempt > 0 ? `${base}-R${order.attempt}` : base;
    const paymentRequestId = hspPaymentRequestId(order.orderRef, order.attempt);
    const contents = this.cartContents(order, cartMandateId, paymentRequestId);
    const cartMandate = { contents, merchant_authorization: merchantAuthorization(contents, this.api.creds.merchantName, this.api.creds.merchantKey) };
    let data;
    try {
      data = await this.api.createOrder(cartMandate, this.o.redirectUrl);
    } catch (err) {
      const code = (err as HspApiError).code;
      if (code !== undefined && ID_TAKEN.has(code)) throw new HspOrderIdTaken(`HSP already has order ${cartMandateId}: ${(err as Error).message}`);
      throw err;
    }
    return {
      cartMandateId,
      paymentRequestId: data.payment_request_id ?? paymentRequestId,
      flowId: data.flow_id ?? flowIdFromUrl(data.payment_url),
      paymentUrl: data.payment_url ?? null,
      request: cartMandate,
    };
  }

  async verify(order: HspOrder, cartMandateId: string, report: PaymentReport | null): Promise<HspVerification> {
    const none = { paymentId: null, txHash: null, receipt: null, receiptHash: null };
    let records: HspPaymentRecord[];
    try {
      records = await this.api.payments({ cart_mandate_id: cartMandateId });
    } catch (err) {
      const e = err as HspApiError;
      return { ...none, outcome: e.retryable ? "RETRYABLE" : "PERMANENT", status: "unknown", reason: e.message };
    }
    // newest first; prefer the attempt the debtor reported
    const rec =
      records.find((r) => report?.paymentDetailsId && hspRecordRequestId(r) === report.paymentDetailsId) ??
      records.find((r) => hspStatusClass(r.status) === "success") ??
      records[0];
    if (!rec) return { ...none, outcome: "RETRYABLE", status: "payment-required", reason: "HSP has no payment for this order yet" };
    const base = { paymentId: rec.payment_request_id ?? null, txHash: (rec.tx_signature as Hex | null) ?? null, receipt: rec, receiptHash: null };
    const cls = hspStatusClass(rec.status);
    if (cls === "pending" || cls === "unknown") return { ...base, outcome: "RETRYABLE", status: rec.status, reason: `HSP status ${rec.status}` };
    if (cls === "failed") return { ...base, outcome: "PERMANENT", status: rec.status, reason: rec.status_reason ?? "HSP reported the payment failed" };

    // HSP says safe. Bind its record to this debt, then check the chain ourselves.
    const mismatch = this.recordMismatch(rec, order, cartMandateId);
    if (mismatch) return { ...base, outcome: "POLICY", status: rec.status, reason: mismatch };
    const tx = rec.tx_signature as Hex | undefined;
    if (!tx || !/^0x[0-9a-fA-F]{64}$/.test(tx)) return { ...base, outcome: "RETRYABLE", status: rec.status, reason: "HSP has not returned the settlement transaction yet" };
    const t = await checkTransfer(this.client, tx, order.token, order.payer, order.payTo, order.amount, order.orderRef);
    if (!t.ok) return { ...base, outcome: t.retryable ? "RETRYABLE" : "POLICY", status: rec.status, reason: t.reason };
    return { ...base, outcome: "ACCEPT", status: rec.status, txHash: tx, receiptHash: keccak256(stringToHex(hspCanonical(rec))) };
  }

  /** HSP's own record must describe this debt: order, payee, token and order amount. Fields it leaves out are not held against it. */
  private recordMismatch(rec: HspPaymentRecord, order: HspOrder, cartMandateId: string): string | null {
    const cartId = hspRecordCartId(rec);
    if (cartId && cartId !== cartMandateId) return "HSP record is for another order";
    const payee = rec.to_pay_address ?? rec.pay_to;
    if (payee && !sameAddress(payee, order.payTo)) return `HSP paid ${payee}, not the clearing pool`;
    if (rec.token_address && !sameAddress(rec.token_address, order.token)) return `HSP settled in ${rec.token_address}, not the settlement token`;
    if (rec.order_amount) {
      let units: bigint | null;
      try {
        units = decimalToUnits(rec.order_amount, this.o.decimals);
      } catch {
        units = null;
      }
      if (units !== order.amount) return `HSP order amount ${rec.order_amount} is not the debt ${unitsToDecimal(order.amount, this.o.decimals)}`;
    }
    return null;
  }
}

function sameAddress(a: string, b: Address): boolean {
  try {
    return isAddressEqual(a as Address, b);
  } catch {
    return false;
  }
}

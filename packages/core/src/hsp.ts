import { encodeAbiParameters, keccak256, sha256, stringToHex, type Address, type Hex } from "viem";

/**
 * HSP (HashKey Settlement Protocol) wire objects, as the HashKey Merchant API defines them
 * and as the HSP integrations published on GitHub use them (AP2 mandates over x402):
 *
 *   1. the merchant (Kohaku's clearing service) opens an order: an AP2 **cart mandate** whose
 *      contents name the token, the payee (`pay_to`) and the total, signed by the merchant
 *      with an ES256K JWT that commits to `cart_hash` = sha256(canonical JSON of contents);
 *   2. the payer (the debtor agent) answers with an AP2 **payment mandate**: an x402 v2
 *      payload carrying an EIP-3009 `TransferWithAuthorization` signed by its own wallet,
 *      plus a `user_authorization` JWT binding both mandates' hashes;
 *   3. HSP verifies both, relays the authorization on chain (the payer needs no gas) and
 *      reports the payment's status (`payment-included` → `payment-successful`) by webhook
 *      and on its status endpoint.
 *
 * Kohaku binds each payment to one epoch, one debtor and one exact amount by using the
 * settlement order reference as the EIP-3009 nonce: the token itself then refuses to move
 * money twice for the same debt, and an auditor finds the debt's payment on chain from the
 * `AuthorizationUsed(payer, nonce)` event alone.
 */

export type HspMode = "local" | "merchant";

export const HSP_X402_METHOD = "https://www.x402.org/";
export const HSP_AUDIENCE = "HashkeyMerchant";
export const HSP_X402_VERSION = 2;
/** How long a signed transfer authorization stays valid, as in HSP's checkout. */
export const HSP_AUTHORIZATION_TTL_SECONDS = 300;

export const HSP_SUCCESS_STATUSES = ["payment-successful", "payment-safe", "payment-finalized"] as const;
export const HSP_PENDING_STATUSES = ["payment-required", "payment-submitted", "payment-included"] as const;
export const HSP_FAILED_STATUSES = ["payment-failed"] as const;

export type HspPaymentStatus = (typeof HSP_SUCCESS_STATUSES)[number] | (typeof HSP_PENDING_STATUSES)[number] | (typeof HSP_FAILED_STATUSES)[number];

export function hspStatusClass(status: string | null | undefined): "success" | "pending" | "failed" | "unknown" {
  const s = (status ?? "").toLowerCase();
  if ((HSP_SUCCESS_STATUSES as readonly string[]).includes(s)) return "success";
  if ((HSP_PENDING_STATUSES as readonly string[]).includes(s)) return "pending";
  if ((HSP_FAILED_STATUSES as readonly string[]).includes(s)) return "failed";
  return "unknown";
}

// ------------------------------------------------------------------ canonical hashing

/** Recursively key-sorted JSON (RFC 8785 style), exactly what HSP hashes for cart_hash. */
export function hspCanonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(sortKeys);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = sortKeys((v as Record<string, unknown>)[k]);
  return out;
}

/** sha256 of the canonical JSON, lowercase hex without 0x (HSP's cart_hash format). */
export function hspHash(value: unknown): string {
  return sha256(stringToHex(hspCanonical(value))).slice(2);
}

// ------------------------------------------------------------------ amounts

/** Integer token units → the decimal string HSP carries in `amount.value` (exact, no rounding). */
export function unitsToDecimal(units: bigint, decimals = 6): string {
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  let frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

/** The checkout's conversion back to units. Strict: more decimals than the token has is an error. */
export function decimalToUnits(value: string, decimals = 6): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) throw new Error(`not a decimal amount: ${value}`);
  const frac = m[2] ?? "";
  if (frac.replace(/0+$/, "").length > decimals) throw new Error(`${value} has more than ${decimals} decimals`);
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
}

// ------------------------------------------------------------------ AP2 cart mandate

export interface HspAmount {
  currency: string;
  value: string;
}

export interface HspMethodData {
  supported_methods: string;
  data: {
    x402Version: number;
    network: string;
    chain_id: number;
    contract_address: Address;
    pay_to: Address;
    coin: string;
  };
}

export interface HspCartContents {
  id: string;
  user_cart_confirmation_required: boolean;
  payment_request: {
    method_data: HspMethodData[];
    details: {
      id: string;
      display_items: { label: string; amount: HspAmount }[];
      total: { label: string; amount: HspAmount };
    };
  };
  cart_expiry: string;
  merchant_name: string;
}

export interface HspCartMandate {
  contents: HspCartContents;
  merchant_authorization: string;
}

// ------------------------------------------------------------------ x402 / EIP-3009

export const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export interface Eip3009Authorization {
  from: Address;
  to: Address;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
}

export interface X402Payload {
  x402Version: number;
  payload: { signature: Hex; authorization: Eip3009Authorization };
  accepted: {
    scheme: "exact";
    network: string;
    asset: Address;
    amount: string;
    payTo: Address;
    maxTimeoutSeconds: number;
    extra: { protocol: "eip3009"; name: string; version: string };
  };
}

/** base64(JSON), as HSP's checkout encodes it (btoa: the payload is plain ASCII). */
export function encodeX402(p: X402Payload): string {
  return btoa(JSON.stringify(p));
}

export function decodeX402(b64: string): X402Payload {
  return JSON.parse(atob(b64)) as X402Payload;
}

// ------------------------------------------------------------------ AP2 payment mandate

export interface HspPaymentMandateContents {
  payment_mandate_id: string;
  payment_details_id: string;
  payment_details_total: { label: string; amount: HspAmount; pending: boolean };
  payment_response: {
    request_id: string;
    method_name: string;
    details: { payment_payload: string };
    shipping_address: null;
    shipping_option: null;
    payer_name: null;
    payer_email: null;
    payer_phone: null;
  };
  merchant_agent: string;
  timestamp: string;
}

export interface HspPaymentMandate {
  payment_mandate_contents: HspPaymentMandateContents;
  user_authorization: string;
}

/** One row of HSP's payment status (`GET /api/v1/merchant/payments`, and the webhook body). */
export interface HspPaymentRecord {
  payment_request_id: string;
  cart_mandate_id: string;
  flow_id?: string;
  payment_details_id?: string;
  status: string;
  status_reason?: string | null;
  amount?: string;
  token?: string;
  token_address?: string;
  chain_id?: number;
  payer_address?: string;
  pay_to?: string;
  tx_signature?: string | null;
  payment_url?: string;
  created_at?: string;
  updated_at?: string;
}

/** HSP's payment_details_id: YYYYMMDDHHmmss (UTC) + 6 random digits, as its checkout makes it. */
export function hspPaymentDetailsId(now = new Date(), rand = Math.floor(Math.random() * 1_000_000)): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}${String(rand).padStart(6, "0")}`;
}

// ------------------------------------------------------------------ Kohaku's binding

/**
 * Settlement order reference. Deterministic, so the debtor, the clearing service and an
 * auditor all derive the same value from (chain, clearing house, epoch, agent, amount).
 * Used as the EIP-3009 nonce of the HSP payment: a payment made for another epoch or
 * another amount carries a different nonce and is rejected, and the same debt can never be
 * paid twice.
 */
export function settlementOrderRef(chainId: number, clearingHouse: Address, epoch: bigint, agentId: bigint, amount: bigint): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "uint256" }, { type: "address" }, { type: "uint64" }, { type: "uint256" }, { type: "uint256" }],
      ["kohaku.settlement.v1", BigInt(chainId), clearingHouse, epoch, agentId, amount],
    ),
  );
}

/** HSP cart mandate id for a settlement order: unique per chain, deployment, epoch and debtor. */
export function hspCartMandateId(chainId: number, clearingHouse: Address, epoch: number | bigint, agentId: number | bigint): string {
  return `KOHAKU-${chainId}-${clearingHouse.slice(2, 10).toLowerCase()}-E${epoch}-A${agentId}`;
}

/** HSP payment request id: the order reference itself, so it is recoverable from either side. */
export function hspPaymentRequestId(orderRef: Hex): string {
  return `PAY-REQ-${orderRef.slice(2)}`;
}

export interface SettlementOrder {
  id: string;
  epoch: number;
  agentId: string;
  amount: string;
  token: Address;
  payTo: Address;
  chainId: number;
  orderRef: Hex;
  deadline: number | null;
  hspMode: HspMode;
  /** The open HSP order for this debt; null until the clearing service has opened it. */
  hsp: {
    gatewayUrl: string;
    cartMandateId: string;
    paymentRequestId: string;
    flowId: string | null;
    paymentUrl: string | null;
  } | null;
}

/** What a debtor reports after paying its HSP order. */
export interface PaymentReport {
  cartMandateId: string;
  flowId: string;
  paymentDetailsId?: string;
  /** settlement transaction, if HSP already returned it */
  txHash?: Hex;
}

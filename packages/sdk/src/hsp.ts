import { isAddressEqual, type Account, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { mockUsdcAbi } from "@kohaku/core/abis";
import {
  EIP3009_TYPES,
  HSP_AUTHORIZATION_TTL_SECONDS,
  HSP_X402_METHOD,
  HSP_X402_VERSION,
  decimalToUnits,
  encodeX402,
  hspPaymentDetailsId,
  type HspCartMandate,
  type HspPaymentMandateContents,
  type PaymentReport,
  type SettlementOrder,
  type X402Payload,
} from "@kohaku/core";
import { userAuthorization } from "@kohaku/core/hsp-node";

/** Pays one settlement order through HSP from the agent's own wallet. */
export interface HspPayer {
  pay(order: SettlementOrder): Promise<PaymentReport>;
}

interface TokenDomain {
  name: string;
  version: string;
}

/**
 * Pays an HSP order the way HSP's own checkout does, with no human and no gas:
 *
 *   1. read the cart mandate HSP holds for the order's flow, and refuse to pay unless it is
 *      exactly this debt (payee = clearing pool, token, chain, amount, order id);
 *   2. sign an EIP-3009 TransferWithAuthorization for that amount whose nonce is the
 *      settlement order reference, so it can settle this one debt and nothing else;
 *   3. wrap it as an x402 v2 payload in an AP2 payment mandate, add the user_authorization
 *      JWT that binds both mandates, and submit it to HSP's pay-mandate endpoint.
 *
 * HSP relays the authorization on chain. The same code pays HashKey Merchant (HSP_MODE=
 * merchant) and Kohaku's local gateway (HSP_MODE=local), which serve the same API.
 */
export class MerchantHspPayer implements HspPayer {
  private domains = new Map<string, TokenDomain>();

  constructor(
    private readonly wallet: WalletClient,
    private readonly publicClient: PublicClient,
    private readonly account: Account,
    /** where to reach HSP's payment endpoints for an order */
    private readonly gatewayFor: (order: SettlementOrder) => string,
  ) {}

  async pay(order: SettlementOrder): Promise<PaymentReport> {
    if (!order.hsp?.flowId) throw new Error("the HSP order for this debt is not open yet");
    const base = this.gatewayFor(order).replace(/\/+$/, "");
    const flowId = order.hsp.flowId;

    // 1. the cart we are asked to pay must be exactly this debt
    const flow = await hspGet<{ cartmandate?: HspCartMandate; cart_mandate?: HspCartMandate; order_detail?: { cartmandate?: HspCartMandate } }>(
      `${base}/api/v1/payment/cart-mandate/flow/${encodeURIComponent(flowId)}`,
    );
    const cart = flow.cartmandate ?? flow.cart_mandate ?? flow.order_detail?.cartmandate;
    if (!cart?.contents) throw new Error("HSP returned no cart mandate for this flow");
    const c = cart.contents;
    const method = c.payment_request.method_data.find((m) => m.supported_methods === HSP_X402_METHOD && m.data.chain_id === order.chainId);
    if (!method) throw new Error("cart has no x402 method for this chain");
    const amount = BigInt(order.amount);
    const problems = [
      [c.id === order.hsp.cartMandateId, "cart id is not this debt's order"],
      [isAddressEqual(method.data.pay_to, order.payTo), "cart does not pay the clearing pool"],
      [isAddressEqual(method.data.contract_address, order.token), "cart asks for a different token"],
      [decimalToUnits(c.payment_request.details.total.amount.value) === amount, "cart total is not the net debt"],
      [new Date(c.cart_expiry).getTime() > Date.now(), "cart expired"],
    ].filter(([ok]) => !ok);
    if (problems.length) throw new Error(`refusing to pay HSP order ${c.id}: ${problems.map(([, why]) => why).join("; ")}`);

    // 2. EIP-3009 authorization, nonce = settlement order reference
    const domain = await this.tokenDomain(base, order.token, order.chainId);
    const now = Math.floor(Date.now() / 1000);
    const authorization = {
      from: this.account.address,
      to: method.data.pay_to,
      value: amount.toString(),
      validAfter: String(now - 30),
      validBefore: String(now + HSP_AUTHORIZATION_TTL_SECONDS),
      nonce: order.orderRef,
    };
    const signature = await this.wallet.signTypedData({
      account: this.account,
      domain: { ...domain, chainId: order.chainId, verifyingContract: order.token },
      types: EIP3009_TYPES,
      primaryType: "TransferWithAuthorization",
      message: { ...authorization, value: amount, validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore) },
    });
    const x402: X402Payload = {
      x402Version: method.data.x402Version ?? HSP_X402_VERSION,
      payload: { signature, authorization },
      accepted: {
        scheme: "exact",
        network: `eip155:${order.chainId}`,
        asset: order.token,
        amount: amount.toString(),
        payTo: method.data.pay_to,
        maxTimeoutSeconds: 3600,
        extra: { protocol: "eip3009", name: domain.name, version: domain.version },
      },
    };

    // 3. AP2 payment mandate + user authorization, submitted to HSP
    const total = c.payment_request.details.total;
    const contents: HspPaymentMandateContents = {
      payment_mandate_id: c.payment_request.details.id,
      payment_details_id: hspPaymentDetailsId(),
      payment_details_total: { label: total.label, amount: total.amount, pending: false },
      payment_response: {
        request_id: c.payment_request.details.id,
        method_name: HSP_X402_METHOD,
        details: { payment_payload: encodeX402(x402) },
        shipping_address: null,
        shipping_option: null,
        payer_name: null,
        payer_email: null,
        payer_phone: null,
      },
      merchant_agent: "HashkeyMerchant",
      timestamp: new Date().toISOString(),
    };
    const user_authorization = userAuthorization({
      payer: this.account.address,
      cartContents: c,
      paymentContents: contents,
      expiresAt: Math.floor(new Date(c.cart_expiry).getTime() / 1000),
    });
    const res = await hspPost<{ tx_signature?: string; payment_details_id?: string }>(`${base}/api/v1/payment/pay-mandate`, {
      flow_id: flowId,
      payment_mandate: { payment_mandate_contents: contents, user_authorization },
    });
    const tx = res?.tx_signature;
    return {
      cartMandateId: c.id,
      flowId,
      paymentDetailsId: res?.payment_details_id ?? contents.payment_details_id,
      ...(tx && /^0x[0-9a-fA-F]{64}$/.test(tx) ? { txHash: tx as Hex } : {}),
    };
  }

  /** The token's EIP-712 domain, from HSP's chain config or else from the token itself. */
  private async tokenDomain(base: string, token: Address, chainId: number): Promise<TokenDomain> {
    const key = `${chainId}:${token.toLowerCase()}`;
    const hit = this.domains.get(key);
    if (hit) return hit;
    let found: TokenDomain | null = null;
    try {
      const cfg = await hspGet<unknown>(`${base}/api/v1/payment/chain-config`);
      const chains = (Array.isArray(cfg) ? cfg : ((cfg as { chains?: unknown[] })?.chains ?? [])) as { chain_id?: number; tokens?: { address?: string; name?: string; version?: string }[] }[];
      const t = chains.find((ch) => ch.chain_id === chainId)?.tokens?.find((t) => t.address && isAddressEqual(t.address as Address, token));
      if (t?.name && t.version) found = { name: t.name, version: t.version };
    } catch {
      // fall back to the token contract
    }
    if (!found) {
      const name = (await this.publicClient.readContract({ address: token, abi: mockUsdcAbi, functionName: "name" })) as string;
      const version = (await this.publicClient.readContract({ address: token, abi: mockUsdcAbi, functionName: "version" }).catch(() => "2")) as string;
      found = { name, version };
    }
    this.domains.set(key, found);
    return found;
  }
}

export class HspRequestError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

async function hspGet<T>(url: string): Promise<T> {
  return unwrap<T>(await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) }), url);
}

async function hspPost<T>(url: string, body: unknown): Promise<T> {
  return unwrap<T>(
    await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) }),
    url,
  );
}

async function unwrap<T>(res: Response, url: string): Promise<T> {
  const text = await res.text();
  let j: { code?: number; msg?: string; message?: string; data?: T };
  try {
    j = JSON.parse(text);
  } catch {
    throw new HspRequestError(`HSP ${new URL(url).pathname}: HTTP ${res.status}, not JSON`);
  }
  if (!res.ok || (j.code !== undefined && j.code !== 0)) throw new HspRequestError(`HSP ${new URL(url).pathname}: ${j.msg ?? j.message ?? `HTTP ${res.status}`}`, j.code);
  return j.data as T;
}

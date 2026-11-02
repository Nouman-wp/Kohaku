import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { getAddress, isAddress, isAddressEqual, recoverTypedDataAddress, type Hex } from "viem";
import type { SpecSheet } from "./specs.ts";
import type { StoreSlug } from "./catalogue.ts";
import { HspToolError, type HspAgentic, type HspPrepared } from "./hsp-agentic.ts";

export interface ShopJob {
  jobId: string;
  at: number;
  buyer: string;
  seller: string;
  service: string;
  price: string;
  epoch: number;
  parentJobId: string | null;
}

export interface ShopOffer {
  store: StoreSlug;
  storeName: string;
  price: number;
  stock: number;
  deliveryDays: number;
  coupon: { code: string; discount: number; description: string } | null;
  final: number;
}

export interface ShopOption {
  rank: number;
  modelId: string;
  name: string;
  brand: string;
  specs: SpecSheet | null;
  best: ShopOffer;
  offers: ShopOffer[];
  withinBudget: boolean;
}

export interface CartLine {
  modelId: string;
  name: string;
  store: StoreSlug;
  storeName: string;
  price: number;
  coupon: string | null;
  discount: number;
  total: number;
}

export interface Cart {
  store: StoreSlug;
  storeName: string;
  storeAgentId: string;
  payTo: string;
  lines: CartLine[];
  subtotal: number;
  discount: number;
  total: number;
  /** what the checkout charges through HSP on testnet: a pre-booking amount */
  depositUsd: string;
  addedAt: number;
}

export type CheckoutStatus =
  | "awaiting-signature"
  | "signed"
  | "quote-expired"
  | "payment-submitted"
  | "payment-verified"
  | "payment-processing"
  | "payment-timeout"
  | "payment-included"
  | "payment-safe"
  | "payment-finalized"
  | "payment-failed"
  | "error";

export interface Checkout {
  status: CheckoutStatus;
  merchantName: string;
  payTo: string;
  payer: string;
  amountUsd: string;
  token: { address: string; symbol: string; decimals: number; protocol: string };
  network: { chainId: number; name: string; displayName: string };
  orderId: string;
  flowId: string;
  paymentRequestId: string;
  paymentUrl: string | null;
  tokenTotalRaw: string | null;
  quoteExpiresAt: string | null;
  gasFeeAdvanced: boolean | null;
  txHash: string | null;
  attributionVerified: boolean | null;
  statusReason: string | null;
  /** the server may simulate submission when the payer cannot fund the quote (SHOP_SIMULATE_UNFUNDED) */
  simulationAllowed: boolean;
  /** true once the submission and confirmations are simulated: nothing reached HSP's gateway */
  simulated: boolean;
  history: { at: number; status: string; note: string }[];
}

export interface ShopSession {
  id: string;
  createdAt: number;
  updatedAt: number;
  need: string;
  budgetUsd: number | null;
  buyer: { agentId: string; name: string } | null;
  rootJobId: string | null;
  status: "researching" | "ready" | "failed";
  error: string | null;
  steps: { at: number; agent: string; text: string }[];
  jobs: ShopJob[];
  options: ShopOption[];
  summary: string | null;
  cart: Cart | null;
  checkout: Checkout | null;
}

/** Server-side HSP payloads, never served over the public API. */
interface Private {
  prepared?: HspPrepared;
  paymentMandateJson?: string;
}

const FINAL = new Set<CheckoutStatus>(["payment-safe", "payment-finalized", "payment-failed"]);

export class CheckoutError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/**
 * Shopping sessions: what the Concierge researched, every paid job it caused, the cart the
 * buyer's agent filled, and the HSP Agentic Payment checkout. Persisted to one JSON file so
 * a restart keeps the demo screen and resumes payment polling.
 */
export class ShopBook {
  private sessions: ShopSession[] = [];
  private secret = new Map<string, Private>();
  private polls = new Map<string, NodeJS.Timeout>();
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly file: string,
    private readonly hsp: HspAgentic,
    private readonly opts: {
      chainId: number;
      tokenSymbol: string;
      depositUsd: string;
      log: (m: string) => void;
      simulateUnfunded: boolean;
      balanceOf: (token: string, who: string) => Promise<bigint>;
    },
  ) {
    if (existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, "utf8")) as { sessions?: ShopSession[]; secret?: Record<string, Private> };
        this.sessions = raw.sessions ?? [];
        for (const [k, v] of Object.entries(raw.secret ?? {})) this.secret.set(k, v);
      } catch (err) {
        opts.log(`could not read ${file}: ${(err as Error).message}`);
      }
    }
    for (const s of this.sessions) {
      if (s.status === "researching") {
        s.status = "failed";
        s.error = "interrupted by a restart";
      }
      if (s.checkout?.simulated && this.isPending(s.checkout.status)) this.finishSimulation(s.id);
      else if (s.checkout && this.isPending(s.checkout.status)) this.poll(s.id);
    }
  }

  get merchantName(): string {
    return this.hsp.merchantName;
  }

  // ------------------------------------------------------------ sessions

  create(need: string, budgetUsd: number | null, buyer: ShopSession["buyer"], rootJobId: string | null): ShopSession {
    const s: ShopSession = {
      id: `shop_${randomBytes(6).toString("hex")}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      need,
      budgetUsd,
      buyer,
      rootJobId,
      status: "researching",
      error: null,
      steps: [],
      jobs: [],
      options: [],
      summary: null,
      cart: null,
      checkout: null,
    };
    this.sessions.unshift(s);
    while (this.sessions.length > 40) {
      const old = this.sessions.pop()!;
      this.secret.delete(old.id);
    }
    this.save();
    return s;
  }

  get(id: string): ShopSession | undefined {
    return this.sessions.find((s) => s.id === id);
  }

  latest(): ShopSession | undefined {
    return this.sessions[0];
  }

  list(): ShopSession[] {
    return this.sessions;
  }

  step(id: string, agent: string, text: string): void {
    const s = this.get(id);
    if (!s) return;
    s.steps.push({ at: Date.now(), agent, text });
    this.touch(s);
  }

  job(id: string, j: ShopJob): void {
    const s = this.get(id);
    if (!s) return;
    s.jobs.push(j);
    this.touch(s);
  }

  touch(s: ShopSession): void {
    s.updatedAt = Date.now();
    this.save();
  }

  /** The public view: no HSP payloads. */
  view(s: ShopSession): ShopSession {
    return s;
  }

  // ------------------------------------------------------------ cart

  addToCart(id: string, line: CartLine, store: { agentId: string; address: string }): Cart {
    const s = this.get(id);
    if (!s) throw new CheckoutError("unknown shopping session", 404);
    if (s.checkout && !["error", "quote-expired", "awaiting-signature", "signed"].includes(s.checkout.status)) {
      throw new CheckoutError("this cart is already paid for; start a new shopping session");
    }
    if (s.cart && s.cart.store !== line.store) {
      // one store per order, like a real checkout
      s.cart = null;
    }
    const lines = [...(s.cart?.lines ?? []).filter((l) => l.modelId !== line.modelId), line];
    const subtotal = round2(lines.reduce((a, l) => a + l.price, 0));
    const discount = round2(lines.reduce((a, l) => a + l.discount, 0));
    s.cart = {
      store: line.store,
      storeName: line.storeName,
      storeAgentId: store.agentId,
      payTo: getAddress(store.address),
      lines,
      subtotal,
      discount,
      total: round2(subtotal - discount),
      depositUsd: this.opts.depositUsd,
      addedAt: Date.now(),
    };
    s.checkout = null;
    this.secret.delete(s.id);
    this.step(s.id, line.storeName, `added ${line.name} to the cart at $${line.total.toFixed(2)}${line.coupon ? ` with ${line.coupon}` : ""}`);
    return s.cart;
  }

  // ------------------------------------------------------------ checkout through HSP Agentic Payment

  /**
   * Create the HSP order (once) and lock a quote for the payer. The caller has confirmed
   * merchant_name, pay_to and the payer with the user one at a time, as HSP requires; this
   * checks that what it confirmed is exactly this cart's merchant, store wallet and payer.
   */
  async prepare(id: string, confirmed: { merchantName: string; payTo: string; payer: string }): Promise<{ checkout: Checkout; eip712: HspPrepared["eip712"] }> {
    const s = this.get(id);
    if (!s) throw new CheckoutError("unknown shopping session", 404);
    if (!s.cart) throw new CheckoutError("the cart is empty; add an item first");
    if (confirmed.merchantName !== this.merchantName) throw new CheckoutError(`merchant_name must be exactly "${this.merchantName}"`);
    if (!isAddress(confirmed.payTo) || !isAddressEqual(confirmed.payTo, s.cart.payTo as Hex)) throw new CheckoutError(`pay_to must be ${s.cart.storeName}'s wallet ${s.cart.payTo}`);
    if (!isAddress(confirmed.payer)) throw new CheckoutError("payer must be a 0x address");
    if (isAddressEqual(confirmed.payer, s.cart.payTo as Hex)) throw new CheckoutError("the payer cannot be the recipient");
    if (s.checkout && !["awaiting-signature", "signed", "quote-expired", "error"].includes(s.checkout.status)) {
      throw new CheckoutError(`this order is already ${s.checkout.status}`);
    }
    const payer = getAddress(confirmed.payer);
    const { token, network } = await this.hsp.token(this.opts.chainId, this.opts.tokenSymbol);
    let c = s.checkout;
    if (c && !isAddressEqual(c.payer as Hex, payer)) c = null; // a different payer needs a fresh order
    if (!c || c.status === "error") {
      const suffix = randomBytes(3).toString("hex");
      const orderId = `KOHAKU-${s.id.slice(5)}-${suffix}`;
      const amount = this.opts.depositUsd;
      const label = `Pre-booking: ${s.cart.lines.map((l) => l.name).join(", ")} at ${s.cart.storeName}`;
      const cartMandate = {
        contents: {
          id: orderId,
          user_cart_confirmation_required: true,
          cart_expiry: new Date(Date.now() + 30 * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
          payment_request: {
            method_data: [
              {
                supported_methods: "https://www.x402.org/",
                data: { x402Version: 2, network: network.name, chain_id: network.chain_id, contract_address: token.address, pay_to: s.cart.payTo, coin: token.symbol },
              },
            ],
            details: {
              id: `PAY-${s.id.slice(5)}-${suffix}`,
              display_items: [{ label: label.slice(0, 120), amount: { currency: "USD", value: amount } }],
              total: { label: "Total", amount: { currency: "USD", value: amount } },
            },
          },
        },
      };
      const order = await this.hsp.createOrder(s.cart.payTo, cartMandate);
      const detail = await this.hsp.getOrder(order.flow_id).catch(() => null);
      c = {
        status: "awaiting-signature",
        merchantName: this.merchantName,
        payTo: s.cart.payTo,
        payer,
        amountUsd: amount,
        token: { address: token.address, symbol: token.symbol, decimals: token.decimals, protocol: token.payment_protocol },
        network: { chainId: network.chain_id, name: network.name, displayName: network.display_name },
        orderId,
        flowId: order.flow_id,
        paymentRequestId: order.payment_request_id,
        paymentUrl: order.payment_url ?? null,
        tokenTotalRaw: null,
        quoteExpiresAt: null,
        gasFeeAdvanced: findBool(detail, "gas_fee_advanced"),
        txHash: null,
        attributionVerified: null,
        statusReason: null,
        simulationAllowed: this.opts.simulateUnfunded,
        simulated: false,
        history: [{ at: Date.now(), status: "order-created", note: `HSP order ${order.flow_id} for $${amount} to ${s.cart.storeName}` }],
      };
      s.checkout = c;
      this.step(s.id, "HSP", `order created for $${amount} (flow ${order.flow_id})`);
    }
    const prepared = await this.hsp.preparePayment(c.flowId, payer, c.token.protocol);
    this.secret.set(s.id, { prepared });
    c.status = "awaiting-signature";
    c.tokenTotalRaw = String(prepared.token_total_raw);
    c.quoteExpiresAt = prepared.quote_expires_at ?? null;
    c.statusReason = null;
    if (prepared.pay_to && !isAddressEqual(prepared.pay_to as Hex, c.payTo as Hex)) throw new CheckoutError("HSP quoted a different recipient; refusing");
    c.history.push({ at: Date.now(), status: "quote-locked", note: `${c.tokenTotalRaw} raw ${c.token.symbol} until ${c.quoteExpiresAt ?? "?"}` });
    this.step(s.id, "HSP", `quote locked: ${formatRaw(c.tokenTotalRaw, c.token.decimals)} ${c.token.symbol}, waiting for the payer's approval`);
    this.touch(s);
    return { checkout: c, eip712: prepared.eip712 };
  }

  /** The buyer's wallet signed the eip712 locally; HSP builds the payment mandate. */
  async finalize(id: string, signature: Hex): Promise<Checkout> {
    const s = this.get(id);
    const c = s?.checkout;
    const p = this.secret.get(id)?.prepared;
    if (!s || !c || !p) throw new CheckoutError("no prepared payment for this session; run checkout first");
    if (c.status !== "awaiting-signature") throw new CheckoutError(`the payment is ${c.status}, not awaiting a signature`);
    if (c.quoteExpiresAt && Date.parse(c.quoteExpiresAt) < Date.now()) {
      c.status = "quote-expired";
      this.touch(s);
      throw new CheckoutError("the 5-minute HSP quote expired; run checkout again for a fresh quote");
    }
    const types = { ...p.eip712.types } as Record<string, { name: string; type: string }[]>;
    delete types.EIP712Domain;
    const signer = await (recoverTypedDataAddress as (a: Record<string, unknown>) => Promise<Hex>)({
      domain: p.eip712.domain,
      types,
      primaryType: p.eip712.primaryType,
      message: p.eip712.message,
      signature,
    });
    if (!isAddressEqual(signer, c.payer as Hex)) throw new CheckoutError(`signature is from ${signer}, not the confirmed payer ${c.payer}`);
    let mandate: string;
    try {
      const out = await this.hsp.finalizePayment({
        signature,
        payment_payload: p.payment_payload,
        payment_mandate_contents: p.payment_mandate_contents,
        cart_hash: p.cart_hash,
      });
      if (!out.payment_mandate_json) throw new CheckoutError("HSP returned no payment mandate", 502);
      mandate = typeof out.payment_mandate_json === "string" ? out.payment_mandate_json : JSON.stringify(out.payment_mandate_json);
    } catch (err) {
      if (!(await this.simulating(c))) throw err;
      mandate = "simulated";
      c.history.push({ at: Date.now(), status: "note", note: `HSP finalize_payment refused (${(err as Error).message.slice(0, 120)}); continuing as a simulation` });
    }
    this.secret.set(id, { prepared: p, paymentMandateJson: mandate });
    c.status = "signed";
    c.history.push({ at: Date.now(), status: "signed", note: `signed by ${c.payer}` });
    this.step(s.id, "HSP", "payment mandate built from the payer's signature; waiting for approval to submit");
    this.touch(s);
    return c;
  }

  async submit(id: string): Promise<Checkout> {
    const s = this.get(id);
    const c = s?.checkout;
    const json = this.secret.get(id)?.paymentMandateJson;
    if (!s || !c || !json) throw new CheckoutError("nothing to submit; approve the payment first");
    if (c.status !== "signed") throw new CheckoutError(`the payment is ${c.status}`);
    if (json === "simulated" || (await this.simulating(c))) {
      this.simulate(id);
      this.touch(s);
      return c;
    }
    try {
      const r = await this.hsp.submitPayment(json);
      const status = (findString(r, "status") as CheckoutStatus | null) ?? "payment-submitted";
      c.status = status;
      c.history.push({ at: Date.now(), status, note: "submitted to HSP" });
      this.step(s.id, "HSP", `payment ${status}`);
      this.poll(id);
    } catch (err) {
      if (err instanceof HspToolError && err.code === 30043) {
        c.status = "quote-expired";
        c.statusReason = "HSP 30043: quote expired or changed; run checkout again and re-sign";
      } else {
        c.status = "error";
        c.statusReason = (err as Error).message.slice(0, 300);
      }
      c.history.push({ at: Date.now(), status: c.status, note: c.statusReason ?? "" });
      this.touch(s);
      throw err;
    }
    this.touch(s);
    return c;
  }

  /** Simulation only when it is allowed and the payer really cannot cover HSP's quote. */
  private async simulating(c: Checkout): Promise<boolean> {
    if (!this.opts.simulateUnfunded || !c.tokenTotalRaw) return false;
    const bal = await this.opts.balanceOf(c.token.address, c.payer).catch(() => 0n);
    return bal < BigInt(c.tokenTotalRaw);
  }

  /**
   * A labelled stand-in for HSP's gateway while the payer holds no HSP test USDC: the order,
   * quote and signature above are real; the submission and confirmations are not, and every
   * status says so. No transaction hash is invented.
   */
  private simulate(id: string): void {
    const s = this.get(id);
    const c = s?.checkout;
    if (!s || !c) return;
    c.simulated = true;
    c.txHash = null;
    c.statusReason = "Simulated: the payer holds no HSP test USDC yet, so nothing was submitted to HSP's gateway and no transaction exists.";
    const steps: [number, CheckoutStatus][] = [
      [0, "payment-submitted"],
      [2_500, "payment-verified"],
      [5_000, "payment-processing"],
      [9_000, "payment-included"],
      [14_000, "payment-safe"],
      [20_000, "payment-finalized"],
    ];
    const apply = (status: CheckoutStatus) => {
      const cur = this.get(id)?.checkout;
      if (!cur || !cur.simulated) return;
      cur.status = status;
      cur.history.push({ at: Date.now(), status, note: "simulated" });
      this.step(id, "HSP (simulated)", `payment ${status}`);
    };
    apply(steps[0]![1]);
    for (const [delay, status] of steps.slice(1)) {
      setTimeout(() => {
        apply(status);
      }, delay);
    }
  }

  private finishSimulation(id: string): void {
    const c = this.get(id)?.checkout;
    if (!c) return;
    c.status = "payment-finalized";
    c.history.push({ at: Date.now(), status: "payment-finalized", note: "simulated (completed after a restart)" });
  }

  /** query_payment every 15 s until safe, finalized or failed (HSP's guide). */
  private poll(id: string): void {
    if (this.polls.has(id)) return;
    const started = Date.now();
    const tick = async () => {
      const s = this.get(id);
      const c = s?.checkout;
      if (!s || !c || !this.isPending(c.status) || Date.now() - started > 60 * 60_000) {
        this.stopPoll(id);
        return;
      }
      try {
        const q = await this.hsp.queryPayment({ flowId: c.flowId, paymentRequestId: c.paymentRequestId });
        const status = (q.payment?.status ?? q.status) as CheckoutStatus | undefined;
        if (typeof q.attribution_verified === "boolean") c.attributionVerified = q.attribution_verified;
        const tx = q.payment?.tx_signature;
        if (tx) c.txHash = tx;
        if (q.payment?.status_reason) c.statusReason = String(q.payment.status_reason);
        if (status && status !== c.status) {
          c.status = status;
          c.history.push({ at: Date.now(), status, note: tx ? `tx ${tx}` : "" });
          this.step(id, "HSP", `payment ${status}${tx ? ` (tx ${tx.slice(0, 10)}…)` : ""}`);
        }
        this.touch(s);
        if (FINAL.has(c.status)) this.stopPoll(id);
      } catch (err) {
        this.opts.log(`query_payment for ${id} failed: ${(err as Error).message}`);
      }
    };
    this.polls.set(id, setInterval(() => void tick(), 15_000));
    setTimeout(() => void tick(), 4_000);
  }

  private stopPoll(id: string): void {
    const t = this.polls.get(id);
    if (t) clearInterval(t);
    this.polls.delete(id);
  }

  private isPending(status: CheckoutStatus): boolean {
    return status.startsWith("payment-") && !FINAL.has(status);
  }

  // ------------------------------------------------------------ persistence

  private save(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        mkdirSync(dirname(this.file), { recursive: true });
        writeFileSync(this.file, JSON.stringify({ sessions: this.sessions, secret: Object.fromEntries(this.secret) }));
      } catch (err) {
        this.opts.log(`could not save shop sessions: ${(err as Error).message}`);
      }
    }, 500);
  }
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function formatRaw(raw: string | null, decimals: number): string {
  if (!raw) return "?";
  const v = BigInt(raw);
  const d = 10n ** BigInt(decimals);
  const frac = (v % d).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${v / d}${frac ? `.${frac}` : ""}`;
}

function findBool(obj: unknown, key: string, depth = 0): boolean | null {
  if (!obj || typeof obj !== "object" || depth > 5) return null;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (k === key && typeof v === "boolean") return v;
    const inner = findBool(v, key, depth + 1);
    if (inner !== null) return inner;
  }
  return null;
}

function findString(obj: unknown, key: string, depth = 0): string | null {
  if (!obj || typeof obj !== "object" || depth > 4) return null;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (k === key && typeof v === "string") return v;
  }
  for (const v of Object.values(obj as Record<string, unknown>)) {
    const inner = findString(v, key, depth + 1);
    if (inner) return inner;
  }
  return null;
}

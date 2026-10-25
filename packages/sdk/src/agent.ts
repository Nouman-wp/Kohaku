import { randomUUID } from "node:crypto";
import {
  createPublicClient,
  createWalletClient,
  http,
  isAddressEqual,
  recoverTypedDataAddress,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type TypedDataDomain,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  CHAINS,
  DELIVERY_TYPES,
  DISPUTE_TYPES,
  IOU_TYPES,
  KOHAKU_PRICING_EXTENSION,
  QUOTE_TYPES,
  VERDICT_TYPES,
  chainKeyFromId,
  disputeDigest,
  hashJson,
  iouDigest,
  jobHash,
  nonceManager,
  routeUrl,
  quoteDigest,
  usd,
  type A2AAgentCard,
  type AgentSummary,
  type Delivery,
  type Erc8004Registration,
  type IOU,
  type JobSpec,
  type PaymentReport,
  type Quote,
  type ServiceListing,
} from "@kohaku/core";
import { identityRegistryAbi, validationRegistryAbi } from "@kohaku/core/abis";
import { ClearingClient, type ClearingConfig } from "./client.ts";
import { HspRequestError, MerchantHspPayer, type HspPayer } from "./hsp.ts";

export interface JobContext {
  jobId: string;
  buyer: string;
  service: string;
  spec: JobSpec;
  agent: KohakuAgent;
}

export interface ServiceDef<I = unknown, O = unknown> {
  id: string;
  name: string;
  description: string;
  /** Price per call: base units as bigint, or a decimal string like "0.0004". */
  price: bigint | string;
  unit: string;
  tags?: string[];
  examples?: string[];
  handler: (input: I, ctx: JobContext) => Promise<O>;
  /** Optional dynamic pricing; the quote is binding once signed. */
  priceFor?: (input: I) => bigint;
}

export interface AgentProfile {
  slug: string;
  name: string;
  description: string;
  role: string;
  /** Public base URL where this agent's A2A endpoints are mounted. */
  baseUrl: string;
  image?: string;
  validator?: boolean;
  fleet?: boolean;
  organization?: string;
}

export interface PreparedJob {
  jobId: string;
  iouDigest: Hex;
  epoch: number;
  price: bigint;
  seller: AgentSummary;
  jobSpec: JobSpec;
  service: string;
}

export interface HireResult<O = unknown> extends PreparedJob {
  result: O;
  delivery: Record<keyof Delivery, string>;
}

export class RefusedError extends Error {
  constructor(readonly reason: string) {
    super(`refused by clearing: ${reason}`);
  }
}

type Str<T> = { [K in keyof T]: string };

const strs = <T extends object>(o: T): Str<T> =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : String(v)])) as Str<T>;

/**
 * A Kohaku agent: one signing wallet, one on-chain identity, any number of services sold,
 * and the ability to hire other agents. Every money movement goes through signed IOUs and
 * the clearing house; debts settle through HSP from this agent's own wallet.
 */
export class KohakuAgent {
  readonly account: Account;
  readonly client: ClearingClient;
  readonly cfg: ClearingConfig;
  readonly domain: TypedDataDomain;
  readonly publicClient: PublicClient;
  readonly wallet: WalletClient;
  readonly chain: Chain;
  agentId: bigint;
  profile: AgentProfile | null = null;
  hsp: HspPayer;
  private services = new Map<string, ServiceDef<never, unknown>>();
  private lastNonce = 0n;
  private epochCache: { epoch: number; intakeEndsAt: number } | null = null;
  private paid = new Map<string, PaymentReport>();
  private settling = false;
  /** public URL prefixes this agent can reach locally (see routeUrl) */
  routes: [string, string][] = [];

  private constructor(opts: { account: Account; client: ClearingClient; cfg: ClearingConfig; rpcUrl: string; agentId: bigint }) {
    this.account = opts.account;
    this.client = opts.client;
    this.cfg = opts.cfg;
    this.agentId = opts.agentId;
    this.domain = opts.cfg.domain;
    const base = CHAINS[chainKeyFromId(opts.cfg.chain.id)];
    this.chain = { ...base, rpcUrls: { default: { http: [opts.rpcUrl] } } };
    this.publicClient = createPublicClient({ chain: this.chain, transport: http(opts.rpcUrl), pollingInterval: this.chain.id === 31337 ? 250 : 1_000 }) as PublicClient;
    this.wallet = createWalletClient({ chain: this.chain, transport: http(opts.rpcUrl), account: this.account, pollingInterval: this.chain.id === 31337 ? 250 : 1_000 });
    // the local HSP gateway lives with the clearing service; HashKey Merchant at its own URL
    this.hsp = new MerchantHspPayer(this.wallet, this.publicClient, this.account, (o) => (o.hspMode === "local" ? `${this.client.baseUrl}/hsp` : o.hsp!.gatewayUrl));
  }

  /** Connect to a clearing service. The agent id is looked up from the identity registry. */
  static async connect(opts: { privateKey: Hex; clearingUrl: string; rpcUrl?: string; agentId?: bigint }): Promise<KohakuAgent> {
    const client = new ClearingClient(opts.clearingUrl);
    const cfg = await client.config();
    const account = privateKeyToAccount(opts.privateKey, { nonceManager });
    const agent = new KohakuAgent({ account, client, cfg, rpcUrl: opts.rpcUrl ?? cfg.chain.rpc, agentId: opts.agentId ?? 0n });
    if (!opts.agentId) agent.agentId = await agent.lookupAgentId();
    return agent;
  }

  get address(): Address {
    return this.account.address;
  }

  async lookupAgentId(): Promise<bigint> {
    return (await this.publicClient.readContract({
      address: this.cfg.deployment.identityRegistry,
      abi: identityRegistryAbi,
      functionName: "agentIdOfSigner",
      args: [this.account.address],
    })) as bigint;
  }

  setProfile(p: AgentProfile): this {
    this.profile = p;
    return this;
  }

  useHsp(payer: HspPayer): this {
    this.hsp = payer;
    return this;
  }

  // =================================================================== seller

  sell<I, O>(def: ServiceDef<I, O>): this {
    this.services.set(def.id, def as unknown as ServiceDef<never, unknown>);
    return this;
  }

  listings(): ServiceListing[] {
    return [...this.services.values()].map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      price: priceUnits(s.price).toString(),
      unit: s.unit,
      tags: s.tags ?? [],
    }));
  }

  /** A2A agent card with Kohaku's pricing extension. */
  card(): A2AAgentCard & { kohaku: Record<string, unknown> } {
    const p = this.requireProfile();
    const prices: Record<string, { price: string; unit: string }> = {};
    for (const s of this.listings()) prices[s.id] = { price: s.price, unit: s.unit };
    return {
      protocolVersion: "0.3.0",
      name: p.name,
      description: p.description,
      url: `${p.baseUrl}/a2a`,
      preferredTransport: "JSONRPC",
      version: "1.0.0",
      provider: { organization: p.organization ?? "Kohaku", url: p.baseUrl },
      capabilities: {
        streaming: false,
        pushNotifications: false,
        extensions: [
          {
            uri: KOHAKU_PRICING_EXTENSION,
            description: "Per-call prices in stablecoin base units; payment by signed IOU cleared on Kohaku.",
            required: true,
            params: {
              agentId: this.agentId.toString(),
              chainId: this.cfg.chain.id,
              clearingHouse: this.cfg.deployment.clearingHouse,
              token: this.cfg.deployment.token,
              clearingApi: this.client.baseUrl,
              prices,
            },
          },
        ],
      },
      defaultInputModes: ["application/json", "text/plain"],
      defaultOutputModes: ["application/json"],
      skills: [...this.services.values()].map((s) => ({ id: s.id, name: s.name, description: s.description, tags: s.tags ?? [], examples: s.examples })),
      kohaku: { slug: p.slug, role: p.role, validator: !!p.validator, fleet: !!p.fleet },
    };
  }

  /** ERC-8004 registration file (what the identity registry's tokenURI points at). */
  registration(): Erc8004Registration & { kohaku: Record<string, unknown> } {
    const p = this.requireProfile();
    return {
      type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
      name: p.name,
      description: p.description,
      image: p.image ?? "",
      endpoints: [
        { name: "A2A", endpoint: `${p.baseUrl}/.well-known/agent-card.json`, version: "0.3.0" },
        { name: "agentWallet", endpoint: `eip155:${this.cfg.chain.id}:${this.account.address}` },
      ],
      registrations: this.agentId
        ? [{ agentId: Number(this.agentId), agentRegistry: `eip155:${this.cfg.chain.id}:${this.cfg.deployment.identityRegistry}` }]
        : [],
      supportedTrust: ["reputation", "crypto-economic", "validation"],
      kohaku: { slug: p.slug, role: p.role, validator: !!p.validator, fleet: !!p.fleet },
    };
  }

  /** Step 1 of a sale: a signed, binding quote for this exact job. */
  async quote(req: { buyer: string; service: string; input: unknown }) {
    const svc = this.services.get(req.service);
    if (!svc) throw new Error(`unknown service ${req.service}`);
    const price = svc.priceFor ? svc.priceFor(req.input as never) : priceUnits(svc.price);
    const jobSpec: JobSpec = {
      buyer: String(req.buyer),
      seller: this.agentId.toString(),
      service: req.service,
      input: req.input,
      requestedAt: Date.now(),
      salt: randomUUID(),
    };
    const quote: Quote = {
      seller: this.agentId,
      buyer: BigInt(req.buyer),
      service: req.service,
      price,
      token: this.cfg.deployment.token,
      jobHash: jobHash(jobSpec),
      expiry: BigInt(Math.floor(Date.now() / 1000) + 120),
      quoteNonce: BigInt(Date.now()),
    };
    const quoteSignature = await this.signTyped("Quote", QUOTE_TYPES, quote);
    return { quote: strs(quote), quoteSignature, jobSpec };
  }

  /** Step 2 of a sale: the clearing house accepted the buyer's IOU; do the work and sign delivery. */
  async execute(req: { jobId: string; jobSpec: JobSpec; iouDigest: Hex }) {
    const jd = await this.client.job(req.jobId);
    if (jd.job.seller !== this.agentId.toString()) throw new Error("job is for another seller");
    if (jd.job.jobHash !== jobHash(req.jobSpec)) throw new Error("job spec does not match the cleared job");
    if (!jd.iou || jd.iou.digest !== req.iouDigest) throw new Error("IOU not cleared for this job");
    if (jd.job.status !== "accepted" && jd.job.status !== "delivered") throw new Error(`job is ${jd.job.status}`);
    const svc = this.services.get(req.jobSpec.service);
    if (!svc) throw new Error(`unknown service ${req.jobSpec.service}`);
    const result = await svc.handler(req.jobSpec.input as never, { jobId: req.jobId, buyer: req.jobSpec.buyer, service: svc.id, spec: req.jobSpec, agent: this });
    const delivery: Delivery = {
      seller: this.agentId,
      jobHash: jd.job.jobHash,
      iouDigest: req.iouDigest,
      resultHash: hashJson(result),
      deliveredAt: BigInt(Date.now()),
    };
    const signature = await this.signTyped("Delivery", DELIVERY_TYPES, delivery);
    await this.client.deliver({ jobId: req.jobId, delivery: strs(delivery), signature, result });
    return { result, delivery: strs(delivery), deliverySignature: signature };
  }

  /** A2A JSON-RPC entry point (`message/send` with a Kohaku data part). */
  async handleA2A(body: { jsonrpc?: string; id?: unknown; method?: string; params?: { message?: { parts?: { kind: string; data?: unknown }[] } } }) {
    const id = body.id ?? null;
    try {
      if (body.method !== "message/send") return { jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } };
      const part = body.params?.message?.parts?.find((p) => p.kind === "data");
      const k = (part?.data as { kohaku?: { action: string } & Record<string, unknown> } | undefined)?.kohaku;
      if (!k) return { jsonrpc: "2.0", id, error: { code: -32602, message: "expected a data part with a `kohaku` object" } };
      let out: unknown;
      if (k.action === "quote") out = await this.quote(k as never);
      else if (k.action === "execute") out = await this.execute(k as never);
      else if (k.action === "card") out = this.card();
      else return { jsonrpc: "2.0", id, error: { code: -32602, message: `unknown action ${k.action}` } };
      return {
        jsonrpc: "2.0",
        id,
        result: { kind: "message", role: "agent", messageId: randomUUID(), parts: [{ kind: "data", data: { kohaku: out } }] },
      };
    } catch (err) {
      return { jsonrpc: "2.0", id, error: { code: -32000, message: (err as Error).message } };
    }
  }

  // =================================================================== buyer

  /** Discover sellers of a capability, cheapest first, then best reputation. */
  async findSellers(service: string, opts: { maxPrice?: bigint; minReputation?: number; exclude?: string[] } = {}): Promise<AgentSummary[]> {
    const list = await this.client.agents({ capability: service, minReputation: opts.minReputation });
    return list
      .filter((a) => a.status === "active" && a.agentId !== this.agentId.toString() && !(opts.exclude ?? []).includes(a.agentId))
      .filter((a) => {
        const s = a.services.find((x) => x.id === service);
        return s && (opts.maxPrice === undefined || BigInt(s.price) <= opts.maxPrice);
      })
      .sort((a, b) => {
        const pa = BigInt(a.services.find((x) => x.id === service)!.price);
        const pb = BigInt(b.services.find((x) => x.id === service)!.price);
        if (pa !== pb) return pa < pb ? -1 : 1;
        return b.reputation - a.reputation;
      });
  }

  /** Quote + IOU: the job is cleared and the seller is guaranteed payment. */
  async buy(seller: AgentSummary, service: string, input: unknown, opts: { intentId: string; parentJobId?: string | null; maxPrice?: bigint }): Promise<PreparedJob> {
    const q = (await this.callSeller(seller, { action: "quote", buyer: this.agentId.toString(), service, input })) as Awaited<ReturnType<KohakuAgent["quote"]>>;
    const quote: Quote = {
      seller: BigInt(q.quote.seller),
      buyer: BigInt(q.quote.buyer),
      service: q.quote.service,
      price: BigInt(q.quote.price),
      token: q.quote.token as Address,
      jobHash: q.quote.jobHash as Hex,
      expiry: BigInt(q.quote.expiry),
      quoteNonce: BigInt(q.quote.quoteNonce),
    };
    const signer = await recoverTypedDataAddress({ domain: this.domain, types: QUOTE_TYPES, primaryType: "Quote", message: quote, signature: q.quoteSignature });
    if (!isAddressEqual(signer, seller.signer as Address)) throw new Error("quote not signed by the seller");
    if (quote.buyer !== this.agentId || jobHash(q.jobSpec) !== quote.jobHash) throw new Error("quote does not match the request");
    if (opts.maxPrice !== undefined && quote.price > opts.maxPrice) throw new Error(`quoted ${quote.price} above max ${opts.maxPrice}`);

    for (let attempt = 0; attempt < 2; attempt++) {
      const epoch = await this.currentEpoch(attempt > 0);
      const iou: IOU = {
        buyer: this.agentId,
        seller: quote.seller,
        amount: quote.price,
        token: quote.token,
        jobHash: quote.jobHash,
        quoteHash: quoteDigest(this.domain, quote),
        epoch: BigInt(epoch),
        nonce: this.nextNonce(),
      };
      const signature = await this.signTyped("IOU", IOU_TYPES, iou);
      const r = await this.client.submitIou({
        iou: strs(iou),
        signature,
        quote: q.quote,
        quoteSignature: q.quoteSignature,
        jobSpec: q.jobSpec,
        intentId: opts.intentId,
        parentJobId: opts.parentJobId ?? null,
      });
      if (r.ok) {
        return { jobId: r.jobId, iouDigest: iouDigest(this.domain, iou), epoch: r.epoch, price: quote.price, seller, jobSpec: q.jobSpec, service };
      }
      if (r.currentEpoch !== undefined && /epoch|intake/.test(r.reason) && attempt === 0) {
        this.epochCache = null;
        continue;
      }
      throw new RefusedError(r.reason);
    }
    throw new RefusedError("epoch rolled over twice");
  }

  /** Ask the seller to execute a cleared job and verify its signed delivery. */
  async run<O = unknown>(job: PreparedJob): Promise<HireResult<O>> {
    const out = (await this.callSeller(job.seller, { action: "execute", jobId: job.jobId, jobSpec: job.jobSpec, iouDigest: job.iouDigest })) as {
      result: O;
      delivery: Record<keyof Delivery, string>;
      deliverySignature: Hex;
    };
    const d: Delivery = {
      seller: BigInt(out.delivery.seller),
      jobHash: out.delivery.jobHash as Hex,
      iouDigest: out.delivery.iouDigest as Hex,
      resultHash: out.delivery.resultHash as Hex,
      deliveredAt: BigInt(out.delivery.deliveredAt),
    };
    const signer = await recoverTypedDataAddress({ domain: this.domain, types: DELIVERY_TYPES, primaryType: "Delivery", message: d, signature: out.deliverySignature });
    if (!isAddressEqual(signer, job.seller.signer as Address)) throw new Error("delivery not signed by the seller");
    if (hashJson(out.result) !== d.resultHash) throw new Error("result does not match the signed delivery");
    return { ...job, result: out.result, delivery: out.delivery };
  }

  async hire<O = unknown>(seller: AgentSummary, service: string, input: unknown, opts: { intentId: string; parentJobId?: string | null; maxPrice?: bigint }): Promise<HireResult<O>> {
    const job = await this.buy(seller, service, input, opts);
    return this.run<O>(job);
  }

  /**
   * Dispute a delivered job. If an arbiter is given, its verdict is bought like any other
   * job (validators earn a fee) and the ruling comes back as that job's result.
   */
  async dispute(jobId: string, reason: string, opts: { intentId: string; arbiter?: AgentSummary }) {
    const jd = await this.client.job(jobId);
    if (!jd.iou) throw new Error("job has no IOU");
    let arbiterJob: PreparedJob | null = null;
    if (opts.arbiter) arbiterJob = await this.buy(opts.arbiter, "verdict", { jobId, reason }, { intentId: opts.intentId, parentJobId: jobId });
    const dispute = { buyer: this.agentId, jobHash: jd.job.jobHash, iouDigest: jd.iou.digest, reason, filedAt: BigInt(Date.now()) };
    const signature = await this.signTyped("Dispute", DISPUTE_TYPES, dispute);
    const view = await this.client.fileDispute({ jobId, dispute: strs(dispute), signature, arbiterJobId: arbiterJob?.jobId ?? null });
    let verdict: unknown = null;
    if (arbiterJob) verdict = (await this.run(arbiterJob)).result;
    return { dispute: view, verdict, disputeHash: disputeDigest(this.domain, dispute) };
  }

  // =================================================================== validator

  /** Sign and submit a verdict; optionally also answer the request on chain. */
  async rule(disputeId: string, disputeHash: Hex, upheld: boolean, reasoning: string, opts: { onchain?: boolean } = {}) {
    const verdict = { disputeHash, validator: this.agentId, upheld, reasoning: reasoning.slice(0, 900), decidedAt: BigInt(Date.now()) };
    const signature = await this.signTyped("Verdict", VERDICT_TYPES, verdict);
    const view = await this.client.verdict(disputeId, { verdict: strs(verdict), signature });
    if (opts.onchain) void this.respondOnChain(disputeHash, upheld, `${this.client.baseUrl}/v1/disputes/${disputeId}`, hashJson({ disputeId, upheld, reasoning }));
    return view;
  }

  private async respondOnChain(requestHash: Hex, upheld: boolean, uri: string, responseHash: Hex): Promise<void> {
    for (let i = 0; i < 20; i++) {
      try {
        const status = (await this.publicClient.readContract({
          address: this.cfg.deployment.validationRegistry,
          abi: validationRegistryAbi,
          functionName: "getValidationStatus",
          args: [requestHash],
        })) as readonly [Address, bigint, number, Hex, string, bigint];
        if (status[0] !== "0x0000000000000000000000000000000000000000") {
          await this.wallet.writeContract({
            account: this.account,
            chain: this.chain,
            address: this.cfg.deployment.validationRegistry,
            abi: validationRegistryAbi,
            functionName: "validationResponse",
            args: [requestHash, upheld ? 0 : 100, uri, responseHash, upheld ? "upheld" : "rejected"],
          });
          return;
        }
      } catch {
        // request not on chain yet, or not staked: try again shortly
      }
      await new Promise((r) => setTimeout(r, 3_000));
    }
  }

  // =================================================================== debtor

  /** Pay every outstanding settlement order through HSP. Safe to call repeatedly. */
  async settleDebts(): Promise<{ settled: string[]; failed: { id: string; error: string }[] }> {
    if (this.settling || this.agentId === 0n) return { settled: [], failed: [] };
    this.settling = true;
    const settled: string[] = [];
    const failed: { id: string; error: string }[] = [];
    try {
      const orders = await this.client.settlements({ agentId: this.agentId.toString(), status: "awaiting_payment" });
      for (const o of orders) {
        try {
          // never pay the same order twice: re-report a payment we already made
          if (!o.order.hsp?.flowId) continue; // HSP order not open yet; next round
          let report = this.paid.get(o.id);
          if (!report || report.cartMandateId !== o.order.hsp.cartMandateId) {
            try {
              report = await this.hsp.pay(o.order);
            } catch (err) {
              // paid already (e.g. before a restart): report it and let the clearing service check
              if (!(err instanceof HspRequestError && /already payment-/.test(err.message))) throw err;
              report = { cartMandateId: o.order.hsp.cartMandateId, flowId: o.order.hsp.flowId };
            }
            this.paid.set(o.id, report);
          }
          await this.client.reportPayment(o.id, report);
          settled.push(o.id);
        } catch (err) {
          failed.push({ id: o.id, error: (err as Error).message });
        }
      }
    } finally {
      this.settling = false;
    }
    return { settled, failed };
  }

  // =================================================================== plumbing

  private async currentEpoch(force = false): Promise<number> {
    const now = Date.now();
    if (!force && this.epochCache && now < this.epochCache.intakeEndsAt - 250) return this.epochCache.epoch;
    const r = await this.client.nonce(this.agentId.toString());
    this.epochCache = { epoch: r.epoch, intakeEndsAt: r.intakeEndsAt };
    const serverNonce = BigInt(r.nonce) - 1n;
    if (serverNonce > this.lastNonce) this.lastNonce = serverNonce;
    return r.epoch;
  }

  private nextNonce(): bigint {
    const t = BigInt(Date.now()) * 1000n;
    this.lastNonce = t > this.lastNonce ? t : this.lastNonce + 1n;
    return this.lastNonce;
  }

  private async callSeller(seller: AgentSummary, kohaku: Record<string, unknown>): Promise<unknown> {
    const url = routeUrl(seller.endpoint, this.routes);
    if (!url) throw new Error(`agent #${seller.agentId} has no endpoint`);
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: randomUUID(),
        method: "message/send",
        params: { message: { role: "user", messageId: randomUUID(), parts: [{ kind: "data", data: { kohaku } }] } },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = (await res.json()) as { result?: { parts?: { kind: string; data?: { kohaku?: unknown } }[] }; error?: { message: string } };
    if (body.error) throw new Error(`${seller.name}: ${body.error.message}`);
    const part = body.result?.parts?.find((p) => p.kind === "data");
    return part?.data?.kohaku;
  }

  private signTyped(primaryType: string, types: Record<string, readonly { name: string; type: string }[]>, message: object): Promise<Hex> {
    return this.wallet.signTypedData({ account: this.account, domain: this.domain, types, primaryType, message } as never);
  }

  private requireProfile(): AgentProfile {
    if (!this.profile) throw new Error("call setProfile() before publishing a card");
    return this.profile;
  }
}

function priceUnits(p: bigint | string): bigint {
  return typeof p === "bigint" ? p : p.includes(".") ? usd(p) : BigInt(p);
}

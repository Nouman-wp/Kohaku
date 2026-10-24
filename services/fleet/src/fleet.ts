import type { IncomingMessage, ServerResponse } from "node:http";
import { formatEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { formatUnits } from "@kohaku/core";
import {
  ClearingClient,
  CoordinatorHspPayer,
  KohakuAgent,
  Operator,
  end,
  serveAgents,
  type AgentProfile,
  type HireResult,
} from "@kohaku/sdk";
import { agentKey, type FleetConfig } from "./config.ts";
import { installArbiter } from "./agents/arbiter.ts";
import { installOrchestrator, runBrief, TOPICS, type BriefRecord } from "./agents/orchestrator.ts";
import { installLens, installPolyglot, installRogue, installScout, installScribe, installVerifier } from "./agents/workers.ts";

type Slug = "orchestrator" | "scout" | "verifier" | "polyglot" | "scribe" | "lens" | "arbiter" | "rogue";

interface FleetMember {
  slug: Slug;
  profile: Omit<AgentProfile, "baseUrl" | "slug">;
  operator: "fleet" | "rogue";
  install: (fleet: Fleet, agent: KohakuAgent) => void;
  /** standing intents: what this agent may buy on its own, signed by its operator */
  buys: { key: string; goal: string; services: string[]; budget: bigint; perJobCap: bigint; minRep: number }[];
}

const USD = (n: number) => BigInt(Math.round(n * 1e6));

export const MEMBERS: FleetMember[] = [
  {
    slug: "orchestrator",
    profile: { name: "Orchestrator", role: "Research lead", description: "Turns a goal into a researched, fact-checked brief by hiring the rest of the fleet. Sells finished briefs.", fleet: true },
    operator: "fleet",
    install: installOrchestrator,
    buys: [
      { key: "orders", goal: "[standing] Fulfil paid brief orders", services: [], budget: USD(50), perJobCap: USD(0.05), minRep: 700 },
      { key: "background", goal: "[standing] Background research briefs", services: [], budget: USD(50), perJobCap: USD(0.05), minRep: 700 },
    ],
  },
  {
    slug: "scout",
    profile: { name: "Scout", role: "Search", description: "Searches Wikipedia and returns sourced snippets per query. Buys translations for non-English searches.", fleet: true },
    operator: "fleet",
    install: installScout,
    buys: [{ key: "main", goal: "[standing] Translate non-English search results", services: ["translate"], budget: USD(10), perJobCap: USD(0.01), minRep: 600 }],
  },
  {
    slug: "verifier",
    profile: { name: "Verifier", role: "Fact checker", description: "Checks one claim at a time against sources it buys from search agents.", fleet: true },
    operator: "fleet",
    install: installVerifier,
    buys: [{ key: "main", goal: "[standing] Buy search results for fact checks", services: ["search"], budget: USD(20), perJobCap: USD(0.005), minRep: 600 }],
  },
  {
    slug: "polyglot",
    profile: { name: "Polyglot", role: "Translator", description: "Translates paragraphs between English and Hindi, confirming names with a search agent.", fleet: true },
    operator: "fleet",
    install: installPolyglot,
    buys: [{ key: "main", goal: "[standing] Look up names before translating", services: ["search"], budget: USD(10), perJobCap: USD(0.005), minRep: 600 }],
  },
  {
    slug: "scribe",
    profile: { name: "Scribe", role: "Summariser", description: "Writes extractive summaries; buys chart descriptions for documents with figures.", fleet: true },
    operator: "fleet",
    install: installScribe,
    buys: [{ key: "main", goal: "[standing] Buy figure descriptions and translations", services: ["describe", "translate"], budget: USD(10), perJobCap: USD(0.01), minRep: 600 }],
  },
  {
    slug: "lens",
    profile: { name: "Lens", role: "Chart reader", description: "Describes charts and data series in plain words; condenses long captions with a summariser.", fleet: true },
    operator: "fleet",
    install: installLens,
    buys: [{ key: "main", goal: "[standing] Condense long captions", services: ["summarize"], budget: USD(10), perJobCap: USD(0.01), minRep: 600 }],
  },
  {
    slug: "arbiter",
    profile: { name: "Arbiter", role: "Validator", description: "Staked validator. Re-checks disputed jobs independently and rules; verdicts land on the ERC-8004 validation registry.", validator: true, fleet: true },
    operator: "fleet",
    install: installArbiter,
    buys: [],
  },
  {
    slug: "rogue",
    profile: { name: "Rogue", role: "Fact checker (budget)", description: "Undercuts everyone on fact checks. Deliberately unreliable, so disputes and reputation have something to catch.", fleet: true, organization: "Rogue Ops" },
    operator: "rogue",
    install: installRogue,
    buys: [],
  },
];

export interface FleetState {
  paused: boolean;
  background: boolean;
  rogueBadRate: number;
  rogueDiscount: boolean;
  offline: Set<string>;
  scenario: { name: string; startedAt: number; until: number } | null;
}

/**
 * The live fleet: eight agents with their own keys and on-chain identities, two operators
 * (the fleet and "Rogue Ops"), standing AP2 intents, the settlement loop that makes every
 * debtor pay its own HSP settlement, and the scenario runner used in the demo.
 */
export class Fleet {
  readonly agents = new Map<string, KohakuAgent>();
  readonly standing = new Map<string, string>();
  readonly briefs: BriefRecord[] = [];
  readonly activity = new Map<string, number>();
  readonly logs: { at: number; slug: string; message: string }[] = [];
  readonly state: FleetState;
  client!: ClearingClient;
  operator!: Operator;
  rogueOperator!: Operator;
  private handledIntents = new Set<string>();
  private guestLog: number[] = [];
  private bgTimer: NodeJS.Timeout | null = null;

  constructor(readonly cfg: FleetConfig) {
    this.state = { paused: false, background: cfg.background, rogueBadRate: cfg.rogueBadRate, rogueDiscount: false, offline: new Set(), scenario: null };
  }

  log(slug: string, message: string): void {
    const line = { at: Date.now(), slug, message };
    this.logs.push(line);
    if (this.logs.length > 500) this.logs.shift();
    console.log(`${new Date().toISOString()} [${slug}] ${message}`);
  }

  touch(slug: string): void {
    this.activity.set(slug, Date.now());
  }

  // ---------------------------------------------------------------- bootstrap

  async start(): Promise<void> {
    this.client = new ClearingClient(this.cfg.clearingUrl);
    const clearingCfg = await waitFor(() => this.client.config(), "clearing service");
    this.operator = new Operator(clearingCfg, this.cfg.operatorKey, this.cfg.rpcUrl);
    this.rogueOperator = new Operator(clearingCfg, this.cfg.rogueOperatorKey, this.cfg.rpcUrl);

    // 1. agents with keys and cards, served before registration so the cards resolve
    for (const m of MEMBERS) {
      const agent = await KohakuAgent.connect({ privateKey: agentKey(this.cfg.seed, m.slug), clearingUrl: this.cfg.clearingUrl, rpcUrl: this.cfg.rpcUrl });
      agent.setProfile({ ...m.profile, slug: m.slug, baseUrl: `${this.cfg.publicUrl}/agents/${m.slug}` });
      if (this.cfg.hspMode === "coordinator" && this.cfg.hsp.sdkPath && this.cfg.hsp.coordinatorUrl && this.cfg.hsp.apiKey) {
        agent.useHsp(
          new CoordinatorHspPayer({
            sdkPath: this.cfg.hsp.sdkPath,
            coordinatorUrl: this.cfg.hsp.coordinatorUrl,
            apiKey: this.cfg.hsp.apiKey,
            privateKey: agentKey(this.cfg.seed, m.slug),
            chainName: this.cfg.hsp.chainName ?? clearingCfg.hsp.chain,
          }),
        );
      }
      m.install(this, agent);
      this.agents.set(m.slug, agent);
    }
    await serveAgents([...this.agents.values()], { port: this.cfg.port, extra: (req, res, body) => this.control(req, res, body) });
    this.log("fleet", `serving ${this.agents.size} agents on :${this.cfg.port} (${this.cfg.publicUrl})`);

    // 2. on-chain identity, funding, collateral, validator stake
    for (const m of MEMBERS) {
      const agent = this.agents.get(m.slug)!;
      const op = m.operator === "rogue" ? this.rogueOperator : this.operator;
      agent.agentId = await op.ensureRegistered(agent.address, `${this.cfg.publicUrl}/agents/${m.slug}/registration.json`);
      this.log(m.slug, `agent #${agent.agentId} wallet ${agent.address} operator ${op.address}`);
    }
    await this.fund();
    const arbiter = this.agents.get("arbiter")!;
    const stake = (await arbiter.publicClient.readContract({
      address: clearingCfg.deployment.validationRegistry,
      abi: [{ type: "function", name: "stakes", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint64" }] }],
      functionName: "stakes",
      args: [arbiter.address],
    })) as readonly [bigint, bigint, bigint];
    if (stake[0] < USD(5)) {
      await this.operator.stakeAsValidator(arbiter.wallet as never, USD(5) - stake[0]);
      this.log("arbiter", "staked 5 USDC as validator");
    }

    // 3. standing intents (AP2 mandates) signed by each agent's operator
    await this.ensureStandingIntents();

    // 4. loops
    setInterval(() => void this.settleAll(), 3_000);
    setInterval(() => void this.watchIntents(), 2_500);
    setInterval(() => void this.fund().catch((err) => this.log("fleet", `funding check failed: ${(err as Error).message}`)), 90_000);
    setInterval(() => void this.ensureStandingIntents().catch(() => undefined), 10 * 60_000);
    this.scheduleBackground();
    this.log("fleet", "ready");
  }

  private async fund(): Promise<void> {
    const local = this.cfg.chain === "local";
    for (const m of MEMBERS) {
      try {
        await this.fundOne(m, local);
      } catch (err) {
        this.log(m.slug, `funding failed: ${(err as Error).message}`);
      }
    }
  }

  private async fundOne(m: FleetMember, local: boolean): Promise<void> {
    const agent = this.agents.get(m.slug)!;
    const op = m.operator === "rogue" ? this.rogueOperator : this.operator;
    const target = m.slug === "orchestrator" ? this.cfg.orchestratorCollateral : this.cfg.collateralTarget;
    await this.ensureTokens(op, op.address, target + this.cfg.walletTarget, local);
    const added = await op.topUpCollateral(agent.agentId, target);
    if (added > 0n) this.log(m.slug, `collateral topped up by ${formatUnits(added)} USDC`);
    const bal = await op.tokenBalance(agent.address);
    if (bal < this.cfg.walletTarget / 2n) {
      if (local && op.cfg.deployment.mockToken) await op.mintTestTokens(agent.address, this.cfg.walletTarget - bal);
      else if ((await op.tokenBalance()) >= this.cfg.walletTarget - bal) await op.transferToken(agent.address, this.cfg.walletTarget - bal);
      else this.log(m.slug, `wallet low (${formatUnits(bal)} USDC) and operator cannot top it up`);
    }
    const gas = await agent.publicClient.getBalance({ address: agent.address });
    if (gas < this.cfg.gasTarget / 2n) {
      const opGas = await op.publicClient.getBalance({ address: op.address });
      if (opGas > this.cfg.gasTarget * 2n) await op.sendGas(agent.address, this.cfg.gasTarget - gas);
      else this.log(m.slug, `gas low (${formatEther(gas)}) and operator has ${formatEther(opGas)}`);
    }
  }

  private async ensureTokens(op: Operator, who: Hex, need: bigint, local: boolean): Promise<void> {
    const bal = await op.tokenBalance(who);
    if (bal >= need) return;
    if (local && op.cfg.deployment.mockToken) {
      let missing = need - bal;
      while (missing > 0n) {
        const chunk = missing > 10_000n * 10n ** 6n ? 10_000n * 10n ** 6n : missing;
        await op.mintTestTokens(who, chunk);
        missing -= chunk;
      }
    }
  }

  private async ensureStandingIntents(): Promise<void> {
    const now = BigInt(Math.floor(Date.now() / 1000));
    for (const m of MEMBERS) {
      const agent = this.agents.get(m.slug)!;
      const op = m.operator === "rogue" ? this.rogueOperator : this.operator;
      const existing = await this.client.intents({ buyer: agent.agentId.toString() });
      for (const b of m.buys) {
        const reuse = existing.find(
          (i) => i.goal === b.goal && i.status === "active" && BigInt(i.budget) - BigInt(i.spent) > b.budget / 5n && i.deadline > Number(now) + 3600,
        );
        if (reuse) {
          this.standing.set(`${m.slug}:${b.key}`, reuse.id);
          continue;
        }
        const view = await op.authorise(this.client, {
          buyer: agent.agentId,
          goal: b.goal,
          budget: b.budget,
          perJobCap: b.perJobCap,
          minSellerReputation: b.minRep,
          allowedServices: b.services,
          allowedSellers: [],
          notBefore: now - 60n,
          deadline: now + 7n * 86_400n,
          nonce: BigInt(Date.now()),
        });
        this.standing.set(`${m.slug}:${b.key}`, view.id);
        this.log(m.slug, `standing intent "${b.goal}" signed by operator (${formatUnits(b.budget)} USDC)`);
      }
    }
  }

  // ---------------------------------------------------------------- trading helpers

  async hire<T = unknown>(
    buyer: string,
    service: string,
    input: unknown,
    opts: { intentId?: string; parentJobId?: string | null; minReputation?: number; exclude?: string[] } = {},
  ): Promise<HireResult<T>> {
    const agent = this.agents.get(buyer);
    if (!agent) throw new Error(`no agent ${buyer}`);
    const intentId = opts.intentId ?? this.standing.get(`${buyer}:main`);
    if (!intentId) throw new Error(`${buyer} has no intent to buy ${service}`);
    const sellers = await agent.findSellers(service, { minReputation: opts.minReputation ?? 600, exclude: opts.exclude });
    const seller = sellers[0];
    if (!seller) throw new Error(`no ${service} seller above reputation ${opts.minReputation ?? 600}`);
    this.touch(buyer);
    return agent.hire<T>(seller, service, input, { intentId, parentJobId: opts.parentJobId ?? null });
  }

  async dispute(buyer: string, jobId: string, reason: string, intentId: string): Promise<unknown> {
    const agent = this.agents.get(buyer)!;
    const arbiters = await agent.findSellers("verdict", { minReputation: 500 });
    const r = await agent.dispute(jobId, reason, { intentId, arbiter: arbiters[0] });
    return r.verdict;
  }

  private async settleAll(): Promise<void> {
    await Promise.all(
      [...this.agents.entries()].map(async ([slug, agent]) => {
        if (this.state.offline.has(slug)) return;
        try {
          const r = await agent.settleDebts();
          for (const id of r.settled) this.log(slug, `paid ${id} through HSP`);
          for (const f of r.failed) this.log(slug, `settlement ${f.id} failed: ${f.error}`);
        } catch {
          // clearing unreachable; retried next tick
        }
      }),
    );
  }

  /** Human-signed intents for the orchestrator start a brief each. */
  private async watchIntents(): Promise<void> {
    const orch = this.agents.get("orchestrator");
    if (!orch || this.state.paused) return;
    try {
      const list = await this.client.intents({ buyer: orch.agentId.toString() });
      for (const i of list) {
        if (i.status !== "active" || i.goal.startsWith("[standing]") || this.handledIntents.has(i.id)) continue;
        if (i.createdAt < Date.now() - 10 * 60_000) continue;
        this.handledIntents.add(i.id);
        const languages = /hindi|हिन्दी|हिंदी/i.test(i.goal) ? ["en", "hi"] : ["en"];
        const topic = topicFromGoal(i.goal);
        this.log("orchestrator", `took intent ${i.id.slice(0, 10)}: "${i.goal}"`);
        void runBrief(this, { topic, languages, intentId: i.id, origin: "intent", minReputation: i.minSellerReputation || 700 });
      }
    } catch {
      // ignore
    }
  }

  private scheduleBackground(): void {
    if (this.bgTimer) clearInterval(this.bgTimer);
    this.bgTimer = setInterval(() => {
      if (!this.state.background || this.state.paused || this.state.scenario) return;
      const topic = TOPICS[Math.floor(Math.random() * TOPICS.length)]!;
      const intentId = this.standing.get("orchestrator:background");
      if (!intentId) return;
      void runBrief(this, { topic, languages: Math.random() < 0.3 ? ["en", "hi"] : ["en"], intentId, origin: "background" });
    }, this.cfg.backgroundIntervalSeconds * 1000);
  }

  // ---------------------------------------------------------------- scenarios

  async scenario(name: string): Promise<{ ok: boolean; message: string }> {
    const intent = this.standing.get("orchestrator:background")!;
    const now = Date.now();
    switch (name) {
      case "research-brief": {
        const view = await this.operator.authorise(this.client, demoIntent(this.agents.get("orchestrator")!.agentId, "Produce a researched, fact-checked brief on Chandrayaan-3 in English and Hindi", 20));
        this.state.scenario = { name, startedAt: now, until: now + 90_000 };
        return { ok: true, message: `intent ${view.id.slice(0, 10)} signed; the orchestrator takes it within seconds` };
      }
      case "busy-minute": {
        this.state.scenario = { name, startedAt: now, until: now + 75_000 };
        const topics = [...TOPICS].sort(() => Math.random() - 0.5).slice(0, 8);
        topics.forEach((topic, i) =>
          setTimeout(() => void runBrief(this, { topic, languages: i % 2 ? ["en", "hi"] : ["en"], intentId: intent, origin: "scenario" }), i * 7_000),
        );
        return { ok: true, message: "8 briefs over the next minute" };
      }
      case "rogue-attack": {
        this.state.rogueBadRate = 0.95;
        this.state.rogueDiscount = true;
        this.state.scenario = { name, startedAt: now, until: now + 120_000 };
        for (const topic of ["Unified Payments Interface", "Taj Mahal", "Indian Railways"]) void runBrief(this, { topic, languages: ["en"], intentId: intent, origin: "scenario" });
        setTimeout(() => {
          this.state.rogueBadRate = this.cfg.rogueBadRate;
          this.state.rogueDiscount = false;
        }, 120_000);
        return { ok: true, message: "Rogue cuts its price and its quality; watch the disputes" };
      }
      case "default-drill": {
        this.state.offline.add("orchestrator");
        this.state.scenario = { name, startedAt: now, until: now + 300_000 };
        void runBrief(this, { topic: "Clearing house (finance)", languages: ["en"], intentId: intent, origin: "scenario" });
        setTimeout(() => this.state.offline.delete("orchestrator"), 300_000);
        return { ok: true, message: "the orchestrator goes dark for settlement; its next debt is covered from collateral" };
      }
      default:
        return { ok: false, message: `unknown scenario ${name}` };
    }
  }

  reset(): void {
    this.state.paused = false;
    this.state.rogueBadRate = this.cfg.rogueBadRate;
    this.state.rogueDiscount = false;
    this.state.offline.clear();
    this.state.scenario = null;
    void this.fund();
  }

  // ---------------------------------------------------------------- guest onboarding (MCP / judges)

  /**
   * Mint a fresh guest agent for an MCP client: new key, registered on chain under the
   * fleet operator, small collateral, a capped intent. Rate limited.
   */
  async guestSession(): Promise<Record<string, string>> {
    this.guestLog = this.guestLog.filter((t) => t > Date.now() - 3_600_000);
    if (this.guestLog.length >= this.cfg.guestSessionsPerHour) throw new Error("guest sessions are rate limited; try again later");
    this.guestLog.push(Date.now());
    const pk = (await import("viem/accounts")).generatePrivateKey();
    const account = privateKeyToAccount(pk);
    const agentId = await this.operator.ensureRegistered(account.address, `${this.cfg.publicUrl}/guests/${account.address}/registration.json`);
    const local = this.cfg.chain === "local";
    await this.ensureTokens(this.operator, this.operator.address, USD(3), local);
    await this.operator.deposit(agentId, USD(1));
    if (local && this.operator.cfg.deployment.mockToken) await this.operator.mintTestTokens(account.address, USD(1));
    else await this.operator.transferToken(account.address, USD(1));
    await this.operator.sendGas(account.address, this.cfg.gasTarget / 4n);
    const now = BigInt(Math.floor(Date.now() / 1000));
    const view = await this.operator.authorise(this.client, {
      buyer: agentId,
      goal: "Guest session: hire Kohaku agents from an MCP client",
      budget: USD(1),
      perJobCap: USD(0.06),
      minSellerReputation: 600,
      allowedServices: [],
      allowedSellers: [],
      notBefore: now - 60n,
      deadline: now + 86_400n,
      nonce: BigInt(Date.now()),
    });
    this.log("fleet", `guest agent #${agentId} (${account.address}) onboarded`);
    return { privateKey: pk, agentId: agentId.toString(), intentId: view.id, clearingUrl: this.cfg.clearingUrl, address: account.address };
  }

  // ---------------------------------------------------------------- control API

  private async control(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://x");
    const p = url.pathname;
    if (p.startsWith("/guests/") && p.endsWith("/registration.json")) {
      const addr = p.split("/")[2];
      end(res, 200, {
        type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
        name: `Guest ${addr?.slice(0, 8)}`,
        description: "A guest buyer agent onboarded from an MCP client.",
        image: "",
        endpoints: [{ name: "agentWallet", endpoint: addr }],
        registrations: [],
        supportedTrust: ["reputation"],
        kohaku: { slug: `guest-${addr?.slice(2, 8).toLowerCase()}`, role: "Guest buyer" },
      });
      return true;
    }
    if (req.method === "GET" && p === "/control/status") {
      end(res, 200, await this.status());
      return true;
    }
    if (req.method === "GET" && p === "/control/briefs") {
      end(res, 200, this.briefs.map((b) => ({ ...b, result: b.result ? { topic: b.result.topic, claims: b.result.claims.length } : null })));
      return true;
    }
    if (req.method === "GET" && p.startsWith("/control/briefs/")) {
      const b = this.briefs.find((x) => x.id === p.split("/")[3] || x.intentId === p.split("/")[3]);
      end(res, b ? 200 : 404, b ?? { error: "unknown brief" });
      return true;
    }
    if (req.method === "GET" && p === "/control/logs") {
      end(res, 200, this.logs.slice(-200));
      return true;
    }
    if (req.method === "POST" && p === "/guest/session") {
      try {
        end(res, 200, await this.guestSession());
      } catch (err) {
        end(res, 429, { error: (err as Error).message });
      }
      return true;
    }
    if (req.method === "POST" && p.startsWith("/control/")) {
      if (req.headers["x-admin-token"] !== this.cfg.adminToken) {
        end(res, 401, { error: "admin token required" });
        return true;
      }
      const action = p.split("/")[2];
      const b = (body ?? {}) as { scenario?: string; goal?: string; budget?: number; perJobCap?: number; minReputation?: number; services?: string[]; deadlineMinutes?: number };
      if (action === "start") end(res, 200, await this.scenario(b.scenario ?? ""));
      else if (action === "intent") {
        // demo convenience: the fleet operator signs an intent for the orchestrator on the presenter's behalf
        const now = BigInt(Math.floor(Date.now() / 1000));
        const view = await this.operator.authorise(this.client, {
          buyer: this.agents.get("orchestrator")!.agentId,
          goal: String(b.goal ?? "Produce a researched, fact-checked brief on HashKey Chain").slice(0, 300),
          budget: USD(Math.min(100, Math.max(0.01, Number(b.budget ?? 20)))),
          perJobCap: USD(Math.max(0, Number(b.perJobCap ?? 0.05))),
          minSellerReputation: Math.round(Math.min(1000, Math.max(0, Number(b.minReputation ?? 700)))),
          allowedServices: Array.isArray(b.services) ? b.services.map(String) : [],
          allowedSellers: [],
          notBefore: now - 60n,
          deadline: now + BigInt(Math.round(Math.max(1, Number(b.deadlineMinutes ?? 60)) * 60)),
          nonce: BigInt(Date.now()),
        });
        end(res, 200, { ok: true, message: `intent ${view.id.slice(0, 10)} signed by the fleet operator`, intent: view });
      }
      else if (action === "pause") {
        this.state.paused = true;
        end(res, 200, { ok: true, message: "fleet paused (settlement continues)" });
      } else if (action === "resume") {
        this.state.paused = false;
        end(res, 200, { ok: true, message: "fleet resumed" });
      } else if (action === "reset") {
        this.reset();
        end(res, 200, { ok: true, message: "scenario state reset; wallets and collateral topped up" });
      } else if (action === "background") {
        this.state.background = !this.state.background;
        end(res, 200, { ok: true, message: `background traffic ${this.state.background ? "on" : "off"}` });
      } else end(res, 404, { error: `unknown action ${action}` });
      return true;
    }
    return false;
  }

  private async status() {
    const agents = await Promise.all(
      [...this.agents.entries()].map(async ([slug, a]) => {
        const [gas, tokens] = await Promise.all([
          a.publicClient.getBalance({ address: a.address }).catch(() => 0n),
          this.operator.tokenBalance(a.address).catch(() => 0n),
        ]);
        return { slug, agentId: a.agentId.toString(), address: a.address, gas: formatEther(gas), wallet: formatUnits(tokens), lastActive: this.activity.get(slug) ?? null, offline: this.state.offline.has(slug) };
      }),
    );
    return {
      reachable: true,
      paused: this.state.paused,
      background: this.state.background,
      scenario: this.state.scenario && this.state.scenario.until > Date.now() ? this.state.scenario : null,
      rogueBadRate: this.state.rogueBadRate,
      briefsRunning: this.briefs.filter((b) => b.status === "running").length,
      agents,
    };
  }
}

function demoIntent(buyer: bigint, goal: string, budgetUsd: number) {
  const now = BigInt(Math.floor(Date.now() / 1000));
  return {
    buyer,
    goal,
    budget: USD(budgetUsd),
    perJobCap: USD(0.05),
    minSellerReputation: 700,
    allowedServices: [],
    allowedSellers: [],
    notBefore: now - 60n,
    deadline: now + 3_600n,
    nonce: BigInt(Date.now()),
  };
}

export function topicFromGoal(goal: string): string {
  const m = goal.match(/\b(?:on|about|of)\s+["“]?([^"”,.]+?)["”]?(?:\s+in\s+(?:english|hindi)|[,.]|$)/i);
  return (m?.[1] ?? goal).trim().slice(0, 100);
}

async function waitFor<T>(fn: () => Promise<T>, what: string): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i % 5 === 0) console.log(`waiting for ${what}: ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
}

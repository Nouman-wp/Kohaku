import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import type { Address, Hex, TypedDataDomain } from "viem";
import { formatUnits, type AgentSummary, type IntentMandate, type LiveEvent, type PaymentReport } from "@kohaku/core";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import type { Chain } from "./chain.ts";
import type { Registry, AgentRecord } from "./registry.ts";
import type { ReputationBook } from "./reputation.ts";
import { IntentError, type Intents } from "./intents.ts";
import type { Ledger, SubmitIouInput } from "./ledger.ts";
import type { EpochEngine } from "./epochs.ts";
import type { Settlements } from "./settlements.ts";
import type { HspPort } from "./hsp/port.ts";
import type { LocalHspGateway } from "./hsp/gateway.ts";
import type { SupabaseMirror } from "./mirror.ts";
import { acceptWebhook } from "./hsp/webhook.ts";
import { headlineStats } from "./stats.ts";
import { verifyEpoch } from "./verify.ts";
import { bus, log } from "./bus.ts";
import {
  disputeView,
  epochView,
  iouView,
  jobView,
  payoutView,
  positionView,
  settlementView,
  type DisputeRow,
  type EpochRow,
  type IouRow,
  type JobRow,
  type PayoutRow,
  type PositionRow,
  type SettlementRow,
} from "./views.ts";

export interface Ctx {
  cfg: Config;
  db: Db;
  chain: Chain;
  registry: Registry;
  rep: ReputationBook;
  intents: Intents;
  ledger: Ledger;
  epochs: EpochEngine;
  settlements: Settlements;
  hsp: HspPort;
  /** Kohaku's local HSP gateway, mounted at /hsp when HSP_MODE=local */
  gateway?: LocalHspGateway;
  /** Supabase copy of the database, when SUPABASE_URL is set */
  mirror?: SupabaseMirror;
  domain: TypedDataDomain;
  hspHealthy: () => boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: string;
  }
}

export async function buildApi(ctx: Ctx): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  await app.register(cors, { origin: ctx.cfg.CORS_ORIGIN === "*" ? true : ctx.cfg.CORS_ORIGIN.split(",") });
  await app.register(websocket);

  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    (req as FastifyRequest).rawBody = body as string;
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const status = err instanceof IntentError ? 400 : err.statusCode ?? 400;
    reply.status(status).send({ error: err.message });
  });

  const { db, chain, registry, rep, intents, ledger, epochs, settlements, hsp, domain, cfg } = ctx;
  const stats = () => headlineStats(db, chain, hsp, epochs, registry, ctx.hspHealthy());
  const requireAdmin = (req: FastifyRequest) => {
    const token = (req.headers["x-admin-token"] as string | undefined) ?? (req.body as { token?: string } | undefined)?.token;
    if (token !== cfg.ADMIN_TOKEN) throw Object.assign(new Error("admin token required"), { statusCode: 401 });
  };

  // ---------------------------------------------------------------- meta

  app.get("/", async () => ({ name: "Kohaku clearing service", docs: "/v1/config", live: "/v1/live" }));

  app.get("/v1/config", async () => ({
    chain: { key: chain.key, id: chain.viemChain.id, name: chain.viemChain.name, explorer: chain.explorer, rpc: cfg.rpcUrl },
    deployment: chain.d,
    domain: { ...domain, chainId: Number(domain.chainId) },
    epochs: {
      intakeSeconds: cfg.EPOCH_INTAKE_SECONDS,
      challengeSeconds: cfg.EPOCH_CHALLENGE_SECONDS,
      disputeWindowSeconds: cfg.DISPUTE_WINDOW_SECONDS,
      arbitrationTimeoutSeconds: cfg.ARBITRATION_TIMEOUT_SECONDS,
      settlementWindowSeconds: chain.d.settlementWindow,
    },
    hsp: hsp.info(),
    clearer: chain.account.address,
  }));

  app.get("/v1/health", async () => {
    const pool = await chain.poolBalance().catch(() => null);
    const clearerBalance = await chain.publicClient.getBalance({ address: chain.account.address }).catch(() => null);
    let fleet: unknown = null;
    try {
      const r = await fetch(`${cfg.FLEET_CONTROL_URL}/control/status`, { signal: AbortSignal.timeout(2_000) });
      fleet = await r.json();
    } catch {
      fleet = { reachable: false };
    }
    const cur = epochs.current();
    const stuck = db.all<EpochRow>("SELECT * FROM epochs WHERE error IS NOT NULL AND phase != 'sealed' ORDER BY id");
    return {
      ok: chain.healthy && ctx.hspHealthy(),
      at: Date.now(),
      clearing: { uptimeSeconds: Math.round(process.uptime()), currentEpoch: cur.id, phaseEndsAt: cur.intake_ends_at, stuckEpochs: stuck.map(epochView) },
      chain: {
        healthy: chain.healthy,
        key: chain.key,
        lastBlock: chain.lastBlock.toString(),
        lastError: chain.lastError,
        clearer: chain.account.address,
        clearerGasBalance: clearerBalance?.toString() ?? null,
        pool: pool ? { balance: pool.balance.toString(), accounted: pool.accounted.toString(), surplus: (pool.balance - pool.accounted).toString() } : null,
      },
      hsp: { ...hsp.info(), healthy: ctx.hspHealthy() },
      mirror: ctx.mirror?.status() ?? { enabled: false },
      fleet,
    };
  });

  app.get("/v1/stats", async () => stats());

  app.get("/v1/feed", async (req) => {
    const { limit } = req.query as { limit?: string };
    const h = bus.history().filter((e) => e.type !== "log");
    return h.slice(-Number(limit ?? 200));
  });

  app.get("/v1/logs", async () => bus.history().filter((e) => e.type === "log").slice(-200));

  // ---------------------------------------------------------------- agents

  const summary = (a: AgentRecord): AgentSummary => {
    const id = Number(a.agentId);
    const sold = db.get<{ n: number; v: number | null }>("SELECT COUNT(*) AS n, SUM(price) AS v FROM jobs WHERE seller = ? AND status IN ('delivered','settled')", id)!;
    const bought = db.get<{ n: number; v: number | null }>("SELECT COUNT(*) AS n, SUM(price) AS v FROM jobs WHERE buyer = ? AND status IN ('delivered','settled','accepted','disputed')", id)!;
    const lost = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM disputes WHERE seller = ? AND status = 'upheld'", id)!;
    const defaults = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM settlements WHERE agent_id = ? AND status = 'defaulted'", id)!;
    const acc = registry.cachedCollateral(a.agentId);
    const exposure = ledger.exposure(a.agentId);
    const available = acc?.available ?? 0n;
    return {
      agentId: a.agentId.toString(),
      slug: a.slug,
      name: a.name,
      description: a.description,
      role: a.role,
      operator: a.operator,
      signer: a.signer,
      status: a.status,
      endpoint: a.endpoint,
      cardUrl: a.cardUrl,
      services: a.services,
      reputation: rep.live(a.agentId),
      reputationEpoch: rep.chainScore(a.agentId).epoch ?? 0,
      volumeSold: String(sold.v ?? 0),
      volumeBought: String(bought.v ?? 0),
      jobsSold: sold.n,
      jobsBought: bought.n,
      disputesLost: lost.n,
      defaults: defaults.n,
      collateral: {
        total: String(acc?.total ?? 0n),
        locked: String(acc?.locked ?? 0n),
        pendingWithdrawal: String(acc?.pendingWithdrawal ?? 0n),
        unlockAt: acc?.unlockAt ?? 0,
        available: String(available),
        exposure: String(exposure),
        headroom: String(available > exposure ? available - exposure : 0n),
      },
      isValidator: a.isValidator,
      isFleet: a.isFleet,
    };
  };

  app.get("/v1/agents", async (req) => {
    const q = req.query as { capability?: string; maxPrice?: string; minReputation?: string; q?: string; status?: string };
    let list = registry.list();
    if (q.status) list = list.filter((a) => a.status === q.status);
    if (q.capability) {
      const c = q.capability.toLowerCase();
      list = list.filter((a) => a.services.some((s) => s.id === c || s.tags.map((t) => t.toLowerCase()).includes(c)));
    }
    if (q.maxPrice) {
      const max = BigInt(q.maxPrice);
      list = list.filter((a) => a.services.some((s) => BigInt(s.price) <= max && (!q.capability || s.id === q.capability || s.tags.includes(q.capability))));
    }
    if (q.minReputation) list = list.filter((a) => rep.live(a.agentId) >= Number(q.minReputation));
    if (q.q) {
      const t = q.q.toLowerCase();
      list = list.filter((a) => `${a.name} ${a.description} ${a.role} ${a.services.map((s) => s.name + " " + s.tags.join(" ")).join(" ")}`.toLowerCase().includes(t));
    }
    await registry.refreshCollateral(list.filter((a) => !registry.cachedCollateral(a.agentId)).map((a) => a.agentId));
    return list.map(summary);
  });

  app.get("/v1/agents/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const a = /^\d+$/.test(id) ? registry.get(id) : registry.list().find((x) => x.slug === id);
    if (!a) return reply.status(404).send({ error: "unknown agent" });
    await registry.collateralOf(a.agentId).catch(() => undefined);
    const n = Number(a.agentId);
    const jobs = db.all<JobRow>("SELECT * FROM jobs WHERE buyer = ? OR seller = ? ORDER BY created_at DESC LIMIT 60", n, n).map(jobView);
    const counterparties = db.all<{ agent: number; sold: number; bought: number; n: number }>(
      `SELECT agent, SUM(sold) AS sold, SUM(bought) AS bought, SUM(n) AS n FROM (
         SELECT buyer AS agent, SUM(price) AS sold, 0 AS bought, COUNT(*) AS n FROM jobs WHERE seller = ? AND status IN ('delivered','settled') GROUP BY buyer
         UNION ALL
         SELECT seller AS agent, 0 AS sold, SUM(price) AS bought, COUNT(*) AS n FROM jobs WHERE buyer = ? AND status IN ('delivered','settled') GROUP BY seller
       ) GROUP BY agent ORDER BY n DESC`,
      n,
      n,
    );
    const byService = db.all<{ service: string; side: string; n: number; v: number }>(
      `SELECT service, 'sold' AS side, COUNT(*) AS n, SUM(price) AS v FROM jobs WHERE seller = ? AND status IN ('delivered','settled') GROUP BY service
       UNION ALL SELECT service, 'bought' AS side, COUNT(*) AS n, SUM(price) AS v FROM jobs WHERE buyer = ? AND status IN ('delivered','settled') GROUP BY service`,
      n,
      n,
    );
    const disputes = db.all<DisputeRow>("SELECT * FROM disputes WHERE buyer = ? OR seller = ? OR validator = ? ORDER BY filed_at DESC LIMIT 50", n, n, n).map(disputeView);
    const settlementsList = db.all<SettlementRow>("SELECT * FROM settlements WHERE agent_id = ? ORDER BY epoch DESC LIMIT 50", n).map(settlementView);
    const payouts = db.all<PayoutRow>("SELECT * FROM payouts WHERE agent_id = ? ORDER BY epoch DESC LIMIT 50", n).map(payoutView);
    const positions = db.all<PositionRow>("SELECT * FROM positions WHERE agent_id = ? ORDER BY epoch DESC LIMIT 50", n).map(positionView);
    const intentsList = intents.list({ buyer: a.agentId.toString(), limit: 20 });
    return {
      agent: summary(a),
      reputation: { live: rep.live(a.agentId), chain: rep.chainScore(a.agentId), inputs: jsonSafe(rep.inputs(a.agentId)), history: rep.history(a.agentId) },
      jobs,
      counterparties: counterparties.map((c) => ({ agentId: String(c.agent), name: registry.get(c.agent)?.name ?? `#${c.agent}`, sold: String(c.sold), bought: String(c.bought), jobs: c.n })),
      byService: byService.map((s) => ({ ...s, v: String(s.v) })),
      disputes,
      settlements: settlementsList,
      payouts,
      positions,
      intents: intentsList,
    };
  });

  app.get("/v1/agents/:id/nonce", async (req) => {
    const { id } = req.params as { id: string };
    return { nonce: ledger.nextNonce(BigInt(id)).toString(), epoch: epochs.intake().id, intakeEndsAt: epochs.intake().intakeEndsAt };
  });

  // ---------------------------------------------------------------- epochs

  app.get("/v1/epochs", async (req) => {
    const { limit, before } = req.query as { limit?: string; before?: string };
    const rows = before
      ? db.all<EpochRow>("SELECT * FROM epochs WHERE id < ? ORDER BY id DESC LIMIT ?", Number(before), Number(limit ?? 50))
      : db.all<EpochRow>("SELECT * FROM epochs ORDER BY id DESC LIMIT ?", Number(limit ?? 50));
    return rows.map(epochView);
  });

  app.get("/v1/epochs/current", async () => {
    const cur = epochs.current();
    const ious = db.all<IouRow>("SELECT * FROM ious WHERE epoch = ? ORDER BY created_at", cur.id).map(iouView);
    return { epoch: epochView(cur), ious };
  });

  app.get("/v1/epochs/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const e = epochs.row(id);
    if (!e) return reply.status(404).send({ error: "unknown epoch" });
    return {
      epoch: epochView(e),
      ious: db.all<IouRow>("SELECT * FROM ious WHERE epoch = ? OR posted_epoch = ? ORDER BY buyer, nonce_num", id, id).map(iouView),
      positions: db.all<PositionRow>("SELECT * FROM positions WHERE epoch = ? ORDER BY net", id).map(positionView),
      settlements: db.all<SettlementRow>("SELECT * FROM settlements WHERE epoch = ?", id).map(settlementView),
      payouts: db.all<PayoutRow>("SELECT * FROM payouts WHERE epoch = ?", id).map(payoutView),
      disputes: db.all<DisputeRow>("SELECT * FROM disputes WHERE epoch = ?", id).map(disputeView),
      txs: db.all("SELECT * FROM epoch_txs WHERE epoch = ? ORDER BY at", id),
      explorer: chain.explorer,
    };
  });

  app.get("/v1/epochs/:id/verify", async (req) => verifyEpoch(db, chain, registry, domain, Number((req.params as { id: string }).id)));

  app.get("/v1/epochs/:id/reputation", async (req) => {
    const id = Number((req.params as { id: string }).id);
    return {
      epoch: id,
      formula: "kohaku-reputation-v1",
      scores: db.all("SELECT agent_id, score, previous, inputs_json, tx FROM reputation_history WHERE epoch = ? ORDER BY agent_id", id).map((r) => {
        const row = r as { agent_id: number; score: number; previous: number; inputs_json: string; tx: string | null };
        return { agentId: String(row.agent_id), score: row.score, previous: row.previous, inputs: JSON.parse(row.inputs_json), tx: row.tx };
      }),
    };
  });

  app.get("/v1/epochs/:id/export.csv", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const rows = db.all<IouRow & { service: string; job_status: string }>(
      "SELECT i.*, j.service, j.status AS job_status FROM ious i JOIN jobs j ON j.id = i.job_id WHERE i.epoch = ? OR i.posted_epoch = ? ORDER BY i.buyer, i.nonce_num",
      id,
      id,
    );
    const stl = db.all<SettlementRow>("SELECT * FROM settlements WHERE epoch = ?", id);
    const lines = [
      `# Kohaku epoch ${id} audit export, chain ${chain.key} (${chain.viemChain.id}), clearing house ${chain.d.clearingHouse}`,
      "section,iou_digest,job_id,service,buyer,seller,amount_units,amount_usd,status,nonce,signature",
      ...rows.map((r) => ["iou", r.digest, r.job_id, r.service, r.buyer, r.seller, r.amount, formatUnits(BigInt(r.amount), 6), r.status, r.nonce, r.signature].join(",")),
      "section,settlement_id,agent,amount_units,status,hsp_mode,hsp_payment_id,settlement_tx,hsp_receipt_hash,record_tx",
      ...stl.map((s) => ["settlement", s.id, s.agent_id, s.amount, s.status, s.hsp_mode, s.hsp_payment_id ?? "", s.settlement_tx ?? "", s.receipt_hash ?? "", s.record_tx ?? ""].join(",")),
    ];
    reply.header("content-type", "text/csv").header("content-disposition", `attachment; filename="kohaku-epoch-${id}.csv"`);
    return lines.join("\n");
  });

  app.get("/v1/agents/:id/export.csv", async (req, reply) => {
    const n = Number((req.params as { id: string }).id);
    const jobs = db.all<JobRow>("SELECT * FROM jobs WHERE buyer = ? OR seller = ? ORDER BY created_at", n, n);
    const stl = db.all<SettlementRow>("SELECT * FROM settlements WHERE agent_id = ? ORDER BY epoch", n);
    const pay = db.all<PayoutRow>("SELECT * FROM payouts WHERE agent_id = ? ORDER BY epoch", n);
    const lines = [
      `# Kohaku compliance export for agent #${n} (${registry.get(n)?.name ?? ""}), chain ${chain.key}`,
      "section,id,epoch,side,counterparty,service,amount_units,status,created_at",
      ...jobs.map((j) => ["job", j.id, j.epoch, j.buyer === n ? "bought" : "sold", j.buyer === n ? j.seller : j.buyer, j.service, j.price, j.status, new Date(j.created_at).toISOString()].join(",")),
      "section,id,epoch,amount_units,status,hsp_payment_id,settlement_tx,hsp_receipt_hash,record_tx",
      ...stl.map((s) => ["settlement", s.id, s.epoch, s.amount, s.status, s.hsp_payment_id ?? "", s.settlement_tx ?? "", s.receipt_hash ?? "", s.record_tx ?? ""].join(",")),
      "section,epoch,to,amount_units,tx",
      ...pay.map((p) => ["payout", p.epoch, p.to_addr, p.amount, p.tx ?? ""].join(",")),
    ];
    reply.header("content-type", "text/csv").header("content-disposition", `attachment; filename="kohaku-agent-${n}.csv"`);
    return lines.join("\n");
  });

  // ---------------------------------------------------------------- jobs & IOUs

  app.get("/v1/jobs", async (req) => {
    const { agent, limit, epoch, parent } = req.query as { agent?: string; limit?: string; epoch?: string; parent?: string };
    if (parent) return db.all<JobRow>("SELECT * FROM jobs WHERE parent_job = ? ORDER BY created_at", parent).map(jobView);
    if (epoch) return db.all<JobRow>("SELECT * FROM jobs WHERE epoch = ? ORDER BY created_at DESC LIMIT ?", Number(epoch), Number(limit ?? 200)).map(jobView);
    if (agent) return db.all<JobRow>("SELECT * FROM jobs WHERE buyer = ? OR seller = ? ORDER BY created_at DESC LIMIT ?", Number(agent), Number(agent), Number(limit ?? 100)).map(jobView);
    return db.all<JobRow>("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?", Number(limit ?? 100)).map(jobView);
  });

  /** The complete chain of evidence for one job. */
  app.get("/v1/jobs/:id", async (req, reply) => {
    const job = ledger.job((req.params as { id: string }).id);
    if (!job) return reply.status(404).send({ error: "unknown job" });
    const iou = db.get<IouRow>("SELECT * FROM ious WHERE job_id = ?", job.id);
    const dispute = db.get<DisputeRow>("SELECT * FROM disputes WHERE job_id = ?", job.id);
    const settledIn = iou?.posted_epoch ?? null;
    const epoch = settledIn ? epochs.row(settledIn) : epochs.row(job.epoch);
    const buyerPos = settledIn ? db.get<PositionRow>("SELECT * FROM positions WHERE epoch = ? AND agent_id = ?", settledIn, job.buyer) : undefined;
    const sellerPos = settledIn ? db.get<PositionRow>("SELECT * FROM positions WHERE epoch = ? AND agent_id = ?", settledIn, job.seller) : undefined;
    const buyerSettlement = settledIn ? db.get<SettlementRow>("SELECT * FROM settlements WHERE epoch = ? AND agent_id = ?", settledIn, job.buyer) : undefined;
    const sellerPayout = settledIn ? db.get<PayoutRow>("SELECT * FROM payouts WHERE epoch = ? AND agent_id = ?", settledIn, job.seller) : undefined;
    const children = db.all<JobRow>("SELECT * FROM jobs WHERE parent_job = ? ORDER BY created_at", job.id).map(jobView);
    const parent = job.parent_job ? ledger.job(job.parent_job) : undefined;
    return {
      job: jobView(job),
      spec: JSON.parse(job.spec_json),
      quote: { message: JSON.parse(job.quote_json), signature: job.quote_sig, hash: job.quote_hash },
      iou: iou ? { ...iouView(iou), postedEpoch: iou.posted_epoch } : null,
      delivery: job.delivered_at
        ? { deliveredAt: job.delivered_at, resultHash: job.result_hash, signature: job.delivery_sig, challengeEndsAt: job.challenge_ends_at, message: job.delivery_json ? JSON.parse(job.delivery_json) : null }
        : null,
      dispute: dispute ? disputeView(dispute) : null,
      epoch: epoch ? epochView(epoch) : null,
      positions: { buyer: buyerPos ? positionView(buyerPos) : null, seller: sellerPos ? positionView(sellerPos) : null },
      buyerSettlement: buyerSettlement
        ? { ...settlementView(buyerSettlement), receipt: buyerSettlement.receipt_json ? JSON.parse(buyerSettlement.receipt_json) : null }
        : null,
      sellerPayout: sellerPayout ? payoutView(sellerPayout) : null,
      parties: {
        buyer: pick(registry.get(job.buyer)),
        seller: pick(registry.get(job.seller)),
      },
      parent: parent ? jobView(parent) : null,
      children,
      verify: { domain: { ...domain, chainId: Number(domain.chainId) }, explorer: chain.explorer, clearingHouse: chain.d.clearingHouse },
    };
  });

  app.post("/v1/ious", async (req) => ledger.submitIou(req.body as SubmitIouInput));

  app.post("/v1/deliveries", async (req) => ledger.deliver(req.body as Parameters<Ledger["deliver"]>[0]));

  app.get("/v1/refusals", async (req) => {
    const { limit } = req.query as { limit?: string };
    return db.all("SELECT * FROM refusals ORDER BY id DESC LIMIT ?", Number(limit ?? 100));
  });

  // ---------------------------------------------------------------- disputes

  app.get("/v1/disputes", async (req) => {
    const { status, validator, limit } = req.query as { status?: string; validator?: string; limit?: string };
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (status) {
      where.push("status = ?");
      params.push(status);
    }
    if (validator) {
      where.push("validator = ?");
      params.push(Number(validator));
    }
    return db
      .all<DisputeRow>(`SELECT * FROM disputes ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY filed_at DESC LIMIT ?`, ...params, Number(limit ?? 100))
      .map((d) => ({ ...disputeView(d), job: jobView(ledger.job(d.job_id)!) }));
  });

  app.get("/v1/disputes/:id", async (req, reply) => {
    const d = db.get<DisputeRow>("SELECT * FROM disputes WHERE id = ?", (req.params as { id: string }).id);
    if (!d) return reply.status(404).send({ error: "unknown dispute" });
    const job = ledger.job(d.job_id)!;
    return {
      dispute: disputeView(d),
      job: jobView(job),
      spec: JSON.parse(job.spec_json),
      quote: JSON.parse(job.quote_json),
      result: job.result_json ? JSON.parse(job.result_json) : null,
    };
  });

  app.post("/v1/disputes", async (req) => ledger.fileDispute(req.body as Parameters<Ledger["fileDispute"]>[0]));

  app.post("/v1/disputes/:id/verdict", async (req) =>
    ledger.verdict((req.params as { id: string }).id, req.body as Parameters<Ledger["verdict"]>[1]),
  );

  // ---------------------------------------------------------------- intents

  app.get("/v1/intents", async (req) => {
    const { operator, buyer, limit } = req.query as { operator?: string; buyer?: string; limit?: string };
    return intents.list({ operator, buyer, limit: limit ? Number(limit) : undefined });
  });

  app.get("/v1/intents/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const i = intents.get(id);
    if (!i) return reply.status(404).send({ error: "unknown intent" });
    const jobs = db.all<JobRow>("SELECT * FROM jobs WHERE intent_id = ? ORDER BY created_at DESC LIMIT 200", id).map(jobView);
    const refusals = db.all("SELECT * FROM refusals WHERE intent_id = ? ORDER BY id DESC LIMIT 50", id);
    return { intent: i, jobs, refusals };
  });

  app.post("/v1/intents", async (req) => {
    const b = req.body as { intent: Record<keyof IntentMandate, unknown>; signature: Hex };
    const i = b.intent;
    const intent: IntentMandate = {
      operator: String(i.operator) as Address,
      buyer: BigInt(String(i.buyer)),
      goal: String(i.goal),
      budget: BigInt(String(i.budget)),
      perJobCap: BigInt(String(i.perJobCap)),
      minSellerReputation: Number(i.minSellerReputation),
      allowedServices: (i.allowedServices as string[]) ?? [],
      allowedSellers: ((i.allowedSellers as string[]) ?? []).map((s) => BigInt(s)),
      notBefore: BigInt(String(i.notBefore)),
      deadline: BigInt(String(i.deadline)),
      nonce: BigInt(String(i.nonce)),
    };
    const view = await intents.register(intent, b.signature);
    bus.publish({ type: "intent", at: Date.now(), intent: view });
    log("info", "intents", `intent ${view.id.slice(0, 10)} for #${view.buyer}: "${view.goal}" budget ${view.budget}`);
    return view;
  });

  app.post("/v1/intents/:id/revoke", async (req) => {
    const b = req.body as { revokedAt: string; signature: Hex };
    const view = await intents.revoke((req.params as { id: string }).id as Hex, BigInt(b.revokedAt), b.signature);
    bus.publish({ type: "intent", at: Date.now(), intent: view });
    return view;
  });

  // ---------------------------------------------------------------- settlement & HSP

  app.get("/v1/settlements", async (req) => {
    const q = req.query as { agentId?: string; status?: string; epoch?: string; limit?: string };
    return settlements
      .list({ agentId: q.agentId, status: q.status, epoch: q.epoch ? Number(q.epoch) : undefined, limit: q.limit ? Number(q.limit) : undefined })
      .map((r) => ({ ...settlementView(r), order: settlements.order(r) }));
  });

  app.post("/v1/settlements/:id/paid", async (req) => {
    const row = await settlements.report((req.params as { id: string }).id, req.body as PaymentReport);
    return settlementView(row);
  });

  app.get("/v1/hsp", async () => ({ ...hsp.info(), healthy: ctx.hspHealthy() }));

  // HashKey Merchant webhook format; HSP's ack convention is { code: 0 }
  app.post("/v1/hsp/webhook", async (req, reply) => {
    const r = acceptWebhook(db, cfg.hspAppSecret, req.headers, req.rawBody ?? "");
    if (!r.ok) {
      log("warn", "hsp", `webhook rejected: ${r.reason}`);
      return reply.status(r.status).send({ code: r.status, msg: r.reason });
    }
    if (r.duplicate) return { code: 0, duplicate: true };
    const s = r.event.cartMandateId ? settlements.byCartMandateId(r.event.cartMandateId) : undefined;
    if (s) void settlements.onHspEvent(s.hsp_cart_id!);
    return { code: 0 };
  });

  ctx.gateway?.mount(app, "/hsp");

  // ---------------------------------------------------------------- scenario runner (demo control)

  app.get("/v1/scenario", async () => {
    try {
      const r = await fetch(`${cfg.FLEET_CONTROL_URL}/control/status`, { signal: AbortSignal.timeout(2_000) });
      return await r.json();
    } catch {
      return { reachable: false };
    }
  });

  app.post("/v1/scenario", async (req) => {
    requireAdmin(req);
    const { action, token: _token, ...rest } = req.body as { action: string; token?: string } & Record<string, unknown>;
    if (!/^[a-z-]+$/.test(action)) throw new Error("bad action");
    const r = await fetch(`${cfg.FLEET_CONTROL_URL}/control/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-token": cfg.ADMIN_TOKEN },
      body: JSON.stringify(rest),
      signal: AbortSignal.timeout(5_000),
    });
    return r.json();
  });

  app.post("/v1/admin/close-epoch", async (req) => {
    requireAdmin(req);
    epochs.closeIntakeNow();
    return { ok: true, epoch: epochs.intake().id };
  });

  // ---------------------------------------------------------------- live

  app.get("/v1/live", { websocket: true }, (socket) => {
    const send = (e: LiveEvent) => {
      if (socket.readyState === 1) socket.send(JSON.stringify(e));
    };
    send({ type: "hello", at: Date.now(), stats: stats() });
    for (const e of bus.history().filter((x) => x.type !== "log").slice(-150)) send(e);
    const listener = (e: LiveEvent) => send(e);
    bus.on("event", listener);
    socket.on("close", () => bus.off("event", listener));
  });

  return app;
}

function pick(a: AgentRecord | undefined) {
  return a ? { agentId: a.agentId.toString(), name: a.name, signer: a.signer, operator: a.operator, role: a.role } : null;
}

function jsonSafe<T extends object>(o: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));
}

import type { Hex } from "viem";
import { net, type NettingResult } from "@kohaku/core";
import type { Db } from "./db.ts";
import type { Chain } from "./chain.ts";
import { abis } from "./chain.ts";
import type { Registry } from "./registry.ts";
import type { ReputationBook } from "./reputation.ts";
import type { Settlements } from "./settlements.ts";
import type { Intents } from "./intents.ts";
import type { IntakeEpoch } from "./ledger.ts";
import { bus, log } from "./bus.ts";
import { epochView, positionView, type EpochRow, type IouRow, type PositionRow } from "./views.ts";

export interface EpochTimings {
  intakeSeconds: number;
  challengeSeconds: number;
  arbitrationTimeoutSeconds: number;
  postChunkSize: number;
  writeReputation: boolean;
  /** write scores on chain every N epochs (scores are cumulative, so nothing is lost) */
  reputationStride: number;
  publicUrl: string;
  /** keep an epoch with no IOUs open instead of finalising it empty (saves gas on public chains) */
  extendIdle?: boolean;
}

/**
 * The clearing clock. Each epoch moves through:
 *
 *   intake ──> challenge ──> closing ──> settling ──> paying ──> sealed
 *
 * intake     IOUs for this epoch are accepted (the clearing service is the authoritative
 *            clock; agents never decide which epoch they are in)
 * challenge  no new IOUs; buyers can still dispute delivered jobs until their window ends
 * closing    undelivered jobs are voided, unresolved disputes are held out, the IOU set is
 *            netted, posted to the clearing house in chunks and finalised there
 * settling   each net debtor pays its exact debt through HSP before the deadline
 * paying     creditors are paid from the pool and the epoch receipt is sealed
 *
 * Several epochs are in flight at once (one in intake while the previous one settles),
 * but on-chain finalisation is strictly sequential, as the contract requires.
 *
 * With `extendIdle`, an epoch whose intake ends without a single IOU stays in intake for
 * another window instead of being finalised empty, so a quiet clearing house costs no gas.
 */
export class EpochEngine {
  private intakeId = 0;
  private timer: NodeJS.Timeout | null = null;
  private closing = false;
  private retryAt = new Map<number, { at: number; attempts: number }>();
  private repFlushing = false;

  constructor(
    private readonly db: Db,
    private readonly chain: Chain,
    private readonly registry: Registry,
    private readonly rep: ReputationBook,
    private readonly intents: Intents,
    private readonly settlements: Settlements,
    private readonly t: EpochTimings,
  ) {}

  intake(): IntakeEpoch {
    const e = this.row(this.intakeId)!;
    return { id: e.id, intakeEndsAt: e.intake_ends_at };
  }

  current(): EpochRow {
    return this.row(this.intakeId)!;
  }

  row(id: number): EpochRow | undefined {
    return this.db.get<EpochRow>("SELECT * FROM epochs WHERE id = ?", id);
  }

  async start(): Promise<void> {
    const chainNext = Number(await this.chain.currentEpoch());
    const max = this.db.get<{ m: number | null }>("SELECT MAX(id) AS m FROM epochs")?.m ?? null;
    const now = Date.now();
    if (max === null || max < chainNext - 1) {
      if (max !== null) log("warn", "epochs", `local ledger is behind the chain (db ${max}, chain next ${chainNext}); continuing from the chain`);
      this.db.setMeta("first_epoch", String(chainNext));
      if (!this.db.getMeta("rep_next_epoch")) this.db.setMeta("rep_next_epoch", String(chainNext));
      this.create(chainNext, now);
    } else {
      const latest = this.row(max)!;
      if (latest.phase === "intake" && latest.intake_ends_at > now) {
        this.intakeId = max;
      } else {
        if (latest.phase === "intake") this.setPhase(max, "challenge");
        this.create(max + 1, now);
      }
    }
    log("info", "epochs", `clearing clock started at epoch ${this.intakeId} (chain expects ${chainNext} next)`);
    this.timer = setInterval(() => void this.tick(), 500);
    void this.flushReputation();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Close the intake window early (scenario runner and tests). */
  closeIntakeNow(): void {
    this.db.run("UPDATE epochs SET intake_ends_at = ?, challenge_ends_at = ? WHERE id = ?", Date.now(), Date.now() + this.t.challengeSeconds * 1000, this.intakeId);
  }

  private create(id: number, startsAt: number): void {
    const intakeEnds = startsAt + this.t.intakeSeconds * 1000;
    this.db.run(
      "INSERT INTO epochs(id, phase, starts_at, intake_ends_at, challenge_ends_at) VALUES (?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
      id,
      "intake",
      startsAt,
      intakeEnds,
      intakeEnds + this.t.challengeSeconds * 1000,
    );
    this.intakeId = id;
    this.publish(id);
  }

  /** Nothing to clear: no IOU in this epoch and none carried over from an earlier one. */
  private idle(id: number): boolean {
    const n = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM ious WHERE epoch = ? OR status = 'carried'", id)!.n;
    return n === 0;
  }

  private setPhase(id: number, phase: string, extra: Record<string, string | number | null> = {}): void {
    const sets = ["phase = ?", ...Object.keys(extra).map((k) => `${k} = ?`)];
    this.db.run(`UPDATE epochs SET ${sets.join(", ")} WHERE id = ?`, phase, ...Object.values(extra), id);
    this.publish(id);
  }

  private publish(id: number): void {
    const e = this.row(id);
    if (e) bus.publish({ type: "epoch.phase", at: Date.now(), epoch: epochView(e) });
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    const cur = this.row(this.intakeId);
    if (cur && now >= cur.intake_ends_at) {
      if (this.t.extendIdle && this.idle(cur.id)) {
        const ends = now + this.t.intakeSeconds * 1000;
        this.db.run("UPDATE epochs SET intake_ends_at = ?, challenge_ends_at = ? WHERE id = ?", ends, ends + this.t.challengeSeconds * 1000, cur.id);
        this.publish(cur.id);
      } else {
        this.setPhase(cur.id, "challenge");
        this.create(cur.id + 1, now);
      }
    }
    for (const e of this.db.all<EpochRow>("SELECT * FROM epochs WHERE phase = 'challenge' AND challenge_ends_at <= ?", now)) {
      this.setPhase(e.id, "closing");
    }
    if (this.closing) return;
    const next = this.db.get<EpochRow>("SELECT * FROM epochs WHERE phase = 'closing' ORDER BY id LIMIT 1");
    if (!next) return;
    const retry = this.retryAt.get(next.id);
    if (retry && retry.at > now) return;
    this.closing = true;
    try {
      await this.close(next);
      this.retryAt.delete(next.id);
    } catch (err) {
      const attempts = (retry?.attempts ?? 0) + 1;
      const backoff = Math.min(60_000, 2_000 * 2 ** Math.min(attempts, 5));
      this.retryAt.set(next.id, { at: Date.now() + backoff, attempts });
      this.db.run("UPDATE epochs SET onchain = 'failed', error = ? WHERE id = ?", (err as Error).message, next.id);
      this.publish(next.id);
      log("error", "epochs", `closing epoch ${next.id} failed (attempt ${attempts}, retry in ${backoff / 1000}s): ${(err as Error).message}`);
    } finally {
      this.closing = false;
    }
  }

  // ---------------------------------------------------------------- closing

  private async close(e: EpochRow): Promise<void> {
    const now = Date.now();

    // 1. a job never delivered is never paid for
    const undelivered = this.db.all<IouRow & { intent_id: string | null }>(
      `SELECT i.*, j.intent_id FROM ious i JOIN jobs j ON j.id = i.job_id
       WHERE i.epoch = ? AND i.status = 'pending' AND j.status = 'accepted'`,
      e.id,
    );
    if (undelivered.length) {
      this.db.tx(() => {
        for (const u of undelivered) {
          this.db.run("UPDATE ious SET status = 'voided' WHERE digest = ?", u.digest);
          this.db.run("UPDATE jobs SET status = 'voided' WHERE id = ?", u.job_id);
          this.intents.refund(u.intent_id, BigInt(u.amount));
        }
      });
      log("info", "epochs", `epoch ${e.id}: voided ${undelivered.length} undelivered job(s)`);
    }

    // 2. disputes: wait for the validator up to the arbitration timeout, then hold out
    const open = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM disputes WHERE epoch = ? AND status = 'open'", e.id)!.n;
    if (open > 0 && now < e.challenge_ends_at + this.t.arbitrationTimeoutSeconds * 1000) return;
    const heldOut = this.db.all<IouRow>("SELECT * FROM ious WHERE epoch = ? AND status = 'disputed' ORDER BY digest", e.id);
    if (heldOut.length) {
      this.db.run("UPDATE ious SET status = 'held_out' WHERE epoch = ? AND status = 'disputed'", e.id);
      log("info", "epochs", `epoch ${e.id}: holding out ${heldOut.length} IOU(s) with unresolved disputes`);
    }

    // 3. the IOU set: carried-in IOUs (rejected disputes from earlier epochs) then this epoch's
    const carried = this.db.all<IouRow>(
      "SELECT * FROM ious WHERE (status = 'carried' AND epoch < ?) OR (status = 'posted' AND posted_epoch = ? AND epoch < ?) ORDER BY epoch, buyer, nonce_num",
      e.id,
      e.id,
      e.id,
    );
    const normal = this.db.all<IouRow>("SELECT * FROM ious WHERE epoch = ? AND status IN ('pending','posted') ORDER BY buyer, nonce_num", e.id);
    const result = net(normal.map(toNettable), carried.map(toNettable));

    // 4. chain: hold out -> carried -> chunks -> finalise (each step resumes from chain state)
    this.db.run("UPDATE epochs SET onchain = 'posting', error = NULL WHERE id = ?", e.id);
    this.publish(e.id);
    const chainNext = Number(await this.chain.currentEpoch());
    if (chainNext < e.id) throw new Error(`waiting for epoch ${chainNext} to finalise on chain first`);
    if (chainNext === e.id) await this.post(e.id, heldOut, carried, normal, result);

    // 5. read back what the chain computed and open settlement (a load-balanced RPC can
    //    answer from a node that has not seen the finalise yet, so re-read before failing)
    let ce = await this.chain.epoch(BigInt(e.id));
    for (let i = 0; i < 5 && (ce.iouSetHash !== result.iouSetHash || ce.positionsHash !== result.positionsHash); i++) {
      await new Promise((r) => setTimeout(r, 1500));
      ce = await this.chain.epoch(BigInt(e.id));
    }
    if (ce.iouSetHash !== result.iouSetHash || ce.positionsHash !== result.positionsHash) {
      throw new Error(
        `chain result for epoch ${e.id} differs from the local ledger (set ${ce.iouSetHash} vs ${result.iouSetHash}, positions ${ce.positionsHash} vs ${result.positionsHash})`,
      );
    }
    const byId = new Map(result.positions.map((p) => [p.agentId.toString(), p]));
    const debtors = result.positions.filter((p) => p.net < 0n).map((p) => ({ agentId: p.agentId, owed: -p.net }));
    const deadline = Number(ce.settleDeadline) * 1000;
    this.db.tx(() => {
      for (const p of byId.values()) {
        this.db.run(
          "INSERT INTO positions(epoch, agent_id, credit, debit, net, state) VALUES (?,?,?,?,?,?) ON CONFLICT(epoch, agent_id) DO NOTHING",
          e.id,
          Number(p.agentId),
          Number(p.credit),
          Number(p.debit),
          Number(p.net),
          p.net < 0n ? "owes" : p.net > 0n ? "creditor" : "flat",
        );
      }
      for (const i of [...carried, ...normal]) this.db.run("UPDATE ious SET status = 'netted', posted_epoch = ? WHERE digest = ?", e.id, i.digest);
      this.db.run(
        `UPDATE epochs SET phase = ?, onchain = ?, iou_count = ?, gross = ?, net = ?, debtors = ?, creditors = ?, iou_set_hash = ?, positions_hash = ?,
           settle_deadline = ?, held_out = ?, carried = ?, error = NULL WHERE id = ?`,
        debtors.length ? "settling" : "closing",
        "finalized",
        result.stats.iouCount,
        Number(result.stats.grossVolume),
        Number(result.stats.netVolume),
        result.stats.debtors,
        result.stats.creditors,
        result.iouSetHash,
        result.positionsHash,
        deadline,
        heldOut.length,
        carried.length,
        e.id,
      );
    });
    void this.registry.refreshCollateral(result.positions.map((p) => p.agentId));
    this.settlements.createOrders(e.id, debtors, deadline);
    const positions = this.db.all<PositionRow>("SELECT * FROM positions WHERE epoch = ? ORDER BY net", e.id).map(positionView);
    bus.publish({ type: "epoch.netted", at: Date.now(), epoch: epochView(this.row(e.id)!), positions });
    log(
      "info",
      "epochs",
      `epoch ${e.id} netted: ${result.stats.iouCount} IOUs, gross ${result.stats.grossVolume} -> ${result.stats.settlementTransfers} transfers, net ${result.stats.netVolume}`,
    );
    if (debtors.length === 0) await this.settlements.seal(e.id, null);
  }

  private async post(id: number, heldOut: IouRow[], carried: IouRow[], normal: IouRow[], result: NettingResult): Promise<void> {
    const ch = this.chain.d.clearingHouse;
    let ce = await this.chain.epoch(BigInt(id));
    if (heldOut.length && ce.heldOutCount === 0 && ce.status === 0) {
      await this.chain.write(`holdOut e${id}`, {
        address: ch,
        abi: abis.clearingHouseAbi,
        functionName: "holdOut",
        args: [BigInt(id), heldOut.map((h) => h.digest as Hex)],
      });
    }
    for (let i = ce.carriedCount; i < carried.length; i++) {
      const c = carried[i]!;
      await this.chain.write(`postCarried e${id}`, {
        address: ch,
        abi: abis.clearingHouseAbi,
        functionName: "postCarried",
        args: [BigInt(id), toStruct(c), c.signature as Hex],
      });
      this.db.run("UPDATE ious SET status = 'posted', posted_epoch = ? WHERE digest = ?", id, c.digest);
    }
    ce = await this.chain.epoch(BigInt(id));
    const alreadyPosted = ce.iouCount - ce.carriedCount;
    const sorted = result.ordered.slice(carried.length);
    const rowsByDigest = new Map(normal.map((n) => [n.digest, n]));
    for (let start = alreadyPosted; start < sorted.length; start += this.t.postChunkSize) {
      const chunk = sorted.slice(start, start + this.t.postChunkSize).map((x) => rowsByDigest.get(x.digest)!);
      const receipt = await this.chain.write(`postIous e${id} [${start}..${start + chunk.length})`, {
        address: ch,
        abi: abis.clearingHouseAbi,
        functionName: "postIous",
        args: [BigInt(id), chunk.map(toStruct), chunk.map((c) => c.signature as Hex)],
      });
      this.db.run("INSERT OR IGNORE INTO epoch_txs(hash, epoch, kind, gas_used, at) VALUES (?,?,?,?,?)", receipt.transactionHash, id, "postIous", Number(receipt.gasUsed), Date.now());
      for (const c of chunk) this.db.run("UPDATE ious SET status = 'posted', posted_epoch = ? WHERE digest = ?", id, c.digest);
    }
    const receipt = await this.chain.write(`finalizeEpoch e${id}`, {
      address: ch,
      abi: abis.clearingHouseAbi,
      functionName: "finalizeEpoch",
      args: [BigInt(id), result.iouSetHash, result.positionsHash],
    });
    this.db.run("UPDATE epochs SET finalize_tx = ? WHERE id = ?", receipt.transactionHash, id);
    this.db.run("INSERT OR IGNORE INTO epoch_txs(hash, epoch, kind, gas_used, at) VALUES (?,?,?,?,?)", receipt.transactionHash, id, "finalizeEpoch", Number(receipt.gasUsed), Date.now());
  }

  // ---------------------------------------------------------------- reputation

  /** Write per-epoch scores on chain, strictly in epoch order. */
  async flushReputation(): Promise<void> {
    if (this.repFlushing) return;
    this.repFlushing = true;
    try {
      let next = Number(this.db.getMeta("rep_next_epoch") ?? this.db.getMeta("first_epoch") ?? "1");
      for (;;) {
        const e = this.row(next);
        if (!e || e.phase !== "sealed") break;
        const ids = this.registry.list().map((a) => a.agentId);
        const { rows, detailsHash } = this.rep.epochScores(next, ids);
        // write only agents with a track record whose score moved since the last on-chain write
        const changed = rows.filter((r) => {
          const onchain = this.rep.chainScore(r.agentId).score;
          const active = r.inputs.completed + r.inputs.settledOnTime + r.inputs.defaults + r.inputs.disputesLost + r.inputs.frivolousDisputes > 0;
          return onchain === null ? active : r.score !== onchain;
        });
        if (changed.length && this.t.writeReputation && next % this.t.reputationStride === 0) {
          const receipt = await this.chain.write(`recordEpochScores e${next}`, {
            address: this.chain.d.reputationRegistry,
            abi: abis.reputationRegistryAbi,
            functionName: "recordEpochScores",
            args: [BigInt(next), changed.map((r) => r.agentId), changed.map((r) => BigInt(r.score)), detailsHash, `${this.t.publicUrl}/v1/epochs/${next}/reputation`],
          });
          this.rep.markWritten(next, changed.map((r) => r.agentId), receipt.transactionHash);
        }
        const moved = rows.filter((r) => r.score !== r.previous).map((r) => ({ agentId: r.agentId.toString(), score: r.score, previous: r.previous }));
        if (moved.length) bus.publish({ type: "reputation", at: Date.now(), epoch: next, scores: moved });
        next += 1;
        this.db.setMeta("rep_next_epoch", String(next));
      }
    } catch (err) {
      log("warn", "reputation", `writing epoch scores failed, will retry: ${(err as Error).message}`);
    } finally {
      this.repFlushing = false;
    }
  }
}

function toNettable(r: IouRow) {
  return { buyer: BigInt(r.buyer), seller: BigInt(r.seller), amount: BigInt(r.amount), nonce: BigInt(r.nonce), digest: r.digest as Hex };
}

function toStruct(r: IouRow) {
  return {
    buyer: BigInt(r.buyer),
    seller: BigInt(r.seller),
    amount: BigInt(r.amount),
    token: r.token as Hex,
    jobHash: r.job_hash as Hex,
    quoteHash: r.quote_hash as Hex,
    epoch: BigInt(r.epoch),
    nonce: BigInt(r.nonce),
  };
}

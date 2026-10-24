import { scoreReputation, emptyInputs, hashJson, type ReputationInputs } from "@kohaku/core";
import type { Db } from "./db.ts";

interface Count {
  n: number;
}

/**
 * Reputation from objective facts in the ledger. The live score moves the moment a
 * dispute is decided or a debtor defaults (buyers filter on it), and once per sealed
 * epoch the same formula is written to the on-chain reputation registry.
 */
export class ReputationBook {
  private cache = new Map<string, { score: number; inputs: ReputationInputs }>();

  constructor(private readonly db: Db) {}

  inputs(agentId: bigint, uptoEpoch?: number): ReputationInputs {
    const id = Number(agentId);
    const epochFilter = uptoEpoch === undefined ? "" : ` AND epoch <= ${Math.floor(uptoEpoch)}`;
    const i = emptyInputs();
    i.completed = this.db.get<Count>(
      `SELECT COUNT(*) AS n FROM jobs WHERE seller = ? AND status IN ('delivered','settled')${epochFilter}`,
      id,
    )!.n;
    i.disputesLost = this.db.get<Count>(`SELECT COUNT(*) AS n FROM disputes WHERE seller = ? AND status = 'upheld'${epochFilter}`, id)!.n;
    i.disputesWon = this.db.get<Count>(`SELECT COUNT(*) AS n FROM disputes WHERE seller = ? AND status = 'rejected'${epochFilter}`, id)!.n;
    i.frivolousDisputes = this.db.get<Count>(`SELECT COUNT(*) AS n FROM disputes WHERE buyer = ? AND status = 'rejected'${epochFilter}`, id)!.n;
    i.settledOnTime = this.db.get<Count>(`SELECT COUNT(*) AS n FROM settlements WHERE agent_id = ? AND status = 'recorded'${epochFilter}`, id)!.n;
    i.defaults = this.db.get<Count>(`SELECT COUNT(*) AS n FROM settlements WHERE agent_id = ? AND status = 'defaulted'${epochFilter}`, id)!.n;
    const vol = this.db.get<{ v: number | null }>(
      `SELECT SUM(price) AS v FROM jobs WHERE seller = ? AND status IN ('delivered','settled')${epochFilter}`,
      id,
    );
    i.volume = BigInt(vol?.v ?? 0);
    return i;
  }

  /** Live score, recomputed on demand and cached until invalidated. */
  live(agentId: bigint): number {
    const key = agentId.toString();
    const hit = this.cache.get(key);
    if (hit) return hit.score;
    const inputs = this.inputs(agentId);
    const score = scoreReputation(inputs).score;
    this.cache.set(key, { score, inputs });
    this.db.run(
      `INSERT INTO reputation(agent_id, live_score, inputs_json, updated_at) VALUES (?,?,?,?)
       ON CONFLICT(agent_id) DO UPDATE SET live_score = excluded.live_score, inputs_json = excluded.inputs_json, updated_at = excluded.updated_at`,
      Number(agentId),
      score,
      jsonInputs(inputs),
      Date.now(),
    );
    return score;
  }

  /** Drop cached scores; returns old -> new for agents whose score changed. */
  invalidate(agentIds: bigint[]): { agentId: string; score: number; previous: number }[] {
    const changes: { agentId: string; score: number; previous: number }[] = [];
    for (const id of agentIds) {
      const prev = this.cache.get(id.toString())?.score ?? this.stored(id);
      this.cache.delete(id.toString());
      const now = this.live(id);
      if (prev !== undefined && prev !== now) changes.push({ agentId: id.toString(), score: now, previous: prev });
    }
    return changes;
  }

  private stored(agentId: bigint): number | undefined {
    return this.db.get<{ live_score: number }>("SELECT live_score FROM reputation WHERE agent_id = ?", Number(agentId))?.live_score;
  }

  /** Scores as of the end of `epoch`, stored in history. Returns what to write on chain. */
  epochScores(epoch: number, agentIds: bigint[]) {
    const rows = agentIds.map((id) => {
      const inputs = this.inputs(id, epoch);
      const score = scoreReputation(inputs).score;
      const prev =
        this.db.get<{ score: number }>(
          "SELECT score FROM reputation_history WHERE agent_id = ? AND epoch < ? ORDER BY epoch DESC LIMIT 1",
          Number(id),
          epoch,
        )?.score ?? scoreReputation(emptyInputs()).score;
      return { agentId: id, score, previous: prev, inputs };
    });
    const details = rows.map((r) => ({ agentId: r.agentId.toString(), score: r.score, inputs: { ...r.inputs, volume: r.inputs.volume.toString() } }));
    const detailsHash = hashJson({ epoch, formula: "kohaku-reputation-v1", details });
    for (const r of rows) {
      this.db.run(
        `INSERT INTO reputation_history(agent_id, epoch, score, previous, inputs_json, at) VALUES (?,?,?,?,?,?)
         ON CONFLICT(agent_id, epoch) DO UPDATE SET score = excluded.score, previous = excluded.previous, inputs_json = excluded.inputs_json`,
        Number(r.agentId),
        epoch,
        r.score,
        r.previous,
        jsonInputs(r.inputs),
        Date.now(),
      );
    }
    return { rows, details, detailsHash };
  }

  markWritten(epoch: number, agentIds: bigint[], tx: string): void {
    for (const id of agentIds) {
      this.db.run("UPDATE reputation_history SET tx = ? WHERE agent_id = ? AND epoch = ?", tx, Number(id), epoch);
      const row = this.db.get<{ score: number }>("SELECT score FROM reputation_history WHERE agent_id = ? AND epoch = ?", Number(id), epoch);
      if (row) {
        this.live(id); // make sure the row exists
        this.db.run("UPDATE reputation SET chain_score = ?, chain_epoch = ? WHERE agent_id = ?", row.score, epoch, Number(id));
      }
    }
  }

  history(agentId: bigint, limit = 50) {
    return this.db.all<{ epoch: number; score: number; previous: number; tx: string | null; at: number }>(
      "SELECT epoch, score, previous, tx, at FROM reputation_history WHERE agent_id = ? ORDER BY epoch DESC LIMIT ?",
      Number(agentId),
      limit,
    );
  }

  chainScore(agentId: bigint): { score: number | null; epoch: number | null } {
    const r = this.db.get<{ chain_score: number | null; chain_epoch: number | null }>(
      "SELECT chain_score, chain_epoch FROM reputation WHERE agent_id = ?",
      Number(agentId),
    );
    return { score: r?.chain_score ?? null, epoch: r?.chain_epoch ?? null };
  }
}

function jsonInputs(i: ReputationInputs): string {
  return JSON.stringify({ ...i, volume: i.volume.toString() });
}

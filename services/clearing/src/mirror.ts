import type { Db } from "./db.ts";
import { log } from "./bus.ts";

/**
 * Every table the Supabase mirror copies, with its primary key. Order matters for a restore:
 * jobs come before the IOUs and disputes that reference them.
 */
export const MIRRORED: Record<string, string[]> = {
  meta: ["key"],
  agents: ["agent_id"],
  reputation: ["agent_id"],
  reputation_history: ["agent_id", "epoch"],
  intents: ["id"],
  jobs: ["id"],
  ious: ["digest"],
  refusals: ["id"],
  disputes: ["id"],
  epochs: ["id"],
  epoch_txs: ["hash"],
  positions: ["epoch", "agent_id"],
  settlements: ["id"],
  payouts: ["epoch", "agent_id"],
  webhook_events: ["id"],
  hsp_gateway_flows: ["flow_id"],
};

/**
 * Queue every insert and update of a mirrored table in `sync_outbox`. The triggers run inside
 * the same transaction as the write itself, so a change can never be committed without being
 * queued, and nothing in the clearing pipeline has to know the mirror exists.
 */
export function installMirror(db: Db): void {
  db.raw.exec("CREATE TABLE IF NOT EXISTS sync_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, tbl TEXT NOT NULL, pk TEXT NOT NULL)");
  for (const [tbl, keys] of Object.entries(MIRRORED)) {
    const pk = `json_array(${keys.map((k) => `NEW.${k}`).join(", ")})`;
    for (const ev of ["INSERT", "UPDATE"]) {
      db.raw.exec(`CREATE TRIGGER IF NOT EXISTS mirror_${tbl}_${ev.toLowerCase()} AFTER ${ev} ON ${tbl} BEGIN INSERT INTO sync_outbox(tbl, pk) VALUES ('${tbl}', ${pk}); END`);
    }
  }
}

/** With the mirror off, drop the triggers and the queue so nothing piles up. */
export function removeMirror(db: Db): void {
  for (const tbl of Object.keys(MIRRORED)) {
    for (const ev of ["insert", "update"]) db.raw.exec(`DROP TRIGGER IF EXISTS mirror_${tbl}_${ev}`);
  }
  db.raw.exec("DROP TABLE IF EXISTS sync_outbox");
  db.run("DELETE FROM meta WHERE key = 'mirror_target'");
}

/** Queue every existing row, for the first sync to a new Supabase project. */
export function queueAll(db: Db): number {
  let n = 0;
  for (const [tbl, keys] of Object.entries(MIRRORED)) {
    n += Number(db.run(`INSERT INTO sync_outbox(tbl, pk) SELECT '${tbl}', json_array(${keys.join(", ")}) FROM ${tbl}`).changes);
  }
  return n;
}

/** Supabase accepts its new secret keys on `apikey` only; the legacy service_role JWT also goes on Authorization. */
export function supabaseHeaders(key: string, extra: Record<string, string> = {}): Record<string, string> {
  return { apikey: key, ...(key.startsWith("eyJ") ? { authorization: `Bearer ${key}` } : {}), ...extra };
}

export interface MirrorOptions {
  /** project URL, e.g. https://abcd.supabase.co */
  url: string;
  /** secret (service_role) key: server side only, it bypasses row level security */
  key: string;
  /** this deployment's ledger name; every row carries it, so deployments never mix */
  deployment: string;
  batch?: number;
  fetch?: typeof fetch;
}

export interface MirrorStatus {
  enabled: boolean;
  pending?: number;
  lastOkAt?: number | null;
  lastError?: string | null;
}

/**
 * One-way copy of the clearing database to Supabase (Postgres, through its REST API). SQLite
 * stays the engine; the mirror gives an off-server backup that `scripts/db-restore.mjs` can
 * rebuild a server from, and a dashboard of agents, operators, jobs and settlements.
 */
export class SupabaseMirror {
  lastOkAt: number | null = null;
  lastError: string | null = null;
  private busy = false;
  private failures = 0;
  private retryAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly db: Db;
  private readonly o: Required<MirrorOptions>;

  constructor(db: Db, o: MirrorOptions) {
    this.db = db;
    this.o = { batch: 500, fetch: globalThis.fetch, ...o, url: o.url.replace(/\/+$/, "") };
    installMirror(db);
    if (db.getMeta("mirror_target") !== this.o.url) {
      const n = queueAll(db);
      db.setMeta("mirror_target", this.o.url);
      log("info", "mirror", `queued ${n} existing rows for the first sync to ${this.o.url}`);
    }
  }

  start(intervalMs = 3_000): void {
    this.timer = setInterval(() => void this.flush(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  pending(): number {
    return this.db.get<{ n: number }>("SELECT count(*) AS n FROM sync_outbox")?.n ?? 0;
  }

  status(): MirrorStatus {
    return { enabled: true, pending: this.pending(), lastOkAt: this.lastOkAt, lastError: this.lastError };
  }

  /** Send queued changes. Rows leave the queue only once Supabase has accepted them. */
  async flush(): Promise<number> {
    if (this.busy || Date.now() < this.retryAt) return 0;
    this.busy = true;
    let sent = 0;
    try {
      for (;;) {
        const queued = this.db.all<{ id: number; tbl: string; pk: string }>("SELECT id, tbl, pk FROM sync_outbox ORDER BY id LIMIT ?", this.o.batch);
        if (!queued.length) break;
        const byTable = new Map<string, Set<string>>();
        for (const q of queued) {
          if (!byTable.has(q.tbl)) byTable.set(q.tbl, new Set());
          byTable.get(q.tbl)!.add(q.pk);
        }
        for (const [tbl, pks] of byTable) {
          const keys = MIRRORED[tbl];
          if (!keys) continue;
          const where = keys.map((k) => `${k} = ?`).join(" AND ");
          const rows = [...pks]
            .map((pk) => this.db.get(`SELECT * FROM ${tbl} WHERE ${where}`, ...(JSON.parse(pk) as (string | number)[])))
            .filter((r) => r !== undefined)
            .map((r) => ({ deployment: this.o.deployment, ...r }));
          if (rows.length) await this.upsert(tbl, keys, rows);
        }
        // anything queued after this batch was read has a higher id and goes out next time
        this.db.run("DELETE FROM sync_outbox WHERE id <= ?", queued.at(-1)!.id);
        sent += queued.length;
        if (queued.length < this.o.batch) break;
      }
      this.lastOkAt = Date.now();
      if (this.lastError) log("info", "mirror", "Supabase mirror caught up");
      this.lastError = null;
      this.failures = 0;
    } catch (err) {
      const msg = (err as Error).message;
      this.failures++;
      this.retryAt = Date.now() + Math.min(60_000, 1_000 * 2 ** this.failures);
      if (msg !== this.lastError) log("warn", "mirror", `Supabase mirror paused, will retry: ${msg}`);
      this.lastError = msg;
    } finally {
      this.busy = false;
    }
    return sent;
  }

  private async upsert(tbl: string, keys: string[], rows: Record<string, unknown>[]): Promise<void> {
    const res = await this.o.fetch(`${this.o.url}/rest/v1/${tbl}?on_conflict=${["deployment", ...keys].join(",")}`, {
      method: "POST",
      headers: supabaseHeaders(this.o.key, { "content-type": "application/json", prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify(rows),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`${tbl}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
}

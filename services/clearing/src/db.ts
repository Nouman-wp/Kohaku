import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Durable state of the clearing service. SQLite in WAL mode: every IOU, job, dispute,
 * settlement and epoch survives a restart, and each epoch's pipeline resumes from the
 * step it reached (each step also checks the chain, so resuming is idempotent).
 *
 * Amounts are stored as INTEGER token base units. They are bounded far below 2^53, so
 * reading them as JS numbers is exact; all arithmetic happens in bigint.
 */
const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  agent_id INTEGER PRIMARY KEY,
  slug TEXT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'agent',
  operator TEXT NOT NULL,
  signer TEXT NOT NULL,
  status TEXT NOT NULL,
  card_url TEXT NOT NULL DEFAULT '',
  endpoint TEXT NOT NULL DEFAULT '',
  services_json TEXT NOT NULL DEFAULT '[]',
  is_validator INTEGER NOT NULL DEFAULT 0,
  is_fleet INTEGER NOT NULL DEFAULT 0,
  registered_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS agents_signer ON agents(signer);

CREATE TABLE IF NOT EXISTS reputation (
  agent_id INTEGER PRIMARY KEY,
  live_score INTEGER NOT NULL,
  chain_score INTEGER,
  chain_epoch INTEGER,
  inputs_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reputation_history (
  agent_id INTEGER NOT NULL,
  epoch INTEGER NOT NULL,
  score INTEGER NOT NULL,
  previous INTEGER NOT NULL,
  inputs_json TEXT NOT NULL,
  tx TEXT,
  at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, epoch)
);

CREATE TABLE IF NOT EXISTS intents (
  id TEXT PRIMARY KEY,
  operator TEXT NOT NULL,
  buyer INTEGER NOT NULL,
  goal TEXT NOT NULL,
  budget INTEGER NOT NULL,
  per_job_cap INTEGER NOT NULL,
  min_rep INTEGER NOT NULL,
  allowed_services_json TEXT NOT NULL,
  allowed_sellers_json TEXT NOT NULL,
  not_before INTEGER NOT NULL,
  deadline INTEGER NOT NULL,
  nonce TEXT NOT NULL,
  signature TEXT NOT NULL,
  spent INTEGER NOT NULL DEFAULT 0,
  jobs INTEGER NOT NULL DEFAULT 0,
  refusals INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revocation_sig TEXT
);
CREATE INDEX IF NOT EXISTS intents_buyer ON intents(buyer, status);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  job_hash TEXT NOT NULL UNIQUE,
  buyer INTEGER NOT NULL,
  seller INTEGER NOT NULL,
  service TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  price INTEGER NOT NULL,
  epoch INTEGER NOT NULL,
  intent_id TEXT,
  quote_json TEXT NOT NULL,
  quote_sig TEXT NOT NULL,
  quote_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  challenge_ends_at INTEGER,
  result_hash TEXT,
  result_json TEXT,
  delivery_sig TEXT,
  delivery_json TEXT,
  parent_job TEXT
);
CREATE INDEX IF NOT EXISTS jobs_epoch ON jobs(epoch);
CREATE INDEX IF NOT EXISTS jobs_buyer ON jobs(buyer, created_at);
CREATE INDEX IF NOT EXISTS jobs_seller ON jobs(seller, created_at);

CREATE TABLE IF NOT EXISTS ious (
  digest TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  epoch INTEGER NOT NULL,
  buyer INTEGER NOT NULL,
  seller INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  token TEXT NOT NULL,
  job_hash TEXT NOT NULL,
  quote_hash TEXT NOT NULL,
  nonce TEXT NOT NULL,
  nonce_num INTEGER NOT NULL,
  signature TEXT NOT NULL,
  status TEXT NOT NULL,
  posted_epoch INTEGER,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ious_buyer_nonce ON ious(buyer, nonce_num);
CREATE INDEX IF NOT EXISTS ious_epoch ON ious(epoch, status);

CREATE TABLE IF NOT EXISTS refusals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  buyer INTEGER,
  seller INTEGER,
  service TEXT,
  amount INTEGER,
  reason TEXT NOT NULL,
  intent_id TEXT
);

CREATE TABLE IF NOT EXISTS disputes (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  iou_digest TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  buyer INTEGER NOT NULL,
  seller INTEGER NOT NULL,
  validator INTEGER,
  arbiter_job_id TEXT,
  reason TEXT NOT NULL,
  filed_at INTEGER NOT NULL,
  signature TEXT NOT NULL,
  dispute_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  reasoning TEXT,
  verdict_sig TEXT,
  decided_at INTEGER,
  request_tx TEXT,
  response_tx TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS disputes_job ON disputes(job_id);

CREATE TABLE IF NOT EXISTS epochs (
  id INTEGER PRIMARY KEY,
  phase TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  intake_ends_at INTEGER NOT NULL,
  challenge_ends_at INTEGER NOT NULL,
  settle_deadline INTEGER,
  iou_count INTEGER NOT NULL DEFAULT 0,
  gross INTEGER NOT NULL DEFAULT 0,
  net INTEGER NOT NULL DEFAULT 0,
  debtors INTEGER NOT NULL DEFAULT 0,
  creditors INTEGER NOT NULL DEFAULT 0,
  iou_set_hash TEXT,
  positions_hash TEXT,
  receipt_hash TEXT,
  finalize_tx TEXT,
  payout_tx TEXT,
  held_out INTEGER NOT NULL DEFAULT 0,
  carried INTEGER NOT NULL DEFAULT 0,
  disputes_upheld INTEGER NOT NULL DEFAULT 0,
  defaults INTEGER NOT NULL DEFAULT 0,
  onchain TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  sealed_at INTEGER
);

CREATE TABLE IF NOT EXISTS epoch_txs (
  hash TEXT PRIMARY KEY,
  epoch INTEGER NOT NULL,
  kind TEXT NOT NULL,
  gas_used INTEGER,
  at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS positions (
  epoch INTEGER NOT NULL,
  agent_id INTEGER NOT NULL,
  credit INTEGER NOT NULL,
  debit INTEGER NOT NULL,
  net INTEGER NOT NULL,
  state TEXT NOT NULL,
  PRIMARY KEY (epoch, agent_id)
);

CREATE TABLE IF NOT EXISTS settlements (
  id TEXT PRIMARY KEY,
  epoch INTEGER NOT NULL,
  agent_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL,
  hsp_mode TEXT NOT NULL,
  hsp_cart_id TEXT,
  hsp_flow_id TEXT,
  hsp_payment_url TEXT,
  hsp_order_json TEXT,
  hsp_attempt INTEGER NOT NULL DEFAULT 0,
  hsp_payment_id TEXT,
  hsp_status TEXT,
  hsp_outcome TEXT,
  mandate_json TEXT,
  receipt_json TEXT,
  settlement_tx TEXT,
  receipt_hash TEXT,
  record_tx TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  deadline INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS settlements_epoch_agent ON settlements(epoch, agent_id);
CREATE UNIQUE INDEX IF NOT EXISTS settlements_payment ON settlements(hsp_payment_id) WHERE hsp_payment_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS settlements_tx ON settlements(settlement_tx) WHERE settlement_tx IS NOT NULL;

CREATE TABLE IF NOT EXISTS payouts (
  epoch INTEGER NOT NULL,
  agent_id INTEGER NOT NULL,
  to_addr TEXT NOT NULL,
  amount INTEGER NOT NULL,
  tx TEXT,
  PRIMARY KEY (epoch, agent_id)
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL
);

-- the local HSP gateway's checkout flows (HSP_MODE=local only)
CREATE TABLE IF NOT EXISTS hsp_gateway_flows (
  flow_id TEXT PRIMARY KEY,
  cart_mandate_id TEXT NOT NULL UNIQUE,
  payment_request_id TEXT NOT NULL,
  cart_json TEXT NOT NULL,
  amount TEXT NOT NULL,
  status TEXT NOT NULL,
  status_reason TEXT,
  payer TEXT,
  payment_details_id TEXT,
  tx TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

export type Row = Record<string, SQLInputValue>;

export class Db {
  readonly raw: DatabaseSync;

  constructor(dataDir: string, file = "kohaku.sqlite") {
    mkdirSync(dataDir, { recursive: true });
    this.raw = new DatabaseSync(join(dataDir, file));
    this.raw.exec(SCHEMA);
    // additive migrations for databases created by earlier versions
    for (const sql of [
      "ALTER TABLE jobs ADD COLUMN delivery_json TEXT",
      "ALTER TABLE settlements ADD COLUMN hsp_cart_id TEXT",
      "ALTER TABLE settlements ADD COLUMN hsp_flow_id TEXT",
      "ALTER TABLE settlements ADD COLUMN hsp_payment_url TEXT",
      "ALTER TABLE settlements ADD COLUMN hsp_order_json TEXT",
      "ALTER TABLE settlements ADD COLUMN hsp_attempt INTEGER NOT NULL DEFAULT 0",
      "CREATE UNIQUE INDEX IF NOT EXISTS settlements_cart ON settlements(hsp_cart_id) WHERE hsp_cart_id IS NOT NULL",
      // earlier versions lost the payout hash when the seal ran on a later tick; the payouts table kept it
      "UPDATE epochs SET payout_tx = (SELECT tx FROM payouts WHERE payouts.epoch = epochs.id AND tx IS NOT NULL LIMIT 1) WHERE payout_tx IS NULL",
    ]) {
      try {
        this.raw.exec(sql);
      } catch {
        // column already exists
      }
    }
  }

  run(sql: string, ...params: SQLInputValue[]) {
    return this.raw.prepare(sql).run(...params);
  }

  get<T = Row>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  tx<T>(fn: () => T): T {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.raw.exec("COMMIT");
      return out;
    } catch (err) {
      this.raw.exec("ROLLBACK");
      throw err;
    }
  }

  getMeta(key: string): string | undefined {
    return this.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)?.value;
  }

  setMeta(key: string, value: string): void {
    this.run("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }
}

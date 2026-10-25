#!/usr/bin/env node
// Rebuild this deployment's clearing database from its Supabase mirror: for a new server, or
// after the old one's disk is gone. Reads SUPABASE_URL / SUPABASE_SECRET_KEY from the env file.
//
//   node scripts/db-restore.mjs testnet                  restore into DATA_DIR (default .data/)
//   node scripts/db-restore.mjs testnet --out <dir>      restore somewhere else (a dry run)
//
// It never overwrites a database that exists. Start the service afterwards as usual: each
// epoch's pipeline resumes from the step it reached and checks the chain before acting.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { useNetworkEnv } from "./lib.mjs";

const network = process.argv[2];
if (!["testnet", "mainnet"].includes(network)) throw new Error("usage: node scripts/db-restore.mjs testnet|mainnet [--out <dir>]");
useNetworkEnv(network);
const outIdx = process.argv.indexOf("--out");

const { ledgerName, loadConfig } = await import("../services/clearing/src/config.ts");
const { Db } = await import("../services/clearing/src/db.ts");
const { MIRRORED, supabaseHeaders } = await import("../services/clearing/src/mirror.ts");

const cfg = loadConfig();
if (!cfg.SUPABASE_URL || !cfg.SUPABASE_SECRET_KEY) throw new Error(`set SUPABASE_URL and SUPABASE_SECRET_KEY in .env.${network}`);
const url = cfg.SUPABASE_URL.replace(/\/+$/, "");
const deployment = ledgerName(cfg);
const dir = outIdx > 0 ? resolve(process.argv[outIdx + 1]) : cfg.DATA_DIR;
const file = `${deployment}.sqlite`;
if (existsSync(join(dir, file))) throw new Error(`${join(dir, file)} already exists; move it away first (this script never overwrites a ledger)`);

const PAGE = 1000;
async function rows(tbl, keys) {
  const all = [];
  for (let offset = 0; ; offset += PAGE) {
    const q = `deployment=eq.${encodeURIComponent(deployment)}&select=*&order=${keys.join(",")}&limit=${PAGE}&offset=${offset}`;
    const res = await fetch(`${url}/rest/v1/${tbl}?${q}`, { headers: supabaseHeaders(cfg.SUPABASE_SECRET_KEY), signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`${tbl}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const page = await res.json();
    all.push(...page);
    if (page.length < PAGE) return all;
  }
}

const db = new Db(dir, file);
const counts = {};
try {
  for (const [tbl, keys] of Object.entries(MIRRORED)) {
    const data = await rows(tbl, keys);
    const cols = db.all(`PRAGMA table_info(${tbl})`).map((c) => c.name);
    const insert = db.raw.prepare(`INSERT OR REPLACE INTO ${tbl} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`);
    db.tx(() => {
      for (const r of data) insert.run(...cols.map((c) => r[c] ?? null));
    });
    counts[tbl] = data.length;
  }
} finally {
  db.raw.close();
}
console.log(`restored ${deployment} from ${url} into ${join(dir, file)}`);
for (const [tbl, n] of Object.entries(counts)) console.log(`  ${tbl.padEnd(20)} ${n}`);

#!/usr/bin/env node
// End-to-end test against a running stack (`pnpm dev`): jobs -> IOUs -> epoch close ->
// on-chain netting -> HSP settlement by the debtors -> payout -> sealed receipt -> independent
// verification. Exits non-zero on any failure.
//
//   pnpm dev            (in one terminal)
//   pnpm e2e            (in another)
import { loadEnv } from "./lib.mjs";

const env = loadEnv();
const API = process.env.KOHAKU_API ?? `http://localhost:${env.PORT ?? 8787}`;
const FLEET = process.env.KOHAKU_FLEET ?? `http://localhost:${env.FLEET_PORT ?? 8788}`;
const TOKEN = process.env.ADMIN_TOKEN ?? env.ADMIN_TOKEN ?? "kohaku-admin";

const get = (p) => fetch(`${API}${p}`).then((r) => r.json());
const post = (url, body) => fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-admin-token": TOKEN }, body: JSON.stringify(body) }).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};

async function until(fn, label, timeoutMs) {
  const start = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out: ${label}`);
    await sleep(2000);
  }
}

console.log(`Kohaku e2e against ${API}`);
const stats0 = await get("/v1/stats");
check("clearing service is up", !!stats0.currentEpoch, `epoch ${stats0.currentEpoch}, HSP ${stats0.hsp.mode}`);
const fleet = await fetch(`${FLEET}/control/status`).then((r) => r.json());
check("fleet is up", fleet.reachable === true, `${fleet.agents.length} agents`);

// 1. make work happen and close the epoch early
const startEpoch = stats0.currentEpoch;
const r = await post(`${FLEET}/control/start`, { scenario: "research-brief" });
check("research-brief scenario starts", r.ok === true, r.message);
await until(async () => (await get(`/v1/epochs/${startEpoch}`)).epoch.iouCount > 0 || (await get("/v1/epochs/current")).ious.length >= 5, "IOUs to arrive", 90_000);
const cur = await get("/v1/epochs/current");
console.log(`  …  ${cur.ious.length} IOUs in epoch ${cur.epoch.id}; closing it`);
await post(`${API}/v1/admin/close-epoch`, { token: TOKEN });
const target = cur.epoch.id;

// 2. netting on chain
const netted = await until(async () => {
  const e = (await get(`/v1/epochs/${target}`)).epoch;
  return e.onchain === "finalized" || e.phase === "sealed" ? e : null;
}, "epoch to finalise on chain", 180_000);
check("epoch finalised on chain", true, `${netted.iouCount} IOUs -> ${netted.settlementTransfers} transfers`);
check("netting compressed the payments", netted.iouCount === 0 || netted.settlementTransfers <= netted.iouCount);

// 3. HSP settlement by the debtors, payout, seal
const sealed = await until(async () => {
  const d = await get(`/v1/epochs/${target}`);
  return d.epoch.phase === "sealed" ? d : null;
}, "every debtor to settle through HSP and the epoch to seal", 300_000);
const recorded = sealed.settlements.filter((s) => s.status === "recorded");
check("every debtor settled through HSP", recorded.length === sealed.settlements.length, `${recorded.length}/${sealed.settlements.length}`);
check("each settlement has an HSP payment id and transfer", recorded.every((s) => s.hspPaymentId && s.settlementTx && s.recordTx));
check("creditors were paid out", sealed.payouts.length === sealed.epoch.creditors, `${sealed.payouts.length} payouts`);
check("epoch receipt sealed", !!sealed.epoch.receiptHash);
const sum = sealed.positions.reduce((a, p) => a + BigInt(p.net), 0n);
check("net positions sum to zero", sum === 0n);

// 4. independent verification against the chain
const v = await get(`/v1/epochs/${target}/verify`);
for (const c of v.checks) check(`verify: ${c.name}`, c.ok, c.detail);

// 5. a job walks back to its HSP receipt
const job = sealed.ious.find((i) => i.status === "netted");
if (job) {
  const j = await get(`/v1/jobs/${job.jobId}`);
  check("job links to its quote, IOU, delivery and epoch", !!(j.quote && j.iou && j.delivery && j.epoch));
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);

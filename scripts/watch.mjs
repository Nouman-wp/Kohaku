#!/usr/bin/env node
// Kohaku in a terminal: follows the latest shopping request live. Shows every agent step,
// every signed IOU between agents, the HSP checkout, and how the request's epoch nets
// and settles. Read-only; no keys needed.
//
//   node scripts/watch.mjs                         follow kohaku-api.caspx.in
//   node scripts/watch.mjs --api http://localhost:8790
//   node scripts/watch.mjs --replay                print the latest session from the start
const args = process.argv.slice(2);
const opt = (name, d) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : d;
};
const API = (opt("api", process.env.KOHAKU_API ?? "https://kohaku-api.caspx.in") || "").replace(/\/+$/, "");
const REPLAY = args.includes("--replay");
const WEB = (opt("web", process.env.KOHAKU_WEB ?? "https://kohaku.caspx.in") || "").replace(/\/+$/, "");

// ── colours (caspx black + lemon green)
const tc = (r, g, b) => (s) => `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m`;
const lemon = tc(184, 243, 77);
const amber = tc(245, 181, 68);
const faint = tc(138, 138, 132);
const muted = tc(164, 164, 160);
const white = tc(236, 236, 234);
const bold = (s) => `\x1b[1m${s}\x1b[22m`;
const pad = (s, n) => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length));
const usd = (units, d = 4) => `$${(Number(units) / 1e6).toFixed(d)}`;
const time = (ms = Date.now()) => faint(new Date(ms).toLocaleTimeString("en-GB", { hour12: false }));
const out = (line) => process.stdout.write(`${line}\n`);

async function get(path) {
  const r = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(8_000) });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

let names = new Map();
async function loadAgents() {
  try {
    const list = await get("/v1/agents");
    names = new Map(list.map((a) => [a.agentId, a.name]));
  } catch {
    // keep the last list
  }
}
const nameOf = (id, s) => (s?.buyer && id === s.buyer.agentId ? "Your agent" : (names.get(id) ?? `#${id}`));

function banner() {
  out("");
  out(lemon(bold("  ◆ KOHAKU 琥珀")) + muted("  the clearing house for agent payments"));
  out(faint(`    live on HashKey Chain testnet · ${API} · ${WEB}/shop`));
  out(faint("  ─".padEnd(78, "─")));
}

// ── state
let current = null; // session id
const seen = { steps: 0, jobs: new Set(), history: 0 };
const epochs = new Map(); // id -> { phase, settled:Set, paid:Set }
let doneShown = false;

function startSession(s, replay) {
  current = s.id;
  seen.steps = replay ? 0 : s.steps.length;
  seen.jobs = new Set(replay ? [] : s.jobs.map((j) => j.jobId));
  seen.history = replay ? 0 : (s.checkout?.history.length ?? 0);
  doneShown = !replay && s.status !== "researching";
  if (!replay) return;
  out("");
  out(`${time(s.createdAt)}  ${lemon(bold("NEW REQUEST"))}  ${white(`“${s.need}”`)}${s.budgetUsd ? muted(`  budget $${s.budgetUsd}`) : ""}`);
  out(`${" ".repeat(12)}${muted(`from ${s.buyer?.name ?? "a buyer agent"} · session ${s.id}`)}`);
}

function render(s) {
  // gather everything new, then print in time order so steps, IOUs and HSP interleave
  const events = [];
  for (const st of s.steps.slice(seen.steps)) {
    if (st.agent.startsWith("HSP")) continue; // the checkout history below carries these
    const sim = /simulated/i.test(st.agent);
    const who = pad(st.agent, 16);
    events.push({ at: st.at, o: 0, line: `${time(st.at)}  ${sim ? amber(who) : lemon(who)}${sim ? amber(st.text) : white(st.text)}` });
  }
  seen.steps = s.steps.length;
  for (const j of s.jobs) {
    if (seen.jobs.has(j.jobId)) continue;
    seen.jobs.add(j.jobId);
    if (j.epoch > 0 && !epochs.has(j.epoch)) epochs.set(j.epoch, { phase: null, settled: new Set(), paid: new Set() });
    const pair = `${nameOf(j.buyer, s)} → ${nameOf(j.seller, s)}`;
    events.push({ at: j.at, o: 1, line: `${time(j.at)}  ${faint(pad("IOU", 8))}${white(pad(pair, 30))}${muted(pad(j.service, 14))}${lemon(pad(usd(j.price), 10))}${faint(j.epoch ? `epoch ${j.epoch} · signed` : "signed")}` });
  }
  const c = s.checkout;
  if (c) {
    for (const h of c.history.slice(seen.history)) {
      const sim = /simulated/i.test(h.note) || (c.simulated && h.status.startsWith("payment-"));
      const tag = sim ? amber(" [SIMULATED]") : "";
      const line = h.status === "quote-locked" ? `quote locked: ${h.note}` : h.status === "order-created" ? h.note : `${h.status}${h.note && !/^simulated/.test(h.note) ? `  ${h.note}` : ""}`;
      events.push({ at: h.at, o: 2, line: `${time(h.at)}  ${sim ? amber(pad("HSP", 8)) : lemon(bold(pad("HSP", 8)))}${sim ? amber(line) : white(line)}${tag}` });
    }
    seen.history = c.history.length;
  }
  events.sort((x, y) => x.at - y.at || x.o - y.o);
  for (const e of events) out(e.line);
  if (!doneShown && s.status !== "researching") {
    doneShown = true;
    const gross = s.jobs.reduce((a, j) => a + BigInt(j.price), 0n);
    const agents = new Set(s.jobs.flatMap((j) => [j.buyer, j.seller])).size;
    out(faint("  ─".padEnd(78, "─")));
    out(`${" ".repeat(12)}${lemon(bold(`${s.jobs.length} paid jobs`))}${muted(` between ${agents} agents · `)}${lemon(usd(gross))}${muted(" in signed IOUs · no money moved yet")}`);
    if (s.options?.[0]) {
      const o = s.options[0];
      out(`${" ".repeat(12)}${muted("top pick: ")}${white(o.name)}${muted(` $${o.best.final.toFixed(2)} at ${o.best.storeName}${o.best.coupon ? ` with ${o.best.coupon.code}` : ""}`)}`);
    }
    out(faint("  ─".padEnd(78, "─")));
  }
}

async function watchEpochs() {
  for (const [id, st] of epochs) {
    try {
      const d = await get(`/v1/epochs/${id}`);
      const e = d.epoch;
      if (e.phase !== st.phase) {
        st.phase = e.phase;
        if (e.phase === "intake") continue;
        const label = { challenge: "intake closed; dispute window open", closing: "netting", sealed: "sealed" }[e.phase] ?? e.phase;
        const count = Math.max(e.iouCount ?? 0, d.ious?.length ?? 0);
        out(`${time()}  ${lemon(bold(pad("EPOCH", 8)))}${white(`#${id} ${label}`)}${muted(`  · ${count} IOUs from every agent on Kohaku`)}`);
        if (e.settlementTransfers > 0 || e.phase === "sealed") {
          out(`${" ".repeat(12)}${lemon(bold(`${count} IOUs → ${e.settlementTransfers} net transfers`))}${muted(`  (${e.transfersAvoided} transfers avoided, ${Math.round((e.transferReduction ?? 0) * 100)}% fewer)`)}`);
        }
      }
      for (const x of d.settlements ?? []) {
        if (st.settled.has(x.id) || !["verified", "recorded"].includes(x.status)) continue;
        st.settled.add(x.id);
        const via = x.hspMode === "local" ? "Kohaku's HSP gateway (local mode)" : "HSP";
        out(`${time(x.updatedAt)}  ${lemon(pad("SETTLE", 8))}${white(pad(names.get(x.agentId) ?? `#${x.agentId}`, 18))}${muted("paid ")}${lemon(usd(x.amount))}${muted(` net through ${via}`)}${x.settlementTx ? faint(`  tx ${x.settlementTx.slice(0, 12)}…`) : ""}`);
      }
      for (const p of d.payouts ?? []) {
        const key = `${p.agentId}`;
        if (st.paid.has(key) || !p.tx) continue;
        st.paid.add(key);
        out(`${time()}  ${lemon(pad("PAYOUT", 8))}${white(pad(names.get(p.agentId) ?? `#${p.agentId}`, 18))}${muted("received ")}${lemon(usd(p.amount))}${faint(`  tx ${p.tx.slice(0, 12)}…`)}`);
      }
      if (e.phase === "sealed" && e.onchain === "settled") epochs.delete(id);
    } catch {
      // retry next tick
    }
  }
}

async function tick() {
  try {
    const s = await get("/shop/latest");
    if (s.id !== current) {
      const fresh = current !== null || REPLAY || Date.now() - s.createdAt < 60_000;
      startSession(s, fresh);
      if (!fresh) out(`${time()}  ${muted("waiting for a shopping request… (ask Claude to shop with Kohaku)")}`);
    }
    render(s);
  } catch (err) {
    if (!/404/.test(String(err))) out(`${time()}  ${amber(`backend unreachable: ${err.message}`)}`);
  }
}

banner();
await loadAgents();
setInterval(loadAgents, 20_000);
await tick();
setInterval(tick, 700);
setInterval(watchEpochs, 3_000);
process.on("SIGINT", () => {
  out(faint("\n  bye"));
  process.exit(0);
});

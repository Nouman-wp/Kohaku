import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Link } from "react-router";
import type { EpochPhase, EpochView, SettlementView } from "@kohaku/core";
import { AgentGem, Btn, HashLink, useNow } from "../components/ui.tsx";
import { IconArrow, IconChain, IconCheck, IconClock, IconHsp } from "../components/icons.tsx";
import { useApi, useLive, agentName, type EpochDetail, type LiveState } from "../lib/api.ts";
import { useConfig } from "../lib/wallet.ts";
import { clock, compact, pct, score, usd, explorerTx } from "../lib/format.ts";

/** Stagger index for an entrance; see `.js-reveal` in base.css. */
const at = (i: number) => ({ "--i": i }) as CSSProperties;

/** Mark `[data-reveal]` elements as they scroll into view, once. */
function useReveal() {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const els = [...(ref.current?.querySelectorAll<HTMLElement>("[data-reveal]") ?? [])];
    if (!("IntersectionObserver" in window)) {
      els.forEach((e) => e.classList.add("in"));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries)
          if (e.isIntersecting) {
            e.target.classList.add("in");
            io.unobserve(e.target);
          }
      },
      { rootMargin: "0px 0px -6% 0px", threshold: 0.08 },
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, []);
  return ref;
}

/** The latest sealed epoch that cleared anything, with its full detail. */
function useLastSealed(live: LiveState) {
  const last = useMemo(
    () =>
      [...live.epochs.values()]
        .filter((e) => e.phase === "sealed" && e.iouCount > 0)
        .sort((a, b) => b.id - a.id)[0] ?? null,
    [live.epochs],
  );
  const { data } = useApi<EpochDetail>(last ? `/v1/epochs/${last.id}` : null);
  return { last, data };
}

export default function Landing() {
  const live = useLive();
  const ref = useReveal();
  const sealed = useLastSealed(live);
  return (
    <main className="landing" ref={ref}>
      <Hero live={live} sealed={sealed} />
      <Netting live={live} sealed={sealed} />
      <Fleet live={live} />
      <Lifecycle live={live} />
      <Settlement live={live} />
      <Trust />
      <Builders />
      <Pricing />
      <Cta live={live} />
    </main>
  );
}

type Sealed = ReturnType<typeof useLastSealed>;

// ─────────────────────────────────────────────── hero

function Hero({ live, sealed }: { live: LiveState; sealed: Sealed }) {
  const now = useNow(500);
  const s = live.stats;
  const cur = s ? live.epochs.get(s.currentEpoch) : undefined;
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="wrap hero-grid">
        <div className="hero-copy">
          <h1 id="hero-title" className="hero-title" data-reveal>
            Clearing for the agent economy
          </h1>
          <p className="hero-serif serif" data-reveal style={at(1)}>
            Many payments in. <span className="lime">A handful out.</span>
          </p>
          <p className="hero-sub" data-reveal style={at(2)}>
            AI agents sign an IOU for every job they buy. Kohaku nets them every epoch on HashKey Chain and settles only the difference through HSP, with a receipt for every cent.
          </p>
          <div className="hero-actions" data-reveal style={at(3)}>
            <Btn to="/floor" variant="accent" size="lg">
              Watch the live floor <IconArrow aria-hidden />
            </Btn>
            <Btn to="/intents/new" variant="secondary" size="lg">
              Sign an intent
            </Btn>
          </div>
          <ul className="hero-chips" data-reveal style={at(4)} aria-label="This deployment">
            <li className="chip">
              <IconChain aria-hidden /> {s?.chain.name ?? "HashKey Chain"}
            </li>
            <li className="chip">
              <IconClock aria-hidden /> Epoch <b>{s?.currentEpoch ?? "—"}</b>
              {cur?.phase === "intake" ? (
                <>
                  closes in <b className="mono">{clock(cur.intakeEndsAt - now)}</b>
                </>
              ) : (
                <b>{cur?.phase ?? "connecting…"}</b>
              )}
            </li>
            <li className="chip">
              <IconHsp size={16} aria-hidden /> {s ? (s.hsp.mode === "merchant" ? "Settled through HashKey Merchant" : "HSP local gateway") : "Settled through HSP"}
            </li>
          </ul>
        </div>
        <Ledger live={live} sealed={sealed} now={now} />
      </div>
      <div className="wrap">
        <dl className="hero-stats" data-reveal style={at(2)}>
          <div>
            <dt>Jobs cleared</dt>
            <dd>{s ? compact(s.jobsCleared) : "—"}</dd>
          </div>
          <div>
            <dt>Transfers avoided</dt>
            <dd>
              {s ? compact(s.transfersAvoided) : "—"}
              {s && <small>{pct(s.transferReduction)} fewer</small>}
            </dd>
          </div>
          <div>
            <dt>Settled through HSP</dt>
            <dd>
              {s ? usd(s.valueSettledViaHsp) : "—"}
              {s && <small>{s.hspPayments} payments</small>}
            </dd>
          </div>
          <div>
            <dt>Agents trading</dt>
            <dd>{s?.agents ?? "—"}</dd>
          </div>
          <div>
            <dt>Epochs sealed</dt>
            <dd>{s?.epochsSealed ?? "—"}</dd>
          </div>
        </dl>
      </div>
    </section>
  );
}

/** The hero picture is the product itself: the ledger, filling up in real time. */
function Ledger({ live, sealed, now }: { live: LiveState; sealed: Sealed; now: number }) {
  const s = live.stats;
  const cur = s ? live.epochs.get(s.currentEpoch) : undefined;
  const fromLive = live.ious.length > 0;
  const rows = fromLive
    ? live.ious.slice(0, 7).map((r) => ({ key: r.iou.digest, buyer: r.iou.buyer, seller: r.iou.seller, amount: r.iou.amount, service: r.job.service as string | null, jobId: r.job.id }))
    : (sealed.data?.ious ?? []).slice(0, 7).map((i) => ({ key: i.digest, buyer: i.buyer, seller: i.seller, amount: i.amount, service: null as string | null, jobId: i.jobId }));
  const last = sealed.last;
  return (
    <aside className="ledger" data-ui data-reveal style={at(2)} aria-label="Live ledger">
      <header className="ledger-head">
        <div>
          <div className="ledger-kicker">
            <span className={`live-dot ${live.connected ? "" : "off"}`} aria-hidden /> {live.connected ? "Live ledger" : "Connecting…"}
          </div>
          <div className="ledger-epoch">
            Epoch <span className="num">{s?.currentEpoch ?? "—"}</span>
            <span className="ledger-phase">{cur?.phase ?? "intake"}</span>
          </div>
        </div>
        <div className="ledger-clock">
          <span>{cur?.phase === "intake" ? "closes in" : "phase ends"}</span>
          <b className="mono">{cur ? clock(cur.intakeEndsAt - now) : "--:--"}</b>
        </div>
      </header>
      <div className="ledger-label">{fromLive ? "Signed IOUs, as they arrive" : last ? `Signed IOUs from sealed epoch ${last.id}` : "Signed IOUs"}</div>
      {rows.length ? (
        <ol className="ledger-rows">
          {rows.map((r) => (
            <li key={r.key}>
              <Link to={`/jobs/${r.jobId}`}>
                <AgentGem id={r.buyer} size={24} />
                <span className="ledger-who">
                  <b>{agentName(live.agents, r.buyer)}</b> <span aria-label="paid">→</span> <b>{agentName(live.agents, r.seller)}</b>
                  {r.service && <span className="ledger-svc">{r.service}</span>}
                </span>
                <span className="mono ledger-amt">{usd(r.amount, 4)}</span>
              </Link>
            </li>
          ))}
        </ol>
      ) : (
        <p className="ledger-empty">{live.connected ? "Waiting for the first IOU of this epoch. The fleet trades every few seconds." : "Connecting to the clearing service…"}</p>
      )}
      {last && (
        <footer className="ledger-foot">
          <span>
            Epoch {last.id} netted <b>{last.iouCount}</b> IOUs into <b className="lime">{last.settlementTransfers}</b> transfers
          </span>
          <Link to={`/epochs/${last.id}`} className="text-link">
            Receipt
          </Link>
        </footer>
      )}
    </aside>
  );
}

// ─────────────────────────────────────────────── netting: the one live thing

function Netting({ live, sealed }: { live: LiveState; sealed: Sealed }) {
  const [netted, setNetted] = useState(false);
  const { data, last } = sealed;
  const ious = useMemo(() => (data?.ious ?? []).filter((x) => x.status === "netted"), [data]);
  const nets = useMemo(() => (data?.positions ?? []).filter((p) => BigInt(p.net) !== 0n).sort((a, b) => Number(BigInt(a.net) - BigInt(b.net))), [data]);
  // identical IOUs (same buyer, seller and price) share a chip with a count
  const groups = useMemo(() => {
    const m = new Map<string, { buyer: string; seller: string; amount: string; n: number }>();
    for (const x of ious) {
      const k = `${x.buyer}-${x.seller}-${x.amount}`;
      const g = m.get(k);
      if (g) g.n++;
      else m.set(k, { buyer: x.buyer, seller: x.seller, amount: x.amount, n: 1 });
    }
    return [...m.values()];
  }, [ious]);
  const shown = groups.slice(0, 14);
  const more = groups.slice(14).reduce((sum, g) => sum + g.n, 0);
  const name = (id: string) => agentName(live.agents, id);
  const e = data?.epoch;
  return (
    <section className="section" id="netting" aria-labelledby="netting-title">
      <div className="wrap">
        <div className="section-head" data-reveal>
          <h2 id="netting-title">{e ? `${e.iouCount} IOUs in. ${e.settlementTransfers} transfers out.` : "Many payments in. A handful out."}</h2>
          <p>
            An agent can make dozens of sub-cent calls a minute, and paying each one on chain costs more than the work. Kohaku records them as IOUs and, when the epoch closes, moves only the
            differences. This is the last sealed epoch, as it was cleared on chain.
          </p>
        </div>
        <div className="net-board" data-ui data-reveal style={at(1)}>
          <div className="net-board-head">
            <div className="net-board-title">
              {e ? (
                <>
                  Epoch <span className="num">{e.id}</span> <span className="pill pill-good">sealed</span>
                </>
              ) : live.connected ? (
                "No sealed epoch yet"
              ) : (
                "Connecting to the clearing service…"
              )}
            </div>
            <button type="button" className="button button-accent" disabled={!data} aria-pressed={netted} onClick={() => setNetted((n) => !n)}>
              {netted ? "Show the IOUs again" : "Net this epoch"}
            </button>
          </div>
          <div className="net-figures" aria-hidden={!e}>
            <div className={netted ? "" : "on"}>
              <b className="num">{e?.iouCount ?? "—"}</b>
              <span>signed IOUs · {e ? usd(e.grossVolume, 4) : "—"} gross</span>
            </div>
            <IconArrow size={28} className="net-arrow" aria-hidden />
            <div className={netted ? "on" : ""}>
              <b className="num">{e?.settlementTransfers ?? "—"}</b>
              <span>transfers · {e ? usd(e.netVolume, 4) : "—"} net</span>
            </div>
          </div>
          <div className="net-flow" aria-live="polite">
            {shown.map((g, i) => (
              <span key={`${g.buyer}-${g.seller}-${g.amount}`} className={`net-chip ${netted ? "gone" : ""}`} style={{ transitionDelay: `${i * 25}ms` }}>
                {name(g.buyer)} → {name(g.seller)} <span className="mono">{usd(g.amount, 4)}</span>
                {g.n > 1 ? <em>×{g.n}</em> : null}
              </span>
            ))}
            {!netted && more > 0 && <span className="net-chip">+{more} more</span>}
            {netted &&
              nets.map((p, i) => (
                <span key={p.agentId} className={`net-chip net ${BigInt(p.net) > 0n ? "in" : "out"}`} style={{ animationDelay: `${200 + i * 60}ms` }}>
                  {name(p.agentId)} {BigInt(p.net) > 0n ? "receives" : "pays"} <span className="mono">{usd(BigInt(p.net) > 0n ? p.net : -BigInt(p.net), 4)}</span>
                </span>
              ))}
          </div>
          {last && (
            <p className="net-summary">
              {pct(last.transferReduction)} fewer payments than settling every job, and {pct(last.volumeReduction)} of the value never had to move.{" "}
              <Link to={`/epochs/${last.id}`} className="text-link">
                Open epoch {last.id}’s receipt
              </Link>
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────── the fleet's rate card

function Fleet({ live }: { live: LiveState }) {
  const agents = useMemo(() => [...live.agents].sort((a, b) => Number(a.agentId) - Number(b.agentId)), [live.agents]);
  const search = live.agents.flatMap((a) => a.services).find((sv) => sv.id === "search");
  return (
    <section className="section" aria-labelledby="fleet-title">
      <div className="wrap split">
        <div className="split-copy" data-reveal>
          <h2 id="fleet-title">Agents that hire other agents</h2>
          <p>
            An orchestrator buys search, fact checks, summaries and translations. Its suppliers buy from each other too, so debts run in loops, which is exactly what netting cancels out.
          </p>
          <p>
            {search ? `A search costs ${usd(search.price, 4)}. ` : ""}Every agent here is an ERC‑8004 identity with an A2A card, a price list, posted collateral and a reputation it earned on chain.
          </p>
          <Link to="/agents" className="text-link">
            Browse the registry <IconArrow aria-hidden />
          </Link>
        </div>
        <div className="rate-card" data-ui data-reveal style={at(1)}>
          <div className="rate-card-head">
            <span>Rate card</span>
            <span>{agents.length ? `${agents.length} agents registered` : "Loading the registry…"}</span>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Agent</th>
                  <th scope="col">Sells</th>
                  <th scope="col" className="num">
                    Price
                  </th>
                  <th scope="col" className="num">
                    Reputation
                  </th>
                </tr>
              </thead>
              <tbody>
                {agents.map((a) => {
                  const sv = a.services[0];
                  const low = a.reputation < 700;
                  return (
                    <tr key={a.agentId}>
                      <td>
                        <Link to={`/agents/${a.agentId}`} className="agent-cell">
                          <AgentGem id={a.agentId} size={26} />
                          <span className="rate-name">
                            <b>{a.name}</b>
                            <small>{a.role}</small>
                          </span>
                        </Link>
                      </td>
                      <td className="dim">{sv ? sv.name : <span className="muted">Buyer only</span>}</td>
                      <td className="num">
                        {sv ? (
                          <>
                            <span className="mono">{usd(sv.price, 4)}</span>
                            <small className="muted"> / {sv.unit}</small>
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td className="num">
                        <span className="rep">
                          <span className={`rep-bar ${low ? "low" : ""}`} aria-hidden>
                            <i style={{ width: `${Math.max(4, a.reputation / 10)}%` }} />
                          </span>
                          <span className={low ? "warn-text" : ""}>{score(a.reputation)}</span>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────── one epoch, live

const PHASES: { key: EpochPhase[]; name: string; title: string; desc: string }[] = [
  { key: ["intake"], name: "Intake", title: "Agents trade", desc: "Buyers sign an EIP‑712 IOU for every job, bound to the seller’s signed quote and to a human’s intent. Nothing touches the chain." },
  { key: ["challenge"], name: "Challenge", title: "Bad work is disputed", desc: "No new IOUs. A buyer can still dispute a delivery; a staked validator re-checks it, and an upheld dispute voids the IOU." },
  { key: ["closing"], name: "Netting", title: "The contract does the maths", desc: "Every surviving IOU is posted. The clearing house recomputes each net position, checks they sum to zero and locks each debt in collateral." },
  { key: ["settling"], name: "Settlement", title: "Debtors pay through HSP", desc: "Each net debtor pays its exact debt as an HSP order signed by its own wallet. No human, and no gas on the agent’s side." },
  { key: ["paying", "sealed"], name: "Seal", title: "The receipt is sealed", desc: "Creditors are paid from the pool, reputation is written to ERC‑8004, and the epoch is sealed with a receipt hash." },
];

function Lifecycle({ live }: { live: LiveState }) {
  const cfg = useConfig();
  const cur = live.stats ? live.epochs.get(live.stats.currentEpoch) : undefined;
  // the newest epoch that is past intake shows where the previous cycle is
  const closing = useMemo(
    () =>
      [...live.epochs.values()]
        .filter((e) => e.phase !== "intake" && e.phase !== "sealed" && e.phase !== "failed")
        .sort((a, b) => b.id - a.id)[0],
    [live.epochs],
  );
  const meta = (i: number) =>
    !cfg ? null : i === 0 ? `${cfg.epochs.intakeSeconds}s` : i === 1 ? `${cfg.epochs.challengeSeconds}s` : i === 3 ? `${cfg.epochs.settlementWindowSeconds}s window` : null;
  return (
    <section className="section" aria-labelledby="cycle-title">
      <div className="wrap">
        <div className="section-head" data-reveal>
          <h2 id="cycle-title">One epoch, from first IOU to sealed receipt</h2>
          <p>Epochs run back to back, so while one is taking IOUs the previous one is netting and settling. The markers below follow the real epochs on this deployment.</p>
        </div>
        <ol className="phases" data-reveal style={at(1)}>
          {PHASES.map((p, i) => {
            const here = [cur, closing].filter((e, k, all): e is EpochView => !!e && p.key.includes(e.phase) && all.findIndex((x) => x?.id === e.id) === k);
            return (
              <li key={p.name} className={here.length ? "on" : ""}>
                <div className="phase-top">
                  <span className="phase-name">{p.name}</span>
                  {meta(i) && <span className="phase-meta mono">{meta(i)}</span>}
                </div>
                <h3>{p.title}</h3>
                <p>{p.desc}</p>
                {here.map((e) => (
                  <Link key={e.id} to={`/epochs/${e.id}`} className="phase-here">
                    <span className="live-dot" aria-hidden /> Epoch {e.id} is here
                  </Link>
                ))}
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────── HSP, shown as a real receipt

function Settlement({ live }: { live: LiveState }) {
  const { data } = useApi<SettlementView[]>("/v1/settlements?status=recorded&limit=1", 30_000);
  const s = data?.[0] ?? [...live.settlements.values()].filter((x) => x.status === "recorded").sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const explorer = live.stats?.chain.explorer;
  const mode = live.stats?.hsp.mode;
  return (
    <section className="section" aria-labelledby="hsp-title">
      <div className="wrap split split-rev">
        <div className="split-copy" data-reveal>
          <h2 id="hsp-title">Every net debt is an HSP order</h2>
          <p>Kohaku is the merchant. When an epoch closes it opens one order per net debtor, and the agent pays it from its own wallet. The epoch only counts as settled once three things hold.</p>
          <ol className="hsp-steps">
            <li>
              <b>Cart mandate.</b> Kohaku states the exact net debt, payee and token.
            </li>
            <li>
              <b>Payment mandate.</b> The agent checks the cart against its debt and signs an EIP‑3009 authorization.
            </li>
            <li>
              <b>Verified transfer.</b> HSP reports it safe, and Kohaku sees the exact wallet‑to‑pool transfer on chain.
            </li>
            <li>
              <b>Recorded.</b> The clearing house checks the pool balance and records the settlement.
            </li>
          </ol>
          {mode && (
            <p className="fine">
              {mode === "merchant"
                ? "This deployment settles through HashKey Merchant."
                : "This deployment runs the HSP local gateway, which serves HashKey Merchant’s API. Transfers are real on-chain payments; switching to HashKey is a configuration change."}
            </p>
          )}
          <Link to="/developers#hsp" className="text-link">
            How settlement works <IconArrow aria-hidden />
          </Link>
        </div>
        <figure className="receipt" data-ui data-reveal style={at(1)}>
          <div className="receipt-top">
            <img src="/logo.svg" alt="" width={28} height={28} />
            <div>
              <b>Kohaku clearing house</b>
              <span>HSP settlement receipt</span>
            </div>
          </div>
          {s ? (
            <>
              <div className="receipt-amount">
                <span>{agentName(live.agents, s.agentId)} paid its net debt</span>
                <b className="mono">{usd(s.amount, 4)}</b>
              </div>
              <dl className="receipt-lines">
                <div>
                  <dt>Epoch</dt>
                  <dd>
                    <Link to={`/epochs/${s.epoch}`}>{s.epoch}</Link>
                  </dd>
                </div>
                <div>
                  <dt>HSP order</dt>
                  <dd>
                    <HashLink hash={s.hspCartMandateId} href={s.hspPaymentUrl} n={6} />
                  </dd>
                </div>
                <div>
                  <dt>Outcome</dt>
                  <dd>{s.hspStatus ? `${s.hspStatus} / ${s.hspOutcome ?? "—"}` : s.status}</dd>
                </div>
                <div>
                  <dt>Wallet → pool</dt>
                  <dd>
                    <HashLink hash={s.settlementTx} href={explorerTx(explorer, s.settlementTx)} n={5} />
                  </dd>
                </div>
                <div>
                  <dt>Recorded on chain</dt>
                  <dd>
                    <HashLink hash={s.recordTx} href={explorerTx(explorer, s.recordTx)} n={5} />
                  </dd>
                </div>
                <div>
                  <dt>Gateway</dt>
                  <dd>{s.hspMode === "local" ? "HSP local gateway" : "HashKey Merchant"}</dd>
                </div>
              </dl>
              <figcaption className="receipt-foot">
                <IconCheck size={14} aria-hidden /> Paid via HSP, verified on chain
              </figcaption>
            </>
          ) : (
            <p className="receipt-empty">The latest HSP settlement appears here once an epoch has closed.</p>
          )}
        </figure>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────── guarantees

const GUARANTEES = [
  { t: "Net positions sum to zero", d: "The clearing house computes every position itself and refuses a result that does not balance." },
  { t: "No IOU is counted twice", d: "A strict (buyer, nonce) order and the epoch inside the signature rule out replays." },
  { t: "No IOU without a signature", d: "Each one is recovered on chain against the buyer’s key in the identity registry." },
  { t: "Debts never exceed collateral", d: "Checked when an IOU arrives and locked when the epoch finalises." },
  { t: "Settled only when paid", d: "HSP’s status, the exact transfer and the pool balance are all checked on chain." },
  { t: "Bad work is refunded", d: "An upheld dispute voids the IOU before netting and cuts the seller’s ERC‑8004 reputation." },
];

function Trust() {
  return (
    <section className="section" aria-labelledby="trust-title">
      <div className="wrap trust">
        <div className="trust-head" data-reveal>
          <h2 id="trust-title">Don’t trust us. Re‑check the chain.</h2>
          <p>Every settlement traces back to a single sub-cent job, and the Verify page redoes an epoch’s netting in your browser, against what the contract stored.</p>
          <div className="control-bar">
            <Btn to="/verify" variant="primary">
              Verify an epoch
            </Btn>
            <Btn to="/disputes" variant="secondary">
              See the disputes
            </Btn>
          </div>
        </div>
        <ul className="guarantees" data-reveal style={at(1)}>
          {GUARANTEES.map((g) => (
            <li key={g.t}>
              <IconCheck size={18} aria-hidden />
              <div>
                <h3>{g.t}</h3>
                <p>{g.d}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────── developers

function Builders() {
  return (
    <section className="section" aria-labelledby="build-title">
      <div className="wrap split">
        <div className="split-copy" data-reveal>
          <h2 id="build-title">Bring your own agent</h2>
          <p>Turn any API into a Kohaku seller in a few lines. The SDK signs quotes, IOUs and deliveries, serves an A2A agent card, and settles your agent’s debts through HSP on its own.</p>
          <p>Or let an MCP client like Claude hire the fleet directly. It joins as a guest buyer with its own key, collateral and a capped intent.</p>
          <ul className="tool-list" aria-label="MCP tools">
            {["find_agent", "get_quote", "hire_agent", "check_balance", "get_job"].map((t) => (
              <li key={t}>
                <code>{t}</code>
              </li>
            ))}
          </ul>
          <div className="control-bar">
            <Btn to="/developers" variant="primary">
              Read the quickstart
            </Btn>
            <Btn to="/developers#mcp" variant="secondary">
              MCP server
            </Btn>
          </div>
        </div>
        <pre className="code code-hero" data-reveal style={at(1)} aria-label="Selling a service with the Kohaku SDK">
          <span className="k">import</span> {"{ KohakuAgent, serveAgents }"} <span className="k">from</span> <span className="s">"@kohaku/sdk"</span>;{"\n\n"}
          <span className="k">const</span> agent = <span className="k">await</span> KohakuAgent.<span className="f">connect</span>({"{"} privateKey, clearingUrl {"}"});{"\n\n"}
          agent.<span className="f">sell</span>({"{"}
          {"\n"}  id: <span className="s">"uppercase"</span>,{"\n"}  price: <span className="s">"0.0005"</span>, <span className="c">// USDC per call</span>
          {"\n"}  handler: <span className="k">async</span> (text) =&gt; text.<span className="f">toUpperCase</span>(),{"\n"}
          {"}"});{"\n\n"}
          <span className="c">// quotes, IOUs, deliveries and HSP settlement are handled for you</span>
          {"\n"}
          <span className="k">await</span> <span className="f">serveAgents</span>([agent], {"{"} port: <span className="s">9000</span> {"}"});
        </pre>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────── pricing

function Pricing() {
  return (
    <section className="section" aria-labelledby="price-title">
      <div className="wrap pricing">
        <h2 id="price-title" data-reveal>
          Pay on net, not on gross
        </h2>
        <div className="price" data-reveal style={at(1)}>
          <b>Free</b>
          <p>to register and list an agent. Keep every cent you sell.</p>
          <Link to="/console" className="text-link">
            Register an agent
          </Link>
        </div>
        <div className="price" data-reveal style={at(2)}>
          <b>0%</b>
          <p>clearing fee during the hackathon. Later, a small fee on net settled volume, never on gross.</p>
          <Link to="/developers" className="text-link">
            Read the model
          </Link>
        </div>
        <p className="fine pricing-note">Gas and HSP network costs are paid by whoever sends the transaction. Collateral stays yours.</p>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────── CTA

function Cta({ live }: { live: LiveState }) {
  const now = useNow(1000);
  const s = live.stats;
  const cur = s ? live.epochs.get(s.currentEpoch) : undefined;
  return (
    <section className="cta-band" aria-labelledby="cta-title">
      <div className="wrap cta-inner">
        <div>
          <h2 id="cta-title">Watch an epoch close</h2>
          <p>
            {cur?.phase === "intake" ? (
              <>
                Epoch {cur.id} closes in <b className="mono">{clock(cur.intakeEndsAt - now)}</b>.{" "}
              </>
            ) : null}
            The floor shows every IOU as it is signed and the moment they collapse into a handful of transfers.
          </p>
        </div>
        <Link to="/floor" className="button button-dark button-lg">
          Open the live floor <IconArrow aria-hidden />
        </Link>
      </div>
    </section>
  );
}

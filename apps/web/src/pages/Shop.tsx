import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import type { AgentSummary, EpochView } from "@kohaku/core";
import { api, fleet, useApi, useLive } from "../lib/api.ts";
import { ago, clock, short, usd } from "../lib/format.ts";
import { AgentGem, Panel, Pill, useNow } from "../components/ui.tsx";

// ─────────────────────────────────────────────── shapes served by the fleet's /shop API

interface ShopJob {
  jobId: string;
  at: number;
  buyer: string;
  seller: string;
  service: string;
  price: string;
  epoch: number;
}
interface Offer {
  store: string;
  storeName: string;
  price: number;
  stock: number;
  deliveryDays: number;
  coupon: { code: string; discount: number; description: string } | null;
  final: number;
}
interface Specs {
  title: string;
  url: string;
  intro: string;
  released: string | null;
  chip: string | null;
  display: string | null;
  rearCamera: string | null;
  battery: string | null;
  charging: string | null;
  water: string | null;
}
interface Option {
  rank: number;
  modelId: string;
  name: string;
  brand: string;
  specs: Specs | null;
  best: Offer;
  offers: Offer[];
  withinBudget: boolean;
}
interface Cart {
  store: string;
  storeName: string;
  storeAgentId: string;
  payTo: string;
  lines: { modelId: string; name: string; price: number; coupon: string | null; discount: number; total: number }[];
  subtotal: number;
  discount: number;
  total: number;
  depositUsd: string;
  addedAt: number;
}
interface Checkout {
  status: string;
  merchantName: string;
  payTo: string;
  payer: string;
  amountUsd: string;
  token: { address: string; symbol: string; decimals: number };
  network: { chainId: number; name: string; displayName: string };
  flowId: string;
  paymentRequestId: string;
  tokenTotalRaw: string | null;
  quoteExpiresAt: string | null;
  txHash: string | null;
  attributionVerified: boolean | null;
  statusReason: string | null;
  history: { at: number; status: string; note: string }[];
}
interface Session {
  id: string;
  createdAt: number;
  updatedAt: number;
  need: string;
  budgetUsd: number | null;
  buyer: { agentId: string; name: string } | null;
  status: "researching" | "ready" | "failed";
  error: string | null;
  steps: { at: number; agent: string; text: string }[];
  jobs: ShopJob[];
  options: Option[];
  summary: string | null;
  cart: Cart | null;
  checkout: Checkout | null;
}

const TIERS: { slug: string; label?: string }[][] = [
  [{ slug: "you" }],
  [{ slug: "concierge" }],
  [{ slug: "pricewise" }, { slug: "scout" }, { slug: "clipper" }, { slug: "scribe" }],
  [{ slug: "amber-mart" }, { slug: "lantern-tech" }, { slug: "harbor-mobile" }],
];

export default function Shop() {
  const { id } = useParams();
  const live = useLive();
  const now = useNow(500);
  const [s, setS] = useState<Session | null>(null);
  const [missing, setMissing] = useState(false);
  const [explorer, setExplorer] = useState<string | null>(null);

  useEffect(() => {
    api<{ chain: { explorer: string | null } }>("/v1/config")
      .then((c) => setExplorer(c.chain.explorer))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fleet<Session>(id ? `/control/shop/sessions/${id}` : "/control/shop/latest")
        .then((d) => {
          if (!alive) return;
          setS(d);
          setMissing(false);
        })
        .catch(() => alive && setMissing(true));
    void load();
    const t = setInterval(load, 1_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id]);

  if (!s) {
    return (
      <main className="page page-wide shop">
        <div className="page-inner">
          <Waiting missing={missing} following={!id} />
        </div>
      </main>
    );
  }

  const gross = s.jobs.reduce((a, j) => a + BigInt(j.price), 0n);
  const cur = live.stats?.currentEpoch ?? null;
  const epochs = [...new Set(s.jobs.map((j) => j.epoch).filter((e) => e > 0))].sort((a, b) => a - b);
  const epoch = epochs.length ? live.epochs.get(epochs[epochs.length - 1]!) : undefined;
  const agentsInvolved = new Set(s.jobs.flatMap((j) => [j.buyer, j.seller])).size;
  const fresh = now - s.updatedAt < 4_000 && s.status === "researching";

  return (
    <main className="page page-wide shop">
      <div className="page-inner">
        <header className="shop-head">
          <div className="shop-status" aria-live="polite">
            <span className={`live-dot ${fresh || s.status === "researching" ? "" : "idle"}`} aria-hidden />
            {s.status === "researching" ? "Agents are working" : s.status === "ready" ? "Research done" : "Research failed"}
            <span className="muted"> · {id ? "session" : "following the latest session"} {s.id.slice(5)}</span>
          </div>
          <h1 className="shop-need">
            <span className="shop-quote">“</span>
            {s.need}
            <span className="shop-quote">”</span>
          </h1>
          <div className="shop-meta">
            <span>
              asked by <b>{s.buyer?.name ?? "a buyer agent"}</b> (the user's agent)
            </span>
            {s.budgetUsd ? <span>budget ${s.budgetUsd}</span> : null}
            <span>{ago(s.createdAt)}</span>
          </div>
        </header>

        <div className="shop-counters">
          <Counter value={String(s.jobs.length)} label="paid jobs between agents" />
          <Counter value={String(agentsInvolved)} label="agents involved" />
          <Counter value={usd(gross, 4)} label="signed IOUs, gross" />
          <Counter
            value={epoch ? (epoch.phase === "intake" ? clock(Math.max(0, epoch.intakeEndsAt - now)) : epoch.phase) : cur ? `#${cur}` : "—"}
            label={epoch ? `epoch ${epoch.id} ${epoch.phase === "intake" ? "nets in" : ""}`.trim() : "current epoch"}
          />
          <Counter value={s.checkout ? label(s.checkout.status) : s.cart ? "in cart" : "—"} label="checkout (HSP)" accent={!!s.checkout} />
        </div>

        <div className="shop-grid">
          <Panel title="Who hired whom" actions={<span className="muted" style={{ fontSize: 12 }}>every arrow is a signed IOU</span>}>
            <HireGraph session={s} agents={live.agents} now={now} />
          </Panel>
          <Panel title="Payments between agents, as they happen" actions={epochs.length ? <Link className="text-link" style={{ fontSize: 13 }} to={`/epochs/${epochs[epochs.length - 1]}`}>Epoch {epochs[epochs.length - 1]}</Link> : null}>
            <JobStream session={s} agents={live.agents} now={now} />
          </Panel>
        </div>

        <div className="shop-grid shop-grid-b">
          <Panel title={s.options.length ? `${s.options.length} options, ranked by the Concierge` : "Options"}>
            <Options session={s} />
          </Panel>
          <Panel className={`shop-cart ${s.cart ? "has-cart" : ""}`} title="Cart and checkout">
            <CartView session={s} explorer={explorer} now={now} />
          </Panel>
        </div>

        <NetBox session={s} epochs={epochs} />

        <Panel title="What each agent did">
          <ol className="shop-steps">
            {s.steps
              .slice()
              .reverse()
              .map((st, i) => (
                <li key={`${st.at}-${i}`}>
                  <span className="shop-step-agent">{st.agent}</span>
                  <span>{st.text}</span>
                  <time className="muted">{new Date(st.at).toLocaleTimeString()}</time>
                </li>
              ))}
          </ol>
        </Panel>

        <p className="shop-note">
          Kohaku's three stores (Amber Mart, Lantern Tech, Harbor Mobile) are demo stores. Their prices, stock and coupon codes are sample data. The phone specs are read live from Wikipedia. Every
          payment between agents is a real signed IOU, cleared and netted on HashKey Chain testnet. The checkout is a real HSP Agentic Payment order on HSP's QA environment, attributed to team{" "}
          {s.checkout?.merchantName ?? "Kohaku"}.
        </p>
      </div>
    </main>
  );
}

function Waiting({ missing, following }: { missing: boolean; following: boolean }) {
  return (
    <div className="shop-waiting">
      <div className="shop-status">
        <span className="live-dot" aria-hidden />
        {missing ? (following ? "Waiting for the first shopping request" : "No such shopping session") : "Loading…"}
      </div>
      <h1 className="shop-need">Ask your agent to shop.</h1>
      <p className="muted" style={{ maxWidth: 620 }}>
        From Claude with the Kohaku MCP server, try: <i>"Use Kohaku to find me a phone under $500 with a great camera, with the best coupon."</i> This screen follows the latest request and shows every
        agent the Concierge hires, every payment between them, the cart and the HSP checkout.
      </p>
    </div>
  );
}

function Counter({ value, label, accent }: { value: string; label: string; accent?: boolean }) {
  return (
    <div className={`floor-counter ${accent ? "shop-counter-accent" : ""}`}>
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}

// ─────────────────────────────────────────────── hire graph

function HireGraph({ session, agents, now }: { session: Session; agents: AgentSummary[]; now: number }) {
  const W = 680;
  const H = 440;
  const slugOf = (id: string) => (session.buyer && id === session.buyer.agentId ? "you" : (agents.find((a) => a.agentId === id)?.slug ?? `#${id}`));
  const pos = new Map<string, { x: number; y: number }>();
  TIERS.forEach((tier, ti) => {
    const y = 34 + ti * ((H - 70) / (TIERS.length - 1));
    tier.forEach((n, ni) => pos.set(n.slug, { x: ((ni + 1) * W) / (tier.length + 1), y }));
  });
  const edges = new Map<string, { from: string; to: string; count: number; amount: bigint; last: number; services: Set<string> }>();
  const touched = new Map<string, number>();
  for (const j of session.jobs) {
    const from = slugOf(j.buyer);
    const to = slugOf(j.seller);
    const k = `${from}>${to}`;
    const e = edges.get(k) ?? { from, to, count: 0, amount: 0n, last: 0, services: new Set<string>() };
    e.count++;
    e.amount += BigInt(j.price);
    e.last = Math.max(e.last, j.at);
    e.services.add(j.service);
    edges.set(k, e);
    touched.set(from, Math.max(touched.get(from) ?? 0, j.at));
    touched.set(to, Math.max(touched.get(to) ?? 0, j.at));
  }
  const name = (slug: string) => (slug === "you" ? "Your agent" : (agents.find((a) => a.slug === slug)?.name ?? slug));
  const idOf = (slug: string) => agents.find((a) => a.slug === slug)?.agentId ?? slug;
  return (
    <svg className="shop-graph" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Which agent hired which, with the number of paid jobs on each arrow">
      <defs>
        <marker id="shop-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="9" markerHeight="9" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="currentColor" />
        </marker>
      </defs>
      {[...edges.values()].map((e) => {
        const a = pos.get(e.from);
        const b = pos.get(e.to);
        if (!a || !b) return null;
        const hot = now - e.last < 2_500;
        // labels sit at different points along the arrow per source, so fans do not collide
        const t = e.from === "clipper" ? 0.72 : e.from === "pricewise" ? 0.3 : 0.5;
        const mx = a.x + (b.x - a.x) * t;
        const my = a.y + 16 + (b.y - 18 - (a.y + 16)) * t;
        const tag = `${e.count}×`;
        const w = tag.length * 7 + 14;
        return (
          <g key={`${e.from}>${e.to}`} className={`shop-edge ${hot ? "hot" : ""}`}>
            <title>{`${name(e.from)} paid ${name(e.to)} ${usd(e.amount, 4)} over ${e.count} job${e.count === 1 ? "" : "s"} (${[...e.services].join(", ")})`}</title>
            <line x1={a.x} y1={a.y + 16} x2={b.x} y2={b.y - 18} strokeWidth={Math.min(6, 1.2 + Math.log2(e.count + 1))} markerEnd="url(#shop-arrow)" />
            <g transform={`translate(${mx},${my})`}>
              <rect x={-w / 2} y={-10} width={w} height={20} rx={10} />
              <text textAnchor="middle" dy="4">
                {tag}
              </text>
            </g>
          </g>
        );
      })}
      {[...pos.entries()].map(([slug, p]) => {
        const active = now - (touched.get(slug) ?? 0) < 2_500;
        const seen = touched.has(slug);
        return (
          <g key={slug} className={`shop-node ${active ? "active" : ""} ${seen ? "seen" : ""}`} transform={`translate(${p.x},${p.y})`}>
            <rect x={-62} y={-16} width={124} height={32} rx={16} />
            {slug !== "you" && (
              <foreignObject x={-56} y={-11} width={22} height={22}>
                <AgentGem id={idOf(slug)} size={22} />
              </foreignObject>
            )}
            <text x={slug === "you" ? 0 : 8} textAnchor="middle" dy="4">
              {name(slug)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ─────────────────────────────────────────────── job stream

function JobStream({ session, agents, now }: { session: Session; agents: AgentSummary[]; now: number }) {
  const nameOf = (id: string) => (session.buyer && id === session.buyer.agentId ? "Your agent" : (agents.find((a) => a.agentId === id)?.name ?? `#${id}`));
  const jobs = session.jobs.slice().reverse().slice(0, 60);
  if (!jobs.length) return <p className="muted">No payments yet.</p>;
  return (
    <ul className="shop-stream" aria-live="polite">
      {jobs.map((j) => (
        <li key={j.jobId} className={now - j.at < 2_000 ? "new" : ""}>
          <span className="shop-stream-who">
            {nameOf(j.buyer)} <span className="muted">→</span> {nameOf(j.seller)}
          </span>
          <span className="shop-stream-svc">{j.service}</span>
          <Link className="shop-stream-amt" to={`/jobs/${j.jobId}`}>
            {usd(j.price, 4)}
          </Link>
        </li>
      ))}
    </ul>
  );
}

// ─────────────────────────────────────────────── options

function Options({ session }: { session: Session }) {
  if (!session.options.length) return <p className="muted">{session.status === "researching" ? "The Concierge is comparing stores, specs and coupons…" : (session.error ?? "No options.")}</p>;
  const inCart = new Set(session.cart?.lines.map((l) => l.modelId) ?? []);
  return (
    <div className="shop-options">
      {session.summary && <p className="shop-summary">{session.summary}</p>}
      {session.options.map((o) => (
        <article key={o.modelId} className={`shop-option ${inCart.has(o.modelId) ? "in-cart" : ""}`}>
          <div className="shop-option-head">
            <span className="shop-rank">{o.rank}</span>
            <div>
              <h3>{o.name}</h3>
              <div className="muted shop-option-sub">
                {o.best.storeName} · delivery {o.best.deliveryDays} day{o.best.deliveryDays === 1 ? "" : "s"}
                {!o.withinBudget && <> · over budget</>}
              </div>
            </div>
            <div className="shop-price">
              <b>${o.best.final.toFixed(2)}</b>
              {o.best.coupon && (
                <span>
                  <s>${o.best.price}</s> {o.best.coupon.code} −${o.best.coupon.discount}
                </span>
              )}
            </div>
          </div>
          {o.specs ? (
            <dl className="shop-specs">
              {o.specs.chip && (
                <>
                  <dt>Chip</dt>
                  <dd>{o.specs.chip}</dd>
                </>
              )}
              {o.specs.rearCamera && (
                <>
                  <dt>Camera</dt>
                  <dd>{o.specs.rearCamera.split(";").slice(0, 2).join(" · ")}</dd>
                </>
              )}
              {o.specs.display && (
                <>
                  <dt>Display</dt>
                  <dd>{o.specs.display.split(";")[0]}</dd>
                </>
              )}
              {o.specs.battery && (
                <>
                  <dt>Battery</dt>
                  <dd>{o.specs.battery}</dd>
                </>
              )}
            </dl>
          ) : (
            <p className="muted">Spec sheet unavailable.</p>
          )}
          <div className="shop-option-foot">
            <span className="muted">
              {o.offers
                .slice(1)
                .map((x) => `${x.storeName} $${x.final.toFixed(2)}`)
                .join(" · ") || "only one store has it in stock"}
            </span>
            {o.specs && (
              <a className="text-link" href={o.specs.url} target="_blank" rel="noreferrer">
                Wikipedia
              </a>
            )}
            {inCart.has(o.modelId) && <Pill tone="accent">in cart</Pill>}
          </div>
        </article>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────── cart + HSP checkout

const STAGES: { key: string; label: string; match: (c: Checkout | null, s: Session) => number | null }[] = [
  { key: "cart", label: "Added to cart by your agent", match: (_c, s) => s.cart?.addedAt ?? null },
  { key: "order", label: "HSP order created", match: (c) => at(c, "order-created") },
  { key: "quote", label: "Quote locked for your wallet", match: (c) => at(c, "quote-locked") },
  { key: "signed", label: "You approved; wallet signed", match: (c) => at(c, "signed") },
  { key: "submitted", label: "Submitted to HSP", match: (c) => at(c, "payment-submitted") ?? at(c, "payment-verified") ?? at(c, "payment-processing") },
  { key: "included", label: "In a block", match: (c) => at(c, "payment-included") },
  { key: "safe", label: "Safe (half the confirmations)", match: (c) => at(c, "payment-safe") },
  { key: "final", label: "Finalized", match: (c) => at(c, "payment-finalized") },
];

function at(c: Checkout | null, status: string): number | null {
  return c?.history.find((h) => h.status === status)?.at ?? null;
}

function CartView({ session, explorer, now }: { session: Session; explorer: string | null; now: number }) {
  const cart = session.cart;
  const c = session.checkout;
  if (!cart) {
    return (
      <div className="shop-cart-empty">
        <p className="muted">The cart is empty. When the user picks an option, their agent adds it here and checks out through HSP.</p>
      </div>
    );
  }
  const reached = STAGES.map((st) => st.match(c, session));
  const failed = c && (c.status === "payment-failed" || c.status === "error" || c.status === "quote-expired");
  return (
    <div>
      <div className="shop-cart-store">
        <AgentGem id={cart.storeAgentId} size={26} />
        <div>
          <b>{cart.storeName}</b>
          <div className="muted mono" style={{ fontSize: 12 }}>
            {short(cart.payTo, 6)}
          </div>
        </div>
      </div>
      <table className="shop-cart-lines">
        <tbody>
          {cart.lines.map((l) => (
            <tr key={l.modelId}>
              <td>{l.name}</td>
              <td className="num">${l.price.toFixed(2)}</td>
            </tr>
          ))}
          {cart.discount > 0 && (
            <tr className="shop-cart-discount">
              <td>Coupon {cart.lines.map((l) => l.coupon).filter(Boolean).join(", ")}</td>
              <td className="num">−${cart.discount.toFixed(2)}</td>
            </tr>
          )}
          <tr className="shop-cart-total">
            <td>Total</td>
            <td className="num">${cart.total.toFixed(2)}</td>
          </tr>
          <tr className="shop-cart-deposit">
            <td>Pre-booking now through HSP (testnet)</td>
            <td className="num">${cart.depositUsd}</td>
          </tr>
        </tbody>
      </table>

      <ol className="shop-timeline">
        {STAGES.map((st, i) => {
          const t = reached[i];
          const next = !t && reached.slice(0, i).every(Boolean);
          return (
            <li key={st.key} className={t ? "done" : next ? (failed ? "failed" : "next") : ""}>
              <span className="shop-tl-dot" aria-hidden />
              <span>{st.label}</span>
              <time className="muted">{t ? new Date(t).toLocaleTimeString() : next && !failed ? "…" : ""}</time>
            </li>
          );
        })}
      </ol>

      {c && (
        <dl className="shop-hsp">
          <dt>Status</dt>
          <dd>
            <Pill tone={c.status === "payment-finalized" || c.status === "payment-safe" ? "good" : failed ? "warn" : "accent"}>{c.status}</Pill>
          </dd>
          <dt>Merchant</dt>
          <dd>
            {c.merchantName}
            {c.attributionVerified !== null && <span className="muted"> · attribution {c.attributionVerified ? "verified" : "not verified"}</span>}
          </dd>
          <dt>Amount</dt>
          <dd>
            ${c.amountUsd} · {c.tokenTotalRaw ? `${c.tokenTotalRaw} raw ${c.token.symbol}` : "quote pending"}
            {c.quoteExpiresAt && c.status === "awaiting-signature" && <span className="muted"> · quote {Date.parse(c.quoteExpiresAt) > now ? `expires in ${clock(Date.parse(c.quoteExpiresAt) - now)}` : "expired"}</span>}
          </dd>
          <dt>Payer</dt>
          <dd className="mono">{short(c.payer, 6)}</dd>
          <dt>HSP flow</dt>
          <dd className="mono">{c.flowId}</dd>
          {c.txHash && (
            <>
              <dt>Transaction</dt>
              <dd className="mono">
                {explorer ? (
                  <a className="text-link" href={`${explorer.replace(/\/+$/, "")}/tx/${c.txHash}`} target="_blank" rel="noreferrer">
                    {short(c.txHash, 8)}
                  </a>
                ) : (
                  short(c.txHash, 8)
                )}
              </dd>
            </>
          )}
          {c.statusReason && (
            <>
              <dt>Note</dt>
              <dd>{c.statusReason}</dd>
            </>
          )}
        </dl>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────── netting

function NetBox({ session, epochs }: { session: Session; epochs: number[] }) {
  if (!epochs.length) return null;
  return (
    <section className="shop-net">
      {epochs.map((e) => (
        <NetRow key={e} id={e} mine={session.jobs.filter((j) => j.epoch === e).length} />
      ))}
    </section>
  );
}

/** Each epoch read from the API: the live map only updates on phase changes. */
function NetRow({ id, mine }: { id: number; mine: number }) {
  const { data } = useApi<{ epoch: EpochView }>(`/v1/epochs/${id}`, 5_000);
  const v = data?.epoch;
  const netted = v && v.phase !== "intake" && v.phase !== "challenge";
  return (
    <div className="shop-net-row">
      <div>
        <b>{mine}</b> of this request's payments are in <Link to={`/epochs/${id}`}>epoch {id}</Link>
        {v ? <span className="muted"> with {v.iouCount} IOUs in total from every agent on Kohaku</span> : null}.
      </div>
      <div className="shop-net-result">
        {netted && v ? (
          <>
            netted to <b>{v.settlementTransfers}</b> settlement transfer{v.settlementTransfers === 1 ? "" : "s"} through HSP ({v.transfersAvoided} avoided)
          </>
        ) : (
          <span className="muted">nets into a handful of HSP settlements when the epoch closes</span>
        )}
      </div>
    </div>
  );
}

function label(status: string): string {
  return status.replace(/^payment-/, "").replace(/-/g, " ");
}

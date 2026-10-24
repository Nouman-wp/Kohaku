import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import type { AgentSummary, IouView, JobView, PositionView } from "@kohaku/core";
import { api, useLive, agentName, type LiveState } from "../lib/api.ts";
import { clock, compact, pct, signedUsd, usd, score, explorerTx } from "../lib/format.ts";
import { AgentGem, Badge, Btn, Panel, Pill, useNow, HashLink } from "../components/ui.tsx";

export default function Floor() {
  const live = useLive();
  const now = useNow(250);
  const cur = live.stats?.currentEpoch ?? null;
  const epoch = cur ? live.epochs.get(cur) : undefined;
  const [backfill, setBackfill] = useState<{ iou: IouView; job?: JobView }[]>([]);

  useEffect(() => {
    if (!cur) return;
    api<{ ious: IouView[] }>("/v1/epochs/current")
      .then((d) => setBackfill(d.ious.map((iou) => ({ iou }))))
      .catch(() => undefined);
  }, [cur]);

  const epochIous = useMemo(() => {
    const m = new Map<string, IouView>();
    for (const b of backfill) if (b.iou.epoch === cur) m.set(b.iou.digest, b.iou);
    for (const r of live.ious) if (r.iou.epoch === cur) m.set(r.iou.digest, r.iou);
    return [...m.values()];
  }, [backfill, live.ious, cur]);
  const gross = epochIous.reduce((a, i) => a + BigInt(i.amount), 0n);
  const refusedNow = live.refusals.filter((r) => epoch && r.at >= epoch.startsAt).length;
  const remaining = epoch ? epoch.intakeEndsAt - now : 0;

  return (
    <main className="page page-wide floor">
      <div className="page-inner">
        <div className="floor-top">
          <div className="floor-epoch">
            <div>
              <div className="muted" style={{ fontSize: 13 }}>
                <span className={`live-dot ${live.connected ? "" : "off"}`} />
                {live.connected ? "Live clearing floor" : "Reconnecting…"}
              </div>
              <div className="floor-epoch-num">Epoch {cur ?? "—"}</div>
            </div>
            <div>
              <div className="muted" style={{ fontSize: 13 }}>intake closes in</div>
              <div className="floor-clock">{epoch ? clock(remaining) : "--:--"}</div>
            </div>
          </div>
          <div className="floor-counters">
            <div className="floor-counter">
              <b>{epochIous.length}</b>
              <span>IOUs this epoch</span>
            </div>
            <div className="floor-counter">
              <b>{usd(gross, 4)}</b>
              <span>gross obligations</span>
            </div>
            <div className="floor-counter">
              <b>{refusedNow}</b>
              <span>refused by policy</span>
            </div>
            <div className="floor-counter">
              <b>{live.stats ? compact(live.stats.transfersAvoided) : "—"}</b>
              <span>transfers avoided, all time</span>
            </div>
          </div>
          <ScenarioControls />
        </div>

        <div className="floor-grid">
          <Panel className="graph-panel panel-glass" title={<>Debt graph · epoch {cur ?? "—"}</>} actions={<Pill tone="muted">edge width = gross owed</Pill>}>
            <DebtGraph agents={live.agents} ious={epochIous} />
          </Panel>
          <Panel className="panel-glass" title="Signed IOUs, as they arrive" actions={<Link className="text-link" style={{ fontSize: 13 }} to={cur ? `/epochs/${cur}` : "/epochs"}>Epoch detail</Link>}>
            <Stream live={live} />
          </Panel>
        </div>

        <NettingMoment live={live} />

        <div className="grid grid-2" style={{ marginTop: 16 }}>
          <Panel title="Disputes and reputation">
            <DisputeTicker live={live} />
          </Panel>
          <Panel title="Settlement through HSP">
            <SettlementTicker live={live} />
          </Panel>
        </div>
      </div>
    </main>
  );
}

// ─────────────────────────────────────────────── debt graph

function DebtGraph({ agents, ious }: { agents: AgentSummary[]; ious: IouView[] }) {
  const W = 880;
  const H = 560;
  const cx = W / 2;
  const cy = H / 2 + 6;
  const active = agents.filter((a) => a.isFleet || ious.some((i) => i.buyer === a.agentId || i.seller === a.agentId)).slice(0, 14);
  const hub = active.find((a) => a.slug === "orchestrator");
  const ring = active.filter((a) => a !== hub);
  const pos = new Map<string, { x: number; y: number }>();
  if (hub) pos.set(hub.agentId, { x: cx, y: cy });
  ring.forEach((a, i) => {
    const t = (i / Math.max(1, ring.length)) * Math.PI * 2 - Math.PI / 2;
    pos.set(a.agentId, { x: cx + Math.cos(t) * 330, y: cy + Math.sin(t) * 215 });
  });

  const edges = useMemo(() => {
    const m = new Map<string, { from: string; to: string; amount: bigint; count: number; last: string }>();
    for (const i of ious) {
      const k = `${i.buyer}>${i.seller}`;
      const e = m.get(k) ?? { from: i.buyer, to: i.seller, amount: 0n, count: 0, last: "" };
      e.amount += BigInt(i.amount);
      e.count++;
      e.last = i.digest;
      m.set(k, e);
    }
    return [...m.values()];
  }, [ious]);

  const nets = useMemo(() => {
    const m = new Map<string, bigint>();
    for (const i of ious) {
      m.set(i.seller, (m.get(i.seller) ?? 0n) + BigInt(i.amount));
      m.set(i.buyer, (m.get(i.buyer) ?? 0n) - BigInt(i.amount));
    }
    return m;
  }, [ious]);
  const max = edges.reduce((a, e) => (e.amount > a ? e.amount : a), 1n);

  return (
    <svg className="graph-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Debt graph for the current epoch">
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="rgba(186,156,255,.8)" />
        </marker>
        <radialGradient id="hubglow">
          <stop offset="0" stopColor="rgba(255,200,130,.35)" />
          <stop offset="1" stopColor="rgba(255,159,69,0)" />
        </radialGradient>
      </defs>
      {[1, 2, 3].map((r) => (
        <ellipse key={r} cx={cx} cy={cy} rx={110 * r} ry={72 * r} fill="none" stroke="rgba(186,156,255,.07)" />
      ))}
      {edges.map((e) => {
        const a = pos.get(e.from);
        const b = pos.get(e.to);
        if (!a || !b) return null;
        const w = 1 + 7 * Math.sqrt(Number(e.amount) / Number(max));
        const mx = (a.x + b.x) / 2 + (b.y - a.y) * 0.18;
        const my = (a.y + b.y) / 2 - (b.x - a.x) * 0.18;
        const dx = b.x - mx;
        const dy = b.y - my;
        const len = Math.hypot(dx, dy) || 1;
        const ex = b.x - (dx / len) * 34;
        const ey = b.y - (dy / len) * 34;
        return (
          <g key={`${e.from}>${e.to}`}>
            <path className="edge" d={`M${a.x},${a.y} Q${mx},${my} ${ex},${ey}`} fill="none" stroke="rgba(186,156,255,.55)" strokeOpacity={0.35 + 0.5 * (w / 8)} strokeWidth={w} markerEnd="url(#arrow)" />
            <path key={e.last} className="pulse" d={`M${a.x},${a.y} Q${mx},${my} ${ex},${ey}`} fill="none" stroke="#f4f0ff" strokeOpacity={0} strokeWidth={w} />
          </g>
        );
      })}
      {hub && <circle cx={cx} cy={cy} r={110} fill="url(#hubglow)" />}
      {active.map((a) => {
        const p = pos.get(a.agentId);
        if (!p) return null;
        const n = nets.get(a.agentId) ?? 0n;
        return (
          <g key={a.agentId} transform={`translate(${p.x},${p.y})`}>
            <circle r={30} fill="rgba(6,3,23,.9)" stroke="rgba(186,156,255,.35)" />
            <foreignObject x={-16} y={-16} width={32} height={32}>
              <AgentGem id={a.agentId} size={32} />
            </foreignObject>
            <text className="node-label" textAnchor="middle" y={50}>
              {a.name}
            </text>
            <text className="node-sub" textAnchor="middle" y={68}>
              {n === 0n ? `rep ${score(a.reputation)}` : `${signedUsd(n)} · rep ${score(a.reputation)}`}
            </text>
          </g>
        );
      })}
      {active.length === 0 && (
        <text x={cx} y={cy} textAnchor="middle" className="node-sub">
          Waiting for agents…
        </text>
      )}
    </svg>
  );
}

// ─────────────────────────────────────────────── stream

function Stream({ live }: { live: LiveState }) {
  const items = useMemo(() => {
    const ious = live.ious.slice(0, 40).map((r) => ({ kind: "iou" as const, at: r.at, r }));
    const refused = live.refusals.slice(0, 12).map((r) => ({ kind: "refused" as const, at: r.at, r }));
    return [...ious, ...refused].sort((a, b) => b.at - a.at).slice(0, 40);
  }, [live.ious, live.refusals]);
  if (!items.length) return <div className="empty">No IOUs yet this session. The fleet trades every few seconds.</div>;
  return (
    <div className="stream">
      {items.map((it) =>
        it.kind === "iou" ? (
          <Link key={it.r.iou.digest} to={`/jobs/${it.r.job.id}`} className="stream-item">
            <AgentGem id={it.r.iou.buyer} size={22} />
            <div className="who">
              <b>{agentName(live.agents, it.r.iou.buyer)}</b> → <b>{agentName(live.agents, it.r.iou.seller)}</b> <span className="svc">{it.r.job.service}</span>
            </div>
            <span className="num dim">{usd(it.r.iou.amount, 4)}</span>
          </Link>
        ) : (
          <div key={`${it.at}-${it.r.reason}`} className="stream-item refused" title={it.r.reason}>
            <span style={{ width: 22, textAlign: "center" }}>⊘</span>
            <div className="who">
              Refused: {agentName(live.agents, it.r.buyer)} → {agentName(live.agents, it.r.seller)} <span className="svc">{it.r.reason}</span>
            </div>
            <span className="num">{usd(it.r.amount, 4)}</span>
          </div>
        ),
      )}
    </div>
  );
}

// ─────────────────────────────────────────────── netting moment

function NettingMoment({ live }: { live: LiveState }) {
  const id = useMemo(() => Math.max(0, ...[...live.netted.keys()]), [live.netted]);
  const epoch = id ? live.epochs.get(id) : undefined;
  const positions: PositionView[] = id ? live.netted.get(id) ?? [] : [];
  const [collapsed, setCollapsed] = useState(false);
  const seen = useRef(0);
  useEffect(() => {
    if (!id || id === seen.current) return;
    seen.current = id;
    setCollapsed(false);
    const t = setTimeout(() => setCollapsed(true), 900);
    return () => clearTimeout(t);
  }, [id]);
  if (!epoch) {
    return (
      <Panel className="netting-moment" title="The netting moment">
        <div className="empty">When the current epoch closes, its IOUs collapse into net positions here.</div>
      </Panel>
    );
  }
  const bars = Math.min(120, Math.max(epoch.iouCount, 1));
  const keep = epoch.settlementTransfers;
  return (
    <Panel
      className="netting-moment panel-glass"
      title={
        <>
          Epoch {epoch.id} netted <Pill tone={epoch.phase === "sealed" ? "good" : "accent"}>{epoch.phase}</Pill>
        </>
      }
      actions={
        <Link className="text-link" style={{ fontSize: 13 }} to={`/epochs/${epoch.id}`}>
          Receipt and verification
        </Link>
      }
    >
      <div className="collapse">
        <div className="collapse-side">
          <b>{epoch.iouCount}</b>
          <span>IOUs · {usd(epoch.grossVolume, 4)} gross</span>
        </div>
        <div className="collapse-arrow">→</div>
        <div className="collapse-side">
          <b className="cosmic-text">{epoch.settlementTransfers}</b>
          <span>
            transfers · {usd(epoch.netVolume, 4)} net · {pct(epoch.transferReduction)} fewer payments
          </span>
        </div>
      </div>
      <div className={`bars ${collapsed ? "collapsed" : ""}`} aria-hidden>
        {Array.from({ length: bars }, (_, i) => (
          <i key={`${epoch.id}-${i}`} className={i % Math.max(1, Math.floor(bars / Math.max(1, keep))) === 0 && i / Math.max(1, Math.floor(bars / Math.max(1, keep))) < keep ? "keep" : ""} style={{ height: `${30 + ((i * 37) % 70)}%` }} />
        ))}
      </div>
      <div className="positions-list">
        {[...positions]
          .filter((p) => p.net !== "0")
          .sort((a, b) => Number(a.net) - Number(b.net))
          .map((p) => {
            const s = live.settlements.get(`stl_${epoch.id}_${p.agentId}`);
            const paid = live.payouts.get(epoch.id)?.find((x) => x.agentId === p.agentId);
            const state = BigInt(p.net) < 0n ? (s ? s.status.replace("_", " ") : p.state) : paid ? "paid out" : epoch.phase === "sealed" ? "paid out" : "awaiting payout";
            return (
              <div key={p.agentId} className="position-card">
                <AgentGem id={p.agentId} size={26} />
                <div>
                  <div style={{ fontWeight: 500 }}>{agentName(live.agents, p.agentId)}</div>
                  <div className="state">
                    {BigInt(p.net) < 0n ? "pays via HSP · " : "receives · "}
                    {state}
                  </div>
                </div>
                <span className="amt">{signedUsd(p.net)}</span>
              </div>
            );
          })}
      </div>
    </Panel>
  );
}

function DisputeTicker({ live }: { live: LiveState }) {
  const items = live.ticker.filter((e) => e.type === "dispute.opened" || e.type === "dispute.resolved" || e.type === "reputation").slice(0, 30);
  if (!items.length) return <div className="empty">No disputes yet. Rogue will get caught eventually.</div>;
  return (
    <div className="ticker">
      {items.map((e, i) => {
        if (e.type === "dispute.opened")
          return (
            <div key={i}>
              <b>{agentName(live.agents, e.dispute.buyer)}</b> disputed <Link to={`/jobs/${e.dispute.jobId}`} className="accent">a job</Link> by <b>{agentName(live.agents, e.dispute.seller)}</b>: {e.dispute.reason}
            </div>
          );
        if (e.type === "dispute.resolved")
          return (
            <div key={i}>
              <b>{agentName(live.agents, e.dispute.validator)}</b> {e.dispute.status === "upheld" ? "upheld" : "rejected"} the dispute against <b>{agentName(live.agents, e.dispute.seller)}</b>
              {e.dispute.status === "upheld" ? "; the IOU is void" : ""}. <span className="muted">{e.dispute.reasoning}</span>
            </div>
          );
        if (e.type === "reputation")
          return (
            <div key={i}>
              Reputation{" "}
              {e.scores
                .slice(0, 4)
                .map((s) => `${agentName(live.agents, s.agentId)} ${score(s.previous)}→${score(s.score)}`)
                .join(", ")}
            </div>
          );
        return null;
      })}
    </div>
  );
}

function SettlementTicker({ live }: { live: LiveState }) {
  const list = [...live.settlements.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 14);
  const explorer = live.stats?.chain.explorer;
  if (!list.length) return <div className="empty">Net debtors pay here when an epoch closes.</div>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Epoch</th>
            <th>Debtor</th>
            <th className="num">Amount</th>
            <th>HSP</th>
            <th>Transfer</th>
          </tr>
        </thead>
        <tbody>
          {list.map((s) => (
            <tr key={s.id}>
              <td>
                <Link to={`/epochs/${s.epoch}`}>{s.epoch}</Link>
              </td>
              <td>{agentName(live.agents, s.agentId)}</td>
              <td className="num">{usd(s.amount, 4)}</td>
              <td>
                <Pill tone={s.status === "recorded" ? "good" : s.status === "defaulted" ? "warn" : "accent"}>{s.status.replace("_", " ")}</Pill>
              </td>
              <td>
                <HashLink hash={s.settlementTx} href={explorerTx(explorer, s.settlementTx)} n={4} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─────────────────────────────────────────────── scenario runner

function ScenarioControls() {
  const [token, setToken] = useState(() => {
    try {
      return localStorage.getItem("kohaku-admin") ?? "";
    } catch {
      return "";
    }
  });
  const [msg, setMsg] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const run = async (action: string, scenario?: string) => {
    try {
      const r =
        action === "close"
          ? await api<{ epoch: number }>("/v1/admin/close-epoch", { method: "POST", body: JSON.stringify({ token }) }).then((x) => ({ message: `closing epoch ${x.epoch}` }))
          : await api<{ message: string }>("/v1/scenario", { method: "POST", body: JSON.stringify({ action, scenario, token }) });
      setMsg(r.message);
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  if (!open)
    return (
      <div className="control-bar" style={{ justifyContent: "flex-end" }}>
        <Btn variant="secondary" size="sm" onClick={() => setOpen(true)}>
          Scenario runner
        </Btn>
        <Btn to="/intents/new" size="sm">
          Sign an intent
        </Btn>
      </div>
    );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-end" }}>
      <div className="control-bar">
        <input
          className="input"
          style={{ width: 150, padding: "5px 10px", fontSize: 13 }}
          type="password"
          placeholder="admin token"
          value={token}
          onChange={(e) => {
            setToken(e.target.value);
            try {
              localStorage.setItem("kohaku-admin", e.target.value);
            } catch {
              // private mode
            }
          }}
        />
        <Btn size="sm" variant="secondary" onClick={() => run("start", "research-brief")}>
          Research brief
        </Btn>
        <Btn size="sm" variant="secondary" onClick={() => run("start", "busy-minute")}>
          Busy minute
        </Btn>
        <Btn size="sm" variant="secondary" onClick={() => run("start", "rogue-attack")}>
          Rogue attack
        </Btn>
        <Btn size="sm" variant="secondary" onClick={() => run("start", "default-drill")}>
          Default drill
        </Btn>
        <Btn size="sm" variant="secondary" onClick={() => run("close")}>
          Close epoch now
        </Btn>
        <Btn size="sm" variant="secondary" onClick={() => run("reset")}>
          Reset
        </Btn>
      </div>
      {msg && <div className="muted" style={{ fontSize: 12 }}>{msg}</div>}
      <Badge icon={false}>Demo controls drive the real fleet</Badge>
    </div>
  );
}

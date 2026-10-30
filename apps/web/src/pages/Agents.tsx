import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import type { AgentSummary, DisputeView, IntentView, JobView, PayoutView, PositionView, SettlementView } from "@kohaku/core";
import { formatScore } from "@kohaku/core";
import { API, useApi, useLive, agentName } from "../lib/api.ts";
import { ago, score, short, signedUsd, usd, explorerAddr, explorerTx } from "../lib/format.ts";
import { AgentGem, Btn, Empty, HashLink, PageHead, Panel, Pill, Stat, Stats } from "../components/ui.tsx";
import { Loading, Missing } from "./Epochs.tsx";

export function AgentList() {
  const live = useLive();
  const [q, setQ] = useState("");
  const [cap, setCap] = useState("");
  const [minRep, setMinRep] = useState(0);
  const [maxPrice, setMaxPrice] = useState("");
  const caps = useMemo(() => [...new Set(live.agents.flatMap((a) => a.services.map((s) => s.id)))].sort(), [live.agents]);
  const list = live.agents.filter((a) => {
    if (q && !`${a.name} ${a.description} ${a.role} ${a.services.map((s) => s.name).join(" ")}`.toLowerCase().includes(q.toLowerCase())) return false;
    if (cap && !a.services.some((s) => s.id === cap)) return false;
    if (a.reputation < minRep * 10) return false;
    if (maxPrice && !a.services.some((s) => (!cap || s.id === cap) && Number(s.price) / 1e6 <= Number(maxPrice))) return false;
    return true;
  });
  return (
    <main className="page">
      <div className="page-inner">
        <PageHead
          title="Agent registry"
          sub="Every agent here is an ERC-8004 identity on chain, with an A2A agent card, a price list, posted collateral and a reputation computed from what it actually did."
          actions={<Btn to="/console">Register your agent</Btn>}
        />
        <div className="toolbar" role="search">
          <input
            className="input grow"
            type="search"
            name="q"
            autoComplete="off"
            aria-label="Search agents and services"
            placeholder="Search agents and services…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <select className="select" aria-label="Capability" value={cap} onChange={(e) => setCap(e.target.value)}>
            <option value="">Any capability</option>
            {caps.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <select className="select" aria-label="Minimum reputation" value={minRep} onChange={(e) => setMinRep(Number(e.target.value))}>
            <option value={0}>Any reputation</option>
            <option value={60}>Reputation ≥ 60</option>
            <option value={70}>Reputation ≥ 70</option>
            <option value={85}>Reputation ≥ 85</option>
          </select>
          <input
            className="input"
            style={{ minWidth: 150, width: 150 }}
            name="max-price"
            inputMode="decimal"
            autoComplete="off"
            aria-label="Maximum price in USDC"
            placeholder="Max price…"
            value={maxPrice}
            onChange={(e) => setMaxPrice(e.target.value)}
          />
          <span className="toolbar-count" aria-live="polite">
            {live.agents.length ? `${list.length} of ${live.agents.length} agents` : ""}
          </span>
        </div>
        <div className="grid grid-3">
          {list.map((a) => (
            <AgentCard key={a.agentId} a={a} />
          ))}
        </div>
        {!list.length && <Empty>{live.agents.length ? "No agent matches those filters." : "Loading the registry…"}</Empty>}
      </div>
    </main>
  );
}

function AgentCard({ a }: { a: AgentSummary }) {
  return (
    <Link to={`/agents/${a.agentId}`} className="panel agent-card">
      <div className="agent-cell">
        <AgentGem id={a.agentId} size={40} />
        <div style={{ minWidth: 0 }}>
          <b style={{ fontSize: 16, color: "var(--text)" }}>{a.name}</b>
          <div className="muted" style={{ fontSize: 13 }}>
            {a.role} · #{a.agentId}
          </div>
        </div>
        <div style={{ marginLeft: "auto" }}>
          <Pill tone={a.status === "active" ? (a.reputation >= 700 ? "good" : "warn") : "muted"}>{a.status === "active" ? `rep ${score(a.reputation)}` : a.status}</Pill>
        </div>
      </div>
      <p className="agent-card-desc">{a.description}</p>
      <div className="svc-list">
        {a.services.map((s) => (
          <div key={s.id}>
            <span>{s.name}</span>
            <span className="num">
              {usd(s.price, 4)} / {s.unit}
            </span>
          </div>
        ))}
        {!a.services.length && <div className="muted">Buyer only</div>}
      </div>
      <div className="agent-card-foot">
        {a.jobsSold} sold · {a.jobsBought} bought · {usd(a.collateral.total)} collateral
      </div>
    </Link>
  );
}

interface AgentDetail {
  agent: AgentSummary;
  reputation: { live: number; chain: { score: number | null; epoch: number | null }; inputs: Record<string, number | string>; history: { epoch: number; score: number; previous: number; tx: string | null; at: number }[] };
  jobs: JobView[];
  counterparties: { agentId: string; name: string; sold: string; bought: string; jobs: number }[];
  byService: { service: string; side: string; n: number; v: string }[];
  disputes: DisputeView[];
  settlements: SettlementView[];
  payouts: PayoutView[];
  positions: PositionView[];
  intents: IntentView[];
}

export function AgentPage() {
  const { id } = useParams();
  const live = useLive();
  const { data, error } = useApi<AgentDetail>(`/v1/agents/${id}`, 5_000);
  if (error) return <Missing what={`agent ${id}`} error={error} />;
  if (!data) return <Loading />;
  const a = data.agent;
  const explorer = live.stats?.chain.explorer;
  const inputs = data.reputation.inputs;
  return (
    <main className="page">
      <div className="page-inner">
        <PageHead
          crumbs={
            <>
              <Link to="/agents">Agents</Link> / <span>{a.name}</span>
            </>
          }
          title={
            <span className="agent-cell" style={{ gap: 16 }}>
              <AgentGem id={a.agentId} size={44} />
              {a.name}
            </span>
          }
          meta={
            <>
              <Pill tone={a.status === "active" ? "good" : "muted"}>{a.status}</Pill>
              <span>ERC-8004 agent #{a.agentId}</span>
              <span>{a.role}</span>
            </>
          }
          sub={a.description}
          actions={
            <>
              <Btn href={a.cardUrl} variant="secondary">
                Agent card
              </Btn>
              <Btn href={`${API}/v1/agents/${a.agentId}/export.csv`} variant="secondary">
                Compliance export
              </Btn>
            </>
          }
        />
        <Stats>
          <Stat label="Reputation (live)" value={formatScore(data.reputation.live)} hint={data.reputation.chain.score !== null ? `on chain ${formatScore(data.reputation.chain.score)} @ epoch ${data.reputation.chain.epoch}` : "not yet written on chain"} accent />
          <Stat label="Sold" value={usd(a.volumeSold, 4)} hint={`${a.jobsSold} jobs`} />
          <Stat label="Bought" value={usd(a.volumeBought, 4)} hint={`${a.jobsBought} jobs`} />
          <Stat label="Collateral" value={usd(a.collateral.total)} hint={`${usd(a.collateral.locked)} locked · ${usd(a.collateral.exposure, 4)} exposure`} />
          <Stat label="Headroom" value={usd(a.collateral.headroom)} hint="free collateral minus open obligations" />
        </Stats>
        <div className="grid grid-2" style={{ marginBottom: 16 }}>
          <Panel title="Identity">
            <dl className="kv">
              <dt>Operator</dt>
              <dd>
                <HashLink hash={a.operator} href={explorerAddr(explorer, a.operator)} n={8} />
              </dd>
              <dt>Agent wallet</dt>
              <dd>
                <HashLink hash={a.signer} href={explorerAddr(explorer, a.signer)} n={8} />
              </dd>
              <dt>A2A endpoint</dt>
              <dd className="mono dim" style={{ fontSize: 12 }}>
                {a.endpoint || "—"}
              </dd>
              <dt>Services</dt>
              <dd>
                {a.services.map((s) => (
                  <div key={s.id}>
                    {s.name} · {usd(s.price, 4)} / {s.unit} <span className="muted">({s.tags.join(", ")})</span>
                  </div>
                ))}
                {!a.services.length && <span className="muted">none</span>}
              </dd>
              <dt>Validator</dt>
              <dd>{a.isValidator ? "Yes, staked" : "No"}</dd>
            </dl>
          </Panel>
          <Panel title="Reputation inputs" actions={<Link to="/developers#reputation" className="text-link" style={{ fontSize: 13 }}>Formula</Link>}>
            <dl className="kv">
              <dt>Jobs completed</dt>
              <dd>{String(inputs.completed)}</dd>
              <dt>Disputes lost / won</dt>
              <dd>
                {String(inputs.disputesLost)} / {String(inputs.disputesWon)}
              </dd>
              <dt>Frivolous disputes</dt>
              <dd>{String(inputs.frivolousDisputes)}</dd>
              <dt>Settled on time</dt>
              <dd>{String(inputs.settledOnTime)}</dd>
              <dt>Defaults</dt>
              <dd>{String(inputs.defaults)}</dd>
            </dl>
            <h3 className="panel-sub">History (on-chain writes)</h3>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {data.reputation.history.slice(0, 18).map((h) => (
                <span key={h.epoch} title={h.tx ?? ""}>
                  <Pill tone={h.score < h.previous ? "warn" : "muted"}>
                    e{h.epoch}: {score(h.score)}
                  </Pill>
                </span>
              ))}
              {!data.reputation.history.length && <span className="muted">none yet</span>}
            </div>
          </Panel>
        </div>
        <div className="grid grid-2" style={{ marginBottom: 16 }}>
          <Panel title="Counterparties">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Agent</th>
                  <th scope="col" className="num">
                    Sold to
                  </th>
                  <th scope="col" className="num">
                    Bought from
                  </th>
                  <th scope="col" className="num">
                    Jobs
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.counterparties.map((c) => (
                  <tr key={c.agentId}>
                    <td>
                      <Link to={`/agents/${c.agentId}`} className="agent-cell">
                        <AgentGem id={c.agentId} size={20} /> {c.name}
                      </Link>
                    </td>
                    <td className="num">{usd(c.sold, 4)}</td>
                    <td className="num">{usd(c.bought, 4)}</td>
                    <td className="num">{c.jobs}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!data.counterparties.length && <Empty>No settled jobs yet.</Empty>}
          </Panel>
          <Panel title="By service">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Service</th>
                  <th scope="col">Side</th>
                  <th scope="col" className="num">
                    Jobs
                  </th>
                  <th scope="col" className="num">
                    Volume
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.byService.map((s) => (
                  <tr key={`${s.service}-${s.side}`}>
                    <td>{s.service}</td>
                    <td className="dim">{s.side}</td>
                    <td className="num">{s.n}</td>
                    <td className="num">{usd(s.v, 4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!data.byService.length && <Empty>Nothing yet.</Empty>}
          </Panel>
        </div>
        <Panel title="Recent jobs" actions={<span className="muted" style={{ fontSize: 13 }}>{data.jobs.length} shown</span>}>
          <div className="table-wrap" style={{ maxHeight: 420, overflow: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Job</th>
                  <th scope="col">Side</th>
                  <th scope="col">Counterparty</th>
                  <th scope="col">Service</th>
                  <th scope="col" className="num">
                    Price
                  </th>
                  <th scope="col">Epoch</th>
                  <th scope="col">Status</th>
                  <th scope="col">When</th>
                </tr>
              </thead>
              <tbody>
                {data.jobs.map((j) => {
                  const sold = j.seller === a.agentId;
                  return (
                    <tr key={j.id}>
                      <td>
                        <Link to={`/jobs/${j.id}`} className="hash-link">
                          <span className="mono">{j.id.slice(4, 14)}</span>
                        </Link>
                      </td>
                      <td className="dim">{sold ? "sold" : "bought"}</td>
                      <td>{agentName(live.agents, sold ? j.buyer : j.seller)}</td>
                      <td>{j.service}</td>
                      <td className="num">{usd(j.price, 4)}</td>
                      <td>
                        <Link to={`/epochs/${j.epoch}`}>{j.epoch}</Link>
                      </td>
                      <td>
                        <Pill tone={j.status === "settled" ? "good" : j.status === "voided" || j.status === "disputed" ? "warn" : "muted"}>{j.status}</Pill>
                      </td>
                      <td className="muted">{ago(j.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>
        <div className="grid grid-2" style={{ marginTop: 16 }}>
          <Panel title="Settlements and payouts">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Epoch</th>
                  <th scope="col">Kind</th>
                  <th scope="col" className="num">
                    Amount
                  </th>
                  <th scope="col">Tx</th>
                </tr>
              </thead>
              <tbody>
                {data.settlements.map((s) => (
                  <tr key={s.id}>
                    <td>{s.epoch}</td>
                    <td>
                      <Pill tone={s.status === "recorded" ? "good" : s.status === "defaulted" ? "warn" : "accent"}>{s.status === "recorded" ? "paid via HSP" : s.status.replace("_", " ")}</Pill>
                    </td>
                    <td className="num">−{usd(s.amount, 4)}</td>
                    <td>
                      <HashLink hash={s.settlementTx} href={explorerTx(explorer, s.settlementTx)} n={4} />
                    </td>
                  </tr>
                ))}
                {data.payouts.map((p) => (
                  <tr key={`p${p.epoch}`}>
                    <td>{p.epoch}</td>
                    <td>
                      <Pill tone="good">payout</Pill>
                    </td>
                    <td className="num">+{usd(p.amount, 4)}</td>
                    <td>
                      <HashLink hash={p.tx} href={explorerTx(explorer, p.tx)} n={4} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!data.settlements.length && !data.payouts.length && <Empty>No settlements yet.</Empty>}
          </Panel>
          <Panel title="Disputes">
            {data.disputes.map((d) => (
              <div key={d.id} className="list-row">
                <div className="dispute-line">
                  <Pill tone={d.status === "upheld" ? "warn" : d.status === "open" ? "accent" : "muted"}>{d.status}</Pill>
                  <Link to={`/jobs/${d.jobId}`} className="cell-link" style={{ fontWeight: 500 }}>
                    {d.reason}
                  </Link>
                </div>
                {d.reasoning && (
                  <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
                    {d.reasoning}
                  </div>
                )}
              </div>
            ))}
            {!data.disputes.length && <Empty>No disputes.</Empty>}
          </Panel>
        </div>
        {data.intents.length > 0 && (
          <Panel title="Intents (AP2 mandates)">
            <div style={{ marginTop: 4 }}>
              {data.intents.map((i) => (
                <IntentRow key={i.id} i={i} />
              ))}
            </div>
          </Panel>
        )}
        {data.positions.length > 0 && (
          <div className="muted" style={{ marginTop: 16, fontSize: 13 }}>
            Net positions by epoch:{" "}
            {data.positions.slice(0, 20).map((p) => (
              <Link key={p.epoch} to={`/epochs/${p.epoch}`} style={{ marginRight: 10 }}>
                e{p.epoch} {signedUsd(p.net)}
              </Link>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

export function IntentRow({ i }: { i: IntentView }) {
  const spent = Number(i.spent) / Math.max(1, Number(i.budget));
  return (
    <Link to={`/intents/${i.id}`} className="list-row intent-row">
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
        <Pill tone={i.status === "active" ? "accent" : "muted"}>{i.status}</Pill>
        <span>{i.goal}</span>
        <span className="muted" style={{ marginLeft: "auto", fontSize: 13 }}>
          {usd(i.spent, 4)} of {usd(i.budget)} · {i.jobs} jobs · {i.refusals} refused
        </span>
      </div>
      <div className="progress">
        <i style={{ width: `${Math.min(100, spent * 100)}%` }} />
      </div>
      <div className="muted mono" style={{ fontSize: 12, marginTop: 6 }}>
        {short(i.id, 8)}
      </div>
    </Link>
  );
}

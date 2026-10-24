import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { isAddressEqual, type Address, type Hex } from "viem";
import { INTENT_TYPES, usd as toUnits, type IntentView, type JobView } from "@kohaku/core";
import { api, fleet, useApi, useLive, agentName } from "../lib/api.ts";
import { ago, usd, short } from "../lib/format.ts";
import { useConfig, useWallet } from "../lib/wallet.ts";
import { AgentGem, Badge, Btn, Empty, Panel, Pill, Stat } from "../components/ui.tsx";
import { Loading, Missing } from "./Epochs.tsx";

const SERVICES = ["search", "factcheck", "summarize", "translate", "describe", "verdict"];

export function IntentComposer() {
  const live = useLive();
  const cfg = useConfig();
  const wallet = useWallet(cfg);
  const nav = useNavigate();
  const [params] = useSearchParams();
  const orchestrator = live.agents.find((a) => a.slug === "orchestrator");
  const [buyer, setBuyer] = useState(params.get("buyer") ?? "");
  const [goal, setGoal] = useState("Produce a researched, fact-checked brief on Chandrayaan-3 in English and Hindi");
  const [budget, setBudget] = useState("20");
  const [cap, setCap] = useState("0.05");
  const [minRep, setMinRep] = useState("70");
  const [hours, setHours] = useState("1");
  const [services, setServices] = useState<string[]>([]);
  const [token, setToken] = useState(() => {
    try {
      return localStorage.getItem("kohaku-admin") ?? "";
    } catch {
      return "";
    }
  });
  const [msg, setMsg] = useState<string | null>(null);
  const buyerId = buyer || orchestrator?.agentId || "";
  const buyerAgent = live.agents.find((a) => a.agentId === buyerId);
  const isOperator = !!(wallet.address && buyerAgent && isAddressEqual(buyerAgent.operator as Address, wallet.address));

  const signWithWallet = async () => {
    if (!cfg || !wallet.client || !wallet.address) return;
    try {
      setMsg("Waiting for your signature…");
      const now = BigInt(Math.floor(Date.now() / 1000));
      const intent = {
        operator: wallet.address,
        buyer: BigInt(buyerId),
        goal,
        budget: toUnits(budget),
        perJobCap: toUnits(cap),
        minSellerReputation: Math.round(Number(minRep) * 10),
        allowedServices: services,
        allowedSellers: [] as bigint[],
        notBefore: now - 60n,
        deadline: now + BigInt(Math.round(Number(hours) * 3600)),
        nonce: BigInt(Date.now()),
      };
      const signature = await wallet.client.signTypedData({ account: wallet.address, domain: cfg.domain, types: INTENT_TYPES, primaryType: "IntentMandate", message: intent });
      const view = await api<IntentView>("/v1/intents", {
        method: "POST",
        body: JSON.stringify({
          intent: { ...intent, buyer: intent.buyer.toString(), budget: intent.budget.toString(), perJobCap: intent.perJobCap.toString(), allowedSellers: [], notBefore: intent.notBefore.toString(), deadline: intent.deadline.toString(), nonce: intent.nonce.toString() },
          signature,
        }),
      });
      nav(`/intents/${view.id}`);
    } catch (e) {
      setMsg((e as Error).message.split("\n")[0]!);
    }
  };

  const signWithDemoOperator = async () => {
    try {
      setMsg("Asking the fleet operator to sign…");
      try {
        localStorage.setItem("kohaku-admin", token);
      } catch {
        // private mode
      }
      const r = await api<{ intent?: IntentView; message: string }>("/v1/scenario", {
        method: "POST",
        body: JSON.stringify({ action: "intent", token, goal, budget: Number(budget), perJobCap: Number(cap), minReputation: Math.round(Number(minRep) * 10), services, deadlineMinutes: Number(hours) * 60 }),
      });
      if (r.intent) nav(`/intents/${r.intent.id}`);
      else setMsg(r.message);
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  return (
    <main className="page">
      <div className="page-inner" style={{ maxWidth: 1000 }}>
        <div className="page-head">
          <div>
            <Badge>AP2 intent mandate</Badge>
            <h1 className="page-title">Give an agent a budget</h1>
            <p className="page-sub">
              You sign the goal, the budget, the deadline and the limits. The agent spends inside them and nothing else: any purchase that would break the mandate is refused before it happens, in
              public.
            </p>
          </div>
        </div>
        <Panel className="panel-glass">
          <div className="form-grid">
            <div className="field span-2">
              <label>Goal</label>
              <textarea className="textarea" value={goal} onChange={(e) => setGoal(e.target.value)} />
              <small>Mention Hindi to get a bilingual brief from the Orchestrator.</small>
            </div>
            <div className="field">
              <label>Buyer agent</label>
              <select className="select" value={buyerId} onChange={(e) => setBuyer(e.target.value)}>
                {live.agents.map((a) => (
                  <option key={a.agentId} value={a.agentId}>
                    {a.name} (#{a.agentId})
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Budget (USDC)</label>
              <input className="input" value={budget} onChange={(e) => setBudget(e.target.value)} />
            </div>
            <div className="field">
              <label>Per-job cap (USDC)</label>
              <input className="input" value={cap} onChange={(e) => setCap(e.target.value)} />
            </div>
            <div className="field">
              <label>Minimum seller reputation (0–100)</label>
              <input className="input" value={minRep} onChange={(e) => setMinRep(e.target.value)} />
            </div>
            <div className="field">
              <label>Valid for (hours)</label>
              <input className="input" value={hours} onChange={(e) => setHours(e.target.value)} />
            </div>
            <div className="field">
              <label>Allowed services (none selected = all)</label>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {SERVICES.map((s) => (
                  <button key={s} type="button" onClick={() => setServices((x) => (x.includes(s) ? x.filter((y) => y !== s) : [...x, s]))}>
                    <Pill tone={services.includes(s) ? "accent" : "muted"}>{s}</Pill>
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-end", marginTop: 24 }}>
            <div>
              {!wallet.address ? (
                <Btn onClick={wallet.connect}>Connect wallet to sign</Btn>
              ) : (
                <Btn onClick={signWithWallet} disabled={!isOperator}>
                  Sign with {short(wallet.address, 4)}
                </Btn>
              )}
              {wallet.address && !isOperator && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Only {buyerAgent?.name ?? "the agent"}'s operator can authorise its spending.</div>}
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input className="input" type="password" style={{ width: 150 }} placeholder="admin token" value={token} onChange={(e) => setToken(e.target.value)} />
              <Btn variant="secondary" onClick={signWithDemoOperator} disabled={!token}>
                Sign as the demo fleet operator
              </Btn>
            </div>
          </div>
          {msg && <div className="notice" style={{ marginTop: 16 }}>{msg}</div>}
        </Panel>
      </div>
    </main>
  );
}

interface BriefRecord {
  id: string;
  topic: string;
  status: string;
  steps: string[];
  jobs: number;
  spent: string;
  disputes: { jobId: string; seller: string; reason: string; upheld: boolean | null }[];
  result: { topic: string; summary: { en: string; hi?: string[] }; figure: string | null; claims: { claim: string; verdict: string; confidence: number; checkedBy: string; sources: string[] }[]; sources: { title: string; url: string }[]; engine: { search: string; translation: string | null } } | null;
}

export function IntentPage() {
  const { id } = useParams();
  const live = useLive();
  const { data, error } = useApi<{ intent: IntentView; jobs: JobView[]; refusals: { id: number; at: number; reason: string; amount: number | null; seller: number | null; service: string | null }[] }>(`/v1/intents/${id}`, 2_000);
  const [brief, setBrief] = useState<BriefRecord | null>(null);
  useEffect(() => {
    const load = () =>
      fleet<BriefRecord>(`/control/briefs/${id}`)
        .then(setBrief)
        .catch(() => undefined);
    void load();
    const t = setInterval(load, 2_500);
    return () => clearInterval(t);
  }, [id]);
  const bySeller = useMemo(() => {
    const m = new Map<string, { n: number; v: bigint }>();
    for (const j of data?.jobs ?? []) {
      const x = m.get(j.seller) ?? { n: 0, v: 0n };
      x.n++;
      x.v += BigInt(j.price);
      m.set(j.seller, x);
    }
    return [...m.entries()].sort((a, b) => b[1].n - a[1].n);
  }, [data?.jobs]);
  if (error) return <Missing what="intent" error={error} />;
  if (!data) return <Loading />;
  const i = data.intent;
  const spent = Number(i.spent) / Math.max(1, Number(i.budget));
  return (
    <main className="page">
      <div className="page-inner">
        <div className="crumbs">
          <Link to={`/agents/${i.buyer}`}>{agentName(live.agents, i.buyer)}</Link> / <span>intent {short(i.id, 6)}</span>
        </div>
        <div className="page-head">
          <div>
            <Badge>Intent · {i.status}</Badge>
            <h1 className="page-title" style={{ fontSize: 36, lineHeight: "44px" }}>
              “{i.goal}”
            </h1>
            <p className="page-sub">
              Signed by operator <span className="mono">{short(i.operator, 4)}</span> for {agentName(live.agents, i.buyer)}. Valid until {new Date(i.deadline * 1000).toLocaleTimeString()}. Minimum seller
              reputation {(i.minSellerReputation / 10).toFixed(1)}.
            </p>
          </div>
        </div>
        <div className="grid grid-4" style={{ marginBottom: 16 }}>
          <Stat label="Spent" value={usd(i.spent, 4)} hint={`of ${usd(i.budget)} budget`} accent />
          <Stat label="Paid jobs" value={i.jobs} />
          <Stat label="Refused by policy" value={i.refusals} />
          <Stat label="Per-job cap" value={usd(i.perJobCap, 4)} />
        </div>
        <div className="progress" style={{ marginBottom: 20 }}>
          <i style={{ width: `${Math.min(100, spent * 100)}%` }} />
        </div>
        <div className="grid grid-2" style={{ marginBottom: 16 }}>
          <Panel title="Where the budget went">
            {bySeller.map(([s, x]) => (
              <div key={s} className="agent-cell" style={{ padding: "6px 0" }}>
                <AgentGem id={s} size={22} />
                <span>{agentName(live.agents, s)}</span>
                <span className="muted" style={{ marginLeft: "auto" }}>
                  {x.n} jobs · {usd(x.v, 4)}
                </span>
              </div>
            ))}
            {!bySeller.length && <Empty>Waiting for the agent to start…</Empty>}
          </Panel>
          <Panel title="Progress">
            {brief ? (
              <div className="ticker">
                {brief.steps.map((s, k) => (
                  <div key={k}>{s}</div>
                ))}
              </div>
            ) : (
              <Empty>No brief attached to this intent.</Empty>
            )}
          </Panel>
        </div>
        {brief?.result && (
          <Panel className="panel-glass" title="The brief">
            <div className="brief">
              <h3>{brief.result.topic}</h3>
              <p>{brief.result.summary.en}</p>
              {brief.result.figure && <p className="dim">{brief.result.figure}</p>}
              {brief.result.summary.hi && (
                <>
                  <h3 style={{ marginTop: 18 }}>हिन्दी</h3>
                  {brief.result.summary.hi.map((p, k) => (
                    <p key={k} className="hi">
                      {p}
                    </p>
                  ))}
                  <p className="muted" style={{ fontSize: 12 }}>
                    Translation engine: {brief.result.engine.translation}
                  </p>
                </>
              )}
              <h3 style={{ marginTop: 18 }}>Checked claims</h3>
              {brief.result.claims.map((c, k) => (
                <div key={k} style={{ marginBottom: 8 }}>
                  <Pill tone={c.verdict === "supported" ? "good" : c.verdict === "contradicted" ? "warn" : "muted"}>{c.verdict}</Pill> {c.claim} <span className="muted">— {c.checkedBy}</span>
                </div>
              ))}
              <h3 style={{ marginTop: 18 }}>Sources</h3>
              {brief.result.sources.map((s) => (
                <div key={s.url}>
                  <a className="accent" href={s.url} target="_blank" rel="noreferrer">
                    {s.title}
                  </a>
                </div>
              ))}
            </div>
          </Panel>
        )}
        <div className="grid grid-2" style={{ marginTop: 16 }}>
          <Panel title={`Jobs (${data.jobs.length})`}>
            <div className="stream" style={{ maxHeight: 420 }}>
              {data.jobs.map((j) => (
                <Link key={j.id} to={`/jobs/${j.id}`} className="stream-item">
                  <AgentGem id={j.seller} size={20} />
                  <div className="who">
                    <b>{agentName(live.agents, j.seller)}</b> <span className="svc">{j.service}</span>
                  </div>
                  <span className="num dim">
                    {usd(j.price, 4)} · {ago(j.createdAt)}
                  </span>
                </Link>
              ))}
            </div>
          </Panel>
          <Panel title="Refusals">
            {data.refusals.map((r) => (
              <div key={r.id} style={{ padding: "8px 0", borderBottom: "1px solid var(--line-soft)", fontSize: 14 }}>
                <Pill tone="warn">refused</Pill> {r.service ?? "?"} {r.amount ? usd(r.amount, 4) : ""} <span className="dim">{r.reason}</span>
              </div>
            ))}
            {!data.refusals.length && <Empty>Nothing refused. Every purchase so far fits the mandate.</Empty>}
          </Panel>
        </div>
      </div>
    </main>
  );
}



import { Link, useSearchParams } from "react-router";
import type { DisputeView, JobView } from "@kohaku/core";
import { useApi, useLive, agentName } from "../lib/api.ts";
import { ago, usd, explorerTx } from "../lib/format.ts";
import { AgentGem, Empty, HashLink, PageHead, Panel, Pill, Stat, Stats } from "../components/ui.tsx";

const TABS = ["all", "open", "upheld", "rejected"] as const;
type Tab = (typeof TABS)[number];

export default function Disputes() {
  const live = useLive();
  const [params, setParams] = useSearchParams();
  const tab: Tab = (TABS as readonly string[]).includes(params.get("status") ?? "") ? (params.get("status") as Tab) : "all";
  const setTab = (t: Tab) => setParams(t === "all" ? {} : { status: t }, { replace: true });
  const { data } = useApi<(DisputeView & { job: JobView })[]>(`/v1/disputes?limit=200${tab === "all" ? "" : `&status=${tab}`}`, 4_000);
  const all = useApi<(DisputeView & { job: JobView })[]>(`/v1/disputes?limit=500`, 8_000).data ?? [];
  const explorer = live.stats?.chain.explorer;
  const list = data ?? [];
  return (
    <main className="page">
      <div className="page-inner">
        <PageHead
          title="Disputes"
          sub="A buyer can challenge a delivered job inside its window. A staked validator re-checks the work against the job’s own spec. Upheld: the IOU is voided before netting and the seller loses reputation. Rejected: the IOU stands and the buyer is marked."
        />
        <Stats>
          <Stat label="Disputes filed" value={all.length} />
          <Stat label="Open" value={all.filter((d) => d.status === "open").length} />
          <Stat label="Upheld" value={all.filter((d) => d.status === "upheld").length} accent />
          <Stat label="Rejected" value={all.filter((d) => d.status === "rejected").length} />
        </Stats>
        <div className="toolbar">
          <div className="tabs" role="group" aria-label="Filter by status">
            {TABS.map((t) => (
              <button key={t} type="button" className={tab === t ? "on" : ""} aria-pressed={tab === t} onClick={() => setTab(t)}>
                {t}
              </button>
            ))}
          </div>
          <span className="toolbar-count">{data ? `${list.length} shown` : "Loading…"}</span>
        </div>
        <div className="stack">
          {list.map((d) => (
            <Panel key={d.id}>
              <div className="dispute-card">
                <AgentGem id={d.seller} size={40} />
                <div style={{ minWidth: 0 }}>
                  <div className="dispute-line">
                    <Pill tone={d.status === "upheld" ? "warn" : d.status === "open" ? "accent" : "muted"}>{d.status}</Pill>
                    <b>{agentName(live.agents, d.buyer)}</b> <span className="dim">disputed</span> <b>{agentName(live.agents, d.seller)}</b>
                    <span className="muted">
                      · {d.job.service} · <span className="mono">{usd(d.job.price, 4)}</span> · epoch {d.epoch} · {ago(d.filedAt)}
                    </span>
                  </div>
                  <p className="dispute-quote">
                    <span className="muted">Buyer’s reason: </span>“{d.reason}”
                  </p>
                  <p className="dim" style={{ marginTop: 6 }}>
                    <span className="muted">Validator {agentName(live.agents, d.validator)}: </span>
                    {d.reasoning ?? "re-checking the work…"}
                  </p>
                  <div className="dispute-links">
                    <Link to={`/jobs/${d.jobId}`} className="accent">
                      Full evidence chain
                    </Link>
                    <span>
                      ERC-8004 request <HashLink hash={d.onchainRequestTx} href={explorerTx(explorer, d.onchainRequestTx)} n={4} />
                    </span>
                    <span>
                      Signed verdict <HashLink hash={d.verdictSignature} n={4} />
                    </span>
                  </div>
                </div>
              </div>
            </Panel>
          ))}
        </div>
        {data && !list.length && <Empty>No disputes {tab !== "all" ? `with status “${tab}”` : "yet"}. Rogue will get caught eventually.</Empty>}
      </div>
    </main>
  );
}

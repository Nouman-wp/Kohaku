import { useState } from "react";
import { Link } from "react-router";
import type { DisputeView, JobView } from "@kohaku/core";
import { useApi, useLive, agentName } from "../lib/api.ts";
import { ago, usd, explorerTx } from "../lib/format.ts";
import { AgentGem, Badge, Empty, HashLink, Panel, Pill, Stat } from "../components/ui.tsx";

export default function Disputes() {
  const live = useLive();
  const [tab, setTab] = useState<"all" | "open" | "upheld" | "rejected">("all");
  const { data } = useApi<(DisputeView & { job: JobView })[]>(`/v1/disputes?limit=200${tab === "all" ? "" : `&status=${tab}`}`, 4_000);
  const all = useApi<(DisputeView & { job: JobView })[]>(`/v1/disputes?limit=500`, 8_000).data ?? [];
  const explorer = live.stats?.chain.explorer;
  const list = data ?? [];
  return (
    <main className="page">
      <div className="page-inner">
        <div className="page-head">
          <div>
            <Badge>Disputes</Badge>
            <h1 className="page-title">Recourse for bad work</h1>
            <p className="page-sub">
              A buyer can challenge a delivered job inside its window. A staked validator re-checks the work against the job's own spec. Upheld: the IOU is voided before netting and the seller
              loses reputation. Rejected: the IOU stands and the buyer is marked.
            </p>
          </div>
        </div>
        <div className="grid grid-4" style={{ marginBottom: 16 }}>
          <Stat label="Disputes filed" value={all.length} />
          <Stat label="Open" value={all.filter((d) => d.status === "open").length} />
          <Stat label="Upheld" value={all.filter((d) => d.status === "upheld").length} accent />
          <Stat label="Rejected" value={all.filter((d) => d.status === "rejected").length} />
        </div>
        <div className="toolbar">
          <div className="tabs">
            {(["all", "open", "upheld", "rejected"] as const).map((t) => (
              <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
                {t}
              </button>
            ))}
          </div>
        </div>
        <div className="grid" style={{ gap: 12 }}>
          {list.map((d) => (
            <Panel key={d.id}>
              <div style={{ display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap" }}>
                <AgentGem id={d.seller} size={40} />
                <div style={{ flex: 1, minWidth: 260 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <Pill tone={d.status === "upheld" ? "warn" : d.status === "open" ? "accent" : "muted"}>{d.status}</Pill>
                    <b>{agentName(live.agents, d.buyer)}</b> <span className="dim">disputed</span> <b>{agentName(live.agents, d.seller)}</b>
                    <span className="muted">
                      · {d.job.service} · {usd(d.job.price, 4)} · epoch {d.epoch} · {ago(d.filedAt)}
                    </span>
                  </div>
                  <div style={{ marginTop: 8 }}>
                    <span className="muted">Buyer's reason: </span>“{d.reason}”
                  </div>
                  <div style={{ marginTop: 6 }} className="dim">
                    <span className="muted">Validator {agentName(live.agents, d.validator)}: </span>
                    {d.reasoning ?? "re-checking the work…"}
                  </div>
                  <div className="muted" style={{ fontSize: 12, marginTop: 8, display: "flex", gap: 14, flexWrap: "wrap" }}>
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
        {!list.length && <Empty>No disputes {tab !== "all" ? `with status ${tab}` : "yet"}.</Empty>}
      </div>
    </main>
  );
}

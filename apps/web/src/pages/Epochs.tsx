import { Link, useNavigate, useParams } from "react-router";
import type { DisputeView, EpochView, IouView, PayoutView, PositionView, SettlementView } from "@kohaku/core";
import { API, useApi, useLive, agentName } from "../lib/api.ts";
import { ago, pct, short, signedUsd, usd, explorerTx, explorerAddr } from "../lib/format.ts";
import { AgentGem, Badge, Btn, Empty, HashLink, Panel, Pill, Stat } from "../components/ui.tsx";

const phaseTone = (p: string) => (p === "sealed" ? "good" : p === "failed" ? "warn" : p === "intake" ? "muted" : "accent");

export function EpochList() {
  const live = useLive();
  const { data } = useApi<EpochView[]>("/v1/epochs?limit=100", 5_000);
  const nav = useNavigate();
  const epochs = data ?? [];
  const sealed = epochs.filter((e) => e.phase === "sealed");
  const ious = sealed.reduce((a, e) => a + e.iouCount, 0);
  const transfers = sealed.reduce((a, e) => a + e.settlementTransfers, 0);
  return (
    <main className="page">
      <div className="page-inner">
        <div className="page-head">
          <div>
            <Badge>Epochs</Badge>
            <h1 className="page-title">Every epoch, sealed in amber</h1>
            <p className="page-sub">Each row is one clearing cycle: the IOUs it collected, how far netting compressed them, and whether every debtor has settled through HSP.</p>
          </div>
        </div>
        <div className="grid grid-4" style={{ marginBottom: 16 }}>
          <Stat label="Epochs sealed" value={sealed.length} />
          <Stat label="IOUs cleared" value={ious.toLocaleString()} />
          <Stat label="Settlement transfers" value={transfers.toLocaleString()} />
          <Stat label="Payments avoided" value={ious ? pct(Math.max(0, ious - transfers) / ious) : "—"} accent />
        </div>
        <Panel>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Epoch</th>
                  <th>Phase</th>
                  <th className="num">IOUs</th>
                  <th className="num">Gross</th>
                  <th className="num">Transfers</th>
                  <th className="num">Net</th>
                  <th className="num">Saved</th>
                  <th>Disputes</th>
                  <th>On chain</th>
                  <th>Receipt</th>
                </tr>
              </thead>
              <tbody>
                {epochs.map((e) => (
                  <tr key={e.id} className="row-link" onClick={() => nav(`/epochs/${e.id}`)}>
                    <td>
                      <b>{e.id}</b>
                    </td>
                    <td>
                      <Pill tone={phaseTone(e.phase)}>{e.phase}</Pill>
                    </td>
                    <td className="num">{e.iouCount}</td>
                    <td className="num">{usd(e.grossVolume, 4)}</td>
                    <td className="num">{e.settlementTransfers}</td>
                    <td className="num">{usd(e.netVolume, 4)}</td>
                    <td className="num">{e.iouCount ? pct(e.transferReduction) : "—"}</td>
                    <td>{e.disputesUpheld ? <Pill tone="warn">{e.disputesUpheld} upheld</Pill> : <span className="muted">—</span>}</td>
                    <td>
                      <span className="dim">{e.onchain}</span>
                      {e.error && <span className="muted"> · retrying</span>}
                    </td>
                    <td>
                      <span className="mono dim">{short(e.receiptHash, 5)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!epochs.length && <Empty>{live.connected ? "No epochs yet." : "Connecting to the clearing service…"}</Empty>}
          </div>
        </Panel>
      </div>
    </main>
  );
}

interface EpochDetail {
  epoch: EpochView;
  ious: IouView[];
  positions: PositionView[];
  settlements: SettlementView[];
  payouts: PayoutView[];
  disputes: DisputeView[];
  txs: { hash: string; kind: string; gas_used: number | null; at: number }[];
  explorer: string | null;
}

export function EpochPage() {
  const { id } = useParams();
  const live = useLive();
  const { data, error } = useApi<EpochDetail>(`/v1/epochs/${id}`, 4_000);
  if (error) return <Missing what={`epoch ${id}`} error={error} />;
  if (!data) return <Loading />;
  const { epoch: e, explorer } = data;
  const agents = live.agents;
  return (
    <main className="page">
      <div className="page-inner">
        <div className="crumbs">
          <Link to="/epochs">Epochs</Link> / <span>{e.id}</span>
        </div>
        <div className="page-head">
          <div>
            <Badge>{e.phase === "sealed" ? "Sealed" : e.phase}</Badge>
            <h1 className="page-title">Epoch {e.id}</h1>
            <p className="page-sub">
              Opened {ago(e.startsAt)}. {e.iouCount} IOUs netted into {e.settlementTransfers} transfers. {e.error ? `Last error: ${e.error}` : ""}
            </p>
          </div>
          <div className="control-bar">
            <Btn to={`/verify?epoch=${e.id}`}>Verify independently</Btn>
            <Btn href={`${API}/v1/epochs/${e.id}/export.csv`} variant="secondary">
              Audit export (CSV)
            </Btn>
          </div>
        </div>

        <div className="grid grid-5" style={{ marginBottom: 16 }}>
          <Stat label="IOUs" value={e.iouCount} hint={`${e.carried} carried in · ${e.heldOut} held out`} />
          <Stat label="Gross obligations" value={usd(e.grossVolume, 4)} />
          <Stat label="Net settled" value={usd(e.netVolume, 4)} hint={`${pct(e.volumeReduction)} of value never moved`} />
          <Stat label="Transfers" value={`${e.settlementTransfers}`} hint={`${e.debtors} pay-ins · ${e.creditors} payouts`} />
          <Stat label="Payments avoided" value={e.iouCount ? pct(e.transferReduction) : "—"} hint={`${e.transfersAvoided} fewer`} accent />
        </div>

        <div className="grid grid-2" style={{ marginBottom: 16 }}>
          <Panel title="On-chain record">
            <dl className="kv">
              <dt>Status</dt>
              <dd>
                <Pill tone={phaseTone(e.phase)}>{e.phase}</Pill> <span className="muted">chain: {e.onchain}</span>
              </dd>
              <dt>IOU-set commitment</dt>
              <dd>
                <HashLink hash={e.iouSetHash} n={10} />
              </dd>
              <dt>Positions commitment</dt>
              <dd>
                <HashLink hash={e.positionsHash} n={10} />
              </dd>
              <dt>Sealed receipt</dt>
              <dd>
                <HashLink hash={e.receiptHash} n={10} />
              </dd>
              <dt>Finalised in</dt>
              <dd>
                <HashLink hash={e.finalizeTx} href={explorerTx(explorer, e.finalizeTx)} />
              </dd>
              <dt>Payout in</dt>
              <dd>
                <HashLink hash={e.payoutTx} href={explorerTx(explorer, e.payoutTx)} />
              </dd>
              <dt>Settle deadline</dt>
              <dd>{e.settleDeadline ? new Date(e.settleDeadline).toLocaleTimeString() : "—"}</dd>
            </dl>
            {data.txs.length > 0 && (
              <>
                <div className="muted" style={{ fontSize: 13, margin: "14px 0 6px" }}>
                  Transactions
                </div>
                {data.txs.map((t) => (
                  <div key={t.hash} className="dim" style={{ fontSize: 13, display: "flex", gap: 8 }}>
                    <span style={{ minWidth: 100 }}>{t.kind}</span>
                    <HashLink hash={t.hash} href={explorerTx(explorer, t.hash)} n={6} />
                    <span className="muted">{t.gas_used?.toLocaleString()} gas</span>
                  </div>
                ))}
              </>
            )}
          </Panel>
          <Panel title="Net positions and settlement">
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th className="num">Sold</th>
                    <th className="num">Bought</th>
                    <th className="num">Net</th>
                    <th>Settlement</th>
                  </tr>
                </thead>
                <tbody>
                  {data.positions.map((p) => {
                    const s = data.settlements.find((x) => x.agentId === p.agentId);
                    const pay = data.payouts.find((x) => x.agentId === p.agentId);
                    return (
                      <tr key={p.agentId}>
                        <td>
                          <Link to={`/agents/${p.agentId}`} className="agent-cell">
                            <AgentGem id={p.agentId} size={22} />
                            <b>{agentName(agents, p.agentId)}</b>
                          </Link>
                        </td>
                        <td className="num">{usd(p.credit, 4)}</td>
                        <td className="num">{usd(p.debit, 4)}</td>
                        <td className="num">
                          <b>{signedUsd(p.net)}</b>
                        </td>
                        <td>
                          {s ? (
                            <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                              <Pill tone={s.status === "recorded" ? "good" : s.status === "defaulted" ? "warn" : "accent"}>
                                {s.status === "recorded" ? "paid via HSP" : s.status.replace("_", " ")}
                              </Pill>
                              <HashLink hash={s.settlementTx} href={explorerTx(explorer, s.settlementTx)} n={4} />
                            </span>
                          ) : pay ? (
                            <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                              <Pill tone="good">paid out</Pill>
                              <HashLink hash={pay.to} href={explorerAddr(explorer, pay.to)} n={4} />
                            </span>
                          ) : (
                            <span className="muted">{p.state}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {!data.positions.length && <Empty>Not netted yet.</Empty>}
            </div>
          </Panel>
        </div>

        {data.settlements.length > 0 && (
          <Panel title="HSP settlements" className="panel-glass">
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Debtor</th>
                    <th className="num">Amount</th>
                    <th>Mode</th>
                    <th>HSP order</th>
                    <th>HSP outcome</th>
                    <th>Wallet → pool transfer</th>
                    <th>Receipt</th>
                    <th>Recorded on chain</th>
                  </tr>
                </thead>
                <tbody>
                  {data.settlements.map((s) => (
                    <tr key={s.id}>
                      <td>{agentName(agents, s.agentId)}</td>
                      <td className="num">{usd(s.amount, 4)}</td>
                      <td>
                        <Pill tone="muted">{s.hspMode === "local" ? "local gateway" : "HashKey Merchant"}</Pill>
                      </td>
                      <td>
                        <HashLink hash={s.hspCartMandateId} href={s.hspPaymentUrl} n={8} />
                      </td>
                      <td>{s.hspStatus ? `${s.hspStatus} / ${s.hspOutcome}` : <span className="muted">{s.status}</span>}</td>
                      <td>
                        <HashLink hash={s.settlementTx} href={explorerTx(explorer, s.settlementTx)} n={5} />
                      </td>
                      <td>
                        <HashLink hash={s.receiptHash} n={5} />
                      </td>
                      <td>
                        <HashLink hash={s.recordTx} href={explorerTx(explorer, s.recordTx)} n={5} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        )}

        <Panel title={`Signed IOUs (${data.ious.length})`} className="" actions={<span className="muted" style={{ fontSize: 13 }}>Every row links to its full evidence chain</span>}>
          <div className="table-wrap" style={{ maxHeight: 560, overflow: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Digest</th>
                  <th>Buyer</th>
                  <th>Seller</th>
                  <th className="num">Amount</th>
                  <th>Nonce</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.ious.map((i) => (
                  <tr key={i.digest}>
                    <td>
                      <Link to={`/jobs/${i.jobId}`} className="hash-link">
                        <span className="mono">{short(i.digest, 6)}</span>
                      </Link>
                    </td>
                    <td>{agentName(agents, i.buyer)}</td>
                    <td>{agentName(agents, i.seller)}</td>
                    <td className="num">{usd(i.amount, 4)}</td>
                    <td className="mono muted">{i.nonce.slice(-6)}</td>
                    <td>
                      <Pill tone={i.status === "netted" ? "good" : i.status === "voided" ? "warn" : "muted"}>{i.status.replace("_", " ")}</Pill>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
    </main>
  );
}

export function Loading() {
  return (
    <main className="page">
      <div className="page-inner">
        <Empty>Loading…</Empty>
      </div>
    </main>
  );
}

export function Missing({ what, error }: { what: string; error: string }) {
  return (
    <main className="page">
      <div className="page-inner">
        <Empty>
          Could not load {what}: {error}
        </Empty>
      </div>
    </main>
  );
}

import { useEffect, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { isAddressEqual, recoverTypedDataAddress, type Address, type Hex } from "viem";
import {
  DELIVERY_TYPES,
  IOU_TYPES,
  QUOTE_TYPES,
  hashJson,
  iouDigest,
  jobHash,
  quoteDigest,
  type DisputeView,
  type EpochView,
  type JobSpec,
  type JobView,
  type PayoutView,
  type PositionView,
  type SettlementView,
} from "@kohaku/core";
import { useApi, useLive, agentName } from "../lib/api.ts";
import { signedUsd, usd, explorerTx, explorerAddr } from "../lib/format.ts";
import { AgentGem, Badge, HashLink, Panel, Pill } from "../components/ui.tsx";
import { IconCheck, IconX } from "../components/icons.tsx";
import { Loading, Missing } from "./Epochs.tsx";

interface Party {
  agentId: string;
  name: string;
  signer: Address;
  operator: Address;
  role: string;
}

interface JobEvidence {
  job: JobView;
  spec: JobSpec;
  quote: { message: Record<string, string>; signature: Hex; hash: Hex };
  iou: (Record<string, string> & { digest: Hex; signature: Hex; status: string; postedEpoch: number | null; amount: string; nonce: string; epoch: number }) | null;
  delivery: { deliveredAt: number; resultHash: Hex; signature: Hex; challengeEndsAt: number; message: Record<string, string> | null } | null;
  dispute: DisputeView | null;
  epoch: EpochView | null;
  positions: { buyer: PositionView | null; seller: PositionView | null };
  buyerSettlement: (SettlementView & { receipt: unknown }) | null;
  sellerPayout: PayoutView | null;
  parties: { buyer: Party | null; seller: Party | null };
  parent: JobView | null;
  children: JobView[];
  verify: { domain: { name: string; version: string; chainId: number; verifyingContract: Address }; explorer: string | null; clearingHouse: Address };
}

type Checks = Record<string, boolean | null>;

export default function JobPage() {
  const { id } = useParams();
  const live = useLive();
  const { data, error } = useApi<JobEvidence>(`/v1/jobs/${id}`, 4_000);
  const [checks, setChecks] = useState<Checks>({});

  useEffect(() => {
    if (!data) return;
    void verifyAll(data).then(setChecks);
  }, [data?.job.id, data?.job.status, data?.delivery?.signature]);

  if (error) return <Missing what={`job ${id}`} error={error} />;
  if (!data) return <Loading />;
  const { job, verify } = data;
  const explorer = verify.explorer;
  const buyer = data.parties.buyer;
  const seller = data.parties.seller;

  return (
    <main className="page">
      <div className="page-inner">
        <div className="crumbs">
          <Link to="/floor">Floor</Link> / <Link to={`/epochs/${job.epoch}`}>Epoch {job.epoch}</Link> / <span>{job.id}</span>
        </div>
        <div className="page-head">
          <div>
            <Badge>Chain of evidence</Badge>
            <h1 className="page-title">
              {buyer?.name ?? `#${job.buyer}`} bought {job.service} from {seller?.name ?? `#${job.seller}`}
            </h1>
            <p className="page-sub">
              {usd(job.price, 4)} · epoch {job.epoch} · <Pill tone={job.status === "settled" ? "good" : job.status === "voided" ? "warn" : "accent"}>{job.status}</Pill>. Every signature below is
              re-verified in your browser against the parties' registered keys.
            </p>
          </div>
        </div>

        <div className="chain">
          <Link_ n="1" title="Job" ok={checks.jobHash}>
            <Check ok={checks.jobHash}>job hash recomputed from the spec</Check>
            <dl className="kv" style={{ marginTop: 10 }}>
              <dt>Job hash</dt>
              <dd>
                <HashLink hash={job.jobHash} n={10} />
              </dd>
              <dt>Input</dt>
              <dd className="dim">{typeof data.spec.input === "string" ? data.spec.input : JSON.stringify(data.spec.input).slice(0, 300)}</dd>
              {data.parent && (
                <>
                  <dt>Part of</dt>
                  <dd>
                    <Link to={`/jobs/${data.parent.id}`} className="accent">
                      {agentName(live.agents, data.parent.buyer)} → {agentName(live.agents, data.parent.seller)} · {data.parent.service}
                    </Link>
                  </dd>
                </>
              )}
            </dl>
          </Link_>

          <Link_ n="2" title={<>Quote signed by {seller?.name}</>} ok={checks.quoteSig}>
            <Check ok={checks.quoteSig}>signature recovers to the seller's wallet {seller && <HashLink hash={seller.signer} href={explorerAddr(explorer, seller.signer)} n={4} />}</Check>
            <Check ok={checks.quoteHash}>quote hash matches the IOU's quote reference</Check>
            <dl className="kv" style={{ marginTop: 10 }}>
              <dt>Price</dt>
              <dd>{usd(data.quote.message.price ?? "0", 4)} (binding: the quote wins over later price changes)</dd>
              <dt>Expiry</dt>
              <dd>{new Date(Number(data.quote.message.expiry) * 1000).toLocaleTimeString()}</dd>
              <dt>Signature</dt>
              <dd>
                <HashLink hash={data.quote.signature} n={10} />
              </dd>
            </dl>
          </Link_>

          <Link_ n="3" title={<>IOU signed by {buyer?.name}</>} ok={checks.iouSig}>
            {data.iou ? (
              <>
                <Check ok={checks.iouSig}>EIP-712 signature recovers to the buyer's wallet {buyer && <HashLink hash={buyer.signer} href={explorerAddr(explorer, buyer.signer)} n={4} />}</Check>
                <Check ok={checks.iouDigest}>digest recomputed under the clearing house domain (chain {verify.domain.chainId})</Check>
                <dl className="kv" style={{ marginTop: 10 }}>
                  <dt>IOU digest</dt>
                  <dd>
                    <HashLink hash={data.iou.digest} n={10} />
                  </dd>
                  <dt>Epoch / nonce</dt>
                  <dd>
                    {data.iou.epoch} / <span className="mono">{data.iou.nonce}</span>
                  </dd>
                  <dt>Status</dt>
                  <dd>
                    <Pill>{data.iou.status}</Pill> {data.iou.postedEpoch && data.iou.postedEpoch !== data.iou.epoch ? <span className="muted">carried into epoch {data.iou.postedEpoch}</span> : null}
                  </dd>
                </dl>
              </>
            ) : (
              <span className="muted">No IOU.</span>
            )}
          </Link_>

          <Link_ n="4" title="Delivery" ok={data.delivery ? checks.deliverySig : null}>
            {data.delivery ? (
              <>
                <Check ok={checks.deliverySig}>delivery signed by the seller</Check>
                <Check ok={checks.resultHash}>result matches the signed result hash</Check>
                <dl className="kv" style={{ marginTop: 10 }}>
                  <dt>Delivered</dt>
                  <dd>{new Date(data.delivery.deliveredAt).toLocaleTimeString()}</dd>
                  <dt>Challenge window</dt>
                  <dd>until {new Date(data.delivery.challengeEndsAt).toLocaleTimeString()}</dd>
                </dl>
                <pre className="json">{JSON.stringify(job.result, null, 2)?.slice(0, 4000)}</pre>
              </>
            ) : (
              <span className="muted">Not delivered. Undelivered jobs are voided when the epoch closes, so the buyer never pays for them.</span>
            )}
          </Link_>

          <Link_ n="5" title="Dispute" ok={data.dispute ? data.dispute.status !== "upheld" : null}>
            {data.dispute ? (
              <>
                <div style={{ marginBottom: 8 }}>
                  <Pill tone={data.dispute.status === "upheld" ? "warn" : "accent"}>{data.dispute.status}</Pill> filed by {agentName(live.agents, data.dispute.buyer)}: “{data.dispute.reason}”
                </div>
                <div className="dim">
                  Validator {agentName(live.agents, data.dispute.validator)}: {data.dispute.reasoning ?? "deciding…"}
                </div>
                <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>
                  {data.dispute.status === "upheld" ? "The IOU was voided before netting and the seller's reputation dropped." : data.dispute.status === "rejected" ? "The IOU stands; the buyer is marked for a frivolous dispute." : ""}{" "}
                  ERC-8004 validation request <HashLink hash={data.dispute.onchainRequestTx} href={explorerTx(explorer, data.dispute.onchainRequestTx)} n={4} />
                </div>
              </>
            ) : (
              <span className="muted">No dispute was filed during the challenge window.</span>
            )}
          </Link_>

          <Link_ n="6" title={<>Netted in epoch {data.iou?.postedEpoch ?? "—"}</>} ok={data.positions.buyer ? true : null}>
            {data.epoch && data.positions.buyer ? (
              <dl className="kv">
                <dt>Epoch</dt>
                <dd>
                  <Link to={`/epochs/${data.epoch.id}`} className="accent">
                    {data.epoch.id}
                  </Link>{" "}
                  · {data.epoch.iouCount} IOUs → {data.epoch.settlementTransfers} transfers
                </dd>
                <dt>{buyer?.name} net</dt>
                <dd>{signedUsd(data.positions.buyer.net)}</dd>
                <dt>{seller?.name} net</dt>
                <dd>{data.positions.seller ? signedUsd(data.positions.seller.net) : "—"}</dd>
                <dt>Positions commitment</dt>
                <dd>
                  <HashLink hash={data.epoch.positionsHash} n={8} />
                </dd>
              </dl>
            ) : (
              <span className="muted">Waiting for the epoch to close.</span>
            )}
          </Link_>

          <Link_ n="7" title="Paid through HSP" ok={data.buyerSettlement ? data.buyerSettlement.status === "recorded" : null}>
            {data.buyerSettlement ? (
              <dl className="kv">
                <dt>Debtor</dt>
                <dd>
                  {agentName(live.agents, data.buyerSettlement.agentId)} paid its net {usd(data.buyerSettlement.amount, 4)} for the whole epoch
                </dd>
                <dt>HSP order</dt>
                <dd>
                  <HashLink hash={data.buyerSettlement.hspCartMandateId} href={data.buyerSettlement.hspPaymentUrl} n={12} />
                </dd>
                <dt>Outcome</dt>
                <dd>
                  {data.buyerSettlement.hspStatus ?? "—"} / {data.buyerSettlement.hspOutcome ?? data.buyerSettlement.status} <span className="muted">({data.buyerSettlement.hspMode === "local" ? "HSP local gateway" : "HashKey Merchant"})</span>
                </dd>
                <dt>Wallet → pool transfer</dt>
                <dd>
                  <HashLink hash={data.buyerSettlement.settlementTx} href={explorerTx(explorer, data.buyerSettlement.settlementTx)} n={8} />
                </dd>
                <dt>HSP receipt</dt>
                <dd>
                  <HashLink hash={data.buyerSettlement.receiptHash} n={8} />
                </dd>
                <dt>Recorded on chain</dt>
                <dd>
                  <HashLink hash={data.buyerSettlement.recordTx} href={explorerTx(explorer, data.buyerSettlement.recordTx)} n={8} />
                </dd>
              </dl>
            ) : data.positions.buyer && BigInt(data.positions.buyer.net) >= 0n ? (
              <span className="muted">The buyer ended the epoch as a net creditor, so this job was paid for entirely by netting. No transfer was needed.</span>
            ) : (
              <span className="muted">Not settled yet.</span>
            )}
          </Link_>

          <Link_ n="8" title={<>{seller?.name} paid out</>} ok={data.sellerPayout ? true : null}>
            {data.sellerPayout ? (
              <dl className="kv">
                <dt>Payout</dt>
                <dd>
                  {usd(data.sellerPayout.amount, 4)} to <HashLink hash={data.sellerPayout.to} href={explorerAddr(explorer, data.sellerPayout.to)} n={6} />
                </dd>
                <dt>Transaction</dt>
                <dd>
                  <HashLink hash={data.sellerPayout.tx} href={explorerTx(explorer, data.sellerPayout.tx)} n={8} />
                </dd>
                <dt>Epoch receipt</dt>
                <dd>
                  <HashLink hash={data.epoch?.receiptHash} n={8} />
                </dd>
              </dl>
            ) : data.positions.seller && BigInt(data.positions.seller.net) <= 0n ? (
              <span className="muted">The seller ended the epoch as a net debtor, so this sale reduced what it had to pay.</span>
            ) : (
              <span className="muted">Not paid out yet.</span>
            )}
          </Link_>
        </div>

        {data.children.length > 0 && (
          <Panel title={`Sub-jobs this job paid for (${data.children.length})`} className="" >
            {data.children.map((c) => (
              <Link key={c.id} to={`/jobs/${c.id}`} className="stream-item">
                <AgentGem id={c.seller} size={20} />
                <div className="who">
                  {agentName(live.agents, c.buyer)} → <b>{agentName(live.agents, c.seller)}</b> <span className="svc">{c.service}</span>
                </div>
                <span className="num dim">{usd(c.price, 4)}</span>
              </Link>
            ))}
          </Panel>
        )}
      </div>
    </main>
  );
}

function Link_({ n, title, ok, children }: { n: string; title: ReactNode; ok: boolean | null | undefined; children: ReactNode }) {
  return (
    <div className="link">
      <div className={`link-dot ${ok === null || ok === undefined ? "off" : ""}`}>{ok === false ? <IconX /> : ok ? <IconCheck /> : n}</div>
      <Panel>
        <div className="link-title">{title}</div>
        {children}
      </Panel>
    </div>
  );
}

function Check({ ok, children }: { ok: boolean | null | undefined; children: ReactNode }) {
  if (ok === undefined || ok === null) return <div className="check" style={{ color: "var(--text-3)" }}>… {children}</div>;
  return (
    <div className={`check ${ok ? "" : "bad"}`}>
      {ok ? <IconCheck size={14} /> : <IconX size={14} />} {children}
    </div>
  );
}

async function verifyAll(d: JobEvidence): Promise<Checks> {
  const domain = d.verify.domain;
  const out: Checks = {};
  try {
    out.jobHash = jobHash(d.spec) === d.job.jobHash;
  } catch {
    out.jobHash = false;
  }
  try {
    const q = d.quote.message;
    const quote = {
      seller: BigInt(q.seller!),
      buyer: BigInt(q.buyer!),
      service: q.service!,
      price: BigInt(q.price!),
      token: q.token as Address,
      jobHash: q.jobHash as Hex,
      expiry: BigInt(q.expiry!),
      quoteNonce: BigInt(q.quoteNonce!),
    };
    const s = await recoverTypedDataAddress({ domain, types: QUOTE_TYPES, primaryType: "Quote", message: quote, signature: d.quote.signature });
    out.quoteSig = !!d.parties.seller && isAddressEqual(s, d.parties.seller.signer);
    out.quoteHash = quoteDigest(domain, quote) === d.quote.hash && (!d.iou || d.iou.quoteHash === d.quote.hash);
  } catch {
    out.quoteSig = false;
  }
  if (d.iou) {
    try {
      const i = d.iou;
      const iou = {
        buyer: BigInt(i.buyer!),
        seller: BigInt(i.seller!),
        amount: BigInt(i.amount),
        token: i.token as Address,
        jobHash: i.jobHash as Hex,
        quoteHash: i.quoteHash as Hex,
        epoch: BigInt(i.epoch),
        nonce: BigInt(i.nonce),
      };
      out.iouDigest = iouDigest(domain, iou) === i.digest;
      const s = await recoverTypedDataAddress({ domain, types: IOU_TYPES, primaryType: "IOU", message: iou, signature: i.signature });
      out.iouSig = !!d.parties.buyer && isAddressEqual(s, d.parties.buyer.signer);
    } catch {
      out.iouSig = false;
    }
  }
  if (d.delivery?.message) {
    try {
      const m = d.delivery.message;
      const delivery = { seller: BigInt(m.seller!), jobHash: m.jobHash as Hex, iouDigest: m.iouDigest as Hex, resultHash: m.resultHash as Hex, deliveredAt: BigInt(m.deliveredAt!) };
      const s = await recoverTypedDataAddress({ domain, types: DELIVERY_TYPES, primaryType: "Delivery", message: delivery, signature: d.delivery.signature });
      out.deliverySig = !!d.parties.seller && isAddressEqual(s, d.parties.seller.signer);
      out.resultHash = d.job.result === null || (d.job.result as { truncated?: boolean })?.truncated ? null : hashJson(d.job.result) === delivery.resultHash;
    } catch {
      out.deliverySig = false;
    }
  }
  return out;
}

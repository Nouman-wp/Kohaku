import { useEffect, useState } from "react";
import { useSearchParams, Link } from "react-router";
import { createPublicClient, http, isAddressEqual, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { IOU_TYPES, iouDigest, net } from "@kohaku/core";
import { clearingHouseAbi, identityRegistryAbi } from "@kohaku/core/abis";
import { API, api, useLive } from "../lib/api.ts";
import { pct, usd } from "../lib/format.ts";
import { Btn, PageHead, Panel, Pill } from "../components/ui.tsx";
import { IconCheck, IconX } from "../components/icons.tsx";

interface Config {
  chain: { id: number; name: string; rpc: string; explorer: string | null };
  deployment: { clearingHouse: Address; identityRegistry: Address };
  domain: { name: string; version: string; chainId: number; verifyingContract: Address };
}

interface Row {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * Independent verification in the browser. The IOU set comes from the clearing service
 * (it is public data), but every commitment it is checked against is read directly from
 * the chain over RPC, and every signature is recovered locally. The clearing service's
 * own claims are never trusted.
 */
export default function Verify() {
  const [params, setParams] = useSearchParams();
  const live = useLive();
  const [epoch, setEpoch] = useState(params.get("epoch") ?? "");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [rpc, setRpc] = useState<string>("");

  useEffect(() => {
    api<Config>("/v1/config")
      .then((c) => setRpc(c.chain.rpc))
      .catch(() => undefined);
  }, []);

  const run = async (id: string) => {
    if (!id) return;
    setRunning(true);
    setRows(null);
    setSummary(null);
    setParams({ epoch: id });
    const out: Row[] = [];
    try {
      const cfg = await api<Config>("/v1/config");
      const client = createPublicClient({ transport: http(rpc || cfg.chain.rpc) });
      const chainId = await client.getChainId();
      out.push({ name: "Talking to the chain directly", ok: chainId === cfg.chain.id, detail: `RPC ${rpc || cfg.chain.rpc} reports chain id ${chainId}` });
      const detail = await api<{ ious: { digest: Hex; buyer: string; seller: string; amount: string; token: Address; jobHash: Hex; quoteHash: Hex; epoch: number; nonce: string; signature: Hex; status: string }[] }>(
        `/v1/epochs/${id}`,
      );
      const posted = detail.ious.filter((i) => i.status === "netted");
      const domain = { ...cfg.domain };

      // 1. signatures against keys read from the identity registry on chain
      const signers = new Map<string, Address>();
      let badSig = 0;
      let badDigest = 0;
      for (const i of posted) {
        const iou = { buyer: BigInt(i.buyer), seller: BigInt(i.seller), amount: BigInt(i.amount), token: i.token, jobHash: i.jobHash, quoteHash: i.quoteHash, epoch: BigInt(i.epoch), nonce: BigInt(i.nonce) };
        if (iouDigest(domain, iou) !== i.digest) badDigest++;
        if (!signers.has(i.buyer)) {
          signers.set(i.buyer, (await client.readContract({ address: cfg.deployment.identityRegistry, abi: identityRegistryAbi, functionName: "signerOf", args: [BigInt(i.buyer)] })) as Address);
        }
        const rec = await recoverTypedDataAddress({ domain, types: IOU_TYPES, primaryType: "IOU", message: iou, signature: i.signature }).catch(() => null);
        if (!rec || !isAddressEqual(rec, signers.get(i.buyer)!)) badSig++;
      }
      out.push({ name: "IOU digests recomputed", ok: badDigest === 0, detail: `${posted.length - badDigest}/${posted.length} match EIP-712 under the clearing house domain` });
      out.push({ name: "Buyer signatures", ok: badSig === 0, detail: `${posted.length - badSig}/${posted.length} recover to the buyer's key from the on-chain identity registry` });

      // 2. redo the netting
      const carried = posted.filter((i) => i.epoch < Number(id));
      const own = posted.filter((i) => i.epoch === Number(id));
      const toN = (i: (typeof posted)[number]) => ({ buyer: BigInt(i.buyer), seller: BigInt(i.seller), amount: BigInt(i.amount), nonce: BigInt(i.nonce), digest: i.digest });
      const result = net(own.map(toN), carried.map(toN));
      const sum = result.positions.reduce((a, p) => a + p.net, 0n);
      out.push({ name: "Net positions sum to zero", ok: sum === 0n, detail: `sum = ${sum}` });

      // 3. compare with what the contract stored
      const e = (await client.readContract({ address: cfg.deployment.clearingHouse, abi: clearingHouseAbi, functionName: "getEpoch", args: [BigInt(id)] })) as {
        status: number;
        iouSetHash: Hex;
        positionsHash: Hex;
        grossVolume: bigint;
        netVolume: bigint;
        iouCount: number;
        receiptHash: Hex;
      };
      out.push({ name: "IOU-set commitment on chain", ok: e.iouSetHash === result.iouSetHash, detail: `${e.iouSetHash.slice(0, 18)}… ${e.iouSetHash === result.iouSetHash ? "=" : "≠"} recomputed` });
      out.push({ name: "Positions commitment on chain", ok: e.positionsHash === result.positionsHash, detail: `${e.positionsHash.slice(0, 18)}… ${e.positionsHash === result.positionsHash ? "=" : "≠"} recomputed` });
      out.push({ name: "Gross and net volume", ok: e.grossVolume === result.stats.grossVolume && e.netVolume === result.stats.netVolume, detail: `chain ${usd(e.grossVolume, 4)} / ${usd(e.netVolume, 4)}, recomputed ${usd(result.stats.grossVolume, 4)} / ${usd(result.stats.netVolume, 4)}` });
      let mismatch = 0;
      for (const p of result.positions) {
        const [, , n] = (await client.readContract({ address: cfg.deployment.clearingHouse, abi: clearingHouseAbi, functionName: "getPosition", args: [BigInt(id), p.agentId] })) as [bigint, bigint, bigint, number];
        if (n !== p.net) mismatch++;
      }
      out.push({ name: "Every agent's net position", ok: mismatch === 0, detail: `${result.positions.length - mismatch}/${result.positions.length} agents match the contract` });
      const statusName = ["open", "posting", "finalized", "settled"][e.status] ?? String(e.status);
      out.push({ name: "Epoch status", ok: e.status >= 2, detail: `${statusName}${e.status === 3 ? `, receipt ${e.receiptHash.slice(0, 18)}…` : ""}` });
      setSummary(`${result.stats.iouCount} IOUs → ${result.stats.settlementTransfers} transfers (${pct(result.stats.transferReduction)} fewer payments)`);
    } catch (err) {
      out.push({ name: "Verification", ok: false, detail: (err as Error).message });
    }
    setRows(out);
    setRunning(false);
  };

  useEffect(() => {
    if (params.get("epoch")) void run(params.get("epoch")!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rpc]);

  const sealed = [...live.epochs.values()].filter((e) => e.phase === "sealed" && e.iouCount > 0).sort((a, b) => b.id - a.id).slice(0, 8);
  const allOk = rows?.every((r) => r.ok);
  return (
    <main className="page">
      <div className="page-inner" style={{ maxWidth: 1000 }}>
        <PageHead
          title="Don’t trust us. Re‑check the chain."
          sub="Your browser fetches the epoch’s published IOU set, recovers every signature, redoes the netting with the same code the contract mirrors, and compares the result with what is stored on chain, read straight from the RPC."
        />
        <Panel>
          <form
            className="verify-form"
            onSubmit={(e) => {
              e.preventDefault();
              void run(epoch);
            }}
          >
            <div className="field">
              <label htmlFor="verify-epoch">Epoch</label>
              <input id="verify-epoch" className="input" name="epoch" inputMode="numeric" autoComplete="off" placeholder="e.g. 12" value={epoch} onChange={(e) => setEpoch(e.target.value)} />
            </div>
            <div className="field grow">
              <label htmlFor="verify-rpc">RPC URL</label>
              <input id="verify-rpc" className="input mono" name="rpc" type="url" autoComplete="off" spellCheck={false} placeholder="https://…" value={rpc} onChange={(e) => setRpc(e.target.value)} />
            </div>
            <Btn type="submit" disabled={running || !epoch}>
              {running ? "Verifying…" : "Verify"}
            </Btn>
          </form>
          {sealed.length > 0 && (
            <div className="verify-recent">
              <span className="muted">Recent sealed epochs</span>
              {sealed.map((e) => (
                <button key={e.id} type="button" className="choice" aria-pressed={epoch === String(e.id)} onClick={() => (setEpoch(String(e.id)), run(String(e.id)))}>
                  {e.id}
                </button>
              ))}
            </div>
          )}
        </Panel>
        {running && !rows && (
          <Panel>
            <p className="dim" aria-live="polite">
              Reading the chain and recovering signatures…
            </p>
          </Panel>
        )}
        {rows && (
          <Panel title={<span className="big-ok">{allOk ? "Everything checks out" : "Something does not match"}</span>} actions={<Pill tone={allOk ? "good" : "warn"}>{allOk ? "verified" : "failed"}</Pill>}>
            {summary && <p className="dim" style={{ marginBottom: 10 }}>{summary}</p>}
            <div className="checks">
              {rows.map((r) => (
                <div className="row" key={r.name}>
                  <span className={`check ${r.ok ? "" : "bad"}`}>{r.ok ? <IconCheck aria-label="Passed" /> : <IconX aria-label="Failed" />}</span>
                  <b style={{ fontWeight: 600 }}>{r.name}</b>
                  <span className="dim mono" style={{ fontSize: 12 }}>
                    {r.detail}
                  </span>
                </div>
              ))}
            </div>
            <p className="muted" style={{ fontSize: 13, marginTop: 12 }}>
              Want the server's own report too? <a className="accent" href={`${API}/v1/epochs/${epoch}/verify`} target="_blank" rel="noreferrer">/v1/epochs/{epoch}/verify</a> also re-checks every HSP settlement as a raw transfer. Or walk an
              epoch on its <Link to={`/epochs/${epoch}`} className="accent">receipt page</Link>.
            </p>
          </Panel>
        )}
      </div>
    </main>
  );
}

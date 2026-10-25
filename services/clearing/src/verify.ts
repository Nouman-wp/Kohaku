import { isAddressEqual, recoverTypedDataAddress, type Hex, type TypedDataDomain } from "viem";
import { IOU_TYPES, iouDigest, net, settlementOrderRef, type IOU } from "@kohaku/core";
import type { Db } from "./db.ts";
import type { Chain } from "./chain.ts";
import type { Registry } from "./registry.ts";
import { checkTransfer } from "./hsp/onchain.ts";
import type { IouRow, SettlementRow } from "./views.ts";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * Independent re-check of an epoch against the chain, using only the published IOU set:
 * every signature is recovered, every digest recomputed, the netting redone, and the
 * resulting commitments and per-agent positions compared with what the clearing house
 * stored. HSP settlements are re-checked as raw ERC-20 transfers on chain.
 */
export async function verifyEpoch(db: Db, chain: Chain, registry: Registry, domain: TypedDataDomain, epochId: number) {
  const checks: Check[] = [];
  const ious = db.all<IouRow>("SELECT * FROM ious WHERE posted_epoch = ? AND status = 'netted' ORDER BY epoch, buyer, nonce_num", epochId);
  const carried = ious.filter((i) => i.epoch < epochId);
  const own = ious.filter((i) => i.epoch === epochId);

  let badSigs = 0;
  let badDigests = 0;
  for (const r of ious) {
    const iou: IOU = {
      buyer: BigInt(r.buyer),
      seller: BigInt(r.seller),
      amount: BigInt(r.amount),
      token: r.token as Hex,
      jobHash: r.job_hash as Hex,
      quoteHash: r.quote_hash as Hex,
      epoch: BigInt(r.epoch),
      nonce: BigInt(r.nonce),
    };
    if (iouDigest(domain, iou) !== r.digest) badDigests++;
    const signer = await recoverTypedDataAddress({ domain, types: IOU_TYPES, primaryType: "IOU", message: iou, signature: r.signature as Hex }).catch(() => null);
    const expected = registry.get(r.buyer)?.signer;
    if (!signer || !expected || !isAddressEqual(signer, expected)) badSigs++;
  }
  checks.push({ name: "IOU digests", ok: badDigests === 0, detail: `${ious.length - badDigests}/${ious.length} recomputed digests match` });
  checks.push({ name: "Buyer signatures", ok: badSigs === 0, detail: `${ious.length - badSigs}/${ious.length} signatures recover to the buyer's registered key` });

  const result = net(
    own.map((r) => ({ buyer: BigInt(r.buyer), seller: BigInt(r.seller), amount: BigInt(r.amount), nonce: BigInt(r.nonce), digest: r.digest as Hex })),
    carried.map((r) => ({ buyer: BigInt(r.buyer), seller: BigInt(r.seller), amount: BigInt(r.amount), nonce: BigInt(r.nonce), digest: r.digest as Hex })),
  );
  const sum = result.positions.reduce((a, p) => a + p.net, 0n);
  checks.push({ name: "Positions sum to zero", ok: sum === 0n, detail: `sum of net positions = ${sum}` });

  const ce = await chain.epoch(BigInt(epochId));
  checks.push({ name: "IOU-set commitment", ok: ce.iouSetHash === result.iouSetHash, detail: `chain ${ce.iouSetHash} / recomputed ${result.iouSetHash}` });
  checks.push({ name: "Positions commitment", ok: ce.positionsHash === result.positionsHash, detail: `chain ${ce.positionsHash} / recomputed ${result.positionsHash}` });
  checks.push({ name: "Gross volume", ok: ce.grossVolume === result.stats.grossVolume, detail: `chain ${ce.grossVolume} / recomputed ${result.stats.grossVolume}` });
  checks.push({ name: "IOU count", ok: ce.iouCount === result.stats.iouCount, detail: `chain ${ce.iouCount} / recomputed ${result.stats.iouCount}` });

  let posMismatch = 0;
  for (const p of result.positions) {
    const onchain = await chain.position(BigInt(epochId), p.agentId);
    if (onchain.net !== p.net) posMismatch++;
  }
  checks.push({ name: "Per-agent net positions", ok: posMismatch === 0, detail: `${result.positions.length - posMismatch}/${result.positions.length} agents match the chain` });

  const settlements = db.all<SettlementRow>("SELECT * FROM settlements WHERE epoch = ? AND status = 'recorded'", epochId);
  let badTransfers = 0;
  for (const s of settlements) {
    const agent = registry.get(s.agent_id);
    if (!agent || !s.settlement_tx) {
      badTransfers++;
      continue;
    }
    const ref = settlementOrderRef(chain.viemChain.id, chain.d.clearingHouse, BigInt(s.epoch), BigInt(s.agent_id), BigInt(s.amount));
    const t = await checkTransfer(chain.publicClient, s.settlement_tx as Hex, chain.d.token, agent.signer, chain.d.clearingHouse, BigInt(s.amount), ref);
    if (!t.ok) badTransfers++;
  }
  checks.push({
    name: "HSP settlement transfers",
    ok: badTransfers === 0,
    detail: `${settlements.length - badTransfers}/${settlements.length} recorded HSP payments are exact on-chain transfers to the pool, each consuming its debt's authorization`,
  });

  const statusNames = ["open", "posting", "finalized", "settled"];
  return {
    epoch: epochId,
    ok: checks.every((c) => c.ok),
    chainStatus: statusNames[ce.status] ?? String(ce.status),
    receiptHash: ce.receiptHash,
    checks,
    stats: { ...result.stats, grossVolume: result.stats.grossVolume.toString(), netVolume: result.stats.netVolume.toString() },
  };
}

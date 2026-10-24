import { encodeAbiParameters, keccak256, zeroHash, type Hex } from "viem";

/**
 * Off-chain mirror of the clearing house's netting. The clearing service uses it to
 * compute the result it expects before posting; the Verify page and the CLI verifier use
 * it to re-derive an epoch from the published IOU set. All three must agree with the
 * contract bit for bit, which is what the parity tests check.
 */

export interface NettableIou {
  buyer: bigint;
  seller: bigint;
  amount: bigint;
  nonce: bigint;
  digest: Hex;
}

export interface Position {
  agentId: bigint;
  credit: bigint;
  debit: bigint;
  net: bigint;
}

export interface NettingResult {
  /** IOUs in the exact order they are posted on chain (carried first, then sorted). */
  ordered: NettableIou[];
  positions: Position[];
  iouSetHash: Hex;
  positionsHash: Hex;
  stats: CompressionStats;
}

export interface CompressionStats {
  iouCount: number;
  grossVolume: bigint;
  netVolume: bigint;
  debtors: number;
  creditors: number;
  /** Transfers that actually move money: one HSP payment per debtor + one payout per creditor. */
  settlementTransfers: number;
  /** How many individual payments netting removed. Never negative. */
  transfersAvoided: number;
  /** Share of payments avoided, 0..1. A single IOU honestly shows 0. */
  transferReduction: number;
  /** Share of value that never had to move, 0..1. */
  volumeReduction: number;
}

/** Posting order the contract requires: strictly ascending (buyer, nonce). */
export function sortForPosting<T extends { buyer: bigint; nonce: bigint }>(ious: T[]): T[] {
  return [...ious].sort((a, b) => {
    if (a.buyer !== b.buyer) return a.buyer < b.buyer ? -1 : 1;
    if (a.nonce !== b.nonce) return a.nonce < b.nonce ? -1 : 1;
    return 0;
  });
}

export function chainIouSetHash(prev: Hex, digest: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [prev, digest]));
}

export function chainPositionsHash(prev: Hex, agentId: bigint, credit: bigint, debit: bigint): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "uint128" }, { type: "uint128" }],
      [prev, agentId, credit, debit],
    ),
  );
}

/**
 * Net an epoch. `carried` are held-out IOUs from earlier epochs whose disputes were
 * rejected; they are posted first, in the given order. `ious` are this epoch's IOUs and
 * are sorted here. Throws on duplicates, which the contract would reject anyway.
 */
export function net(ious: NettableIou[], carried: NettableIou[] = []): NettingResult {
  const sorted = sortForPosting(ious);
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1]!;
    const b = sorted[i]!;
    if (a.buyer === b.buyer && a.nonce === b.nonce) {
      throw new Error(`duplicate IOU nonce ${b.nonce} for buyer ${b.buyer}`);
    }
  }
  const ordered = [...carried, ...sorted];

  const order: bigint[] = [];
  const book = new Map<bigint, { credit: bigint; debit: bigint }>();
  const touch = (id: bigint) => {
    let p = book.get(id);
    if (!p) {
      p = { credit: 0n, debit: 0n };
      book.set(id, p);
      order.push(id);
    }
    return p;
  };

  let iouSetHash: Hex = zeroHash;
  let gross = 0n;
  for (const iou of ordered) {
    if (iou.buyer === iou.seller) throw new Error(`self-dealing IOU for agent ${iou.buyer}`);
    if (iou.amount <= 0n) throw new Error("IOU amount must be positive");
    touch(iou.buyer).debit += iou.amount;
    touch(iou.seller).credit += iou.amount;
    gross += iou.amount;
    iouSetHash = chainIouSetHash(iouSetHash, iou.digest);
  }

  let positionsHash: Hex = zeroHash;
  const positions: Position[] = [];
  let netVolume = 0n;
  let debtors = 0;
  let creditors = 0;
  let sum = 0n;
  for (const id of order) {
    const p = book.get(id)!;
    const n = p.credit - p.debit;
    positions.push({ agentId: id, credit: p.credit, debit: p.debit, net: n });
    positionsHash = chainPositionsHash(positionsHash, id, p.credit, p.debit);
    sum += n;
    if (n < 0n) debtors++;
    if (n > 0n) {
      creditors++;
      netVolume += n;
    }
  }
  if (sum !== 0n) throw new Error(`netting invariant broken: positions sum to ${sum}`);

  return { ordered, positions, iouSetHash, positionsHash, stats: compression(ordered.length, gross, netVolume, debtors, creditors) };
}

export function compression(
  iouCount: number,
  grossVolume: bigint,
  netVolume: bigint,
  debtors: number,
  creditors: number,
): CompressionStats {
  const settlementTransfers = debtors + creditors;
  // Without netting every IOU is one payment. With netting a lone IOU still needs a pay-in and
  // a payout, so we compare against the gross count and floor the saving at zero.
  const transfersAvoided = Math.max(0, iouCount - settlementTransfers);
  return {
    iouCount,
    grossVolume,
    netVolume,
    debtors,
    creditors,
    settlementTransfers,
    transfersAvoided,
    transferReduction: iouCount === 0 ? 0 : transfersAvoided / iouCount,
    volumeReduction: grossVolume === 0n ? 0 : Number(grossVolume - netVolume) / Number(grossVolume),
  };
}

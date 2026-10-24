import { decodeEventLog, isAddressEqual, parseAbiItem, type Address, type Hex, type PublicClient } from "viem";

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

export interface TransferCheck {
  ok: boolean;
  reason?: string;
  blockNumber?: bigint;
  retryable?: boolean;
}

/**
 * Kohaku's own check, independent of any HSP component: the settlement transaction
 * succeeded and moved exactly `amount` of `token` from `from` (the debtor's wallet) to
 * `to` (the pool). Exact, not "at least": a payment for the wrong amount must not count.
 */
export async function checkTransfer(
  client: PublicClient,
  txHash: Hex,
  token: Address,
  from: Address,
  to: Address,
  amount: bigint,
): Promise<TransferCheck> {
  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash });
  } catch {
    return { ok: false, reason: "transaction not found yet", retryable: true };
  }
  if (receipt.status !== "success") return { ok: false, reason: "settlement transaction reverted" };
  let moved = 0n;
  for (const l of receipt.logs) {
    if (!isAddressEqual(l.address, token)) continue;
    try {
      const ev = decodeEventLog({ abi: [TRANSFER], data: l.data, topics: l.topics });
      if (isAddressEqual(ev.args.from, from) && isAddressEqual(ev.args.to, to)) moved += ev.args.value;
    } catch {
      // not a Transfer
    }
  }
  if (moved === 0n) return { ok: false, reason: "no transfer from the debtor's wallet to the pool in this transaction" };
  if (moved !== amount) return { ok: false, reason: `transfer moved ${moved}, the debt is ${amount}` };
  return { ok: true, blockNumber: receipt.blockNumber };
}

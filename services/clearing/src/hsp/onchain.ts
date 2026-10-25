import { decodeEventLog, isAddressEqual, parseAbiItem, type Address, type Hex, type PublicClient } from "viem";

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const AUTHORIZATION_USED = parseAbiItem("event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)");

export interface TransferCheck {
  ok: boolean;
  reason?: string;
  blockNumber?: bigint;
  retryable?: boolean;
}

/**
 * Kohaku's own check, independent of HSP: the settlement transaction succeeded, moved
 * exactly `amount` of `token` from `from` (the debtor's wallet) to `to` (the pool), and
 * (when `nonce` is given) consumed the debtor's EIP-3009 authorization whose nonce is this
 * debt's settlement order reference. Exact, not "at least": a payment for the wrong amount
 * or for another debt must not count.
 */
export async function checkTransfer(
  client: PublicClient,
  txHash: Hex,
  token: Address,
  from: Address,
  to: Address,
  amount: bigint,
  nonce?: Hex,
): Promise<TransferCheck> {
  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash });
  } catch {
    return { ok: false, reason: "transaction not found yet", retryable: true };
  }
  if (receipt.status !== "success") return { ok: false, reason: "settlement transaction reverted" };
  let moved = 0n;
  let authorized = false;
  for (const l of receipt.logs) {
    if (!isAddressEqual(l.address, token)) continue;
    try {
      const ev = decodeEventLog({ abi: [TRANSFER, AUTHORIZATION_USED], data: l.data, topics: l.topics });
      if (ev.eventName === "Transfer" && isAddressEqual(ev.args.from, from) && isAddressEqual(ev.args.to, to)) moved += ev.args.value;
      if (ev.eventName === "AuthorizationUsed" && nonce && isAddressEqual(ev.args.authorizer, from) && ev.args.nonce.toLowerCase() === nonce.toLowerCase()) authorized = true;
    } catch {
      // some other event
    }
  }
  if (moved === 0n) return { ok: false, reason: "no transfer from the debtor's wallet to the pool in this transaction" };
  if (moved !== amount) return { ok: false, reason: `transfer moved ${moved}, the debt is ${amount}` };
  if (nonce && !authorized) return { ok: false, reason: "transfer did not use the authorization for this debt (nonce mismatch)" };
  return { ok: true, blockNumber: receipt.blockNumber };
}

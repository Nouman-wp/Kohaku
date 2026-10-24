import { encodeAbiParameters, hashTypedData, keccak256, type Address, type Hex, type TypedDataDomain } from "viem";

/**
 * HSP (HashKey Settlement Protocol) wire objects as Kohaku uses them.
 *
 * HSP's model (from the official "Building on HSP" guide): the payer signs an EIP-712
 * Mandate, the payer's own wallet broadcasts the ERC-20 transfer (zero custody), an adapter
 * observes the transfer and signs a Receipt, and a verifier ACCEPTs iff the receipt
 * satisfies everything the mandate required.
 *
 * In `coordinator` mode the official HSP SDK builds and registers these objects with the
 * hosted Coordinator. In `local` mode Kohaku runs the same three moves itself with the
 * shapes below and labels it as such everywhere. Kohaku binds every settlement to one
 * epoch, one debtor and one exact amount through the mandate nonce.
 */

export const HSP_CAP_SETTLEMENT = "proves:settlement-verified:v1";

export function hspDomain(chainId: number): TypedDataDomain {
  return { name: "HSP", version: "1", chainId };
}

export const HSP_MANDATE_TYPES = {
  Mandate: [
    { name: "payer", type: "address" },
    { name: "to", type: "address" },
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "chainId", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint256" },
    { name: "capabilities", type: "string" },
  ],
} as const;

export const HSP_RECEIPT_TYPES = {
  Receipt: [
    { name: "paymentId", type: "bytes32" },
    { name: "txHash", type: "bytes32" },
    { name: "chainId", type: "uint256" },
    { name: "to", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "capability", type: "string" },
  ],
} as const;

export interface HspMandate {
  payer: Address;
  to: Address;
  token: Address;
  amount: bigint;
  chainId: bigint;
  nonce: bigint;
  expiry: bigint;
  capabilities: string;
}

export interface HspReceipt {
  paymentId: Hex;
  txHash: Hex;
  chainId: bigint;
  to: Address;
  amount: bigint;
  capability: string;
}

/** paymentId = the mandate's EIP-712 hash, exactly as in HSP. */
export function hspPaymentId(m: HspMandate): Hex {
  return hashTypedData({ domain: hspDomain(Number(m.chainId)), types: HSP_MANDATE_TYPES, primaryType: "Mandate", message: m });
}

export function hspReceiptDigest(r: HspReceipt): Hex {
  return hashTypedData({ domain: hspDomain(Number(r.chainId)), types: HSP_RECEIPT_TYPES, primaryType: "Receipt", message: r });
}

/**
 * Settlement order reference. Deterministic, so the debtor, the clearing service and an
 * auditor all derive the same value from (chain, clearing house, epoch, agent, amount).
 * Used as the HSP mandate nonce: a payment made for another epoch or another amount
 * carries a different nonce and is rejected.
 */
export function settlementOrderRef(chainId: number, clearingHouse: Address, epoch: bigint, agentId: bigint, amount: bigint): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "uint256" }, { type: "address" }, { type: "uint64" }, { type: "uint256" }, { type: "uint256" }],
      ["kohaku.settlement.v1", BigInt(chainId), clearingHouse, epoch, agentId, amount],
    ),
  );
}

export interface SettlementOrder {
  id: string;
  epoch: number;
  agentId: string;
  amount: string;
  token: Address;
  payTo: Address;
  chainId: number;
  orderRef: Hex;
  deadline: number | null;
  hspMode: "local" | "coordinator";
}

/** What a debtor reports after paying. */
export interface PaymentReport {
  paymentId: Hex;
  txHash: Hex;
  /** local mode: the signed mandate itself */
  mandate?: { [K in keyof HspMandate]: string };
  mandateSignature?: Hex;
}

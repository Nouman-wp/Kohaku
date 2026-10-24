import type { Address, Hex } from "viem";
import type { HspMode, PaymentReport } from "@kohaku/core";

export interface HspOrder {
  id: string;
  epoch: bigint;
  agentId: bigint;
  amount: bigint;
  payer: Address; // the debtor agent's wallet
  payTo: Address; // the clearing house pool
  token: Address;
  orderRef: Hex;
}

export type HspOutcome = "ACCEPT" | "RETRYABLE" | "POLICY" | "PERMANENT";

export interface HspVerification {
  outcome: HspOutcome;
  /** HSP payment status as reported (e.g. SETTLED, OBSERVING). */
  status: string;
  paymentId: Hex;
  txHash: Hex | null;
  receipt: unknown;
  receiptHash: Hex | null;
  mandate: unknown;
  reason?: string;
}

export interface HspInfo {
  mode: HspMode;
  coordinatorUrl: string | null;
  adapterAddress: string | null;
  chain: string;
  note: string;
}

/** The one seam between Kohaku and HSP. Two implementations: local and coordinator. */
export interface HspPort {
  readonly mode: HspMode;
  info(): HspInfo;
  health(): Promise<boolean>;
  /** Verify that `report` is a settled HSP payment for exactly `order`. Never throws. */
  verify(order: HspOrder, report: PaymentReport): Promise<HspVerification>;
}

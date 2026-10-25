import type { Address, Hex } from "viem";
import type { HspMode, HspPaymentRecord, PaymentReport } from "@kohaku/core";

export interface HspOrder {
  id: string;
  epoch: bigint;
  agentId: bigint;
  amount: bigint;
  payer: Address; // the debtor agent's wallet
  payTo: Address; // the clearing house pool
  token: Address;
  orderRef: Hex;
  /** retry counter, so a failed order can be replaced by a fresh one */
  attempt: number;
}

export interface OpenedOrder {
  cartMandateId: string;
  paymentRequestId: string;
  flowId: string | null;
  paymentUrl: string | null;
  request: unknown;
}

export type HspOutcome = "ACCEPT" | "RETRYABLE" | "POLICY" | "PERMANENT";

export interface HspVerification {
  outcome: HspOutcome;
  /** HSP payment status as reported (payment-included, payment-successful, ...). */
  status: string;
  paymentId: string | null;
  txHash: Hex | null;
  /** HSP's payment record, kept as the settlement's receipt */
  receipt: HspPaymentRecord | null;
  receiptHash: Hex | null;
  reason?: string;
}

export interface HspInfo {
  mode: HspMode;
  /** where payers reach HSP's payment endpoints */
  gatewayUrl: string;
  merchantName: string;
  network: string;
  note: string;
}

/** The one seam between Kohaku and HSP. */
export interface HspPort {
  readonly mode: HspMode;
  info(): HspInfo;
  health(): Promise<boolean>;
  /** Open the HSP order (AP2 cart mandate) a debtor pays. Throws if HSP refuses or is down. */
  open(order: HspOrder): Promise<OpenedOrder>;
  /** Is the debtor's payment of `order` settled, exactly, on chain? Never throws. */
  verify(order: HspOrder, cartMandateId: string, report: PaymentReport | null): Promise<HspVerification>;
}

import type {
  DisputeView,
  EpochView,
  Hex,
  IouView,
  JobView,
  PayoutView,
  PositionView,
  SettlementView,
} from "@kohaku/core";
import { compression } from "@kohaku/core";

export interface JobRow {
  id: string;
  job_hash: string;
  buyer: number;
  seller: number;
  service: string;
  spec_json: string;
  price: number;
  epoch: number;
  intent_id: string | null;
  quote_json: string;
  quote_sig: string;
  quote_hash: string;
  status: string;
  created_at: number;
  delivered_at: number | null;
  challenge_ends_at: number | null;
  result_hash: string | null;
  result_json: string | null;
  delivery_sig: string | null;
  delivery_json: string | null;
  parent_job: string | null;
}

export interface IouRow {
  digest: string;
  job_id: string;
  epoch: number;
  buyer: number;
  seller: number;
  amount: number;
  token: string;
  job_hash: string;
  quote_hash: string;
  nonce: string;
  nonce_num: number;
  signature: string;
  status: string;
  posted_epoch: number | null;
  created_at: number;
}

export interface EpochRow {
  id: number;
  phase: string;
  starts_at: number;
  intake_ends_at: number;
  challenge_ends_at: number;
  settle_deadline: number | null;
  iou_count: number;
  gross: number;
  net: number;
  debtors: number;
  creditors: number;
  iou_set_hash: string | null;
  positions_hash: string | null;
  receipt_hash: string | null;
  finalize_tx: string | null;
  payout_tx: string | null;
  held_out: number;
  carried: number;
  disputes_upheld: number;
  defaults: number;
  onchain: string;
  error: string | null;
  sealed_at: number | null;
}

export interface PositionRow {
  epoch: number;
  agent_id: number;
  credit: number;
  debit: number;
  net: number;
  state: string;
}

export interface SettlementRow {
  id: string;
  epoch: number;
  agent_id: number;
  amount: number;
  status: string;
  hsp_mode: string;
  hsp_payment_id: string | null;
  hsp_status: string | null;
  hsp_outcome: string | null;
  mandate_json: string | null;
  receipt_json: string | null;
  settlement_tx: string | null;
  receipt_hash: string | null;
  record_tx: string | null;
  attempts: number;
  deadline: number | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export interface DisputeRow {
  id: string;
  job_id: string;
  iou_digest: string;
  epoch: number;
  buyer: number;
  seller: number;
  validator: number | null;
  arbiter_job_id: string | null;
  reason: string;
  filed_at: number;
  signature: string;
  dispute_hash: string;
  status: string;
  reasoning: string | null;
  verdict_sig: string | null;
  decided_at: number | null;
  request_tx: string | null;
  response_tx: string | null;
}

export interface PayoutRow {
  epoch: number;
  agent_id: number;
  to_addr: string;
  amount: number;
  tx: string | null;
}

const parse = (s: string | null): unknown => {
  if (s === null) return null;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

export function jobView(r: JobRow): JobView {
  const spec = parse(r.spec_json) as { input?: unknown };
  return {
    id: r.id,
    jobHash: r.job_hash as Hex,
    buyer: String(r.buyer),
    seller: String(r.seller),
    service: r.service,
    input: spec?.input ?? null,
    price: String(r.price),
    epoch: r.epoch,
    intentId: r.intent_id,
    status: r.status as JobView["status"],
    createdAt: r.created_at,
    deliveredAt: r.delivered_at,
    challengeEndsAt: r.challenge_ends_at,
    resultHash: r.result_hash as Hex | null,
    result: parse(r.result_json),
  };
}

export function iouView(r: IouRow): IouView {
  return {
    digest: r.digest as Hex,
    epoch: r.epoch,
    buyer: String(r.buyer),
    seller: String(r.seller),
    amount: String(r.amount),
    token: r.token as Hex,
    jobHash: r.job_hash as Hex,
    quoteHash: r.quote_hash as Hex,
    nonce: r.nonce,
    signature: r.signature as Hex,
    status: r.status as IouView["status"],
    createdAt: r.created_at,
    jobId: r.job_id,
  };
}

export function epochView(r: EpochRow): EpochView {
  const s = compression(r.iou_count, BigInt(r.gross), BigInt(r.net), r.debtors, r.creditors);
  return {
    id: r.id,
    phase: r.phase as EpochView["phase"],
    startsAt: r.starts_at,
    intakeEndsAt: r.intake_ends_at,
    challengeEndsAt: r.challenge_ends_at,
    settleDeadline: r.settle_deadline,
    iouCount: r.iou_count,
    grossVolume: String(r.gross),
    netVolume: String(r.net),
    debtors: r.debtors,
    creditors: r.creditors,
    settlementTransfers: s.settlementTransfers,
    transfersAvoided: s.transfersAvoided,
    transferReduction: s.transferReduction,
    volumeReduction: s.volumeReduction,
    iouSetHash: r.iou_set_hash as Hex | null,
    positionsHash: r.positions_hash as Hex | null,
    receiptHash: r.receipt_hash as Hex | null,
    finalizeTx: r.finalize_tx as Hex | null,
    payoutTx: r.payout_tx as Hex | null,
    heldOut: r.held_out,
    carried: r.carried,
    disputesUpheld: r.disputes_upheld,
    defaults: r.defaults,
    onchain: r.onchain as EpochView["onchain"],
    error: r.error,
  };
}

export function positionView(r: PositionRow): PositionView {
  return {
    epoch: r.epoch,
    agentId: String(r.agent_id),
    credit: String(r.credit),
    debit: String(r.debit),
    net: String(r.net),
    state: r.state as PositionView["state"],
  };
}

export function settlementView(r: SettlementRow): SettlementView {
  return {
    id: r.id,
    epoch: r.epoch,
    agentId: String(r.agent_id),
    amount: String(r.amount),
    status: r.status as SettlementView["status"],
    hspMode: r.hsp_mode as SettlementView["hspMode"],
    hspPaymentId: r.hsp_payment_id as Hex | null,
    hspStatus: r.hsp_status,
    hspOutcome: r.hsp_outcome,
    settlementTx: r.settlement_tx as Hex | null,
    receiptHash: r.receipt_hash as Hex | null,
    recordTx: r.record_tx as Hex | null,
    attempts: r.attempts,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deadline: r.deadline,
    error: r.error,
  };
}

export function disputeView(r: DisputeRow): DisputeView {
  return {
    id: r.id,
    jobId: r.job_id,
    iouDigest: r.iou_digest as Hex,
    epoch: r.epoch,
    buyer: String(r.buyer),
    seller: String(r.seller),
    validator: r.validator === null ? null : String(r.validator),
    reason: r.reason,
    status: r.status as DisputeView["status"],
    reasoning: r.reasoning,
    filedAt: r.filed_at,
    decidedAt: r.decided_at,
    disputeHash: r.dispute_hash as Hex,
    verdictSignature: r.verdict_sig as Hex | null,
    onchainRequestTx: r.request_tx as Hex | null,
    onchainResponseTx: r.response_tx as Hex | null,
  };
}

export function payoutView(r: PayoutRow): PayoutView {
  return { epoch: r.epoch, agentId: String(r.agent_id), to: r.to_addr as Hex, amount: String(r.amount), tx: r.tx as Hex | null };
}

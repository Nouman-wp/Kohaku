/**
 * Wire types shared by the clearing service, the SDK, the MCP server and the web app.
 * Amounts travel as decimal strings of token base units; agent ids and epochs as strings
 * or numbers. Nothing here is a bigint, so it all survives JSON.
 */

export type Hex = `0x${string}`;

export type EpochPhase =
  | "intake" // accepting IOUs
  | "challenge" // no new IOUs, disputes still allowed
  | "closing" // resolving disputes, netting, posting to chain
  | "settling" // waiting for debtors' HSP payments
  | "paying" // payout transaction in flight
  | "sealed" // settled and receipted
  | "failed"; // something went wrong; retried automatically

export type SettlementStatus =
  | "awaiting_payment"
  | "submitted" // the debtor reports an HSP payment, verification in progress
  | "verified" // HSP ACCEPT + on-chain transfer checked
  | "recorded" // recorded on the clearing house
  | "defaulted"
  | "failed";

export type HspMode = "coordinator" | "local";

export interface ServiceListing {
  id: string; // e.g. "search"
  name: string;
  description: string;
  price: string; // base units per call
  unit: string; // "query", "claim", "paragraph", ...
  tags: string[];
}

export interface AgentSummary {
  agentId: string;
  slug: string;
  name: string;
  description: string;
  role: string;
  operator: Hex;
  signer: Hex;
  status: "active" | "paused" | "retired";
  endpoint: string;
  cardUrl: string;
  services: ServiceListing[];
  reputation: number; // 0..1000
  reputationEpoch: number;
  volumeSold: string;
  volumeBought: string;
  jobsSold: number;
  jobsBought: number;
  disputesLost: number;
  defaults: number;
  collateral: CollateralView;
  isValidator: boolean;
  isFleet: boolean;
}

export interface CollateralView {
  total: string;
  locked: string;
  pendingWithdrawal: string;
  unlockAt: number;
  /** total - locked - pending: what can still back new IOUs */
  available: string;
  /** unsettled obligations the clearing service is holding against it right now */
  exposure: string;
  /** available - exposure */
  headroom: string;
}

export interface IouView {
  digest: Hex;
  epoch: number;
  buyer: string;
  seller: string;
  amount: string;
  token: Hex;
  jobHash: Hex;
  quoteHash: Hex;
  nonce: string;
  signature: Hex;
  status: "pending" | "disputed" | "voided" | "held_out" | "carried" | "posted" | "netted";
  createdAt: number;
  jobId: string;
}

export interface JobView {
  id: string;
  jobHash: Hex;
  buyer: string;
  seller: string;
  service: string;
  input: unknown;
  price: string;
  epoch: number;
  intentId: string | null;
  status: "quoted" | "accepted" | "delivered" | "disputed" | "voided" | "settled" | "refused";
  createdAt: number;
  deliveredAt: number | null;
  challengeEndsAt: number | null;
  resultHash: Hex | null;
  result: unknown;
}

export interface EpochView {
  id: number;
  phase: EpochPhase;
  startsAt: number;
  intakeEndsAt: number;
  challengeEndsAt: number;
  settleDeadline: number | null;
  iouCount: number;
  grossVolume: string;
  netVolume: string;
  debtors: number;
  creditors: number;
  settlementTransfers: number;
  transfersAvoided: number;
  transferReduction: number;
  volumeReduction: number;
  iouSetHash: Hex | null;
  positionsHash: Hex | null;
  receiptHash: Hex | null;
  finalizeTx: Hex | null;
  payoutTx: Hex | null;
  heldOut: number;
  carried: number;
  disputesUpheld: number;
  defaults: number;
  onchain: "pending" | "posting" | "finalized" | "settled" | "failed" | "skipped";
  error: string | null;
}

export interface PositionView {
  epoch: number;
  agentId: string;
  credit: string;
  debit: string;
  net: string;
  state: "flat" | "owes" | "settled" | "defaulted" | "creditor" | "paid";
}

export interface SettlementView {
  id: string;
  epoch: number;
  agentId: string;
  amount: string;
  status: SettlementStatus;
  hspMode: HspMode;
  hspPaymentId: Hex | null;
  hspStatus: string | null;
  hspOutcome: string | null;
  settlementTx: Hex | null;
  receiptHash: Hex | null;
  recordTx: Hex | null;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  deadline: number | null;
  error: string | null;
}

export interface PayoutView {
  epoch: number;
  agentId: string;
  to: Hex;
  amount: string;
  tx: Hex | null;
}

export interface DisputeView {
  id: string;
  jobId: string;
  iouDigest: Hex;
  epoch: number;
  buyer: string;
  seller: string;
  validator: string | null;
  reason: string;
  status: "open" | "upheld" | "rejected" | "expired";
  reasoning: string | null;
  filedAt: number;
  decidedAt: number | null;
  disputeHash: Hex;
  verdictSignature: Hex | null;
  onchainRequestTx: Hex | null;
  onchainResponseTx: Hex | null;
}

export interface IntentView {
  id: Hex; // intent digest
  operator: Hex;
  buyer: string;
  goal: string;
  budget: string;
  spent: string;
  perJobCap: string;
  minSellerReputation: number;
  allowedServices: string[];
  allowedSellers: string[];
  notBefore: number;
  deadline: number;
  status: "active" | "revoked" | "expired" | "exhausted";
  createdAt: number;
  revokedAt: number | null;
  jobs: number;
  refusals: number;
}

export interface HeadlineStats {
  agents: number;
  jobsCleared: number;
  iousCleared: number;
  epochsSealed: number;
  grossVolume: string;
  netVolume: string;
  valueSettledViaHsp: string;
  hspPayments: number;
  transfersAvoided: number;
  transferReduction: number;
  currentEpoch: number;
  epochPhase: EpochPhase;
  phaseEndsAt: number;
  chain: { key: string; id: number; name: string; explorer: string | null };
  hsp: { mode: HspMode; coordinatorUrl: string | null; healthy: boolean; note: string };
  deployment: Record<string, string> | null;
}

/** Events pushed over the live WebSocket. */
export type LiveEvent =
  | { type: "hello"; at: number; stats: HeadlineStats }
  | { type: "stats"; at: number; stats: HeadlineStats }
  | { type: "iou.accepted"; at: number; iou: IouView; job: JobView }
  | { type: "iou.refused"; at: number; buyer: string; seller: string; amount: string; service: string; reason: string; intentId: string | null }
  | { type: "job.delivered"; at: number; job: JobView }
  | { type: "dispute.opened"; at: number; dispute: DisputeView }
  | { type: "dispute.resolved"; at: number; dispute: DisputeView }
  | { type: "epoch.phase"; at: number; epoch: EpochView }
  | { type: "epoch.netted"; at: number; epoch: EpochView; positions: PositionView[] }
  | { type: "settlement.update"; at: number; settlement: SettlementView }
  | { type: "payout"; at: number; payouts: PayoutView[]; epoch: number }
  | { type: "reputation"; at: number; epoch: number; scores: { agentId: string; score: number; previous: number }[] }
  | { type: "intent"; at: number; intent: IntentView }
  | { type: "log"; at: number; level: "info" | "warn" | "error"; source: string; message: string };

/** A2A agent card (subset of the A2A spec) with Kohaku's pricing extension. */
export interface A2AAgentCard {
  protocolVersion: string;
  name: string;
  description: string;
  url: string;
  preferredTransport: "JSONRPC";
  version: string;
  provider: { organization: string; url: string };
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
    extensions: { uri: string; description: string; required: boolean; params: KohakuPricingExtension }[];
  };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: { id: string; name: string; description: string; tags: string[]; examples?: string[] }[];
}

export const KOHAKU_PRICING_EXTENSION = "https://kohaku.dev/a2a/ext/pricing/v1";

export interface KohakuPricingExtension {
  agentId: string;
  chainId: number;
  clearingHouse: Hex;
  token: Hex;
  clearingApi: string;
  prices: Record<string, { price: string; unit: string }>;
}

/** ERC-8004 registration file, the document the identity registry's tokenURI points at. */
export interface Erc8004Registration {
  type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";
  name: string;
  description: string;
  image: string;
  endpoints: { name: string; endpoint: string; version?: string }[];
  registrations: { agentId: number; agentRegistry: string }[];
  supportedTrust: string[];
}

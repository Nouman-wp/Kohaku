import type { Address, Hex } from "viem";
import type {
  AgentSummary,
  DisputeView,
  EpochView,
  HeadlineStats,
  IntentView,
  JobView,
  PaymentReport,
  SettlementOrder,
  SettlementView,
} from "@kohaku/core";

export interface ClearingConfig {
  chain: { key: string; id: number; name: string; explorer: string | null; rpc: string };
  deployment: {
    chainId: number;
    token: Address;
    identityRegistry: Address;
    collateralVault: Address;
    clearingHouse: Address;
    reputationRegistry: Address;
    validationRegistry: Address;
    mockToken: boolean;
    settlementWindow: number;
  };
  domain: { name: string; version: string; chainId: number; verifyingContract: Address };
  epochs: { intakeSeconds: number; challengeSeconds: number; disputeWindowSeconds: number; arbitrationTimeoutSeconds: number; settlementWindowSeconds: number };
  hsp: { mode: "local" | "coordinator"; coordinatorUrl: string | null; adapterAddress: string | null; chain: string; note: string };
  clearer: Address;
}

export type SubmitResult =
  | { ok: true; jobId: string; iouDigest: Hex; epoch: number; disputeWindowSeconds: number }
  | { ok: false; reason: string; currentEpoch?: number };

export class KohakuApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Thin typed client for the clearing service REST API. */
export class ClearingClient {
  constructor(readonly baseUrl: string) {}

  private async req<T>(method: "GET" | "POST", path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const res = await fetch(`${this.baseUrl.replace(/\/+$/, "")}${path}`, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) throw new KohakuApiError((json as { error?: string })?.error ?? `HTTP ${res.status}`, res.status);
    return json as T;
  }

  config = () => this.req<ClearingConfig>("GET", "/v1/config");
  stats = () => this.req<HeadlineStats>("GET", "/v1/stats");
  agents = (q: { capability?: string; maxPrice?: string; minReputation?: number; q?: string } = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "") p.set(k, String(v));
    return this.req<AgentSummary[]>("GET", `/v1/agents${p.size ? "?" + p.toString() : ""}`);
  };
  agent = (id: string) => this.req<{ agent: AgentSummary }>("GET", `/v1/agents/${id}`);
  nonce = (agentId: string) => this.req<{ nonce: string; epoch: number; intakeEndsAt: number }>("GET", `/v1/agents/${agentId}/nonce`);
  submitIou = (body: unknown) => this.req<SubmitResult>("POST", "/v1/ious", body);
  job = (id: string) => this.req<{ job: JobView; iou: { digest: Hex; status: string } | null; dispute: DisputeView | null }>("GET", `/v1/jobs/${id}`);
  deliver = (body: unknown) => this.req<{ ok: boolean; challengeEndsAt?: number }>("POST", "/v1/deliveries", body);
  fileDispute = (body: unknown) => this.req<DisputeView>("POST", "/v1/disputes", body);
  disputes = (q: { status?: string; validator?: string } = {}) => {
    const p = new URLSearchParams(q as Record<string, string>);
    return this.req<(DisputeView & { job: JobView })[]>("GET", `/v1/disputes?${p.toString()}`);
  };
  dispute = (id: string) => this.req<{ dispute: DisputeView; job: JobView; spec: unknown; quote: unknown; result: unknown }>("GET", `/v1/disputes/${id}`);
  verdict = (id: string, body: unknown) => this.req<DisputeView>("POST", `/v1/disputes/${id}/verdict`, body);
  createIntent = (body: unknown) => this.req<IntentView>("POST", "/v1/intents", body);
  intents = (q: { operator?: string; buyer?: string }) => this.req<IntentView[]>("GET", `/v1/intents?${new URLSearchParams(q as Record<string, string>).toString()}`);
  revokeIntent = (id: string, body: unknown) => this.req<IntentView>("POST", `/v1/intents/${id}/revoke`, body);
  settlements = (q: { agentId?: string; status?: string; epoch?: number }) =>
    this.req<(SettlementView & { order: SettlementOrder })[]>("GET", `/v1/settlements?${new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)] as [string, string])).toString()}`);
  reportPayment = (id: string, report: PaymentReport) => this.req<SettlementView>("POST", `/v1/settlements/${id}/paid`, report);
  epochs = (limit = 20) => this.req<EpochView[]>("GET", `/v1/epochs?limit=${limit}`);
  epoch = (id: number) => this.req<{ epoch: EpochView }>("GET", `/v1/epochs/${id}`);
}

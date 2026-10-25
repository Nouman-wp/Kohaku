import { useEffect, useState, useSyncExternalStore } from "react";
import type {
  AgentSummary,
  DisputeView,
  EpochView,
  HeadlineStats,
  IouView,
  JobView,
  LiveEvent,
  PayoutView,
  PositionView,
  SettlementView,
} from "@kohaku/core";

export const API = (import.meta.env.VITE_KOHAKU_API as string).replace(/\/+$/, "");
export const FLEET = (import.meta.env.VITE_KOHAKU_FLEET as string).replace(/\/+$/, "");
/** The live feed's own origin, for hosts that proxy REST but not WebSockets (Vercel). */
const LIVE = ((import.meta.env.VITE_KOHAKU_WS as string) || API.replace(/^http/, "ws")).replace(/\/+$/, "");

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error((json as { error?: string })?.error ?? `HTTP ${res.status}`);
  return json as T;
}

export async function fleet<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${FLEET}${path}`, { ...init, headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...(init?.headers ?? {}) } });
  const json = await res.json();
  if (!res.ok) throw new Error((json as { error?: string })?.error ?? `HTTP ${res.status}`);
  return json as T;
}

/** Fetch on mount and every `refreshMs` (0 = once). */
export function useApi<T>(path: string | null, refreshMs = 0): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    const load = () =>
      api<T>(path)
        .then((d) => {
          if (!alive) return;
          setData(d);
          setError(null);
        })
        .catch((e: Error) => alive && setError(e.message))
        .finally(() => alive && setLoading(false));
    void load();
    const t = refreshMs ? setInterval(load, refreshMs) : null;
    return () => {
      alive = false;
      if (t) clearInterval(t);
    };
  }, [path, refreshMs, tick]);
  return { data, error, loading, reload: () => setTick((x) => x + 1) };
}

/** GET /v1/epochs/:id */
export interface EpochDetail {
  epoch: EpochView;
  ious: IouView[];
  positions: PositionView[];
  settlements: SettlementView[];
  payouts: PayoutView[];
  disputes: DisputeView[];
  txs: { hash: string; kind: string; gas_used: number | null; at: number }[];
  explorer: string | null;
}

// ─────────────────────────────────────────────── live store (WebSocket)

export interface FloorIou {
  iou: IouView;
  job: JobView;
  at: number;
}

export interface LiveState {
  connected: boolean;
  stats: HeadlineStats | null;
  ious: FloorIou[];
  refusals: Extract<LiveEvent, { type: "iou.refused" }>[];
  deliveries: Map<string, number>;
  disputes: Map<string, DisputeView>;
  epochs: Map<number, EpochView>;
  netted: Map<number, PositionView[]>;
  settlements: Map<string, SettlementView>;
  payouts: Map<number, PayoutView[]>;
  reputation: Extract<LiveEvent, { type: "reputation" }>[];
  ticker: LiveEvent[];
  agents: AgentSummary[];
  version: number;
}

const state: LiveState = {
  connected: false,
  stats: null,
  ious: [],
  refusals: [],
  deliveries: new Map(),
  disputes: new Map(),
  epochs: new Map(),
  netted: new Map(),
  settlements: new Map(),
  payouts: new Map(),
  reputation: [],
  ticker: [],
  agents: [],
  version: 0,
};

let snapshot: LiveState = { ...state };
const listeners = new Set<() => void>();
let started = false;
let pending = false;

function emit() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    state.version++;
    snapshot = { ...state };
    listeners.forEach((l) => l());
  });
}

function apply(e: LiveEvent) {
  switch (e.type) {
    case "hello":
    case "stats":
      state.stats = e.stats;
      break;
    case "iou.accepted":
      state.ious = [{ iou: e.iou, job: e.job, at: e.at }, ...state.ious].slice(0, 600);
      break;
    case "iou.refused":
      state.refusals = [e, ...state.refusals].slice(0, 60);
      break;
    case "job.delivered":
      state.deliveries.set(e.job.id, e.at);
      break;
    case "dispute.opened":
    case "dispute.resolved":
      state.disputes = new Map(state.disputes).set(e.dispute.id, e.dispute);
      break;
    case "epoch.phase":
      state.epochs = new Map(state.epochs).set(e.epoch.id, e.epoch);
      break;
    case "epoch.netted":
      state.epochs = new Map(state.epochs).set(e.epoch.id, e.epoch);
      state.netted = new Map(state.netted).set(e.epoch.id, e.positions);
      break;
    case "settlement.update":
      state.settlements = new Map(state.settlements).set(e.settlement.id, e.settlement);
      break;
    case "payout":
      state.payouts = new Map(state.payouts).set(e.epoch, e.payouts);
      break;
    case "reputation":
      state.reputation = [e, ...state.reputation].slice(0, 40);
      for (const s of e.scores) {
        const a = state.agents.find((x) => x.agentId === s.agentId);
        if (a) a.reputation = s.score;
      }
      state.agents = [...state.agents];
      break;
    default:
      break;
  }
  if (e.type !== "stats" && e.type !== "hello" && e.type !== "log") state.ticker = [e, ...state.ticker].slice(0, 120);
}

function connect(delay = 0) {
  setTimeout(() => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${LIVE}/v1/live`);
    } catch {
      connect(Math.min(10_000, delay * 2 + 1_000));
      return;
    }
    ws.onopen = () => {
      state.connected = true;
      emit();
    };
    ws.onmessage = (m) => {
      try {
        apply(JSON.parse(m.data as string) as LiveEvent);
        emit();
      } catch {
        // ignore malformed frames
      }
    };
    ws.onclose = () => {
      state.connected = false;
      emit();
      connect(Math.min(10_000, delay * 2 + 1_000));
    };
    ws.onerror = () => ws.close();
  }, delay);
}

async function loadAgents() {
  try {
    state.agents = await api<AgentSummary[]>("/v1/agents");
    emit();
  } catch {
    // retried on the next tick
  }
}

async function loadRecent() {
  try {
    const epochs = await api<EpochView[]>("/v1/epochs?limit=30");
    const m = new Map(state.epochs);
    for (const e of epochs) if (!m.has(e.id)) m.set(e.id, e);
    state.epochs = m;
    const sealed = epochs.find((e) => e.phase === "sealed" && e.iouCount > 0);
    if (sealed && !state.netted.has(sealed.id)) {
      const d = await api<{ positions: PositionView[] }>(`/v1/epochs/${sealed.id}`);
      state.netted = new Map(state.netted).set(sealed.id, d.positions);
    }
    emit();
  } catch {
    // offline
  }
}

export function startLive() {
  if (started) return;
  started = true;
  connect();
  void loadAgents();
  void loadRecent();
  setInterval(loadAgents, 8_000);
}

export function useLive(): LiveState {
  startLive();
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
  );
}

export function agentName(agents: AgentSummary[], id: string | null | undefined): string {
  if (!id) return "?";
  return agents.find((a) => a.agentId === id)?.name ?? `#${id}`;
}

/** Current epoch phase with a countdown target. */
export function epochClock(s: LiveState): { epoch: EpochView | null; endsAt: number | null; label: string } {
  const cur = s.stats ? s.epochs.get(s.stats.currentEpoch) ?? null : null;
  if (!cur) return { epoch: null, endsAt: s.stats?.phaseEndsAt ?? null, label: "intake" };
  return { epoch: cur, endsAt: cur.intakeEndsAt, label: cur.phase };
}

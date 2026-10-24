import type { Address } from "viem";
import {
  KOHAKU_PRICING_EXTENSION,
  type A2AAgentCard,
  type Erc8004Registration,
  type ServiceListing,
} from "@kohaku/core";
import type { Chain, VaultAccount } from "./chain.ts";
import type { Db } from "./db.ts";
import { log } from "./bus.ts";

export interface AgentRecord {
  agentId: bigint;
  slug: string;
  name: string;
  description: string;
  role: string;
  operator: Address;
  signer: Address;
  status: "active" | "paused" | "retired";
  cardUrl: string;
  endpoint: string;
  services: ServiceListing[];
  isValidator: boolean;
  isFleet: boolean;
}

interface AgentRow {
  agent_id: number;
  slug: string;
  name: string;
  description: string;
  role: string;
  operator: string;
  signer: string;
  status: string;
  card_url: string;
  endpoint: string;
  services_json: string;
  is_validator: number;
  is_fleet: number;
}

/**
 * Mirror of the on-chain identity registry plus each agent's published card. The chain
 * is the source of truth for identity, operator, signer and status; the card (fetched
 * from the agent's tokenURI) supplies name, endpoint, services and prices.
 */
export class Registry {
  private agents = new Map<string, AgentRecord>();
  private bySignerMap = new Map<string, bigint>();
  private collateral = new Map<string, { at: number; acc: VaultAccount }>();
  private syncing = false;

  constructor(
    private readonly db: Db,
    private readonly chain: Chain,
  ) {
    for (const row of db.all<AgentRow>("SELECT * FROM agents")) {
      const rec = fromRow(row);
      this.agents.set(rec.agentId.toString(), rec);
      this.bySignerMap.set(rec.signer.toLowerCase(), rec.agentId);
    }
  }

  list(): AgentRecord[] {
    return [...this.agents.values()].sort((a, b) => (a.agentId < b.agentId ? -1 : 1));
  }

  get(agentId: bigint | string | number): AgentRecord | undefined {
    return this.agents.get(BigInt(agentId).toString());
  }

  bySigner(addr: string): AgentRecord | undefined {
    const id = this.bySignerMap.get(addr.toLowerCase());
    return id === undefined ? undefined : this.get(id);
  }

  /** Pull new agents and refresh existing ones from chain. Cheap enough to run every few seconds. */
  async sync(full = false): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const total = Number(await this.chain.totalAgents());
      for (let id = 1; id <= total; id++) {
        const known = this.agents.get(String(id));
        if (known && !full) continue;
        await this.refresh(BigInt(id));
      }
    } catch (err) {
      log("warn", "registry", `sync failed: ${(err as Error).message}`);
    } finally {
      this.syncing = false;
    }
  }

  async refresh(agentId: bigint): Promise<AgentRecord | undefined> {
    const on = await this.chain.agent(agentId);
    const prev = this.get(agentId);
    const card = await fetchCard(on.uri).catch(() => null);
    const rec: AgentRecord = {
      agentId,
      slug: card?.slug ?? prev?.slug ?? `agent-${agentId}`,
      name: card?.name ?? prev?.name ?? `Agent #${agentId}`,
      description: card?.description ?? prev?.description ?? "",
      role: card?.role ?? prev?.role ?? "agent",
      operator: on.operator,
      signer: on.signer,
      status: on.status,
      cardUrl: on.uri,
      endpoint: card?.endpoint ?? prev?.endpoint ?? "",
      services: card?.services ?? prev?.services ?? [],
      isValidator: card?.isValidator ?? prev?.isValidator ?? false,
      isFleet: card?.isFleet ?? prev?.isFleet ?? false,
    };
    if (prev && prev.signer.toLowerCase() !== rec.signer.toLowerCase()) this.bySignerMap.delete(prev.signer.toLowerCase());
    this.agents.set(agentId.toString(), rec);
    this.bySignerMap.set(rec.signer.toLowerCase(), agentId);
    const now = Date.now();
    this.db.run(
      `INSERT INTO agents(agent_id, slug, name, description, role, operator, signer, status, card_url, endpoint, services_json, is_validator, is_fleet, registered_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(agent_id) DO UPDATE SET slug=excluded.slug, name=excluded.name, description=excluded.description, role=excluded.role,
         operator=excluded.operator, signer=excluded.signer, status=excluded.status, card_url=excluded.card_url, endpoint=excluded.endpoint,
         services_json=excluded.services_json, is_validator=excluded.is_validator, is_fleet=excluded.is_fleet, updated_at=excluded.updated_at`,
      Number(agentId),
      rec.slug,
      rec.name,
      rec.description,
      rec.role,
      rec.operator,
      rec.signer,
      rec.status,
      rec.cardUrl,
      rec.endpoint,
      JSON.stringify(rec.services),
      rec.isValidator ? 1 : 0,
      rec.isFleet ? 1 : 0,
      now,
      now,
    );
    if (!prev) log("info", "registry", `agent #${agentId} ${rec.name} (${rec.role}) joined`);
    return rec;
  }

  // ---------------------------------------------------------------- collateral cache

  async collateralOf(agentId: bigint, maxAgeMs = 4_000): Promise<VaultAccount> {
    const key = agentId.toString();
    const hit = this.collateral.get(key);
    if (hit && Date.now() - hit.at < maxAgeMs) return hit.acc;
    const acc = await this.chain.vaultAccount(agentId);
    this.collateral.set(key, { at: Date.now(), acc });
    return acc;
  }

  cachedCollateral(agentId: bigint): VaultAccount | undefined {
    return this.collateral.get(agentId.toString())?.acc;
  }

  async refreshCollateral(ids: bigint[]): Promise<void> {
    await Promise.all(ids.map((id) => this.collateralOf(id, 0).catch(() => undefined)));
  }

  priceOf(agentId: bigint, serviceId: string): bigint | undefined {
    const svc = this.get(agentId)?.services.find((s) => s.id === serviceId);
    return svc ? BigInt(svc.price) : undefined;
  }
}

function fromRow(r: AgentRow): AgentRecord {
  return {
    agentId: BigInt(r.agent_id),
    slug: r.slug,
    name: r.name,
    description: r.description,
    role: r.role,
    operator: r.operator as Address,
    signer: r.signer as Address,
    status: r.status as AgentRecord["status"],
    cardUrl: r.card_url,
    endpoint: r.endpoint,
    services: JSON.parse(r.services_json) as ServiceListing[],
    isValidator: !!r.is_validator,
    isFleet: !!r.is_fleet,
  };
}

interface FetchedCard {
  slug: string;
  name: string;
  description: string;
  role: string;
  endpoint: string;
  services: ServiceListing[];
  isValidator: boolean;
  isFleet: boolean;
}

/**
 * Resolve tokenURI -> ERC-8004 registration file -> A2A agent card. The registration may
 * also be the A2A card itself; both shapes are accepted.
 */
async function fetchCard(uri: string): Promise<FetchedCard | null> {
  if (!/^https?:\/\//.test(uri)) return null;
  const first = (await getJson(uri)) as Partial<Erc8004Registration & A2AAgentCard & { kohaku?: Record<string, unknown> }>;
  let card: Partial<A2AAgentCard & { kohaku?: Record<string, unknown> }> = first;
  if (first.type?.includes("eip-8004")) {
    const a2a = first.endpoints?.find((e) => e.name.toLowerCase() === "a2a");
    if (a2a) card = (await getJson(a2a.endpoint)) as typeof card;
  }
  const ext = card.capabilities?.extensions?.find((e) => e.uri === KOHAKU_PRICING_EXTENSION);
  const prices = ext?.params?.prices ?? {};
  const services: ServiceListing[] = (card.skills ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    price: prices[s.id]?.price ?? "0",
    unit: prices[s.id]?.unit ?? "call",
    tags: s.tags ?? [],
  }));
  const k = (card.kohaku ?? first.kohaku ?? {}) as Record<string, unknown>;
  return {
    slug: String(k.slug ?? card.name?.toLowerCase().replace(/[^a-z0-9]+/g, "-") ?? "agent"),
    name: card.name ?? first.name ?? "Agent",
    description: card.description ?? first.description ?? "",
    role: String(k.role ?? "agent"),
    endpoint: card.url ?? "",
    services,
    isValidator: Boolean(k.validator),
    isFleet: Boolean(k.fleet),
  };
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(4_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

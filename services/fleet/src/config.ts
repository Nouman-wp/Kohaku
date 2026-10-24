import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { concat, keccak256, stringToHex, type Hex } from "viem";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "../../..");

function loadDotEnv(): void {
  const file = resolve(REPO_ROOT, ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]!] !== undefined) continue;
    process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

// Well-known anvil development keys. Only ever used when KOHAKU_CHAIN=local.
const ANVIL_1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const ANVIL_2 = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
// Development seed for local runs only; any public deployment must set FLEET_SEED.
const DEV_SEED = keccak256(stringToHex("kohaku-dev-fleet-seed"));

export interface FleetConfig {
  chain: string;
  port: number;
  publicUrl: string;
  clearingUrl: string;
  rpcUrl?: string;
  seed: Hex;
  operatorKey: Hex;
  rogueOperatorKey: Hex;
  adminToken: string;
  background: boolean;
  backgroundIntervalSeconds: number;
  collateralTarget: bigint;
  orchestratorCollateral: bigint;
  walletTarget: bigint;
  gasTarget: bigint;
  rogueBadRate: number;
  guestSessionsPerHour: number;
  hspMode: "local" | "coordinator";
  hsp: { sdkPath?: string; coordinatorUrl?: string; apiKey?: string; chainName?: string };
}

export function loadFleetConfig(): FleetConfig {
  loadDotEnv();
  const e = process.env;
  const chain = e.KOHAKU_CHAIN ?? "local";
  const local = chain === "local";
  const need = (name: string, fallback?: string): Hex => {
    const v = e[name] ?? (local ? fallback : undefined);
    if (!v || !/^0x[0-9a-fA-F]{64}$/.test(v)) throw new Error(`${name} must be set to a 32-byte hex key on ${chain}`);
    return v as Hex;
  };
  const units = (v: string | undefined, d: string) => BigInt(Math.round(Number(v ?? d) * 1e6));
  return {
    chain,
    port: Number(e.FLEET_PORT ?? 8788),
    publicUrl: (e.PUBLIC_FLEET_URL ?? "http://localhost:8788").replace(/\/+$/, ""),
    clearingUrl: (e.CLEARING_URL ?? `http://localhost:${e.PORT ?? 8787}`).replace(/\/+$/, ""),
    rpcUrl: e.RPC_URL,
    seed: need("FLEET_SEED", DEV_SEED),
    operatorKey: need("FLEET_OPERATOR_KEY", ANVIL_1),
    rogueOperatorKey: need("ROGUE_OPERATOR_KEY", ANVIL_2),
    adminToken: e.ADMIN_TOKEN ?? "kohaku-admin",
    background: (e.FLEET_BACKGROUND ?? "on") !== "off",
    backgroundIntervalSeconds: Number(e.BACKGROUND_INTERVAL_SECONDS ?? 40),
    collateralTarget: units(e.COLLATERAL_TARGET, local ? "25" : "3"),
    orchestratorCollateral: units(e.ORCHESTRATOR_COLLATERAL, local ? "100" : "10"),
    walletTarget: units(e.WALLET_TARGET, local ? "20" : "2"),
    gasTarget: BigInt(Math.round(Number(e.GAS_TARGET ?? (local ? "0.5" : "0.02")) * 1e18)),
    rogueBadRate: Number(e.ROGUE_BAD_RATE ?? 0.5),
    guestSessionsPerHour: Number(e.GUEST_SESSIONS_PER_HOUR ?? 20),
    hspMode: (e.HSP_MODE ?? "local") === "coordinator" ? "coordinator" : "local",
    hsp: { sdkPath: e.HSP_SDK_PATH, coordinatorUrl: e.HSP_COORDINATOR_URL, apiKey: e.HSP_API_KEY, chainName: e.HSP_CHAIN_NAME },
  };
}

/** Deterministic per-agent keys from the fleet seed. */
export function agentKey(seed: Hex, slug: string): Hex {
  return keccak256(concat([seed, stringToHex(`kohaku/agent/${slug}`)]));
}

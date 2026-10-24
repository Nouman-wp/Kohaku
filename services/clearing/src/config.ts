import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ChainKey, Deployment, HspMode } from "@kohaku/core";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "../../..");

/** Minimal .env loader so the service runs with plain `pnpm clearing`. Real env wins. */
export function loadDotEnv(file = resolve(REPO_ROOT, ".env")): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, key, raw] = m as unknown as [string, string, string];
    if (process.env[key] !== undefined) continue;
    process.env[key] = raw.replace(/^["']|["']$/g, "");
  }
}

const hexKey = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte private key");

const schema = z.object({
  KOHAKU_CHAIN: z.enum(["local", "hashkey-testnet", "hashkey"]).default("local"),
  RPC_URL: z.string().optional(),
  CLEARER_PRIVATE_KEY: hexKey,
  PORT: z.coerce.number().default(8787),
  PUBLIC_API_URL: z.string().default("http://localhost:8787"),
  DATA_DIR: z.string().default(resolve(REPO_ROOT, ".data")),
  EPOCH_INTAKE_SECONDS: z.coerce.number().min(10).default(75),
  DISPUTE_WINDOW_SECONDS: z.coerce.number().min(3).default(12),
  EPOCH_CHALLENGE_SECONDS: z.coerce.number().min(5).default(18),
  ARBITRATION_TIMEOUT_SECONDS: z.coerce.number().min(3).default(15),
  POST_CHUNK_SIZE: z.coerce.number().min(1).max(400).default(120),
  WRITE_REPUTATION_ONCHAIN: z.enum(["true", "false"]).default("true"),
  HSP_MODE: z.enum(["local", "coordinator"]).default("local"),
  HSP_COORDINATOR_URL: z.string().optional(),
  HSP_API_KEY: z.string().optional(),
  HSP_CHAIN_NAME: z.string().optional(),
  HSP_ADAPTER_ADDRESS: z.string().optional(),
  HSP_SDK_PATH: z.string().optional(),
  HSP_LOCAL_ADAPTER_KEY: hexKey.optional(),
  HSP_WEBHOOK_SECRET: z.string().min(16).default("kohaku-local-webhook-secret-change-me"),
  FLEET_CONTROL_URL: z.string().default("http://localhost:8788"),
  ADMIN_TOKEN: z.string().min(8).default("kohaku-admin"),
  CORS_ORIGIN: z.string().default("*"),
});

export type Config = z.infer<typeof schema> & {
  chain: ChainKey;
  rpcUrl: string;
  deployment: Deployment;
  hspMode: HspMode;
};

export function loadConfig(): Config {
  loadDotEnv();
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid clearing service configuration:\n${issues}`);
  }
  const env = parsed.data;
  const chain = env.KOHAKU_CHAIN as ChainKey;
  const deployment = loadDeployment(chain);
  const defaultRpc = chain === "hashkey" ? "https://mainnet.hsk.xyz" : chain === "hashkey-testnet" ? "https://testnet.hsk.xyz" : "http://127.0.0.1:8545";
  return {
    ...env,
    chain,
    rpcUrl: env.RPC_URL ?? defaultRpc,
    deployment,
    hspMode: env.HSP_MODE,
  };
}

export function deploymentPath(chain: ChainKey): string {
  const id = chain === "hashkey" ? 177 : chain === "hashkey-testnet" ? 133 : 31337;
  return resolve(REPO_ROOT, "contracts", "deployments", `${id}.json`);
}

export function loadDeployment(chain: ChainKey): Deployment {
  const file = deploymentPath(chain);
  if (!existsSync(file)) {
    throw new Error(`No deployment for ${chain} at ${file}. Run \`pnpm deploy:${chain === "local" ? "local" : chain === "hashkey" ? "mainnet" : "testnet"}\` first.`);
  }
  return JSON.parse(readFileSync(file, "utf8")) as Deployment;
}

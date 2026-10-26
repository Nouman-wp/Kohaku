import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { concat, keccak256, stringToHex, type Hex } from "viem";
import { HSP_BASE_URLS, HSP_DEFAULT_BASE_URL, HSP_TOKENS, type ChainKey, type Deployment, type HspMode } from "@kohaku/core";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "../../..");

/** The env file in use: KOHAKU_ENV_FILE (e.g. .env.testnet) or .env. */
export function envFile(): string {
  return resolve(REPO_ROOT, process.env.KOHAKU_ENV_FILE ?? ".env");
}

/** Minimal .env loader so the service runs with plain `pnpm clearing`. Real env wins. */
export function loadDotEnv(file = envFile()): void {
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
  REPUTATION_EPOCH_STRIDE: z.coerce.number().min(1).default(1),
  /** local: Kohaku's own gateway serving HashKey Merchant's API. merchant: HashKey Merchant itself. */
  HSP_MODE: z.enum(["local", "merchant"]).default("local"),
  HSP_BASE_URL: z.string().optional(),
  HSP_APP_KEY: z.string().optional(),
  HSP_APP_SECRET: z.string().optional(),
  HSP_MERCHANT_NAME: z.string().default("Kohaku"),
  /** secp256k1 key (0x-hex or PEM) that signs merchant_authorization; its public PEM is registered with HashKey */
  HSP_MERCHANT_PRIVATE_KEY: z.string().optional(),
  HSP_NETWORK: z.string().optional(),
  HSP_COIN: z.string().default("USDC"),
  HSP_CART_TTL_SECONDS: z.coerce.number().min(60).default(7200),
  HSP_REDIRECT_URL: z.string().optional(),
  /** local gateway only: the key that relays EIP-3009 authorizations (pays their gas) */
  HSP_GATEWAY_RELAYER_KEY: hexKey.optional(),
  /** quiet epochs stay open until the first IOU arrives, so an idle clearing house spends no gas */
  EPOCH_EXTEND_IDLE: z.enum(["true", "false"]).optional(),
  FLEET_CONTROL_URL: z.string().default("http://localhost:8788"),
  /** the fleet's public base; cards under it are fetched from FLEET_CONTROL_URL directly */
  PUBLIC_FLEET_URL: z.string().optional(),
  ADMIN_TOKEN: z.string().min(8).default("kohaku-admin"),
  CORS_ORIGIN: z.string().default("*"),
  /** optional Supabase mirror of this database: project URL and its secret key (server side only) */
  SUPABASE_URL: z.string().optional(),
  SUPABASE_SECRET_KEY: z.string().optional(),
});

export type Config = z.infer<typeof schema> & {
  chain: ChainKey;
  rpcUrl: string;
  deployment: Deployment;
  hspMode: HspMode;
  hspAppKey: string;
  hspAppSecret: string;
  hspMerchantKey: string;
  hspRelayerKey: Hex;
  extendIdleEpochs: boolean;
};

/** A stable secret derived from the clearer key, for local defaults that need no setup. */
function derived(clearerKey: string, label: string): Hex {
  return keccak256(concat([clearerKey as Hex, stringToHex(`kohaku/${label}`)]));
}

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
  const hspBaseUrl = (env.HSP_BASE_URL || (env.HSP_MODE === "merchant" ? HSP_DEFAULT_BASE_URL[chain] : undefined))?.replace(/\/+$/, "");
  if (env.HSP_MODE === "merchant") checkMerchantSetup(env, chain, deployment, hspBaseUrl);
  return {
    ...env,
    HSP_BASE_URL: hspBaseUrl,
    chain,
    rpcUrl: env.RPC_URL ?? defaultRpc,
    deployment,
    hspMode: env.HSP_MODE,
    hspAppKey: env.HSP_APP_KEY ?? "kohaku-local-gateway",
    hspAppSecret: env.HSP_APP_SECRET ?? derived(env.CLEARER_PRIVATE_KEY, "hsp-app-secret"),
    hspMerchantKey: env.HSP_MERCHANT_PRIVATE_KEY ?? derived(env.CLEARER_PRIVATE_KEY, "hsp-merchant-key"),
    hspRelayerKey: (env.HSP_GATEWAY_RELAYER_KEY ?? derived(env.CLEARER_PRIVATE_KEY, "hsp-gateway-relayer")) as Hex,
    extendIdleEpochs: env.EPOCH_EXTEND_IDLE ? env.EPOCH_EXTEND_IDLE === "true" : chain !== "local",
  };
}

/** HSP_MODE=merchant against HashKey: credentials present, the right host for the chain, and a token HashKey settles by EIP-3009. */
function checkMerchantSetup(env: z.infer<typeof schema>, chain: ChainKey, deployment: Deployment, baseUrl: string | undefined): void {
  const missing = [...(baseUrl ? [] : ["HSP_BASE_URL"]), ...(["HSP_APP_KEY", "HSP_APP_SECRET", "HSP_MERCHANT_PRIVATE_KEY"] as const).filter((k) => !env[k])];
  if (missing.length) throw new Error(`HSP_MODE=merchant needs ${missing.join(", ")} (from HashKey Merchant onboarding)`);
  if (deployment.mockToken) throw new Error("HSP_MODE=merchant settles in a token HashKey supports; this deployment uses the test token. Redeploy with SETTLEMENT_TOKEN set.");
  // HashKey's QA host serves testnet tokens; staging and production serve mainnet tokens only
  const mainnetHost = baseUrl === HSP_BASE_URLS.staging || baseUrl === HSP_BASE_URLS.production;
  if (chain === "hashkey" && baseUrl === HSP_BASE_URLS.qa) throw new Error(`HSP_BASE_URL ${baseUrl} is HashKey's testnet (QA) host; mainnet uses ${HSP_BASE_URLS.production}`);
  if (chain === "hashkey-testnet" && mainnetHost) throw new Error(`HSP_BASE_URL ${baseUrl} serves mainnet tokens only; testnet uses ${HSP_BASE_URLS.qa}`);
  const tokens = HSP_TOKENS[chain];
  if (!tokens) return;
  const t = tokens.find((x) => x.address.toLowerCase() === deployment.token.toLowerCase());
  const usable = tokens.filter((x) => x.protocol === "eip3009").map((x) => `${x.coin} ${x.address}`).join(", ");
  if (!t || t.protocol !== "eip3009") throw new Error(`HSP_MODE=merchant: settlement token ${deployment.token} is not one HashKey Merchant settles by EIP-3009 on ${chain} (${usable})`);
  if (env.HSP_COIN !== t.coin) throw new Error(`HSP_COIN=${env.HSP_COIN}, but HashKey Merchant lists ${deployment.token} as ${t.coin}`);
}

/** This deployment's ledger: names its SQLite file and tags its rows in the Supabase mirror. */
export function ledgerName(cfg: Pick<Config, "chain" | "deployment">): string {
  return `kohaku-${cfg.chain}-${cfg.deployment.clearingHouse.slice(2, 10).toLowerCase()}`;
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

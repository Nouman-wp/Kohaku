import { keccak256, concat, stringToHex, type Hex } from "viem";
import { kohakuDomain, HSP_CHAIN_NAMES } from "@kohaku/core";
import { loadConfig } from "./config.ts";
import { Db } from "./db.ts";
import { Chain } from "./chain.ts";
import { Registry } from "./registry.ts";
import { ReputationBook } from "./reputation.ts";
import { Intents } from "./intents.ts";
import { Ledger } from "./ledger.ts";
import { EpochEngine } from "./epochs.ts";
import { Settlements } from "./settlements.ts";
import { LocalHsp } from "./hsp/local.ts";
import { CoordinatorHsp } from "./hsp/coordinator.ts";
import type { HspPort } from "./hsp/port.ts";
import { buildApi } from "./api.ts";
import { bus, log } from "./bus.ts";
import { headlineStats } from "./stats.ts";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const chain = new Chain(cfg.chain, cfg.rpcUrl, cfg.CLEARER_PRIVATE_KEY as Hex, cfg.deployment);
  if (!(await chain.ping())) throw new Error(`cannot reach ${cfg.chain} RPC at ${cfg.rpcUrl}: ${chain.lastError}`);

  // one database per deployment, so a redeploy never mixes ledgers
  const db = new Db(cfg.DATA_DIR, `kohaku-${cfg.chain}-${cfg.deployment.clearingHouse.slice(2, 10).toLowerCase()}.sqlite`);
  const domain = kohakuDomain(chain.viemChain.id, cfg.deployment.clearingHouse);

  const registry = new Registry(db, chain);
  await registry.sync(true);
  const rep = new ReputationBook(db);
  const intents = new Intents(db, registry, domain);

  let hsp: HspPort;
  if (cfg.hspMode === "coordinator") {
    if (!cfg.HSP_COORDINATOR_URL) throw new Error("HSP_MODE=coordinator needs HSP_COORDINATOR_URL (and HSP_API_KEY)");
    const c = new CoordinatorHsp(chain.publicClient, cfg.HSP_COORDINATOR_URL, cfg.HSP_API_KEY, cfg.HSP_CHAIN_NAME ?? HSP_CHAIN_NAMES[cfg.chain], cfg.HSP_ADAPTER_ADDRESS, cfg.HSP_SDK_PATH);
    await c.init();
    hsp = c;
  } else {
    const adapterKey = (cfg.HSP_LOCAL_ADAPTER_KEY ?? keccak256(concat([cfg.CLEARER_PRIVATE_KEY as Hex, stringToHex("kohaku/hsp-local-adapter")]))) as Hex;
    hsp = new LocalHsp(chain.publicClient, chain.viemChain.id, HSP_CHAIN_NAMES[cfg.chain], adapterKey, {
      url: `http://127.0.0.1:${cfg.PORT}/v1/hsp/webhook`,
      secret: cfg.HSP_WEBHOOK_SECRET,
    });
  }
  let hspHealthy = await hsp.health();

  // eslint-disable-next-line prefer-const
  let epochs: EpochEngine;
  const settlements = new Settlements(db, chain, registry, hsp, () => void epochs.flushReputation());
  epochs = new EpochEngine(db, chain, registry, rep, intents, settlements, {
    intakeSeconds: cfg.EPOCH_INTAKE_SECONDS,
    challengeSeconds: cfg.EPOCH_CHALLENGE_SECONDS,
    arbitrationTimeoutSeconds: cfg.ARBITRATION_TIMEOUT_SECONDS,
    postChunkSize: cfg.POST_CHUNK_SIZE,
    writeReputation: cfg.WRITE_REPUTATION_ONCHAIN === "true",
    publicUrl: cfg.PUBLIC_API_URL,
  });
  const ledger = new Ledger(db, registry, intents, rep, chain, domain, cfg.deployment.token, { disputeWindowSeconds: cfg.DISPUTE_WINDOW_SECONDS, publicUrl: cfg.PUBLIC_API_URL }, () =>
    epochs.intake(),
  );
  await epochs.start();

  const app = await buildApi({ cfg, db, chain, registry, rep, intents, ledger, epochs, settlements, hsp, domain, hspHealthy: () => hspHealthy });
  await app.listen({ port: cfg.PORT, host: "0.0.0.0" });

  setInterval(() => void registry.sync(), 5_000);
  setInterval(() => void settlements.tick().catch((err) => log("warn", "settlement", (err as Error).message)), 2_000);
  setInterval(() => void chain.ping(), 10_000);
  setInterval(async () => {
    hspHealthy = await hsp.health();
  }, 15_000);
  setInterval(() => {
    try {
      bus.publish({ type: "stats", at: Date.now(), stats: headlineStats(db, chain, hsp, epochs, registry, hspHealthy) });
    } catch {
      // stats are best effort
    }
  }, 2_000);

  log("info", "clearing", `Kohaku clearing service on :${cfg.PORT} | chain ${cfg.chain} (${chain.viemChain.id}) | clearing house ${cfg.deployment.clearingHouse} | HSP ${hsp.mode}`);

  const shutdown = async () => {
    epochs.stop();
    await app.close();
    db.raw.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

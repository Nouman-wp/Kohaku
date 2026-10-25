import type { Hex } from "viem";
import { kohakuDomain, HSP_CHAIN_NAMES } from "@kohaku/core";
import { mockUsdcAbi } from "@kohaku/core/abis";
import { merchantKey } from "@kohaku/core/hsp-node";
import { loadConfig } from "./config.ts";
import { Db } from "./db.ts";
import { Chain } from "./chain.ts";
import { Registry } from "./registry.ts";
import { ReputationBook } from "./reputation.ts";
import { Intents } from "./intents.ts";
import { Ledger } from "./ledger.ts";
import { EpochEngine } from "./epochs.ts";
import { Settlements } from "./settlements.ts";
import { HspMerchantClient, MerchantHsp } from "./hsp/merchant.ts";
import { LocalHspGateway } from "./hsp/gateway.ts";
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
  if (cfg.PUBLIC_FLEET_URL && cfg.PUBLIC_FLEET_URL !== cfg.FLEET_CONTROL_URL) {
    registry.routes = [[`${cfg.PUBLIC_FLEET_URL.replace(/\/+$/, "")}/`, `${cfg.FLEET_CONTROL_URL.replace(/\/+$/, "")}/`]];
  }
  await registry.sync(true);
  const rep = new ReputationBook(db);
  const intents = new Intents(db, registry, domain);

  // HSP: the clearing service is the merchant. In local mode it also runs the gateway that
  // stands in for HashKey Merchant (same API); in merchant mode it talks to HashKey.
  const read = <T,>(functionName: string, fallback: T) =>
    chain.publicClient.readContract({ address: cfg.deployment.token, abi: mockUsdcAbi, functionName } as never).then((v) => v as T, () => fallback);
  const token = {
    address: cfg.deployment.token,
    name: await read<string>("name", "USD Coin"),
    symbol: await read<string>("symbol", "USDC"),
    version: await read<string>("version", "2"),
    decimals: await read<number>("decimals", 6),
  };
  const network = cfg.HSP_NETWORK ?? HSP_CHAIN_NAMES[cfg.chain];
  const key = merchantKey(cfg.hspMerchantKey);
  const local = cfg.hspMode === "local";
  const gatewayPublic = `${cfg.PUBLIC_API_URL.replace(/\/+$/, "")}/hsp`;
  const api = new HspMerchantClient({
    baseUrl: local ? `http://127.0.0.1:${cfg.PORT}/hsp` : cfg.HSP_BASE_URL!.replace(/\/+$/, ""),
    appKey: cfg.hspAppKey,
    appSecret: cfg.hspAppSecret,
    merchantName: cfg.HSP_MERCHANT_NAME,
    merchantKey: key,
  });
  const gateway = local
    ? new LocalHspGateway(db, chain.publicClient, {
        chain: chain.viemChain,
        rpcUrl: cfg.rpcUrl,
        network,
        token,
        relayerKey: cfg.hspRelayerKey,
        merchant: { appKey: cfg.hspAppKey, appSecret: cfg.hspAppSecret, publicKey: key, webhookUrl: `http://127.0.0.1:${cfg.PORT}/v1/hsp/webhook` },
        publicUrl: gatewayPublic,
      })
    : undefined;
  const hsp = new MerchantHsp(chain.publicClient, api, {
    mode: cfg.hspMode,
    chainId: chain.viemChain.id,
    network,
    coin: cfg.HSP_COIN,
    decimals: token.decimals,
    payerGatewayUrl: local ? gatewayPublic : cfg.HSP_BASE_URL!.replace(/\/+$/, ""),
    redirectUrl: cfg.HSP_REDIRECT_URL,
    cartTtlSeconds: cfg.HSP_CART_TTL_SECONDS,
    note: local
      ? `HSP local gateway: Kohaku serves HashKey Merchant's API itself (cart mandate → payment mandate → EIP-3009 transfer relayed on chain → signed webhook). Transfers are real on-chain payments of ${token.symbol}; HashKey is not involved. Relayer ${gateway!.relayerAddress}.`
      : `HashKey Merchant (HSP) at ${cfg.HSP_BASE_URL}, merchant "${cfg.HSP_MERCHANT_NAME}". Debtors pay through HSP; HSP relays each EIP-3009 authorization on chain.`,
  });
  let hspHealthy = false;
  if (gateway && cfg.chain === "local") {
    // on a devnet the clearer has plenty: keep the gateway's relayer topped up
    const bal = await chain.publicClient.getBalance({ address: gateway.relayerAddress });
    if (bal < 10n ** 18n) await chain.sendValue(gateway.relayerAddress, 10n ** 19n);
  }

  // eslint-disable-next-line prefer-const
  let epochs: EpochEngine;
  const settlements = new Settlements(db, chain, registry, hsp, () => void epochs.flushReputation());
  epochs = new EpochEngine(db, chain, registry, rep, intents, settlements, {
    intakeSeconds: cfg.EPOCH_INTAKE_SECONDS,
    challengeSeconds: cfg.EPOCH_CHALLENGE_SECONDS,
    arbitrationTimeoutSeconds: cfg.ARBITRATION_TIMEOUT_SECONDS,
    postChunkSize: cfg.POST_CHUNK_SIZE,
    writeReputation: cfg.WRITE_REPUTATION_ONCHAIN === "true",
    reputationStride: cfg.REPUTATION_EPOCH_STRIDE,
    publicUrl: cfg.PUBLIC_API_URL,
    extendIdle: cfg.extendIdleEpochs,
  });
  const ledger = new Ledger(db, registry, intents, rep, chain, domain, cfg.deployment.token, { disputeWindowSeconds: cfg.DISPUTE_WINDOW_SECONDS, publicUrl: cfg.PUBLIC_API_URL }, () =>
    epochs.intake(),
  );
  await epochs.start();

  const app = await buildApi({ cfg, db, chain, registry, rep, intents, ledger, epochs, settlements, hsp, gateway, domain, hspHealthy: () => hspHealthy });
  await app.listen({ port: cfg.PORT, host: "0.0.0.0" });
  hspHealthy = await hsp.health();

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

  log("info", "clearing", `Kohaku clearing service on :${cfg.PORT} | chain ${cfg.chain} (${chain.viemChain.id}) | clearing house ${cfg.deployment.clearingHouse} | HSP ${local ? "local gateway" : `merchant ${cfg.HSP_BASE_URL}`}${hspHealthy ? "" : " (unreachable)"}`);

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

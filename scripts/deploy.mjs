#!/usr/bin/env node
// Deploy the Kohaku contracts.
//   node scripts/deploy.mjs local            anvil, mock token
//   node scripts/deploy.mjs hashkey-testnet  HashKey Chain testnet (133), verified on Blockscout
//   node scripts/deploy.mjs hashkey          HashKey Chain mainnet (177), verified on Blockscout
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ANVIL_KEYS, ROOT, bin, loadEnv, runToEnd } from "./lib.mjs";

const NETWORKS = {
  local: { rpc: "http://127.0.0.1:8545", id: 31337 },
  "hashkey-testnet": { rpc: "https://testnet.hsk.xyz", id: 133, verifier: "https://testnet-explorer.hsk.xyz/api/" },
  hashkey: { rpc: "https://mainnet.hsk.xyz", id: 177, verifier: "https://hashkey.blockscout.com/api/" },
};

export async function deploy(network) {
  const net = NETWORKS[network];
  if (!net) throw new Error(`unknown network ${network}; use local, hashkey-testnet or hashkey`);
  const env = { ...loadEnv(), ...process.env };
  const key = env.DEPLOYER_PRIVATE_KEY || (network === "local" ? ANVIL_KEYS[0] : "");
  if (!key) throw new Error("set DEPLOYER_PRIVATE_KEY in .env");
  if (network === "hashkey" && !env.SETTLEMENT_TOKEN) {
    console.warn("SETTLEMENT_TOKEN is empty: a MockUSDC would be deployed on mainnet. Set it to the stablecoin to settle in.");
    throw new Error("refusing to deploy a mock token to mainnet");
  }
  // the contracts must trust the key the clearing service will actually run with
  let clearer = env.CLEARER_ADDRESS || "";
  if (!clearer && env.CLEARER_PRIVATE_KEY) {
    clearer = execFileSync(bin("cast"), ["wallet", "address", "--private-key", env.CLEARER_PRIVATE_KEY], { encoding: "utf8" }).trim();
    console.log(`clearer (from CLEARER_PRIVATE_KEY): ${clearer}`);
  }
  const args = ["script", "script/Deploy.s.sol:Deploy", "--rpc-url", env.RPC_URL && network !== "local" ? env.RPC_URL : net.rpc, "--broadcast", "--slow"];
  if (net.verifier) args.push("--verify", "--verifier", "blockscout", "--verifier-url", net.verifier);
  await runToEnd("deploy", bin("forge"), args, {
    cwd: join(ROOT, "contracts"),
    env: {
      DEPLOYER_PRIVATE_KEY: key,
      SETTLEMENT_TOKEN: env.SETTLEMENT_TOKEN ?? "",
      ...(clearer ? { CLEARER_ADDRESS: clearer } : {}),
      ...(env.OWNER_ADDRESS ? { OWNER_ADDRESS: env.OWNER_ADDRESS } : {}),
      SETTLEMENT_WINDOW: env.SETTLEMENT_WINDOW ?? "120",
      WITHDRAWAL_DELAY: env.WITHDRAWAL_DELAY ?? "600",
    },
  });
  const file = join(ROOT, "contracts", "deployments", `${net.id}.json`);
  if (!existsSync(file)) throw new Error("deployment file missing");
  return JSON.parse(readFileSync(file, "utf8"));
}

if (process.argv[1]?.endsWith("deploy.mjs")) {
  deploy(process.argv[2] ?? "local")
    .then((d) => {
      console.log("\nDeployed:");
      for (const [k, v] of Object.entries(d)) console.log(`  ${k.padEnd(20)} ${v}`);
    })
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}

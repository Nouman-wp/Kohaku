#!/usr/bin/env node
// Top up the service wallets of a public deployment with native gas (HSK) from the deployer.
// Each wallet is brought up to its target, never above it, so it is safe to run again.
//
//   node scripts/fund.mjs testnet           show balances and send what is missing
//   node scripts/fund.mjs testnet --dry     show what would be sent
//
// Agents need no gas (HSP relays their settlements); the fleet operator funds the validator.
import { addressOf, cast, loadEnv, useNetworkEnv } from "./lib.mjs";

const network = process.argv[2] ?? "testnet";
const dry = process.argv.includes("--dry");
useNetworkEnv(network);
const env = loadEnv();
const rpc = env.RPC_URL || (network === "mainnet" ? "https://mainnet.hsk.xyz" : "https://testnet.hsk.xyz");
if (!env.DEPLOYER_PRIVATE_KEY) throw new Error(`no DEPLOYER_PRIVATE_KEY in .env.${network}; run node scripts/wallets.mjs ${network}`);

// HSK targets. Testnet gas is ~1 gwei: 0.1 HSK is ~100M gas, many busy epochs.
const TARGETS = {
  testnet: { CLEARER_PRIVATE_KEY: "0.3", HSP_GATEWAY_RELAYER_KEY: "0.05", FLEET_OPERATOR_KEY: "0.05", ROGUE_OPERATOR_KEY: "0.01" },
  mainnet: { CLEARER_PRIVATE_KEY: "20", HSP_GATEWAY_RELAYER_KEY: "2", FLEET_OPERATOR_KEY: "5", ROGUE_OPERATOR_KEY: "1" },
}[network];
const LABEL = { CLEARER_PRIVATE_KEY: "clearing service", HSP_GATEWAY_RELAYER_KEY: "HSP gateway relayer", FLEET_OPERATOR_KEY: "fleet operator", ROGUE_OPERATOR_KEY: "rogue operator" };
if (env.HSP_MODE === "merchant") delete TARGETS.HSP_GATEWAY_RELAYER_KEY; // HashKey relays

const wei = (eth) => BigInt(cast(["to-wei", eth]));
const fmt = (w) => cast(["from-wei", w.toString()]);
const balance = (addr) => BigInt(cast(["balance", addr, "--rpc-url", rpc]));

const deployer = addressOf(env.DEPLOYER_PRIVATE_KEY);
let available = balance(deployer);
console.log(`${network}: deployer ${deployer} has ${fmt(available)} HSK`);
for (const [name, target] of Object.entries(TARGETS)) {
  if (!env[name]) {
    console.log(`  skip ${LABEL[name]}: ${name} not set`);
    continue;
  }
  const to = addressOf(env[name]);
  const have = balance(to);
  const missing = wei(target) - have;
  if (missing <= 0n) {
    console.log(`  ok   ${LABEL[name].padEnd(20)} ${to}  ${fmt(have)} HSK`);
    continue;
  }
  const reserve = wei(network === "mainnet" ? "1" : "0.005"); // keep enough for the deployer's own transactions
  const send = missing < available - reserve ? missing : available - reserve;
  if (send <= 0n) {
    console.log(`  LOW  ${LABEL[name].padEnd(20)} ${to}  has ${fmt(have)}, needs ${fmt(missing)} more: deployer is out of HSK`);
    continue;
  }
  if (dry) {
    console.log(`  send ${LABEL[name].padEnd(20)} ${to}  +${fmt(send)} HSK (dry run)`);
    continue;
  }
  const out = cast(["send", "--rpc-url", rpc, "--private-key", env.DEPLOYER_PRIVATE_KEY, "--value", send.toString(), to, "--json"]);
  const tx = JSON.parse(out).transactionHash;
  available -= send;
  console.log(`  sent ${LABEL[name].padEnd(20)} ${to}  +${fmt(send)} HSK  ${tx}`);
}
console.log(`deployer left with ${fmt(balance(deployer))} HSK`);

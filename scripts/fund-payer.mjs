#!/usr/bin/env node
// Fund the wallet that pays at the demo stores' HSP checkout with HSP's test USDC, from the
// fleet operator (where HSP sends the team's test tokens). HSP's guide makes funding the
// payer a manual step for the team, so this is a script you run yourself.
//
//   node scripts/fund-payer.mjs testnet                 show balances: operator and this PC's MCP wallet
//   node scripts/fund-payer.mjs testnet 20              send 20 USDC to this PC's MCP wallet
//   node scripts/fund-payer.mjs testnet 20 0xPAYER      send 20 USDC to another wallet
//
// "This PC's MCP wallet" is the guest agent the Kohaku MCP server runs as, saved in
// ~/.kohaku/guest-<chain id>.json the first time Claude uses Kohaku.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { addressOf, cast, loadEnv, useNetworkEnv } from "./lib.mjs";

const network = process.argv[2] ?? "testnet";
const amount = process.argv[3];
useNetworkEnv(network);
const env = loadEnv();
const mainnet = network === "mainnet";
const rpc = env.RPC_URL || (mainnet ? "https://mainnet.hsk.xyz" : "https://testnet.hsk.xyz");
const chainId = mainnet ? 177 : 133;
// HSP's USDC on HashKey Chain, as listed by HSP Agentic Payment's get_chain_config
const TOKEN = env.SHOP_TOKEN_ADDRESS || (mainnet ? "0x054ed45810DbBAb8B27668922D110669c9D88D0a" : "0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6");
if (!env.FLEET_OPERATOR_KEY) throw new Error(`no FLEET_OPERATOR_KEY in .env.${network}`);

const guestFile = join(homedir(), ".kohaku", `guest-${chainId}.json`);
const guest = existsSync(guestFile) ? JSON.parse(readFileSync(guestFile, "utf8")).address : null;
const to = process.argv[4] ?? guest;
const operator = addressOf(env.FLEET_OPERATOR_KEY);
const balance = (who) => BigInt(cast(["call", TOKEN, "balanceOf(address)(uint256)", who, "--rpc-url", rpc]).split(/\s/)[0]);
const usdc = (units) => `${(Number(units) / 1e6).toFixed(6)} USDC`;

console.log(`token     ${TOKEN} (HSP's USDC on chain ${chainId})`);
console.log(`operator  ${operator}  ${usdc(balance(operator))}`);
if (guest) console.log(`MCP payer ${guest}  ${usdc(balance(guest))}  (${guestFile})`);
else console.log(`MCP payer none yet: use Kohaku from Claude once, then run this again`);

if (amount) {
  if (!to || !/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error("no payer address: pass one, or use Kohaku from Claude first");
  const units = BigInt(Math.round(Number(amount) * 1e6));
  if (!(units > 0n)) throw new Error(`bad amount ${amount}`);
  if (balance(operator) < units) throw new Error(`the operator holds less than ${amount} USDC; ask HSP for test tokens first`);
  const out = JSON.parse(cast(["send", TOKEN, "transfer(address,uint256)", to, units.toString(), "--private-key", env.FLEET_OPERATOR_KEY, "--rpc-url", rpc, "--json"]));
  console.log(`sent ${amount} USDC to ${to}: tx ${out.transactionHash} (${out.status === "0x1" ? "ok" : "failed"})`);
  console.log(`payer now ${usdc(balance(to))}`);
}

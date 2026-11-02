#!/usr/bin/env node
// Fund the wallet that pays at the demo stores' HSP checkout with HSP's test USDC, from the
// fleet operator (where HSP sends the team's test tokens). HSP's guide makes funding the
// payer a manual step for the team, so this is a script you run yourself.
//
// The checkout pays on SHOP_CHAIN_ID (default: Kohaku's own chain). On Ethereum, Base or
// Arbitrum Sepolia, HSP takes Circle's test USDC: claim it for the payer at
// https://faucet.circle.com, then run this script to check the balance.
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
// HSP's USDC per network, as listed by HSP Agentic Payment's get_chain_config
const HSP_USDC = {
  177: ["https://mainnet.hsk.xyz", "0x054ed45810DbBAb8B27668922D110669c9D88D0a", "HashKey Chain"],
  133: [rpc, "0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6", "HashKey Chain Testnet"],
  11155111: ["https://ethereum-sepolia-rpc.publicnode.com", "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", "Ethereum Sepolia"],
  84532: ["https://sepolia.base.org", "0x036CbD53842c5426634e7929541eC2318f3dCF7e", "Base Sepolia"],
  421614: ["https://sepolia-rollup.arbitrum.io/rpc", "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", "Arbitrum Sepolia"],
};
const payChain = Number(env.SHOP_CHAIN_ID || chainId);
if (!HSP_USDC[payChain]) throw new Error(`no HSP USDC known for chain ${payChain}`);
const [payRpc, knownToken, payName] = HSP_USDC[payChain];
const TOKEN = env.SHOP_TOKEN_ADDRESS || knownToken;
if (!env.FLEET_OPERATOR_KEY) throw new Error(`no FLEET_OPERATOR_KEY in .env.${network}`);

const guestFile = join(homedir(), ".kohaku", `guest-${chainId}.json`);
const guest = existsSync(guestFile) ? JSON.parse(readFileSync(guestFile, "utf8")).address : null;
const to = process.argv[4] ?? guest;
const operator = addressOf(env.FLEET_OPERATOR_KEY);
const balance = (who) => BigInt(cast(["call", TOKEN, "balanceOf(address)(uint256)", who, "--rpc-url", payRpc]).split(/\s/)[0]);
const usdc = (units) => `${(Number(units) / 1e6).toFixed(6)} USDC`;

console.log(`token     ${TOKEN} (HSP's USDC on ${payName}, chain ${payChain})`);
console.log(`operator  ${operator}  ${usdc(balance(operator))}`);
if (guest) console.log(`MCP payer ${guest}  ${usdc(balance(guest))}  (${guestFile})`);
else console.log(`MCP payer none yet: use Kohaku from Claude once, then run this again`);
if (payChain !== 177 && payChain !== 133 && !amount) console.log(`claim test USDC for the payer at https://faucet.circle.com (${payName})`);

if (amount) {
  if (!to || !/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error("no payer address: pass one, or use Kohaku from Claude first");
  const units = BigInt(Math.round(Number(amount) * 1e6));
  if (!(units > 0n)) throw new Error(`bad amount ${amount}`);
  if (balance(operator) < units) throw new Error(`the operator holds less than ${amount} USDC on ${payName}; get test tokens first`);
  const out = JSON.parse(cast(["send", TOKEN, "transfer(address,uint256)", to, units.toString(), "--private-key", env.FLEET_OPERATOR_KEY, "--rpc-url", payRpc, "--json"]));
  console.log(`sent ${amount} USDC to ${to}: tx ${out.transactionHash} (${out.status === "0x1" ? "ok" : "failed"})`);
  console.log(`payer now ${usdc(balance(to))}`);
}

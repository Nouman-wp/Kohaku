import { defineChain, type Chain } from "viem";

export type ChainKey = "local" | "hashkey-testnet" | "hashkey";

export const hashkey = defineChain({
  id: 177,
  name: "HashKey Chain",
  nativeCurrency: { name: "HashKey", symbol: "HSK", decimals: 18 },
  rpcUrls: { default: { http: ["https://mainnet.hsk.xyz"] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://hashkey.blockscout.com" } },
});

export const hashkeyTestnet = defineChain({
  id: 133,
  name: "HashKey Chain Testnet",
  nativeCurrency: { name: "HashKey", symbol: "HSK", decimals: 18 },
  rpcUrls: { default: { http: ["https://testnet.hsk.xyz"] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://testnet-explorer.hsk.xyz" } },
  testnet: true,
});

export const localChain = defineChain({
  id: 31337,
  name: "Local (anvil)",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
  testnet: true,
});

export const CHAINS: Record<ChainKey, Chain> = {
  local: localChain,
  "hashkey-testnet": hashkeyTestnet,
  hashkey,
};

/** HSP's name for each network, as used by the Coordinator (`GET /chains`). */
export const HSP_CHAIN_NAMES: Record<ChainKey, string> = {
  local: "local",
  "hashkey-testnet": "hashkey-testnet",
  hashkey: "hashkey",
};

export function chainKeyFromId(id: number): ChainKey {
  if (id === 177) return "hashkey";
  if (id === 133) return "hashkey-testnet";
  return "local";
}

export function explorerTx(chain: ChainKey, hash: string): string | null {
  const base = CHAINS[chain].blockExplorers?.default.url;
  return base ? `${base}/tx/${hash}` : null;
}

export function explorerAddress(chain: ChainKey, address: string): string | null {
  const base = CHAINS[chain].blockExplorers?.default.url;
  return base ? `${base}/address/${address}` : null;
}

export interface Deployment {
  chainId: number;
  deployedAtBlock: number;
  deployer: `0x${string}`;
  owner: `0x${string}`;
  clearer: `0x${string}`;
  mockToken: boolean;
  token: `0x${string}`;
  identityRegistry: `0x${string}`;
  collateralVault: `0x${string}`;
  clearingHouse: `0x${string}`;
  reputationRegistry: `0x${string}`;
  validationRegistry: `0x${string}`;
  settlementWindow: number;
  withdrawalDelay: number;
}

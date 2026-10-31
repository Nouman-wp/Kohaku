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
  blockExplorers: { default: { name: "Blockscout", url: "https://testnet-explorer.hskchain.net" } },
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

/** HSP's network name, carried in a cart mandate's x402 method data (override with HSP_NETWORK). */
export const HSP_CHAIN_NAMES: Record<ChainKey, string> = {
  local: "local",
  "hashkey-testnet": "hashkey-testnet",
  hashkey: "hashkey",
};

/** HashKey Merchant hosts, as HashKey's HSP docs list them (hashkey-merchant.github.io). */
export const HSP_BASE_URLS = {
  /** testnet tokens */
  qa: "https://merchant-qa.hashkeymerchant.com",
  /** mainnet tokens */
  staging: "https://merchant-stg.hashkeymerchant.com",
  /** mainnet tokens */
  production: "https://hsp.hashkey.com",
} as const;

/** The HashKey Merchant host a chain settles through unless HSP_BASE_URL says otherwise. */
export const HSP_DEFAULT_BASE_URL: Partial<Record<ChainKey, string>> = {
  "hashkey-testnet": HSP_BASE_URLS.qa,
  hashkey: HSP_BASE_URLS.production,
};

export interface HspToken {
  coin: string;
  address: `0x${string}`;
  decimals: number;
  protocol: "eip3009" | "permit2";
}

/**
 * The HashKey Chain tokens HashKey Merchant settles, from its onboarding table. Kohaku's
 * debtors pay with EIP-3009 authorizations, so only USDC can settle; USDT there uses Permit2.
 */
export const HSP_TOKENS: Partial<Record<ChainKey, HspToken[]>> = {
  "hashkey-testnet": [
    { coin: "USDC", address: "0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6", decimals: 6, protocol: "eip3009" },
    { coin: "USDT", address: "0x372325443233fEbaC1F6998aC750276468c83CC6", decimals: 6, protocol: "permit2" },
  ],
  hashkey: [
    { coin: "USDC", address: "0x054ed45810DbBAb8B27668922D110669c9D88D0a", decimals: 6, protocol: "eip3009" },
    { coin: "USDT", address: "0xf1b50ed67a9e2cc94ad3c477779e2d4cbfff9029", decimals: 6, protocol: "permit2" },
  ],
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

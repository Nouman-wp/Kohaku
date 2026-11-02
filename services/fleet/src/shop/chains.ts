/**
 * Public RPCs, explorers and faucets for the test networks HSP Agentic Payment supports
 * (its get_chain_config on QA lists these). The clearing house always runs on HashKey Chain;
 * only the shopping checkout can pay on another HSP network, chosen with SHOP_CHAIN_ID.
 * SHOP_RPC_URL overrides the RPC.
 */
export interface ShopChain {
  rpc: string;
  explorer: string;
  /** where a team can get the test token HSP accepts on this network */
  faucet: string | null;
}

export const SHOP_CHAINS: Record<number, ShopChain> = {
  11155111: { rpc: "https://ethereum-sepolia-rpc.publicnode.com", explorer: "https://sepolia.etherscan.io", faucet: "https://faucet.circle.com (Ethereum Sepolia, USDC)" },
  84532: { rpc: "https://sepolia.base.org", explorer: "https://sepolia.basescan.org", faucet: "https://faucet.circle.com (Base Sepolia, USDC)" },
  421614: { rpc: "https://sepolia-rollup.arbitrum.io/rpc", explorer: "https://sepolia.arbiscan.io", faucet: "https://faucet.circle.com (Arbitrum Sepolia, USDC)" },
  97: { rpc: "https://bsc-testnet-rpc.publicnode.com", explorer: "https://testnet.bscscan.com", faucet: null },
  133: { rpc: "https://testnet.hsk.xyz", explorer: "https://testnet-explorer.hskchain.net", faucet: null },
  177: { rpc: "https://mainnet.hsk.xyz", explorer: "https://hashkey.blockscout.com", faucet: null },
};

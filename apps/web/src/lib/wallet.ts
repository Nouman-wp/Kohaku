import { useEffect, useState } from "react";
import { createPublicClient, createWalletClient, custom, http, type Address, type Hex, type PublicClient, type WalletClient, type Chain } from "viem";
import { CHAINS, chainKeyFromId } from "@kohaku/core";
import { api } from "./api.ts";

export interface KohakuConfig {
  chain: { key: string; id: number; name: string; explorer: string | null; rpc: string };
  deployment: {
    token: Address;
    identityRegistry: Address;
    collateralVault: Address;
    clearingHouse: Address;
    reputationRegistry: Address;
    validationRegistry: Address;
    mockToken: boolean;
    settlementWindow: number;
    withdrawalDelay: number;
  };
  domain: { name: string; version: string; chainId: number; verifyingContract: Address };
  epochs: { intakeSeconds: number; challengeSeconds: number; disputeWindowSeconds: number; settlementWindowSeconds: number };
  hsp: { mode: string; note: string; gatewayUrl: string; merchantName: string; network: string };
  clearer: Address;
}

type Eip1193 = { request: (a: { method: string; params?: unknown[] }) => Promise<unknown>; on?: (e: string, f: (...a: unknown[]) => void) => void };

declare global {
  interface Window {
    ethereum?: Eip1193;
  }
}

let cfgPromise: Promise<KohakuConfig> | null = null;
export function loadConfig(): Promise<KohakuConfig> {
  cfgPromise ??= api<KohakuConfig>("/v1/config");
  return cfgPromise;
}

export function useConfig(): KohakuConfig | null {
  const [cfg, setCfg] = useState<KohakuConfig | null>(null);
  useEffect(() => {
    loadConfig()
      .then(setCfg)
      .catch(() => (cfgPromise = null));
  }, []);
  return cfg;
}

export function chainFor(cfg: KohakuConfig): Chain {
  const base = CHAINS[chainKeyFromId(cfg.chain.id)];
  return { ...base, rpcUrls: { default: { http: [cfg.chain.rpc] } } };
}

export function publicClientFor(cfg: KohakuConfig): PublicClient {
  return createPublicClient({ chain: chainFor(cfg), transport: http(cfg.chain.rpc) }) as PublicClient;
}

export interface WalletState {
  available: boolean;
  address: Address | null;
  chainId: number | null;
  client: WalletClient | null;
  error: string | null;
  connect: () => Promise<void>;
  switchChain: () => Promise<void>;
}

export function useWallet(cfg: KohakuConfig | null): WalletState {
  const [address, setAddress] = useState<Address | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const eth = typeof window !== "undefined" ? window.ethereum : undefined;

  useEffect(() => {
    if (!eth) return;
    eth.request({ method: "eth_accounts" }).then((a) => setAddress(((a as string[])[0] as Address) ?? null)).catch(() => undefined);
    eth.request({ method: "eth_chainId" }).then((c) => setChainId(Number(c))).catch(() => undefined);
    eth.on?.("accountsChanged", (a) => setAddress(((a as string[])[0] as Address) ?? null));
    eth.on?.("chainChanged", (c) => setChainId(Number(c)));
  }, [eth]);

  const client = eth && address && cfg ? createWalletClient({ account: address, chain: chainFor(cfg), transport: custom(eth) }) : null;

  return {
    available: !!eth,
    address,
    chainId,
    client,
    error,
    connect: async () => {
      if (!eth) {
        setError("No browser wallet found. Install MetaMask or a compatible wallet.");
        return;
      }
      try {
        const a = (await eth.request({ method: "eth_requestAccounts" })) as string[];
        setAddress((a[0] as Address) ?? null);
        setChainId(Number(await eth.request({ method: "eth_chainId" })));
        setError(null);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    switchChain: async () => {
      if (!eth || !cfg) return;
      const hex = `0x${cfg.chain.id.toString(16)}`;
      try {
        await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
      } catch {
        await eth.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: hex,
              chainName: cfg.chain.name,
              nativeCurrency: { name: cfg.chain.id === 31337 ? "Ether" : "HashKey", symbol: cfg.chain.id === 31337 ? "ETH" : "HSK", decimals: 18 },
              rpcUrls: [cfg.chain.rpc],
              blockExplorerUrls: cfg.chain.explorer ? [cfg.chain.explorer] : [],
            },
          ],
        });
      }
    },
  };
}

export async function sendTx(wallet: WalletClient, pub: PublicClient, params: { address: Address; abi: readonly unknown[]; functionName: string; args: readonly unknown[] }): Promise<Hex> {
  const { request } = await pub.simulateContract({ ...(params as object), account: wallet.account } as never);
  const hash = await wallet.writeContract(request as never);
  await pub.waitForTransactionReceipt({ hash });
  return hash;
}

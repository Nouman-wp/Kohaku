import { useEffect, useState } from "react";
import { createPublicClient, http, type Address, type Hex, type PublicClient, type WalletClient, type Chain } from "viem";
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

// useWallet and the connect button live in wallet-kit.tsx (RainbowKit + wagmi)

export async function sendTx(wallet: WalletClient, pub: PublicClient, params: { address: Address; abi: readonly unknown[]; functionName: string; args: readonly unknown[] }): Promise<Hex> {
  const { request } = await pub.simulateContract({ ...(params as object), account: wallet.account } as never);
  const hash = await wallet.writeContract(request as never);
  await pub.waitForTransactionReceipt({ hash });
  return hash;
}

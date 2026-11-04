// Wallet connection through RainbowKit + wagmi. Only the pages that need a wallet (the operator
// console and the intent composer) load this module, so the rest of the site stays light.
//
// MetaMask on a phone: RainbowKit's MetaMask option uses the MetaMask SDK there, which opens the
// MetaMask app, asks for approval and hands the connection back to the browser. It needs no
// WalletConnect project id. OKX, Trust, Rainbow, the WalletConnect QR code and other mobile wallets
// go through WalletConnect and appear once VITE_WALLETCONNECT_PROJECT_ID is set (free at
// dashboard.reown.com, with the site's domains on the project's allowlist).
import "@rainbow-me/rainbowkit/styles.css";
import { useEffect, useState, type ReactNode } from "react";
import { ConnectButton, RainbowKitProvider, connectorsForWallets, darkTheme, useConnectModal, type Theme } from "@rainbow-me/rainbowkit";
import { injectedWallet, metaMaskWallet, okxWallet, rainbowWallet, trustWallet, walletConnectWallet } from "@rainbow-me/rainbowkit/wallets";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider, createConfig, http, useAccount, useSwitchChain } from "wagmi";
import { createWalletClient, custom, type Address, type Chain, type EIP1193Provider, type WalletClient } from "viem";
import { CHAINS } from "@kohaku/core";
import { chainFor, useConfig, type KohakuConfig } from "./wallet.ts";
import { short } from "./format.ts";
import { Btn } from "../components/ui.tsx";

const API = import.meta.env.VITE_KOHAKU_API as string;
const LOCAL = /\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(API);
// the deployment chain comes from /v1/config at runtime; wagmi needs the list up front
const chains: readonly [Chain, ...Chain[]] = LOCAL ? [CHAINS["hashkey-testnet"], CHAINS.hashkey, CHAINS.local] : [CHAINS["hashkey-testnet"], CHAINS.hashkey];

// Without a project id, WalletConnect refuses our origin, so the modal lists only what works without
// it. RainbowKit still needs some id to build its connectors; "YOUR_PROJECT_ID" is its placeholder.
const wcProjectId = (import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined)?.trim() || null;
const projectId = wcProjectId ?? "YOUR_PROJECT_ID";
const origin = typeof window !== "undefined" ? window.location.origin : "https://kohaku.caspx.in";
const hasInjected = typeof window !== "undefined" && !!(window as { ethereum?: unknown }).ethereum;

// On a desktop without the extension, RainbowKit's MetaMask entry shows a WalletConnect QR code;
// with no project id that QR never loads, so offer the extension download instead. (RainbowKit
// sets qrCode exactly in that case: no MetaMask injected and not a phone.)
const metaMaskOnly: typeof metaMaskWallet = (options) => {
  const wallet = metaMaskWallet(options);
  return wallet.qrCode ? { ...wallet, qrCode: undefined, installed: false } : wallet;
};
// "Browser Wallet" catches injected wallets that don't announce themselves; pointless without one
const injected = hasInjected ? [injectedWallet] : [];

const connectors = connectorsForWallets(
  wcProjectId
    ? [
        { groupName: "Recommended", wallets: [metaMaskWallet, okxWallet, walletConnectWallet] },
        { groupName: "More wallets", wallets: [rainbowWallet, trustWallet, ...injected] },
      ]
    : [{ groupName: "Recommended", wallets: [metaMaskOnly, ...injected] }],
  {
    appName: "Kohaku",
    appDescription: "The clearing house for agent-to-agent payments on HashKey Chain",
    appUrl: origin,
    appIcon: `${origin}/logo-512.png`,
    projectId,
  },
);

const wagmiConfig = createConfig({
  chains,
  connectors,
  transports: Object.fromEntries(chains.map((c) => [c.id, http()])),
});

const queryClient = new QueryClient();

const base = darkTheme({ accentColor: "#b8f34d", accentColorForeground: "#0d1500", borderRadius: "large", overlayBlur: "small" });
const theme: Theme = {
  ...base,
  colors: {
    ...base.colors,
    modalBackground: "#0a0a0a",
    modalBorder: "#1e1e1e",
    modalBackdrop: "rgba(0, 0, 0, 0.72)",
    modalText: "#ececea",
    modalTextSecondary: "#a4a4a0",
    modalTextDim: "#8a8a84",
    generalBorder: "#1e1e1e",
    generalBorderDim: "#161616",
    menuItemBackground: "#1a1a1a",
    actionButtonBorder: "#1e1e1e",
    actionButtonBorderMobile: "#1e1e1e",
    actionButtonSecondaryBackground: "#111111",
    closeButton: "#a4a4a0",
    closeButtonBackground: "#111111",
    profileForeground: "#0a0a0a",
    profileAction: "#111111",
    profileActionHover: "#1a1a1a",
    selectedOptionBorder: "rgba(184, 243, 77, 0.34)",
    downloadTopCardBackground: "linear-gradient(126deg, rgba(184, 243, 77, 0.16) 9.49%, rgba(0, 0, 0, 0) 71.04%), #0a0a0a",
    downloadBottomCardBackground: "linear-gradient(126deg, rgba(184, 243, 77, 0.08) 9.49%, rgba(0, 0, 0, 0) 71.04%), #0a0a0a",
    standby: "#f5b544",
  },
  fonts: { body: '"Inter Variable", "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
  radii: { ...base.radii, modal: "16px", modalMobile: "16px", menuButton: "10px", actionButton: "999px", connectButton: "999px" },
  shadows: { ...base.shadows, dialog: "0 24px 80px rgba(0, 0, 0, 0.6)" },
};

/** Wallet providers and the RainbowKit modal; wrap each page that uses useWallet. */
export function WalletKit({ children }: { children: ReactNode }) {
  const cfg = useConfig();
  const initialChain = cfg && chains.some((c) => c.id === cfg.chain.id) ? cfg.chain.id : undefined;
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={theme} initialChain={initialChain} appInfo={{ appName: "Kohaku", learnMoreUrl: "https://ethereum.org/en/wallets/" }}>
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
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

/** The connected wallet. Same shape as before RainbowKit, so the pages did not change. */
export function useWallet(cfg: KohakuConfig | null): WalletState {
  const { address, chainId, connector, isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();
  const { switchChainAsync } = useSwitchChain();
  const [client, setClient] = useState<WalletClient | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A viem client pinned to the deployment chain, built on the connector's own provider (the
  // extension, the MetaMask SDK on a phone, or WalletConnect): viem refuses to send a transaction
  // while the wallet sits on another chain, exactly as before.
  useEffect(() => {
    if (!isConnected || !address || !connector || !cfg) {
      setClient(null);
      return;
    }
    let live = true;
    connector
      .getProvider()
      .then((provider) => {
        if (live) setClient(createWalletClient({ account: address, chain: chainFor(cfg), transport: custom(provider as EIP1193Provider) }));
      })
      .catch((e) => live && setError(firstLine(e)));
    return () => {
      live = false;
    };
  }, [isConnected, address, connector, cfg]);

  return {
    available: true,
    address: isConnected && address ? address : null,
    chainId: isConnected ? (chainId ?? null) : null,
    client,
    error,
    connect: async () => {
      setError(null);
      openConnectModal?.();
    },
    switchChain: async () => {
      if (!cfg) return;
      try {
        setError(null);
        // wagmi adds the chain to the wallet first when the wallet does not know it yet
        await switchChainAsync({ chainId: cfg.chain.id });
      } catch (e) {
        setError(firstLine(e));
      }
    },
  };
}

/** Connect button in the site's style; once connected, the address chip opens the account modal. */
export function WalletButton({ label = "Connect wallet" }: { label?: string }) {
  return (
    <ConnectButton.Custom>
      {({ account, mounted, openConnectModal, openAccountModal }) =>
        mounted && account ? (
          <button type="button" className="chip wallet-chip" onClick={openAccountModal} title="Wallet: copy the address or disconnect">
            <span className="live-dot" aria-hidden /> <span className="mono">{short(account.address, 4)}</span>
          </button>
        ) : (
          <Btn variant="accent" onClick={openConnectModal} disabled={!mounted}>
            {label}
          </Btn>
        )
      }
    </ConnectButton.Custom>
  );
}

function firstLine(e: unknown): string {
  const err = e as { shortMessage?: string; message?: string };
  return (err.shortMessage ?? err.message ?? String(e)).split("\n")[0]!;
}

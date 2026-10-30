import { useEffect, useState } from "react";
import { Link } from "react-router";
import { isAddress, isAddressEqual, parseEventLogs, type Address } from "viem";
import { REVOCATION_TYPES, usd as toUnits, type AgentSummary, type IntentView } from "@kohaku/core";
import { collateralVaultAbi, erc20Abi, identityRegistryAbi, mockUsdcAbi } from "@kohaku/core/abis";
import { API, api, useLive } from "../lib/api.ts";
import { usd, short, explorerTx } from "../lib/format.ts";
import { publicClientFor, sendTx, useConfig, useWallet, type KohakuConfig, type WalletState } from "../lib/wallet.ts";
import { AgentGem, Btn, Empty, HashLink, PageHead, Panel, Pill, Stat, Stats } from "../components/ui.tsx";
import { IntentRow } from "./Agents.tsx";

export default function Console() {
  const cfg = useConfig();
  const wallet = useWallet(cfg);
  const live = useLive();
  const [msg, setMsg] = useState<{ text: string; tx?: string; bad?: boolean } | null>(null);
  const mine = live.agents.filter((a) => wallet.address && isAddressEqual(a.operator as Address, wallet.address));
  const wrongChain = cfg && wallet.chainId !== null && wallet.chainId !== cfg.chain.id;

  const act = async (label: string, fn: () => Promise<string | void>) => {
    setMsg({ text: `${label}…` });
    try {
      const tx = await fn();
      setMsg({ text: `${label}: done`, tx: tx ?? undefined });
    } catch (e) {
      setMsg({ text: `${label} failed: ${(e as Error).message.split("\n")[0]}`, bad: true });
    }
  };

  return (
    <main className="page">
      <div className="page-inner">
        <PageHead
          title="Operator console"
          sub="Register agents, post and withdraw collateral, sign or revoke intents, and see live exposure and earnings. Every action is a transaction or a signature from your wallet."
          actions={
            <>
              {!wallet.address ? (
                <Btn variant="accent" onClick={wallet.connect}>
                  Connect wallet
                </Btn>
              ) : (
                <span className="chip">
                  <span className="live-dot" aria-hidden /> <span className="mono">{short(wallet.address, 4)}</span>
                </span>
              )}
              {wrongChain && (
                <Btn variant="secondary" onClick={wallet.switchChain}>
                  Switch to {cfg?.chain.name}
                </Btn>
              )}
            </>
          }
        />
        <div aria-live="polite">
          {wallet.error && (
            <div className="notice warn" style={{ marginBottom: 16 }}>
              {wallet.error}
            </div>
          )}
          {msg && (
            <div className={`notice ${msg.bad ? "warn" : ""}`} style={{ marginBottom: 16 }}>
              {msg.text} {msg.tx && <HashLink hash={msg.tx} href={explorerTx(cfg?.chain.explorer, msg.tx)} n={6} />}
            </div>
          )}
        </div>
        {!wallet.address && (
          <Panel>
            <p className="dim" style={{ maxWidth: 720 }}>
              Connect the wallet that operates your agents. Judges: the public fleet is operated by Kohaku’s own keys, so you can browse everything without connecting, or register an agent of your
              own on {cfg?.chain.name ?? "the network"}.
            </p>
          </Panel>
        )}
        {wallet.address && cfg && wallet.client && (
          <>
            <TokenBar cfg={cfg} wallet={wallet} act={act} />
            <div className="grid grid-2">
              <RegisterAgent cfg={cfg} wallet={wallet} act={act} />
              <Panel title={`Agents you operate (${mine.length})`}>
                {mine.map((a) => (
                  <ManageAgent key={a.agentId} a={a} cfg={cfg} wallet={wallet} act={act} />
                ))}
                {!mine.length && <Empty>No agents operated by {short(wallet.address, 4)} yet.</Empty>}
              </Panel>
            </div>
          </>
        )}
      </div>
    </main>
  );
}

type Act = (label: string, fn: () => Promise<string | void>) => Promise<void>;

function TokenBar({ cfg, wallet, act }: { cfg: KohakuConfig; wallet: WalletState; act: Act }) {
  const [bal, setBal] = useState<bigint | null>(null);
  const pub = publicClientFor(cfg);
  useEffect(() => {
    const load = () =>
      pub
        .readContract({ address: cfg.deployment.token, abi: erc20Abi, functionName: "balanceOf", args: [wallet.address!] })
        .then((b) => setBal(b as bigint))
        .catch(() => undefined);
    void load();
    const t = setInterval(load, 6_000);
    return () => clearInterval(t);
  }, [wallet.address]);
  return (
    <Stats>
      <Stat label="Your stablecoin balance" value={bal === null ? "—" : usd(bal)} hint={cfg.deployment.mockToken ? "mock token on this network" : cfg.deployment.token} />
      <Stat label="Network" value={cfg.chain.name} hint={`chain id ${cfg.chain.id}`} />
      <div className="stat" style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {cfg.deployment.mockToken ? (
          <Btn onClick={() => act("Mint 100 test USDC", () => sendTx(wallet.client!, pub, { address: cfg.deployment.token, abi: mockUsdcAbi, functionName: "mint", args: [wallet.address!, 100_000_000n] }))}>
            Mint 100 test USDC
          </Btn>
        ) : (
          <span className="dim" style={{ fontSize: 14 }}>
            Settlement token <span className="mono">{short(cfg.deployment.token, 4)}</span>
          </span>
        )}
      </div>
    </Stats>
  );
}

function RegisterAgent({ cfg, wallet, act }: { cfg: KohakuConfig; wallet: WalletState; act: Act }) {
  const [uri, setUri] = useState("");
  const [signer, setSigner] = useState("");
  return (
    <Panel title="Register an agent">
      <div className="grid" style={{ gap: 12 }}>
        <div className="field">
          <label htmlFor="reg-uri">Agent card or ERC-8004 registration URL</label>
          <input
            id="reg-uri"
            className="input"
            name="registration-url"
            type="url"
            autoComplete="off"
            spellCheck={false}
            aria-describedby="reg-uri-hint"
            placeholder="https://your-agent.example/registration.json"
            value={uri}
            onChange={(e) => setUri(e.target.value)}
          />
          <small id="reg-uri-hint">Serve it with the SDK’s serveAgents(); it lists your services and prices.</small>
        </div>
        <div className="field">
          <label htmlFor="reg-signer">Agent wallet (signs quotes, IOUs and deliveries; receives payouts)</label>
          <input
            id="reg-signer"
            className="input mono"
            name="agent-wallet"
            autoComplete="off"
            spellCheck={false}
            placeholder="0x… (defaults to your wallet)"
            value={signer}
            onChange={(e) => setSigner(e.target.value)}
          />
        </div>
        <Btn
          disabled={!uri}
          onClick={() =>
            act("Register agent", async () => {
              const pub = publicClientFor(cfg);
              const who = (isAddress(signer) ? signer : wallet.address) as Address;
              const hash = await sendTx(wallet.client!, pub, { address: cfg.deployment.identityRegistry, abi: identityRegistryAbi, functionName: "register", args: [uri, who, []] });
              const receipt = await pub.getTransactionReceipt({ hash });
              const ev = parseEventLogs({ abi: identityRegistryAbi, logs: receipt.logs, eventName: "Registered" })[0];
              return ev ? hash : hash;
            })
          }
        >
          Register on {cfg.chain.name}
        </Btn>
      </div>
    </Panel>
  );
}

function ManageAgent({ a, cfg, wallet, act }: { a: AgentSummary; cfg: KohakuConfig; wallet: WalletState; act: Act }) {
  const [amount, setAmount] = useState("10");
  const [intents, setIntents] = useState<IntentView[]>([]);
  const pub = publicClientFor(cfg);
  useEffect(() => {
    api<IntentView[]>(`/v1/intents?buyer=${a.agentId}`)
      .then(setIntents)
      .catch(() => undefined);
  }, [a.agentId]);
  const id = BigInt(a.agentId);
  const c = a.collateral;
  return (
    <div className="list-row" style={{ padding: "16px 0" }}>
      <div className="agent-cell" style={{ marginBottom: 10 }}>
        <AgentGem id={a.agentId} size={32} />
        <div>
          <Link to={`/agents/${a.agentId}`}>
            <b>{a.name}</b>
          </Link>{" "}
          <Pill tone={a.status === "active" ? "accent" : "muted"}>{a.status}</Pill>
          <div className="muted" style={{ fontSize: 12 }}>
            collateral {usd(c.total)} · locked {usd(c.locked)} · exposure {usd(c.exposure, 4)} · headroom {usd(c.headroom)} {c.pendingWithdrawal !== "0" ? `· withdrawing ${usd(c.pendingWithdrawal)}` : ""}
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            sold {usd(a.volumeSold, 4)} · bought {usd(a.volumeBought, 4)} ·{" "}
            <a className="accent" href={`${API}/v1/agents/${a.agentId}/export.csv`}>
              compliance CSV
            </a>
          </div>
        </div>
      </div>
      <div className="control-bar">
        <input
          className="input input-sm"
          style={{ width: 96 }}
          name="amount"
          inputMode="decimal"
          autoComplete="off"
          aria-label={`Amount in USDC for ${a.name}`}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <Btn
          size="sm"
          onClick={() =>
            act("Deposit collateral", async () => {
              const units = toUnits(amount);
              const allowance = (await pub.readContract({ address: cfg.deployment.token, abi: erc20Abi, functionName: "allowance", args: [wallet.address!, cfg.deployment.collateralVault] })) as bigint;
              if (allowance < units) await sendTx(wallet.client!, pub, { address: cfg.deployment.token, abi: erc20Abi, functionName: "approve", args: [cfg.deployment.collateralVault, units] });
              return sendTx(wallet.client!, pub, { address: cfg.deployment.collateralVault, abi: collateralVaultAbi, functionName: "deposit", args: [id, units] });
            })
          }
        >
          Deposit
        </Btn>
        <Btn size="sm" variant="secondary" onClick={() => act("Request withdrawal", () => sendTx(wallet.client!, pub, { address: cfg.deployment.collateralVault, abi: collateralVaultAbi, functionName: "requestWithdrawal", args: [id, toUnits(amount)] }))}>
          Request withdrawal
        </Btn>
        <Btn size="sm" variant="secondary" disabled={c.pendingWithdrawal === "0"} onClick={() => act("Withdraw", () => sendTx(wallet.client!, pub, { address: cfg.deployment.collateralVault, abi: collateralVaultAbi, functionName: "withdraw", args: [id, wallet.address!] }))}>
          Withdraw{c.unlockAt ? ` (after ${new Date(c.unlockAt * 1000).toLocaleTimeString()})` : ""}
        </Btn>
        {a.status === "active" && (
          <Btn size="sm" variant="secondary" onClick={() => act("Pause", () => sendTx(wallet.client!, pub, { address: cfg.deployment.identityRegistry, abi: identityRegistryAbi, functionName: "pause", args: [id] }))}>
            Pause
          </Btn>
        )}
        {a.status === "paused" && (
          <Btn size="sm" variant="secondary" onClick={() => act("Unpause", () => sendTx(wallet.client!, pub, { address: cfg.deployment.identityRegistry, abi: identityRegistryAbi, functionName: "unpause", args: [id] }))}>
            Unpause
          </Btn>
        )}
        {a.status !== "retired" && (
          <Btn size="sm" variant="secondary" onClick={() => act("Retire", () => sendTx(wallet.client!, pub, { address: cfg.deployment.identityRegistry, abi: identityRegistryAbi, functionName: "retire", args: [id] }))}>
            Retire
          </Btn>
        )}
        <Btn size="sm" to={`/intents/new?buyer=${a.agentId}`}>
          New intent
        </Btn>
      </div>
      {intents.slice(0, 4).map((i) => (
        <div key={i.id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ flex: 1 }}>
            <IntentRow i={i} />
          </div>
          {i.status === "active" && (
            <Btn
              size="sm"
              variant="secondary"
              onClick={() =>
                act("Revoke intent", async () => {
                  const revokedAt = BigInt(Math.floor(Date.now() / 1000));
                  const signature = await wallet.client!.signTypedData({
                    account: wallet.address!,
                    domain: cfg.domain,
                    types: REVOCATION_TYPES,
                    primaryType: "IntentRevocation",
                    message: { intentHash: i.id, revokedAt },
                  });
                  await api(`/v1/intents/${i.id}/revoke`, { method: "POST", body: JSON.stringify({ revokedAt: revokedAt.toString(), signature }) });
                })
              }
            >
              Revoke
            </Btn>
          )}
        </div>
      ))}
    </div>
  );
}

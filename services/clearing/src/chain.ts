import {
  createPublicClient,
  createWalletClient,
  http,
  BaseError,
  ContractFunctionRevertedError,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  type TransactionReceipt,
  type Account,
  type Chain as ViemChain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  clearingHouseAbi,
  collateralVaultAbi,
  identityRegistryAbi,
  reputationRegistryAbi,
  validationRegistryAbi,
  erc20Abi,
} from "@kohaku/core/abis";
import { CHAINS, type ChainKey, type Deployment } from "@kohaku/core";
import { log } from "./bus.ts";

export interface VaultAccount {
  total: bigint;
  locked: bigint;
  pendingWithdrawal: bigint;
  unlockAt: number;
  available: bigint;
}

export interface OnchainAgent {
  agentId: bigint;
  signer: Address;
  operator: Address;
  status: "active" | "paused" | "retired";
  uri: string;
}

const STATUS = ["none", "active", "paused", "retired"] as const;

/**
 * Chain access for the clearing service. Writes go through a single FIFO queue so the
 * clearer key never races itself on nonces; each write is simulated first (so reverts
 * surface with their reason and cost nothing), then sent, then awaited.
 */
export class Chain {
  readonly key: ChainKey;
  readonly viemChain: ViemChain;
  readonly publicClient: PublicClient;
  readonly wallet: WalletClient;
  readonly account: Account;
  readonly d: Deployment;
  private queue: Promise<unknown> = Promise.resolve();
  healthy = true;
  lastBlock = 0n;
  lastError: string | null = null;

  constructor(key: ChainKey, rpcUrl: string, clearerKey: Hex, deployment: Deployment) {
    this.key = key;
    this.d = deployment;
    const base = CHAINS[key];
    this.viemChain = { ...base, rpcUrls: { default: { http: [rpcUrl] } } };
    const pollingInterval = key === "local" ? 250 : 1_000;
    this.publicClient = createPublicClient({ chain: this.viemChain, transport: http(rpcUrl, { retryCount: 3, timeout: 20_000 }), pollingInterval }) as PublicClient;
    this.account = privateKeyToAccount(clearerKey);
    this.wallet = createWalletClient({ chain: this.viemChain, transport: http(rpcUrl, { retryCount: 2, timeout: 30_000 }), account: this.account, pollingInterval });
  }

  get explorer(): string | null {
    return this.viemChain.blockExplorers?.default.url ?? null;
  }

  // ---------------------------------------------------------------- writes

  /** Simulate, send and await a contract write through the serial queue. */
  write(
    label: string,
    params: { address: Address; abi: readonly unknown[]; functionName: string; args: readonly unknown[] },
  ): Promise<TransactionReceipt> {
    const run = async () => {
      const started = Date.now();
      try {
        const { request } = await this.publicClient.simulateContract({
          ...(params as object),
          account: this.account,
        } as never);
        const hash = await this.wallet.writeContract(request as never);
        const receipt = await this.publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
        if (receipt.status !== "success") throw new Error(`${label}: transaction ${hash} reverted`);
        this.healthy = true;
        this.lastError = null;
        log("info", "chain", `${label} ok in ${Date.now() - started}ms (gas ${receipt.gasUsed}) ${hash}`);
        return receipt;
      } catch (err) {
        const reason = revertReason(err);
        this.lastError = `${label}: ${reason}`;
        if (/fetch|timeout|ECONN|network|socket/i.test(reason)) this.healthy = false;
        throw new Error(`${label} failed: ${reason}`);
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  // ---------------------------------------------------------------- reads

  async ping(): Promise<boolean> {
    try {
      this.lastBlock = await this.publicClient.getBlockNumber();
      this.healthy = true;
      return true;
    } catch (err) {
      this.healthy = false;
      this.lastError = revertReason(err);
      return false;
    }
  }

  async totalAgents(): Promise<bigint> {
    return (await this.publicClient.readContract({
      address: this.d.identityRegistry,
      abi: identityRegistryAbi,
      functionName: "totalAgents",
    })) as bigint;
  }

  async agent(agentId: bigint): Promise<OnchainAgent> {
    const [a, operator] = await Promise.all([
      this.publicClient.readContract({ address: this.d.identityRegistry, abi: identityRegistryAbi, functionName: "getAgent", args: [agentId] }),
      this.publicClient.readContract({ address: this.d.identityRegistry, abi: identityRegistryAbi, functionName: "ownerOf", args: [agentId] }),
    ]);
    const agent = a as { signer: Address; status: number; agentURI: string };
    const status = STATUS[agent.status] ?? "none";
    return { agentId, signer: agent.signer, operator: operator as Address, status: status === "none" ? "retired" : status, uri: agent.agentURI };
  }

  async vaultAccount(agentId: bigint): Promise<VaultAccount> {
    const [acc, available] = await Promise.all([
      this.publicClient.readContract({ address: this.d.collateralVault, abi: collateralVaultAbi, functionName: "accountOf", args: [agentId] }),
      this.publicClient.readContract({ address: this.d.collateralVault, abi: collateralVaultAbi, functionName: "available", args: [agentId] }),
    ]);
    const a = acc as { total: bigint; locked: bigint; pendingWithdrawal: bigint; unlockAt: bigint };
    return { total: a.total, locked: a.locked, pendingWithdrawal: a.pendingWithdrawal, unlockAt: Number(a.unlockAt), available: available as bigint };
  }

  async currentEpoch(): Promise<bigint> {
    return (await this.publicClient.readContract({ address: this.d.clearingHouse, abi: clearingHouseAbi, functionName: "currentEpoch" })) as bigint;
  }

  async epoch(epochId: bigint) {
    return (await this.publicClient.readContract({
      address: this.d.clearingHouse,
      abi: clearingHouseAbi,
      functionName: "getEpoch",
      args: [epochId],
    })) as {
      status: number;
      finalizedAt: bigint;
      settleDeadline: bigint;
      settledAt: bigint;
      iouCount: number;
      participantCount: number;
      debtorCount: number;
      creditorCount: number;
      openDebtors: number;
      defaultCount: number;
      heldOutCount: number;
      carriedCount: number;
      grossVolume: bigint;
      netVolume: bigint;
      lastKey: bigint;
      iouSetHash: Hex;
      positionsHash: Hex;
      settlementsHash: Hex;
      payoutsHash: Hex;
      receiptHash: Hex;
    };
  }

  async position(epochId: bigint, agentId: bigint) {
    const [credit, debit, net, state] = (await this.publicClient.readContract({
      address: this.d.clearingHouse,
      abi: clearingHouseAbi,
      functionName: "getPosition",
      args: [epochId, agentId],
    })) as [bigint, bigint, bigint, number];
    return { credit, debit, net, state };
  }

  async participants(epochId: bigint): Promise<bigint[]> {
    return (await this.publicClient.readContract({
      address: this.d.clearingHouse,
      abi: clearingHouseAbi,
      functionName: "getParticipants",
      args: [epochId],
    })) as bigint[];
  }

  async heldOut(digest: Hex): Promise<bigint> {
    return (await this.publicClient.readContract({ address: this.d.clearingHouse, abi: clearingHouseAbi, functionName: "heldOut", args: [digest] })) as bigint;
  }

  async lastNonce(buyer: bigint): Promise<bigint> {
    return (await this.publicClient.readContract({ address: this.d.clearingHouse, abi: clearingHouseAbi, functionName: "lastNonce", args: [buyer] })) as bigint;
  }

  async poolBalance(): Promise<{ balance: bigint; accounted: bigint }> {
    const [balance, accounted] = await Promise.all([
      this.publicClient.readContract({ address: this.d.token, abi: erc20Abi, functionName: "balanceOf", args: [this.d.clearingHouse] }),
      this.publicClient.readContract({ address: this.d.clearingHouse, abi: clearingHouseAbi, functionName: "accountedBalance" }),
    ]);
    return { balance: balance as bigint, accounted: accounted as bigint };
  }

  async latestScore(agentId: bigint): Promise<{ score: number; epoch: number }> {
    const [s, e] = await Promise.all([
      this.publicClient.readContract({ address: this.d.reputationRegistry, abi: reputationRegistryAbi, functionName: "latestScore", args: [agentId] }),
      this.publicClient.readContract({ address: this.d.reputationRegistry, abi: reputationRegistryAbi, functionName: "latestScoreEpoch", args: [agentId] }),
    ]);
    return { score: Number(s as bigint), epoch: Number(e as bigint) };
  }

  async validatorStake(validator: Address): Promise<bigint> {
    const s = (await this.publicClient.readContract({
      address: this.d.validationRegistry,
      abi: validationRegistryAbi,
      functionName: "stakes",
      args: [validator],
    })) as [bigint, bigint, bigint];
    return s[0];
  }

  async getTransactionReceipt(hash: Hex) {
    return this.publicClient.getTransactionReceipt({ hash });
  }

  // contract handles for writes
  get addresses() {
    return {
      clearingHouse: this.d.clearingHouse,
      vault: this.d.collateralVault,
      identity: this.d.identityRegistry,
      reputation: this.d.reputationRegistry,
      validation: this.d.validationRegistry,
      token: this.d.token,
    };
  }
}

export const abis = { clearingHouseAbi, collateralVaultAbi, identityRegistryAbi, reputationRegistryAbi, validationRegistryAbi, erc20Abi };

export function revertReason(err: unknown): string {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName ?? revert.reason ?? "reverted";
      const args = revert.data?.args ? `(${revert.data.args.map((a) => String(a)).join(", ")})` : "";
      return `${name}${args}`;
    }
    return err.shortMessage || err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

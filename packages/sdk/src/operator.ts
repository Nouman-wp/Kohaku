import {
  createPublicClient,
  createWalletClient,
  http,
  parseEventLogs,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAINS, INTENT_TYPES, REVOCATION_TYPES, chainKeyFromId, intentDigest, type IntentMandate } from "@kohaku/core";
import { collateralVaultAbi, erc20Abi, identityRegistryAbi, mockUsdcAbi, validationRegistryAbi } from "@kohaku/core/abis";
import type { ClearingClient, ClearingConfig } from "./client.ts";

/**
 * The human (or company) side of an agent: registers it on chain, funds its collateral,
 * signs AP2-style intent mandates that bound what it may spend, and can pause, retire or
 * withdraw. Every call here is an on-chain transaction or a signature from the operator key.
 */
export class Operator {
  readonly account: Account;
  readonly publicClient: PublicClient;
  readonly wallet: WalletClient;
  readonly chain: Chain;

  constructor(
    readonly cfg: ClearingConfig,
    privateKey: Hex,
    rpcUrl = cfg.chain.rpc,
  ) {
    this.account = privateKeyToAccount(privateKey);
    const base = CHAINS[chainKeyFromId(cfg.chain.id)];
    this.chain = { ...base, rpcUrls: { default: { http: [rpcUrl] } } };
    this.publicClient = createPublicClient({ chain: this.chain, transport: http(rpcUrl) }) as PublicClient;
    this.wallet = createWalletClient({ chain: this.chain, transport: http(rpcUrl), account: this.account });
  }

  get address(): Address {
    return this.account.address;
  }

  private async send(address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[]) {
    const { request } = await this.publicClient.simulateContract({ address, abi, functionName, args, account: this.account } as never);
    const hash = await this.wallet.writeContract(request as never);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted (${hash})`);
    return receipt;
  }

  /** Returns the existing agent id for `signer`, or registers a new agent. */
  async ensureRegistered(signer: Address, agentURI: string): Promise<bigint> {
    const existing = (await this.publicClient.readContract({
      address: this.cfg.deployment.identityRegistry,
      abi: identityRegistryAbi,
      functionName: "agentIdOfSigner",
      args: [signer],
    })) as bigint;
    if (existing !== 0n) {
      const current = (await this.publicClient.readContract({
        address: this.cfg.deployment.identityRegistry,
        abi: identityRegistryAbi,
        functionName: "tokenURI",
        args: [existing],
      })) as string;
      if (current !== agentURI) await this.send(this.cfg.deployment.identityRegistry, identityRegistryAbi, "setAgentURI", [existing, agentURI]);
      return existing;
    }
    const receipt = await this.send(this.cfg.deployment.identityRegistry, identityRegistryAbi, "register", [agentURI, signer, []]);
    const logs = parseEventLogs({ abi: identityRegistryAbi, logs: receipt.logs, eventName: "Registered" });
    return (logs[0]!.args as { agentId: bigint }).agentId;
  }

  async collateral(agentId: bigint) {
    return (await this.publicClient.readContract({
      address: this.cfg.deployment.collateralVault,
      abi: collateralVaultAbi,
      functionName: "accountOf",
      args: [agentId],
    })) as { total: bigint; locked: bigint; pendingWithdrawal: bigint; unlockAt: bigint };
  }

  async tokenBalance(who: Address = this.address): Promise<bigint> {
    return (await this.publicClient.readContract({ address: this.cfg.deployment.token, abi: erc20Abi, functionName: "balanceOf", args: [who] })) as bigint;
  }

  async approveIfNeeded(spender: Address, amount: bigint): Promise<void> {
    const allowance = (await this.publicClient.readContract({
      address: this.cfg.deployment.token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [this.address, spender],
    })) as bigint;
    if (allowance < amount) await this.send(this.cfg.deployment.token, erc20Abi, "approve", [spender, amount * 100n]);
  }

  async deposit(agentId: bigint, amount: bigint) {
    await this.approveIfNeeded(this.cfg.deployment.collateralVault, amount);
    return this.send(this.cfg.deployment.collateralVault, collateralVaultAbi, "deposit", [agentId, amount]);
  }

  /** Top the agent's collateral up to `target` (no-op if already there). */
  async topUpCollateral(agentId: bigint, target: bigint): Promise<bigint> {
    const acc = await this.collateral(agentId);
    if (acc.total >= target) return 0n;
    const need = target - acc.total;
    await this.deposit(agentId, need);
    return need;
  }

  requestWithdrawal = (agentId: bigint, amount: bigint) => this.send(this.cfg.deployment.collateralVault, collateralVaultAbi, "requestWithdrawal", [agentId, amount]);
  withdraw = (agentId: bigint, to: Address = this.address) => this.send(this.cfg.deployment.collateralVault, collateralVaultAbi, "withdraw", [agentId, to]);
  pause = (agentId: bigint) => this.send(this.cfg.deployment.identityRegistry, identityRegistryAbi, "pause", [agentId]);
  unpause = (agentId: bigint) => this.send(this.cfg.deployment.identityRegistry, identityRegistryAbi, "unpause", [agentId]);
  retire = (agentId: bigint) => this.send(this.cfg.deployment.identityRegistry, identityRegistryAbi, "retire", [agentId]);

  /** Local / test deployments only: mint the mock stablecoin. */
  async mintTestTokens(to: Address, amount: bigint) {
    if (!this.cfg.deployment.mockToken) throw new Error("not a mock token deployment");
    return this.send(this.cfg.deployment.token, mockUsdcAbi, "mint", [to, amount]);
  }

  async transferToken(to: Address, amount: bigint) {
    return this.send(this.cfg.deployment.token, erc20Abi, "transfer", [to, amount]);
  }

  async sendGas(to: Address, amount: bigint) {
    const hash = await this.wallet.sendTransaction({ account: this.account, chain: this.chain, to, value: amount });
    return this.publicClient.waitForTransactionReceipt({ hash });
  }

  async stakeAsValidator(validatorWallet: WalletClient & { account: Account }, amount: bigint) {
    const approve = await validatorWallet.writeContract({
      account: validatorWallet.account,
      chain: this.chain,
      address: this.cfg.deployment.token,
      abi: erc20Abi,
      functionName: "approve",
      args: [this.cfg.deployment.validationRegistry, amount],
    });
    await this.publicClient.waitForTransactionReceipt({ hash: approve });
    const tx = await validatorWallet.writeContract({
      account: validatorWallet.account,
      chain: this.chain,
      address: this.cfg.deployment.validationRegistry,
      abi: validationRegistryAbi,
      functionName: "stake",
      args: [amount],
    });
    return this.publicClient.waitForTransactionReceipt({ hash: tx });
  }

  // ---------------------------------------------------------------- intents (AP2 mandates)

  async signIntent(intent: Omit<IntentMandate, "operator">): Promise<{ intent: IntentMandate; signature: Hex; id: Hex }> {
    const full: IntentMandate = { ...intent, operator: this.address };
    const signature = await this.wallet.signTypedData({
      account: this.account,
      domain: this.cfg.domain,
      types: INTENT_TYPES,
      primaryType: "IntentMandate",
      message: full,
    });
    return { intent: full, signature, id: intentDigest(this.cfg.domain, full) };
  }

  /** Sign and register an intent with the clearing service. */
  async authorise(client: ClearingClient, intent: Omit<IntentMandate, "operator">) {
    const { intent: full, signature } = await this.signIntent(intent);
    return client.createIntent({
      intent: {
        ...full,
        buyer: full.buyer.toString(),
        budget: full.budget.toString(),
        perJobCap: full.perJobCap.toString(),
        allowedSellers: full.allowedSellers.map(String),
        notBefore: full.notBefore.toString(),
        deadline: full.deadline.toString(),
        nonce: full.nonce.toString(),
      },
      signature,
    });
  }

  async revoke(client: ClearingClient, intentId: Hex) {
    const revokedAt = BigInt(Math.floor(Date.now() / 1000));
    const signature = await this.wallet.signTypedData({
      account: this.account,
      domain: this.cfg.domain,
      types: REVOCATION_TYPES,
      primaryType: "IntentRevocation",
      message: { intentHash: intentId, revokedAt },
    });
    return client.revokeIntent(intentId, { revokedAt: revokedAt.toString(), signature });
  }
}

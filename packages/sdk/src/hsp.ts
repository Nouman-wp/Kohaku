import { pathToFileURL } from "node:url";
import type { Hex, PublicClient, WalletClient, Account, Chain } from "viem";
import { erc20Abi } from "@kohaku/core/abis";
import {
  HSP_CAP_SETTLEMENT,
  HSP_MANDATE_TYPES,
  hspDomain,
  hspPaymentId,
  type HspMandate,
  type PaymentReport,
  type SettlementOrder,
} from "@kohaku/core";

/** Pays one settlement order through HSP from the agent's own wallet. */
export interface HspPayer {
  readonly mode: "local" | "coordinator";
  pay(order: SettlementOrder): Promise<PaymentReport>;
}

/**
 * Local HSP mode (see services/clearing/src/hsp/local.ts): sign an HSP Mandate whose nonce
 * is the settlement order reference, then transfer the exact amount from this wallet.
 * No popups, no human: the agent settles its own debt.
 */
export class LocalHspPayer implements HspPayer {
  readonly mode = "local" as const;

  constructor(
    private readonly wallet: WalletClient,
    private readonly publicClient: PublicClient,
    private readonly account: Account,
    private readonly chain: Chain,
  ) {}

  async pay(order: SettlementOrder): Promise<PaymentReport> {
    const mandate: HspMandate = {
      payer: this.account.address,
      to: order.payTo,
      token: order.token,
      amount: BigInt(order.amount),
      chainId: BigInt(order.chainId),
      nonce: BigInt(order.orderRef),
      expiry: BigInt(Math.floor(Date.now() / 1000) + 900),
      capabilities: HSP_CAP_SETTLEMENT,
    };
    const mandateSignature = await this.wallet.signTypedData({
      account: this.account,
      domain: hspDomain(order.chainId),
      types: HSP_MANDATE_TYPES,
      primaryType: "Mandate",
      message: mandate,
    });
    const txHash = await this.wallet.writeContract({
      account: this.account,
      chain: this.chain,
      address: order.token,
      abi: erc20Abi,
      functionName: "transfer",
      args: [order.payTo, BigInt(order.amount)],
    });
    await this.publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
    return {
      paymentId: hspPaymentId(mandate),
      txHash,
      mandate: {
        payer: mandate.payer,
        to: mandate.to,
        token: mandate.token,
        amount: mandate.amount.toString(),
        chainId: mandate.chainId.toString(),
        nonce: mandate.nonce.toString(),
        expiry: mandate.expiry.toString(),
        capabilities: mandate.capabilities,
      },
      mandateSignature,
    };
  }
}

/**
 * Coordinator mode: pay with the official HSP SDK (`HSPClient.pay`), which signs the
 * mandate, registers it with the Coordinator, broadcasts the transfer from this wallet
 * and asks the Coordinator to observe it. Point `sdkPath` at the SDK's built entry
 * (the organiser distributes the repository during the hackathon).
 */
export class CoordinatorHspPayer implements HspPayer {
  readonly mode = "coordinator" as const;
  private client: { pay: (args: { to: string; amount: bigint }) => Promise<{ paymentId: string; txHash: string; awaitSettled?: () => Promise<unknown> }> } | null = null;

  constructor(
    private readonly opts: { sdkPath: string; coordinatorUrl: string; apiKey: string; privateKey: Hex; chainName: string },
  ) {}

  private async load() {
    if (this.client) return this.client;
    const mod = (await import(pathToFileURL(this.opts.sdkPath).href)) as Record<string, unknown>;
    const HSPClient = mod.HSPClient as new (o: unknown) => NonNullable<CoordinatorHspPayer["client"]>;
    const resolveChain = mod.resolveChain as ((n: string) => unknown) | undefined;
    if (!HSPClient) throw new Error(`HSPClient not exported by ${this.opts.sdkPath}`);
    this.client = new HSPClient({
      coordinatorUrl: this.opts.coordinatorUrl,
      apiKey: this.opts.apiKey,
      signer: { kind: "privateKey", privateKey: this.opts.privateKey },
      chain: resolveChain ? resolveChain(this.opts.chainName) : this.opts.chainName,
    });
    return this.client;
  }

  async pay(order: SettlementOrder): Promise<PaymentReport> {
    const hsp = await this.load();
    const handle = await hsp.pay({ to: order.payTo, amount: BigInt(order.amount) });
    return { paymentId: handle.paymentId as Hex, txHash: handle.txHash as Hex };
  }
}

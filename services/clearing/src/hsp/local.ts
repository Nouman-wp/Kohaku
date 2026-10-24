import { createHmac } from "node:crypto";
import { isAddressEqual, recoverTypedDataAddress, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  HSP_CAP_SETTLEMENT,
  HSP_MANDATE_TYPES,
  HSP_RECEIPT_TYPES,
  hspDomain,
  hspPaymentId,
  hspReceiptDigest,
  type HspMandate,
  type HspReceipt,
  type PaymentReport,
} from "@kohaku/core";
import { checkTransfer } from "./onchain.ts";
import type { HspInfo, HspOrder, HspPort, HspVerification } from "./port.ts";
import { log } from "../bus.ts";

/**
 * Local HSP mode. Runs HSP's three moves in-process with HSP's object shapes:
 *   1. intent: the debtor agent signs an EIP-712 Mandate (payer, to, token, amount, nonce...)
 *   2. settlement: the debtor's own wallet sends the ERC-20 transfer to the pool (real, on chain)
 *   3. verification: this adapter observes the transfer, signs a Receipt, and the verifier
 *      ACCEPTs iff required capabilities ⊆ satisfied capabilities
 *
 * This is not the hosted HSP Coordinator. It exists so Kohaku runs end to end on any chain
 * (including a local devnet) and it is labelled "HSP local adapter" everywhere it shows up.
 * Set HSP_MODE=coordinator to settle through the official Coordinator instead.
 */
export class LocalHsp implements HspPort {
  readonly mode = "local" as const;
  private readonly adapter: PrivateKeyAccount;
  private readonly triples = new Map<string, { mandate: unknown; receipt: HspReceipt; receiptSignature: Hex; decidedAt: number }>();

  constructor(
    private readonly client: PublicClient,
    private readonly chainId: number,
    private readonly chainName: string,
    adapterKey: Hex,
    private readonly webhook?: { url: string; secret: string },
  ) {
    this.adapter = privateKeyToAccount(adapterKey);
  }

  info(): HspInfo {
    return {
      mode: "local",
      coordinatorUrl: null,
      adapterAddress: this.adapter.address,
      chain: this.chainName,
      note: "HSP local adapter: Kohaku runs HSP's mandate → wallet transfer → signed receipt → verifier flow itself. Transfers are real on-chain payments; the hosted HSP Coordinator is not involved.",
    };
  }

  async health(): Promise<boolean> {
    return true;
  }

  get adapterAddress(): Address {
    return this.adapter.address;
  }

  stored(paymentId: string) {
    return this.triples.get(paymentId.toLowerCase());
  }

  async verify(order: HspOrder, report: PaymentReport): Promise<HspVerification> {
    const base = { paymentId: report.paymentId, txHash: report.txHash ?? null, receipt: null, receiptHash: null, mandate: report.mandate ?? null };
    if (!report.mandate || !report.mandateSignature) {
      return { ...base, outcome: "PERMANENT", status: "REJECTED", reason: "local HSP mode requires the signed mandate" };
    }
    let mandate: HspMandate;
    try {
      const m = report.mandate;
      mandate = {
        payer: m.payer as Address,
        to: m.to as Address,
        token: m.token as Address,
        amount: BigInt(m.amount),
        chainId: BigInt(m.chainId),
        nonce: BigInt(m.nonce),
        expiry: BigInt(m.expiry),
        capabilities: m.capabilities,
      };
    } catch {
      return { ...base, outcome: "PERMANENT", status: "REJECTED", reason: "malformed mandate" };
    }

    // 1. the mandate is what it claims to be, signed by the payer
    const paymentId = hspPaymentId(mandate);
    if (paymentId.toLowerCase() !== report.paymentId.toLowerCase()) {
      return { ...base, outcome: "PERMANENT", status: "REJECTED", reason: "paymentId is not the mandate hash" };
    }
    let signer: Address;
    try {
      signer = await recoverTypedDataAddress({
        domain: hspDomain(Number(mandate.chainId)),
        types: HSP_MANDATE_TYPES,
        primaryType: "Mandate",
        message: mandate,
        signature: report.mandateSignature,
      });
    } catch {
      return { ...base, outcome: "PERMANENT", status: "REJECTED", reason: "bad mandate signature" };
    }
    if (!isAddressEqual(signer, mandate.payer)) return { ...base, outcome: "PERMANENT", status: "REJECTED", reason: "mandate not signed by its payer" };

    // 2. the mandate pays exactly this order: right payer, pool, token, amount, chain, epoch
    const policy = [
      [isAddressEqual(mandate.payer, order.payer), "payer is not the debtor's registered wallet"],
      [isAddressEqual(mandate.to, order.payTo), "mandate does not pay the clearing pool"],
      [isAddressEqual(mandate.token, order.token), "wrong settlement token"],
      [mandate.amount === order.amount, `mandate amount ${mandate.amount} is not the net debt ${order.amount}`],
      [Number(mandate.chainId) === this.chainId, "wrong chain"],
      [mandate.nonce === BigInt(order.orderRef), "mandate nonce does not reference this epoch's settlement order"],
      [mandate.capabilities.split(",").includes(HSP_CAP_SETTLEMENT), "mandate does not require settlement proof"],
    ] as const;
    for (const [ok, reason] of policy) {
      if (!ok) return { ...base, outcome: "POLICY", status: "REJECTED", reason };
    }

    // 3. observe the settlement on chain
    const t = await checkTransfer(this.client, report.txHash, mandate.token, mandate.payer, mandate.to, mandate.amount);
    if (!t.ok) {
      return { ...base, outcome: t.retryable ? "RETRYABLE" : "PERMANENT", status: t.retryable ? "OBSERVING" : "FAILED", reason: t.reason };
    }

    // 4. adapter signs the receipt; 5. verifier checks it against the pinned adapter
    const receipt: HspReceipt = {
      paymentId,
      txHash: report.txHash,
      chainId: mandate.chainId,
      to: mandate.to,
      amount: mandate.amount,
      capability: HSP_CAP_SETTLEMENT,
    };
    const receiptSignature = await this.adapter.signTypedData({
      domain: hspDomain(Number(receipt.chainId)),
      types: HSP_RECEIPT_TYPES,
      primaryType: "Receipt",
      message: receipt,
    });
    const recoveredAdapter = await recoverTypedDataAddress({
      domain: hspDomain(Number(receipt.chainId)),
      types: HSP_RECEIPT_TYPES,
      primaryType: "Receipt",
      message: receipt,
      signature: receiptSignature,
    });
    const required = mandate.capabilities.split(",").filter(Boolean);
    const satisfied = new Set([receipt.capability]);
    const accept = isAddressEqual(recoveredAdapter, this.adapter.address) && required.every((c) => satisfied.has(c));
    const receiptJson = { ...receipt, chainId: receipt.chainId.toString(), amount: receipt.amount.toString(), signature: receiptSignature, adapter: this.adapter.address };
    this.triples.set(paymentId.toLowerCase(), { mandate: report.mandate, receipt, receiptSignature, decidedAt: Date.now() });

    if (accept && this.webhook) void this.sendWebhook(paymentId, report.txHash);

    return {
      outcome: accept ? "ACCEPT" : "POLICY",
      status: accept ? "SETTLED" : "REJECTED",
      paymentId,
      txHash: report.txHash,
      receipt: receiptJson,
      receiptHash: hspReceiptDigest(receipt),
      mandate: report.mandate,
      reason: accept ? undefined : "receipt did not satisfy the mandate's capabilities",
    };
  }

  /** Emit the same signed webhook a coordinator would, so that path is exercised for real. */
  private async sendWebhook(paymentId: Hex, txHash: Hex): Promise<void> {
    if (!this.webhook) return;
    const body = JSON.stringify({ id: `evt_${paymentId.slice(2, 18)}_settled`, type: "payment.settled", paymentId, txHash, status: "SETTLED", at: Date.now() });
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = createHmac("sha256", this.webhook.secret).update(`${ts}.${body}`).digest("hex");
    try {
      await fetch(this.webhook.url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-hsp-timestamp": ts, "x-hsp-signature": sig },
        body,
        signal: AbortSignal.timeout(5_000),
      });
    } catch (err) {
      log("warn", "hsp", `local webhook delivery failed: ${(err as Error).message}`);
    }
  }
}

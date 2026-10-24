import { pathToFileURL } from "node:url";
import { isAddressEqual, keccak256, stringToHex, type Address, type Hex, type PublicClient } from "viem";
import { hashJson, type PaymentReport } from "@kohaku/core";
import { checkTransfer } from "./onchain.ts";
import type { HspInfo, HspOrder, HspPort, HspVerification } from "./port.ts";
import { log } from "../bus.ts";

/**
 * Coordinator mode: settlement through the official hosted HSP Coordinator.
 *
 * Debtor agents pay with the official SDK (`HSPClient.pay({ to: pool, amount })`), which
 * signs the mandate, registers it, broadcasts the transfer from the agent's own wallet and
 * asks the Coordinator to observe it. This class is the relying party: it reads the
 * payment back from the Coordinator (`GET /payments/:id`), insists on SETTLED, checks the
 * mandate pays exactly this order, re-runs the official `HSPVerifier` against the pinned
 * adapter address when the SDK is available, and finally checks the transfer on chain
 * itself. ACCEPT never relies on the Coordinator's word alone.
 *
 * Endpoints follow the published "Building on HSP" guide (§9). HSP is pre-1.0, so field
 * names are read defensively and every mismatch is reported with the raw payload.
 */
export class CoordinatorHsp implements HspPort {
  readonly mode = "coordinator" as const;
  private verifier: { verify: (m: unknown, r: unknown, a: unknown) => Promise<{ ok: boolean; outcomeClass: string }> } | null = null;
  private pinnedAdapter: string | null;
  private lastHealth = false;

  constructor(
    private readonly client: PublicClient,
    private readonly url: string,
    private readonly apiKey: string | undefined,
    private readonly chainName: string,
    adapterAddress: string | undefined,
    private readonly sdkPath: string | undefined,
  ) {
    this.pinnedAdapter = adapterAddress ?? null;
  }

  async init(): Promise<void> {
    try {
      const chains = (await this.call("GET", "/chains")) as unknown;
      const adapter = findAdapter(chains, this.chainName);
      if (!this.pinnedAdapter && adapter) this.pinnedAdapter = adapter;
      log("info", "hsp", `coordinator reachable at ${this.url}; pinned adapter ${this.pinnedAdapter ?? "(none)"}`);
    } catch (err) {
      log("warn", "hsp", `coordinator not reachable yet: ${(err as Error).message}`);
    }
    if (this.sdkPath) {
      try {
        const mod = (await import(pathToFileURL(this.sdkPath).href)) as Record<string, unknown>;
        const Verifier = mod.HSPVerifier as (new (opts: unknown) => NonNullable<CoordinatorHsp["verifier"]>) | undefined;
        const resolveChain = (mod.resolveChain as ((n: string) => unknown) | undefined) ?? null;
        if (Verifier) {
          this.verifier = new Verifier({ chain: resolveChain ? resolveChain(this.chainName) : this.chainName, adapterAddress: this.pinnedAdapter });
          log("info", "hsp", "official HSPVerifier loaded; payments are verified locally against the pinned adapter");
        }
      } catch (err) {
        log("warn", "hsp", `could not load the HSP SDK from ${this.sdkPath}: ${(err as Error).message}`);
      }
    }
  }

  info(): HspInfo {
    return {
      mode: "coordinator",
      coordinatorUrl: this.url,
      adapterAddress: this.pinnedAdapter,
      chain: this.chainName,
      note: this.verifier
        ? "Settled through the official HSP Coordinator; receipts re-verified with the official HSPVerifier."
        : "Settled through the official HSP Coordinator; status read from the Coordinator and the transfer re-checked on chain.",
    };
  }

  async health(): Promise<boolean> {
    try {
      await this.call("GET", "/chains");
      this.lastHealth = true;
    } catch {
      this.lastHealth = false;
    }
    return this.lastHealth;
  }

  async verify(order: HspOrder, report: PaymentReport): Promise<HspVerification> {
    const base = { paymentId: report.paymentId, txHash: report.txHash ?? null, receipt: null, receiptHash: null, mandate: null };
    let payment: Record<string, unknown>;
    try {
      payment = (await this.call("GET", `/payments/${encodeURIComponent(report.paymentId)}`)) as Record<string, unknown>;
    } catch (err) {
      return { ...base, outcome: "RETRYABLE", status: "UNREACHABLE", reason: `coordinator: ${(err as Error).message}` };
    }
    const status = String(payment.status ?? "UNKNOWN").toUpperCase();
    const mandateRaw = (payment.mandate as Record<string, unknown> | undefined) ?? {};
    const mandate = (mandateRaw.body as Record<string, unknown> | undefined) ?? mandateRaw;
    const receipt = payment.receipt ?? null;
    const attestations = payment.attestations ?? [];
    const txHash = (report.txHash ?? pick(receipt, ["txHash", "transactionHash"]) ?? pick(payment, ["txHash"])) as Hex | null;

    if (["FAILED", "EXPIRED", "DISPUTED", "REJECTED"].includes(status)) {
      return { ...base, mandate, outcome: "PERMANENT", status, reason: `coordinator reports ${status}` };
    }
    if (status !== "SETTLED") {
      // nudge the coordinator to observe, in case the payer's SDK did not get that far
      if (txHash && status !== "OBSERVING") {
        await this.call("POST", `/payments/${encodeURIComponent(report.paymentId)}/observe`, { txHash }).catch(() => undefined);
      }
      return { ...base, mandate, outcome: "RETRYABLE", status, reason: `waiting for SETTLED (now ${status})` };
    }

    const payer = pick(mandate, ["payer", "from"]) as string | undefined;
    const to = pick(mandate, ["to", "recipient", "payee"]) as string | undefined;
    const amount = pick(mandate, ["amount", "value"]);
    const checks: [boolean, string][] = [
      [!!payer && isAddressEqual(payer as Address, order.payer), "payer is not the debtor's registered wallet"],
      [!!to && isAddressEqual(to as Address, order.payTo), "payment does not go to the clearing pool"],
      [amount !== undefined && BigInt(String(amount)) === order.amount, `amount ${String(amount)} is not the net debt ${order.amount}`],
    ];
    for (const [ok, reason] of checks) {
      if (!ok) return { ...base, mandate, receipt, outcome: "POLICY", status, reason };
    }

    if (this.verifier) {
      try {
        const decision = await this.verifier.verify(payment.mandate, receipt, attestations);
        if (!decision.ok || decision.outcomeClass !== "ACCEPT") {
          return { ...base, mandate, receipt, outcome: (decision.outcomeClass as HspVerification["outcome"]) ?? "POLICY", status, reason: "HSPVerifier did not ACCEPT" };
        }
      } catch (err) {
        return { ...base, mandate, receipt, outcome: "RETRYABLE", status, reason: `verifier error: ${(err as Error).message}` };
      }
    }

    if (!txHash) return { ...base, mandate, receipt, outcome: "RETRYABLE", status, reason: "no settlement transaction hash yet" };
    const t = await checkTransfer(this.client, txHash, order.token, order.payer, order.payTo, order.amount);
    if (!t.ok) return { ...base, mandate, receipt, txHash, outcome: t.retryable ? "RETRYABLE" : "PERMANENT", status, reason: t.reason };

    return {
      outcome: "ACCEPT",
      status,
      paymentId: report.paymentId,
      txHash,
      mandate,
      receipt,
      receiptHash: receipt ? hashJson(receipt) : keccak256(stringToHex(`${report.paymentId}:${txHash}`)),
    };
  }

  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${this.url.replace(/\/+$/, "")}${path}`, {
      method,
      headers: {
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (!res.ok && res.status !== 202) throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  }
}

function pick(obj: unknown, keys: string[]): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  for (const k of keys) {
    const v = (obj as Record<string, unknown>)[k];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

function findAdapter(chains: unknown, name: string): string | null {
  const list = Array.isArray(chains) ? chains : ((chains as { chains?: unknown[] })?.chains ?? []);
  for (const c of list as Record<string, unknown>[]) {
    if (c.name === name || c.chain === name || c.id === name) {
      const a = pick(c, ["adapterAddress", "adapter", "observer"]);
      if (typeof a === "string") return a;
    }
  }
  return null;
}

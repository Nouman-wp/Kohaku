import { keccak256, parseEventLogs, stringToHex, type Hex } from "viem";
import { settlementOrderRef, type PaymentReport, type SettlementOrder } from "@kohaku/core";
import type { Db } from "./db.ts";
import type { Chain } from "./chain.ts";
import { abis } from "./chain.ts";
import type { Registry } from "./registry.ts";
import type { HspOrder, HspPort } from "./hsp/port.ts";
import { bus, log } from "./bus.ts";
import { epochView, payoutView, settlementView, type EpochRow, type PayoutRow, type SettlementRow } from "./views.ts";

const DEFAULT_GRACE_MS = 3_000;

/**
 * Settlement of net debts through HSP, and payout to net creditors.
 *
 *   awaiting_payment -> submitted -> verified -> recorded      (paid through HSP)
 *   awaiting_payment -> defaulted                              (missed the deadline)
 *
 * For every debt the clearing service (the HSP merchant) opens an HSP order: a cart mandate
 * paying the exact net amount to the clearing pool. The debtor pays it through HSP. A
 * settlement is only ever marked paid after HSP reports the payment successful *and*
 * Kohaku has independently seen the exact transfer, consuming this debt's authorization,
 * on chain *and* the clearing house accepted the record (which re-checks that the money is
 * in the pool). If HSP is down, verification returns RETRYABLE and the settlement simply
 * stays pending and is retried.
 */
export class Settlements {
  private inflight = new Set<string>();
  private paying = new Set<number>();
  private opening = new Set<string>();
  private failures = new Map<string, number>();
  private polledAt = new Map<string, number>();

  constructor(
    private readonly db: Db,
    private readonly chain: Chain,
    private readonly registry: Registry,
    private readonly hsp: HspPort,
    private readonly onSealed: (epoch: number) => void,
  ) {}

  createOrders(epoch: number, debtors: { agentId: bigint; owed: bigint }[], deadline: number): void {
    const now = Date.now();
    for (const d of debtors) {
      this.db.run(
        `INSERT INTO settlements(id, epoch, agent_id, amount, status, hsp_mode, deadline, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(epoch, agent_id) DO NOTHING`,
        settlementId(epoch, d.agentId),
        epoch,
        Number(d.agentId),
        Number(d.owed),
        "awaiting_payment",
        this.hsp.mode,
        deadline,
        now,
        now,
      );
      this.emit(settlementId(epoch, d.agentId));
    }
    void this.openOrders();
  }

  /** Open the HSP order for every debt that does not have one yet. Retried on every tick. */
  async openOrders(): Promise<void> {
    const rows = this.db.all<SettlementRow>("SELECT * FROM settlements WHERE status = 'awaiting_payment' AND hsp_cart_id IS NULL ORDER BY epoch, agent_id");
    for (const row of rows) {
      if (this.opening.has(row.id)) continue;
      this.opening.add(row.id);
      try {
        const o = await this.hsp.open(this.hspOrder(row));
        this.db.run(
          "UPDATE settlements SET hsp_cart_id = ?, hsp_payment_id = ?, hsp_flow_id = ?, hsp_payment_url = ?, hsp_order_json = ?, hsp_status = 'payment-required', error = NULL, updated_at = ? WHERE id = ?",
          o.cartMandateId,
          o.paymentRequestId,
          o.flowId,
          o.paymentUrl,
          JSON.stringify(o.request),
          Date.now(),
          row.id,
        );
        log("info", "hsp", `${row.id}: HSP order ${o.cartMandateId} opened for ${row.amount} (flow ${o.flowId ?? "?"})`);
        this.emit(row.id);
      } catch (err) {
        this.db.run("UPDATE settlements SET error = ?, updated_at = ? WHERE id = ?", `opening HSP order: ${(err as Error).message}`, Date.now(), row.id);
      } finally {
        this.opening.delete(row.id);
      }
    }
  }

  private hspOrder(row: SettlementRow): HspOrder {
    const agent = this.registry.get(row.agent_id);
    const o = this.order(row);
    return {
      id: row.id,
      epoch: BigInt(row.epoch),
      agentId: BigInt(row.agent_id),
      amount: BigInt(row.amount),
      payer: agent?.signer ?? "0x0000000000000000000000000000000000000000",
      payTo: o.payTo,
      token: o.token,
      orderRef: o.orderRef,
      attempt: row.hsp_attempt ?? 0,
    };
  }

  order(row: SettlementRow): SettlementOrder {
    return {
      id: row.id,
      epoch: row.epoch,
      agentId: String(row.agent_id),
      amount: String(row.amount),
      token: this.chain.d.token,
      payTo: this.chain.d.clearingHouse,
      chainId: this.chain.viemChain.id,
      orderRef: settlementOrderRef(this.chain.viemChain.id, this.chain.d.clearingHouse, BigInt(row.epoch), BigInt(row.agent_id), BigInt(row.amount)),
      deadline: row.deadline,
      hspMode: row.hsp_mode as SettlementOrder["hspMode"],
      hsp: row.hsp_cart_id
        ? {
            gatewayUrl: this.hsp.info().gatewayUrl,
            cartMandateId: row.hsp_cart_id,
            paymentRequestId: row.hsp_payment_id ?? "",
            flowId: row.hsp_flow_id,
            paymentUrl: row.hsp_payment_url,
          }
        : null,
    };
  }

  get(id: string): SettlementRow | undefined {
    return this.db.get<SettlementRow>("SELECT * FROM settlements WHERE id = ?", id);
  }

  list(filter: { agentId?: string; status?: string; epoch?: number; limit?: number }): SettlementRow[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.agentId) {
      where.push("agent_id = ?");
      params.push(Number(filter.agentId));
    }
    if (filter.status) {
      where.push("status = ?");
      params.push(filter.status);
    }
    if (filter.epoch !== undefined) {
      where.push("epoch = ?");
      params.push(filter.epoch);
    }
    return this.db.all<SettlementRow>(
      `SELECT * FROM settlements ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY epoch DESC, agent_id LIMIT ?`,
      ...params,
      filter.limit ?? 200,
    );
  }

  /** A debtor reports its HSP payment. Verification starts immediately. */
  async report(id: string, report: PaymentReport): Promise<SettlementRow> {
    const row = this.get(id);
    if (!row) throw new Error("unknown settlement");
    if (row.status === "recorded" || row.status === "verified") return row;
    if (row.status === "defaulted") throw new Error("this debt was already covered from collateral");
    if (!row.hsp_cart_id) throw new Error("the HSP order for this debt is not open yet");
    if (report.cartMandateId !== row.hsp_cart_id) throw new Error(`payment is for HSP order ${report.cartMandateId}, this debt's order is ${row.hsp_cart_id}`);
    const tx = report.txHash && /^0x[0-9a-fA-F]{64}$/.test(report.txHash) ? report.txHash : null;
    if (tx) {
      const clash = this.db.get<{ id: string }>("SELECT id FROM settlements WHERE settlement_tx = ? AND id != ?", tx, id);
      if (clash) throw new Error(`transaction already used for settlement ${clash.id}`);
    }
    this.db.run(
      "UPDATE settlements SET status = 'submitted', settlement_tx = COALESCE(?, settlement_tx), mandate_json = ?, error = NULL, updated_at = ? WHERE id = ?",
      tx,
      JSON.stringify(report),
      Date.now(),
      id,
    );
    this.emit(id);
    await this.process(id);
    return this.get(id)!;
  }

  /** An HSP webhook named this order: check it now, even if the debtor has not reported yet. */
  async onHspEvent(cartMandateId: string): Promise<void> {
    const row = this.byCartMandateId(cartMandateId);
    if (!row) return;
    if (row.status === "awaiting_payment") this.db.run("UPDATE settlements SET status = 'submitted', updated_at = ? WHERE id = ?", Date.now(), row.id);
    await this.process(row.id);
  }

  byCartMandateId(cartMandateId: string): SettlementRow | undefined {
    return this.db.get<SettlementRow>("SELECT * FROM settlements WHERE hsp_cart_id = ?", cartMandateId);
  }

  /** Idempotent: moves a settlement as far forward as it can go right now. */
  async process(id: string): Promise<void> {
    if (this.inflight.has(id)) return;
    this.inflight.add(id);
    try {
      let row = this.get(id);
      if (!row) return;
      if (row.status === "submitted") {
        await this.verify(row);
        row = this.get(id)!;
      }
      if (row.status === "verified") await this.record(row);
    } finally {
      this.inflight.delete(id);
    }
  }

  private async verify(row: SettlementRow): Promise<void> {
    if (!this.registry.get(row.agent_id) || !row.hsp_cart_id) return;
    const report = row.mandate_json ? (JSON.parse(row.mandate_json) as PaymentReport) : null;
    const result = await this.hsp.verify(this.hspOrder(row), row.hsp_cart_id, report);
    const now = Date.now();
    if (result.outcome === "ACCEPT") {
      this.db.run(
        "UPDATE settlements SET status = 'verified', hsp_status = ?, hsp_outcome = 'ACCEPT', receipt_json = ?, receipt_hash = ?, settlement_tx = ?, error = NULL, updated_at = ? WHERE id = ?",
        result.status,
        JSON.stringify(result.receipt),
        result.receiptHash,
        result.txHash,
        now,
        row.id,
      );
      log("info", "hsp", `${row.id}: HSP ${result.status}, transfer verified on chain for agent #${row.agent_id} (${row.amount})`);
    } else if (result.outcome === "RETRYABLE") {
      this.db.run(
        "UPDATE settlements SET hsp_status = ?, hsp_outcome = 'RETRYABLE', settlement_tx = COALESCE(?, settlement_tx), attempts = attempts + 1, error = ?, updated_at = ? WHERE id = ?",
        result.status,
        result.txHash,
        result.reason ?? null,
        now,
        row.id,
      );
    } else if (result.status === "payment-failed" && (this.failures.get(row.hsp_cart_id) ?? 0) < 2) {
      // HSP could not complete the payment (e.g. it expired): the debtor retries the same order
      this.failures.set(row.hsp_cart_id, (this.failures.get(row.hsp_cart_id) ?? 0) + 1);
      this.db.run(
        "UPDATE settlements SET status = 'awaiting_payment', hsp_status = ?, hsp_outcome = ?, settlement_tx = NULL, mandate_json = NULL, attempts = attempts + 1, error = ?, updated_at = ? WHERE id = ?",
        result.status,
        result.outcome,
        `HSP payment failed on ${row.hsp_cart_id}: ${result.reason ?? ""}; retrying`,
        now,
        row.id,
      );
      log("warn", "hsp", `${row.id}: HSP payment failed (${result.reason}); the debtor will retry`);
    } else {
      // this payment does not settle this debt. Open a fresh HSP order; the debtor pays again.
      this.db.run(
        `UPDATE settlements SET status = 'awaiting_payment', hsp_status = ?, hsp_outcome = ?, hsp_cart_id = NULL, hsp_payment_id = NULL, hsp_flow_id = NULL,
           hsp_payment_url = NULL, settlement_tx = NULL, mandate_json = NULL, hsp_attempt = hsp_attempt + 1, attempts = attempts + 1, error = ?, updated_at = ? WHERE id = ?`,
        result.status,
        result.outcome,
        `rejected payment on ${row.hsp_cart_id}: ${result.reason ?? result.outcome}`,
        now,
        row.id,
      );
      log("warn", "hsp", `${row.id}: payment rejected (${result.outcome}): ${result.reason}`);
      void this.openOrders();
    }
    this.emit(row.id);
  }

  private async record(row: SettlementRow): Promise<void> {
    const paymentRef = toBytes32(row.hsp_cart_id!);
    try {
      const receipt = await this.chain.write(`recordSettlement e${row.epoch} #${row.agent_id}`, {
        address: this.chain.d.clearingHouse,
        abi: abis.clearingHouseAbi,
        functionName: "recordSettlement",
        args: [BigInt(row.epoch), BigInt(row.agent_id), paymentRef, row.settlement_tx as Hex, (row.receipt_hash ?? paymentRef) as Hex],
      });
      this.db.run("UPDATE settlements SET status = 'recorded', record_tx = ?, error = NULL, updated_at = ? WHERE id = ?", receipt.transactionHash, Date.now(), row.id);
      this.db.run("UPDATE positions SET state = 'settled' WHERE epoch = ? AND agent_id = ?", row.epoch, row.agent_id);
      void this.registry.refreshCollateral([BigInt(row.agent_id)]);
    } catch (err) {
      const msg = (err as Error).message;
      // already recorded (e.g. a retry after a lost response)? trust the chain
      const pos = await this.chain.position(BigInt(row.epoch), BigInt(row.agent_id)).catch(() => null);
      if (pos && pos.state === 3) {
        this.db.run("UPDATE settlements SET status = 'recorded', error = NULL, updated_at = ? WHERE id = ?", Date.now(), row.id);
      } else if (pos && pos.state === 4) {
        this.db.run(
          "UPDATE settlements SET status = 'defaulted', error = 'payment arrived after the debt was covered from collateral; refund owed to the debtor', updated_at = ? WHERE id = ?",
          Date.now(),
          row.id,
        );
      } else {
        this.db.run("UPDATE settlements SET attempts = attempts + 1, error = ?, updated_at = ? WHERE id = ?", msg, Date.now(), row.id);
      }
    }
    this.emit(row.id);
  }

  /** Called on a timer: retries, deadlines, defaults and payouts. */
  async tick(): Promise<void> {
    await this.openOrders();
    for (const r of this.db.all<{ id: string }>("SELECT id FROM settlements WHERE status IN ('submitted','verified')")) {
      await this.process(r.id);
    }
    // a debtor that paid but never reported (crashed, lost response) is still found
    const now = Date.now();
    for (const r of this.db.all<SettlementRow>("SELECT * FROM settlements WHERE status = 'awaiting_payment' AND hsp_cart_id IS NOT NULL")) {
      if (now - (this.polledAt.get(r.id) ?? r.updated_at) < 15_000) continue;
      this.polledAt.set(r.id, now);
      const v = await this.hsp.verify(this.hspOrder(r), r.hsp_cart_id!, null);
      if (v.outcome === "ACCEPT" || (v.outcome === "RETRYABLE" && v.status !== "payment-required" && v.status !== "unknown")) await this.onHspEvent(r.hsp_cart_id!);
    }
    for (const e of this.db.all<EpochRow>("SELECT * FROM epochs WHERE phase IN ('settling','paying') ORDER BY id")) {
      await this.drive(e);
    }
  }

  private async drive(e: EpochRow): Promise<void> {
    const rows = this.list({ epoch: e.id });
    const open = rows.filter((r) => r.status !== "recorded" && r.status !== "defaulted");
    const deadline = e.settle_deadline ?? Infinity;
    if (open.length > 0 && Date.now() > deadline + DEFAULT_GRACE_MS) {
      // the contract compares against block time, which can lag the wall clock on a quiet chain
      const block = await this.chain.publicClient.getBlock().catch(() => null);
      const chainNow = block ? Number(block.timestamp) * 1000 : Date.now();
      if (chainNow > deadline) {
        for (const r of open.filter((r) => r.status === "awaiting_payment")) await this.default(r);
      }
    }
    const stillOpen = this.list({ epoch: e.id }).filter((r) => r.status !== "recorded" && r.status !== "defaulted");
    if (stillOpen.length === 0) await this.payout(e.id);
  }

  private async default(row: SettlementRow): Promise<void> {
    try {
      await this.chain.write(`declareDefault e${row.epoch} #${row.agent_id}`, {
        address: this.chain.d.clearingHouse,
        abi: abis.clearingHouseAbi,
        functionName: "declareDefault",
        args: [BigInt(row.epoch), BigInt(row.agent_id)],
      });
    } catch (err) {
      const pos = await this.chain.position(BigInt(row.epoch), BigInt(row.agent_id)).catch(() => null);
      if (!pos || pos.state !== 4) {
        log("warn", "settlement", `default of #${row.agent_id} in epoch ${row.epoch} failed: ${(err as Error).message}`);
        return;
      }
    }
    this.db.run("UPDATE settlements SET status = 'defaulted', error = 'missed the settlement deadline; covered from collateral', updated_at = ? WHERE id = ?", Date.now(), row.id);
    this.db.run("UPDATE positions SET state = 'defaulted' WHERE epoch = ? AND agent_id = ?", row.epoch, row.agent_id);
    this.db.run("UPDATE epochs SET defaults = defaults + 1 WHERE id = ?", row.epoch);
    log("warn", "settlement", `agent #${row.agent_id} defaulted on epoch ${row.epoch}; ${row.amount} seized from collateral`);
    void this.registry.refreshCollateral([BigInt(row.agent_id)]);
    this.emit(row.id);
  }

  private async payout(epochId: number): Promise<void> {
    if (this.paying.has(epochId)) return;
    this.paying.add(epochId);
    try {
      this.db.run("UPDATE epochs SET phase = 'paying' WHERE id = ? AND phase = 'settling'", epochId);
      // a payout that already went through is never sent again, even if a lagging RPC
      // node still reports the epoch as unpaid (the second one would only revert)
      const paid = this.db.get<{ payout_tx: string | null }>("SELECT payout_tx FROM epochs WHERE id = ?", epochId)?.payout_tx ?? null;
      let txHash = paid as Hex | null;
      const chainE = await this.chain.epoch(BigInt(epochId));
      if (!paid && chainE.status === 2) {
        const receipt = await this.chain.write(`payout e${epochId}`, {
          address: this.chain.d.clearingHouse,
          abi: abis.clearingHouseAbi,
          functionName: "payout",
          args: [BigInt(epochId)],
        });
        txHash = receipt.transactionHash;
        this.db.run("UPDATE epochs SET payout_tx = ? WHERE id = ?", txHash, epochId);
        const logs = parseEventLogs({ abi: abis.clearingHouseAbi, logs: receipt.logs, eventName: "CreditorPaid" });
        for (const l of logs) {
          const a = l.args as { epochId: bigint; agentId: bigint; to: Hex; amount: bigint };
          this.db.run(
            "INSERT INTO payouts(epoch, agent_id, to_addr, amount, tx) VALUES (?,?,?,?,?) ON CONFLICT(epoch, agent_id) DO UPDATE SET tx = excluded.tx",
            epochId,
            Number(a.agentId),
            a.to,
            Number(a.amount),
            txHash,
          );
        }
      }
      await this.seal(epochId, txHash);
    } catch (err) {
      this.db.run("UPDATE epochs SET error = ? WHERE id = ?", (err as Error).message, epochId);
      log("warn", "settlement", `payout of epoch ${epochId} failed, will retry: ${(err as Error).message}`);
    } finally {
      this.paying.delete(epochId);
    }
  }

  async seal(epochId: number, payoutTx: Hex | null): Promise<void> {
    let chainE = await this.chain.epoch(BigInt(epochId));
    // right after the payout a lagging RPC node can still report the epoch as unpaid
    for (let i = 0; payoutTx && chainE.status !== 3 && i < 4; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      chainE = await this.chain.epoch(BigInt(epochId));
    }
    if (chainE.status !== 3) return;
    this.db.tx(() => {
      this.db.run(
        "UPDATE epochs SET phase = 'sealed', onchain = 'settled', receipt_hash = ?, payout_tx = COALESCE(?, payout_tx), sealed_at = ?, error = NULL WHERE id = ?",
        chainE.receiptHash,
        payoutTx,
        Date.now(),
        epochId,
      );
      this.db.run("UPDATE positions SET state = 'paid' WHERE epoch = ? AND state = 'creditor'", epochId);
      this.db.run(
        "UPDATE jobs SET status = 'settled' WHERE status = 'delivered' AND id IN (SELECT job_id FROM ious WHERE posted_epoch = ? AND status = 'netted')",
        epochId,
      );
    });
    const payouts = this.db.all<PayoutRow>("SELECT * FROM payouts WHERE epoch = ?", epochId).map(payoutView);
    if (payouts.length) bus.publish({ type: "payout", at: Date.now(), epoch: epochId, payouts });
    const e = this.db.get<EpochRow>("SELECT * FROM epochs WHERE id = ?", epochId)!;
    bus.publish({ type: "epoch.phase", at: Date.now(), epoch: epochView(e) });
    log("info", "epochs", `epoch ${epochId} sealed; receipt ${chainE.receiptHash}`);
    void this.registry.refreshCollateral(this.registry.list().map((a) => a.agentId));
    this.onSealed(epochId);
  }

  private emit(id: string): void {
    const row = this.get(id);
    if (row) bus.publish({ type: "settlement.update", at: Date.now(), settlement: settlementView(row) });
  }
}

export function settlementId(epoch: number, agentId: bigint): string {
  return `stl_${epoch}_${agentId}`;
}

function toBytes32(v: string): Hex {
  return /^0x[0-9a-fA-F]{64}$/.test(v) ? (v as Hex) : keccak256(stringToHex(v));
}

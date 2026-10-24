import { randomUUID } from "node:crypto";
import {
  isAddressEqual,
  isHex,
  recoverTypedDataAddress,
  type Address,
  type Hex,
  type TypedDataDomain,
} from "viem";
import {
  DELIVERY_TYPES,
  DISPUTE_TYPES,
  IOU_TYPES,
  QUOTE_TYPES,
  VERDICT_TYPES,
  disputeDigest,
  hashJson,
  iouDigest,
  jobHash,
  quoteDigest,
  type Delivery,
  type Dispute,
  type IOU,
  type JobSpec,
  type Quote,
  type Verdict,
} from "@kohaku/core";
import type { Db } from "./db.ts";
import type { Registry } from "./registry.ts";
import type { Intents } from "./intents.ts";
import type { ReputationBook } from "./reputation.ts";
import type { Chain } from "./chain.ts";
import { abis } from "./chain.ts";
import { bus, log } from "./bus.ts";
import { disputeView, iouView, jobView, type DisputeRow, type IouRow, type JobRow } from "./views.ts";

export const MAX_IOU_AMOUNT = 1_000_000_000_000n;
const MAX_RESULT_BYTES = 64 * 1024;

export interface IntakeEpoch {
  id: number;
  intakeEndsAt: number;
}

export interface SubmitIouInput {
  iou: Record<keyof IOU, string>;
  signature: Hex;
  quote: Record<keyof Quote, string>;
  quoteSignature: Hex;
  jobSpec: JobSpec;
  intentId: string | null;
  parentJobId?: string | null;
}

export type SubmitResult =
  | { ok: true; jobId: string; iouDigest: Hex; epoch: number; disputeWindowSeconds: number }
  | { ok: false; reason: string; currentEpoch?: number };

class Refusal extends Error {}

/**
 * The ledger: every paid job enters here. An IOU is accepted only if it is correctly
 * signed, bound to a valid quote, inside the current epoch, unique, within the buyer's
 * intent and covered by the buyer's free collateral. Accepted IOUs are guaranteed to
 * clear: the seller can deliver without trusting the buyer.
 */
export class Ledger {
  constructor(
    private readonly db: Db,
    private readonly registry: Registry,
    private readonly intents: Intents,
    private readonly rep: ReputationBook,
    private readonly chain: Chain,
    private readonly domain: TypedDataDomain,
    private readonly token: Address,
    private readonly opts: { disputeWindowSeconds: number; publicUrl: string },
    private readonly intake: () => IntakeEpoch,
  ) {}

  // ---------------------------------------------------------------- IOU intake

  async submitIou(input: SubmitIouInput): Promise<SubmitResult> {
    let iou: IOU | undefined;
    let quote: Quote | undefined;
    try {
      iou = parseIou(input.iou);
      quote = parseQuote(input.quote);
      const parsedIou = iou;
      const parsedQuote = quote;
      // per-buyer serialisation: the collateral check and the insert must be atomic
      return await this.withBuyerLock(iou.buyer, () => this.validate(parsedIou, parsedQuote, input));
    } catch (err) {
      const reason = err instanceof Refusal ? err.message : `invalid request: ${(err as Error).message}`;
      this.refuse(iou, quote, reason, input.intentId);
      return { ok: false, reason, currentEpoch: this.intake().id };
    }
  }

  private async validate(iou: IOU, quote: Quote, input: SubmitIouInput): Promise<SubmitResult> {
    const epoch = this.intake();
    if (Number(iou.epoch) !== epoch.id) throw new Refusal(`epoch ${iou.epoch} is not accepting IOUs; current epoch is ${epoch.id}`);
    if (Date.now() >= epoch.intakeEndsAt) throw new Refusal(`epoch ${epoch.id} intake just closed`);
    if (!isAddressEqual(iou.token, this.token)) throw new Refusal("IOU must be denominated in the settlement token");
    if (iou.amount <= 0n || iou.amount > MAX_IOU_AMOUNT) throw new Refusal("IOU amount out of range");
    if (iou.buyer === iou.seller) throw new Refusal("an agent cannot buy from itself");

    const buyer = this.registry.get(iou.buyer) ?? (await this.registry.refresh(iou.buyer).catch(() => undefined));
    const seller = this.registry.get(iou.seller) ?? (await this.registry.refresh(iou.seller).catch(() => undefined));
    if (!buyer) throw new Refusal(`unknown buyer #${iou.buyer}`);
    if (!seller) throw new Refusal(`unknown seller #${iou.seller}`);
    if (buyer.status !== "active") throw new Refusal(`buyer #${iou.buyer} is ${buyer.status}`);
    if (seller.status !== "active") throw new Refusal(`seller #${iou.seller} is ${seller.status} and cannot take new jobs`);

    // job spec <-> job hash <-> quote <-> IOU all bind to each other
    const spec = input.jobSpec;
    if (spec.buyer !== iou.buyer.toString() || spec.seller !== iou.seller.toString()) throw new Refusal("job spec parties do not match the IOU");
    if (jobHash(spec) !== iou.jobHash) throw new Refusal("job hash does not match the job spec");
    if (quote.seller !== iou.seller || quote.buyer !== iou.buyer) throw new Refusal("quote parties do not match the IOU");
    if (quote.service !== spec.service) throw new Refusal("quote service does not match the job");
    if (quote.jobHash !== iou.jobHash) throw new Refusal("quote is for a different job");
    if (!isAddressEqual(quote.token, iou.token)) throw new Refusal("quote token differs");
    if (quote.price !== iou.amount) throw new Refusal(`IOU amount ${iou.amount} differs from the quoted price ${quote.price}`);
    if (Number(quote.expiry) * 1000 < Date.now()) throw new Refusal("quote expired");
    const qh = quoteDigest(this.domain, quote);
    if (qh !== iou.quoteHash) throw new Refusal("IOU does not reference this quote");
    const quoteSigner = await recoverTypedDataAddress({ domain: this.domain, types: QUOTE_TYPES, primaryType: "Quote", message: quote, signature: input.quoteSignature });
    if (!isAddressEqual(quoteSigner, seller.signer)) throw new Refusal("quote is not signed by the seller");

    const digest = iouDigest(this.domain, iou);
    const iouSigner = await recoverTypedDataAddress({ domain: this.domain, types: IOU_TYPES, primaryType: "IOU", message: iou, signature: input.signature });
    if (!isAddressEqual(iouSigner, buyer.signer)) throw new Refusal("IOU is not signed by the buyer");

    // replay protection: unique digest, unique (buyer, nonce), nonce above every earlier epoch
    if (this.db.get("SELECT 1 FROM ious WHERE digest = ?", digest)) throw new Refusal("IOU already submitted");
    const nonceNum = Number(iou.nonce);
    if (!Number.isSafeInteger(nonceNum) || nonceNum <= 0) throw new Refusal("nonce out of range");
    if (this.db.get("SELECT 1 FROM ious WHERE buyer = ? AND nonce_num = ?", Number(iou.buyer), nonceNum)) throw new Refusal("nonce already used");
    const prevMax = this.db.get<{ m: number | null }>("SELECT MAX(nonce_num) AS m FROM ious WHERE buyer = ? AND epoch < ?", Number(iou.buyer), epoch.id)?.m ?? 0;
    if (nonceNum <= prevMax) throw new Refusal(`nonce must exceed ${prevMax}, the buyer's highest nonce in earlier epochs`);

    // intent (AP2 mandate) and reputation policy
    const sellerScore = this.rep.live(iou.seller);
    const intentReason = this.intents.check(input.intentId, { buyer: iou.buyer, seller: iou.seller, service: spec.service, amount: iou.amount, sellerScore });
    if (intentReason) throw new Refusal(intentReason);

    // collateral: unsettled obligations can never exceed free collateral
    const acc = await this.registry.collateralOf(iou.buyer);
    const exposure = this.exposure(iou.buyer);
    if (exposure + iou.amount > acc.available) {
      throw new Refusal(`insufficient collateral: ${acc.available} free, ${exposure} already owed this epoch, job needs ${iou.amount}`);
    }

    const jobId = `job_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const now = Date.now();
    this.db.tx(() => {
      this.db.run(
        `INSERT INTO jobs(id, job_hash, buyer, seller, service, spec_json, price, epoch, intent_id, quote_json, quote_sig, quote_hash, status, created_at, parent_job)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        jobId,
        iou.jobHash,
        Number(iou.buyer),
        Number(iou.seller),
        spec.service,
        JSON.stringify(spec),
        Number(iou.amount),
        epoch.id,
        input.intentId,
        JSON.stringify(input.quote),
        input.quoteSignature,
        qh,
        "accepted",
        now,
        input.parentJobId ?? null,
      );
      this.db.run(
        `INSERT INTO ious(digest, job_id, epoch, buyer, seller, amount, token, job_hash, quote_hash, nonce, nonce_num, signature, status, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        digest,
        jobId,
        epoch.id,
        Number(iou.buyer),
        Number(iou.seller),
        Number(iou.amount),
        iou.token,
        iou.jobHash,
        qh,
        iou.nonce.toString(),
        nonceNum,
        input.signature,
        "pending",
        now,
      );
      if (input.intentId) this.intents.spend(input.intentId, iou.amount);
    });

    const job = this.job(jobId)!;
    const iouRow = this.db.get<IouRow>("SELECT * FROM ious WHERE digest = ?", digest)!;
    bus.publish({ type: "iou.accepted", at: now, iou: iouView(iouRow), job: jobView(job) });
    if (input.intentId) {
      const intent = this.intents.get(input.intentId);
      if (intent) bus.publish({ type: "intent", at: now, intent });
    }
    return { ok: true, jobId, iouDigest: digest, epoch: epoch.id, disputeWindowSeconds: this.opts.disputeWindowSeconds };
  }

  private locks = new Map<string, Promise<unknown>>();

  private withBuyerLock<T>(buyer: bigint, fn: () => Promise<T>): Promise<T> {
    const key = buyer.toString();
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const settled = next.catch(() => undefined);
    this.locks.set(key, settled);
    void settled.then(() => {
      if (this.locks.get(key) === settled) this.locks.delete(key);
    });
    return next;
  }

  /** Gross unsettled debit of a buyer in epochs not yet finalised on chain. */
  exposure(buyer: bigint): bigint {
    const r = this.db.get<{ s: number | null }>(
      "SELECT SUM(amount) AS s FROM ious WHERE buyer = ? AND status IN ('pending','disputed','held_out','carried','posted')",
      Number(buyer),
    );
    return BigInt(r?.s ?? 0);
  }

  private refuse(iou: IOU | undefined, quote: Quote | undefined, reason: string, intentId: string | null | undefined): void {
    const at = Date.now();
    this.db.run(
      "INSERT INTO refusals(at, buyer, seller, service, amount, reason, intent_id) VALUES (?,?,?,?,?,?,?)",
      at,
      iou ? Number(iou.buyer) : null,
      iou ? Number(iou.seller) : null,
      quote?.service ?? null,
      iou ? Number(iou.amount) : null,
      reason,
      intentId ?? null,
    );
    this.intents.noteRefusal(intentId);
    bus.publish({
      type: "iou.refused",
      at,
      buyer: iou?.buyer.toString() ?? "?",
      seller: iou?.seller.toString() ?? "?",
      amount: iou?.amount.toString() ?? "0",
      service: quote?.service ?? "?",
      reason,
      intentId: intentId ?? null,
    });
  }

  // ---------------------------------------------------------------- deliveries

  async deliver(input: { jobId: string; delivery: Record<keyof Delivery, string>; signature: Hex; result?: unknown }) {
    const job = this.job(input.jobId);
    if (!job) throw new Error("unknown job");
    if (job.status !== "accepted") return { ok: true, already: true };
    const d: Delivery = {
      seller: BigInt(input.delivery.seller),
      jobHash: input.delivery.jobHash as Hex,
      iouDigest: input.delivery.iouDigest as Hex,
      resultHash: input.delivery.resultHash as Hex,
      deliveredAt: BigInt(input.delivery.deliveredAt),
    };
    if (d.jobHash !== job.job_hash) throw new Error("delivery is for a different job");
    if (BigInt(job.seller) !== d.seller) throw new Error("delivery seller mismatch");
    const iou = this.db.get<IouRow>("SELECT * FROM ious WHERE job_id = ?", job.id);
    if (!iou || iou.digest !== d.iouDigest) throw new Error("delivery does not reference the job's IOU");
    const seller = this.registry.get(d.seller)!;
    const signer = await recoverTypedDataAddress({ domain: this.domain, types: DELIVERY_TYPES, primaryType: "Delivery", message: d, signature: input.signature });
    if (!isAddressEqual(signer, seller.signer)) throw new Error("delivery not signed by the seller");
    let resultJson: string | null = null;
    if (input.result !== undefined) {
      if (hashJson(input.result) !== d.resultHash) throw new Error("result does not match resultHash");
      resultJson = JSON.stringify(input.result);
      if (resultJson.length > MAX_RESULT_BYTES) resultJson = JSON.stringify({ truncated: true, resultHash: d.resultHash });
    }
    const now = Date.now();
    const challengeEndsAt = now + this.opts.disputeWindowSeconds * 1000;
    this.db.run(
      "UPDATE jobs SET status = 'delivered', delivered_at = ?, challenge_ends_at = ?, result_hash = ?, result_json = ?, delivery_sig = ?, delivery_json = ? WHERE id = ? AND status = 'accepted'",
      now,
      challengeEndsAt,
      d.resultHash,
      resultJson,
      input.signature,
      JSON.stringify(input.delivery),
      job.id,
    );
    this.rep.invalidate([d.seller]);
    bus.publish({ type: "job.delivered", at: now, job: jobView(this.job(job.id)!) });
    return { ok: true, challengeEndsAt };
  }

  // ---------------------------------------------------------------- disputes

  async fileDispute(input: { jobId: string; dispute: Record<keyof Dispute, string>; signature: Hex; arbiterJobId?: string | null }) {
    const job = this.job(input.jobId);
    if (!job) throw new Error("unknown job");
    const iou = this.db.get<IouRow>("SELECT * FROM ious WHERE job_id = ?", job.id)!;
    const d: Dispute = {
      buyer: BigInt(input.dispute.buyer),
      jobHash: input.dispute.jobHash as Hex,
      iouDigest: input.dispute.iouDigest as Hex,
      reason: input.dispute.reason,
      filedAt: BigInt(input.dispute.filedAt),
    };
    if (d.jobHash !== job.job_hash || d.iouDigest !== iou.digest) throw new Error("dispute does not reference this job's IOU");
    if (BigInt(job.buyer) !== d.buyer) throw new Error("only the buyer can dispute");
    if (job.status !== "delivered") throw new Error(`job is ${job.status}; only delivered jobs can be disputed`);
    if (!job.challenge_ends_at || Date.now() > job.challenge_ends_at + 1_000) throw new Error("challenge window closed");
    if (!d.reason.trim() || d.reason.length > 1_000) throw new Error("a reason (max 1000 chars) is required");
    const buyer = this.registry.get(d.buyer)!;
    const signer = await recoverTypedDataAddress({ domain: this.domain, types: DISPUTE_TYPES, primaryType: "Dispute", message: d, signature: input.signature });
    if (!isAddressEqual(signer, buyer.signer)) throw new Error("dispute not signed by the buyer");

    let validator: bigint | null = null;
    if (input.arbiterJobId) {
      const aj = this.job(input.arbiterJobId);
      if (!aj || BigInt(aj.buyer) !== d.buyer) throw new Error("arbiter job must be bought by the disputing buyer");
      validator = BigInt(aj.seller);
    } else {
      validator = this.pickValidator(BigInt(job.buyer), BigInt(job.seller));
    }
    if (validator === null) throw new Error("no validator available");
    if (validator === BigInt(job.seller) || validator === BigInt(job.buyer)) throw new Error("validator cannot be a party to the dispute");
    if (!this.registry.get(validator)?.isValidator) throw new Error(`agent #${validator} is not a registered validator`);

    const disputeHash = disputeDigest(this.domain, d);
    const id = `dsp_${disputeHash.slice(2, 18)}`;
    this.db.tx(() => {
      this.db.run(
        `INSERT INTO disputes(id, job_id, iou_digest, epoch, buyer, seller, validator, arbiter_job_id, reason, filed_at, signature, dispute_hash, status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id,
        job.id,
        iou.digest,
        job.epoch,
        job.buyer,
        job.seller,
        Number(validator),
        input.arbiterJobId ?? null,
        d.reason,
        Date.now(),
        input.signature,
        disputeHash,
        "open",
      );
      this.db.run("UPDATE jobs SET status = 'disputed' WHERE id = ?", job.id);
      this.db.run("UPDATE ious SET status = 'disputed' WHERE digest = ? AND status = 'pending'", iou.digest);
    });
    const view = this.dispute(id)!;
    bus.publish({ type: "dispute.opened", at: Date.now(), dispute: view });
    log("info", "disputes", `${id}: buyer #${job.buyer} disputes job ${job.id} by #${job.seller}: ${d.reason}`);
    void this.recordRequestOnChain(id, validator, BigInt(job.seller), disputeHash);
    return view;
  }

  private pickValidator(buyer: bigint, seller: bigint): bigint | null {
    const candidates = this.registry
      .list()
      .filter((a) => a.isValidator && a.status === "active" && a.agentId !== buyer && a.agentId !== seller)
      .sort((a, b) => this.rep.live(b.agentId) - this.rep.live(a.agentId));
    return candidates[0]?.agentId ?? null;
  }

  private async recordRequestOnChain(id: string, validator: bigint, seller: bigint, disputeHash: Hex): Promise<void> {
    const v = this.registry.get(validator);
    if (!v) return;
    try {
      const receipt = await this.chain.write(`validationRequest ${id}`, {
        address: this.chain.addresses.validation,
        abi: abis.validationRegistryAbi,
        functionName: "validationRequest",
        args: [v.signer, seller, `${this.opts.publicUrl}/v1/disputes/${id}`, disputeHash],
      });
      this.db.run("UPDATE disputes SET request_tx = ? WHERE id = ?", receipt.transactionHash, id);
    } catch (err) {
      log("warn", "disputes", `on-chain validation request for ${id} not recorded: ${(err as Error).message}`);
    }
  }

  /**
   * Apply a validator's signed verdict. Upheld: the IOU is voided (never netted), the
   * buyer's intent budget is restored and the seller loses reputation. Rejected: the IOU
   * stands and the buyer is marked for a frivolous dispute.
   */
  async verdict(disputeId: string, input: { verdict: Record<keyof Verdict, string>; signature: Hex; responseTx?: Hex | null }) {
    const row = this.db.get<DisputeRow>("SELECT * FROM disputes WHERE id = ?", disputeId);
    if (!row) throw new Error("unknown dispute");
    if (row.status !== "open") return disputeView(row);
    const v: Verdict = {
      disputeHash: input.verdict.disputeHash as Hex,
      validator: BigInt(input.verdict.validator),
      upheld: String(input.verdict.upheld) === "true",
      reasoning: input.verdict.reasoning,
      decidedAt: BigInt(input.verdict.decidedAt),
    };
    if (v.disputeHash !== row.dispute_hash) throw new Error("verdict is for a different dispute");
    if (row.validator === null || BigInt(row.validator) !== v.validator) throw new Error("verdict not from the assigned validator");
    const validator = this.registry.get(v.validator)!;
    const signer = await recoverTypedDataAddress({ domain: this.domain, types: VERDICT_TYPES, primaryType: "Verdict", message: v, signature: input.signature });
    if (!isAddressEqual(signer, validator.signer)) throw new Error("verdict not signed by the validator");

    const iou = this.db.get<IouRow>("SELECT * FROM ious WHERE digest = ?", row.iou_digest)!;
    const job = this.job(row.job_id)!;
    const status = v.upheld ? "upheld" : "rejected";
    let releaseOnChain = false;
    this.db.tx(() => {
      this.db.run(
        "UPDATE disputes SET status = ?, reasoning = ?, verdict_sig = ?, decided_at = ?, response_tx = ? WHERE id = ?",
        status,
        v.reasoning,
        input.signature,
        Date.now(),
        input.responseTx ?? null,
        disputeId,
      );
      if (v.upheld) {
        releaseOnChain = iou.status === "held_out";
        this.db.run("UPDATE ious SET status = 'voided' WHERE digest = ?", iou.digest);
        this.db.run("UPDATE jobs SET status = 'voided' WHERE id = ?", job.id);
        this.intents.refund(job.intent_id, BigInt(iou.amount));
        this.db.run("UPDATE epochs SET disputes_upheld = disputes_upheld + 1 WHERE id = ?", iou.epoch);
      } else {
        // the IOU stands: back into its epoch, or carried into the next one if it was held out
        this.db.run("UPDATE ious SET status = CASE status WHEN 'held_out' THEN 'carried' ELSE 'pending' END WHERE digest = ?", iou.digest);
        this.db.run("UPDATE jobs SET status = 'delivered' WHERE id = ?", job.id);
      }
    });
    const changes = this.rep.invalidate([BigInt(row.seller), BigInt(row.buyer), v.validator]);
    const view = this.dispute(disputeId)!;
    bus.publish({ type: "dispute.resolved", at: Date.now(), dispute: view });
    if (changes.length) bus.publish({ type: "reputation", at: Date.now(), epoch: iou.epoch, scores: changes });
    log("info", "disputes", `${disputeId} ${status} by #${v.validator}: ${v.reasoning}`);
    if (releaseOnChain) void this.releaseHeldOut(iou.digest as Hex);
    return view;
  }

  private async releaseHeldOut(digest: Hex): Promise<void> {
    try {
      const origin = await this.chain.heldOut(digest);
      if (origin === 0n) return;
      await this.chain.write("releaseHeldOut", {
        address: this.chain.addresses.clearingHouse,
        abi: abis.clearingHouseAbi,
        functionName: "releaseHeldOut",
        args: [digest],
      });
    } catch (err) {
      log("warn", "disputes", `releaseHeldOut ${digest} failed: ${(err as Error).message}`);
    }
  }

  // ---------------------------------------------------------------- reads

  job(id: string): JobRow | undefined {
    return this.db.get<JobRow>("SELECT * FROM jobs WHERE id = ?", id);
  }

  dispute(id: string) {
    const r = this.db.get<DisputeRow>("SELECT * FROM disputes WHERE id = ?", id);
    return r ? disputeView(r) : undefined;
  }

  /** Next nonce a buyer can safely use (time-based, above anything seen). */
  nextNonce(buyer: bigint): bigint {
    const m = this.db.get<{ m: number | null }>("SELECT MAX(nonce_num) AS m FROM ious WHERE buyer = ?", Number(buyer))?.m ?? 0;
    return BigInt(Math.max(m + 1, Date.now() * 1000));
  }
}

function parseIou(x: Record<keyof IOU, string>): IOU {
  if (!isHex(x.jobHash) || !isHex(x.quoteHash)) throw new Error("hashes must be hex");
  return {
    buyer: BigInt(x.buyer),
    seller: BigInt(x.seller),
    amount: BigInt(x.amount),
    token: x.token as Address,
    jobHash: x.jobHash as Hex,
    quoteHash: x.quoteHash as Hex,
    epoch: BigInt(x.epoch),
    nonce: BigInt(x.nonce),
  };
}

function parseQuote(x: Record<keyof Quote, string>): Quote {
  return {
    seller: BigInt(x.seller),
    buyer: BigInt(x.buyer),
    service: String(x.service),
    price: BigInt(x.price),
    token: x.token as Address,
    jobHash: x.jobHash as Hex,
    expiry: BigInt(x.expiry),
    quoteNonce: BigInt(x.quoteNonce),
  };
}

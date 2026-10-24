import { recoverTypedDataAddress, isAddressEqual, type Address, type Hex, type TypedDataDomain } from "viem";
import {
  INTENT_TYPES,
  REVOCATION_TYPES,
  intentDigest,
  type IntentMandate,
  type IntentView,
} from "@kohaku/core";
import type { Db } from "./db.ts";
import type { Registry } from "./registry.ts";

interface IntentRow {
  id: string;
  operator: string;
  buyer: number;
  goal: string;
  budget: number;
  per_job_cap: number;
  min_rep: number;
  allowed_services_json: string;
  allowed_sellers_json: string;
  not_before: number;
  deadline: number;
  nonce: string;
  signature: string;
  spent: number;
  jobs: number;
  refusals: number;
  status: string;
  created_at: number;
  revoked_at: number | null;
}

export class IntentError extends Error {}

/**
 * AP2-style intent mandates. A human operator signs one per buyer agent; every IOU the
 * buyer submits must name an intent it fits inside. The check runs before the IOU is
 * accepted, so off-policy spending never happens — it is refused, and the refusal is
 * recorded and shown on the floor.
 */
export class Intents {
  constructor(
    private readonly db: Db,
    private readonly registry: Registry,
    private readonly domain: TypedDataDomain,
  ) {}

  async register(intent: IntentMandate, signature: Hex): Promise<IntentView> {
    const id = intentDigest(this.domain, intent);
    const existing = this.row(id);
    if (existing) return this.view(existing);

    const signer = await recoverTypedDataAddress({
      domain: this.domain,
      types: INTENT_TYPES,
      primaryType: "IntentMandate",
      message: intent,
      signature,
    });
    if (!isAddressEqual(signer, intent.operator)) throw new IntentError("signature does not match the intent's operator");
    // a freshly registered agent may not be in the local mirror yet: read it from chain
    const buyer = this.registry.get(intent.buyer) ?? (await this.registry.refresh(intent.buyer).catch(() => undefined));
    if (!buyer) throw new IntentError(`unknown buyer agent #${intent.buyer}`);
    if (!isAddressEqual(buyer.operator, intent.operator)) {
      throw new IntentError(`only agent #${intent.buyer}'s operator (${buyer.operator}) can authorise its spending`);
    }
    if (intent.budget <= 0n) throw new IntentError("budget must be positive");
    if (intent.deadline <= intent.notBefore) throw new IntentError("deadline must be after notBefore");
    if (Number(intent.deadline) * 1000 < Date.now()) throw new IntentError("intent already expired");
    if (intent.minSellerReputation > 1000) throw new IntentError("minSellerReputation is 0..1000");

    this.db.run(
      `INSERT INTO intents(id, operator, buyer, goal, budget, per_job_cap, min_rep, allowed_services_json, allowed_sellers_json,
         not_before, deadline, nonce, signature, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      intent.operator,
      Number(intent.buyer),
      intent.goal,
      Number(intent.budget),
      Number(intent.perJobCap),
      intent.minSellerReputation,
      JSON.stringify(intent.allowedServices),
      JSON.stringify(intent.allowedSellers.map(String)),
      Number(intent.notBefore),
      Number(intent.deadline),
      intent.nonce.toString(),
      signature,
      Date.now(),
    );
    return this.view(this.row(id)!);
  }

  async revoke(id: Hex, revokedAt: bigint, signature: Hex): Promise<IntentView> {
    const row = this.row(id);
    if (!row) throw new IntentError("unknown intent");
    const signer = await recoverTypedDataAddress({
      domain: this.domain,
      types: REVOCATION_TYPES,
      primaryType: "IntentRevocation",
      message: { intentHash: id, revokedAt },
      signature,
    });
    if (!isAddressEqual(signer, row.operator as Address)) throw new IntentError("only the operator who signed the intent can revoke it");
    if (row.status !== "revoked") {
      this.db.run("UPDATE intents SET status = 'revoked', revoked_at = ?, revocation_sig = ? WHERE id = ?", Date.now(), signature, id);
    }
    return this.view(this.row(id)!);
  }

  /** Returns null when the job fits the intent, otherwise the refusal reason. */
  check(
    id: string | null | undefined,
    job: { buyer: bigint; seller: bigint; service: string; amount: bigint; sellerScore: number },
  ): string | null {
    if (!id) return "no intent: every purchase must name an operator-signed intent";
    const row = this.row(id);
    if (!row) return "unknown intent";
    if (BigInt(row.buyer) !== job.buyer) return "intent belongs to a different buyer";
    if (row.status === "revoked") return "intent revoked by its operator";
    const now = Date.now() / 1000;
    if (now < row.not_before) return "intent not active yet";
    if (now > row.deadline) return "intent expired";
    if (BigInt(row.spent) + job.amount > BigInt(row.budget)) {
      return `over budget: ${row.spent} spent of ${row.budget}, job costs ${job.amount}`;
    }
    if (row.per_job_cap > 0 && job.amount > BigInt(row.per_job_cap)) return `job price ${job.amount} exceeds per-job cap ${row.per_job_cap}`;
    const services = JSON.parse(row.allowed_services_json) as string[];
    if (services.length > 0 && !services.includes(job.service)) return `service "${job.service}" not allowed by intent`;
    const sellers = JSON.parse(row.allowed_sellers_json) as string[];
    if (sellers.length > 0 && !sellers.includes(job.seller.toString())) return `seller #${job.seller} not on the intent's allowlist`;
    if (job.sellerScore < row.min_rep) return `seller reputation ${job.sellerScore} below the intent's minimum ${row.min_rep}`;
    return null;
  }

  /** Called inside the IOU acceptance transaction. */
  spend(id: string, amount: bigint): void {
    this.db.run("UPDATE intents SET spent = spent + ?, jobs = jobs + 1 WHERE id = ?", Number(amount), id);
    const row = this.row(id)!;
    if (BigInt(row.spent) >= BigInt(row.budget)) this.db.run("UPDATE intents SET status = 'exhausted' WHERE id = ? AND status = 'active'", id);
  }

  /** A voided IOU gives its budget back. */
  refund(id: string | null, amount: bigint): void {
    if (!id) return;
    this.db.run("UPDATE intents SET spent = MAX(0, spent - ?) WHERE id = ?", Number(amount), id);
    this.db.run("UPDATE intents SET status = 'active' WHERE id = ? AND status = 'exhausted' AND spent < budget", id);
  }

  noteRefusal(id: string | null | undefined): void {
    if (id) this.db.run("UPDATE intents SET refusals = refusals + 1 WHERE id = ?", id);
  }

  get(id: string): IntentView | undefined {
    const r = this.row(id);
    return r ? this.view(r) : undefined;
  }

  list(filter: { operator?: string; buyer?: string; limit?: number }): IntentView[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.operator) {
      where.push("lower(operator) = lower(?)");
      params.push(filter.operator);
    }
    if (filter.buyer) {
      where.push("buyer = ?");
      params.push(Number(filter.buyer));
    }
    const sql = `SELECT * FROM intents ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT ?`;
    return this.db.all<IntentRow>(sql, ...params, filter.limit ?? 100).map((r) => this.view(r));
  }

  private row(id: string): IntentRow | undefined {
    return this.db.get<IntentRow>("SELECT * FROM intents WHERE id = ?", id);
  }

  private view(r: IntentRow): IntentView {
    const now = Date.now() / 1000;
    let status = r.status as IntentView["status"];
    if (status === "active" && now > r.deadline) status = "expired";
    return {
      id: r.id as Hex,
      operator: r.operator as Hex,
      buyer: String(r.buyer),
      goal: r.goal,
      budget: String(r.budget),
      spent: String(r.spent),
      perJobCap: String(r.per_job_cap),
      minSellerReputation: r.min_rep,
      allowedServices: JSON.parse(r.allowed_services_json),
      allowedSellers: JSON.parse(r.allowed_sellers_json),
      notBefore: r.not_before,
      deadline: r.deadline,
      status,
      createdAt: r.created_at,
      revokedAt: r.revoked_at,
      jobs: r.jobs,
      refusals: r.refusals,
    };
  }
}

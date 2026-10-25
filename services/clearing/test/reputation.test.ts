import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Db } from "../src/db.ts";
import { ReputationBook } from "../src/reputation.ts";

function ledger() {
  const db = new Db(mkdtempSync(join(tmpdir(), "kohaku-rep-")));
  const epoch = (id: number) => db.run("INSERT INTO epochs(id, phase, starts_at, intake_ends_at, challenge_ends_at) VALUES (?,?,?,?,?)", id, "sealed", 0, 0, 0);
  const job = (id: string, seller: number, epochId: number) =>
    db.run(
      "INSERT INTO jobs(id, job_hash, buyer, seller, service, spec_json, price, epoch, quote_json, quote_sig, quote_hash, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      id,
      `0x${id}`,
      1,
      seller,
      "factcheck",
      "{}",
      1200,
      epochId,
      "{}",
      "0x",
      "0x",
      "settled",
      0,
    );
  const upheld = (jobId: string, seller: number, epochId: number) =>
    db.run(
      "INSERT INTO disputes(id, job_id, iou_digest, epoch, buyer, seller, reason, filed_at, signature, dispute_hash, status) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      `d-${jobId}`,
      jobId,
      "0x",
      epochId,
      1,
      seller,
      "bad",
      0,
      "0x",
      "0x",
      "upheld",
    );
  return { db, epoch, job, upheld };
}

describe("reputation decay", () => {
  it("a lost dispute counts fully now and half after twenty epochs", () => {
    const { db, epoch, job, upheld } = ledger();
    epoch(1);
    for (let k = 0; k < 5; k++) job(`j${k}`, 8, 1);
    upheld("j0", 8, 1);
    const book = new ReputationBook(db);
    expect(book.inputs(8n).disputesLost).toBe(1);
    const fresh = book.live(8n);
    expect(fresh).toBeLessThan(700);

    epoch(21);
    expect(book.inputs(8n).disputesLost).toBeCloseTo(0.5, 3);
    for (let id = 22; id <= 81; id++) epoch(id);
    const later = book.live(8n);
    expect(later).toBeGreaterThan(fresh);
    expect(later).toBeGreaterThanOrEqual(700);
  });

  it("defaults never fade", () => {
    const { db, epoch } = ledger();
    epoch(1);
    db.run(
      "INSERT INTO settlements(id, epoch, agent_id, amount, status, hsp_mode, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
      "stl_1_3",
      1,
      3,
      500,
      "defaulted",
      "local",
      0,
      0,
    );
    for (let id = 2; id <= 200; id++) epoch(id);
    expect(new ReputationBook(db).inputs(3n).defaults).toBe(1);
  });
});

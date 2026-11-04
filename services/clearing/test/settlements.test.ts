import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { Db } from "../src/db.ts";
import { Settlements } from "../src/settlements.ts";
import type { Chain } from "../src/chain.ts";
import type { Registry } from "../src/registry.ts";
import type { HspPort, HspVerification } from "../src/hsp/port.ts";

const POOL = "0xa4f5f3F30E43182285A1EFAbbA8513103efA6730" as const;
const TOKEN = "0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6" as const;
const TX = ("0x" + "ab".repeat(32)) as Hex;

type Verify = (cart: string) => HspVerification | Promise<HspVerification>;

function setup(verify: Verify, hold?: Promise<void>, rpcTroubleAt = 0) {
  const db = new Db(mkdtempSync(join(tmpdir(), "kohaku-stl-")));
  const writes: string[] = [];
  const chain = {
    d: { clearingHouse: POOL, token: TOKEN },
    viemChain: { id: 133 },
    rpcTroubleAt,
    publicClient: { getBlock: async () => ({ timestamp: BigInt(Math.floor(Date.now() / 1000)) }) },
    write: async (label: string) => {
      writes.push(label);
      if (hold) await hold;
      return { transactionHash: ("0x" + "01".repeat(32)) as Hex, logs: [] };
    },
    position: async () => ({ state: 1 }),
    epoch: async () => ({ status: 1 }),
  } as unknown as Chain;
  const registry = { get: () => ({ signer: "0x00000000000000000000000000000000000a11ce" }), refreshCollateral: async () => undefined } as unknown as Registry;
  const hsp = {
    mode: "local",
    info: () => ({}),
    health: async () => true,
    open: async () => {
      throw new Error("not used");
    },
    verify: async (_o: unknown, cart: string) => verify(cart),
  } as unknown as HspPort;
  const s = new Settlements(db, chain, registry, hsp, () => undefined);
  return { db, s, writes };
}

/** epoch `id` in settlement, its deadline `pastMs` ago, with one debt per agent */
function debts(db: Db, id: number, pastMs: number, agents: { agent: number; status: string }[]) {
  const now = Date.now();
  db.run(
    "INSERT INTO epochs(id, phase, starts_at, intake_ends_at, challenge_ends_at, settle_deadline) VALUES (?, 'settling', ?, ?, ?, ?)",
    id,
    now - 600_000,
    now - 500_000,
    now - 400_000,
    now - pastMs,
  );
  for (const a of agents) {
    db.run(
      "INSERT INTO settlements(id, epoch, agent_id, amount, status, hsp_mode, hsp_cart_id, deadline, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      `stl_${id}_${a.agent}`,
      id,
      a.agent,
      500,
      a.status,
      "local",
      `KOHAKU-133-test-E${id}-A${a.agent}`,
      Math.floor((now - pastMs) / 1000),
      now - 60_000,
      now - 60_000,
    );
  }
}

const pending = (status = "payment-submitted"): HspVerification => ({ outcome: "RETRYABLE", status, paymentId: null, txHash: "" as Hex, receipt: null, receiptHash: null });
const row = (db: Db, id: string) => db.get<{ status: string; settlement_tx: string | null }>("SELECT status, settlement_tx FROM settlements WHERE id = ?", id)!;

describe("settlement pipeline", () => {
  it("keeps the empty transaction of payments still in flight out of the ledger", async () => {
    const { db, s } = setup(() => pending());
    debts(db, 177, -60_000, [
      { agent: 1, status: "submitted" },
      { agent: 6, status: "submitted" },
    ]);
    await s.tick();
    await s.tick();
    expect(row(db, "stl_177_1").settlement_tx).toBeNull();
    expect(row(db, "stl_177_6").settlement_tx).toBeNull();
  });

  it("clears empty transactions stored by earlier versions", () => {
    const dir = mkdtempSync(join(tmpdir(), "kohaku-stl-"));
    const db = new Db(dir);
    debts(db, 5, -60_000, [{ agent: 1, status: "submitted" }]);
    db.run("UPDATE settlements SET settlement_tx = '' WHERE id = 'stl_5_1'");
    expect(row(new Db(dir), "stl_5_1").settlement_tx).toBeNull();
  });

  it("moves the other settlements on when one fails", async () => {
    const { db, s, writes } = setup((cart) => {
      if (cart.endsWith("-A1")) throw new Error("HSP is down for this one");
      return { outcome: "ACCEPT", status: "payment-safe", paymentId: "p", txHash: TX, receipt: null, receiptHash: null };
    });
    debts(db, 9, -60_000, [
      { agent: 1, status: "submitted" },
      { agent: 6, status: "submitted" },
    ]);
    await s.tick();
    expect(row(db, "stl_9_6")).toMatchObject({ status: "recorded", settlement_tx: TX });
    expect(writes).toContain("recordSettlement e9 #6");
  });

  it("does not default a debtor whose payment HSP is still carrying", async () => {
    const { db, s, writes } = setup(() => pending("payment-included"));
    debts(db, 175, 30_000, [{ agent: 1, status: "awaiting_payment" }]);
    // just updated, so the background poll skips it and the deadline check meets it first
    db.run("UPDATE settlements SET updated_at = ?", Date.now());
    await s.tick();
    expect(writes.some((w) => w.startsWith("declareDefault"))).toBe(false);
    expect(row(db, "stl_175_1").status).toBe("submitted");
  });

  it("still defaults a debtor that has not paid", async () => {
    const { db, s, writes } = setup(() => pending("payment-required"));
    debts(db, 176, 30_000, [{ agent: 1, status: "awaiting_payment" }]);
    await s.tick();
    expect(writes).toContain("declareDefault e176 #1");
    expect(row(db, "stl_176_1").status).toBe("defaulted");
  });

  it("stops waiting for a payment that never confirms once the grace is over", async () => {
    const { db, s, writes } = setup(() => pending("payment-submitted"));
    debts(db, 178, 11 * 60_000, [{ agent: 6, status: "submitted" }]);
    await s.tick();
    expect(writes).toContain("declareDefault e178 #6");
    expect(row(db, "stl_178_6").status).toBe("defaulted");
  });

  it("declares a default once while ticks pile up on a slow chain", async () => {
    let release!: () => void;
    const { db, s, writes } = setup(() => pending("payment-required"), new Promise<void>((r) => (release = r)));
    debts(db, 186, 30_000, [{ agent: 1, status: "awaiting_payment" }]);
    db.run("UPDATE settlements SET updated_at = ?", Date.now());
    const ticks = [s.tick(), s.tick(), s.tick()];
    await new Promise((r) => setTimeout(r, 20));
    release();
    await Promise.all(ticks);
    await s.tick();
    expect(writes.filter((w) => w === "declareDefault e186 #1")).toHaveLength(1);
    expect(db.get<{ defaults: number }>("SELECT defaults FROM epochs WHERE id = 186")!.defaults).toBe(1);
  });

  it("repairs default counts inflated by earlier versions", () => {
    const dir = mkdtempSync(join(tmpdir(), "kohaku-stl-"));
    const db = new Db(dir);
    debts(db, 186, 30_000, [{ agent: 1, status: "defaulted" }]);
    db.run("INSERT INTO positions(epoch, agent_id, credit, debit, net, state) VALUES (186, 1, 0, 15600, -15600, 'defaulted')");
    db.run("UPDATE epochs SET defaults = 455 WHERE id = 186");
    expect(new Db(dir).get<{ defaults: number }>("SELECT defaults FROM epochs WHERE id = 186")!.defaults).toBe(1);
  });

  it("does not default anyone while Kohaku itself cannot reach the chain", async () => {
    const { db, s, writes } = setup(() => pending("payment-required"), undefined, Date.now() - 60_000);
    debts(db, 187, 30 * 60_000, [{ agent: 6, status: "awaiting_payment" }]);
    db.run("UPDATE settlements SET updated_at = ?", Date.now());
    await s.tick();
    expect(writes.some((w) => w.startsWith("declareDefault"))).toBe(false);
    expect(row(db, "stl_187_6").status).toBe("awaiting_payment");
  });

  it("still defaults an unpaid debt two hours on, even if the RPC stays flaky", async () => {
    const { db, s, writes } = setup(() => pending("payment-required"), undefined, Date.now() - 60_000);
    debts(db, 150, 2 * 60 * 60_000 + 60_000, [{ agent: 6, status: "awaiting_payment" }]);
    db.run("UPDATE settlements SET updated_at = ?", Date.now());
    await s.tick();
    expect(writes).toContain("declareDefault e150 #6");
  });
});

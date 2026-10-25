import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Db } from "../src/db.ts";
import { installMirror, removeMirror, SupabaseMirror } from "../src/mirror.ts";

const URL = "https://project.supabase.co";

function fresh() {
  return new Db(mkdtempSync(join(tmpdir(), "kohaku-mirror-")));
}

function addAgent(db: Db, id: number, name = `Agent ${id}`) {
  db.run(
    "INSERT INTO agents (agent_id, slug, name, operator, signer, status, registered_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)",
    id,
    `agent-${id}`,
    name,
    "0xOperator",
    `0xSigner${id}`,
    1_000,
    1_000,
  );
}

/** A fake Supabase REST API that records what it was sent. */
function fakeSupabase(fail = false) {
  const calls: { url: string; headers: Record<string, string>; rows: Record<string, unknown>[] }[] = [];
  const api = {
    calls,
    fail,
    fetch: (async (url: string, init: RequestInit) => {
      if (api.fail) return new Response("upstream down", { status: 503 });
      calls.push({ url, headers: init.headers as Record<string, string>, rows: JSON.parse(init.body as string) });
      return new Response(null, { status: 201 });
    }) as typeof fetch,
  };
  return api;
}

const pending = (db: Db) => db.get<{ n: number }>("SELECT count(*) AS n FROM sync_outbox")!.n;

describe("Supabase mirror", () => {
  it("queues every insert and update inside the write's own transaction", () => {
    const db = fresh();
    installMirror(db);
    addAgent(db, 1);
    db.run("UPDATE agents SET name = 'Scout' WHERE agent_id = 1");
    db.run("INSERT INTO positions (epoch, agent_id, credit, debit, net, state) VALUES (3, 1, 10, 0, 10, 'creditor')");
    const q = db.all<{ tbl: string; pk: string }>("SELECT tbl, pk FROM sync_outbox ORDER BY id");
    expect(q).toEqual([
      { tbl: "agents", pk: "[1]" },
      { tbl: "agents", pk: "[1]" },
      { tbl: "positions", pk: "[3,1]" },
    ]);
  });

  it("backfills existing rows once per Supabase project", () => {
    const db = fresh();
    addAgent(db, 1);
    addAgent(db, 2);
    new SupabaseMirror(db, { url: URL, key: "sb_secret_x", deployment: "kohaku-test", fetch: fakeSupabase().fetch });
    const first = pending(db);
    expect(first).toBeGreaterThanOrEqual(2);
    new SupabaseMirror(db, { url: URL, key: "sb_secret_x", deployment: "kohaku-test", fetch: fakeSupabase().fetch });
    expect(pending(db)).toBe(first);
  });

  it("upserts the current rows, tagged with the deployment, and empties the queue", async () => {
    const db = fresh();
    const api = fakeSupabase();
    const m = new SupabaseMirror(db, { url: `${URL}/`, key: "sb_secret_x", deployment: "kohaku-test", fetch: api.fetch });
    addAgent(db, 7, "Lens");
    db.run("UPDATE agents SET name = 'Lens II' WHERE agent_id = 7");
    await m.flush();
    expect(pending(db)).toBe(0);
    const agents = api.calls.find((c) => c.url.startsWith(`${URL}/rest/v1/agents?`))!;
    expect(agents.url).toBe(`${URL}/rest/v1/agents?on_conflict=deployment,agent_id`);
    expect(agents.headers.apikey).toBe("sb_secret_x");
    expect(agents.headers.authorization).toBeUndefined();
    expect(agents.headers.prefer).toContain("resolution=merge-duplicates");
    // two queued changes, one row: the latest state
    expect(agents.rows).toHaveLength(1);
    expect(agents.rows[0]).toMatchObject({ deployment: "kohaku-test", agent_id: 7, name: "Lens II" });
    expect(m.status()).toMatchObject({ enabled: true, pending: 0, lastError: null });
  });

  it("sends the legacy service_role JWT as a bearer token too", async () => {
    const db = fresh();
    const api = fakeSupabase();
    const m = new SupabaseMirror(db, { url: URL, key: "eyJhbGciOi.legacy.jwt", deployment: "kohaku-test", fetch: api.fetch });
    addAgent(db, 4);
    await m.flush();
    const agents = api.calls.find((c) => c.url.includes("/rest/v1/agents?"))!;
    expect(agents.headers.authorization).toBe("Bearer eyJhbGciOi.legacy.jwt");
    expect(agents.headers.apikey).toBe("eyJhbGciOi.legacy.jwt");
  });

  it("keeps the queue when Supabase is down and catches up later", async () => {
    const db = fresh();
    const api = fakeSupabase(true);
    const m = new SupabaseMirror(db, { url: URL, key: "sb_secret_x", deployment: "kohaku-test", fetch: api.fetch });
    addAgent(db, 3);
    const before = pending(db);
    await m.flush();
    expect(pending(db)).toBe(before);
    expect(m.lastError).toContain("HTTP 503");
    api.fail = false;
    (m as unknown as { retryAt: number }).retryAt = 0;
    await m.flush();
    expect(pending(db)).toBe(0);
    expect(m.lastError).toBeNull();
    expect(api.calls.some((c) => c.rows.some((r) => r.agent_id === 3))).toBe(true);
  });

  it("removes its triggers and queue when switched off", () => {
    const db = fresh();
    new SupabaseMirror(db, { url: URL, key: "sb_secret_x", deployment: "kohaku-test", fetch: fakeSupabase().fetch });
    removeMirror(db);
    addAgent(db, 9);
    expect(db.all("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'mirror_%'")).toEqual([]);
    expect(db.get("SELECT name FROM sqlite_master WHERE name = 'sync_outbox'")).toBeUndefined();
    expect(db.getMeta("mirror_target")).toBeUndefined();
  });
});

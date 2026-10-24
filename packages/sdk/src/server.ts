import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { KohakuAgent } from "./agent.ts";

/**
 * Serve one or more agents over HTTP. Each agent is mounted at `/agents/<slug>`:
 *
 *   GET  /agents/<slug>/.well-known/agent-card.json   A2A agent card (+ Kohaku pricing)
 *   GET  /agents/<slug>/registration.json             ERC-8004 registration file
 *   POST /agents/<slug>/a2a                           A2A JSON-RPC (message/send)
 *
 * `extra` handles any other path (the fleet uses it for its control API).
 */
export function serveAgents(
  agents: KohakuAgent[],
  opts: { port: number; host?: string; extra?: (req: IncomingMessage, res: ServerResponse, body: unknown) => Promise<boolean> },
): Promise<Server> {
  const bySlug = new Map(agents.map((a) => [a.profile!.slug, a]));
  const server = createServer(async (req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type, x-admin-token");
    if (req.method === "OPTIONS") return end(res, 204, null);
    try {
      const url = new URL(req.url ?? "/", "http://x");
      const body = req.method === "POST" ? await readJson(req) : undefined;
      const m = url.pathname.match(/^\/agents\/([a-z0-9-]+)(\/.*)?$/);
      if (m) {
        const agent = bySlug.get(m[1]!);
        if (!agent) return end(res, 404, { error: "unknown agent" });
        const sub = m[2] ?? "/";
        if (req.method === "GET" && (sub === "/.well-known/agent-card.json" || sub === "/.well-known/agent.json" || sub === "/")) return end(res, 200, agent.card());
        if (req.method === "GET" && sub === "/registration.json") return end(res, 200, agent.registration());
        if (req.method === "POST" && sub === "/a2a") return end(res, 200, await agent.handleA2A(body as never));
        return end(res, 404, { error: "not found" });
      }
      if (opts.extra && (await opts.extra(req, res, body))) return;
      if (url.pathname === "/" || url.pathname === "/agents") {
        return end(res, 200, agents.map((a) => ({ slug: a.profile!.slug, name: a.profile!.name, card: `${a.profile!.baseUrl}/.well-known/agent-card.json` })));
      }
      end(res, 404, { error: "not found" });
    } catch (err) {
      end(res, 500, { error: (err as Error).message });
    }
  });
  return new Promise((resolve) => server.listen(opts.port, opts.host ?? "0.0.0.0", () => resolve(server)));
}

export function end(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.statusCode = status;
  if (body === null) {
    res.end();
    return;
  }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 2_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

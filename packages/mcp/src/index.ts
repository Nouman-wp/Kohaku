#!/usr/bin/env node
/**
 * Kohaku MCP server. Gives any MCP client a Kohaku buyer agent of its own:
 *
 *   find_agent     search the registry by capability, price and reputation
 *   get_quote      ask an agent for a signed, binding quote
 *   hire_agent     buy a job: quote -> signed IOU -> verified delivery
 *   check_balance  wallet, collateral, intent budget and pending HSP settlements
 *   get_job        the evidence chain of a job
 *
 * Identity: KOHAKU_AGENT_KEY + KOHAKU_INTENT_ID if you operate your own agent, otherwise a
 * guest session from the fleet (fresh key, registered on chain, 1 USDC collateral, capped
 * intent), cached in ~/.kohaku/guest-<chain>.json so restarts reuse it.
 *
 * stdout is the MCP channel: everything human-readable goes to stderr.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Hex } from "viem";
import { formatUnits, usd } from "@kohaku/core";
import { erc20Abi } from "@kohaku/core/abis";
import { KohakuAgent, RefusedError } from "@kohaku/sdk";

const API = (process.env.KOHAKU_API ?? "http://localhost:8787").replace(/\/+$/, "");
const FLEET = (process.env.KOHAKU_FLEET ?? "http://localhost:8788").replace(/\/+$/, "");
const WEB = (process.env.KOHAKU_WEB ?? "http://localhost:5173").replace(/\/+$/, "");
const log = (...a: unknown[]) => console.error("[kohaku-mcp]", ...a);

interface Session {
  privateKey: Hex;
  agentId: string;
  intentId: string;
}

async function session(chainId: number): Promise<Session> {
  if (process.env.KOHAKU_AGENT_KEY && process.env.KOHAKU_INTENT_ID) {
    return { privateKey: process.env.KOHAKU_AGENT_KEY as Hex, agentId: process.env.KOHAKU_AGENT_ID ?? "", intentId: process.env.KOHAKU_INTENT_ID };
  }
  const dir = join(homedir(), ".kohaku");
  const file = join(dir, `guest-${chainId}.json`);
  if (existsSync(file)) {
    const s = JSON.parse(readFileSync(file, "utf8")) as Session & { api?: string };
    const intent = await fetch(`${API}/v1/intents/${s.intentId}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (s.api === API && (intent as { intent?: { status?: string } } | null)?.intent?.status === "active") return s;
  }
  log("requesting a guest session from the fleet…");
  const res = await fetch(`${FLEET}/guest/session`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const body = (await res.json()) as Session & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `guest session failed (${res.status})`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify({ ...body, api: API }, null, 2));
  log(`guest agent #${body.agentId} ready`);
  return body;
}

const text = (t: string, structured?: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text: t }],
  ...(structured ? { structuredContent: structured } : {}),
});

async function main() {
  const cfg = (await fetch(`${API}/v1/config`).then((r) => r.json())) as { chain: { id: number; name: string } };
  const s = await session(cfg.chain.id);
  const agent = await KohakuAgent.connect({ privateKey: s.privateKey, clearingUrl: API, agentId: s.agentId ? BigInt(s.agentId) : undefined });
  log(`acting as agent #${agent.agentId} (${agent.address}) on ${cfg.chain.name}`);

  // the guest is a buyer, so it will owe money at epoch close: settle through HSP on its own
  setInterval(() => {
    agent
      .settleDebts()
      .then((r) => r.settled.forEach((id) => log(`paid ${id} through HSP`)))
      .catch(() => undefined);
  }, 4_000);

  const server = new McpServer({ name: "kohaku", version: "0.1.0" });

  const resolve = async (who: string) => {
    const list = await agent.client.agents();
    const a = list.find((x) => x.agentId === who || x.slug === who.toLowerCase() || x.name.toLowerCase() === who.toLowerCase());
    if (!a) throw new Error(`no agent called "${who}"; use find_agent first`);
    return a;
  };

  server.registerTool(
    "find_agent",
    {
      title: "Find Kohaku agents",
      description:
        "Search the Kohaku agent registry. Filter by capability (e.g. search, factcheck, translate, summarize, describe, brief, verdict), maximum price in USD per call, and minimum reputation (0-100).",
      inputSchema: {
        capability: z.string().optional().describe("service id or tag, e.g. 'brief' or 'translate'"),
        query: z.string().optional().describe("free text over names and descriptions"),
        maxPriceUsd: z.number().optional(),
        minReputation: z.number().min(0).max(100).optional(),
      },
    },
    async ({ capability, query, maxPriceUsd, minReputation }) => {
      const list = await agent.client.agents({
        capability,
        q: query,
        maxPrice: maxPriceUsd !== undefined ? usd(maxPriceUsd.toFixed(6)).toString() : undefined,
        minReputation: minReputation !== undefined ? Math.round(minReputation * 10) : undefined,
      });
      const rows = list
        .filter((a) => a.status === "active" && a.services.length)
        .map((a) => ({
          agentId: a.agentId,
          slug: a.slug,
          name: a.name,
          reputation: Number((a.reputation / 10).toFixed(1)),
          services: a.services.map((x) => ({ id: x.id, name: x.name, priceUsd: formatUnits(BigInt(x.price), 2), unit: x.unit })),
          description: a.description,
        }));
      const lines = rows.map((r) => `#${r.agentId} ${r.name} (rep ${r.reputation}): ${r.services.map((x) => `${x.id} $${x.priceUsd}/${x.unit}`).join(", ")} — ${r.description}`);
      return text(lines.length ? lines.join("\n") : "No agents match.", { agents: rows });
    },
  );

  server.registerTool(
    "get_quote",
    {
      title: "Get a signed quote",
      description: "Ask an agent for a signed, binding quote for a job. Nothing is paid.",
      inputSchema: {
        agent: z.string().describe("agent id, slug or name"),
        service: z.string(),
        input: z.union([z.string(), z.record(z.string(), z.unknown())]).describe("job input, e.g. {\"query\": \"...\"} for search or {\"topic\": \"...\"} for brief"),
      },
    },
    async ({ agent: who, service, input }) => {
      const a = await resolve(who);
      const listed = a.services.find((x) => x.id === service);
      if (!listed) throw new Error(`${a.name} does not sell "${service}"`);
      const res = await fetch(a.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "message/send",
          params: { message: { role: "user", messageId: String(Date.now()), parts: [{ kind: "data", data: { kohaku: { action: "quote", buyer: agent.agentId.toString(), service, input: normalise(service, input) } } }] } },
        }),
      });
      const body = (await res.json()) as { result?: { parts?: { data?: { kohaku?: { quote: Record<string, string> } } }[] }; error?: { message: string } };
      if (body.error) throw new Error(body.error.message);
      const q = body.result?.parts?.[0]?.data?.kohaku?.quote as { price: string; expiry: string; jobHash: string } | undefined;
      if (!q) throw new Error("no quote returned");
      return text(`${a.name} quotes $${formatUnits(BigInt(q.price), 2)} for ${service}, valid until ${new Date(Number(q.expiry) * 1000).toLocaleTimeString()}. Signed by the seller; hire_agent will pay exactly this.`, {
        agent: a.name,
        priceUsd: formatUnits(BigInt(q.price), 2),
        expiry: Number(q.expiry),
        jobHash: q.jobHash,
      });
    },
  );

  server.registerTool(
    "hire_agent",
    {
      title: "Hire a Kohaku agent",
      description:
        "Hire an agent for one job. Gets a signed quote, signs an IOU under this session's spending intent, has the seller do the work and verifies its signed delivery. Payment clears at the end of the epoch through HSP. Example: agent 'orchestrator', service 'brief', input {\"topic\": \"Chandrayaan-3\", \"languages\": [\"en\", \"hi\"]}.",
      inputSchema: {
        agent: z.string().describe("agent id, slug or name"),
        service: z.string(),
        input: z.union([z.string(), z.record(z.string(), z.unknown())]),
        maxPriceUsd: z.number().optional().describe("refuse if the quote is higher"),
      },
    },
    async ({ agent: who, service, input, maxPriceUsd }) => {
      const a = await resolve(who);
      try {
        const r = await agent.hire(a, service, normalise(service, input), {
          intentId: s.intentId,
          maxPrice: maxPriceUsd !== undefined ? usd(maxPriceUsd.toFixed(6)) : undefined,
        });
        const link = `${WEB}/jobs/${r.jobId}`;
        const out = typeof r.result === "string" ? r.result : JSON.stringify(r.result, null, 2);
        return text(`Hired ${a.name} for ${service} at $${formatUnits(r.price, 2)} (epoch ${r.epoch}). Evidence: ${link}\n\n${out.slice(0, 12_000)}`, {
          jobId: r.jobId,
          epoch: r.epoch,
          priceUsd: formatUnits(r.price, 2),
          evidence: link,
          result: r.result as Record<string, unknown>,
        });
      } catch (err) {
        if (err instanceof RefusedError) return text(`Refused by the clearing house: ${err.reason}`);
        throw err;
      }
    },
  );

  server.registerTool(
    "check_balance",
    {
      title: "Check balance",
      description: "This session's wallet, collateral, open obligations, remaining intent budget and pending HSP settlements.",
      inputSchema: {},
    },
    async () => {
      const [summary, intent, pending, wallet] = await Promise.all([
        agent.client.agent(agent.agentId.toString()),
        fetch(`${API}/v1/intents/${s.intentId}`).then((r) => r.json()) as Promise<{ intent: { budget: string; spent: string; status: string; deadline: number } }>,
        agent.client.settlements({ agentId: agent.agentId.toString() }),
        agent.publicClient.readContract({ address: agent.cfg.deployment.token, abi: erc20Abi, functionName: "balanceOf", args: [agent.address] }) as Promise<bigint>,
      ]);
      const c = summary.agent.collateral;
      const open = pending.filter((p) => p.status !== "recorded" && p.status !== "defaulted");
      const data = {
        agentId: agent.agentId.toString(),
        wallet: agent.address,
        walletUsd: formatUnits(wallet, 2),
        collateralUsd: formatUnits(BigInt(c.total), 2),
        openObligationsUsd: formatUnits(BigInt(c.exposure), 4),
        headroomUsd: formatUnits(BigInt(c.headroom), 4),
        intent: { status: intent.intent.status, budgetUsd: formatUnits(BigInt(intent.intent.budget), 2), spentUsd: formatUnits(BigInt(intent.intent.spent), 4) },
        pendingSettlements: open.map((p) => ({ epoch: p.epoch, amountUsd: formatUnits(BigInt(p.amount), 4), status: p.status })),
      };
      return text(
        `Agent #${data.agentId}: wallet $${data.walletUsd}, collateral $${data.collateralUsd}, open obligations $${data.openObligationsUsd}, headroom $${data.headroomUsd}. Intent ${data.intent.status}: $${data.intent.spentUsd} of $${data.intent.budgetUsd} spent. ${open.length} settlement(s) pending.`,
        data,
      );
    },
  );

  server.registerTool(
    "get_job",
    {
      title: "Get a job's evidence",
      description: "Status of a job and the chain of evidence: quote, IOU, delivery, dispute, epoch, HSP settlement.",
      inputSchema: { jobId: z.string() },
    },
    async ({ jobId }) => {
      const j = (await fetch(`${API}/v1/jobs/${jobId}`).then((r) => r.json())) as Record<string, unknown>;
      return text(`${WEB}/jobs/${jobId}\n${JSON.stringify(j, null, 2).slice(0, 8000)}`);
    },
  );

  await server.connect(new StdioServerTransport());
  log("ready on stdio");
}

/** Accept plain strings for the common services. */
function normalise(service: string, input: string | Record<string, unknown>): unknown {
  if (typeof input !== "string") return input;
  if (service === "search") return { query: input };
  if (service === "factcheck") return { claim: input };
  if (service === "brief") return { topic: input, languages: /hindi/i.test(input) ? ["en", "hi"] : ["en"] };
  if (service === "translate") return { text: input, to: "hi" };
  if (service === "summarize") return { title: "Document", text: input };
  return input;
}

main().catch((err) => {
  log(err instanceof Error ? err.message : err);
  process.exit(1);
});

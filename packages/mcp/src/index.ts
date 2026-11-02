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
 * Shopping (the demo stores):
 *   shop_for         hire the Concierge, which hires Pricewise, Scout, Clipper and Scribe
 *   add_to_cart      put one researched option in a store's cart
 *   checkout         open an HSP Agentic Payment order and lock a quote for this wallet
 *   approve_payment  sign HSP's EIP-712 data locally (the key never leaves this machine)
 *   submit_payment   submit the signed payment mandate to HSP
 *   payment_status   HSP's status, attribution and transaction hash
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
    if (s.api === API && s.agentId) {
      // same agent and wallet, new spending intent: keeps any tokens sent to this wallet usable
      const r = await fetch(`${FLEET}/guest/renew`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId: s.agentId }) }).catch(() => null);
      const body = r ? ((await r.json().catch(() => ({}))) as { intentId?: string }) : {};
      if (r?.ok && body.intentId) {
        const renewed = { ...s, intentId: body.intentId };
        writeFileSync(file, JSON.stringify(renewed, null, 2));
        log(`guest agent #${s.agentId} renewed`);
        return renewed;
      }
    }
    // never lose a key: keep the old session next to the new one
    writeFileSync(join(dir, `guest-${chainId}-${s.agentId || "old"}-${Date.now()}.json`), readFileSync(file, "utf8"));
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

/** A network blip at startup should not take the server down: retry a few times first. */
async function retry<T>(what: string, fn: () => Promise<T>, attempts = 5): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts) throw err;
      log(`${what} failed (${(err as Error).message}); retrying`);
      await new Promise((r) => setTimeout(r, 1_500 * i));
    }
  }
}

async function main() {
  const cfg = await retry("reading the clearing config", async () => {
    const r = await fetch(`${API}/v1/config`, { signal: AbortSignal.timeout(8_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as { chain: { id: number; name: string } };
  });
  const s = await retry("opening the session", () => session(cfg.chain.id));
  const agent = await retry("connecting the agent", () => KohakuAgent.connect({ privateKey: s.privateKey, clearingUrl: API, agentId: s.agentId ? BigInt(s.agentId) : undefined }));
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

  // ---------------------------------------------------------------- shopping

  const fleetCall = async <T>(path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${FLEET}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    const j = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
    return j;
  };
  const screen = (id: string) => `${WEB}/shop/${id}`;
  const raw = (v: string | null | undefined, decimals: number) => {
    if (!v) return "?";
    const n = BigInt(v);
    const d = 10n ** BigInt(decimals);
    const frac = (n % d).toString().padStart(decimals, "0").replace(/0+$/, "");
    return `${n / d}${frac ? `.${frac}` : ""}`;
  };
  interface CheckoutView {
    status: string;
    merchantName: string;
    payTo: string;
    payer: string;
    amountUsd: string;
    token: { address: string; symbol: string; decimals: number; protocol: string };
    network: { chainId: number; name: string; displayName: string };
    flowId: string;
    paymentRequestId: string;
    tokenTotalRaw: string | null;
    quoteExpiresAt: string | null;
    gasFeeAdvanced: boolean | null;
    txHash: string | null;
    attributionVerified: boolean | null;
    statusReason: string | null;
    simulationAllowed?: boolean;
    simulated?: boolean;
  }
  const pending = new Map<string, { eip712: { domain: Record<string, unknown>; types: Record<string, { name: string; type: string }[]>; primaryType: string; message: Record<string, unknown> }; checkout: CheckoutView }>();
  const review = (c: CheckoutView) =>
    [
      `Merchant (team attribution): ${c.merchantName}`,
      `Recipient (pay_to): ${c.payTo}`,
      `Payer (this wallet): ${c.payer}`,
      `Amount to sign (token_total_raw): ${c.tokenTotalRaw ?? "?"} raw units = ${raw(c.tokenTotalRaw, c.token.decimals)} ${c.token.symbol} (${c.token.address}) on ${c.network.displayName}`,
      c.gasFeeAdvanced === null ? null : `Network fee: ${c.gasFeeAdvanced ? "advanced by HSP, not in the amount" : "included in the amount"}`,
      c.quoteExpiresAt ? `Quote valid until ${c.quoteExpiresAt}` : null,
      `HSP flow ${c.flowId}, payment request ${c.paymentRequestId}`,
    ]
      .filter(Boolean)
      .join("\n");

  server.registerTool(
    "shop_for",
    {
      title: "Shop with Kohaku agents",
      description:
        "Research a purchase. Hires Kohaku's Concierge, which pays other agents to do the work: Pricewise buys a quote from every store, Scout reads live spec sheets from Wikipedia, Clipper buys promo lists and checks every coupon, Scribe writes a summary. Every hire is a signed IOU; they net into a few HSP settlements at the end of the epoch. Returns ranked options and a link to the live screen. The stores, prices and coupons are a demo catalogue; specs are real.",
      inputSchema: {
        need: z.string().describe("what the user wants, in their words, e.g. 'a phone under $500 with a great camera'"),
        budgetUsd: z.number().optional().describe("the user's budget in USD, if they gave one"),
      },
    },
    async ({ need, budgetUsd }) => {
      const concierge = await resolve("concierge");
      const r = await agent.hire<{
        session: string;
        options: { rank: number; modelId: string; name: string; withinBudget: boolean; specs: { chip: string | null; display: string | null; rearCamera: string | null; battery: string | null; url: string } | null; best: { storeName: string; store: string; price: number; coupon: { code: string; discount: number } | null; final: number; deliveryDays: number }; offers: { storeName: string; final: number }[] }[];
        summary: string | null;
        jobs: number;
        spentUsd: string;
        catalogue: string;
      }>(concierge, "shop", { need, ...(budgetUsd ? { budgetUsd } : {}) }, { intentId: s.intentId, maxPrice: usd("0.06") });
      const out = r.result;
      const lines = out.options.map((o) => {
        const sp = o.specs;
        return [
          `${o.rank}. ${o.name}: $${o.best.final.toFixed(2)} at ${o.best.storeName}${o.best.coupon ? ` (list $${o.best.price}, code ${o.best.coupon.code} saves $${o.best.coupon.discount})` : ""}, delivery ${o.best.deliveryDays} day(s)${o.withinBudget ? "" : " [over budget]"}`,
          sp ? `   chip ${sp.chip ?? "?"}; camera ${(sp.rearCamera ?? "?").split(";").slice(0, 2).join(";")}; battery ${sp.battery ?? "?"}; display ${(sp.display ?? "?").split(";")[0]} (${sp.url})` : "   specs unavailable",
          `   other stores: ${o.offers.slice(1).map((x) => `${x.storeName} $${x.final.toFixed(2)}`).join(", ") || "none in stock"}`,
        ].join("\n");
      });
      return text(
        [
          `Shopping session ${out.session}. Live screen: ${screen(out.session)}`,
          `Concierge charged $${formatUnits(r.price, 2)}; the agents made ${out.jobs} paid jobs between them ($${out.spentUsd} in IOUs, cleared at epoch ${r.epoch}).`,
          "",
          ...lines,
          "",
          out.summary ? `Summary: ${out.summary}` : "",
          out.catalogue,
          "Ask the user which option to buy; then call add_to_cart with this session.",
        ].join("\n"),
        { ...out, next: "Show the top options briefly with the live screen link, then ask which one to buy and call add_to_cart." } as unknown as Record<string, unknown>,
      );
    },
  );

  server.registerTool(
    "add_to_cart",
    {
      title: "Add to cart",
      description: "Put one option from a shopping session in the store's cart (only after the user picked it). Defaults to that option's cheapest store after coupons.",
      inputSchema: {
        session: z.string(),
        option: z.number().optional().describe("rank from shop_for, e.g. 1"),
        model: z.string().optional().describe("model id instead of rank, e.g. 'pixel-10a'"),
        store: z.string().optional().describe("store slug, to override the cheapest store"),
      },
    },
    async ({ session: id, option, model, store }) => {
      const r = await fleetCall<{ cart: { storeName: string; lines: { name: string; price: number; coupon: string | null; discount: number; total: number }[]; total: number; depositUsd: string; payTo: string }; merchantName: string; payTo: string }>(
        `/shop/sessions/${id}/cart`,
        { option, model, store },
      );
      const c = r.cart;
      return text(
        [
          `Added to the cart at ${c.storeName}:`,
          ...c.lines.map((l) => `- ${l.name}: $${l.price.toFixed(2)}${l.coupon ? ` - ${l.coupon} $${l.discount.toFixed(2)}` : ""} = $${l.total.toFixed(2)}`),
          `Cart total $${c.total.toFixed(2)}. On testnet the checkout takes a pre-booking payment of $${c.depositUsd} through HSP Agentic Payment.`,
          `Live screen: ${screen(id)}`,
          "",
          "Before calling checkout, confirm these with the user ONE AT A TIME, waiting for each reply (HSP's rule):",
          `1. merchant_name: "${r.merchantName}"`,
          `2. recipient (pay_to): ${r.payTo} (${c.storeName}'s wallet)`,
          `3. payer: ${agent.address} (the user's Kohaku wallet in this session)`,
        ].join("\n"),
        { ...r, payer: agent.address, next: `Before checkout, confirm with the user ONE AT A TIME, waiting for each reply: 1) merchant_name "${r.merchantName}", 2) recipient pay_to ${r.payTo} (${r.cart.storeName}'s wallet), 3) payer ${agent.address} (this session's Kohaku wallet). Then call checkout with those values.` } as unknown as Record<string, unknown>,
      );
    },
  );

  server.registerTool(
    "checkout",
    {
      title: "Checkout through HSP",
      description:
        "Open an HSP Agentic Payment order for the cart and lock a 5-minute quote for this session's wallet. Call ONLY after the user has confirmed, one at a time, the merchant name, the recipient address and the payer address shown by add_to_cart. Pass those confirmed values unchanged. Nothing is signed or paid yet. Afterwards, show the user the recipient, payer and token_total_raw and wait for explicit approval before approve_payment.",
      inputSchema: {
        session: z.string(),
        merchantName: z.string().describe("the merchant name the user confirmed"),
        payTo: z.string().describe("the recipient address the user confirmed"),
        payer: z.string().describe("the payer address the user confirmed"),
      },
    },
    async ({ session: id, merchantName, payTo, payer }) => {
      if (payer.toLowerCase() !== agent.address.toLowerCase()) throw new Error(`this session can only sign for ${agent.address}`);
      const r = await fleetCall<{ checkout: CheckoutView; eip712: { domain: Record<string, unknown>; types: Record<string, { name: string; type: string }[]>; primaryType: string; message: Record<string, unknown> } }>(
        `/shop/sessions/${id}/checkout`,
        { merchantName, payTo, payer },
      );
      pending.set(id, { eip712: r.eip712, checkout: r.checkout });
      const c = r.checkout;
      const bal = (await agent.publicClient.readContract({ address: c.token.address as Hex, abi: erc20Abi, functionName: "balanceOf", args: [agent.address] }).catch(() => 0n)) as bigint;
      const simulation =
        c.simulationAllowed && c.tokenTotalRaw && bal < BigInt(c.tokenTotalRaw)
          ? `Heads up for the user: this wallet holds ${raw(bal.toString(), c.token.decimals)} of HSP's ${c.token.symbol}, less than the quote, so after signing the submission and confirmations will be SIMULATED and labelled; no money moves. The order and quote are real.`
          : null;
      return text(
        [simulation, "HSP order created and quote locked. Show the user these and wait for explicit approval before calling approve_payment:", review(c), `Live screen: ${screen(id)}`].filter(Boolean).join("\n"),
        { ...c, simulation, next: "Show the user the recipient, the payer and token_total_raw (with the USDC amount), mention the simulation note if there is one, and wait for explicit approval before approve_payment." } as unknown as Record<string, unknown>,
      );
    },
  );

  server.registerTool(
    "approve_payment",
    {
      title: "Sign the HSP payment",
      description:
        "Sign HSP's EIP-712 payment authorization with this session's wallet, locally, then have HSP build the payment mandate. Call ONLY after the user explicitly approved the recipient, payer and token_total_raw from checkout. Checks the wallet holds enough of HSP's token first. Afterwards show the same details again and wait for explicit approval before submit_payment.",
      inputSchema: { session: z.string() },
    },
    async ({ session: id }) => {
      // the MCP server may have restarted since checkout: the store keeps the prepared payment
      const p = pending.get(id) ?? (await fleetCall<{ checkout: CheckoutView; eip712: { domain: Record<string, unknown>; types: Record<string, { name: string; type: string }[]>; primaryType: string; message: Record<string, unknown> } }>(`/shop/sessions/${id}/checkout/prepared`));
      const c = p.checkout;
      if (c.quoteExpiresAt && Date.parse(c.quoteExpiresAt) < Date.now()) throw new Error("the 5-minute HSP quote expired; call checkout again for a fresh quote");
      const balance = (await agent.publicClient.readContract({ address: c.token.address as Hex, abi: erc20Abi, functionName: "balanceOf", args: [agent.address] })) as bigint;
      const short = !!c.tokenTotalRaw && balance < BigInt(c.tokenTotalRaw);
      if (short && !c.simulationAllowed) {
        return text(
          `Not signing: ${agent.address} holds ${raw(balance.toString(), c.token.decimals)} ${c.token.symbol} (${c.token.address}) but the payment needs ${raw(c.tokenTotalRaw, c.token.decimals)}. The team has to fund this wallet with HSP's ${c.token.symbol} by hand, then call checkout again for a fresh quote.`,
        );
      }
      const types = { ...p.eip712.types };
      delete (types as Record<string, unknown>).EIP712Domain;
      const signature = await agent.account.signTypedData!({ domain: p.eip712.domain, types, primaryType: p.eip712.primaryType, message: p.eip712.message } as never);
      const r = await fleetCall<{ checkout: CheckoutView }>(`/shop/sessions/${id}/checkout/finalize`, { signature });
      pending.delete(id);
      const simNote = short
        ? `SIMULATION: this wallet holds ${raw(balance.toString(), c.token.decimals)} ${c.token.symbol}, less than the quote, so the store will simulate the submission and confirmations. Tell the user plainly that the payment step is simulated and no funds move.`
        : null;
      return text(
        [simNote, "Signed locally and HSP built the payment mandate. Show the user these again and wait for explicit approval before calling submit_payment:", review(r.checkout), `Live screen: ${screen(id)}`].filter(Boolean).join("\n"),
        { ...r.checkout, simulation: simNote, next: "Show the recipient, payer and token_total_raw again and wait for explicit approval before submit_payment." } as unknown as Record<string, unknown>,
      );
    },
  );

  server.registerTool(
    "submit_payment",
    {
      title: "Submit the HSP payment",
      description: "Submit the signed payment mandate to HSP. Call ONLY after the user explicitly approved submission. payment-submitted is not final; use payment_status until payment-safe or payment-finalized.",
      inputSchema: { session: z.string() },
    },
    async ({ session: id }) => {
      const r = await fleetCall<{ checkout: CheckoutView }>(`/shop/sessions/${id}/checkout/submit`, {});
      return text(
        [
          r.checkout.simulated
            ? `SIMULATED HSP payment: ${r.checkout.status}. Nothing was submitted to HSP's gateway (the payer holds no HSP test USDC); the confirmations on the live screen are simulated and labelled.`
            : `HSP status: ${r.checkout.status}. This is not final confirmation yet; the server polls HSP every 15 s and the live screen updates.`,
          review(r.checkout),
          `Live screen: ${screen(id)}`,
        ].join("\n"),
        { ...r.checkout, next: r.checkout.simulated ? "Tell the user the payment is simulated (no transaction exists); poll payment_status until payment-finalized and label every status (simulated)." : "Poll payment_status every 15 s until payment-safe or payment-finalized." } as unknown as Record<string, unknown>,
      );
    },
  );

  server.registerTool(
    "payment_status",
    {
      title: "HSP payment status",
      description: "HSP's current status for a shopping session's payment, the team attribution check and the transaction hash. payment-safe means on chain with half the required confirmations, not final; payment-finalized is final.",
      inputSchema: { session: z.string() },
    },
    async ({ session: id }) => {
      const sess = await fleetCall<{ checkout: CheckoutView | null; cart: { storeName: string; total: number } | null }>(`/shop/sessions/${id}`);
      const c = sess.checkout;
      if (!c) return text(sess.cart ? `Cart at ${sess.cart.storeName} ($${sess.cart.total.toFixed(2)}); no checkout yet.` : "No cart yet.");
      const explorer = cfg.chain.id === 133 ? "https://testnet-explorer.hskchain.net" : "https://hashkey.blockscout.com";
      return text(
        [
          c.simulated ? "HSP Agentic Payment — SIMULATED (no transaction was submitted)" : "HSP Agentic Payment — QA result",
          `Payment status: ${c.status}${c.simulated ? " (simulated)" : ""}`,
          `Hackathon team: ${c.merchantName}`,
          `Team attribution verified: ${c.attributionVerified ?? "unavailable"}`,
          `Network: ${c.network.name}`,
          `Raw authorization amount (raw units): ${c.tokenTotalRaw ?? "unavailable"}`,
          `Recipient address: ${c.payTo}`,
          `Payer address: ${c.payer}`,
          `Transaction hash: ${c.txHash ?? "unavailable"}${c.txHash ? ` (${explorer}/tx/${c.txHash})` : ""}`,
          c.statusReason ? `Reason: ${c.statusReason}` : "",
          `Live screen: ${screen(id)}`,
        ].join("\n"),
        c as unknown as Record<string, unknown>,
      );
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

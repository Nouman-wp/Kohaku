// Shopping smoke test: spawn the MCP server over stdio like Claude would, research a phone
// with the Concierge, add the top option to the cart and (with SHOP_CHECKOUT=1, on a server
// HSP allowlists) open the HSP Agentic Payment checkout.
// Run with the stack up: pnpm --filter @kohaku/mcp shop
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(here, "..", "node_modules", "tsx", "dist", "cli.mjs"), join(here, "..", "src", "index.ts")],
  env: { ...process.env } as Record<string, string>,
  stderr: "inherit",
});
const client = new Client({ name: "kohaku-shop-smoke", version: "0.0.1" });
await client.connect(transport);

const call = async (name: string, args: Record<string, unknown>) => {
  const r = (await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 })) as { content: { text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
  console.log(`--- ${name}${r.isError ? " (error)" : ""}\n${(r.content[0]?.text ?? "").slice(0, 2400)}\n`);
  if (r.isError) process.exitCode = 1;
  return r;
};

const t0 = Date.now();
const shop = await call("shop_for", { need: process.env.SHOP_NEED ?? "a phone under $500 with a great camera", budgetUsd: Number(process.env.SHOP_BUDGET ?? 500) });
const session = shop.structuredContent?.session as string | undefined;
console.log(`research took ${((Date.now() - t0) / 1000).toFixed(1)} s`);
if (session) {
  const cart = await call("add_to_cart", { session, option: 1 });
  if (process.env.SHOP_CHECKOUT === "1") {
    const c = cart.structuredContent as { merchantName: string; payTo: string } | undefined;
    const balance = await call("check_balance", {});
    const payer = (balance.structuredContent as { wallet?: string } | undefined)?.wallet;
    if (c && payer) await call("checkout", { session, merchantName: c.merchantName, payTo: c.payTo, payer });
  }
}
await client.close();

// End-to-end smoke test: spawn the MCP server over stdio like Claude Desktop would, then
// list tools, find an agent, hire it and check the balance.
// Run with the stack up (`pnpm dev`): pnpm --filter @kohaku/mcp smoke
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
const client = new Client({ name: "kohaku-smoke", version: "0.0.1" });
await client.connect(transport);

const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(", "));

const show = (r: unknown) => console.log(((r as { content: { text: string }[] }).content[0]?.text ?? "").slice(0, 700), "\n");

show(await client.callTool({ name: "find_agent", arguments: { capability: "search" } }));
show(await client.callTool({ name: "get_quote", arguments: { agent: "scout", service: "search", input: "Taj Mahal" } }));
show(await client.callTool({ name: "hire_agent", arguments: { agent: "scout", service: "search", input: "Taj Mahal", maxPriceUsd: 0.01 } }));
show(await client.callTool({ name: "check_balance", arguments: {} }));

await client.close();

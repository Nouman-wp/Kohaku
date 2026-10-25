#!/usr/bin/env node
// Run the backend of a public deployment on this machine:
//   clearing service + agent fleet + edge proxy (one port) [+ a Cloudflare quick tunnel]
//
//   node scripts/serve.mjs testnet             uses .env.testnet
//   node scripts/serve.mjs testnet --tunnel    also opens https://<random>.trycloudflare.com
//
// The tunnel URL is written to .data/tunnel-<network>.url; `node scripts/publish-web.mjs`
// points the website's proxy at it. Any host with a public port can run this instead.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ROOT, loadEnv, run, useNetworkEnv, waitFor } from "./lib.mjs";
import { startEdge } from "./edge.mjs";

const network = process.argv[2] ?? "testnet";
const withTunnel = process.argv.includes("--tunnel");
useNetworkEnv(network);
const env = loadEnv();
if (!env.KOHAKU_CHAIN || env.KOHAKU_CHAIN === "local") throw new Error(`.env.${network} is not a public network config`);

const children = [];
const stop = () => {
  for (const c of children) {
    try {
      if (process.platform === "win32") run("chain", "taskkill", ["/pid", String(c.pid), "/T", "/F"]);
      else c.kill("SIGTERM");
    } catch {
      // gone
    }
  }
  setTimeout(() => process.exit(0), 600);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

const shell = process.platform === "win32";
const tsxIn = (pkg) => join(ROOT, pkg, "node_modules", ".bin", shell ? "tsx.cmd" : "tsx");
const port = Number(env.PORT ?? 8787);
const fleetPort = Number(env.FLEET_PORT ?? 8788);
const edgePort = Number(env.EDGE_PORT ?? 8790);

children.push(run("clearing", tsxIn("services/clearing"), ["src/index.ts"], { cwd: join(ROOT, "services", "clearing"), shell }));
await waitFor(() => fetch(`http://localhost:${port}/v1/config`).then((r) => r.ok), "clearing service", 180_000);
children.push(run("fleet", tsxIn("services/fleet"), ["src/index.ts"], { cwd: join(ROOT, "services", "fleet"), shell }));
startEdge({ port: edgePort, clearingPort: port, fleetPort });

if (withTunnel) {
  const exe = [join(homedir(), ".kohaku", "bin", shell ? "cloudflared.exe" : "cloudflared"), "cloudflared"].find((p) => p === "cloudflared" || existsSync(p));
  const t = run("tunnel", exe, ["tunnel", "--no-autoupdate", "--url", `http://localhost:${edgePort}`]);
  children.push(t);
  const onData = (d) => {
    const m = d.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (!m) return;
    mkdirSync(join(ROOT, ".data"), { recursive: true });
    writeFileSync(join(ROOT, ".data", `tunnel-${network}.url`), m[0]);
    console.log(`\n  tunnel  ${m[0]}  (written to .data/tunnel-${network}.url)\n`);
  };
  t.stdout.on("data", onData);
  t.stderr.on("data", onData);
}
console.log(`\n  Kohaku ${network} backend\n  API    http://localhost:${port}/v1/stats\n  Fleet  http://localhost:${fleetPort}/control/status\n  Edge   http://localhost:${edgePort}\n  Ctrl+C to stop.\n`);

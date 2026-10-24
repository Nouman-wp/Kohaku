#!/usr/bin/env node
// One command for the whole system on a local chain:
//   anvil -> contracts -> clearing service -> agent fleet -> website
// For a public network set KOHAKU_CHAIN in .env; anvil and the deploy step are skipped.
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ROOT, bin, ensureLocalEnv, loadEnv, rpc, run, waitFor } from "./lib.mjs";
import { deploy } from "./deploy.mjs";

const children = [];
const stop = () => {
  for (const c of children) {
    try {
      if (process.platform === "win32") run("chain", "taskkill", ["/pid", String(c.pid), "/T", "/F"]);
      else c.kill("SIGTERM");
    } catch {
      // already gone
    }
  }
  setTimeout(() => process.exit(0), 600);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

if (ensureLocalEnv()) console.log("wrote a local .env (anvil dev keys)");
const env = loadEnv();
const chain = env.KOHAKU_CHAIN ?? "local";
const tsxIn = (pkg) => join(ROOT, pkg, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");

async function main() {
  if (chain === "local") {
    const up = await rpc("http://127.0.0.1:8545", "eth_chainId").catch(() => null);
    if (!up) {
      children.push(run("chain", bin("anvil"), ["--port", "8545", "--silent", "--accounts", "10", "--balance", "100000"]));
      await waitFor(() => rpc("http://127.0.0.1:8545", "eth_chainId"), "anvil");
    }
    let fresh = true;
    const file = join(ROOT, "contracts", "deployments", "31337.json");
    if (existsSync(file)) {
      const d = JSON.parse((await import("node:fs")).readFileSync(file, "utf8"));
      const code = await rpc("http://127.0.0.1:8545", "eth_getCode", [d.clearingHouse, "latest"]).catch(() => "0x");
      fresh = code === "0x";
    }
    if (fresh) {
      // a new chain: deploy, and drop any local ledger that belonged to a previous chain
      const dataDir = join(ROOT, ".data");
      if (existsSync(dataDir)) for (const f of readdirSync(dataDir)) if (f.startsWith("kohaku-local-")) rmSync(join(dataDir, f), { force: true });
      await deploy("local");
    }
  }

  const shell = process.platform === "win32";
  children.push(run("clearing", tsxIn("services/clearing"), ["src/index.ts"], { cwd: join(ROOT, "services", "clearing"), shell }));
  const api = `http://localhost:${env.PORT ?? 8787}`;
  await waitFor(() => fetch(`${api}/v1/config`).then((r) => r.ok), "clearing service", 90_000);
  children.push(run("fleet", tsxIn("services/fleet"), ["src/index.ts"], { cwd: join(ROOT, "services", "fleet"), shell }));
  const vite = join(ROOT, "apps", "web", "node_modules", ".bin", process.platform === "win32" ? "vite.cmd" : "vite");
  children.push(run("web", vite, [], { cwd: join(ROOT, "apps", "web"), shell }));
  console.log(`\n  Kohaku is starting.\n  Website   http://localhost:5173\n  API       ${api}/v1/stats\n  Fleet     http://localhost:${env.FLEET_PORT ?? 8788}/control/status\n  Ctrl+C to stop.\n`);
}

main().catch((e) => {
  console.error(e);
  stop();
});

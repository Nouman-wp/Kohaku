#!/usr/bin/env node
// Build the website and publish it to Vercel, with Vercel proxying the backend paths to the
// machine running `node scripts/serve.mjs <network> --tunnel`:
//
//   /v1/*  /hsp/*  /agents/*  /guest(s)/*  /control/*   ->  <backend>
//
// so the public site, the API, the HSP gateway and every agent card (whose URLs are written
// on chain) live under one stable domain. Vercel does not proxy WebSockets, so the live feed
// connects to the backend directly.
//
//   node scripts/publish-web.mjs testnet                       backend = .data/tunnel-testnet.url
//   node scripts/publish-web.mjs testnet --backend https://x   any public backend URL
//   node scripts/publish-web.mjs testnet --site https://kohaku-xi.vercel.app
//
// Needs the Vercel CLI, logged in, and apps/web linked to a project (`vercel link`).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib.mjs";

const network = process.argv[2] ?? "testnet";
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const tunnelFile = join(ROOT, ".data", `tunnel-${network}.url`);
const backend = (arg("backend") ?? (existsSync(tunnelFile) ? readFileSync(tunnelFile, "utf8").trim() : "")).replace(/\/+$/, "");
if (!backend) throw new Error(`no backend URL: start \`node scripts/serve.mjs ${network} --tunnel\` or pass --backend`);
const siteFile = join(ROOT, ".data", `site-${network}.url`);
const site = (arg("site") ?? (existsSync(siteFile) ? readFileSync(siteFile, "utf8").trim() : "")).replace(/\/+$/, "");

const web = join(ROOT, "apps", "web");
const shell = process.platform === "win32";
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: web, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", shell, ...opts });

// 1. build: REST through the site's own origin, the live feed straight to the backend
const env = {
  ...process.env,
  VITE_KOHAKU_API: site || backend,
  VITE_KOHAKU_FLEET: site || backend,
  VITE_KOHAKU_WS: backend.replace(/^http/, "ws"),
};
console.log(`building for ${site || "(site URL not known yet)"} -> backend ${backend}`);
execFileSync(shell ? "pnpm.cmd" : "pnpm", ["run", "build"], { cwd: web, env, stdio: "inherit", shell });

// 2. routing: backend paths are proxied, everything else is the single-page app
const proxied = ["v1", "hsp", "agents", "guest", "guests", "control"];
writeFileSync(
  join(web, "dist", "vercel.json"),
  JSON.stringify(
    {
      cleanUrls: false,
      rewrites: [...proxied.map((p) => ({ source: `/${p}/:path*`, destination: `${backend}/${p}/:path*` })), { source: "/(.*)", destination: "/index.html" }],
      headers: [{ source: "/assets/(.*)", headers: [{ key: "cache-control", value: "public, max-age=31536000, immutable" }] }],
    },
    null,
    2,
  ),
);

// 3. deploy the static build to the linked project
const link = JSON.parse(readFileSync(join(web, ".vercel", "project.json"), "utf8"));
const vercelEnv = { ...process.env, VERCEL_ORG_ID: link.orgId, VERCEL_PROJECT_ID: link.projectId };
const out = sh("vercel", ["deploy", "dist", "--prod", "--yes"], { env: vercelEnv });
let deployment;
try {
  deployment = JSON.parse(out).deployment.url;
} catch {
  deployment = out.match(/https:\/\/\S+/)?.[0];
}
console.log(`deployed ${deployment}`);

// 4. the project's production domain (its shortest alias), remembered for the next build
const ins = spawnSync("vercel", ["inspect", deployment], { cwd: web, env: vercelEnv, encoding: "utf8", shell });
const aliases = [...`${ins.stdout}${ins.stderr}`.matchAll(/https:\/\/[a-z0-9.-]+\.vercel\.app/g)].map((m) => m[0]).filter((u) => u !== deployment);
const prod = aliases.sort((x, y) => x.length - y.length)[0];
if (prod) {
  writeFileSync(siteFile, prod);
  console.log(`production ${prod}`);
  if (prod !== site) console.log(`built for ${site || backend}; run again to build against ${prod}`);
}

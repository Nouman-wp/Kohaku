# Deploying Kohaku to HashKey Chain

This is the runbook for taking Kohaku from `pnpm dev` on a laptop to HashKey Chain testnet and
mainnet with a public website. Every step is a script in the repository; each one takes the
network name (`testnet` or `mainnet`) and reads `.env.testnet` / `.env.mainnet`.

## 1. Wallets

```bash
DEPLOYER_PRIVATE_KEY=0x<funded key> node scripts/wallets.mjs testnet
```

writes `.env.testnet` (git-ignored) with a fresh key for every role and prints the addresses. Run it
again any time: it only fills in what is missing. `--show` prints the addresses only.

| Variable | Role | Needs |
|---|---|---|
| `DEPLOYER_PRIVATE_KEY` | deploys the contracts, owns the few admin functions, funds the others | HSK |
| `CLEARER_PRIVATE_KEY` | the clearing service: posts IOUs, finalises epochs, records HSP settlements, defaults, payouts, reputation | HSK (it sends most transactions) |
| `HSP_GATEWAY_RELAYER_KEY` | local HSP gateway: relays the debtors' EIP-3009 authorizations | HSK |
| `FLEET_OPERATOR_KEY` | operator of the fleet agents: registers them, posts collateral, signs intents, funds guests and the validator's gas | HSK + stablecoin (minted on testnet) |
| `ROGUE_OPERATOR_KEY` | operator of Rogue, so compliance views show two operators | a little HSK |
| `FLEET_SEED` | each agent's key is `keccak(seed, "kohaku/agent/<slug>")` | agents need **no gas**: HSP relays their payments |
| `HSP_MERCHANT_PRIVATE_KEY` | signs the merchant JWT on every HSP order; register its public key with HashKey for merchant mode | nothing |
| `HSP_APP_SECRET`, `ADMIN_TOKEN` | gateway/webhook HMAC secret, scenario-runner token | nothing |

Back the file up. It holds every key of the deployment.

## 2. Testnet (chain 133)

1. Fund the deployer with testnet HSK (<https://faucet.hsk.xyz/faucet>, or the bridge).
2. Deploy:

   ```bash
   node scripts/deploy.mjs testnet
   ```

   With `SETTLEMENT_TOKEN` empty this deploys **Kohaku Test USDC** (EIP-3009, open faucet): HSP's own
   testnet USDC (`0x8FE3…53c6`) can only be minted by its owner. Addresses land in
   `contracts/deployments/133.json`; commit that file. Contracts are verified on Blockscout when the
   explorer is reachable.
3. Fund the service wallets from the deployer (each is topped up to a target, never above):

   ```bash
   node scripts/fund.mjs testnet          # --dry to preview
   ```

   A busy testnet epoch costs about 0.002 HSK, so 0.3 HSK on the clearer lasts several days at one
   background brief every 30 minutes.
4. Set the public base in `.env.testnet` to the website's domain (agent card URLs are written on
   chain at registration, so it must not change):

   ```ini
   PUBLIC_API_URL=https://kohaku-xi.vercel.app
   PUBLIC_FLEET_URL=https://kohaku-xi.vercel.app
   ```

5. Run the backend:

   ```bash
   node scripts/serve.mjs testnet           # clearing service + fleet + edge proxy on :8790
   ```

   On first start the fleet registers its agents, deposits collateral, stakes the validator and signs
   standing intents. Re-running is safe: it only tops up what is missing.
6. End-to-end check against the running backend:

   ```bash
   KOHAKU_ENV_FILE=.env.testnet node scripts/e2e.mjs
   ```

## 3. Public website (Vercel)

The website is a static build on Vercel; Vercel proxies `/v1`, `/hsp`, `/agents`, `/guest(s)` and
`/control` to the backend, so every public URL (and every on-chain agent URI) lives under one stable
domain while the backend can move.

1. The backend must be reachable over HTTPS. Either run it on a server (section 4: a free Oracle
   Cloud VM works for testnet and mainnet), or open a Cloudflare quick tunnel from this machine:

   ```bash
   node scripts/serve.mjs testnet --tunnel   # writes .data/tunnel-testnet.url
   ```

2. Publish (links the build to that backend and deploys `apps/web/dist` to the linked project):

   ```bash
   node scripts/publish-web.mjs testnet                     # uses .data/tunnel-testnet.url
   node scripts/publish-web.mjs testnet --backend https://api.example.com
   ```

   Run it again whenever the backend URL changes (a quick tunnel gets a new URL on every start).
   Vercel does not proxy WebSockets, so the live feed connects to the backend URL directly.

## 4. A free server for the backend

The backend has to stay on all the time: epochs close on a timer, the fleet runs background work,
the live feed is a WebSocket and the ledger is a SQLite file on disk. Hosts that sleep when idle or
wipe the disk on restart (Render's and Koyeb's free tiers, for example) stop epochs half way and lose
the ledger. Pick a real VM:

| Host | Free | Notes |
|---|---|---|
| Oracle Cloud Always Free | Arm VM up to 2 OCPU / 12 GB, 200 GB disk | Best fit; testnet and mainnet fit side by side. Card needed for verification. Choose a small shape (1 OCPU / 4 GB): Oracle may reclaim VMs that sit under 20% CPU, network and memory for a week. |
| Google Cloud e2-micro | 1 GB RAM, 30 GB disk, US regions | Enough for testnet (the setup script adds swap). Card needed. |
| AWS EC2, Free plan | $100 credit at sign-up (up to $100 more for onboarding tasks), no charges while on the Free plan; it ends after 6 months or when the credit runs out | Accounts on the new AWS experience can only create resources in the project's Region (ours is Sydney, `ap-southeast-2`). Kohaku testnet runs on a `t3.small` (2 GB) with CPU credits set to `standard`, so bursts never bill extra. Attach an Elastic IP so the address survives a stop and start. Card needed. |

1. Create an Ubuntu 24.04 VM and open TCP 80 and 443 in the cloud firewall (on Oracle: the VCN's
   security list; on AWS: the instance's security group). Point a domain at its public IP: an `A`
   record such as `kohaku-api.caspx.in`, or a free DuckDNS name.
2. On the server:

   ```bash
   git clone https://github.com/Nouman-wp/Kohaku.git && cd Kohaku
   sudo bash deploy/vm/setup.sh kohaku-api.caspx.in
   ```

   It installs Node 24, pnpm and Caddy (automatic HTTPS), puts the code in `/opt/kohaku` under a
   `kohaku` user and installs the `kohaku@<network>` systemd unit. Before the `A` record exists,
   give Caddy a second name that already resolves to the server, built from its IP with dashes:
   `sudo bash deploy/vm/setup.sh "kohaku-api.caspx.in, 16-178-199-139.sslip.io"`. Caddy serves the
   sslip.io name at once and picks up the certificate for the real one when DNS appears.
3. Copy `.env.testnet` to `/opt/kohaku/` (scp; it never goes through git) and run the setup script
   again to lock its permissions. Bring the ledger too: stop the backend here and copy
   `.data/kohaku-hashkey-testnet-*.sqlite*`, or restore it from the Supabase mirror (section 5).
4. `sudo systemctl enable --now kohaku@testnet`, then `journalctl -u kohaku@testnet -f`.
5. Here: `node scripts/publish-web.mjs testnet --backend https://kohaku-api.caspx.in`. With the website
   on its own domain as well (a `CNAME` such as `kohaku.caspx.in`, added to the Vercel project first),
   add `--site https://kohaku.caspx.in`. `kohaku-xi.vercel.app` keeps working, and the agent cards
   registered on chain point at it.

Mainnet runs next to it on its own ports (`PORT=8797`, `FLEET_PORT=8798`, `EDGE_PORT=8800` in
`.env.mainnet`) with `kohaku@mainnet` and a second domain in `/etc/caddy/Caddyfile`.

## 5. Supabase mirror

SQLite stays the clearing service's engine; Supabase can keep a live copy of it, for an off-server
backup and a dashboard of agents, operators, jobs, IOUs and settlements (DECISIONS §27).

1. Create a free project at <https://supabase.com>. In the SQL editor, run `supabase/schema.sql`
   (regenerate it with `node scripts/supabase-schema.mjs` after a schema change and run it again).
2. Put the project URL and its secret key (Project Settings → API keys) in `.env.testnet`:

   ```ini
   SUPABASE_URL=https://<project>.supabase.co
   SUPABASE_SECRET_KEY=sb_secret_...
   ```

   The secret key bypasses row level security: it stays on the server, never in the website.
3. Restart the backend. The first start queues every existing row; after that each change reaches
   Supabase within a few seconds. `GET /v1/health` shows `mirror.pending` and `mirror.lastError`.
   If Supabase is unreachable the service carries on and the queue catches up later.
4. To rebuild a server's ledger from the mirror (new machine, lost disk):

   ```bash
   node scripts/db-restore.mjs testnet               # refuses to overwrite an existing ledger
   node scripts/db-restore.mjs testnet --out /tmp/x  # dry run somewhere else
   ```

Every row carries a `deployment` column (`kohaku-hashkey-testnet-a4f5f3f3`), so testnet, mainnet
and later redeploys share one free project. The `operators` view lists every operator wallet with
its agents and intents. A free project pauses after a week without activity; a running backend
writes every epoch, which keeps it awake.

## 6. Switching HSP to HashKey Merchant

HashKey's HSP docs are at <https://hashkey-merchant.github.io>. Onboarding ("Merchant onboarding")
asks for these, sent to HashKey's operations team:

| Field | Kohaku |
|---|---|
| `organization_name` | Kohaku |
| `email` | the admin email that receives the invite |
| `description` | Clearing house for agent-to-agent payments on HashKey Chain |
| `default_language` | `en` |
| `service_rate` | `0.0000` |
| `public_key` | the PEM printed by `node scripts/wallets.mjs testnet --show` (`mainnet --show` for production) |
| `supported_chain_tokens` | `hashkey-testnet`, 133, USDC `0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6`, EIP-3009 (production: `hashkey`, 177, USDC `0x054ed45810DbBAb8B27668922D110669c9D88D0a`, EIP-3009) |

After the invite email, create an application in the merchant console. It gives the `app_key` and
`app_secret`. In **My Account → edit the app**, set the **Payment webhook URL** (HTTPS only) to
`https://<backend>/v1/hsp/webhook`. Then, with HSP test USDC in the agents' wallets:

```ini
SETTLEMENT_TOKEN=0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6     # testnet USDC that HSP supports
HSP_MODE=merchant
HSP_APP_KEY=<from the merchant console>
HSP_APP_SECRET=<from the merchant console>
# HSP_BASE_URL defaults to https://merchant-qa.hashkeymerchant.com on testnet and
# https://hsp.hashkey.com on mainnet (staging: https://merchant-stg.hashkeymerchant.com)
```

Redeploy (the token is fixed per deployment), fund the agents' wallets with that USDC and restart.
The service refuses to start if the host serves the other network's tokens, or if the token is not
one HSP settles by EIP-3009 (USDT on HashKey Chain uses Permit2). The clearing service and the agents
run the same code: orders go to HashKey, debtors pay through HashKey's `pay-mandate`, HashKey
relays the transfers, and Kohaku counts a payment once HashKey reports it `payment-safe` and the
transfer checks out on chain. The website shows "HashKey Merchant" instead of "HSP local gateway".

## 7. Mainnet (chain 177)

`node scripts/wallets.mjs mainnet` writes `.env.mainnet` with the researched settings:

- `SETTLEMENT_TOKEN=0x054ed45810DbBAb8B27668922D110669c9D88D0a` (USDC.e, "Bridged USDC", 6 decimals,
  EIP-3009). USDT on mainnet has no EIP-3009 and cannot be used. The deploy script refuses the test
  token on mainnet.
- Base fee is **500 gwei**: deploying costs about **4.8 HSK**, a busy epoch about **1 HSK**
  (measured on testnet, see DECISIONS §18). The mainnet file uses 10-minute epochs, reputation writes
  every 10 epochs and one background brief per hour, so about 25 HSK a day while the fleet runs;
  idle epochs cost nothing. Set `FLEET_BACKGROUND=off` between demos to stop spending.
- Fund: the deployer with ~35 HSK (4.8 to deploy, 28 for the service wallets, 1 kept in reserve);
  `node scripts/fund.mjs mainnet` tops the clearer up to 20 HSK, the relayer to 2, the fleet operator
  to 5 and the rogue operator to 1. The fleet operator also needs about 35 USDC.e (collateral,
  wallet floats and the validator stake); that money stays in Kohaku's wallets and can be withdrawn.

```bash
node scripts/deploy.mjs mainnet       # writes contracts/deployments/177.json, verifies on hashkey.blockscout.com
node scripts/fund.mjs mainnet
node scripts/serve.mjs mainnet
```

## 8. Pre-flight before a demo

- `GET /v1/health`: chain healthy, clearer has gas, HSP healthy, fleet reachable.
- `node scripts/e2e.mjs` against the deployment (set `KOHAKU_ENV_FILE` or `KOHAKU_API`,
  `KOHAKU_FLEET`, `ADMIN_TOKEN`).
- Open the live floor, run **Research brief**, then **Close epoch now**, then open the sealed epoch and
  press **Verify independently**.
- Keep a local `pnpm dev` ready as a fallback for flaky venue Wi-Fi. Set `KOHAKU_OFFLINE=1` to make
  the agents use their offline corpus and glossary.

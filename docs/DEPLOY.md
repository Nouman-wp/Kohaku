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

1. The backend must be reachable over HTTPS. Either run `serve.mjs` on a host with a public port
   (a VPS, Railway, Render, Fly; point a domain at port 8790), or open a Cloudflare quick tunnel from
   this machine:

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

## 4. Supabase mirror

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

## 5. Switching HSP to HashKey Merchant

When HashKey has onboarded the merchant (app key, app secret, merchant public key registered, test
USDC in the agents' wallets):

```ini
SETTLEMENT_TOKEN=0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6     # testnet USDC that HSP supports
HSP_MODE=merchant
HSP_BASE_URL=https://merchant-qa.hashkeymerchant.com
HSP_APP_KEY=<from HashKey>
HSP_APP_SECRET=<from HashKey>
```

Redeploy (the token is fixed per deployment), fund the agents' wallets with that USDC, set the
webhook URL in the HashKey Merchant console to `https://<site>/v1/hsp/webhook`, and restart. The
clearing service and the agents run the same code: orders go to HashKey, debtors pay through
HashKey's `pay-mandate`, and HashKey relays the transfers. The website shows "HashKey Merchant"
instead of "HSP local gateway".

## 6. Mainnet (chain 177)

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

## 7. Pre-flight before a demo

- `GET /v1/health`: chain healthy, clearer has gas, HSP healthy, fleet reachable.
- `node scripts/e2e.mjs` against the deployment (set `KOHAKU_ENV_FILE` or `KOHAKU_API`,
  `KOHAKU_FLEET`, `ADMIN_TOKEN`).
- Open the live floor, run **Research brief**, then **Close epoch now**, then open the sealed epoch and
  press **Verify independently**.
- Keep a local `pnpm dev` ready as a fallback for flaky venue Wi-Fi. Set `KOHAKU_OFFLINE=1` to make
  the agents use their offline corpus and glossary.

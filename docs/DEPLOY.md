# Deploying Kohaku to HashKey Chain

This is the runbook for taking Kohaku from `pnpm dev` on a laptop to HashKey Chain testnet and
mainnet with a public website. Every step uses scripts that are in the repository.

## 1. Keys

Create separate keys for each role (`cast wallet new` prints an address and a private key):

| Variable | Role | Needs |
|---|---|---|
| `DEPLOYER_PRIVATE_KEY` | deploys the contracts, becomes admin unless `OWNER_ADDRESS` is set | HSK for gas |
| `CLEARER_PRIVATE_KEY` | the clearing service: posts IOUs, finalises epochs, records HSP settlements, writes reputation, defaults and payouts | HSK for gas (it sends most transactions) |
| `FLEET_OPERATOR_KEY` | operator of the fleet agents: registers them, posts their collateral, signs their intents, funds guest sessions | HSK + stablecoin |
| `ROGUE_OPERATOR_KEY` | operator of Rogue (a second operator, so compliance views show two) | a little HSK + stablecoin |
| `FLEET_SEED` | 32 random bytes; each agent's key is `keccak(seed, slug)` | the agents' wallets need HSK for gas and stablecoin to pay their HSP settlements (the operator tops them up) |

Put `CLEARER_PRIVATE_KEY` in `.env` before deploying: the deploy script derives its address and
makes the contracts trust that key (or set `CLEARER_ADDRESS` explicitly).

## 2. Testnet (chain 133)

1. Fund the deployer, clearer and both operators from the faucet: <https://faucet.hsk.xyz/faucet>.
2. Settlement token: set `SETTLEMENT_TOKEN` to the stablecoin HSP's sandbox settles in (the
   Coordinator publishes it at `GET <coordinator>/chains`). If you leave it empty, a 6-decimal
   `MockUSDC` is deployed and the fleet mints from it. That is fine for testnet and is shown as a mock
   in the app.
3. Deploy and verify on Blockscout:

   ```bash
   pnpm deploy:testnet
   ```

   Addresses land in `contracts/deployments/133.json`; commit that file.
4. `.env` for the services:

   ```ini
   KOHAKU_CHAIN=hashkey-testnet
   CLEARER_PRIVATE_KEY=0x...
   PUBLIC_API_URL=https://api.your-domain        # where the clearing service is reachable
   PUBLIC_FLEET_URL=https://agents.your-domain   # agent cards are registered on chain under this URL
   CLEARING_URL=https://api.your-domain
   FLEET_SEED=0x...
   FLEET_OPERATOR_KEY=0x...
   ROGUE_OPERATOR_KEY=0x...
   ADMIN_TOKEN=<long random string>
   HSP_WEBHOOK_SECRET=<long random string>
   COLLATERAL_TARGET=3
   ORCHESTRATOR_COLLATERAL=10
   WALLET_TARGET=2
   GAS_TARGET=0.02
   MYMEMORY_EMAIL=you@example.com
   ```

5. Start the services: `pnpm clearing` and `pnpm fleet` (each in its own process, or under a
   process manager). The fleet registers its agents, deposits collateral and signs standing intents
   on first start. Re-running is safe: it only tops up what is missing.

## 3. Switching HSP to the hosted Coordinator

When the organisers share the sandbox details:

```ini
HSP_MODE=coordinator
HSP_COORDINATOR_URL=<COORDINATOR_URL>
HSP_API_KEY=<API_KEY>
HSP_CHAIN_NAME=hashkey-testnet
HSP_ADAPTER_ADDRESS=<adapter address from GET <COORDINATOR_URL>/chains>
HSP_SDK_PATH=/path/to/hsp/packages/sdk/dist/index.js
```

Restart both services. Debtor agents now pay with `HSPClient.pay`. The clearing service reads each
payment from the Coordinator, requires `SETTLED`, runs the official `HSPVerifier` against the
pinned adapter, and still checks the transfer on chain before recording it. The website shows
"HSP Coordinator" instead of "HSP local adapter".

## 4. Mainnet (chain 177)

Mainnet's base fee was 500 gwei when this was written, so:

- Deploying costs about **4.9 HSK**. The deploy script refuses to put a mock token on mainnet: set
  `SETTLEMENT_TOKEN=0x054ed45810DbBAb8B27668922D110669c9D88D0a` (USDC.e, 6 decimals).
- `pnpm deploy:mainnet` writes `contracts/deployments/177.json` and verifies on
  <https://hashkey.blockscout.com>.
- To run epochs on mainnet, keep traffic modest: longer epochs (`EPOCH_INTAKE_SECONDS=300`),
  `REPUTATION_EPOCH_STRIDE=10`, `FLEET_BACKGROUND=off`, and use the scenario runner for
  demonstrations. A busy epoch costs about 25k gas per IOU to verify on chain.

## 5. Website

The website is a static build:

```bash
VITE_KOHAKU_API=https://api.your-domain VITE_KOHAKU_FLEET=https://agents.your-domain pnpm --filter @kohaku/web build
```

Serve `apps/web/dist` from any static host. `vercel.json` and `public/_redirects` route every path to
`index.html` (it is a single-page app). The clearing service needs `CORS_ORIGIN` set to the
website's origin, or `*`.

## 6. Pre-flight before a demo

- `GET /v1/health`: chain healthy, clearer has gas, HSP healthy, fleet reachable.
- `pnpm e2e` against the deployment (set `KOHAKU_API`, `KOHAKU_FLEET`, `ADMIN_TOKEN`).
- Open the live floor, run **Research brief**, then **Close epoch now**, then open the sealed epoch and
  press **Verify independently**.
- Keep a local `pnpm dev` ready as a fallback for flaky venue Wi-Fi. Set `KOHAKU_OFFLINE=1` to make
  the agents use their offline corpus and glossary.

# Decisions

Every place where Kohaku departs from the project brief, or where a fact in the brief turned
out to be different, is listed here: what the brief asked for, what Kohaku does instead, and
why. Newest decisions are at the bottom of each section.

---

## HSP

### 1. HSP integration follows the HashKey Merchant API, as the HSP projects on GitHub do

- **Brief:** treat Kohaku as an HSP merchant; debtors pay HSP *orders* (`POST /api/v1/merchant/orders`,
  `POST /api/v1/payment/pay-mandate`), confirmed by an HMAC-signed webhook.
- **Found:** hashfans.io also describes a Coordinator model (`POST /payments`, an `@hsp/sdk`), but its
  SDK repository (`github.com/project-hsp/hsp`) is private and no project settles through it. The
  HSP integrations that do settle (for example `skymiss18/hashkeyhackthon` and
  `Contrarian3-Labs/OutcomeX`) all use the HashKey Merchant API at
  `https://merchant-qa.hashkeymerchant.com`: AP2 cart mandates signed with an ES256K merchant JWT,
  HMAC-SHA256 request signing, x402 v2 payment mandates carrying an EIP-3009
  `TransferWithAuthorization`, statuses `payment-required → payment-included → payment-successful`
  and webhooks signed `X-Signature: t=…,v1=…`. HashKey has since published its HSP docs
  (<https://hashkey-merchant.github.io>) and described Track 2 the same way: the paying agent builds
  a payment mandate from the payment conditions the receiving side sends, signs it with its wallet,
  and HSP's gateway verifies and executes the payment on chain. What the docs changed is in decision 29.
- **Kohaku:** follows that route. The clearing service is the merchant. Each net debt is one HSP order
  paying the exact amount to the clearing pool (`pay_to` = the clearing house). The debtor agent pays
  it the way HSP's checkout does, with no human and no gas: it checks the cart is exactly its debt,
  signs the EIP-3009 authorization and the AP2 payment mandate, adds the `user_authorization` JWT
  binding both mandates, and submits them to `pay-mandate`. HSP relays the transfer.
  An earlier version followed the Coordinator model; it was replaced by this one.

### 2. Two HSP modes, both labelled everywhere

- **Brief:** real HSP in the money path; never simulate HSP and present it as real.
- **Found:** HashKey Merchant credentials (`app_key`, `app_secret`, a registered merchant public key)
  come from HashKey onboarding, and HashKey's testnet USDC/USDT can only be minted by their owners.
- **Kohaku:**
  - `HSP_MODE=merchant`: orders, payments and webhooks go through HashKey Merchant. Set
    `HSP_BASE_URL`, `HSP_APP_KEY`, `HSP_APP_SECRET`, register the merchant public key printed by
    `node scripts/wallets.mjs <network> --show`, and settle in a token HashKey supports.
  - `HSP_MODE=local` (default until those are in hand): the clearing service also runs a gateway
    that serves the same HashKey Merchant endpoints (`/hsp/api/v1/…`), verifies the merchant JWT, the
    payment mandate, the user authorization and the EIP-3009 signature against the cart, relays the
    authorization on chain and sends signed webhooks. Transfers are real on-chain token transfers. It
    is labelled **"HSP local gateway"** in the API, the UI, the README and the logs, and never claims
    to be HashKey.
- **Why:** the clearing service and the agents run the same code against either, so switching to
  HashKey is configuration only, and HSP's evidence model is in the money path at all times.

### 3. Webhooks trigger checks; the status endpoint and the chain decide

- **Brief:** confirm settlement from HSP's signed webhook or by checking status; webhooks must be
  authenticated, fresh and processed exactly once.
- **Kohaku:** `POST /v1/hsp/webhook` verifies `X-Signature` (HMAC-SHA256 with the app secret over
  `${t}.${rawBody}`), rejects anything older than five minutes and records each event, a
  `(request_id, status)` pair, before acting, so replays are acknowledged and ignored. A webhook only
  triggers a check: the settlement is accepted after HSP's HMAC-authenticated status endpoint reports
  `payment-safe` (or `payment-finalized`) for this order, payee, token and amount **and** the chain
  shows the transfer. Open orders are also polled, so a payment is found even if the webhook and the
  debtor's report are both lost.

### 4. How a payment is bound to one epoch and one exact amount

- **Brief:** each HSP payment must bind to the epoch and to the debtor's exact net amount.
- **Kohaku:** the settlement order reference `keccak256("kohaku.settlement.v1", chainId,
  clearingHouse, epoch, agentId, amount)` is the **EIP-3009 nonce** of the payment, and the HSP order
  id is `KOHAKU-<chain>-<clearing house>-E<epoch>-A<agent>`. Kohaku accepts a payment only if its
  transaction moved exactly the debt from the debtor's registered wallet to the pool *and* emitted
  `AuthorizationUsed(debtor, orderRef)`. The token then refuses to pay the same debt twice, and the
  clearing house refuses to record a settlement unless the pool's unaccounted balance covers it, or
  to reuse an order id or a transaction hash. HSP carries amounts as decimal strings; Kohaku writes
  exact integer units (`0.0172` for 17 200 units), so sub-cent debts settle without rounding.

### 5. Creditor payouts go out on chain from the pool, not through HSP

- **Brief:** our choice, as long as every payout references the epoch and the inbound HSP receipts.
- **Kohaku:** `payout(epochId)` transfers each creditor's net position from the clearing house
  pool. HSP pays merchants; the pool is the merchant's `pay_to`, a contract that cannot sign
  authorizations. The sealed epoch receipt hashes together the IOU-set commitment, the positions,
  every recorded HSP settlement (with the hash of HSP's payment record) and every payout, so the
  money trail has no gaps.

---

## Netting and verification

### 6. The contract recomputes the netting from every signed IOU

- **Brief:** a commitment to the IOU set (a Merkle root or similar) with proofs per agent; the
  contract must reject an inconsistent result.
- **Kohaku:** stronger and simpler to explain. At epoch close the clearing service posts the whole
  IOU set in chunks. The clearing house recovers every buyer signature against the identity
  registry, accumulates each agent's credit and debit itself, and only finalises if the IOU-set
  commitment and positions commitment the service *claims* equal what the chain *computed*.
  The IOU-set commitment is a running hash of IOU digests in posting order, not a Merkle root.
- **Cost:** measured on anvil, about 25k gas per IOU in a busy epoch (2.7M gas for 110 IOUs in one
  chunk) and up to 63k per IOU in tiny epochs, where first-touch storage dominates. That is
  negligible on HashKey Chain testnet (1 gwei) and expensive on mainnet (base fee measured at
  500 gwei). See decision 19.

### 7. Double counting is prevented by ordering, not per-IOU storage

- **Kohaku:** within an epoch, IOUs must be posted in strictly increasing `(buyer, nonce)` order,
  and each buyer's nonces must keep increasing across epochs (`lastNonce[buyer]`). Together with
  the epoch being part of the signed struct, an IOU can be counted once, in one epoch, and never
  replayed. This costs one storage write per buyer instead of one per IOU.

### 8. Disputes still open at close are held out, then carried or released

- **Brief:** either roll the disputed IOU into the next epoch or hold it out until resolved;
  choose one and document it.
- **Kohaku:** held out. The IOU stays bound to its original epoch (its signature includes the
  epoch, so it cannot move). The clearing house records it as held out *before* that epoch's IOUs
  are posted. If the dispute is later rejected, the unchanged IOU is posted into a later epoch with
  `postCarried`, at most once. If it is upheld, `releaseHeldOut` drops it for good.

### 9. Undelivered jobs are voided at close

- **Not in the brief.** A job whose IOU was accepted but whose seller never delivered is voided
  when the epoch closes and the buyer's intent budget is restored. Agents never pay for work they
  did not receive.

### 10. Collateral exposure is counted gross

- **Brief:** unsettled obligations can never exceed available collateral.
- **Kohaku:** "obligations" means the buyer's gross IOUs in every epoch not yet finalised, not its
  net. That is conservative: even if every IOU owed *to* an agent were disputed away, its own debts
  are still covered. At finalisation only the net debit is locked, so headroom comes back.

### 11. Withdrawals are two-step with a delay

- **Brief:** collateral can be withdrawn only when not backing any open epoch or pending settlement.
- **Found:** an open epoch's obligations live off chain until the epoch closes, so the vault cannot
  see them directly.
- **Kohaku:** a withdrawal request immediately stops counting towards headroom (no new IOUs can
  rely on it) and can only execute after a delay longer than an epoch's lifetime. By then every
  IOU signed before the request has been netted, and its debt is locked. Locked collateral can never
  be withdrawn.

---

## Agents, intents, disputes, reputation

### 12. ERC-8004 registries are Kohaku's own deployments

- **Brief:** follow ERC-8004; deploy our own if there is no official deployment on HashKey Chain.
- **Kohaku:** identity (ERC-721 agents, `register`, `setAgentURI`, `getMetadata`/`setMetadata`,
  `Registered`/`URIUpdated`/`MetadataSet` events), reputation (`giveFeedback`, `revokeFeedback`,
  `readFeedback`, `getSummary`, `getClients`) and validation (`validationRequest`,
  `validationResponse`, `getValidationStatus`) follow the ERC-8004 interfaces. Departures: the
  operator sets the agent wallet (`setSigner`) without a consent signature from the new wallet; the
  reputation registry has an authorised `scorer` that writes Kohaku's per-epoch scores; the
  validation registry adds stablecoin staking and owner-triggered slashing.
- Agent cards are served twice, as an ERC-8004 registration file (what `tokenURI` points at) and
  as an A2A agent card with a Kohaku pricing extension.

### 13. Every purchase needs an intent, including agent-to-agent ones

- **Brief:** a human signs an intent that authorises a buyer agent.
- **Kohaku:** applied to every buyer. Fleet agents that buy from each other (Verifier buying
  searches, Scribe buying chart descriptions) run under standing intents signed by their operator,
  with service allowlists, per-job caps and a reputation floor. That is how "agents with a bad
  history lose business" works: Rogue drops under the orchestrator's 70.0 floor after one upheld
  dispute and stops being picked.

### 14. Validators are paid by the disputing buyer

- **Brief:** an upheld dispute pays the validator a fee.
- **Kohaku:** the buyer hires the validator like any other agent (service `verdict`, $0.01) and
  files the dispute naming that job, so validators earn on every ruling they make. An upheld
  dispute voids the seller's IOU, which recovers the money in dispute. Disputes can also be filed
  without a paid arbiter, in which case the highest-reputation validator is assigned. The brief's
  "frivolous disputes cost reputation" is implemented as written.

### 15. Reputation moves live, and is written on chain only when it changes

- Scores are recomputed the moment a dispute is decided or a debt settles, and buyers filter on
  that live score. At the end of each sealed epoch the same formula is written to the reputation
  registry, in strict epoch order, only for agents whose score changed.
  `REPUTATION_EPOCH_STRIDE` writes every N epochs instead (scores are cumulative, nothing is lost),
  which matters on mainnet.
- Lost and frivolous disputes fade with a 20-epoch half-life; defaults never do. Without decay a
  long-running deployment would exclude Rogue forever and the "agents with bad history lose
  business" story could only be told once. With it, Rogue earns its way back above the floor, gets
  picked, is caught again and drops again: a loop visitors can watch.

### 16. Real work engines and their fallbacks

- **Brief:** each agent does real, cheap, fast work.
- **Kohaku:** Scout searches the Wikipedia API; Polyglot translates with the MyMemory API; Scribe
  writes frequency-based extractive summaries; Lens describes chart data (least-squares trend,
  extremes, share); Verifier checks claims against sources it buys; Arbiter independently re-runs
  the check. For flaky venue networks there are labelled fallbacks: a small offline corpus for search
  (`source: "offline"`) and a glossary/transliteration engine for Hindi (`engine: "offline-glossary"`).

### 17. The default drill uses the orchestrator, not Rogue

- **Brief:** a debtor that goes offline defaults and is covered from collateral.
- **Kohaku:** Rogue only sells, so it is always a net creditor and cannot default. The "default
  drill" scenario takes the orchestrator offline for settlement instead; after the deadline anyone
  can call `declareDefault`, its collateral is seized and creditors are paid in full.

---

## Chain, deployment, stack

### 18. Corrected chain facts

- **Mainnet gas:** the brief says "around 0.001 gwei". Measured on 25 October 2026:
  `baseFeePerGas` is **500 gwei** on mainnet (chain 177) and 1 gwei on testnet (chain 133); block
  gas limit 30M on both; blocks every ~2 s.
- **Deploying the suite:** 10.9M gas with the test token (0.011 HSK on testnet), about 9.5M without
  it, so about **4.8 HSK** on mainnet at 500 gwei.
- **A busy epoch** (5 IOUs, one debtor, two creditors, two disputes) cost 1.2M gas on testnet:
  `postIous` 485k, `finalizeEpoch` 159k, `recordSettlement` 237k, `payout` 147k, validation
  requests ~200k each. A background-brief epoch (18-24 IOUs, two debtors, three creditors) costs
  1.66-1.89M gas: `postIous` 0.84-1.03M, `finalizeEpoch` 0.21M, `recordSettlement` 0.20-0.24M per
  debtor, `payout` 0.18-0.20M, plus ~78k per HSP transfer relayed. Reputation writes add 1.73M
  every `REPUTATION_EPOCH_STRIDE` epochs. That is about 0.002 HSK per busy epoch on testnet and
  about **1 HSK on mainnet** (idle epochs cost nothing).
- **Stablecoins (checked on chain):**
  - mainnet USDC.e `0x054ed45810DbBAb8B27668922D110669c9D88D0a`: "Bridged USDC", 6 decimals,
    Circle FiatToken proxy (implementation `0x82f6…22de`), EIP-712 version "2", supports EIP-3009
    in both the `bytes` and `v,r,s` forms. Total supply is small (~1,777 USDC.e on 25 October 2026).
  - mainnet USDT `0xf1b50ed67a9e2cc94ad3c477779e2d4cbfff9029`: "Tether USD", OptimismMintableERC20
    v1.3.0, **no EIP-3009**, so HSP cannot pull it with an authorization. Kohaku settles in USDC.e.
  - testnet USDC `0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6` (HSP's, "USD Coin" v2, EIP-3009) and
    testnet USDT `0x372325443233fEbaC1F6998aC750276468c83CC6` ("HP2 Tether USD"): minting is owner-only.
  - HashKey's token list (docs.hskchain.net, Token Contracts) and HSP's onboarding table agree:
    USDC (Bridged USDC) `0x054e…8D0a` settles by EIP-3009 and USDT `0xf1b5…9029` by Permit2.
  - Chainlink CCIP on HashKey Chain mainnet (chain selector `7613811247471741961`, router
    `0xf2Fd62c083F3BF324e99ce157D1a42d7EbA77f1d`) carries LINK, WHSK and OpenUSDT
    (`0x1217BfE6c773EEC6cc4A38b5Dc45B92292B6E189`, not the USDT HSP accepts), and no USDC. USDC for
    mainnet agents has to come over a bridge (it is "Bridged USDC"), not CCIP.
- **Explorers:** mainnet `hashkey.blockscout.com`. The documented testnet explorer
  `testnet-explorer.hsk.xyz` had no DNS record on 25 October 2026, so testnet contracts were deployed
  without source verification; `forge verify-contract` can be re-run when it is back.

### 19. Where the live system runs

- **Brief:** contracts on HashKey Chain mainnet; HSP on whichever network it supports, said plainly.
- **Kohaku:** testnet first. The suite is deployed on testnet (addresses in
  `contracts/deployments/133.json` and the README) with the fleet trading on it; mainnet uses the same
  scripts (`node scripts/deploy.mjs mainnet`) once the testnet run is signed off and the deployer is
  funded. On mainnet, epochs are longer (10 minutes) because every busy epoch costs real HSK.

### 20. Stack

- Vite + React single-page app instead of a server-rendered framework; every screen is live data
  over a WebSocket, so there is nothing to server-render.
- Node 22+ with the built-in `node:sqlite` for the clearing service's ledger, so there are no
  native modules to build.
- Foundry for contracts (unit, fuzz and invariant tests); viem everywhere in TypeScript.

### 21. Clearing fee

- The business model charges a small fee on net settled volume. This version charges **0%**: there
  is no fee logic in the contracts, so there is no rounding anywhere and no value is created or
  destroyed. All amounts are integer token units.

### 22. Brief material is kept out of the repository

- `ProjectGuide.md` and `DESIGN.md` were working inputs and stay local (`.gitignore`). This file
  quotes what each decision departs from, so it stands on its own.

### 23. Testnet settles in Kohaku Test USDC

- **Found:** HSP's testnet USDC and USDT can only be minted by their owners, and the testnet faucet
  gives HSK only, so a fleet of agents cannot be funded with them.
- **Kohaku:** on testnet the deploy script deploys Kohaku Test USDC (tUSDC): 6 decimals, an open
  faucet capped per call, and EIP-3009 with USDC's EIP-712 types and domain version, so HSP payments
  take exactly the path they take with real USDC. With HashKey-funded test USDC, set
  `SETTLEMENT_TOKEN=0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6` and redeploy. Mainnet refuses the
  test token.

### 24. Agents need no gas; signers manage their own nonces

- Agents sign IOUs, quotes, deliveries and HSP authorizations; HSP relays the payments, so only the
  validator (which stakes and answers on chain) and the operators hold gas.
- HashKey's public RPC is load-balanced: right after a transaction is mined, another node can still
  report the old nonce or the old state. Every signer uses viem's nonce manager, and a send that is
  rejected for a stale nonce, or that reverts within seconds of the same signer's previous write, is
  retried before giving up.

### 25. Quiet epochs stay open on public chains

- An epoch whose intake window ends without a single IOU stays open for another window instead of
  being finalised empty (`EPOCH_EXTEND_IDLE`, on by default except on a local chain). An idle clearing
  house spends no gas, and epoch numbers on chain still only ever advance by one.

### 26. Hosting: Vercel in front, the backend on a machine of our choosing

- **Asked:** deploy with Vercel.
- **Found:** the clearing service and the fleet are long-running processes with timers, a SQLite
  ledger and a WebSocket feed; Vercel runs static sites and short-lived functions.
- **Kohaku:** the website is a static build on Vercel (`node scripts/publish-web.mjs`), and Vercel
  proxies `/v1`, `/hsp`, `/agents`, `/guest(s)` and `/control` to the backend
  (`node scripts/serve.mjs <network>`, one edge port in front of both services). Every public URL,
  including the agent card URIs written on chain, is under the Vercel domain, so moving the backend
  never breaks them. Vercel does not proxy WebSockets, so the live feed connects to the backend
  directly. Services on the same machine reach each other locally instead of through the public URL.

### 27. Supabase mirrors the ledger; SQLite stays the engine

- **Asked:** keep the off-chain data about agents and users in a Supabase database.
- **Found:** the clearing service makes 130+ synchronous SQLite calls, and every epoch step runs
  inside SQLite transactions that the restart-and-resume logic depends on. Moving all of that to a
  remote Postgres a week before the deadline would rewrite the money path for no gain in safety.
- **Kohaku:** SQLite stays the engine. With `SUPABASE_URL` and `SUPABASE_SECRET_KEY` set, triggers
  queue every insert and update in a local outbox, inside the same transaction as the write, and the
  service upserts them to Supabase's REST API every few seconds (`services/clearing/src/mirror.ts`).
  Rows leave the outbox only once Supabase accepts them, so an outage only delays the copy.
  `scripts/db-restore.mjs` rebuilds a ledger from the mirror; a round trip of the testnet ledger
  came back identical, table for table. JSON stays the exact text the service wrote (cast with
  `::jsonb` to query it), because Postgres `jsonb` reorders keys and a restore must be exact. Row
  level security is on with no policies: only the server's secret key reads or writes. "Users" are
  the operator wallets, listed by the `operators` view.

### 28. The backend's home: a free VM

- **Found:** free container hosts sleep when idle or wipe their disk (Render, Koyeb), give too little
  (Railway's $1 a month) or no longer have a free tier (Fly.io). A clearing house with epoch timers,
  a WebSocket feed and a ledger on disk needs an always-on machine with a disk.
- **Kohaku:** Oracle Cloud's Always Free Arm VM (Google Cloud's e2-micro as the fallback), set up by
  `deploy/vm/setup.sh`: Node 24, Caddy for HTTPS, a `kohaku@<network>` systemd unit. Mainnet uses its
  own ports (8797/8798/8800) so both networks can share the machine.

### 29. HSP follows HashKey's published docs

- **Found:** HashKey published its HSP docs (<https://hashkey-merchant.github.io>, v2.3.0 of 16 October
  2026). They confirm the merchant route of decision 1 and differ from what the GitHub integrations
  showed in five places: the statuses (`payment-required → submitted → verified → processing →
  included → safe → finalized`, or `failed`; there is no `payment-successful`), the payment record's
  field names (`content_id`, `request_id`, `order_amount`, `to_pay_address`, `chain` as CAIP-2), one
  webhook per status with the same `request_id`, ids that can never be reused (`40001` for a cart
  mandate id, `10004` for a payment request id), and the hosts: QA
  `https://merchant-qa.hashkeymerchant.com` for testnet tokens, staging
  `https://merchant-stg.hashkeymerchant.com` and production `https://hsp.hashkey.com` for mainnet
  tokens. The docs cover the merchant endpoints only; the payer side (cart-mandate flow,
  `pay-mandate`, chain config) stays as HSP's checkout calls it.
- **Kohaku:**
  - A payment counts from `payment-safe`, which HSP describes as past reorg risk, plus Kohaku's own
    check of the transfer on chain. `payment-included` is still pending. Earlier gateways'
    `payment-successful` is still read as success.
  - HSP's record has to name this order, the pool as payee, the settlement token and the exact debt as
    `order_amount` before the chain is checked.
  - Webhook events are `(request_id, status)` pairs, so the safe and finalized calls are not dropped
    as replays of the included one.
  - A re-opened order gets fresh ids (`-R<attempt>` on both the cart mandate id and the payment request
    id). If HSP reports an id as taken, for example after a lost response, the next attempt is opened.
  - In merchant mode `HSP_BASE_URL` defaults to QA on testnet and production on mainnet. The service
    refuses to start with a host that serves the other network's tokens, or a settlement token HSP
    does not settle by EIP-3009.
  - The local gateway now answers in the same shapes: the same statuses (safe after three blocks on
    testnet, finalized when the chain's finalized head passes the block), records, webhook bodies,
    single-use ids and error codes.
- **Open with HashKey:** whether the merchant can advance the gas fee (`gas_fee_advanced`) so the payer
  pays exactly the order amount. Kohaku requires the exact debt to reach the pool, and a payment that
  carried fees would be refused.

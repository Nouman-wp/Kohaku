# Decisions

Every place where Kohaku departs from the project brief, or where a fact in the brief turned
out to be different, is listed here: what the brief asked for, what Kohaku does instead, and
why. Newest decisions are at the bottom of each section.

---

## HSP

### 1. HSP integration follows the official Coordinator model, not merchant orders

- **Brief:** treat Kohaku as an HSP merchant; debtors pay HSP *orders* (`POST /api/v1/merchant/orders`,
  `POST /api/v1/payment/pay-mandate`), confirmed by an HMAC-signed webhook.
- **Found:** those endpoints came from a previous hackathon's integration. The current official
  guide ("Building on HSP", linked from hashfans.io) describes a different, zero-custody model:
  the payer signs an EIP-712 **mandate**, the payer's own wallet broadcasts the ERC-20 transfer,
  an adapter observes it and signs a **receipt**, and a **verifier** ACCEPTs iff the mandate's
  required capabilities are satisfied. The Coordinator API is `POST /payments`,
  `POST /payments/:id/observe`, `GET /payments/:id`, `GET /chains`.
- **Kohaku:** follows the official model. Each net debtor is the HSP payer, the clearing pool is
  the payee (`to`), and the amount is the exact net debt. Nothing in Kohaku depends on the old
  merchant-order endpoints.

### 2. Two HSP modes, both labelled everywhere

- **Brief:** real HSP in the money path; never simulate HSP and present it as real.
- **Found:** the HSP SDK repository and the sandbox Coordinator credentials are handed out by the
  organisers during the event and were not public when this was built.
- **Kohaku:**
  - `HSP_MODE=coordinator`: debtor agents pay with the official SDK (`HSPClient.pay`), and the
    clearing service reads the payment back from the Coordinator, insists on `SETTLED`, re-runs
    the official `HSPVerifier` against the pinned adapter when the SDK is available, and checks the
    transfer on chain itself. Switch on by setting `HSP_COORDINATOR_URL`, `HSP_API_KEY`,
    `HSP_SDK_PATH` and `HSP_ADAPTER_ADDRESS`.
  - `HSP_MODE=local` (default until the sandbox details are in hand): Kohaku runs the same three
    moves itself with HSP's object shapes. Mandates are signed by the debtor agent, transfers
    are real on-chain ERC-20 transfers from the debtor's wallet, and a Kohaku adapter key signs
    the receipt, which a verifier checks. This mode is labelled **"HSP local adapter"** in the
    API, the UI, the README and the on-chain records. It never claims to be the hosted
    Coordinator.
- **Why:** it keeps HSP's evidence model in the money path at all times, and switching to the
  hosted Coordinator is a configuration change.

### 3. Webhooks are implemented, but polling is the primary signal

- **Brief:** confirm settlement from HSP's signed webhook or by checking status; webhooks must be
  authenticated, fresh and processed exactly once.
- **Found:** the published Coordinator API documents status polling (`observe` answers 202 while
  confirming), not webhooks.
- **Kohaku:** polls `GET /payments/:id` and retries with backoff. `POST /v1/hsp/webhook` is still
  implemented to the brief's spec (HMAC-SHA256 over `timestamp.body`, five-minute window, event
  ids recorded before anything acts on them). The local adapter sends real signed webhooks to it,
  so that path runs and is unit tested.

### 4. How a payment is bound to one epoch and one exact amount

- **Brief:** each HSP payment must bind to the epoch and to the debtor's exact net amount.
- **Found:** an HSP mandate has fixed fields (payer, to, token, amount, chainId, nonce, expiry,
  capabilities); there is no free-form reference.
- **Kohaku:** the settlement order reference is `keccak256("kohaku.settlement.v1", chainId,
  clearingHouse, epoch, agentId, amount)`, used as the mandate **nonce** (local mode). In both
  modes the clearing service also requires payer = the debtor's registered wallet, payee = the pool,
  amount = the exact debt, and an exact on-chain `Transfer`. The clearing house then refuses to
  record a settlement unless the pool's unaccounted balance covers it, and refuses to reuse a payment
  id or a transaction hash.

### 5. Creditor payouts go out on chain from the pool, not through HSP

- **Brief:** our choice, as long as every payout references the epoch and the inbound HSP receipts.
- **Kohaku:** `payout(epochId)` transfers each creditor's net position from the clearing house
  pool. HSP is wallet-settling (`Transfer.from` must equal the mandate signer) and the pool is a
  contract that cannot sign mandates. The sealed epoch receipt hashes together the IOU-set
  commitment, the positions, every recorded HSP settlement and every payout, so the money trail has
  no gaps.

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
- **Cost:** about 63k gas per IOU (measured on anvil: 1.0M gas for 16 IOUs, including first-touch
  storage). That is negligible on HashKey Chain testnet (1 gwei) and expensive on mainnet (base fee
  measured at 500 gwei). See decision 19.

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
  gas limit 30M on both.
- **Deploying the suite on mainnet:** about 9.7M gas without the mock token, about **4.9 HSK** at
  500 gwei.
- **Mainnet USDC.e** at `0x054ed45810DbBAb8B27668922D110669c9D88D0a` is confirmed: symbol
  `USDC.e`, name "Bridged USDC", 6 decimals.

### 19. Where the live system runs

- **Brief:** contracts on HashKey Chain mainnet; HSP on whichever network it supports, said plainly.
- **Kohaku:** the same verified contract suite deploys to mainnet (`pnpm deploy:mainnet`) and
  testnet (`pnpm deploy:testnet`). The always-on fleet is meant to run on **testnet**, next to the
  HSP sandbox, because posting every IOU on chain at 500 gwei costs about 0.03 HSK per IOU. The
  mainnet deployment carries real, lower-frequency epochs. The README states which network each
  link points at.

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

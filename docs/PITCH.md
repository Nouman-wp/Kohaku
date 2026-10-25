# Pitch: eight slides

Short outline for the Demo Day deck. Numbers in brackets come from the live deployment on the day:
read them from `/v1/stats` or the website's live floor just before presenting.

## 1. The problem

AI agents now pay each other per call: a search for $0.0004, a fact check for $0.002. An
orchestrator makes hundreds of these a minute. Settling each one on chain costs more than the work;
settling none means trusting strangers; and when a paid agent returns garbage, there is no refund
and no memory.

## 2. The insight: clearing houses

Banks solved this decades ago. Members record obligations all day, a clearing house nets them, and
only the differences move. Collateral and default funds keep everyone honest. Kohaku is that, scaled
down to seconds and run for software agents.

## 3. How Kohaku works

Join (ERC-8004 identity, A2A card, collateral) → trade (signed IOUs inside an AP2 intent) →
challenge (disputes, staked validator) → net (the contract recomputes every position) → settle
(debtors pay through HSP) → remember (reputation on chain, sealed receipt).

## 4. Live numbers

[IOUs cleared] → [settlement transfers], [percent of payments avoided]. [Value settled through HSP]
across [HSP payments]. A busy epoch netted 180 IOUs into 6 transfers (97% fewer). Show one
settlement walked back to a single $0.0004 job, every signature re-verified in the browser.

## 5. HSP, AP2 and ERC-8004, on purpose

- **HSP** is in the money path every epoch: each net debtor signs a mandate and pays from its own
  wallet, and nothing is marked settled without a verified receipt and an exact on-chain transfer.
- **AP2** intent mandates bound every purchase: budget, deadline, per-job cap, reputation floor.
  Off-policy spending is refused in public.
- **ERC-8004** identity, reputation and validation registries hold every agent, score and verdict.
- The clearing pool behaves like HSP's Master Account: pooled funds, distributed by rule.

## 6. Business model

A small fee on **net** settled volume, never gross, so agents always save versus paying per call.
HSP gets settlement volume it would never otherwise see. Compliance teams get one auditable
settlement per epoch instead of thousands of dust transfers.

## 7. Roadmap

More stablecoins · cross-chain collateral · credit lines underwritten by receipt history · appeals
and validator panels · a public agent marketplace · the HSP Coordinator by default.

## 8. Team

[Name], final-year B.Tech CSE (AI and ML). Built during the HashKey Chain Horizon Hackathon,
Mumbai 2026. Repository: github.com/Nouman-wp/Kohaku.

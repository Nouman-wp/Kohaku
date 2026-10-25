import type { HeadlineStats } from "@kohaku/core";
import type { Db } from "./db.ts";
import type { Chain } from "./chain.ts";
import type { HspPort } from "./hsp/port.ts";
import type { EpochEngine } from "./epochs.ts";
import type { Registry } from "./registry.ts";

/** Headline numbers. Only sealed (fully settled) epochs count towards cleared totals. */
export function headlineStats(db: Db, chain: Chain, hsp: HspPort, epochs: EpochEngine, registry: Registry, hspHealthy: boolean): HeadlineStats {
  const sealed = db.get<{ n: number; ious: number | null; gross: number | null; net: number | null; debtors: number | null; creditors: number | null }>(
    "SELECT COUNT(*) AS n, SUM(iou_count) AS ious, SUM(gross) AS gross, SUM(net) AS net, SUM(debtors) AS debtors, SUM(creditors) AS creditors FROM epochs WHERE phase = 'sealed'",
  )!;
  const hspPaid = db.get<{ n: number; v: number | null }>("SELECT COUNT(*) AS n, SUM(amount) AS v FROM settlements WHERE status = 'recorded'")!;
  const jobs = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE status = 'settled'")!;
  const ious = sealed.ious ?? 0;
  const transfers = (sealed.debtors ?? 0) + (sealed.creditors ?? 0);
  const avoided = Math.max(0, ious - transfers);
  const cur = epochs.current();
  const info = hsp.info();
  return {
    agents: registry.list().filter((a) => a.status !== "retired").length,
    jobsCleared: jobs.n,
    iousCleared: ious,
    epochsSealed: sealed.n,
    grossVolume: String(sealed.gross ?? 0),
    netVolume: String(sealed.net ?? 0),
    valueSettledViaHsp: String(hspPaid.v ?? 0),
    hspPayments: hspPaid.n,
    transfersAvoided: avoided,
    transferReduction: ious === 0 ? 0 : avoided / ious,
    currentEpoch: cur.id,
    epochPhase: "intake",
    phaseEndsAt: cur.intake_ends_at,
    chain: { key: chain.key, id: chain.viemChain.id, name: chain.viemChain.name, explorer: chain.explorer },
    hsp: { mode: info.mode, gatewayUrl: info.gatewayUrl, healthy: hspHealthy, note: info.note },
    deployment: {
      token: chain.d.token,
      identityRegistry: chain.d.identityRegistry,
      reputationRegistry: chain.d.reputationRegistry,
      validationRegistry: chain.d.validationRegistry,
      collateralVault: chain.d.collateralVault,
      clearingHouse: chain.d.clearingHouse,
      mockToken: String(chain.d.mockToken),
    },
  };
}

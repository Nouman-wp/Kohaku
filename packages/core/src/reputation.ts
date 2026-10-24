/**
 * Kohaku reputation, version 1. Public, deterministic, computed from objective facts only.
 *
 *   quality      q = (completed + 2) / (completed + 2 + 6 * disputesLost)
 *   reliability  r = (settledOnTime + 1) / (settledOnTime + 1 + 3 * defaults)
 *   conduct      c = 1 - min(0.5, 0.1 * frivolousDisputes)
 *   experience   e = min(1, log10(1 + completed) / 3)
 *
 *   score = round(1000 * (0.55 q + 0.25 r + 0.10 c + 0.10 e))      in [0, 1000]
 *
 * "completed" counts delivered jobs as a seller plus verdicts given as a validator.
 * "disputesLost" counts upheld disputes against the agent's work plus a validator's
 * overturned verdicts. Each lost dispute weighs six good jobs, so one bad fact check
 * drops a young seller below the common 700 threshold, while a long track record absorbs
 * an occasional loss. Volume is reported but deliberately not scored: buying your way up
 * would be too easy.
 */
export const REPUTATION_VERSION = 1;

export interface ReputationInputs {
  completed: number;
  disputesLost: number;
  disputesWon: number;
  frivolousDisputes: number;
  settledOnTime: number;
  defaults: number;
  volume: bigint;
}

export interface ReputationBreakdown {
  quality: number;
  reliability: number;
  conduct: number;
  experience: number;
  score: number;
}

export const WEIGHTS = { quality: 0.55, reliability: 0.25, conduct: 0.1, experience: 0.1 } as const;

export function emptyInputs(): ReputationInputs {
  return { completed: 0, disputesLost: 0, disputesWon: 0, frivolousDisputes: 0, settledOnTime: 0, defaults: 0, volume: 0n };
}

export function scoreReputation(i: ReputationInputs): ReputationBreakdown {
  const quality = (i.completed + 2) / (i.completed + 2 + 6 * i.disputesLost);
  const reliability = (i.settledOnTime + 1) / (i.settledOnTime + 1 + 3 * i.defaults);
  const conduct = 1 - Math.min(0.5, 0.1 * i.frivolousDisputes);
  const experience = Math.min(1, Math.log10(1 + i.completed) / 3);
  const raw =
    WEIGHTS.quality * quality +
    WEIGHTS.reliability * reliability +
    WEIGHTS.conduct * conduct +
    WEIGHTS.experience * experience;
  const score = Math.max(0, Math.min(1000, Math.round(1000 * raw)));
  return { quality, reliability, conduct, experience, score };
}

/** Human-readable score, e.g. 87.4 */
export function formatScore(score: number): string {
  return (score / 10).toFixed(1);
}

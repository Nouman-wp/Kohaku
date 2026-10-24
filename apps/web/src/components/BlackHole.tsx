import { useEffect, useMemo, useState } from "react";
import type { AgentSummary } from "@kohaku/core";
import { usd, score } from "../lib/format.ts";

const ANGLES = [180, 225, 270, 315, 0, 45, 90, 135];

function dotPos(deg: number) {
  const r = (deg * Math.PI) / 180;
  return { left: `${50 + 50 * Math.cos(r)}%`, top: `${50 + 50 * Math.sin(r)}%` };
}

/**
 * The hero's black hole: a slowly turning violet accretion swirl around a dark core with a
 * faint amber heart, three orbit rings carrying agent "planets", and a twinkling star belt.
 * The inner ring's top dots carry live agent cards.
 */
export function BlackHole({ agents = [], rings = true }: { agents?: AgentSummary[]; rings?: boolean }) {
  const stars = useMemo(
    () =>
      Array.from({ length: 110 }, (_, i) => {
        const a = (i * 137.5 * Math.PI) / 180;
        const rr = 160 + ((i * 53) % 190);
        return {
          left: 350 + rr * Math.cos(a),
          top: 350 + rr * Math.sin(a),
          d: 3 + ((i * 7) % 5),
          delay: (i % 13) * 0.4,
          o: i % 3 === 0 ? 0.5 : 1,
        };
      }),
    [],
  );
  const featured = useMemo(() => {
    const pick = (slug: string) => agents.find((a) => a.slug === slug);
    return [pick("scout"), pick("verifier"), pick("polyglot")].filter(Boolean) as AgentSummary[];
  }, [agents]);
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setShown((s) => (s + 1) % 3), 3200);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="black-hole" aria-hidden>
      <div className="bh-swirl" />
      <div className="bh-swirl-2" />
      <div className="bh-core" />
      <div className="bh-amber" />
      <div className="bh-stars">
        {stars.map((s, i) => (
          <i key={i} style={{ left: s.left, top: s.top, opacity: s.o, ["--d" as string]: `${s.d}s`, ["--delay" as string]: `${s.delay}s` }} />
        ))}
      </div>
      {rings && (
        <div className="bh-circles">
          {[0, 1, 2].map((ring) => (
            <div key={ring}>
              <div className="bh-circle">
                {ANGLES.map((deg, i) => {
                  const tipIndex = ring === 2 ? [225, 270, 315].indexOf(deg) : -1;
                  const agent = tipIndex >= 0 ? featured[tipIndex] : undefined;
                  return (
                    <div key={i} className={`bh-dot ${agent ? "has-tip" : ""}`} style={dotPos(deg)}>
                      {agent && (
                        <div className={`bh-tip ${shown === tipIndex ? "show" : ""}`}>
                          <div className="bh-tip-title">{agent.name}</div>
                          {agent.services.slice(0, 1).map((s) => (
                            <div key={s.id} className="bh-tip-item">
                              {s.name} <b>{usd(s.price, 4)}</b> / {s.unit}
                            </div>
                          ))}
                          <div className="bh-tip-item">
                            Reputation <b>{score(agent.reputation)}</b>
                          </div>
                          <div className="bh-tip-item">
                            {agent.jobsSold} jobs sold, {agent.jobsBought} bought
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

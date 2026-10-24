import { useMemo } from "react";
import type { LiveState } from "../lib/api.ts";
import { agentName } from "../lib/api.ts";
import { clock, signedUsd, usd, ago } from "../lib/format.ts";
import { AgentGem, useNow } from "./ui.tsx";
import { IconSearch } from "./icons.tsx";

/** A miniature, live Kohaku app window: the landing page's "product screenshot". */
export function MiniApp({ live }: { live: LiveState }) {
  const now = useNow(500);
  const cur = live.stats?.currentEpoch ?? null;
  const epoch = cur ? live.epochs.get(cur) : undefined;
  const remaining = epoch ? epoch.intakeEndsAt - now : 0;

  const groups = useMemo(() => {
    const recent = live.ious.slice(0, 18);
    const order: string[] = [];
    const by = new Map<string, typeof recent>();
    for (const r of recent) {
      if (!by.has(r.iou.buyer)) {
        by.set(r.iou.buyer, []);
        order.push(r.iou.buyer);
      }
      const list = by.get(r.iou.buyer)!;
      if (list.length < 4) list.push(r);
    }
    return order.slice(0, 4).map((b) => ({ buyer: b, items: by.get(b)! }));
  }, [live.ious]);

  const lastNetted = useMemo(() => {
    const ids = [...live.netted.keys()].sort((a, b) => b - a);
    const id = ids[0];
    return id ? { id, positions: [...(live.netted.get(id) ?? [])].sort((a, b) => Math.abs(Number(b.net)) - Math.abs(Number(a.net))).slice(0, 3) } : null;
  }, [live.netted]);

  const settlements = useMemo(
    () => [...live.settlements.values()].filter((s) => s.status === "recorded").sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3),
    [live.settlements],
  );

  const epochs = useMemo(() => {
    const top = cur ?? 1;
    return Array.from({ length: 21 }, (_, i) => top - 20 + i).filter((n) => n > 0);
  }, [cur]);

  return (
    <div className="mini">
      <aside className="mini-side">
        <div className="mini-search">
          <IconSearch size={16} /> Search agents… <kbd>⌘K</kbd>
        </div>
        <div className="mini-nav">
          <div className="on">◆ Live floor</div>
          <div>▤ Epochs</div>
          <div>◎ Agents</div>
          <div>⚖ Disputes</div>
        </div>
        <div className="mini-label">Pinned</div>
        <div className="mini-pin">Current epoch</div>
        <div className="mini-pin">HSP receipts</div>
        <div className="mini-pin">Rogue's disputes</div>
        <div className="mini-pin">Verify an epoch</div>
        <div className="mini-user">
          <AgentGem id={1} size={26} /> Operator console
        </div>
      </aside>
      <div className="mini-main">
        <div className="mini-day">{cur ? `Epoch ${cur} · ${epoch?.phase ?? "intake"}` : "Connecting to the clearing floor…"}</div>
        <ul className="mini-feed">
          {groups.length === 0 && (
            <>
              <li>Agents sign an IOU for every paid job.</li>
              <li className="child">Kohaku nets every IOU when the epoch closes.</li>
              <li className="child">Net debtors settle through HSP. Creditors are paid from the pool.</li>
              <li>Waiting for the first jobs of this epoch.</li>
            </>
          )}
          {groups.map((g) => (
            <GroupRows key={g.buyer} live={live} buyer={g.buyer} items={g.items} />
          ))}
        </ul>
      </div>
      <aside className="mini-right">
        <h4>Epoch clock</h4>
        <div className="mini-clock">{epoch ? clock(remaining) : "--:--"}</div>
        <div className="mini-grid">
          {epochs.map((n) => {
            const e = live.epochs.get(n);
            return (
              <span key={n} className={n === cur ? "now" : e?.phase === "sealed" ? "sealed" : ""}>
                {n}
              </span>
            );
          })}
        </div>
        <div className="mini-sub">{lastNetted ? `Net positions · epoch ${lastNetted.id}` : "Net positions"}</div>
        {lastNetted?.positions.map((p) => (
          <div key={p.agentId} className="mini-row">
            <span>{agentName(live.agents, p.agentId)}</span>
            <span>{signedUsd(p.net)}</span>
          </div>
        ))}
        <div className="mini-sub">HSP settlements</div>
        {settlements.map((s) => (
          <div key={s.id} className="mini-row">
            <span>{agentName(live.agents, s.agentId)}</span>
            <span>
              {usd(s.amount, 4)} · {ago(s.updatedAt)}
            </span>
          </div>
        ))}
        {settlements.length === 0 && <div className="mini-row"><span>Next epoch close</span><span>pending</span></div>}
      </aside>
    </div>
  );
}

function GroupRows({ live, buyer, items }: { live: LiveState; buyer: string; items: LiveState["ious"] }) {
  return (
    <>
      <li>
        <span className="lk">{agentName(live.agents, buyer)}</span> is hiring
      </li>
      {items.map((r) => (
        <li key={r.iou.digest} className="child">
          <span className="lk">{agentName(live.agents, r.iou.seller)}</span> for {r.job.service} <span className="amt">· {usd(r.iou.amount, 4)} IOU</span>
        </li>
      ))}
    </>
  );
}

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Sparkle, IconExternal } from "./icons.tsx";
import { short } from "../lib/format.ts";

export function Btn(props: {
  to?: string;
  href?: string;
  onClick?: () => void;
  variant?: "primary" | "secondary";
  size?: "sm" | "md" | "lg";
  children: ReactNode;
  disabled?: boolean;
  type?: "button" | "submit";
  className?: string;
}) {
  const cls = `button button-${props.variant ?? "primary"}${props.size && props.size !== "md" ? ` button-${props.size}` : ""} ${props.className ?? ""}`;
  const inner = (
    <>
      <span className="button-border" />
      {props.children}
    </>
  );
  if (props.to) return <Link to={props.to} className={cls}>{inner}</Link>;
  if (props.href)
    return (
      <a href={props.href} className={cls} target={props.href.startsWith("http") ? "_blank" : undefined} rel="noreferrer">
        {inner}
      </a>
    );
  return (
    <button type={props.type ?? "button"} className={cls} onClick={props.onClick} disabled={props.disabled}>
      {inner}
    </button>
  );
}

export function Badge({ children, icon = true }: { children: ReactNode; icon?: boolean }) {
  return (
    <div className="badge">
      {icon && <Sparkle />}
      <span className="badge-text">{children}</span>
    </div>
  );
}

/** Section title with Reflect's per-line vertical gradient. */
export function Title({ lines, level = 2, className = "" }: { lines: ReactNode[]; level?: 1 | 2 | 3 | 5; className?: string }) {
  const Tag = (level === 1 ? "h1" : level === 2 ? "h2" : level === 3 ? "h3" : "h5") as "h1";
  return (
    <Tag className={`title title-h${level} ${className}`}>
      {lines.map((l, i) => (
        <span key={i}>{l}</span>
      ))}
    </Tag>
  );
}

/** Deterministic pseudo-random star field rendered as box-shadows (one element per layer). */
export function RisingStars({ seed = 1, count = 120, width = 2000, height = 2000 }: { seed?: number; count?: number; width?: number; height?: number }) {
  const layers = useMemo(() => {
    let s = seed * 9301 + 49297;
    const r = () => {
      s = (s * 9301 + 49297) % 233280;
      return s / 233280;
    };
    return [100, 150, 200].map((duration, li) => {
      const shadows: string[] = [];
      const n = Math.round(count / (li + 1));
      for (let i = 0; i < n; i++) {
        const x = Math.round(r() * width);
        const y = Math.round(r() * height * 3);
        const a = (0.35 + r() * 0.65).toFixed(2);
        shadows.push(`${x}px ${y}px rgba(255,255,255,${a})`);
      }
      return { duration, shadows: shadows.join(","), size: li === 0 ? 1 : li === 1 ? 1.5 : 2 };
    });
  }, [seed, count, width, height]);
  return (
    <div className="rising-stars">
      {layers.map((l, i) => (
        <div key={i} style={{ width: l.size, height: l.size, boxShadow: l.shadows, animationDuration: `${l.duration}s` }} />
      ))}
    </div>
  );
}

/** Small gem avatar, hue derived from the agent id. */
export function AgentGem({ id, size = 28, name }: { id: string | number; size?: number; name?: string }) {
  const hue = useMemo(() => {
    const n = Number(id) || 0;
    const hues = [262, 205, 290, 320, 230, 180, 250, 20, 160, 300];
    return hues[n % hues.length]!;
  }, [id]);
  const gid = `g${id}-${size}`;
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-label={name} role="img">
      <defs>
        <radialGradient id={gid} cx="45%" cy="30%" r="80%">
          <stop offset="0" stopColor={`hsl(${hue} 70% 62%)`} />
          <stop offset="0.55" stopColor={`hsl(${hue} 60% 28%)`} />
          <stop offset="1" stopColor={`hsl(${hue} 70% 10%)`} />
        </radialGradient>
      </defs>
      <path d="M16 1.5 29 8.75v14.5L16 30.5 3 23.25V8.75z" fill={`url(#${gid})`} stroke={`hsl(${hue} 90% 82% / .7)`} strokeWidth="1.2" />
      <path d="M16 9.5 22 13v6l-6 3.5-6-3.5v-6z" fill="none" stroke="rgba(255,255,255,.28)" strokeWidth="1" />
      <circle cx="16" cy="16" r="2.4" fill={id && Number(id) === 8 ? "#ff9f6e" : "#ffe3b0"} />
    </svg>
  );
}

export function HashLink({ hash, href, n = 6 }: { hash: string | null | undefined; href?: string | null; n?: number }) {
  if (!hash) return <span className="muted">—</span>;
  const text = <span className="mono">{short(hash, n)}</span>;
  return href ? (
    <a className="hash-link" href={href} target="_blank" rel="noreferrer" title={hash}>
      {text}
      <IconExternal />
    </a>
  ) : (
    <span className="hash" title={hash} onClick={() => void navigator.clipboard?.writeText(hash)}>
      {text}
    </span>
  );
}

export function useNow(intervalMs = 250): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function Panel({ children, className = "", title, actions }: { children: ReactNode; className?: string; title?: ReactNode; actions?: ReactNode }) {
  return (
    <section className={`panel ${className}`}>
      {(title || actions) && (
        <header className="panel-head">
          <div className="panel-title">{title}</div>
          {actions && <div className="panel-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, hint, accent }: { label: string; value: ReactNode; hint?: ReactNode; accent?: boolean }) {
  return (
    <div className={`stat ${accent ? "stat-accent" : ""}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

export function Pill({ tone = "default", children }: { tone?: "default" | "accent" | "warn" | "muted" | "good"; children: ReactNode }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

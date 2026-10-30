import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { IconExternal, IconCopy, IconCheck } from "./icons.tsx";
import { short } from "../lib/format.ts";

export function Btn(props: {
  to?: string;
  href?: string;
  onClick?: () => void;
  variant?: "accent" | "primary" | "secondary";
  size?: "sm" | "md" | "lg";
  children: ReactNode;
  disabled?: boolean;
  type?: "button" | "submit";
  className?: string;
}) {
  const cls = `button button-${props.variant ?? "primary"}${props.size && props.size !== "md" ? ` button-${props.size}` : ""} ${props.className ?? ""}`;
  if (props.to)
    return (
      <Link to={props.to} className={cls}>
        {props.children}
      </Link>
    );
  if (props.href)
    return (
      <a href={props.href} className={cls} target={props.href.startsWith("http") ? "_blank" : undefined} rel="noreferrer">
        {props.children}
      </a>
    );
  return (
    <button type={props.type ?? "button"} className={cls} onClick={props.onClick} disabled={props.disabled}>
      {props.children}
    </button>
  );
}

/**
 * An agent's mark: the Kohaku hexagon with a glyph of its own inside, so agents stay
 * tellable apart in a graph or a list without a rainbow of hues.
 */
const GLYPHS = [
  <circle key="0" cx="16" cy="16" r="4.2" />,
  <path key="1" d="M16 10.5 21.5 16 16 21.5 10.5 16z" />,
  <path key="2" d="M16 10.8 21.6 20.4H10.4z" />,
  <rect key="3" x="11.8" y="11.8" width="8.4" height="8.4" rx="1" />,
  <path key="4" d="M14.5 10.5h3v4h4v3h-4v4h-3v-4h-4v-3h4z" />,
  <circle key="5" cx="16" cy="16" r="4.4" fill="none" strokeWidth="2.4" />,
  <path key="6" d="M10.4 11.6h11.2L16 21.2z" />,
  <path key="7" d="M16 10.4 20.8 13.2v5.6L16 21.6 11.2 18.8v-5.6z" />,
  <g key="8">
    <circle cx="12.6" cy="16" r="2.6" />
    <circle cx="19.4" cy="16" r="2.6" />
  </g>,
  <rect key="9" x="10.5" y="14.2" width="11" height="3.6" rx="1.2" />,
];

export function AgentGem({ id, size = 28, name }: { id: string | number; size?: number; name?: string }) {
  const glyph = useMemo(() => GLYPHS[(Number(id) || 0) % GLYPHS.length], [id]);
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" role={name ? "img" : undefined} aria-label={name} aria-hidden={name ? undefined : true} className="agent-gem">
      <path d="M16 1.8 28.6 9v14L16 30.2 3.4 23V9z" fill="#141414" stroke="#3a3a38" strokeWidth="1.2" strokeLinejoin="round" />
      <g fill="#ececea" stroke="#ececea" strokeWidth="0">
        {glyph}
      </g>
    </svg>
  );
}

/** A hash: a link to the explorer when there is one, otherwise a button that copies it. */
export function HashLink({ hash, href, n = 6 }: { hash: string | null | undefined; href?: string | null; n?: number }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(t);
  }, [copied]);
  if (!hash) return <span className="muted">—</span>;
  const text = (
    <span className="mono" translate="no">
      {short(hash, n)}
    </span>
  );
  return href ? (
    <a className="hash-link" href={href} target="_blank" rel="noreferrer" title={hash}>
      {text}
      <IconExternal aria-hidden />
    </a>
  ) : (
    <button
      type="button"
      className="hash"
      title={hash}
      aria-label={copied ? "Copied" : `Copy ${hash}`}
      onClick={() => {
        void navigator.clipboard?.writeText(hash).then(() => setCopied(true));
      }}
    >
      {text}
      {copied ? <IconCheck size={12} aria-hidden /> : <IconCopy size={12} aria-hidden />}
    </button>
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
          {title ? <h2 className="panel-title">{title}</h2> : <span />}
          {actions && <div className="panel-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

/** Peer figures share one card, split by quiet dividers. */
export function Stats({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`stats ${className}`}>{children}</div>;
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

/** Page heading for app screens: crumbs, a title, one sentence, and the page's actions. */
export function PageHead({ crumbs, title, meta, sub, actions }: { crumbs?: ReactNode; title: ReactNode; meta?: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <>
      {crumbs && (
        <nav className="crumbs" aria-label="Breadcrumb">
          {crumbs}
        </nav>
      )}
      <div className="page-head">
        <div className="page-head-text">
          <h1 className="page-title">{title}</h1>
          {meta && <div className="page-meta">{meta}</div>}
          {sub && <p className="page-sub">{sub}</p>}
        </div>
        {actions && <div className="control-bar page-actions">{actions}</div>}
      </div>
    </>
  );
}

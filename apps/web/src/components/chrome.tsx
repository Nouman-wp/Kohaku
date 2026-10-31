import { useEffect, useState } from "react";
import { Link, NavLink, useLocation } from "react-router";
import { Btn } from "./ui.tsx";
import { IconGithub } from "./icons.tsx";
import { useLive } from "../lib/api.ts";

export const REPO = "https://github.com/Nouman-wp/Kohaku";

const NAV = [
  { to: "/floor", label: "Live floor" },
  { to: "/epochs", label: "Epochs" },
  { to: "/agents", label: "Agents" },
  { to: "/disputes", label: "Disputes" },
  { to: "/verify", label: "Verify" },
  { to: "/developers", label: "Developers" },
];

const MOBILE = [...NAV, { to: "/console", label: "Operator console" }, { to: "/intents/new", label: "Sign an intent" }, { to: "/status", label: "System status" }];

function Wordmark() {
  return (
    <Link to="/" className="wordmark" aria-label="Kohaku, home">
      <img src="/logo.svg" alt="" width={28} height={28} />
      <span>Kohaku</span>
      <span className="wordmark-kanji" aria-hidden>
        琥珀
      </span>
    </Link>
  );
}

export function Header() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const { pathname } = useLocation();
  const live = useLive();

  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <header className={`header ${scrolled ? "scrolled" : ""} ${open ? "open" : ""}`}>
      <a href="#content" className="skip-link">
        Skip to content
      </a>
      <div className="wrap header-bar">
        <Wordmark />
        <nav aria-label="Main">
          <ul className="header-nav">
            {NAV.map((n) => (
              <li key={n.to}>
                <NavLink to={n.to} className={({ isActive }) => `header-nav-link ${isActive ? "active" : ""}`}>
                  {n.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="header-actions">
          <span className="header-status" aria-live="polite">
            <span className={`live-dot ${live.connected ? "" : "off"}`} aria-hidden />
            {live.connected ? (live.stats ? `Epoch ${live.stats.currentEpoch} live` : "Live") : "Reconnecting…"}
          </span>
          <Btn to="/console" variant="secondary" size="sm" className="header-console">
            Console
          </Btn>
          <Btn to="/floor" variant="accent" size="sm">
            Open the floor
          </Btn>
          <button className="header-toggle" aria-label={open ? "Close menu" : "Open menu"} aria-expanded={open} aria-controls="mobile-menu" onClick={() => setOpen((o) => !o)}>
            <div>
              <span />
              <span />
              <span />
            </div>
          </button>
        </div>
      </div>
      <div id="mobile-menu" className={`header-mobile ${open ? "open" : ""}`}>
        <nav className="wrap" aria-label="Main, mobile">
          {MOBILE.map((n) => (
            <NavLink key={n.to} to={n.to} className={({ isActive }) => (isActive ? "active" : "")}>
              {n.label}
            </NavLink>
          ))}
        </nav>
      </div>
    </header>
  );
}

export function Footer() {
  const explorer = useLive().stats?.chain.explorer ?? "https://hashkey.blockscout.com";
  return (
    <footer className="footer">
      <div className="wrap">
        <div className="footer-top">
          <div className="footer-brand">
            <Wordmark />
            <p>The clearing house for the agent economy. Agent-to-agent IOUs, netted every epoch on HashKey Chain and settled through HSP.</p>
            <Btn href={REPO} variant="secondary" size="sm">
              <IconGithub size={16} aria-hidden /> Source on GitHub
            </Btn>
          </div>
          <div className="footer-nav">
            <div>
              <h2>Product</h2>
              <Link to="/floor">Live floor</Link>
              <Link to="/epochs">Epochs</Link>
              <Link to="/agents">Agents</Link>
              <Link to="/disputes">Disputes</Link>
            </div>
            <div>
              <h2>Operators</h2>
              <Link to="/console">Console</Link>
              <Link to="/intents/new">Sign an intent</Link>
              <Link to="/verify">Verify an epoch</Link>
              <Link to="/status">System status</Link>
            </div>
            <div>
              <h2>Developers</h2>
              <Link to="/developers">Quickstart</Link>
              <Link to="/developers#mcp">MCP server</Link>
              <Link to="/developers#contracts">Contracts</Link>
              <a href={`${REPO}/blob/main/DECISIONS.md`} target="_blank" rel="noreferrer">
                Decisions
              </a>
            </div>
          </div>
        </div>
        <div className="footer-mark" aria-hidden>
          <span>Kohaku</span>
          <span>琥珀</span>
        </div>
        <div className="footer-bottom">
          <span>Built for the HashKey Chain Horizon Hackathon, Mumbai 2026. MIT licensed.</span>
          <nav aria-label="External">
            <a href={REPO} target="_blank" rel="noreferrer">
              GitHub
            </a>
            <a href={explorer} target="_blank" rel="noreferrer">
              HashKey Chain explorer
            </a>
          </nav>
        </div>
      </div>
    </footer>
  );
}

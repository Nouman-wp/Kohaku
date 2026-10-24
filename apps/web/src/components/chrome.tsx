import { useState } from "react";
import { Link, NavLink } from "react-router";
import { Badge, Btn } from "./ui.tsx";
import { IconGithub } from "./icons.tsx";

export const REPO = "https://github.com/Nouman-wp/Kohaku";

const NAV = [
  { to: "/floor", label: "Live floor" },
  { to: "/epochs", label: "Epochs" },
  { to: "/agents", label: "Agents" },
  { to: "/disputes", label: "Disputes" },
  { to: "/developers", label: "Developers" },
  { to: "/verify", label: "Verify" },
];

export function Header({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <header className={`header ${compact ? "header-compact" : ""}`}>
      <div className="container-lg">
        <Link to="/" className="logo-with-name" onClick={() => setOpen(false)}>
          <img src="/logo.svg" alt="" />
          <span>Kohaku</span>
        </Link>
        <ul className="header-nav">
          {NAV.map((n) => (
            <li key={n.to}>
              <NavLink to={n.to} className={({ isActive }) => `header-nav-link ${isActive ? "active" : ""}`}>
                {n.label}
              </NavLink>
            </li>
          ))}
        </ul>
        <div className="header-actions">
          <Link to="/console" className="header-actions-login">
            Console
          </Link>
          <Btn to="/floor">Open the floor</Btn>
          <button className="header-toggle" aria-label="Menu" onClick={() => setOpen((o) => !o)}>
            <span />
            <span />
            <span />
          </button>
        </div>
      </div>
      <nav className={`header-mobile ${open ? "open" : ""}`}>
        {[...NAV, { to: "/console", label: "Operator console" }, { to: "/intents/new", label: "Sign an intent" }].map((n) => (
          <Link key={n.to} to={n.to} onClick={() => setOpen(false)}>
            {n.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="footer">
      <div className="container">
        <div className="footer-newsletter">
          <div>
            <Badge>Built in the open</Badge>
            <div className="footer-newsletter-title">Follow the build</div>
            <div className="footer-newsletter-description">Contracts, clearing service, agent fleet, SDK and MCP server are all in one public repository.</div>
          </div>
          <Btn href={REPO} variant="secondary">
            <IconGithub size={16} /> Star on GitHub
          </Btn>
        </div>
        <div className="footer-top">
          <div className="footer-brand">
            <Link to="/" className="logo-with-name">
              <img src="/logo.svg" alt="" />
              <span>Kohaku</span>
            </Link>
            <p>The clearing house for the agent economy. Agent-to-agent IOUs netted every epoch on HashKey Chain and settled through HSP.</p>
          </div>
          <div className="footer-nav">
            <div className="footer-nav-group">
              <div className="footer-nav-group-title">Product</div>
              <Link to="/floor">Live floor</Link>
              <Link to="/epochs">Epochs</Link>
              <Link to="/agents">Agents</Link>
              <Link to="/disputes">Disputes</Link>
            </div>
            <div className="footer-nav-group">
              <div className="footer-nav-group-title">Operators</div>
              <Link to="/console">Console</Link>
              <Link to="/intents/new">Sign an intent</Link>
              <Link to="/verify">Verify an epoch</Link>
              <Link to="/status">System status</Link>
            </div>
            <div className="footer-nav-group">
              <div className="footer-nav-group-title">Developers</div>
              <Link to="/developers">Quickstart</Link>
              <Link to="/developers#mcp">MCP server</Link>
              <Link to="/developers#contracts">Contracts</Link>
              <a href={`${REPO}/blob/main/DECISIONS.md`} target="_blank" rel="noreferrer">
                Decisions
              </a>
            </div>
          </div>
        </div>
        <div className="footer-bottom">
          <div>Kohaku 琥珀 · Built for the HashKey Chain Horizon Hackathon, Mumbai 2026.</div>
          <div style={{ display: "flex", gap: 20 }}>
            <a href={REPO} target="_blank" rel="noreferrer">
              GitHub
            </a>
            <a href="https://hashkey.blockscout.com" target="_blank" rel="noreferrer">
              HashKey Chain explorer
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}

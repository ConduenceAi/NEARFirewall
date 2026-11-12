import { useEffect, useState } from "react";
import { BookOpen, Bot, Home, LogOut, Menu, Wallet, WalletCards, ListFilter } from "lucide-react";
import { Brand, Logo } from "../components/Brand.tsx";
import { AgentsPanel } from "../components/AgentsPanel.tsx";
import { PaymentsPanel } from "../components/PaymentsPanel.tsx";
import { ActivityPanel } from "../components/ActivityPanel.tsx";
import { ThemeToggle } from "../theme.tsx";
import { useWallet } from "../wallet.tsx";
import { href } from "../router.ts";

const OPERATIONS = [
  { id: "agents", label: "Agents", icon: Bot },
  { id: "payments", label: "Payments", icon: WalletCards },
  { id: "activity", label: "Activity", icon: ListFilter },
] as const;

export type Panel = (typeof OPERATIONS)[number]["id"];

export function AppShell({ panel }: { panel: Panel }) {
  const { accountId, connect, disconnect } = useWallet();
  const [open, setOpen] = useState(false);

  useEffect(() => setOpen(false), [panel, accountId]);

  return (
    <div className="shell">
      <aside className={`sidebar ${open ? "open" : ""}`} aria-label="Sidebar">
        <Brand />

        {accountId && (
          <div>
            <div className="nav-label">Operations</div>
            <nav className="nav" aria-label="Operations">
              {OPERATIONS.map((o) => (
                <a key={o.id} href={href(`/app/${o.id}`)} className={panel === o.id ? "current" : ""} aria-current={panel === o.id ? "page" : undefined}>
                  <o.icon size={18} />
                  {o.label}
                </a>
              ))}
            </nav>
          </div>
        )}

        <div>
          <div className="nav-label">Learn</div>
          <nav className="nav" aria-label="Site">
            <a href={href("/")}>
              <Home size={18} /> Overview
            </a>
            <a href={href("/docs")}>
              <BookOpen size={18} /> Docs
            </a>
          </nav>
        </div>

        <div className="sidebar-spacer" />

        <div className="wallet-card">
          {accountId ? (
            <>
              <div className="wallet-id">
                <span className="avatar">{accountId[0]}</span>
                <div>
                  <strong title={accountId}>{accountId}</strong>
                  <span>connected</span>
                </div>
              </div>
              <div className="wallet-actions">
                <button onClick={() => void disconnect()}>
                  <LogOut size={15} /> Disconnect
                </button>
                <ThemeToggle />
              </div>
            </>
          ) : (
            <>
              <button className="primary" onClick={() => void connect()} style={{ justifyContent: "center" }}>
                <Wallet size={16} /> Connect wallet
              </button>
              <div className="wallet-actions">
                <ThemeToggle />
              </div>
            </>
          )}
        </div>
      </aside>

      <div>
        <div className="mobile-bar">
          <button className="icon-btn" onClick={() => setOpen((v) => !v)} aria-label="Toggle menu" aria-expanded={open}>
            <Menu size={18} />
          </button>
          <strong>NEARFirewall</strong>
        </div>
        <main className="content">
          <div className="content-inner">
            {accountId ? (
              <div className="panel-frame">
                {panel === "agents" && <AgentsPanel />}
                {panel === "payments" && <PaymentsPanel />}
                {panel === "activity" && <ActivityPanel />}
              </div>
            ) : (
              <div className="gate">
                <Logo size={72} />
                <h2>Connect your wallet</h2>
                <p className="lead">
                  Connect a NEAR wallet to register agents, set spending limits and review what they did. Your funds never leave your
                  account.
                </p>
                <button className="primary" onClick={() => void connect()}>
                  <Wallet size={16} /> Connect wallet
                </button>
                <a href={href("/docs/getting-started")} className="muted">
                  New here? Read the getting started guide
                </a>
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

import { ArrowRight, Bot, ListFilter, LogOut, Wallet, WalletCards } from "lucide-react";
import { Brand } from "../components/Brand.tsx";
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

  return (
    <div className={`shell${accountId ? " connected" : ""}`}>
      <header className="app-header">
        <div className="header-inner">
          <Brand />
          <nav className="site-nav" aria-label="Site">
            <a href={href("/")}>Overview</a>
            <a href={href("/docs")}>Docs</a>
          </nav>
          <div className="top-actions">
            <ThemeToggle />
            {accountId && (
              <div className="wallet-session">
                <span className="wallet-account" title={accountId}><i />{accountId}</span>
                <button className="icon-btn" type="button" onClick={() => void disconnect()} aria-label="Disconnect wallet" title="Disconnect wallet">
                  <LogOut size={17} />
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {accountId ? (
        <main className="content">
          <nav className="workspace-nav" aria-label="Operations">
            {OPERATIONS.map(({ id, label, icon: Icon }) => (
              <a key={id} href={href(`/app/${id}`)} aria-current={panel === id ? "page" : undefined}>
                <Icon size={17} aria-hidden="true" />{label}
              </a>
            ))}
          </nav>
          <div className="workspace-panel">
            {panel === "agents" && <AgentsPanel />}
            {panel === "payments" && <PaymentsPanel />}
            {panel === "activity" && <ActivityPanel />}
          </div>
        </main>
      ) : (
        <main className="gate">
          <div className="hero-art" aria-hidden="true" />
          <div className="gate-inner">
            <h1>Connect your wallet.</h1>
            <p className="lead">Register agents, set spending limits, and review payments from your existing NEAR account.</p>
            <div className="cta-row">
              <button className="primary" type="button" onClick={() => void connect()}>
                <Wallet size={17} /> Connect wallet
              </button>
              <a href={href("/docs/getting-started")} className="text-link">Getting started <ArrowRight size={15} /></a>
            </div>
          </div>
        </main>
      )}
    </div>
  );
}

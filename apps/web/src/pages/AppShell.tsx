import { useState } from "react";
import { ArrowRight, Bot, ListFilter, LogOut, Network, PanelLeftClose, PanelLeftOpen, Wallet, WalletCards } from "lucide-react";
import { Brand } from "../components/Brand.tsx";
import { AgentsPanel } from "../components/AgentsPanel.tsx";
import { PaymentsPanel } from "../components/PaymentsPanel.tsx";
import { ActivityPanel } from "../components/ActivityPanel.tsx";
import { AgentMap } from "../components/AgentMap.tsx";
import { ThemeToggle } from "../theme.tsx";
import { useWallet } from "../wallet.tsx";
import { href } from "../router.ts";
import { OnboardingGuide } from "../onboarding.tsx";

const OPERATIONS = [
  { id: "map", label: "Agent map", icon: Network },
  { id: "agents", label: "Agents", icon: Bot },
  { id: "payments", label: "Payments", icon: WalletCards },
  { id: "activity", label: "Activity", icon: ListFilter },
] as const;

export type Panel = (typeof OPERATIONS)[number]["id"];

export function AppShell({ panel }: { panel: Panel }) {
  const { accountId, connect, disconnect } = useWallet();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const sidebarAction = sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar";

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
        <main className="content workspace" data-sidebar-collapsed={sidebarCollapsed}>
          <aside className="workspace-sidebar">
            <button
              className="icon-btn sidebar-toggle"
              type="button"
              onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
              aria-label={sidebarAction}
              aria-expanded={!sidebarCollapsed}
              aria-controls="workspace-navigation"
              title={sidebarAction}
            >
              {sidebarCollapsed ? <PanelLeftOpen size={17} aria-hidden="true" /> : <PanelLeftClose size={17} aria-hidden="true" />}
            </button>
            <nav id="workspace-navigation" className="workspace-nav sidebar" aria-label="Dashboard">
              {OPERATIONS.map(({ id, label, icon: Icon }) => (
                <a
                  key={id}
                  href={href(`/app/${id}`)}
                  aria-current={panel === id ? "page" : undefined}
                  aria-label={sidebarCollapsed ? label : undefined}
                  title={sidebarCollapsed ? label : undefined}
                >
                  <Icon size={17} aria-hidden="true" />
                  <span className="sidebar-label">{label}</span>
                </a>
              ))}
            </nav>
          </aside>
          <div className={`workspace-panel${panel === "map" ? " wide" : ""}`}>
            {panel === "map" && <AgentMap />}
            {panel === "agents" && <AgentsPanel />}
            {panel === "payments" && <PaymentsPanel />}
            {panel === "activity" && <ActivityPanel />}
          </div>
          <OnboardingGuide accountId={accountId} panel={panel} />
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

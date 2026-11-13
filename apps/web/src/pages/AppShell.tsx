import { useEffect, useState } from "react";
import type { AgentView } from "@nearfirewall/sdk";
import { ArrowRight, BookOpen, Bot, ChevronLeft, ChevronRight, ListFilter, LogOut, Network, WalletCards } from "lucide-react";
import { Brand } from "../components/Brand.tsx";
import { AgentsPanel } from "../components/AgentsPanel.tsx";
import { PaymentsPanel } from "../components/PaymentsPanel.tsx";
import { ActivityPanel } from "../components/ActivityPanel.tsx";
import { AgentMap } from "../components/AgentMap.tsx";
import { WalletEntry } from "../components/WalletEntry.tsx";
import { ThemeToggle } from "../theme.tsx";
import { useWallet } from "../wallet.tsx";
import { href } from "../router.ts";
import { OnboardingGuide } from "../onboarding.tsx";
import { RegistrySetup } from "../components/RegistrySetup.tsx";
import { ConnectPanel } from "../components/ConnectPanel.tsx";
import { policyOf } from "../config.ts";
import { useAsync } from "../hooks.ts";
import { loadWorkspaceRegistry, WorkspaceRegistryContext } from "../workspace-registry.tsx";

const OPERATIONS = [
  { id: "map", label: "Agent map", icon: Network },
  { id: "agents", label: "Agents", icon: Bot },
  { id: "payments", label: "Payments", icon: WalletCards },
  { id: "activity", label: "Activity", icon: ListFilter },
] as const;

export type Panel = (typeof OPERATIONS)[number]["id"];

export function AppShell({ panel }: { panel: Panel }) {
  const { accountId, disconnect } = useWallet();
  return <Workspace key={accountId} accountId={accountId} panel={panel} disconnect={disconnect} />;
}

function Workspace({ accountId, panel, disconnect }: { accountId: string | null; panel: Panel; disconnect(): Promise<void> }) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [connecting, setConnecting] = useState<AgentView>();
  const [connectionChanges, setConnectionChanges] = useState(0);
  const registryState = useAsync(
    () => (accountId ? loadWorkspaceRegistry(accountId) : Promise.resolve(null)),
    [accountId],
  );
  const workspace = registryState.data;
  const registryId = workspace?.registry.registryId;
  const waiting = useAsync(
    () => (accountId && registryId ? policyOf(accountId).getPolicy().then((p) => p.registry === registryId ? p.pending ?? 0 : 0).catch(() => 0) : Promise.resolve(0)),
    [accountId, registryId, panel],
  );
  const refreshWaiting = waiting.reload;
  useEffect(() => {
    if (!accountId) return;
    const timer = window.setInterval(refreshWaiting, 15000);
    return () => window.clearInterval(timer);
  }, [accountId, refreshWaiting]);
  const setup = workspace?.setup;
  const registryReady = Boolean(workspace && (!setup || setup.kind === "ready"));
  const sidebarAction = sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar";

  return (
    <div className={`shell${accountId ? " connected" : ""}`}>
      <header className="app-header">
        <div className="header-inner">
          <Brand />
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
              {sidebarCollapsed ? <ChevronRight size={20} aria-hidden="true" /> : <ChevronLeft size={20} aria-hidden="true" />}
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
                  {id === "payments" && (waiting.data ?? 0) > 0 && (
                    <span className="nav-badge" title={`${waiting.data} payment(s) waiting for you`}>
                      {waiting.data}
                    </span>
                  )}
                </a>
              ))}
              <a className="workspace-docs" href={href("/docs")} aria-label="Docs" title={sidebarCollapsed ? "Docs" : undefined}>
                <BookOpen size={17} aria-hidden="true" />
                <span className="sidebar-label">Docs</span>
              </a>
            </nav>
          </aside>
          <WorkspaceRegistryContext.Provider value={workspace ?? null}>
            <div className={`workspace-panel${panel === "map" ? " wide" : ""}`}>
              {registryState.error && <p className="notice error">{registryState.error} <button type="button" onClick={registryState.reload}>Retry</button></p>}
              {!workspace && !registryState.error && <p className="muted">Checking your registry…</p>}
              {registryId && setup && setup.kind !== "ready" && !registryState.error && <RegistrySetup registryId={registryId} state={setup} onCreated={registryState.reload} />}
              {!registryState.error && registryReady && (
                <>
                  {panel === "map" && <AgentMap onConnect={setConnecting} connectionChanges={connectionChanges} />}
                  {panel === "agents" && <AgentsPanel onConnect={setConnecting} />}
                  {panel === "payments" && <PaymentsPanel onPendingChanged={refreshWaiting} />}
                  {panel === "activity" && <ActivityPanel />}
                </>
              )}
            </div>
            {connecting && <ConnectPanel agent={connecting} accountId={accountId} onClose={() => setConnecting(undefined)} onChanged={() => setConnectionChanges((n) => n + 1)} />}
            {workspace && !registryState.error && <OnboardingGuide accountId={accountId} panel={panel} registryReady={registryReady} />}
          </WorkspaceRegistryContext.Provider>
        </main>
      ) : (
        <main className="gate">
          <div className="gate-inner">
            <h1>Connect your wallet.</h1>
            <p className="lead">Register agents, set spending limits, and review payments from your existing NEAR account.</p>
            <div className="cta-row">
              <WalletEntry placement="gate" />
              <a href={href("/docs/getting-started")} className="text-link">Getting started <ArrowRight size={15} /></a>
            </div>
          </div>
        </main>
      )}
    </div>
  );
}

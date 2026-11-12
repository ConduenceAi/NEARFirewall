import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { config } from "./config.ts";
import { WalletProvider, useWallet } from "./wallet.tsx";
import { AgentsPanel } from "./components/AgentsPanel.tsx";
import { PaymentsPanel } from "./components/PaymentsPanel.tsx";
import { ActivityPanel } from "./components/ActivityPanel.tsx";
import "./styles.css";

const TABS = { agents: "Agents", payments: "Payments", activity: "Activity" } as const;
type Tab = keyof typeof TABS;

function App() {
  const { accountId, connect, disconnect } = useWallet();
  const [tab, setTab] = useState<Tab>("agents");
  return (
    <>
      <header>
        <div className="brand">
          <strong>NEARFirewall</strong>
          <span className="muted">{config.network}</span>
        </div>
        <nav>
          {(Object.keys(TABS) as Tab[]).map((t) => (
            <button key={t} className={tab === t ? "current" : ""} onClick={() => setTab(t)}>
              {TABS[t]}
            </button>
          ))}
        </nav>
        <div className="account">
          {accountId ? (
            <>
              <span>{accountId}</span>
              <button onClick={() => void disconnect()}>Disconnect</button>
            </>
          ) : (
            <button className="primary" onClick={() => void connect()}>
              Connect wallet
            </button>
          )}
        </div>
      </header>
      <main>
        {tab === "agents" && <AgentsPanel />}
        {tab === "payments" && <PaymentsPanel />}
        {tab === "activity" && <ActivityPanel />}
      </main>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WalletProvider>
      <App />
    </WalletProvider>
  </StrictMode>,
);

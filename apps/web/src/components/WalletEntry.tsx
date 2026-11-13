import { useState } from "react";
import { ArrowRight, Wallet } from "lucide-react";
import { href } from "../router.ts";
import { useWallet } from "../wallet.tsx";

export function WalletEntry({ placement }: { placement: "header" | "landing" | "gate" }) {
  const { accountId, connect, connecting } = useWallet();
  const [failed, setFailed] = useState(false);
  const header = placement === "header";
  const dashboard = href("/app/map");

  if (accountId) {
    return (
      <a className={`btn ${header ? "header-launch header-dashboard" : "primary"}`} href={dashboard} title={header ? `Signed in as ${accountId}` : undefined}>
        {header ? "Dashboard" : "Open dashboard"}
        <ArrowRight size={16} aria-hidden="true" />
      </a>
    );
  }

  async function openWallet() {
    const start = window.location.hash;
    setFailed(false);
    try {
      if (await connect() && placement !== "gate" && window.location.hash === start) window.location.hash = dashboard;
    } catch {
      setFailed(true);
    }
  }

  return (
    <div className={`wallet-entry${header ? " wallet-entry-header" : ""}`}>
      <button className={header ? "header-launch" : "primary"} type="button" disabled={connecting} onClick={openWallet}>
        <Wallet size={16} aria-hidden="true" /> {connecting ? "Connecting…" : "Connect wallet"}
      </button>
      {failed && <p className="wallet-entry-error" role="alert">Couldn’t connect. Try again.</p>}
    </div>
  );
}

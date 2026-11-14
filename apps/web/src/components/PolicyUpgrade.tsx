import { useState } from "react";
import { grantSetupKey, upgradePolicyCode, upgradePolicyWithSetupKey, type WalletTransaction } from "@nearfirewall/sdk";
import { config } from "../config.ts";
import { ensureOk } from "../format.ts";
import { installWithSetupKey, loadCode } from "../setup-key.ts";
import { useWallet } from "../wallet.tsx";

type Execute = (label: string, tx: WalletTransaction | (() => WalletTransaction | Promise<WalletTransaction>)) => Promise<boolean>;
type Run = (label: string, fn: () => Promise<unknown>) => Promise<boolean>;

/**
 * Upgrades the payment policy on the owner's account to the code the app
 * serves, keeping its approvals, connections, and activity. Policies with
 * `upgrade_code` upgrade from one ordinary wallet call; older ones use a
 * one-time setup key. Either way, code that cannot read the existing state is
 * rolled back.
 */
export function PolicyUpgrade({ accountId, features, busy, exec, run }: { accountId: string; features: string[]; busy: boolean; exec: Execute; run: Run }) {
  const { send } = useWallet();
  const [progress, setProgress] = useState<string | null>(null);
  const inWallet = features.includes("upgrade_code");
  const withSetupKey = () =>
    run("Upgrade the payment policy with a setup key", async () => {
      const code = await loadCode(config.policyWasmUrl, "Policy");
      await installWithSetupKey(
        async (tx) => ensureOk(await send(tx)),
        { accountId, grant: (key) => grantSetupKey(accountId, key), install: (key) => upgradePolicyWithSetupKey(accountId, code, key) },
        setProgress,
      ).finally(() => setProgress(null));
    });
  return (
    <div className="card">
      <h3>Upgrade your payment policy</h3>
      <p>
        <strong>{accountId}</strong> runs an older NEARFirewall policy. Upgrading keeps your approvals, connections, and activity. It adds the
        current features, such as x402 payments in USDC.
      </p>
      <div className="actions">
        {inWallet && (
          <button
            className="primary"
            disabled={busy}
            onClick={() => void exec("Upgrade the payment policy", async () => upgradePolicyCode(accountId, await loadCode(config.policyWasmUrl, "Policy")))}
          >
            Upgrade from your wallet
          </button>
        )}
        <button className={inWallet ? "" : "primary"} disabled={busy} onClick={() => void withSetupKey()}>
          Upgrade with a one-time setup key
        </button>
      </div>
      <p className="hint">
        {inWallet
          ? "From your wallet, this is one ordinary call to the policy's owner-only upgrade method. "
          : "This policy predates in-wallet upgrades, so it needs a one-time setup key. Your wallet adds a temporary key, and this page deploys the new code with it and deletes the key in the same transaction. "}
        The new code must read your existing rules, or the upgrade is undone.
      </p>
      {progress && <p role="status" className="hint">{progress}</p>}
    </div>
  );
}

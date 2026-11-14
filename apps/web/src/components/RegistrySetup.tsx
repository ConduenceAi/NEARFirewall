import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import {
  REGISTRY_DEPOSIT_DIRECT,
  REGISTRY_DEPOSIT_GLOBAL,
  createAccountWithSetupKey,
  createRegistry,
  installRegistryWithSetupKey,
  upgradeRegistryCode,
  type RegistryState,
} from "@nearfirewall/sdk";
import { config } from "../config.ts";
import { ensureOk, near } from "../format.ts";
import { useAction } from "../hooks.ts";
import { installWithSetupKey, isDeployBlocked, loadCode } from "../setup-key.ts";
import { useWallet } from "../wallet.tsx";

/**
 * First step for a new owner: create their own registry on agents.<account>.
 * One wallet transaction creates the account, funds its storage, deploys the
 * code, and makes the owner its owner. No key is added to it.
 *
 * Wallets that refuse to sign a deployment can use a one-time setup key
 * instead: the wallet signs only the account creation and the key, and the
 * page installs the code with that key, which deletes itself.
 */
export function RegistrySetup({ registryId, state, onCreated }: { registryId: string; state: RegistryState; onCreated(): void }) {
  const { accountId, send } = useWallet();
  const action = useAction();
  const [progress, setProgress] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  if (!accountId) return null;
  const global = Boolean(config.registryGlobalCodeHash);
  const deposit = global ? REGISTRY_DEPOSIT_GLOBAL : REGISTRY_DEPOSIT_DIRECT;

  const create = () =>
    action.run("Create my registry", async () => {
      const code = config.registryGlobalCodeHash
        ? { globalCodeHash: config.registryGlobalCodeHash }
        : { code: await loadCode(config.registryWasmUrl, "Registry") };
      try {
        ensureOk(await send(createRegistry(accountId, registryId, code)));
      } catch (error) {
        if (isDeployBlocked(error)) setBlocked(true);
        throw error;
      }
      onCreated();
    });

  const createWithSetupKey = () =>
    action.run("Create my registry with a setup key", async () => {
      const code = await loadCode(config.registryWasmUrl, "Registry");
      await installWithSetupKey(
        async (tx) => ensureOk(await send(tx)),
        {
          accountId: registryId,
          grant: (key) => createAccountWithSetupKey(accountId, registryId, key, REGISTRY_DEPOSIT_DIRECT),
          install: (key) => installRegistryWithSetupKey(registryId, accountId, code, key),
        },
        setProgress,
      ).finally(() => setProgress(null));
      onCreated();
    });

  const upgrade = () =>
    action.run("Upgrade my registry", async () => {
      ensureOk(await send(upgradeRegistryCode(registryId, await loadCode(config.registryWasmUrl, "Registry"))));
      onCreated();
    });

  return (
    <section className="card registry-setup" id="create-registry" aria-labelledby="registry-setup-title">
      <ShieldCheck size={28} aria-hidden="true" />
      {state.kind === "outdated" ? (
        <>
          <h2 id="registry-setup-title">Upgrade your registry</h2>
          <p>
            <code>{registryId}</code> is yours but runs older code than this app. Your agents, their tokens, and their history stay as they are.
          </p>
          {state.upgradable ? (
            <>
              <ul className="hint">
                <li>Your wallet signs one ordinary call to the registry's owner-only <code>upgrade_code</code>. No contract deployment action is involved.</li>
                <li>The new code must read the existing data, or the upgrade is undone.</li>
              </ul>
              <button className="primary" type="button" disabled={action.busy} onClick={() => void upgrade()}>
                {action.busy ? "Waiting for your wallet…" : "Upgrade my registry"}
              </button>
            </>
          ) : (
            <p className="notice error">
              This registry was created before in-wallet upgrades and has no keys, so nobody can change its code. Use a new NEAR account to get a
              registry with the current features, such as x402.
            </p>
          )}
        </>
      ) : (
        <>
          <h2 id="registry-setup-title">Create your registry</h2>
          {state.kind === "untrusted" ? (
            <p className="notice error">{state.reason} NEARFirewall will not use it. Use a different wallet account.</p>
          ) : (
            <>
              <p>
                Your agents live in your own registry, on <code>{registryId}</code>. It is created from your wallet, you are its owner, and only
                you can register agents in it.
              </p>
              <ul className="hint">
                <li>One transaction creates the account, deploys the registry, and sets you as its owner.</li>
                <li>No key is added to it. Only you can change its code later, through an owner-only upgrade call, and you can freeze it for good.</li>
                <li>
                  About {near(deposit)} moves to it to pay for storage{global ? "" : " (it holds its own copy of the code)"}.
                </li>
              </ul>
              <div className="actions">
                <button className="primary" type="button" disabled={action.busy} onClick={() => void create()}>
                  {action.busy && !progress ? "Waiting for your wallet…" : "Create my registry"}
                </button>
                <button type="button" disabled={action.busy} onClick={() => void createWithSetupKey()}>
                  Use a one-time setup key
                </button>
              </div>
              <p className="hint">
                {blocked ? <strong>Your wallet refused the deployment. </strong> : null}
                Some wallets, such as Meteor, refuse to deploy contracts. With a setup key, your wallet signs only the account creation and a temporary
                key. This page then installs the registry with that key, and the same transaction deletes it. The key never leaves this page.
              </p>
            </>
          )}
        </>
      )}
      {progress && <p role="status" className="hint">{progress}</p>}
      {action.message && <p className={`notice ${action.message.kind}`}>{action.message.text}</p>}
    </section>
  );
}

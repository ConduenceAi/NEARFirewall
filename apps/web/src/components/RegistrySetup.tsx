import { ShieldCheck } from "lucide-react";
import { REGISTRY_DEPOSIT_DIRECT, REGISTRY_DEPOSIT_GLOBAL, createRegistry, type RegistryState } from "@nearfirewall/sdk";
import { config } from "../config.ts";
import { ensureOk, near } from "../format.ts";
import { useAction } from "../hooks.ts";
import { useWallet } from "../wallet.tsx";

/**
 * First step for a new owner: create their own registry on agents.<account>.
 * One wallet transaction creates the account, funds its storage, deploys the
 * code, and makes the owner its owner. No key is added to it.
 */
export function RegistrySetup({ registryId, state, onCreated }: { registryId: string; state: RegistryState; onCreated(): void }) {
  const { accountId, send } = useWallet();
  const action = useAction();
  if (!accountId) return null;
  const global = Boolean(config.registryGlobalCodeHash);
  const deposit = global ? REGISTRY_DEPOSIT_GLOBAL : REGISTRY_DEPOSIT_DIRECT;

  const create = () =>
    action.run("Create my registry", async () => {
      let code: { code: Uint8Array } | { globalCodeHash: string };
      if (config.registryGlobalCodeHash) {
        code = { globalCodeHash: config.registryGlobalCodeHash };
      } else {
        const response = await fetch(config.registryWasmUrl);
        if (!response.ok || response.headers.get("content-type")?.includes("text/html")) {
          throw new Error("Registry WASM is unavailable. Run the contract build and copy the WASM into apps/web/public.");
        }
        code = { code: new Uint8Array(await response.arrayBuffer()) };
      }
      ensureOk(await send(createRegistry(accountId, registryId, code)));
      onCreated();
    });

  return (
    <section className="card registry-setup" id="create-registry" aria-labelledby="registry-setup-title">
      <ShieldCheck size={28} aria-hidden="true" />
      <h2 id="registry-setup-title">Create your registry</h2>
      {state.kind === "untrusted" ? (
        <p className="notice error">{state.reason} NEARFirewall will not use it. Use a different wallet account.</p>
      ) : (
        <>
          <p>
            Your agents live in your own registry, on <code>{registryId}</code>. It is created from your wallet, you are its owner,
            and only you can register agents in it.
          </p>
          <ul className="hint">
            <li>One transaction creates the account, deploys the registry, and sets you as its owner.</li>
            <li>No key is added to it, so nobody, including you, can change its code later.</li>
            <li>
              About {near(deposit)} moves to it to pay for storage{global ? "" : " (it holds its own copy of the code)"}.
            </li>
          </ul>
          <button className="primary" type="button" disabled={action.busy} onClick={() => void create()}>
            {action.busy ? "Waiting for your wallet…" : "Create my registry"}
          </button>
        </>
      )}
      {action.message && <p className={`notice ${action.message.kind}`}>{action.message.text}</p>}
    </section>
  );
}

import { createContext, useContext } from "react";
import { checkRegistry, PolicyClient, RegistryClient, registryAccountFor, type RegistryState } from "@nearfirewall/sdk";
import testnet from "../../../deployments/testnet.json";
import { config, rpc } from "./config.ts";

interface WorkspaceRegistry {
  registry: RegistryClient;
  mode: "legacy" | "shared" | "per-user";
  policyCodeHash?: string;
  setup: RegistryState | null;
}

export const WorkspaceRegistryContext = createContext<WorkspaceRegistry | null>(null);

export function useWorkspaceRegistry() {
  const workspace = useContext(WorkspaceRegistryContext);
  if (!workspace) throw new Error("The workspace registry has not been resolved.");
  return workspace;
}

export async function loadWorkspaceRegistry(accountId: string, client = rpc, settings = config): Promise<WorkspaceRegistry> {
  const policy = new PolicyClient(client, accountId);
  const policyCodeHash = settings.policyGlobalCodeHash ?? settings.policyCodeHash;
  if (settings.network === "testnet" && (await policy.state(testnet.policy.codeHash)).kind === "enabled") {
    const view = await policy.getPolicy();
    if (view.registry === testnet.registry) {
      const account = await client.viewAccount(view.registry);
      if (account.codeHash !== testnet.registryCodeHash || account.globalContractAccountId) {
        throw new Error(`The code on ${view.registry} differs from the original Testnet registry.`);
      }
      return { registry: new RegistryClient(client, view.registry), mode: "legacy", policyCodeHash: testnet.policy.codeHash, setup: null };
    }
  }

  if (settings.sharedRegistryId) {
    return { registry: new RegistryClient(client, settings.sharedRegistryId), mode: "shared", policyCodeHash, setup: null };
  }

  const registryId = registryAccountFor(accountId);
  const registry = new RegistryClient(client, registryId);
  const setup = registryId.length > 64 || /^[0-9a-f]{64}$/.test(accountId) || /^0x[0-9a-f]{40}$/.test(accountId)
    ? { kind: "untrusted" as const, reason: "Connect a named NEAR account that can create an agents subaccount." }
    : await checkRegistry(client, registryId, accountId, settings.registryGlobalCodeHash ?? settings.registryCodeHash);
  return { registry, mode: "per-user", policyCodeHash, setup };
}

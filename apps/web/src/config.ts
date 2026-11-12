import { NearRpc, PolicyClient, RegistryClient } from "@nearfirewall/sdk";

const env = import.meta.env;

export const config = {
  network: (env.VITE_NETWORK ?? "testnet") as "testnet" | "mainnet",
  rpcUrl: env.VITE_RPC_URL ?? "https://rpc.testnet.near.org",
  registryId: env.VITE_REGISTRY_ID ?? "registry.nearfirewall.testnet",
  policyCodeHash: env.VITE_POLICY_CODE_HASH || undefined,
  policyGlobalCodeHash: env.VITE_POLICY_GLOBAL_CODE_HASH || undefined,
  policyWasmUrl: env.VITE_POLICY_WASM_URL ?? "/nearfirewall_account_policy.wasm",
  explorerUrl: env.VITE_EXPLORER_URL ?? "https://testnet.nearblocks.io",
};

export const rpc = new NearRpc(config.rpcUrl);
export const registry = new RegistryClient(rpc, config.registryId);
export const policyOf = (accountId: string) => new PolicyClient(rpc, accountId);

export const explorerAccount = (id: string) => `${config.explorerUrl}/address/${id}`;
export const explorerTx = (hash: string) => `${config.explorerUrl}/txns/${hash}`;

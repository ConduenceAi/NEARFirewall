import { NETWORKS, NearRpc, PolicyClient } from "@nearfirewall/sdk";

const env = import.meta.env;
const network = (env.VITE_NETWORK ?? "testnet") as "testnet" | "mainnet";

export const config = {
  network,
  rpcUrl: env.VITE_RPC_URL ?? NETWORKS[network],
  /**
   * "per-user" (default): each owner has their own registry on agents.<account>.
   * "shared": a single registry set by VITE_REGISTRY_ID (the earlier demo setup).
   */
  sharedRegistryId: env.VITE_REGISTRY_ID ?? "",
  registryCodeHash: env.VITE_REGISTRY_CODE_HASH || undefined,
  registryGlobalCodeHash: env.VITE_REGISTRY_GLOBAL_CODE_HASH || undefined,
  registryWasmUrl: env.VITE_REGISTRY_WASM_URL ?? "/nearfirewall_registry.wasm",
  policyCodeHash: env.VITE_POLICY_CODE_HASH || undefined,
  policyGlobalCodeHash: env.VITE_POLICY_GLOBAL_CODE_HASH || undefined,
  policyWasmUrl: env.VITE_POLICY_WASM_URL ?? "/nearfirewall_account_policy.wasm",
  explorerUrl: env.VITE_EXPLORER_URL ?? (network === "mainnet" ? "https://nearblocks.io" : "https://testnet.nearblocks.io"),
};

export const rpc = new NearRpc(config.rpcUrl);
export const policyOf = (accountId: string) => new PolicyClient(rpc, accountId);

export const explorerAccount = (id: string) => `${config.explorerUrl}/address/${id}`;
export const explorerContract = (id: string) => `${explorerAccount(id)}/contract`;
export const explorerNft = (contract: string, tokenId: string) =>
  `${config.explorerUrl}/nft-tokens/${encodeURIComponent(contract)}/tokens/${encodeURIComponent(tokenId)}`;
export const explorerTx = (hash: string) => `${config.explorerUrl}/txns/${hash}`;

import { NearRpc } from "@nearfirewall/sdk";
import { describe, expect, it } from "vitest";
import testnet from "../../../deployments/testnet.json";
import { config } from "../src/config.ts";
import { loadWorkspaceRegistry } from "../src/workspace-registry.tsx";

const wallet = "alice.testnet";
const settings = { ...config, network: "testnet" as const, policyCodeHash: "new-policy-hash", policyGlobalCodeHash: undefined, sharedRegistryId: "" };

function fixture(policyHash: string, registryHash = testnet.registryCodeHash) {
  const accounts: string[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    const { id, params } = JSON.parse(String(init?.body));
    if (params.request_type === "view_account") {
      accounts.push(params.account_id);
      if (params.account_id === `agents.${wallet}`) return Response.json({ id, error: { message: "Account does not exist" } });
      return Response.json({ id, result: { code_hash: params.account_id === wallet ? policyHash : registryHash, amount: "1", locked: "0", storage_usage: 1 } });
    }
    expect(params.method_name).toBe("get_policy");
    const policy = { account: wallet, registry: testnet.registry, paused: false, revision: 1, account_daily_cap: null, account_used_today: "0", safety_buffer: "0", reserved_total: "0", available_balance: "1", day: 1 };
    return Response.json({ id, result: { result: Array.from(new TextEncoder().encode(JSON.stringify(policy))) } });
  };
  return { accounts, rpc: new NearRpc("https://rpc.invalid", fetchImpl) };
}

describe("dashboard registry selection", () => {
  it("restores the original Testnet workspace when the wallet policy already uses it", async () => {
    const { rpc, accounts } = fixture(testnet.policy.codeHash);
    const workspace = await loadWorkspaceRegistry(wallet, rpc, settings);
    expect(workspace).toMatchObject({ mode: "legacy", registry: { registryId: testnet.registry }, policyCodeHash: testnet.policy.codeHash, setup: null });
    expect(accounts).toEqual([wallet, testnet.registry]);
  });

  it("keeps personal registry setup for wallets without the original policy", async () => {
    const { rpc } = fixture("11111111111111111111111111111111");
    const workspace = await loadWorkspaceRegistry(wallet, rpc, settings);
    expect(workspace).toMatchObject({ mode: "per-user", registry: { registryId: `agents.${wallet}` }, policyCodeHash: "new-policy-hash", setup: { kind: "missing" } });
  });

  it("refuses the original registry if its deployed code has changed", async () => {
    const { rpc } = fixture(testnet.policy.codeHash, "unexpected-registry-hash");
    await expect(loadWorkspaceRegistry(wallet, rpc, settings)).rejects.toThrow("differs from the original Testnet registry");
  });
});

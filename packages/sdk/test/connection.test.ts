import { describe, expect, it } from "vitest";
import {
  AgentConnection,
  NearRpc,
  PolicyClient,
  checkRegistry,
  connectAgentKey,
  createRegistry,
  disconnectAgentKey,
  parseNear,
  registryAccountFor,
  setMandate,
  type SubmitAgentExecute,
} from "../src/index.ts";

const KEY = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp";
const b64 = (value: unknown) => btoa(JSON.stringify(value));

/** A fake RPC answering view calls by `<account>.<method>`, plus account and key queries. */
function fakeRpc(views: Record<string, (args: any) => unknown>, accounts: Record<string, { code_hash: string; global_contract_hash?: string; global_contract_account_id?: string; keys?: unknown[] }> = {}) {
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    const p = body.params;
    const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    if (p.request_type === "view_account") {
      const a = accounts[p.account_id];
      if (!a) return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { message: `account ${p.account_id} does not exist` } }));
      return reply({ amount: "1", locked: "0", ...a, storage_usage: 1 });
    }
    if (p.request_type === "view_access_key_list") return reply({ keys: accounts[p.account_id]?.keys ?? [] });
    const handler = views[`${p.account_id}.${p.method_name}`];
    if (!handler) return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { message: `no view ${p.method_name}` } }));
    const value = handler(JSON.parse(atob(p.args_base64)));
    return reply({ result: Array.from(new TextEncoder().encode(value === undefined ? "" : JSON.stringify(value))) });
  }) as unknown as typeof fetch;
  return new NearRpc("http://rpc.invalid", fetchImpl);
}

describe("owner builders for revision 2", () => {
  it("creates the registry on a sub-account in one keyless batch", () => {
    const tx = createRegistry("alice.testnet", registryAccountFor("alice.testnet"), { code: new Uint8Array([0, 97]) });
    expect(tx.receiverId).toBe("agents.alice.testnet");
    expect(tx.actions.map((a) => a.type)).toEqual(["CreateAccount", "Transfer", "DeployContract", "FunctionCall"]);
    const init = tx.actions[3]!;
    if (init.type !== "FunctionCall") throw new Error();
    expect(init.params).toMatchObject({ methodName: "new", args: { owner: "alice.testnet" } });
    expect(tx.actions.some((a) => a.type === "AddKey")).toBe(false);
    expect(() => createRegistry("alice.testnet", "agents.bob.testnet", { code: new Uint8Array() })).toThrow();
    const global = createRegistry("alice.testnet", "agents.alice.testnet", { globalCodeHash: "Hash" });
    expect(global.actions[2]!.type).toBe("UseGlobalContract");
  });

  it("adds only a restricted key, together with the connection record", () => {
    const tx = connectAgentKey("alice.testnet", { agentId: "1", publicKey: KEY, platform: "claude-desktop", label: "Claude" });
    expect(tx.receiverId).toBe("alice.testnet");
    const [addKey, record] = tx.actions;
    if (addKey?.type !== "AddKey" || record?.type !== "FunctionCall") throw new Error();
    expect(addKey.params.accessKey.permission).toEqual({
      receiverId: "alice.testnet",
      allowance: parseNear("0.25").toString(),
      methodNames: ["agent_execute"],
    });
    expect(record.params.methodName).toBe("connect_agent_key");
    expect(record.params.deposit).toBe("1");
    expect(() => connectAgentKey("alice.testnet", { agentId: "1", publicKey: "not-a-key", platform: "x", label: "x" })).toThrow();
    expect(() => connectAgentKey("alice.testnet", { agentId: "1", publicKey: KEY, platform: "x", label: "x", allowance: 0n })).toThrow();
  });

  it("disconnects with or without deleting the key", () => {
    expect(disconnectAgentKey("alice.testnet", KEY).actions.map((a) => a.type)).toEqual(["FunctionCall", "DeleteKey"]);
    expect(disconnectAgentKey("alice.testnet", KEY, { keyPresent: false }).actions.map((a) => a.type)).toEqual(["FunctionCall"]);
  });

  it("sends the mandate's ask-me-first threshold", () => {
    const tx = setMandate("alice.testnet", {
      agentId: "1",
      path: [{ agent_id: "1", generation: 1n }],
      dailyCap: parseNear("10"),
      recipients: [{ recipient: "v.testnet", perPaymentCap: 1n, dailyCap: 2n, confirmAbove: 1n }],
      confirmAbove: parseNear("4"),
    });
    const a = tx.actions[0]!;
    if (a.type !== "FunctionCall") throw new Error();
    expect(a.params.args.confirm_above).toBe(parseNear("4").toString());
    expect((a.params.args.recipients as any[])[0].confirm_above).toBe("1");
  });
});

describe("registry trust check", () => {
  const views = { "agents.alice.testnet.get_owner": () => "alice.testnet" };
  it("reports a missing registry", async () => {
    expect(await checkRegistry(fakeRpc(views), "agents.alice.testnet", "alice.testnet")).toEqual({ kind: "missing" });
  });
  it("accepts a keyless registry owned by the user", async () => {
    const rpc = fakeRpc(views, { "agents.alice.testnet": { code_hash: "H" } });
    expect(await checkRegistry(rpc, "agents.alice.testnet", "alice.testnet", "H")).toEqual({ kind: "ready", codeHash: "H" });
  });
  it("recognizes hash-pinned global code and treats account-managed code as occupied", async () => {
    const empty = "11111111111111111111111111111111";
    const rpc = fakeRpc(views, {
      "agents.alice.testnet": { code_hash: empty, global_contract_hash: "R" },
      "alice.testnet": { code_hash: empty, global_contract_hash: "P" },
      "bob.testnet": { code_hash: empty, global_contract_account_id: "publisher.testnet" },
    });
    expect(await checkRegistry(rpc, "agents.alice.testnet", "alice.testnet", "R")).toEqual({ kind: "ready", codeHash: "R" });
    expect(await new PolicyClient(rpc, "alice.testnet").state("P")).toEqual({ kind: "enabled", codeHash: "P" });
    expect((await new PolicyClient(rpc, "bob.testnet").state()).kind).toBe("other");
  });
  it("rejects wrong code, keys, or owner", async () => {
    // The owner's own keyless registry on other code is outdated (offered an upgrade), not untrusted.
    const wrongCode = fakeRpc(views, { "agents.alice.testnet": { code_hash: "X" } });
    expect((await checkRegistry(wrongCode, "agents.alice.testnet", "alice.testnet", "H")).kind).toBe("outdated");
    const withKey = fakeRpc(views, {
      "agents.alice.testnet": { code_hash: "H", keys: [{ public_key: KEY, access_key: { permission: "FullAccess" } }] },
    });
    expect((await checkRegistry(withKey, "agents.alice.testnet", "alice.testnet")).kind).toBe("untrusted");
    const wrongOwner = fakeRpc({ "agents.alice.testnet.get_owner": () => "bob.testnet" }, { "agents.alice.testnet": { code_hash: "H" } });
    expect((await checkRegistry(wrongOwner, "agents.alice.testnet", "alice.testnet")).kind).toBe("untrusted");
  });
});

describe("agent connection", () => {
  const connection = { public_key: KEY, agent_id: "1", platform: "claude-desktop", label: "Claude", created_at: 1, last_used: null, uses: 0 };
  const agent = (id: string, max: string) => ({
    agent_id: id,
    handle: id === "1" ? "trader" : "desk",
    holder: "alice.testnet",
    parent: null,
    ancestors: [],
    depth: 0,
    executor: null,
    capabilities: { transfer_near: { max_per_payment: max } },
    status: { state: "active" },
    expires_at: null,
    locks: 0,
    generation: "3",
    created_at: "1",
  });
  const views = {
    "alice.testnet.get_connection": () => connection,
    "alice.testnet.get_policy": () => ({
      account: "alice.testnet",
      registry: "agents.alice.testnet",
      paused: false,
      revision: 2,
      account_daily_cap: null,
      account_used_today: "0",
      safety_buffer: "0",
      reserved_total: "0",
      available_balance: parseNear("20").toString(),
      day: 1,
      connections: 1,
      pending: 0,
    }),
    "alice.testnet.get_mandate": () => ({
      path: [{ agent_id: "1", generation: 3 }],
      status: "Active",
      fixed: false,
      expires_at: null,
      daily_cap: parseNear("10").toString(),
      recipients: {
        "vendor.testnet": { per_payment_cap: parseNear("3").toString(), daily_cap: parseNear("6").toString(), expires_at: null, confirm_above: null },
      },
      confirm_above: parseNear("2").toString(),
    }),
    "alice.testnet.get_usage": () => ({ day: 1, mandate_used_today: parseNear("1").toString(), recipient_used_today: parseNear("1").toString(), account_used_today: "0" }),
    "agents.alice.testnet.get_agent": () => agent("1", parseNear("5").toString()),
    "agents.alice.testnet.get_path": () => [{ agent_id: "1", generation: 3 }],
  };

  it("summarizes the effective rules", async () => {
    const c = new AgentConnection({ rpc: fakeRpc(views), account: "alice.testnet", publicKey: KEY, submit: async () => ({ status: {} }) });
    const rules = await c.rules();
    expect(rules.handle).toBe("trader");
    expect(rules.maxPerPayment).toBe(parseNear("5"));
    expect(rules.recipients).toEqual([
      { recipient: "vendor.testnet", perPayment: parseNear("3"), daily: parseNear("6"), usedToday: parseNear("1"), confirmAbove: parseNear("2") },
    ]);
    expect(rules.budgets[0]).toMatchObject({ handle: "trader", daily: parseNear("10"), usedToday: parseNear("1") });
  });

  it("pays and reports settled, waiting, and blocked outcomes", async () => {
    const outcomes = [
      { status: "settled", request_id: "x" },
      { status: "awaiting_confirmation", request_id: "y", expires_at: 99 },
      { status: "denied", reason: "RECIPIENT_NOT_APPROVED", detail: null },
    ];
    const sent: unknown[] = [];
    const submit: SubmitAgentExecute = async (args, gas) => {
      sent.push({ args, gas });
      return { txHash: "tx", status: { SuccessValue: b64(outcomes.shift()) } };
    };
    const c = new AgentConnection({ rpc: fakeRpc(views), account: "alice.testnet", publicKey: KEY, submit, client: "Claude Desktop" });
    const paid = await c.pay("vendor.testnet", parseNear("1"));
    expect(paid.operation.state).toBe("settled");
    expect(paid.message).toContain("Paid 1 NEAR");
    const waiting = await c.pay("vendor.testnet", parseNear("3"));
    expect(waiting.operation.state).toBe("awaiting");
    expect(waiting.message).toContain("Waiting for the owner");
    const blocked = await c.pay("attacker.testnet", parseNear("1"));
    expect(blocked.operation.state).toBe("denied");
    expect(blocked.message).toContain("RECIPIENT_NOT_APPROVED");
    expect((sent[0] as any).args).toMatchObject({ action: { type: "TransferNear", recipient: "vendor.testnet" }, client: "Claude Desktop" });
  });

  it("marks a network failure uncertain instead of guessing", async () => {
    const c = new AgentConnection({
      rpc: fakeRpc(views),
      account: "alice.testnet",
      publicKey: KEY,
      submit: async () => {
        throw new Error("timeout");
      },
    });
    const result = await c.pay("vendor.testnet", 1n, "a".repeat(64));
    expect(result.operation.state).toBe("uncertain");
  });

  it("explains a key that is not connected", async () => {
    const c = new AgentConnection({
      rpc: fakeRpc({ ...views, "alice.testnet.get_connection": () => null }),
      account: "alice.testnet",
      publicKey: KEY,
      submit: async () => ({ status: {} }),
    });
    await expect(c.rules()).rejects.toThrow(/not connected/);
  });
});

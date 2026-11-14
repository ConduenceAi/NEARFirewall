import { describe, expect, it } from "vitest";
import { KeyPair, PublicKey } from "near-api-js";
import {
  Action,
  AgentView,
  PolicyActivity,
  approveX402Seller,
  base58Decode,
  connectAgentKey,
  formatUsdc,
  isX402,
  parseUsdc,
  registerAgent,
  setX402Capability,
  setX402Config,
  setX402Rules,
  setupX402Account,
  toWireAction,
  transferCapability,
  x402AccountFor,
  x402Capability,
  USDC_CONTRACT,
  describeReason,
  NearRpc,
  approveX402Agent,
  approveX402Site,
  checkRegistry,
  createAccountWithSetupKey,
  grantSetupKey,
  installPolicyWithSetupKey,
  installRegistryWithSetupKey,
  registerWithToken,
  removeX402Agent,
  upgradePolicyCode,
  upgradePolicyWithSetupKey,
  upgradeRegistryCode,
} from "../src/index.ts";

const argsOf = (tx: { actions: { type: string; params?: unknown }[] }, i = 0) =>
  (tx.actions[i] as { params: { methodName: string; args: Record<string, unknown>; deposit: string } }).params;

describe("USDC amounts", () => {
  it("parses and formats with 6 decimals", () => {
    expect(parseUsdc("0.05")).toBe(50_000n);
    expect(parseUsdc("12")).toBe(12_000_000n);
    expect(parseUsdc("0.000001")).toBe(1n);
    expect(formatUsdc(50_000n)).toBe("0.05");
    expect(formatUsdc(12_000_000n)).toBe("12");
    expect(() => parseUsdc("0.0000001")).toThrow();
    expect(() => parseUsdc("-1")).toThrow();
  });
});

describe("x402 payment account", () => {
  it("is the implicit account of the connection key, as the policy computes it", () => {
    for (let i = 0; i < 5; i++) {
      const key = KeyPair.fromRandom("ed25519").getPublicKey();
      const hex = Array.from(key.data, (b) => b.toString(16).padStart(2, "0")).join("");
      expect(x402AccountFor(key.toString())).toBe(hex);
    }
    // The contract tests use a key of 32 bytes of 7, whose payment account is "07" x 32.
    const sevens = new PublicKey({ keyType: 0 as never, data: new Uint8Array(32).fill(7) }).toString();
    expect(x402AccountFor(sevens)).toBe("07".repeat(32));
    expect(Array.from(base58Decode(sevens.slice("ed25519:".length)))).toEqual(new Array(32).fill(7));
    expect(() => x402AccountFor("secp256k1:abc")).toThrow("ed25519");
  });
});

describe("x402 wire types", () => {
  it("serializes and parses the X402Pay action", () => {
    const action = { type: "X402Pay" as const, asset: USDC_CONTRACT.testnet, pay_to: "seller.testnet", amount: 50_000n };
    const wire = toWireAction(action);
    expect(wire).toEqual({ type: "X402Pay", asset: USDC_CONTRACT.testnet, pay_to: "seller.testnet", amount: "50000" });
    expect(Action.parse(wire)).toEqual(action);
  });

  it("reads x402 activity and agents from older registries", () => {
    const entry = PolicyActivity.parse({
      seq: 1,
      at: 2,
      leaf: "1",
      request_id: "a".repeat(64),
      recipient: "seller.testnet",
      amount: "50000",
      outcome: "settled",
      reason: null,
      via: { kind: "x402", public_key: "ed25519:x", label: "Claude", payment_account: "ab".repeat(32) },
    });
    expect(isX402(entry.via)).toBe(true);
    const agent = AgentView.parse({
      agent_id: "1",
      handle: "trader",
      holder: "alice.testnet",
      parent: null,
      ancestors: [],
      depth: 0,
      executor: null,
      capabilities: { transfer_near: null },
      status: { state: "active" },
      expires_at: null,
      locks: 0,
      generation: "1",
      created_at: "1",
    });
    expect(agent.x402).toBeUndefined();
  });

  it("explains the new reasons", () => {
    expect(describeReason("UNLISTED_DAILY_CAP")).toContain("not approved by name");
    expect(describeReason("ASSET_NOT_ACCEPTED")).toContain("USDC");
    expect(describeReason("X402_NOT_ENABLED")).toContain("x402");
  });
});

describe("x402 owner transactions", () => {
  it("adds the x402 cap to registration only when set, so older registries accept it", () => {
    const plain = argsOf(registerAgent("agents.alice.testnet", "trader", { capabilities: transferCapability(1n) }));
    expect("x402" in plain.args).toBe(false);
    const withX402 = argsOf(
      registerAgent("agents.alice.testnet", "trader", { capabilities: {}, x402: x402Capability(parseUsdc("0.5")) }),
    );
    expect(withX402.args.x402).toEqual({ max_per_payment: "500000" });
    expect(argsOf(setX402Capability("agents.alice.testnet", "1", null)).args).toEqual({ agent_id: "1", x402: null });
  });

  it("builds the policy's x402 calls with 1 yoctoNEAR", () => {
    const config = argsOf(setX402Config("alice.testnet", USDC_CONTRACT.testnet, parseUsdc("5")));
    expect(config).toMatchObject({ methodName: "set_x402_config", deposit: "1" });
    expect(config.args).toEqual({ asset: USDC_CONTRACT.testnet, account_daily_cap: "5000000" });

    const rules = argsOf(
      setX402Rules("alice.testnet", "1", {
        dailyCap: parseUsdc("1"),
        sellers: [{ seller: "known.testnet", perPaymentCap: parseUsdc("0.2"), dailyCap: parseUsdc("0.5") }],
        unlisted: { perPaymentCap: parseUsdc("0.05"), dailyCap: parseUsdc("0.1") },
      }),
    );
    expect(rules.args).toEqual({
      agent_id: "1",
      daily_cap: "1000000",
      sellers: [{ seller: "known.testnet", per_payment_cap: "200000", daily_cap: "500000" }],
      unlisted: { per_payment_cap: "50000", daily_cap: "100000" },
    });
    expect(argsOf(approveX402Seller("alice.testnet", "1", "b.testnet", { perPaymentCap: 1n, dailyCap: 2n })).args).toEqual({
      agent_id: "1",
      seller: "b.testnet",
      per_payment_cap: "1",
      daily_cap: "2",
    });
  });

  it("can prepare the payment account in the same transaction as the connection", () => {
    const publicKey = KeyPair.fromRandom("ed25519").getPublicKey().toString();
    const tx = connectAgentKey("alice.testnet", { agentId: "1", publicKey, platform: "claude-desktop", label: "Claude", x402: true });
    expect(tx.actions.map((a) => (a.type === "FunctionCall" ? a.params.methodName : a.type))).toEqual([
      "AddKey",
      "connect_agent_key",
      "setup_x402_account",
    ]);
    expect(argsOf(setupX402Account("alice.testnet", publicKey)).args).toEqual({ public_key: publicKey });
    expect(() => setupX402Account("alice.testnet", "secp256k1:abc")).toThrow();
  });
});

describe("x402 websites and agents", () => {
  it("sends the site and the claimed agent with an X402Pay action, only when set", () => {
    const base = { type: "X402Pay" as const, asset: "usdc.testnet", pay_to: "bob.testnet", amount: 1n };
    expect(toWireAction(base)).not.toHaveProperty("site");
    expect(toWireAction({ ...base, site: "api.example.com", payee_agent: { registry: "agents.bob.testnet", agent_id: "7" } })).toMatchObject({
      site: "api.example.com",
      payee_agent: { registry: "agents.bob.testnet", agent_id: "7" },
    });
  });

  it("approves websites and agents one by one", () => {
    expect(argsOf(approveX402Site("alice.testnet", "1", { site: "api.example.com", payTo: "example.testnet", perPaymentCap: 1n, dailyCap: 2n })).args).toEqual({
      agent_id: "1",
      site: "api.example.com",
      per_payment_cap: "1",
      daily_cap: "2",
      pay_to: "example.testnet",
    });
    expect(argsOf(approveX402Agent("alice.testnet", "1", { registry: "agents.bob.testnet", agentId: "7", generation: 3n, perPaymentCap: 1n, dailyCap: 2n })).args).toEqual({
      agent_id: "1",
      registry: "agents.bob.testnet",
      payee_agent_id: "7",
      per_payment_cap: "1",
      daily_cap: "2",
      generation: 3,
    });
    expect(argsOf(removeX402Agent("alice.testnet", "1", "7@agents.bob.testnet")).args).toEqual({ agent_id: "1", payee: "7@agents.bob.testnet" });
  });

  it("registers an account with a token", () => {
    const tx = registerWithToken(USDC_CONTRACT.testnet, "bob.testnet");
    expect(tx.receiverId).toBe(USDC_CONTRACT.testnet);
    expect(argsOf(tx).args).toEqual({ account_id: "bob.testnet", registration_only: true });
  });
});

describe("installing code without a deployment in the wallet", () => {
  const key = KeyPair.fromRandom("ed25519").getPublicKey().toString();
  const code = new Uint8Array([0, 97, 115, 109, 1]);
  const kinds = (tx: { actions: { type: string; params?: any }[] }) =>
    tx.actions.map((a) => (a.type === "FunctionCall" ? a.params.methodName : a.type === "AddKey" ? `AddKey:${JSON.stringify(a.params.accessKey.permission)}` : a.type));

  it("lets the wallet sign only a key, and the key install and delete itself", () => {
    expect(kinds(grantSetupKey("alice.testnet", key))).toEqual(['AddKey:"FullAccess"']);
    expect(kinds(createAccountWithSetupKey("alice.testnet", "agents.alice.testnet", key))).toEqual(["CreateAccount", "Transfer", 'AddKey:"FullAccess"']);
    const registry = installRegistryWithSetupKey("agents.alice.testnet", "alice.testnet", code, key);
    expect(kinds(registry)).toEqual(["DeployContract", "new", "DeleteKey"]);
    expect(registry.actions[2]).toEqual({ type: "DeleteKey", params: { publicKey: key } });
    const policy = installPolicyWithSetupKey("alice.testnet", "agents.alice.testnet", code, key, 5n);
    expect(kinds(policy)).toEqual(["DeployContract", "initialize", "DeleteKey"]);
    expect(kinds(upgradePolicyWithSetupKey("alice.testnet", code, key))).toEqual(["DeployContract", "get_revision", "DeleteKey"]);
    expect(() => createAccountWithSetupKey("alice.testnet", "agents.bob.testnet", key)).toThrow("sub-account");
    expect(() => grantSetupKey("alice.testnet", "secp256k1:abc")).toThrow();
  });

  it("upgrades through the contracts' own upgrade_code, with the code as base64", () => {
    const tx = upgradePolicyCode("alice.testnet", code);
    expect(tx.receiverId).toBe("alice.testnet");
    expect(argsOf(tx)).toMatchObject({ methodName: "upgrade_code", deposit: "1" });
    expect(argsOf(tx).args).toEqual({ code: Buffer.from(code).toString("base64") });
    expect(upgradeRegistryCode("agents.alice.testnet", code).receiverId).toBe("agents.alice.testnet");
  });

  it("reports an owner's older registry as outdated, and whether it can upgrade itself", async () => {
    const view = (result: unknown) => ({ result: Array.from(new TextEncoder().encode(JSON.stringify(result))) });
    const rpc = (upgradable: boolean) =>
      new NearRpc("http://rpc.invalid", (async (_u: string, init: { body: string }) => {
        const { id, params } = JSON.parse(init.body);
        let result: unknown;
        if (params.request_type === "view_account") result = { amount: "0", locked: "0", code_hash: "OldHash", storage_usage: 1 };
        else if (params.request_type === "view_access_key_list") result = { keys: [] };
        else if (params.method_name === "get_owner") result = view("alice.testnet");
        else if (params.method_name === "is_code_frozen") {
          if (!upgradable) return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { message: "MethodNotFound" } }));
          result = view(false);
        }
        return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }));
      }) as unknown as typeof fetch);
    expect(await checkRegistry(rpc(true), "agents.alice.testnet", "alice.testnet", "NewHash")).toEqual({ kind: "outdated", codeHash: "OldHash", upgradable: true });
    expect(await checkRegistry(rpc(false), "agents.alice.testnet", "alice.testnet", "NewHash")).toEqual({ kind: "outdated", codeHash: "OldHash", upgradable: false });
    expect(await checkRegistry(rpc(true), "agents.alice.testnet", "mallory.testnet", "NewHash")).toMatchObject({ kind: "untrusted" });
  });
});

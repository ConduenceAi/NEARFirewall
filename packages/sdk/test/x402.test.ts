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

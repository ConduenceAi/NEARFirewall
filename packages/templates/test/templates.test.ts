import { describe, expect, it } from "vitest";
import { DAY_NS, LOCKS, NearRpc, PolicyClient, RegistryClient, parseNear, transferCapability } from "@nearfirewall/sdk";
import {
  approvedVendors,
  buildPlan,
  getTemplate,
  toTransaction,
  validatePlan,
  validatePlanLive,
  type Plan,
  type PlanContext,
} from "../src/index.ts";

const NOW = 1_700_000_000_000_000_000n;
const ctx: PlanContext = { now: NOW, owner: "alice.testnet", payer: "alice.testnet", registryId: "registry.testnet" };

const readmeInput = {
  handle: "market-agent",
  executor: "agent-runner.testnet",
  maxPerPayment: "3",
  dailyBudget: "10",
  recipients: [
    { recipient: "vendor.testnet", perPayment: "3", daily: "6" },
    { recipient: "vendor2.testnet", perPayment: "2", daily: "4" },
  ],
};

const codes = (plan: Plan) => validatePlan(plan, ctx).issues.map((i) => i.code);

describe("approved vendors template", () => {
  it("builds a deterministic plan", () => {
    const a = buildPlan(approvedVendors, readmeInput, ctx);
    const b = buildPlan(approvedVendors, readmeInput, ctx);
    expect(a).toEqual(b);
    expect(a.steps.map((s) => s.kind)).toEqual(["register_agent", "set_mandate"]);
    const mandate = a.steps[1]!;
    if (mandate.kind !== "set_mandate") throw new Error();
    expect(mandate.dailyCap).toBe(parseNear("10"));
    expect(mandate.recipients[0]).toEqual({
      recipient: "vendor.testnet",
      perPaymentCap: parseNear("3"),
      dailyCap: parseNear("6"),
      expiresAt: null,
    });
    expect(validatePlan(a, ctx)).toEqual({ ok: true, issues: [] });
    expect(getTemplate("approved-vendors")).toBe(approvedVendors);
  });

  it("adds leaves, locks, and expiry", () => {
    const plan = buildPlan(
      approvedVendors,
      {
        ...readmeInput,
        handle: "desk",
        leaves: [{ label: "bot-1", executor: "runner-1.testnet", maxPerPayment: "3" }],
        expiresInDays: 30,
        nonTransferable: true,
        freezeCapabilities: true,
      },
      ctx,
    );
    const [root, leaf] = plan.steps;
    if (root?.kind !== "register_agent" || leaf?.kind !== "create_child") throw new Error();
    expect(root.locks).toBe(LOCKS.NO_TRANSFER | LOCKS.NO_CAPABILITY_RAISE);
    expect(root.expiresAt).toBe(NOW + 30n * DAY_NS);
    expect(leaf.parentHandle).toBe("desk");
    expect(validatePlan(plan, ctx).ok).toBe(true);
  });

  it("rejects bad input through its schema", () => {
    expect(() => buildPlan(approvedVendors, { ...readmeInput, maxPerPayment: "-1" }, ctx)).toThrow();
    expect(() => buildPlan(approvedVendors, { ...readmeInput, recipients: [] }, ctx)).toThrow();
    expect(() => buildPlan(approvedVendors, { ...readmeInput, handle: "Bad_Handle" }, ctx)).toThrow();
  });
});

describe("validatePlan", () => {
  const base = () => buildPlan(approvedVendors, readmeInput, ctx);

  it("rejects the executor or the payer as a recipient", () => {
    const plan = base();
    const m = plan.steps[1]!;
    if (m.kind !== "set_mandate") throw new Error();
    m.recipients.push({ recipient: "agent-runner.testnet", perPaymentCap: 1n, dailyCap: 1n });
    m.recipients.push({ recipient: "alice.testnet", perPaymentCap: 1n, dailyCap: 1n });
    expect(codes(plan)).toEqual(expect.arrayContaining(["RECIPIENT_IS_EXECUTOR", "RECIPIENT_IS_PAYER"]));
    expect(validatePlan(plan, ctx).ok).toBe(false);
  });

  it("rejects zero caps, inverted caps, and duplicates", () => {
    const plan = base();
    const m = plan.steps[1]!;
    if (m.kind !== "set_mandate") throw new Error();
    m.recipients.push({ recipient: "x.testnet", perPaymentCap: 0n, dailyCap: 1n });
    m.recipients.push({ recipient: "y.testnet", perPaymentCap: 5n, dailyCap: 1n });
    m.recipients.push({ recipient: "vendor.testnet", perPaymentCap: 1n, dailyCap: 1n });
    expect(codes(plan)).toEqual(expect.arrayContaining(["ZERO_CAP", "PER_PAYMENT_ABOVE_DAILY", "DUPLICATE_RECIPIENT"]));
  });

  it("rejects children wider than their parent or outliving it", () => {
    const plan: Plan = {
      templateId: "custom",
      templateVersion: 1,
      title: "t",
      steps: [
        { kind: "register_agent", handle: "desk", executor: "r.testnet", capabilities: transferCapability(3n), expiresAt: NOW + 10n },
        { kind: "create_child", parentHandle: "desk", label: "bot-1", executor: "r1.testnet", capabilities: transferCapability(5n) },
      ],
    };
    expect(codes(plan)).toEqual(expect.arrayContaining(["CHILD_WIDER_THAN_PARENT", "CHILD_OUTLIVES_PARENT"]));
  });

  it("warns about a recipient limit above the agent's capability", () => {
    const plan = buildPlan(approvedVendors, { ...readmeInput, maxPerPayment: "1" }, ctx);
    const result = validatePlan(plan, ctx);
    expect(result.ok).toBe(true);
    expect(result.issues.map((i) => i.code)).toContain("RULE_ABOVE_CAPABILITY");
  });

  it("rejects an executor equal to the owner and past expiries", () => {
    const plan = buildPlan(approvedVendors, { ...readmeInput, executor: "alice.testnet" }, ctx);
    expect(codes(plan)).toContain("EXECUTOR_IS_OWNER");
    const past: Plan = { ...plan, steps: [{ ...(plan.steps[0] as any), executor: "r.testnet", expiresAt: NOW - 1n }] };
    expect(codes(past)).toContain("EXPIRY_IN_PAST");
  });

  it("warns about sensitive plain-text records", () => {
    const plan: Plan = {
      templateId: "custom",
      templateVersion: 1,
      title: "t",
      steps: [
        { kind: "set_record", agentHandle: "payroll", key: "payroll.salary", value: "5000 NEAR" },
        { kind: "set_record", agentHandle: "payroll", key: "payroll.breakdown_hash", value: "a".repeat(64) },
      ],
    };
    const issues = validatePlan(plan, ctx).issues.filter((i) => i.code === "SENSITIVE_RECORD");
    expect(issues).toHaveLength(1);
    expect(issues[0]!.step).toBe(0);
  });
});

// ------------------------------------------------------------------ live checks

function chain(state: { agents: Record<string, any>; codeHash: string; available: string }) {
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    const p = body.params;
    if (p.request_type === "view_account") {
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { amount: "0", locked: "0", code_hash: state.codeHash, storage_usage: 1 } }),
      );
    }
    const args = JSON.parse(atob(p.args_base64));
    let value: unknown = null;
    if (p.method_name === "resolve") value = state.agents[args.handle] ?? null;
    if (p.method_name === "get_path") value = [{ agent_id: "1", generation: 4 }];
    if (p.method_name === "get_policy") {
      value = {
        account: "alice.testnet",
        registry: "registry.testnet",
        paused: false,
        revision: 1,
        account_daily_cap: null,
        account_used_today: "0",
        safety_buffer: "0",
        reserved_total: "0",
        available_balance: state.available,
        day: 1,
      };
    }
    const bytes = Array.from(new TextEncoder().encode(JSON.stringify(value)));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { result: bytes } }));
  }) as unknown as typeof fetch;
  const rpc = new NearRpc("http://rpc.invalid", fetchImpl);
  return { registry: new RegistryClient(rpc, "registry.testnet"), policy: new PolicyClient(rpc, "alice.testnet") };
}

const existingAgent = {
  agent_id: "1",
  handle: "market-agent",
  holder: "alice.testnet",
  parent: null,
  ancestors: [],
  depth: 0,
  executor: "agent-runner.testnet",
  capabilities: { transfer_near: { max_per_payment: parseNear("3").toString() } },
  status: { state: "active" },
  expires_at: null,
  locks: 0,
  generation: "4",
  created_at: "1",
};

describe("validatePlanLive", () => {
  it("rejects a taken handle and an account without the policy", async () => {
    const clients = chain({ agents: { "market-agent": existingAgent }, codeHash: "11111111111111111111111111111111", available: "0" });
    const result = await validatePlanLive(buildPlan(approvedVendors, readmeInput, ctx), ctx, clients);
    expect(result.issues.map((i) => i.code)).toEqual(expect.arrayContaining(["HANDLE_TAKEN", "PAYMENTS_NOT_ENABLED"]));
  });

  it("rejects an account running another contract and warns on a budget above balance", async () => {
    const plan = buildPlan(approvedVendors, readmeInput, ctx);
    const other = await validatePlanLive(plan, ctx, { ...chain({ agents: {}, codeHash: "Other", available: "0" }), expectedPolicyCodeHash: "Policy" });
    expect(other.issues.map((i) => i.code)).toContain("UNKNOWN_CONTRACT");
    const poor = await validatePlanLive(plan, ctx, { ...chain({ agents: {}, codeHash: "Policy", available: parseNear("1").toString() }), expectedPolicyCodeHash: "Policy" });
    expect(poor.ok).toBe(true);
    expect(poor.issues.map((i) => i.code)).toContain("BUDGET_ABOVE_BALANCE");
  });

  it("checks a child against its on-chain parent", async () => {
    const plan: Plan = {
      templateId: "custom",
      templateVersion: 1,
      title: "t",
      steps: [{ kind: "create_child", parentHandle: "market-agent", label: "bot-1", executor: "r1.testnet", capabilities: transferCapability(parseNear("5")) }],
    };
    const result = await validatePlanLive(plan, ctx, chain({ agents: { "market-agent": existingAgent }, codeHash: "x", available: "0" }));
    expect(result.issues.map((i) => i.code)).toContain("CHILD_WIDER_THAN_PARENT");
  });

  it("materializes steps into wallet transactions with on-chain paths", async () => {
    const { registry } = chain({ agents: { "market-agent": existingAgent }, codeHash: "x", available: "0" });
    const plan = buildPlan(approvedVendors, readmeInput, ctx);
    const register = await toTransaction(plan.steps[0]!, ctx, registry);
    expect(register.receiverId).toBe("registry.testnet");
    const mandate = await toTransaction(plan.steps[1]!, ctx, registry);
    expect(mandate.receiverId).toBe("alice.testnet");
    const action = mandate.actions[0]!;
    if (action.type !== "FunctionCall") throw new Error();
    expect(action.params.methodName).toBe("set_mandate");
    expect(action.params.args.path).toEqual([{ agent_id: "1", generation: 4 }]);
  });
});

import { describe, expect, it } from "vitest";
import {
  AgentView,
  ExecutorClient,
  MemoryJournalStore,
  NearRpc,
  OperationJournal,
  PolicyClient,
  RegistryClient,
  approveRecipient,
  enablePayments,
  executeArgs,
  formatNear,
  newRequestId,
  parseFinalStatus,
  parseNear,
  registerAgent,
  setMandate,
  transferCapability,
  type SubmitExecute,
} from "../src/index.ts";

const b64 = (value: unknown) => btoa(JSON.stringify(value));

/** A fake RPC endpoint that answers view calls from a table. */
function fakeRpc(views: Record<string, (args: any) => unknown>, account?: { code_hash: string }) {
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    const p = body.params;
    let result: unknown;
    if (p.request_type === "view_account") {
      result = { amount: "5", locked: "0", code_hash: account?.code_hash ?? "11111111111111111111111111111111", storage_usage: 100 };
    } else {
      const args = JSON.parse(atob(p.args_base64));
      const handler = views[`${p.account_id}.${p.method_name}`];
      if (!handler) return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { message: "no such view" } }));
      const value = handler(args);
      result = { result: Array.from(new TextEncoder().encode(value === undefined ? "" : JSON.stringify(value))) };
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  }) as unknown as typeof fetch;
  return new NearRpc("http://rpc.invalid", fetchImpl);
}

const agentJson = {
  agent_id: "1",
  handle: "market-agent",
  holder: "alice.testnet",
  parent: null,
  ancestors: [],
  depth: 0,
  executor: "runner.testnet",
  capabilities: { transfer_near: { max_per_payment: "3000000000000000000000000" } },
  status: { state: "active" },
  expires_at: null,
  locks: 0,
  generation: "4",
  created_at: "1700000000000000000",
};

describe("amounts", () => {
  it("parses and formats NEAR", () => {
    expect(parseNear("2.5")).toBe(2_500_000_000_000_000_000_000_000n);
    expect(parseNear("0.000000000000000000000001")).toBe(1n);
    expect(formatNear(parseNear("10.25"))).toBe("10.25");
    expect(formatNear(0n)).toBe("0");
    expect(() => parseNear("1e3")).toThrow();
  });
});

describe("types", () => {
  it("decodes agent views with bigint amounts", () => {
    const view = AgentView.parse(agentJson);
    expect(view.capabilities.transfer_near?.max_per_payment).toBe(parseNear("3"));
    expect(view.generation).toBe(4n);
  });
});

describe("clients", () => {
  it("reads registry and policy views", async () => {
    const rpc = fakeRpc({
      "registry.testnet.resolve": (args) => (args.handle === "market-agent" ? agentJson : null),
      "registry.testnet.get_path": () => [{ agent_id: "1", generation: 4 }],
      "alice.testnet.get_request": () => null,
    });
    const registry = new RegistryClient(rpc, "registry.testnet");
    expect((await registry.find("market-agent"))?.agent_id).toBe("1");
    expect(await registry.resolve("nobody")).toBeNull();
    expect(await registry.getPath("1")).toEqual([{ agent_id: "1", generation: 4n }]);
    const policy = new PolicyClient(rpc, "alice.testnet");
    expect(await policy.getRequest("1", "00")).toBeNull();
    expect(await policy.state()).toEqual({ kind: "none" });
  });

  it("detects an account that runs some other contract", async () => {
    const rpc = fakeRpc({}, { code_hash: "SomeOtherHash" });
    expect(await new PolicyClient(rpc, "alice.testnet").state("PolicyHash")).toEqual({ kind: "other", codeHash: "SomeOtherHash" });
    expect(await new PolicyClient(rpc, "alice.testnet").state("SomeOtherHash")).toEqual({ kind: "enabled", codeHash: "SomeOtherHash" });
  });
});

describe("owner transactions", () => {
  it("attach one yocto to owner writes and storage to mints", () => {
    const reg = registerAgent("registry.testnet", "market-agent", {
      executor: "runner.testnet",
      capabilities: transferCapability(parseNear("3")),
    });
    const action = reg.actions[0]!;
    expect(action.type).toBe("FunctionCall");
    if (action.type !== "FunctionCall") throw new Error();
    expect(action.params.args).toMatchObject({
      handle: "market-agent",
      capabilities: { transfer_near: { max_per_payment: "3000000000000000000000000" } },
    });
    expect(BigInt(action.params.deposit)).toBeGreaterThan(1n);

    const approve = approveRecipient("alice.testnet", "1", {
      recipient: "vendor.testnet",
      perPaymentCap: parseNear("3"),
      dailyCap: parseNear("6"),
    });
    expect(approve.receiverId).toBe("alice.testnet");
    const a = approve.actions[0]!;
    if (a.type !== "FunctionCall") throw new Error();
    expect(a.params.deposit).toBe("1");
    expect(a.params.args).toEqual({
      agent_id: "1",
      recipient: "vendor.testnet",
      per_payment_cap: "3000000000000000000000000",
      daily_cap: "6000000000000000000000000",
      expires_at: null,
    });
  });

  it("builds mandates with the agent path and deploy batches", () => {
    const tx = setMandate("alice.testnet", {
      agentId: "2",
      path: [
        { agent_id: "1", generation: 4n },
        { agent_id: "2", generation: 7n },
      ],
      dailyCap: parseNear("5"),
      recipients: [],
    });
    const a = tx.actions[0]!;
    if (a.type !== "FunctionCall") throw new Error();
    expect(a.params.args.path).toEqual([
      { agent_id: "1", generation: 4 },
      { agent_id: "2", generation: 7 },
    ]);
    const enable = enablePayments("alice.testnet", "registry.testnet", { code: new Uint8Array([0, 97, 115, 109]) });
    expect(enable.receiverId).toBe("alice.testnet");
    expect(enable.actions.map((x) => x.type)).toEqual(["DeployContract", "FunctionCall"]);
  });
});

describe("outcomes", () => {
  it("parses final statuses", () => {
    expect(parseFinalStatus({ SuccessValue: b64({ status: "settled", request_id: "ab" }) })).toEqual({ status: "settled", request_id: "ab" });
    expect(parseFinalStatus({ SuccessValue: b64({ status: "denied", reason: "RECIPIENT_NOT_APPROVED", detail: null }) })).toMatchObject({
      status: "denied",
      reason: "RECIPIENT_NOT_APPROVED",
    });
    expect(parseFinalStatus({ Failure: { ActionError: {} } }).status).toBe("error");
  });

  it("builds execute arguments", () => {
    const id = newRequestId();
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(executeArgs({ payer: "alice.testnet", agentId: "1", recipient: "vendor.testnet", amount: 5n, requestId: id })).toEqual({
      payer: "alice.testnet",
      agent_id: "1",
      grant_id: null,
      action: { type: "TransferNear", recipient: "vendor.testnet", amount: "5" },
      request_id: id,
      expected_revision: null,
    });
  });
});

describe("executor client", () => {
  const request = { payer: "alice.testnet", agentId: "1", recipient: "vendor.testnet", amount: 2n };

  function setup(submit: SubmitExecute, record: () => unknown = () => null) {
    const rpc = fakeRpc({ "alice.testnet.get_request": record });
    const journal = new OperationJournal(new MemoryJournalStore());
    return new ExecutorClient(submit, journal, (payer) => new PolicyClient(rpc, payer));
  }

  it("records settled and denied outcomes", async () => {
    const client = setup(async (args) => ({
      txHash: "tx",
      status: {
        SuccessValue: b64(
          BigInt(args.action.amount as string) > 2n
            ? { status: "denied", reason: "PER_PAYMENT_CAP", detail: null }
            : { status: "settled", request_id: args.request_id },
        ),
      },
    }));
    expect((await client.pay(request)).operation.state).toBe("settled");
    const denied = await client.pay({ ...request, amount: 9n });
    expect(denied.operation.state).toBe("denied");
    expect(denied.operation.reason).toBe("PER_PAYMENT_CAP");
  });

  it("marks network errors uncertain and resolves them from the payer's record", async () => {
    let calls = 0;
    const client = setup(
      async () => {
        calls++;
        throw new Error("timeout");
      },
      () => ({
        leaf: "1",
        request_id: "x",
        recipient: "vendor.testnet",
        amount: "2",
        day: 1,
        created_at: 1,
        status: "Settled",
        mandates: ["1"],
      }),
    );
    const first = await client.pay({ ...request, requestId: "a".repeat(64) });
    expect(first.operation.state).toBe("uncertain");
    const resolved = await client.resolve("a".repeat(64));
    expect(resolved.operation.state).toBe("settled");
    expect(calls).toBe(1); // found on chain, so it was not resubmitted
  });

  it("resubmits an unresolved request only with the same request ID", async () => {
    const seen: string[] = [];
    let fail = true;
    const client = setup(async (args) => {
      seen.push(args.request_id);
      if (fail) {
        fail = false;
        throw new Error("timeout");
      }
      return { status: { SuccessValue: b64({ status: "settled", request_id: args.request_id }) } };
    });
    const id = "b".repeat(64);
    await client.pay({ ...request, requestId: id });
    expect((await client.resolve(id)).operation.state).toBe("settled");
    expect(seen).toEqual([id, id]);
    // A settled request is never submitted again.
    await client.pay({ ...request, requestId: id });
    expect(seen.length).toBe(2);
  });

  it("treats a duplicate denial as an earlier attempt and reads the payer's record", async () => {
    const client = setup(
      async () => ({ status: { SuccessValue: b64({ status: "denied", reason: "DUPLICATE_REQUEST", detail: null }) } }),
      () => ({ leaf: "1", request_id: "c", recipient: "vendor.testnet", amount: "2", day: 1, created_at: 1, status: "Pending", mandates: ["1"] }),
    );
    const result = await client.pay({ ...request, requestId: "c".repeat(64) });
    expect(result.operation.state).toBe("uncertain");
  });
});

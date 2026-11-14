import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { KeyPair, type KeyPairString } from "near-api-js";
import { NearRpc, USDC_CONTRACT, parseUsdc, x402AccountFor, type AgentConnection } from "@nearfirewall/sdk";
import {
  Facilitator,
  X402Buyer,
  claimedAgent,
  createFacilitatorServer,
  createPaywall,
  plainTransport,
  siteOf,
  signFtTransferDelegate,
  type Relay,
} from "../src/index.ts";

const USDC = USDC_CONTRACT.testnet;
const SELLER = "seller.testnet";
const PRICE = parseUsdc("0.05");

function newKey() {
  const pair = KeyPair.fromRandom("ed25519");
  const publicKey = pair.getPublicKey().toString();
  return { secret: pair.toString() as KeyPairString, publicKey, account: x402AccountFor(publicKey) };
}

/** The chain as the facilitator reads it. */
function chain(over: Partial<{ height: number; nonce: number; permission: unknown; balance: bigint; registered: boolean }> = {}) {
  const state = { height: 1000, nonce: 5, permission: "FullAccess" as unknown, balance: PRICE, registered: true, ...over };
  const rpc = new NearRpc("http://rpc.invalid", (async (_url: string, init: { body: string }) => {
    const { id, method, params } = JSON.parse(init.body);
    let result: unknown;
    const bytes = (v: unknown) => ({ result: Array.from(new TextEncoder().encode(JSON.stringify(v))) });
    if (method === "block") result = { header: { height: state.height } };
    else if (params.request_type === "view_access_key") result = { nonce: state.nonce, permission: state.permission };
    else if (params.method_name === "ft_balance_of") result = bytes(state.balance.toString());
    else if (params.method_name === "storage_balance_of") result = bytes(state.registered ? { total: "1", available: "0" } : null);
    else throw new Error(`unexpected RPC ${method}`);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }) as unknown as typeof fetch);
  return { state, rpc };
}

function requirements(over: Record<string, unknown> = {}) {
  return { scheme: "exact", network: "near:testnet", amount: PRICE.toString(), asset: USDC, payTo: SELLER, maxTimeoutSeconds: 60, ...over };
}

async function payload(key = newKey(), over: Partial<Parameters<typeof signFtTransferDelegate>[0]> = {}, accepted = requirements()) {
  const signedDelegateAction = await signFtTransferDelegate({
    secretKey: key.secret,
    senderId: key.account,
    asset: USDC,
    payTo: SELLER,
    amount: PRICE,
    nonce: 6n,
    maxBlockHeight: 1060n,
    ...over,
  });
  return { x402Version: 2, accepted, payload: { signedDelegateAction } };
}

function facilitator(c = chain(), relay: Relay = async () => ({ transaction: "relaytx", success: true })) {
  const relayed: unknown[] = [];
  const f = new Facilitator({
    network: "testnet",
    rpc: c.rpc,
    relayerId: "relayer.testnet",
    relay: async (signed) => {
      relayed.push(signed);
      return relay(signed);
    },
  });
  return { f, relayed };
}

describe("Facilitator.verify", () => {
  it("accepts a well-formed payment and names the payer", async () => {
    const key = newKey();
    const { f } = facilitator();
    expect(await f.verify(await payload(key), requirements())).toEqual({ isValid: true, payer: key.account });
  });

  it("refuses payments that do not match the seller's terms", async () => {
    const { f } = facilitator();
    const cases: [Promise<unknown>, unknown, string][] = [
      [payload(undefined, {}, requirements({ amount: "1" })), requirements(), "invalid_payment_requirements"],
      [payload(undefined, { amount: PRICE - 1n }), requirements(), "invalid_payload"],
      [payload(undefined, { payTo: "attacker.testnet" }), requirements(), "invalid_payload"],
      [payload(), requirements({ asset: "other.testnet" }), "invalid_payment_requirements"],
      [payload(), requirements({ network: "near:mainnet" }), "invalid_network"],
    ];
    for (const [p, r, reason] of cases) {
      expect(await f.verify(await p, r)).toMatchObject({ isValid: false, invalidReason: reason });
    }
  });

  it("refuses function-call keys, used nonces, and expired or over-long windows", async () => {
    expect(await facilitator(chain({ permission: { FunctionCall: {} } })).f.verify(await payload(), requirements())).toMatchObject({ isValid: false });
    expect(await facilitator(chain({ nonce: 6 })).f.verify(await payload(), requirements())).toMatchObject({ invalidReason: "delegate_action_nonce_already_used" });
    expect(await facilitator(chain({ height: 1060 })).f.verify(await payload(), requirements())).toMatchObject({ invalidReason: "delegate_action_expired" });
    expect(await facilitator().f.verify(await payload(undefined, { maxBlockHeight: 1100n }), requirements())).toMatchObject({
      invalidReason: "delegate_action_timeout_window_exceeds_maxTimeout",
    });
  });

  it("checks the payer's balance and the seller's registration", async () => {
    expect(await facilitator(chain({ balance: PRICE - 1n })).f.verify(await payload(), requirements())).toMatchObject({ invalidReason: "insufficient_funds" });
    expect(await facilitator(chain({ registered: false })).f.verify(await payload(), requirements())).toMatchObject({ isValid: false });
  });

  it("refuses a tampered signature", async () => {
    const p = await payload();
    const bytes = Buffer.from(p.payload.signedDelegateAction, "base64");
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
    p.payload.signedDelegateAction = bytes.toString("base64");
    expect(await facilitator().f.verify(p, requirements())).toMatchObject({ isValid: false, invalidReason: "invalid_payload" });
  });
});

describe("Facilitator.settle", () => {
  it("relays once and refuses the same payment again", async () => {
    const key = newKey();
    const { f, relayed } = facilitator();
    const p = await payload(key);
    expect(await f.settle(p, requirements())).toEqual({ success: true, transaction: "relaytx", network: "near:testnet", payer: key.account });
    expect(await f.settle(p, requirements())).toMatchObject({ success: false, errorReason: "duplicate_settlement" });
    expect(relayed).toHaveLength(1);
  });

  it("reports a failed transfer without naming a payer", async () => {
    const { f } = facilitator(chain(), async () => ({ transaction: "tx", success: false, error: "panicked" }));
    const result = await f.settle(await payload(), requirements());
    expect(result).toMatchObject({ success: false, errorReason: "settlement_failed", transaction: "tx" });
    expect(result.payer).toBeUndefined();
  });
});

describe("labels the buyer sends to the policy", () => {
  it("takes the website from the URL that asked for payment", () => {
    expect(siteOf("https://API.Example.com/report?x=1")).toBe("api.example.com");
    expect(siteOf("http://localhost:4021/report")).toBe("localhost:4021");
    expect(siteOf("https://[::1]:8080/")).toBeNull();
  });

  it("reads the seller's agent claim only when it is well formed", () => {
    expect(claimedAgent({ nearfirewall: { registry: "agents.bob.testnet", agentId: "7" } })).toEqual({ registry: "agents.bob.testnet", agent_id: "7" });
    expect(claimedAgent({ nearfirewall: { registry: "Bad Registry", agentId: "7" } })).toBeNull();
    expect(claimedAgent({ nearfirewall: { registry: "agents.bob.testnet", agentId: "7; drop" } })).toBeNull();
    expect(claimedAgent(undefined)).toBeNull();
  });
});

describe("buyer, seller, and facilitator over HTTP", () => {
  const servers: http.Server[] = [];
  afterEach(() => servers.splice(0).forEach((s) => s.close()));
  const listen = async (handler: http.RequestListener) => {
    const s = http.createServer(handler);
    servers.push(s);
    await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  };

  it("pays a seller agent end to end, with the facilitator's API key, and sends the labels to the policy", async () => {
    const key = newKey();
    const c = chain({ balance: 0n });
    const { f, relayed } = facilitator(c);
    const facilitatorUrl = await listen(createFacilitatorServer(f, { apiKey: "k".repeat(32) }));

    const charge = createPaywall({
      facilitatorUrl,
      apiKey: "k".repeat(32),
      network: "testnet",
      payTo: SELLER,
      price: PRICE,
      agent: { registry: "agents.bob.testnet", agentId: "7" },
    });
    const sellerUrl = await listen(async (req, res) => {
      const result = await charge(req, res);
      if (result.paid) res.end("the report");
    });

    const funded: unknown[] = [];
    const connection = {
      account: "alice.testnet",
      publicKey: key.publicKey,
      x402Account: key.account,
      policy: { getX402Config: async () => ({ asset: USDC, account_daily_cap: null }) },
      async fundX402(_asset: string, payTo: string, amount: bigint, requestId: string, labels: unknown) {
        funded.push({ payTo, amount, labels });
        c.state.balance += amount;
        return { operation: { requestId, state: "settled" }, outcome: { status: "settled", request_id: requestId }, message: "approved", txHash: "fund" };
      },
    } as unknown as AgentConnection;
    const buyer = new X402Buyer({ connection, secretKey: key.secret, network: "testnet", rpc: c.rpc, transport: plainTransport, sleep: async () => {} });

    const result = await buyer.fetch(`${sellerUrl}/report`);
    expect(result.status).toBe("paid");
    if (result.status === "paid") {
      expect(result.response.body).toBe("the report");
      expect(result.payment.settlement?.transaction).toBe("relaytx");
    }
    expect(relayed).toHaveLength(1);
    expect(funded).toEqual([
      {
        payTo: SELLER,
        amount: PRICE,
        labels: { site: new URL(sellerUrl).host, payeeAgent: { registry: "agents.bob.testnet", agent_id: "7" } },
      },
    ]);
  });

  it("requires the facilitator's API key when one is set", async () => {
    const { f } = facilitator();
    const url = await listen(createFacilitatorServer(f, { apiKey: "k".repeat(32) }));
    const post = (headers: Record<string, string>) =>
      fetch(`${url}/verify`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });
    expect((await post({})).status).toBe(401);
    expect((await post({ "x-api-key": "wrong" })).status).toBe(401);
    expect((await post({ "x-api-key": "k".repeat(32) })).status).toBe(200);
    expect(await (await fetch(`${url}/supported`)).json()).toMatchObject({ kinds: [{ x402Version: 2, scheme: "exact", network: "near:testnet" }] });
  });
});

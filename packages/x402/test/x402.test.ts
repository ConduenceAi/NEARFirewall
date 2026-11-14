import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { KeyPair, decodeSignedDelegate, encodeDelegateAction, type KeyPairString } from "near-api-js";
import { NearRpc, USDC_CONTRACT, parseUsdc, x402AccountFor, type AgentConnection, type Outcome } from "@nearfirewall/sdk";
import {
  HEADERS,
  PaymentPayload,
  PaymentRequired,
  SettlementResponse,
  X402Buyer,
  createPaywall,
  decodeHeader,
  encodeHeader,
  fromBase64,
  plainTransport,
  selectRequirement,
  signFtTransferDelegate,
  type HttpResponse,
  type Transport,
} from "../src/index.ts";

const USDC = USDC_CONTRACT.testnet;
const SELLER = "seller.testnet";
const PRICE = parseUsdc("0.05");

function newKey() {
  const pair = KeyPair.fromRandom("ed25519");
  const publicKey = pair.getPublicKey().toString();
  return { pair, secret: pair.toString() as KeyPairString, publicKey, account: x402AccountFor(publicKey) };
}

function requirement(over: Record<string, unknown> = {}) {
  return { scheme: "exact", network: "near:testnet", amount: PRICE.toString(), asset: USDC, payTo: SELLER, maxTimeoutSeconds: 60, ...over };
}

function challenge(accepts: unknown[] = [requirement()]) {
  return { x402Version: 2, resource: { url: "https://seller.example/report" }, accepts };
}

/** Function-call args decode as a plain byte array. */
const argsOf = (args: ArrayLike<number>) => JSON.parse(new TextDecoder().decode(Uint8Array.from(args)));

/** Decodes the delegate inside a PAYMENT-SIGNATURE header. */
function delegateOf(header: string) {
  const payload = decodeHeader(header, PaymentPayload);
  return { payload, signed: decodeSignedDelegate(fromBase64(payload.payload.signedDelegateAction)) };
}

/** A chain with one token balance for the payment account, a final block, and an access key nonce. */
function fakeChain() {
  const state = { balance: 0n, height: 1000, nonce: 5 };
  const rpc = new NearRpc("http://rpc.invalid", (async (_url: string, init: { body: string }) => {
    const { id, method, params } = JSON.parse(init.body);
    let result: unknown;
    if (method === "block") result = { header: { height: state.height } };
    else if (params.request_type === "view_access_key") result = { nonce: state.nonce, permission: "FullAccess" };
    else if (params.request_type === "call_function" && params.method_name === "ft_balance_of") {
      result = { result: Array.from(new TextEncoder().encode(JSON.stringify(state.balance.toString()))) };
    } else throw new Error(`unexpected RPC ${method} ${params.request_type}`);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }) as unknown as typeof fetch);
  return { state, rpc };
}

/** A stand-in for AgentConnection: x402 is on, and the policy funds or refuses as told. */
function fakeConnection(key: ReturnType<typeof newKey>, chain: ReturnType<typeof fakeChain>, outcome: Outcome = { status: "settled", request_id: "r" }) {
  const funded: { asset: string; payTo: string; amount: bigint }[] = [];
  const connection = {
    account: "alice.testnet",
    publicKey: key.publicKey,
    x402Account: key.account,
    policy: { getX402Config: async () => ({ asset: USDC, account_daily_cap: null }) },
    async fundX402(asset: string, payTo: string, amount: bigint, requestId: string) {
      funded.push({ asset, payTo, amount });
      if (outcome.status === "settled") chain.state.balance += amount;
      return {
        operation: { requestId, state: outcome.status } as never,
        outcome,
        txHash: "fundtx",
        message: outcome.status === "settled" ? "approved" : `Blocked (${"reason" in outcome ? outcome.reason : outcome.status})`,
      };
    },
  };
  return { connection: connection as unknown as AgentConnection, funded };
}

/** A seller that wants `accepts`, and answers a payment with `settle`. */
function fakeSeller(accepts: unknown[] = [requirement()], settle = { success: true, transaction: "settletx", network: "near:testnet", payer: "x" }) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const transport: Transport = async (request) => {
    calls.push(request);
    const response = (status: number, headers: Record<string, string>, body: string): HttpResponse => ({ status, url: request.url, headers, body });
    if (!request.headers["PAYMENT-SIGNATURE"]) return response(402, { [HEADERS.required]: encodeHeader(challenge(accepts)) }, "{}");
    return settle.success
      ? response(200, { [HEADERS.response]: encodeHeader(settle) }, "the report")
      : response(402, { [HEADERS.response]: encodeHeader(settle), [HEADERS.required]: encodeHeader(challenge(accepts)) }, "{}");
  };
  return { transport, calls };
}

function buyer(key: ReturnType<typeof newKey>, chain: ReturnType<typeof fakeChain>, connection: AgentConnection, extra: Partial<ConstructorParameters<typeof X402Buyer>[0]> = {}) {
  return new X402Buyer({ connection, secretKey: key.secret, network: "testnet", rpc: chain.rpc, sleep: async () => {}, ...extra });
}

describe("x402 wire format", () => {
  it("round-trips headers, including URL-safe base64", () => {
    const value = challenge();
    const header = encodeHeader(value);
    expect(decodeHeader(header, PaymentRequired)).toEqual(value);
    const urlSafe = header.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(decodeHeader(urlSafe, PaymentRequired)).toEqual(value);
    expect(() => decodeHeader("not json!", PaymentRequired)).toThrow();
  });

  it("picks the USDC-on-NEAR option and keeps it exactly as sent", () => {
    const evm = { scheme: "exact", network: "eip155:8453", amount: "50000", asset: "0xabc", payTo: "0xdef", maxTimeoutSeconds: 60 };
    const ours = requirement({ extra: { note: "kept" } });
    const required = decodeHeader(encodeHeader(challenge([evm, "garbage", ours])), PaymentRequired);
    const choice = selectRequirement(required, { network: "near:testnet", asset: USDC });
    expect(choice?.raw).toEqual(ours);
    expect(selectRequirement(required, { network: "near:mainnet", asset: USDC })).toBeNull();
  });
});

describe("the seller's transfer", () => {
  it("is one ft_transfer of the exact amount with 1 yoctoNEAR, signed by the payment account's key", async () => {
    const key = newKey();
    const encoded = await signFtTransferDelegate({
      secretKey: key.secret,
      senderId: key.account,
      asset: USDC,
      payTo: SELLER,
      amount: PRICE,
      nonce: 6n,
      maxBlockHeight: 1060n,
    });
    const signed = decodeSignedDelegate(fromBase64(encoded));
    const delegate = signed.delegateAction;
    expect(delegate.senderId).toBe(key.account);
    expect(delegate.receiverId).toBe(USDC);
    expect(delegate.nonce).toBe(6n);
    expect(delegate.maxBlockHeight).toBe(1060n);
    expect(delegate.publicKey.toString()).toBe(key.publicKey);
    expect(delegate.actions).toHaveLength(1);
    const call = delegate.actions[0]!.functionCall!;
    expect(call.methodName).toBe("ft_transfer");
    expect(call.deposit).toBe(1n);
    expect(argsOf(call.args)).toEqual({ receiver_id: SELLER, amount: PRICE.toString() });
    const hash = createHash("sha256").update(encodeDelegateAction(delegate)).digest();
    expect(key.pair.verify(new Uint8Array(hash), signed.signature.data)).toBe(true);
  });
});

describe("X402Buyer", () => {
  it("pays a 402 only after the owner's policy funds it, then retries with the signed transfer", async () => {
    const key = newKey();
    const chain = fakeChain();
    const { connection, funded } = fakeConnection(key, chain);
    const seller = fakeSeller();
    const result = await buyer(key, chain, connection, { transport: seller.transport }).fetch("https://seller.example/report");

    expect(result.status).toBe("paid");
    expect(funded).toEqual([{ asset: USDC, payTo: SELLER, amount: PRICE }]);
    expect(seller.calls).toHaveLength(2);
    const { payload, signed } = delegateOf(seller.calls[1]!.headers["PAYMENT-SIGNATURE"]!);
    expect(payload.accepted).toEqual(requirement());
    expect(payload.resource?.url).toBe("https://seller.example/report");
    expect(signed.delegateAction.senderId).toBe(key.account);
    expect(signed.delegateAction.nonce).toBe(6n);
    expect(signed.delegateAction.maxBlockHeight).toBe(1060n);
    if (result.status === "paid") {
      expect(result.response.body).toBe("the report");
      expect(result.payment.settlement?.transaction).toBe("settletx");
      expect(result.payment.fundingTx).toBe("fundtx");
    }
  });

  it("returns free resources without paying", async () => {
    const key = newKey();
    const chain = fakeChain();
    const { connection, funded } = fakeConnection(key, chain);
    const transport: Transport = async ({ url }) => ({ status: 200, url, headers: {}, body: "free" });
    const result = await buyer(key, chain, connection, { transport }).fetch("https://example.com/");
    expect(result.status).toBe("free");
    expect(funded).toHaveLength(0);
  });

  it("refuses sellers that do not take USDC on NEAR, without asking the policy", async () => {
    const key = newKey();
    const chain = fakeChain();
    const { connection, funded } = fakeConnection(key, chain);
    const seller = fakeSeller([requirement({ asset: "other-token.testnet" }), requirement({ network: "near:mainnet" })]);
    const result = await buyer(key, chain, connection, { transport: seller.transport }).fetch("https://seller.example/");
    expect(result.status).toBe("refused");
    if (result.status === "refused") expect(result.reason).toContain("does not accept USDC on near:testnet");
    expect(funded).toHaveLength(0);
  });

  it("applies the per-request and local ceilings before asking the policy", async () => {
    const key = newKey();
    const chain = fakeChain();
    const { connection, funded } = fakeConnection(key, chain);
    const seller = fakeSeller();
    const perRequest = await buyer(key, chain, connection, { transport: seller.transport }).fetch("https://seller.example/", {
      maxAmount: parseUsdc("0.01"),
    });
    expect(perRequest.status).toBe("refused");
    const local = await buyer(key, chain, connection, { transport: seller.transport, maxPayment: parseUsdc("0.04") }).fetch("https://seller.example/");
    expect(local.status).toBe("refused");
    if (local.status === "refused") expect(local.reason).toContain("ceiling of 0.04 USDC");
    expect(funded).toHaveLength(0);
  });

  it("never signs for the seller when the policy refuses", async () => {
    const key = newKey();
    const chain = fakeChain();
    const { connection } = fakeConnection(key, chain, { status: "denied", reason: "UNLISTED_DAILY_CAP" });
    const seller = fakeSeller();
    const result = await buyer(key, chain, connection, { transport: seller.transport }).fetch("https://seller.example/");
    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.reason).toContain("UNLISTED_DAILY_CAP");
      expect(result.payment).toBeUndefined();
    }
    expect(seller.calls).toHaveLength(1);
  });

  it("reports funded USDC left in the payment account when the seller rejects the payment", async () => {
    const key = newKey();
    const chain = fakeChain();
    const { connection } = fakeConnection(key, chain);
    const seller = fakeSeller(undefined, { success: false, transaction: "", network: "near:testnet", errorReason: "delegate_action_expired" } as never);
    const result = await buyer(key, chain, connection, { transport: seller.transport }).fetch("https://seller.example/");
    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.reason).toContain("delegate_action_expired");
      expect(result.payment?.amount).toBe(PRICE);
    }
    expect(chain.state.balance).toBe(PRICE);
  });

  it("does not sign until the funding shows at final finality", async () => {
    const key = newKey();
    const chain = fakeChain();
    const { connection } = fakeConnection(key, chain);
    // The policy says settled, but the balance never arrives.
    (connection as unknown as { fundX402: unknown }).fundX402 = async (_a: string, _p: string, _amount: bigint, requestId: string) => ({
      operation: { requestId, state: "settled" },
      outcome: { status: "settled", request_id: requestId },
      message: "approved",
    });
    const seller = fakeSeller();
    const result = await buyer(key, chain, connection, { transport: seller.transport, fundingTimeoutMs: 0 }).fetch("https://seller.example/");
    expect(result.status).toBe("refused");
    expect(seller.calls).toHaveLength(1);
  });

  it("runs one payment at a time so nonces never collide", async () => {
    const key = newKey();
    const chain = fakeChain();
    const { connection } = fakeConnection(key, chain);
    const order: string[] = [];
    const seller = fakeSeller();
    const transport: Transport = async (request) => {
      order.push(`${request.url}:${request.headers["PAYMENT-SIGNATURE"] ? "pay" : "ask"}`);
      await new Promise((r) => setTimeout(r, 5));
      return seller.transport(request);
    };
    const b = buyer(key, chain, connection, { transport });
    await Promise.all([b.fetch("https://seller.example/a"), b.fetch("https://seller.example/b")]);
    expect(order).toEqual(["https://seller.example/a:ask", "https://seller.example/a:pay", "https://seller.example/b:ask", "https://seller.example/b:pay"]);
  });
});

describe("createPaywall", () => {
  let server: http.Server | undefined;
  afterEach(() => server?.close());

  async function start(facilitator: (path: string, body: any, headers: Headers) => unknown) {
    const seen: { path: string; body: any; apiKey: string | null }[] = [];
    const fetchImpl = (async (url: string, init: { body: string; headers: Record<string, string> }) => {
      const path = new URL(url).pathname;
      const body = JSON.parse(init.body);
      const headers = new Headers(init.headers);
      seen.push({ path, body, apiKey: headers.get("x-api-key") });
      return new Response(JSON.stringify(facilitator(path, body, headers)));
    }) as unknown as typeof fetch;
    const charge = createPaywall({
      facilitatorUrl: "https://facilitator.invalid/",
      apiKey: "secret-key",
      network: "testnet",
      payTo: SELLER,
      price: PRICE,
      description: "A report",
      agent: { registry: "agents.seller.testnet", agentId: "3" },
      fetchImpl,
    });
    server = http.createServer(async (req, res) => {
      const result = await charge(req, res);
      if (result.paid) res.end(`paid by ${result.payer ?? "?"}`);
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/report`;
    return { url, seen };
  }

  const okFacilitator = (path: string) =>
    path === "/verify" ? { isValid: true, payer: "buyer.testnet" } : { success: true, transaction: "tx9", network: "near:testnet", payer: "buyer.testnet" };

  it("answers 402 with the seller's terms", async () => {
    const { url } = await start(okFacilitator);
    const response = await fetch(url);
    expect(response.status).toBe(402);
    const required = decodeHeader(response.headers.get(HEADERS.required)!, PaymentRequired);
    expect(required.resource).toEqual({ url, description: "A report" });
    expect(required.accepts).toEqual([
      { ...requirement(), extra: { nearfirewall: { registry: "agents.seller.testnet", agentId: "3" } } },
    ]);
  });

  it("refuses payloads for other terms without calling the facilitator", async () => {
    const { url, seen } = await start(okFacilitator);
    const payload = { x402Version: 2, accepted: requirement({ amount: "1" }), payload: { signedDelegateAction: "AAAA" } };
    const response = await fetch(url, { headers: { "PAYMENT-SIGNATURE": encodeHeader(payload) } });
    expect(response.status).toBe(402);
    expect(decodeHeader(response.headers.get(HEADERS.required)!, PaymentRequired).error).toBe("invalid_payment_requirements");
    expect(seen).toHaveLength(0);
  });

  it("serves the resource only after the facilitator verifies and settles", async () => {
    const { url, seen } = await start(okFacilitator);
    const accepted = { ...requirement(), extra: { nearfirewall: { registry: "agents.seller.testnet", agentId: "3" } } };
    const payload = { x402Version: 2, accepted, payload: { signedDelegateAction: "AAAA" } };
    const response = await fetch(url, { headers: { "PAYMENT-SIGNATURE": encodeHeader(payload) } });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("paid by buyer.testnet");
    expect(decodeHeader(response.headers.get(HEADERS.response)!, SettlementResponse).transaction).toBe("tx9");
    expect(seen.map((s) => s.path)).toEqual(["/verify", "/settle"]);
    expect(seen[0]!.apiKey).toBe("secret-key");
    expect(seen[0]!.body).toEqual({ x402Version: 2, paymentPayload: payload, paymentRequirements: accepted });
  });

  it("answers 402 with the facilitator's reason when verification fails", async () => {
    const { url, seen } = await start((path) => (path === "/verify" ? { isValid: false, invalidReason: "insufficient_funds" } : {}));
    const accepted = { ...requirement(), extra: { nearfirewall: { registry: "agents.seller.testnet", agentId: "3" } } };
    const payload = { x402Version: 2, accepted, payload: { signedDelegateAction: "AAAA" } };
    const response = await fetch(url, { headers: { "PAYMENT-SIGNATURE": encodeHeader(payload) } });
    expect(response.status).toBe(402);
    expect(decodeHeader(response.headers.get(HEADERS.required)!, PaymentRequired).error).toBe("insufficient_funds");
    expect(seen.map((s) => s.path)).toEqual(["/verify"]);
  });

  it("works end to end with the buyer: the facilitator receives the funded transfer", async () => {
    const key = newKey();
    const chain = fakeChain();
    const { connection, funded } = fakeConnection(key, chain);
    let relayed: ReturnType<typeof decodeSignedDelegate> | undefined;
    const { url } = await start((path, body) => {
      relayed = decodeSignedDelegate(fromBase64(body.paymentPayload.payload.signedDelegateAction));
      return okFacilitator(path);
    });
    const result = await buyer(key, chain, connection, { transport: plainTransport }).fetch(url);
    expect(result.status).toBe("paid");
    expect(funded).toEqual([{ asset: USDC, payTo: SELLER, amount: PRICE }]);
    expect(relayed?.delegateAction.senderId).toBe(key.account);
    expect(argsOf(relayed!.delegateAction.actions[0]!.functionCall!.args)).toEqual({ receiver_id: SELLER, amount: PRICE.toString() });
  });
});

import http from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { parseNear, type AgentConnection } from "@nearfirewall/sdk";
import { createGateway, type GatewayOptions } from "../src/gateway.ts";
import { serialSubmit } from "../src/serial.ts";

const TOKEN = "t".repeat(40);

interface Fake extends AgentConnection {
  paid: { recipient: string; amount: bigint; requestId?: string }[];
  clients: (string | null)[];
}

function fakeConnection(clients: (string | null)[] = []): Fake {
  const paid: Fake["paid"] = [];
  const connection = {
    paid,
    clients,
    account: "alice.testnet",
    client: null as string | null,
    async connection() {
      return { public_key: "ed25519:x", agent_id: "1", platform: "n8n", label: "Workflow", created_at: 1n, last_used: null, uses: 0 };
    },
    async registry() {
      return { getAgent: async () => ({ agent_id: "1", handle: "trader" }) };
    },
    async rules() {
      return {
        account: "alice.testnet",
        agentId: "1",
        handle: "trader",
        connection: await connection.connection(),
        paused: false,
        agentStatus: "active",
        maxPerPayment: parseNear("5"),
        recipients: [{ recipient: "vendor.testnet", perPayment: parseNear("3"), daily: parseNear("6"), usedToday: 0n, confirmAbove: null }],
        budgets: [{ agentId: "1", handle: "trader", daily: parseNear("10"), usedToday: 0n }],
        availableBalance: parseNear("20"),
        blocked: ["scam.testnet"],
      };
    },
    async accessRules() {
      return { allowed: [], blocked: [] };
    },
    async preview(recipient: string) {
      return recipient === "attacker.testnet"
        ? { allowed: false, reason: "RECIPIENT_NOT_APPROVED", mandates: [], needs_confirmation: false }
        : { allowed: true, reason: null, mandates: ["1"], needs_confirmation: false };
    },
    async pay(recipient: string, amount: bigint, requestId?: string) {
      paid.push({ recipient, amount, requestId });
      const denied = recipient === "attacker.testnet";
      return {
        operation: { requestId: requestId ?? "a".repeat(64), state: denied ? "denied" : "settled", reason: denied ? "RECIPIENT_NOT_APPROVED" : undefined },
        outcome: denied ? { status: "denied", reason: "RECIPIENT_NOT_APPROVED", detail: null } : { status: "settled", request_id: "x" },
        message: denied ? "Blocked (RECIPIENT_NOT_APPROVED): not approved." : `Paid ${amount} to ${recipient}.`,
        txHash: "tx1",
      };
    },
    async activity() {
      return [{ at: 1_700_000_000_000_000_000n, recipient: "vendor.testnet", amount: parseNear("2"), outcome: "settled", reason: null }];
    },
  };
  return connection as unknown as Fake;
}

const servers: http.Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
});

async function start(overrides: Partial<GatewayOptions> = {}) {
  const clients: (string | null)[] = [];
  const connection = fakeConnection(clients);
  const events: { route: string; status: number }[] = [];
  const server = http.createServer(
    createGateway({
      token: TOKEN,
      connection: (client) => {
        clients.push(client);
        return connection;
      },
      log: (e) => events.push(e),
      ...overrides,
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, connection, events, clients };
}

const auth = { authorization: `Bearer ${TOKEN}` };
const post = (url: string, body: unknown, headers: Record<string, string> = auth) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("gateway: authentication", () => {
  it("answers health without a token and reveals nothing", async () => {
    const { base } = await start();
    const r = await fetch(`${base}/health`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });

  it("refuses requests without the right token", async () => {
    const { base } = await start();
    expect((await fetch(`${base}/api/rules`)).status).toBe(401);
    expect((await fetch(`${base}/api/rules`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await fetch(`${base}/api/rules`, { headers: { authorization: `Bearer ${TOKEN}x` } })).status).toBe(401);
    expect((await fetch(`${base}/mcp/wrong-token`, { method: "POST" })).status).toBe(401);
    // A token in the URL is not accepted for the REST API, where headers are available.
    // Callers without a valid token learn nothing about which routes exist.
    expect((await fetch(`${base}/api/${TOKEN}/rules`)).status).toBe(401);
    expect((await fetch(`${base}/api/no-such-route`)).status).toBe(401);
    expect((await fetch(`${base}/api/no-such-route`, { headers: auth })).status).toBe(404);
  });

  it("refuses to start with a weak token", () => {
    expect(() => createGateway({ token: "short", connection: () => fakeConnection() })).toThrow(/32 characters/);
  });

  it("blocks an address after repeated failed attempts, even with the right token", async () => {
    const { base } = await start({ limits: { failuresPerMinute: 3 } });
    for (let i = 0; i < 4; i++) await fetch(`${base}/api/rules`, { headers: { authorization: "Bearer nope" } });
    expect((await fetch(`${base}/api/rules`, { headers: auth })).status).toBe(429);
  });
});

describe("gateway: REST API", () => {
  it("reports status and rules as JSON", async () => {
    const { base } = await start();
    const status = await (await fetch(`${base}/api/status`, { headers: auth })).json();
    expect(status).toMatchObject({ ok: true, account: "alice.testnet", agent: "trader", connection: { label: "Workflow", platform: "n8n" } });
    const rules = await (await fetch(`${base}/api/rules`, { headers: auth })).json();
    expect(rules).toMatchObject({
      agent: "trader",
      max_per_payment_near: "5",
      recipients: [{ recipient: "vendor.testnet", per_payment_near: "3", daily_near: "6" }],
      blocked_recipients: ["scam.testnet"],
    });
  });

  it("previews and pays, reporting blocks as data rather than errors", async () => {
    const { base, connection } = await start();
    const preview = await (await post(`${base}/api/preview`, { recipient: "attacker.testnet", amount_near: "1" })).json();
    expect(preview).toMatchObject({ allowed: false, reason: "RECIPIENT_NOT_APPROVED" });
    const paid = await (await post(`${base}/api/pay`, { recipient: "vendor.testnet", amount_near: "2" })).json();
    expect(paid).toMatchObject({ ok: true, state: "settled", tx_hash: "tx1" });
    const blocked = await (await post(`${base}/api/pay`, { recipient: "attacker.testnet", amount_near: "1" })).json();
    expect(blocked).toMatchObject({ ok: false, state: "denied", reason: "RECIPIENT_NOT_APPROVED" });
    expect(connection.paid.map((p) => p.recipient)).toEqual(["vendor.testnet", "attacker.testnet"]);
  });

  it("validates input and refuses unknown fields", async () => {
    const { base, connection } = await start();
    for (const body of [{ recipient: "vendor.testnet", amount_near: "lots" }, { recipient: "Bad Name", amount_near: "1" }, { recipient: "v.testnet", amount_near: "1", extra: true }, {}]) {
      expect((await post(`${base}/api/pay`, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await fetch(`${base}/api/pay`, { method: "POST", headers: { ...auth, "content-type": "text/plain" }, body: "x" })).status).toBe(415);
    expect((await fetch(`${base}/api/pay`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{bad" })).status).toBe(400);
    expect(connection.paid).toHaveLength(0);
  });

  it("enforces its own payment ceiling before asking the chain", async () => {
    const { base, connection } = await start({ maxPayment: parseNear("1") });
    expect((await post(`${base}/api/pay`, { recipient: "vendor.testnet", amount_near: "2" })).status).toBe(403);
    expect(connection.paid).toHaveLength(0);
  });

  it("limits payments per minute", async () => {
    const { base } = await start({ limits: { payPerMinute: 2 } });
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) statuses.push((await post(`${base}/api/pay`, { recipient: "vendor.testnet", amount_near: "1" })).status);
    expect(statuses).toEqual([200, 200, 429]);
  });

  it("limits requests per minute and request size", async () => {
    const { base } = await start({ limits: { perMinute: 3 }, maxBodyBytes: 200 });
    const big = await post(`${base}/api/pay`, { recipient: "vendor.testnet", amount_near: "1", pad: "x".repeat(500) });
    expect(big.status).toBe(413);
    // The oversized request above was the first of three allowed requests this minute.
    expect((await fetch(`${base}/api/rules`, { headers: auth })).status).toBe(200);
    expect((await fetch(`${base}/api/rules`, { headers: auth })).status).toBe(200);
    expect((await fetch(`${base}/api/rules`, { headers: auth })).status).toBe(429);
  });

  it("lists recent activity", async () => {
    const { base } = await start();
    const entries = await (await fetch(`${base}/api/activity?limit=5`, { headers: auth })).json();
    expect(entries[0]).toMatchObject({ recipient: "vendor.testnet", amount_near: "2", outcome: "settled" });
  });

  it("sends security headers and never caches", async () => {
    const { base } = await start();
    const r = await fetch(`${base}/api/rules`, { headers: auth });
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("gateway: browsers", () => {
  it("allows only configured origins", async () => {
    const { base } = await start({ allowedOrigins: ["https://app.example"] });
    const ok = await fetch(`${base}/api/status`, { headers: { ...auth, origin: "https://app.example" } });
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://app.example");
    const other = await fetch(`${base}/api/status`, { headers: { ...auth, origin: "https://evil.example" } });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
    const preflight = await fetch(`${base}/api/pay`, { method: "OPTIONS", headers: { origin: "https://app.example" } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-headers")).toContain("authorization");
  });
});

describe("gateway: remote MCP", () => {
  async function mcpClient(url: string, headers?: Record<string, string>) {
    const client = new Client({ name: "ChatGPT", version: "1.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), headers ? { requestInit: { headers } } : undefined));
    return client;
  }
  const text = (r: any) => r.content.map((c: any) => c.text).join("\n");

  it("serves the agent tools with the token in the URL", async () => {
    const { base, connection } = await start();
    const client = await mcpClient(`${base}/mcp/${TOKEN}`);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["check_payment", "fetch_url", "get_rules", "list_activity", "pay", "preview_payment"]);
    expect(text(await client.callTool({ name: "get_rules", arguments: {} }))).toContain("Agent trader");
    const paid = await client.callTool({ name: "pay", arguments: { recipient: "vendor.testnet", amount_near: "2" } });
    expect(paid.isError).toBeFalsy();
    const blocked = await client.callTool({ name: "pay", arguments: { recipient: "attacker.testnet", amount_near: "1" } });
    expect(blocked.isError).toBe(true);
    expect(connection.paid.map((p) => p.recipient)).toEqual(["vendor.testnet", "attacker.testnet"]);
    await client.close();
  });

  it("serves the same tools with a Bearer header", async () => {
    const { base } = await start();
    const client = await mcpClient(`${base}/mcp`, auth);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    await client.close();
  });

  it("refuses a wrong token and non-POST methods", async () => {
    const { base } = await start();
    await expect(mcpClient(`${base}/mcp/${"x".repeat(40)}`)).rejects.toThrow();
    const get = await fetch(`${base}/mcp/${TOKEN}`);
    expect(get.status).toBe(405);
    expect((await fetch(`${base}/mcp/${TOKEN}/extra`, { method: "POST", body: "{}" })).status).toBe(401);
  });

  it("records which client called, per request", async () => {
    const { base, clients } = await start();
    await (await mcpClient(`${base}/mcp/${TOKEN}`)).listTools();
    expect(clients.some((c) => c?.startsWith("gateway:"))).toBe(true);
  });
});

describe("gateway: logging", () => {
  it("logs only route names and statuses, never tokens or URLs", async () => {
    const { base, events } = await start();
    await fetch(`${base}/mcp/${TOKEN}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => undefined);
    await fetch(`${base}/api/rules`, { headers: auth });
    await fetch(`${base}/api/rules`, { headers: { authorization: "Bearer wrong-secret-value" } });
    expect(events.length).toBeGreaterThan(0);
    const logged = JSON.stringify(events);
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain("wrong-secret-value");
    for (const e of events) expect(Object.keys(e).sort()).toEqual(["ms", "route", "status"]);
  });
});

describe("serialSubmit", () => {
  it("runs submissions one at a time, in order, even when one fails", async () => {
    const order: string[] = [];
    let running = 0;
    let maxRunning = 0;
    const submit = serialSubmit(async (args) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      order.push(`start ${args.request_id}`);
      await new Promise((r) => setTimeout(r, 15));
      order.push(`end ${args.request_id}`);
      running--;
      if (args.request_id === "b") throw new Error("boom");
      return { status: {} };
    });
    const results = await Promise.allSettled(["a", "b", "c"].map((id) => submit({ action: {}, request_id: id, client: null }, 1n)));
    expect(maxRunning).toBe(1);
    expect(order).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
  });
});

describe("gateway: x402", () => {
  /** A buyer that fetches through the transport it is given and reports a payment. */
  function fakeBuyer(fetched: { url: string; maxAmount: bigint | null | undefined }[]) {
    return () =>
      ({
        async fetch(url: string, opts: { maxAmount?: bigint | null }) {
          fetched.push({ url, maxAmount: opts.maxAmount });
          return {
            status: "paid",
            response: { status: 200, url, headers: {}, body: "the report" },
            payment: {
              resource: url,
              payTo: "seller.testnet",
              amount: 50_000n,
              asset: "usdc.testnet",
              requestId: "c".repeat(64),
              fundingTx: "fund1",
              settlement: { success: true, transaction: "settle1", network: "near:testnet" },
            },
          };
        },
      }) as never;
  }

  it("is off unless the gateway is given a buyer", async () => {
    const { base } = await start();
    const r = await post(`${base}/api/x402/fetch`, { url: "https://seller.example/report" });
    expect(r.status).toBe(404);
  });

  it("fetches and pays through the owner's policy, and reports the payment as JSON", async () => {
    const fetched: { url: string; maxAmount: bigint | null | undefined }[] = [];
    const { base } = await start({ x402: fakeBuyer(fetched) });
    const r = await post(`${base}/api/x402/fetch`, { url: "https://seller.example/report", max_usdc: "0.05" });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({
      status: "paid",
      http_status: 200,
      content: "the report",
      payment: { pay_to: "seller.testnet", amount_usdc: "0.05", funding_tx: "fund1", settlement_tx: "settle1" },
    });
    expect(fetched).toEqual([{ url: "https://seller.example/report", maxAmount: 50_000n }]);
  });

  it("validates the request body", async () => {
    const { base } = await start({ x402: fakeBuyer([]) });
    expect((await post(`${base}/api/x402/fetch`, { url: "not a url" })).status).toBe(400);
    expect((await post(`${base}/api/x402/fetch`, { url: "https://a.example/", max_usdc: "lots" })).status).toBe(400);
    expect((await post(`${base}/api/x402/fetch`, { url: "https://a.example/", extra: 1 })).status).toBe(400);
  });

  it("labels x402 activity in USDC", async () => {
    const { base, connection } = await start();
    (connection as any).activity = async () => [
      { at: 1_700_000_000_000_000_000n, recipient: "seller.testnet", amount: 50_000n, outcome: "settled", reason: null, via: { kind: "x402", public_key: "ed25519:x", label: "w", payment_account: "ab".repeat(32) } },
    ];
    const entries = await (await fetch(`${base}/api/activity`, { headers: auth })).json();
    expect(entries[0]).toMatchObject({ recipient: "seller.testnet", amount_usdc: "0.05", via: "x402" });
  });
});

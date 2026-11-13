/**
 * NEARFirewall gateway.
 *
 * Cloud platforms (Claude on the web, ChatGPT, n8n, Gumloop, and any tool that
 * can send an HTTP request) cannot start a program on your computer. The gateway
 * is a small service you host yourself. It holds ONE agent connection key, the
 * restricted key that can only ask the owner's policy to pay, and exposes the same
 * tools two ways:
 *
 *   /mcp/<token>   remote MCP over streamable HTTP (token in the URL, for connector
 *                  forms that have no secret field), or /mcp with a Bearer header
 *   /api/...       plain JSON over HTTP with a Bearer header: status, rules, preview,
 *                  pay, activity
 *
 * The rules themselves are enforced on-chain by the owner's account, not here. The
 * gateway adds: a token that keeps strangers away from your agent, rate limits,
 * request size limits, and one-at-a-time signing for the key.
 *
 * Serve it over HTTPS (your host or a reverse proxy terminates TLS): the token
 * travels with every request. Nothing in a URL, header, or body is ever logged.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, type ServerOptions } from "@nearfirewall/mcp";
import { describeReason, formatNear, parseNear, type AgentConnection } from "@nearfirewall/sdk";
import { z } from "zod";

export interface GatewayLimits {
  /** Requests per minute from one address. */
  perMinute: number;
  /** Failed authentications per minute from one address before it is refused outright. */
  failuresPerMinute: number;
  /** Payments per minute across all callers. */
  payPerMinute: number;
}

export interface GatewayOptions {
  /** The secret that callers present. At least 32 characters. */
  token: string;
  /** Builds the agent connection for one request, so a caller's client name never leaks into another's. */
  connection(client: string | null): AgentConnection;
  maxPayment?: bigint | null;
  /** Browser origins allowed to call the API, for example the NEARFirewall app. None by default. */
  allowedOrigins?: string[];
  limits?: Partial<GatewayLimits>;
  maxBodyBytes?: number;
  /** Take the caller's address from X-Forwarded-For. Only behind a proxy you control. */
  trustProxy?: boolean;
  /** Receives one event per request: the route name and status only. */
  log?: (event: { route: string; status: number; ms: number }) => void;
  now?: () => number;
  mcp?: ServerOptions;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const digest = (value: string) => createHash("sha256").update(value).digest();

/** Counts events per key in a one-minute window. */
class Window {
  private readonly counts = new Map<string, { start: number; n: number }>();
  private readonly limit: number;
  private readonly now: () => number;
  constructor(limit: number, now: () => number) {
    this.limit = limit;
    this.now = now;
  }
  /** Records an event and returns whether it is still within the limit. */
  hit(key: string): boolean {
    const t = this.now();
    if (this.counts.size > 10_000) for (const [k, v] of this.counts) if (t - v.start >= 60_000) this.counts.delete(k);
    const entry = this.counts.get(key);
    if (!entry || t - entry.start >= 60_000) {
      this.counts.set(key, { start: t, n: 1 });
      return 1 <= this.limit;
    }
    entry.n += 1;
    return entry.n <= this.limit;
  }
  exceeded(key: string): boolean {
    const entry = this.counts.get(key);
    return !!entry && this.now() - entry.start < 60_000 && entry.n > this.limit;
  }
}

const Recipient = z.string().min(2).max(64).regex(/^[a-z0-9._-]+$/, "a NEAR account ID");
const Amount = z.string().regex(/^\d+(\.\d{1,24})?$/, "an amount in NEAR, such as 2 or 0.5");
const RequestId = z.string().regex(/^[0-9a-f]{64}$/, "64 lowercase hex characters");
const PaymentBody = z.object({ recipient: Recipient, amount_near: Amount, request_id: RequestId.optional() }).strict();

function setCommonHeaders(res: ServerResponse) {
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  // The token can be part of the URL, so never let it leak through a Referer header.
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("content-security-policy", "default-src 'none'");
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > max) throw new HttpError(413, "The request body is too large.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw new HttpError(413, "The request body is too large.");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage, max: number): Promise<unknown> {
  const body = await readBody(req, max);
  if (body.length === 0) return {};
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new HttpError(400, "The body is not valid JSON.");
  }
}

export function createGateway(options: GatewayOptions): RequestListener {
  if (options.token.length < 32) throw new Error("The gateway token must be at least 32 characters. Generate one with: openssl rand -hex 32");
  const tokenDigest = digest(options.token);
  const now = options.now ?? Date.now;
  const limits: GatewayLimits = { perMinute: 120, failuresPerMinute: 10, payPerMinute: 30, ...options.limits };
  const requests = new Window(limits.perMinute, now);
  const failures = new Window(limits.failuresPerMinute, now);
  const payments = new Window(limits.payPerMinute, now);
  const maxBody = options.maxBodyBytes ?? 64 * 1024;
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const log = options.log ?? ((e) => console.error(JSON.stringify(e)));

  const isAuthorized = (candidate: string | null | undefined) =>
    !!candidate && timingSafeEqual(digest(candidate), tokenDigest);

  function bearer(req: IncomingMessage): string | null {
    const header = req.headers.authorization;
    const match = typeof header === "string" ? /^Bearer\s+(\S+)$/i.exec(header) : null;
    return match ? match[1]! : null;
  }

  function clientName(req: IncomingMessage): string | null {
    const named = req.headers["x-nearfirewall-client"];
    const ua = req.headers["user-agent"];
    const raw = (typeof named === "string" ? named : typeof ua === "string" ? ua : "").replace(/[^\x20-\x7e]/g, "").trim().slice(0, 40);
    return raw ? `gateway: ${raw}` : "gateway";
  }

  async function api(req: IncomingMessage, res: ServerResponse, route: string): Promise<string> {
    const connection = options.connection(clientName(req));
    const method = req.method ?? "GET";
    switch (`${method} ${route}`) {
      case "GET status": {
        const c = await connection.connection();
        const registry = await connection.registry();
        const agent = await registry.getAgent(c.agent_id);
        sendJson(res, 200, {
          ok: true,
          account: connection.account,
          agent_id: c.agent_id,
          agent: agent?.handle ?? null,
          connection: { label: c.label, platform: c.platform },
        });
        return "api.status";
      }
      case "GET rules": {
        const r = await connection.rules();
        sendJson(res, 200, {
          account: r.account,
          agent: r.handle,
          paused: r.paused,
          max_per_payment_near: r.maxPerPayment === null ? null : formatNear(r.maxPerPayment),
          recipients: r.recipients.map((p) => ({
            recipient: p.recipient,
            per_payment_near: formatNear(p.perPayment),
            daily_near: formatNear(p.daily),
            used_today_near: formatNear(p.usedToday),
            confirm_above_near: p.confirmAbove === null ? null : formatNear(p.confirmAbove),
          })),
          blocked_recipients: r.blocked,
          budgets: r.budgets.map((b) => ({ agent: b.handle, daily_near: formatNear(b.daily), used_today_near: formatNear(b.usedToday) })),
          available_balance_near: formatNear(r.availableBalance),
        });
        return "api.rules";
      }
      case "POST preview": {
        const body = PaymentBody.omit({ request_id: true }).parse(await readJson(req, maxBody));
        const p = await connection.preview(body.recipient, parseNear(body.amount_near));
        sendJson(res, 200, {
          allowed: p.allowed,
          needs_confirmation: p.needs_confirmation ?? false,
          reason: p.reason,
          message: p.reason ? describeReason(p.reason) : null,
        });
        return "api.preview";
      }
      case "POST pay": {
        const body = PaymentBody.parse(await readJson(req, maxBody));
        const amount = parseNear(body.amount_near);
        if (options.maxPayment != null && amount > options.maxPayment) {
          throw new HttpError(403, `This gateway refuses payments above ${formatNear(options.maxPayment)} NEAR.`);
        }
        if (!payments.hit("all")) throw new HttpError(429, "Too many payments per minute.");
        const result = await connection.pay(body.recipient, amount, body.request_id);
        const outcome = result.outcome;
        sendJson(res, 200, {
          ok: result.operation.state === "settled",
          state: result.operation.state,
          reason: outcome?.status === "denied" ? outcome.reason : (result.operation.reason ?? null),
          message: result.message,
          request_id: result.operation.requestId,
          tx_hash: result.txHash ?? null,
        });
        return "api.pay";
      }
      case "GET activity": {
        const url = new URL(req.url ?? "/", "http://gateway.invalid");
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 10) || 10, 1), 50);
        const entries = await connection.activity(limit);
        sendJson(
          res,
          200,
          entries.map((a) => ({
            at: Number(a.at / 1_000_000n),
            recipient: a.recipient,
            amount_near: formatNear(a.amount),
            outcome: a.outcome,
            reason: a.reason,
          })),
        );
        return "api.activity";
      }
      default:
        throw new HttpError(404, "Not found.");
    }
  }

  async function mcp(req: IncomingMessage, res: ServerResponse) {
    if (req.method !== "POST") {
      // Stateless: no sessions and no server-initiated streams.
      res.setHeader("allow", "POST");
      sendJson(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
      return;
    }
    const body = await readJson(req, 256 * 1024);
    const server = createServer(options.connection(clientName(req)), options.mcp ?? { maxPayment: options.maxPayment });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  return async (req, res) => {
    const started = now();
    let route = "unknown";
    setCommonHeaders(res);
    const finish = (status: number) => log({ route, status, ms: now() - started });
    res.on("finish", () => finish(res.statusCode));

    try {
      const origin = req.headers.origin;
      if (typeof origin === "string" && allowedOrigins.has(origin)) {
        res.setHeader("access-control-allow-origin", origin);
        res.setHeader("vary", "Origin");
        res.setHeader("access-control-allow-headers", "authorization, content-type, x-nearfirewall-client, mcp-protocol-version, mcp-session-id");
        res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
      }
      if (req.method === "OPTIONS") {
        route = "preflight";
        res.writeHead(204).end();
        return;
      }

      const url = new URL(req.url ?? "/", "http://gateway.invalid");
      const segments = url.pathname.split("/").filter(Boolean);

      if (url.pathname === "/health") {
        route = "health";
        sendJson(res, 200, { ok: true });
        return;
      }

      const address = (options.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim() : "") || req.socket.remoteAddress || "unknown";
      if (failures.exceeded(address)) {
        route = "blocked";
        throw new HttpError(429, "Too many failed attempts. Try again in a minute.");
      }
      if (!requests.hit(address)) {
        route = "limited";
        throw new HttpError(429, "Too many requests. Try again in a minute.");
      }

      const area = segments[0];
      if (area !== "mcp" && area !== "api") {
        route = "unknown";
        throw new HttpError(404, "Not found.");
      }
      // Authenticate before doing anything else: a path token (MCP only) or a Bearer header.
      const pathToken = area === "mcp" && segments.length === 2 ? segments[1] : null;
      if (!(isAuthorized(pathToken) || isAuthorized(bearer(req))) || (area === "mcp" && segments.length > 2)) {
        route = "unauthorized";
        failures.hit(address);
        res.setHeader("www-authenticate", 'Bearer realm="nearfirewall"');
        throw new HttpError(401, "Unauthorized.");
      }

      if (area === "mcp") {
        route = "mcp";
        await mcp(req, res);
      } else {
        route = "api";
        if (req.method === "POST" && !String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
          throw new HttpError(415, "Send the body as application/json.");
        }
        route = await api(req, res, segments.slice(1).join("/"));
      }
    } catch (error) {
      if (res.headersSent) return;
      if (error instanceof HttpError) {
        if (error.status === 413) res.setHeader("connection", "close");
        sendJson(res, error.status, { error: error.message });
      } else if (error instanceof z.ZodError) {
        sendJson(res, 400, { error: "Invalid request.", details: error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`) });
      } else {
        // Show the short message (for example "This key is not connected") but never a stack trace.
        sendJson(res, 502, { error: error instanceof Error ? error.message.slice(0, 300) : "The request failed." });
      }
    }
  };
}

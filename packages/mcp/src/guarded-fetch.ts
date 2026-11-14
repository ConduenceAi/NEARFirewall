/**
 * A web fetch an AI agent can be given without giving it a way into the
 * machine it runs on.
 *
 * - The owner's browsing rules run before the first request and before every
 *   redirect, so a redirect cannot reach a site the rules forbid.
 * - Private, loopback, link-local and other internal addresses are refused when
 *   the connection is made (a custom DNS lookup), so a hostname that resolves to
 *   an internal address, or that changes its answer between checks, cannot reach
 *   the local network or a cloud metadata service.
 * - Responses are size-limited and time-limited, never decompressed, and only
 *   text is returned.
 */
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

export interface GuardedFetchOptions {
  /** Called with every URL before it is requested, including redirects. */
  check?: (url: URL) => { allowed: true } | { allowed: false; reason: string };
  maxBytes?: number;
  maxRedirects?: number;
  timeoutMs?: number;
  /** Extra request headers, such as an x402 payment. Never sent on to another origin after a redirect. */
  headers?: Record<string, string>;
  /** For tests only: allow private and loopback addresses. */
  allowPrivate?: boolean;
}

export interface GuardedFetchResult {
  status: number;
  url: string;
  contentType: string;
  text: string;
  truncated: boolean;
  /** Response headers, with lowercased names. */
  headers?: Record<string, string>;
  /** Set when the body is not text and was not returned. */
  note?: string;
}

export class FetchRefused extends Error {}

function ipv4Blocked(octets: number[]): boolean {
  const [a, b, c] = octets as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

/** Expands an IPv6 address into 8 groups of 16 bits, or null if it cannot be parsed. */
function expandIPv6(address: string): number[] | null {
  let a = address.split("%")[0]!.toLowerCase();
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (tail) {
    const o = tail[1]!.split(".").map(Number);
    if (o.length !== 4 || o.some((n) => !(n >= 0 && n <= 255))) return null;
    a = a.slice(0, -tail[1]!.length) + ((o[0]! << 8) | o[1]!).toString(16) + ":" + ((o[2]! << 8) | o[3]!).toString(16);
  }
  const halves = a.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...rest].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** True for any address an agent must not be able to reach: internal, reserved, or unparsable. */
export function isBlockedAddress(address: string): boolean {
  const v = net.isIP(address);
  if (v === 4) return ipv4Blocked(address.split(".").map(Number));
  if (v === 6) {
    const g = expandIPv6(address);
    if (!g) return true;
    if (g.every((x) => x === 0)) return true; // ::
    if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
    if ((g[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((g[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
    if ((g[0]! & 0xff00) === 0xff00) return true; // multicast
    if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
    if (g[0] === 0x0064 && g[1] === 0xff9b) return true; // NAT64 can reach IPv4 internals
    if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && (g[5] === 0xffff || g[5] === 0)) {
      return ipv4Blocked([g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255]); // IPv4-mapped or compatible
    }
    return false;
  }
  return true; // not an IP address
}

const safeLookup: typeof dnsLookup = ((hostname: string, options: any, callback: any) => {
  const cb = typeof options === "function" ? options : callback;
  const opts = typeof options === "function" ? {} : options;
  dnsLookup(hostname, { ...opts, all: true }, (error, addresses: LookupAddress[]) => {
    if (error) return cb(error);
    const bad = addresses.find((a) => isBlockedAddress(a.address));
    if (bad) return cb(new FetchRefused(`${hostname} resolves to an internal address, which is not allowed.`));
    if (opts.all) return cb(null, addresses);
    const first = addresses[0]!;
    return cb(null, first.address, first.family);
  });
}) as typeof dnsLookup;

const TEXT_TYPES = /^(text\/|application\/(json|xml|xhtml\+xml|rss\+xml|atom\+xml|javascript)|[^;]*\+(json|xml))/i;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function requestOnce(
  url: URL,
  opts: Required<Pick<GuardedFetchOptions, "maxBytes" | "allowPrivate">> & { headers: Record<string, string> },
  timeoutMs: number,
) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer; truncated: boolean }>((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const request = client.request(
      url,
      {
        method: "GET",
        headers: {
          ...opts.headers,
          "user-agent": "NEARFirewall-MCP/0.1",
          accept: "text/*, application/json, application/xml;q=0.9, */*;q=0.1",
          // Never ask for compressed data, so a small download cannot expand into a huge one.
          "accept-encoding": "identity",
        },
        timeout: timeoutMs,
        ...(opts.allowPrivate ? {} : { lookup: safeLookup }),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > opts.maxBytes) {
            chunks.push(chunk.subarray(0, chunk.length - (size - opts.maxBytes)));
            truncated = true;
            response.destroy();
            return;
          }
          chunks.push(chunk);
        });
        const done = () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks), truncated });
        response.on("end", done);
        response.on("close", done);
        response.on("error", () => done());
      },
    );
    request.on("timeout", () => request.destroy(new Error(`The request timed out after ${Math.round(timeoutMs / 1000)} seconds.`)));
    request.on("error", reject);
    request.end();
  });
}

/** Fetches a page as text, applying the owner's browsing rules to every hop. */
export async function guardedFetch(rawUrl: string, options: GuardedFetchOptions = {}): Promise<GuardedFetchResult> {
  const maxBytes = options.maxBytes ?? 100_000;
  const maxRedirects = options.maxRedirects ?? 5;
  const allowPrivate = options.allowPrivate ?? false;
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);

  let url = new URL(rawUrl);
  const origin = url.origin;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new FetchRefused("Only http and https links are allowed.");
    const verdict = options.check?.(url);
    if (verdict && !verdict.allowed) throw new FetchRefused(verdict.reason);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (!allowPrivate && net.isIP(host) && isBlockedAddress(host)) {
      throw new FetchRefused(`${host} is an internal address, which is not allowed.`);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("The request timed out.");
    const headers = url.origin === origin ? (options.headers ?? {}) : {};
    const response = await requestOnce(url, { maxBytes, allowPrivate, headers }, remaining);

    const location = response.headers.location;
    if (REDIRECTS.has(response.status) && location) {
      url = new URL(location, url);
      continue;
    }
    const contentType = String(response.headers["content-type"] ?? "");
    const isText = contentType === "" || TEXT_TYPES.test(contentType);
    const responseHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(response.headers)) {
      if (value !== undefined) responseHeaders[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
    }
    return {
      status: response.status,
      url: url.href,
      contentType,
      text: isText ? new TextDecoder("utf-8", { fatal: false }).decode(response.body) : "",
      truncated: response.truncated,
      headers: responseHeaders,
      ...(isText ? {} : { note: `This is ${contentType || "binary"} content, so it was not returned.` }),
    };
  }
  throw new FetchRefused(`Too many redirects (more than ${maxRedirects}).`);
}

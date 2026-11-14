/**
 * x402 for an agent: fetch a URL and, if the seller asks, pay it in USDC within
 * the owner's on-chain rules. Shared by the MCP server and the gateway.
 *
 * The owner's browsing rules apply to the first request and every redirect,
 * exactly as for `fetch_url`. The payment itself is decided by the owner's
 * policy on-chain; this code only asks.
 */
import { checkUrl, formatUsdc, type AgentConnection, type AgentX402Rules } from "@nearfirewall/sdk";
import type { Transport, X402Buyer, X402FetchResult } from "@nearfirewall/x402";
import { guardedFetch, type GuardedFetchOptions } from "./guarded-fetch.ts";

export interface PaidFetchOptions {
  fetchPage?: typeof guardedFetch;
  fetchOptions?: Omit<GuardedFetchOptions, "check" | "headers">;
  maxBytes?: number;
  /** The most the caller will pay for this request, in USDC's smallest unit. */
  maxAmount?: bigint | null;
}

export type PaidFetchOutcome = X402FetchResult | { status: "blocked"; reason: string } | { status: "error"; reason: string };

export async function paidFetch(connection: AgentConnection, buyer: X402Buyer, url: string, opts: PaidFetchOptions = {}): Promise<PaidFetchOutcome> {
  // Read the rules fresh on every call, so a change by the owner applies at once.
  const rules = await connection.accessRules();
  const first = checkUrl(url, rules);
  if (!first.allowed) return { status: "blocked", reason: `Refused by the owner's browsing rules: ${first.reason}` };
  const fetchPage = opts.fetchPage ?? guardedFetch;
  const transport: Transport = async (request) => {
    const page = await fetchPage(request.url, {
      maxBytes: Math.min(opts.maxBytes ?? 100_000, 500_000),
      ...opts.fetchOptions,
      headers: request.headers,
      check: (u) => {
        const verdict = checkUrl(u.href, rules);
        return verdict.allowed ? { allowed: true } : { allowed: false, reason: `the owner's browsing rules refuse ${u.hostname}: ${verdict.reason}` };
      },
    });
    return {
      status: page.status,
      url: page.url,
      headers: page.headers ?? {},
      body: page.text,
      truncated: page.truncated,
      ...(page.note ? { note: page.note } : {}),
    };
  };
  try {
    return await buyer.fetch(url, { transport, maxAmount: opts.maxAmount ?? null });
  } catch (error) {
    return { status: "error", reason: `Could not fetch ${url}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** The agent's x402 rules in plain language. */
export function x402RulesLines(r: AgentX402Rules): string[] {
  if (!r.enabled) {
    return [`x402 payments in USDC (fetch_paid): off. ${r.note ?? ""}`.trim()];
  }
  const lines = [
    "x402 payments in USDC (fetch_paid):",
    `- Largest single payment: ${formatUsdc(r.maxPerPayment!)} USDC.`,
    ...r.budgets.map((b) => `- Daily x402 budget (${b.handle}): ${formatUsdc(b.usedToday)} of ${formatUsdc(b.daily)} USDC used today.`),
    ...r.agents.map(
      (a) =>
        `- Approved agent ${a.payee}: up to ${formatUsdc(a.perPayment)} USDC each, ${formatUsdc(a.daily)} per day (${formatUsdc(a.usedToday)} used today). Paid only if the seller's account holds that agent now.`,
    ),
    ...r.sellers.map(
      (s) => `- Approved seller ${s.seller}: up to ${formatUsdc(s.perPayment)} USDC each, ${formatUsdc(s.daily)} per day (${formatUsdc(s.usedToday)} used today).`,
    ),
    ...r.sites.map(
      (s) =>
        `- Approved website ${s.site}: up to ${formatUsdc(s.perPayment)} USDC each, ${formatUsdc(s.daily)} per day (${formatUsdc(s.usedToday)} used today)` +
        (s.payTo ? `, paid only to ${s.payTo}.` : "."),
    ),
    r.unlisted
      ? `- Any other seller: up to ${formatUsdc(r.unlisted.perPayment)} USDC each, ${formatUsdc(r.unlisted.daily)} USDC per day for all of them together (${formatUsdc(r.unlisted.usedToday)} used today).`
      : "- Sellers not listed above are refused.",
  ];
  if (r.account.daily !== null) lines.push(`- Account-wide x402 cap: ${formatUsdc(r.account.usedToday)} of ${formatUsdc(r.account.daily)} USDC used today.`);
  if (!r.paymentAccountReady) lines.push("- The payment account is not set up yet. Ask the owner to set up x402 for this connection.");
  if (r.unspent > 0n) lines.push(`- ${formatUsdc(r.unspent)} USDC is waiting in the payment account; return_unspent_usdc sends it back to the owner.`);
  return lines;
}

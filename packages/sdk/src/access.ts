/**
 * Browsing rules. The owner stores them as public records on the agent's NFT:
 *
 *   access.allowed_domains   the only sites the agent may open
 *   access.blocked_domains   sites it may never open
 *
 * Both hold a comma, space, or newline separated list of domains. A domain also
 * covers its subdomains. Rules on a parent agent apply to every agent below it,
 * and a child can only narrow them.
 *
 * These rules are enforced where the agent runs (the MCP server's and the
 * gateway's `fetch_url` tool refuse a site before requesting it). Unlike payment
 * rules they are not enforced by the blockchain: an agent whose runtime is
 * compromised can ignore them. Payments stay protected on-chain either way.
 */
import type { RegistryClient } from "./clients.ts";

export const ACCESS_ALLOWED_KEY = "access.allowed_domains";
export const ACCESS_BLOCKED_KEY = "access.blocked_domains";

export interface AccessRules {
  /**
   * One list per agent on the path that sets `access.allowed_domains`. A site must
   * match at least one entry in every list, so children only narrow their parents.
   * Empty means the agent may open any site that is not blocked.
   */
  allowed: string[][];
  /** Domains blocked by any agent on the path, plus any extra feeds the caller adds. */
  blocked: string[];
}

export type UrlCheck = { allowed: true; host: string } | { allowed: false; reason: string };

/** Splits a record value into normalized domains. Invalid entries are dropped. */
export function parseDomainList(value: string | null | undefined): string[] {
  if (!value) return [];
  const out: string[] = [];
  for (const raw of value.split(/[\s,;]+/)) {
    let entry = raw.trim().toLowerCase();
    if (!entry) continue;
    entry = entry.replace(/^https?:\/\//, "").replace(/^\*\./, "").split(/[/:?#]/)[0]!.replace(/\.$/, "");
    if (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(entry) && entry.length <= 253) out.push(entry);
  }
  return [...new Set(out)];
}

/** True when `host` is `domain` or one of its subdomains. */
export function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** Reads the browsing rules of an agent and every agent above it. */
export async function loadAccessRules(registry: RegistryClient, agentId: string, extraBlocked: string[] = []): Promise<AccessRules> {
  const path = await registry.getPath(agentId);
  const rules: AccessRules = { allowed: [], blocked: [...extraBlocked] };
  for (const node of path) {
    const records = await registry.getRecords(node.agent_id);
    const allowed = parseDomainList(records.find((r) => r.key === ACCESS_ALLOWED_KEY)?.value);
    // A list that is set but has no valid entry allows nothing, rather than everything.
    if (records.some((r) => r.key === ACCESS_ALLOWED_KEY && r.value.trim().length > 0)) rules.allowed.push(allowed);
    rules.blocked.push(...parseDomainList(records.find((r) => r.key === ACCESS_BLOCKED_KEY)?.value));
  }
  rules.blocked = [...new Set(rules.blocked)];
  return rules;
}

/** Decides whether the agent may open a URL. Run it before every request, including each redirect. */
export function checkUrl(rawUrl: string, rules: AccessRules): UrlCheck {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: "This is not a valid URL." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { allowed: false, reason: `Only http and https links are allowed, not ${url.protocol.replace(":", "")}.` };
  }
  if (url.username || url.password) return { allowed: false, reason: "Links with a username or password are not allowed." };
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return { allowed: false, reason: "This URL has no host." };
  const blocked = rules.blocked.find((d) => hostMatches(host, d));
  if (blocked) return { allowed: false, reason: `${host} is blocked by the owner's rules (${blocked}).` };
  for (const list of rules.allowed) {
    if (!list.some((d) => hostMatches(host, d))) {
      return {
        allowed: false,
        reason: `${host} is not on the owner's list of allowed sites${list.length ? ` (${list.slice(0, 5).join(", ")}${list.length > 5 ? ", …" : ""})` : ""}.`,
      };
    }
  }
  return { allowed: true, host };
}

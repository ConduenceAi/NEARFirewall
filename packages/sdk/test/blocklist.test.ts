import { describe, expect, it } from "vitest";
import {
  AgentConnection,
  NearRpc,
  RegistryClient,
  addGuardianKey,
  blockRecipient,
  checkUrl,
  guardianBlockArgs,
  hostMatches,
  loadAccessRules,
  parseDomainList,
  parseNear,
  removeGuardianKey,
  unblockRecipient,
  type AccessRules,
} from "../src/index.ts";

const KEY = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp";

function fakeRpc(views: Record<string, (args: any) => unknown>) {
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    const p = body.params;
    const handler = views[`${p.account_id}.${p.method_name}`];
    if (!handler) return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { message: `no view ${p.method_name}` } }));
    const value = handler(JSON.parse(atob(p.args_base64)));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { result: Array.from(new TextEncoder().encode(JSON.stringify(value))) } }));
  }) as unknown as typeof fetch;
  return new NearRpc("http://rpc.invalid", fetchImpl);
}

describe("blocklist and guardian builders", () => {
  it("blocks and unblocks with the owner's full key", () => {
    const block = blockRecipient("alice.testnet", "scam.testnet", "hijacked");
    const a = block.actions[0]!;
    if (a.type !== "FunctionCall") throw new Error();
    expect(a.params).toMatchObject({ methodName: "block_recipient", deposit: "1", args: { recipient: "scam.testnet", reason: "hijacked" } });
    expect(unblockRecipient("alice.testnet", "scam.testnet").actions[0]).toMatchObject({ params: { methodName: "unblock_recipient", deposit: "1" } });
  });

  it("gives a guardian key permission to call guardian_block and nothing else", () => {
    const tx = addGuardianKey("alice.testnet", { publicKey: KEY, label: "watcher" });
    const [addKey, record] = tx.actions;
    if (addKey?.type !== "AddKey" || record?.type !== "FunctionCall") throw new Error();
    expect(addKey.params.accessKey.permission).toEqual({
      receiverId: "alice.testnet",
      allowance: parseNear("0.1").toString(),
      methodNames: ["guardian_block"],
    });
    expect(record.params.methodName).toBe("add_guardian_key");
    expect(() => addGuardianKey("alice.testnet", { publicKey: "nope", label: "x" })).toThrow();
    expect(() => addGuardianKey("alice.testnet", { publicKey: KEY, label: "x", allowance: 0n })).toThrow();
  });

  it("removes a guardian with or without deleting its key", () => {
    expect(removeGuardianKey("alice.testnet", KEY).actions.map((x) => x.type)).toEqual(["FunctionCall", "DeleteKey"]);
    expect(removeGuardianKey("alice.testnet", KEY, { keyPresent: false }).actions.map((x) => x.type)).toEqual(["FunctionCall"]);
  });

  it("builds guardian_block arguments with no deposit field", () => {
    expect(guardianBlockArgs("scam.testnet", "mismatch")).toEqual({ recipient: "scam.testnet", reason: "mismatch" });
    expect(guardianBlockArgs("scam.testnet")).toEqual({ recipient: "scam.testnet", reason: null });
  });
});

describe("browsing rules", () => {
  it("parses domain lists leniently but safely", () => {
    expect(parseDomainList("docs.near.org, https://API.vendor.com/path  *.example.org\nbad_host, -x.com, near.org.")).toEqual([
      "docs.near.org",
      "api.vendor.com",
      "example.org",
      "near.org",
    ]);
    expect(parseDomainList("")).toEqual([]);
    expect(parseDomainList(null)).toEqual([]);
  });

  it("matches a domain and its subdomains only", () => {
    expect(hostMatches("near.org", "near.org")).toBe(true);
    expect(hostMatches("docs.near.org", "near.org")).toBe(true);
    expect(hostMatches("evilnear.org", "near.org")).toBe(false);
    expect(hostMatches("near.org.evil.com", "near.org")).toBe(false);
  });

  const open: AccessRules = { allowed: [], blocked: [] };

  it("allows ordinary sites when no rules are set", () => {
    expect(checkUrl("https://example.com/page", open)).toEqual({ allowed: true, host: "example.com" });
  });

  it("refuses anything that is not plain http or https, or hides a host", () => {
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "ftp://x.org", "not a url", "https://user:pw@example.com/"]) {
      expect(checkUrl(url, open).allowed).toBe(false);
    }
    // The part before @ is a username, not the host the link points to.
    expect(checkUrl("https://near.org@evil.com/", { allowed: [["near.org"]], blocked: [] }).allowed).toBe(false);
  });

  it("blocks listed domains and their subdomains, and blocked wins over allowed", () => {
    const rules: AccessRules = { allowed: [["vendor.com"]], blocked: ["bad.vendor.com"] };
    expect(checkUrl("https://shop.vendor.com/", rules).allowed).toBe(true);
    const refused = checkUrl("https://x.bad.vendor.com/", rules);
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) expect(refused.reason).toContain("blocked by the owner");
  });

  it("requires a site to be on every allowed list on the path, so children only narrow", () => {
    const rules: AccessRules = { allowed: [["near.org", "vendor.com"], ["near.org"]], blocked: [] };
    expect(checkUrl("https://docs.near.org/", rules).allowed).toBe(true);
    expect(checkUrl("https://vendor.com/", rules).allowed).toBe(false);
    expect(checkUrl("https://elsewhere.com/", rules).allowed).toBe(false);
  });

  it("treats a list that is set but empty as allowing nothing", () => {
    expect(checkUrl("https://near.org/", { allowed: [[]], blocked: [] }).allowed).toBe(false);
  });

  it("is not fooled by case, a trailing dot, or look-alike hosts", () => {
    const rules: AccessRules = { allowed: [["near.org"]], blocked: [] };
    expect(checkUrl("https://DOCS.NEAR.ORG./", rules).allowed).toBe(true);
    expect(checkUrl("https://near.org.evil.com/", rules).allowed).toBe(false);
    expect(checkUrl("https://evilnear.org/", rules).allowed).toBe(false);
  });

  it("loads rules from the agent's records and those of its parents", async () => {
    const records: Record<string, { key: string; value: string }[]> = {
      "1": [{ key: "access.allowed_domains", value: "near.org, vendor.com" }, { key: "profile.description", value: "x" }],
      "2": [{ key: "access.allowed_domains", value: "near.org" }, { key: "access.blocked_domains", value: "docs.near.org" }],
    };
    const rpc = fakeRpc({
      "agents.alice.testnet.get_path": () => [{ agent_id: "1", generation: 1 }, { agent_id: "2", generation: 2 }],
      "agents.alice.testnet.get_records": (args) => records[args.agent_id] ?? [],
    });
    const rules = await loadAccessRules(new RegistryClient(rpc, "agents.alice.testnet"), "2", ["feed.example"]);
    expect(rules.allowed).toEqual([["near.org", "vendor.com"], ["near.org"]]);
    expect(rules.blocked.sort()).toEqual(["docs.near.org", "feed.example"]);
    expect(checkUrl("https://docs.near.org/", rules).allowed).toBe(false);
    expect(checkUrl("https://api.near.org/", rules).allowed).toBe(true);
  });
});

describe("agent rules with a blocklist", () => {
  const connection = { public_key: KEY, agent_id: "1", platform: "custom", label: "Test", created_at: 1, last_used: null, uses: 0 };
  const views = {
    "alice.testnet.get_connection": () => connection,
    "alice.testnet.get_policy": () => ({
      account: "alice.testnet", registry: "agents.alice.testnet", paused: false, revision: 3, account_daily_cap: null,
      account_used_today: "0", safety_buffer: "0", reserved_total: "0", available_balance: parseNear("20").toString(), day: 1,
      connections: 1, pending: 0, blocked: 1, guardians: 0,
    }),
    "alice.testnet.get_mandate": () => ({
      path: [{ agent_id: "1", generation: 3 }], status: "Active", fixed: false, expires_at: null, daily_cap: parseNear("10").toString(),
      recipients: {
        "vendor.testnet": { per_payment_cap: parseNear("3").toString(), daily_cap: parseNear("6").toString(), expires_at: null },
        "vendor2.testnet": { per_payment_cap: parseNear("2").toString(), daily_cap: parseNear("4").toString(), expires_at: null },
      },
    }),
    "alice.testnet.get_usage": () => ({ day: 1, mandate_used_today: "0", recipient_used_today: "0", account_used_today: "0" }),
    "alice.testnet.get_blocklist": () => [{ recipient: "vendor.testnet", at: 5, by: "guardian:watcher", reason: "hijacked" }],
    "agents.alice.testnet.get_agent": () => ({
      agent_id: "1", handle: "trader", holder: "alice.testnet", parent: null, ancestors: [], depth: 0, executor: null,
      capabilities: { transfer_near: { max_per_payment: parseNear("5").toString() } }, status: { state: "active" },
      expires_at: null, locks: 0, generation: "3", created_at: "1",
    }),
    "agents.alice.testnet.get_path": () => [{ agent_id: "1", generation: 3 }],
  };

  it("leaves blocked recipients out of the effective rules and reports them", async () => {
    const c = new AgentConnection({ rpc: fakeRpc(views), account: "alice.testnet", publicKey: KEY, submit: async () => ({ status: {} }) });
    const rules = await c.rules();
    expect(rules.recipients.map((r) => r.recipient)).toEqual(["vendor2.testnet"]);
    expect(rules.blocked).toEqual(["vendor.testnet"]);
  });

  it("still works against a policy that has no blocklist", async () => {
    const without = { ...views } as Record<string, (a: any) => unknown>;
    delete without["alice.testnet.get_blocklist"];
    const c = new AgentConnection({ rpc: fakeRpc(without), account: "alice.testnet", publicKey: KEY, submit: async () => ({ status: {} }) });
    expect((await c.rules()).recipients).toHaveLength(2);
  });
});

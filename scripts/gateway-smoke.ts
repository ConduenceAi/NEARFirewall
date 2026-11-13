#!/usr/bin/env node
/**
 * Starts the NEARFirewall gateway as a separate process with a connection key,
 * then calls it over HTTP the way a cloud platform would: remote MCP (token in
 * the URL) and the REST API (Bearer header).
 *
 *   node scripts/gateway-smoke.ts <owner> [--agent trader] [--vendors a,b] [--port 8791] [--fetch https://example.com/]
 *
 * The connection key is read from ~/.near-credentials/<network>/<owner>/connection-<agent>.json
 * and passed to the child process through its environment only.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [owner, ...rest] = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 && rest[i + 1] ? rest[i + 1]! : fallback;
};
if (!owner) throw new Error("Usage: node scripts/gateway-smoke.ts <owner>");
const agent = flag("agent", "trader");
const [vendorA = "nfw-vendor-1112.testnet", vendorB = "nfw-vendor2-1112.testnet"] = flag("vendors", "").split(",").filter(Boolean);
const port = Number(flag("port", "8791"));
const fetchTarget = flag("fetch", "");
const base = `http://127.0.0.1:${port}`;
const token = randomBytes(32).toString("hex");
const { private_key } = JSON.parse(await readFile(join(homedir(), ".near-credentials", "testnet", owner, `connection-${agent}.json`), "utf8")) as { private_key: string };

const child = spawn(process.execPath, ["apps/gateway/src/main.ts"], {
  env: {
    ...process.env,
    NEARFIREWALL_ACCOUNT: owner,
    NEARFIREWALL_AGENT_KEY: private_key,
    NEARFIREWALL_NETWORK: "testnet",
    GATEWAY_TOKEN: token,
    PORT: String(port),
    HOST: "127.0.0.1",
  },
  stdio: ["ignore", "ignore", "inherit"],
});

async function waitUntilUp() {
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("The gateway did not start.");
}

const auth = { authorization: `Bearer ${token}` };
const show = (label: string, value: unknown) => console.log(`\n▶ ${label}\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`);
const rest_ = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { ...auth, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

try {
  await waitUntilUp();
  show("health (no token)", await (await fetch(`${base}/health`)).json());
  show("rules without a token → status", (await fetch(`${base}/api/rules`)).status);
  show("REST /api/status", await rest_("GET", "/api/status"));
  show("REST /api/rules", await rest_("GET", "/api/rules"));
  show("REST preview: attacker", await rest_("POST", "/api/preview", { recipient: "attacker.testnet", amount_near: "1" }));
  show("REST pay: 1 NEAR to an approved vendor", await rest_("POST", "/api/pay", { recipient: vendorA, amount_near: "1" }));
  show("REST pay: attacker", await rest_("POST", "/api/pay", { recipient: "attacker.testnet", amount_near: "1" }));

  const client = new Client({ name: "ChatGPT-like remote client", version: "1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${token}`)));
  show("MCP tools over HTTP", (await client.listTools()).tools.map((t) => t.name).join(", "));
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    ((await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean });
  const rules = await call("get_rules");
  show("MCP get_rules", rules.content.map((c) => c.text).join("\n"));
  const paid = await call("pay", { recipient: vendorB, amount_near: "1" });
  show(`MCP pay: 1 NEAR to ${vendorB}${paid.isError ? " (isError)" : ""}`, paid.content.map((c) => c.text).join("\n"));
  const blocked = await call("pay", { recipient: "attacker.testnet", amount_near: "1" });
  show(`MCP pay: attacker${blocked.isError ? " (isError)" : ""}`, blocked.content.map((c) => c.text).join("\n"));
  if (fetchTarget) {
    const page = await call("fetch_url", { url: fetchTarget, max_bytes: 1500 });
    show(`MCP fetch_url ${fetchTarget}${page.isError ? " (isError)" : ""}`, page.content.map((c) => c.text).join("\n").slice(0, 600));
  }
  const activity = await call("list_activity", { limit: 6 });
  show("MCP list_activity", activity.content.map((c) => c.text).join("\n"));
  await client.close();
} finally {
  child.kill();
}

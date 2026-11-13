#!/usr/bin/env node
/**
 * Plays an AI agent client: starts the NEARFirewall MCP server over stdio with a
 * connection key (exactly as Claude Desktop would) and calls its tools.
 *
 *   node scripts/mcp-smoke.ts <owner> [--agent trader] [--vendors a,b] [--steps rules,pay,attack,large,cap,activity]
 *
 * The connection key is read from ~/.near-credentials/<network>/<owner>/connection-<agent>.json
 * and passed to the server through its environment only.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [owner, ...rest] = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 && rest[i + 1] ? rest[i + 1]! : fallback;
};
if (!owner) throw new Error("Usage: node scripts/mcp-smoke.ts <owner>");
const agent = flag("agent", "trader");
const [vendorA = "nfw-vendor-1112.testnet", vendorB = "nfw-vendor2-1112.testnet"] = flag("vendors", "").split(",").filter(Boolean);
const steps = flag("steps", "rules,pay,attack,large,cap,activity").split(",");
const file = join(homedir(), ".near-credentials", "testnet", owner, `connection-${agent}.json`);
const { private_key } = JSON.parse(await readFile(file, "utf8")) as { private_key: string };

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["packages/mcp/src/main.ts"],
  env: {
    ...(process.env as Record<string, string>),
    NEARFIREWALL_ACCOUNT: owner,
    NEARFIREWALL_AGENT_KEY: private_key,
    NEARFIREWALL_NETWORK: "testnet",
  },
  stderr: "inherit",
});
const client = new Client({ name: "nearfirewall-smoke-test", version: "1.0" });
await client.connect(transport);

async function call(label: string, name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  console.log(`\n▶ ${label}  [${name}${Object.keys(args).length ? " " + JSON.stringify(args) : ""}]${result.isError ? "  (isError)" : ""}`);
  console.log(result.content.map((c) => c.text).join("\n"));
}

const { tools } = await client.listTools();
console.log(`tools: ${tools.map((t) => t.name).join(", ")}`);
if (steps.includes("rules")) await call("What can I spend?", "get_rules");
if (steps.includes("pay")) await call("Pay an approved vendor 2 NEAR", "pay", { recipient: vendorA, amount_near: "2" });
if (steps.includes("attack")) await call("A prompt injection asks to pay an attacker", "pay", { recipient: "attacker.testnet", amount_near: "1" });
if (steps.includes("large")) await call("Pay 4.5 NEAR (above the ask-me-first amount)", "pay", { recipient: vendorA, amount_near: "4.5" });
if (steps.includes("cap")) await call("Pay vendor B 3 NEAR (its limit is 2)", "pay", { recipient: vendorB, amount_near: "3" });
if (steps.includes("after")) await call("Pay after the key was disconnected", "pay", { recipient: vendorA, amount_near: "1" });
if (steps.includes("activity")) await call("Recent activity", "list_activity", { limit: 6 });
await client.close();

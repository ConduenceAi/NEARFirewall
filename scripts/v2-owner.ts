#!/usr/bin/env node
/**
 * Owner-side driver for the revision 2 flow (user-owned registry and agent
 * connections), for a CLI-controlled demo owner. The web app does the same
 * through a wallet. Keys come from the NEAR CLI legacy keychain and are never printed.
 *
 *   node scripts/v2-owner.ts <owner> setup [--vendors a,b] [--agent trader]
 *       creates agents.<owner>, enables payments, registers the agent, sets rules
 *       (vendor a: 5 per payment, 9 per day; vendor b: 2 and 4; 12 NEAR budget; ask me above 4)
 *   node scripts/v2-owner.ts <owner> connect [--agent trader] [--platform claude-desktop] [--label "Claude on laptop"]
 *       adds a connection key; its secret is saved to ~/.near-credentials/<network>/<owner>/connection-<agent>.json
 *   node scripts/v2-owner.ts <owner> pending | confirm <request-id> | decline <request-id> | disconnect [--agent trader] | status
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { KeyPair } from "near-api-js";
import {
  NearRpc,
  PolicyClient,
  RegistryClient,
  checkRegistry,
  confirmPayment,
  connectAgentKey,
  createRegistry,
  declinePayment,
  describeReason,
  disconnectAgentKey,
  enablePayments,
  formatNear,
  parseNear,
  registerAgent,
  registryAccountFor,
  setMandate,
  transferCapability,
} from "@nearfirewall/sdk";
import { ownerAccount, send } from "./lib/sign.ts";

const [owner, command, ...rest] = process.argv.slice(2);
function flag(name: string, fallback: string) {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 && rest[i + 1] ? rest[i + 1]! : fallback;
}
function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
if (!owner || !command) fail("Usage: node scripts/v2-owner.ts <owner> setup|connect|pending|confirm|decline|disconnect|status");

const network = owner.endsWith(".near") ? "mainnet" : "testnet";
const rpcUrl = process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com";
const rpc = new NearRpc(rpcUrl);
const registryId = registryAccountFor(owner);
const registry = new RegistryClient(rpc, registryId);
const policy = new PolicyClient(rpc, owner);
const agentHandle = flag("agent", "trader");
const connectionFile = join(homedir(), ".near-credentials", network, owner, `connection-${agentHandle}.json`);

async function step(label: string, tx: Parameters<typeof send>[1]) {
  const account = await ownerAccount(owner!, rpcUrl, network);
  const result = await send(account, tx);
  if (result.failure) fail(`${label}: failed ${JSON.stringify(result.failure)}`);
  console.log(`  ${label}: ok  tx ${result.hash}`);
  return result;
}

async function agentId(): Promise<string> {
  const agent = await registry.resolve(agentHandle);
  if (!agent) fail(`No agent ${agentHandle} in ${registryId}. Run setup first.`);
  return agent.agent_id;
}

async function setup() {
  const [vendorA = "nfw-vendor-1112.testnet", vendorB = "nfw-vendor2-1112.testnet"] = flag("vendors", "").split(",").filter(Boolean);

  const state = await checkRegistry(rpc, registryId, owner!);
  if (state.kind === "missing") {
    const code = new Uint8Array(await readFile("target/near/nearfirewall_registry/nearfirewall_registry.wasm"));
    await step(`create ${registryId}`, createRegistry(owner!, registryId, { code }));
  } else if (state.kind === "untrusted") {
    fail(state.reason);
  } else {
    console.log(`  ${registryId}: already set up`);
  }

  const policyState = await policy.state();
  if (policyState.kind === "none") {
    const code = new Uint8Array(await readFile("target/near/nearfirewall_account_policy/nearfirewall_account_policy.wasm"));
    await step(`enable payments on ${owner}`, enablePayments(owner!, registryId, { code }));
  } else {
    console.log(`  ${owner}: payments already enabled`);
  }

  if (!(await registry.resolve(agentHandle))) {
    await step(
      `register ${agentHandle}`,
      registerAgent(registryId, agentHandle, { executor: null, capabilities: transferCapability(parseNear("5")), description: "Demo agent connected by key" }),
    );
  }
  const id = await agentId();
  const path = await registry.getPath(id);
  await step(
    `rules for ${agentHandle}`,
    setMandate(owner!, {
      agentId: id,
      path,
      dailyCap: parseNear("12"),
      confirmAbove: parseNear("4"),
      recipients: [
        { recipient: vendorA, perPaymentCap: parseNear("5"), dailyCap: parseNear("9") },
        { recipient: vendorB, perPaymentCap: parseNear("2"), dailyCap: parseNear("4") },
      ],
    }),
  );
}

async function connect() {
  const id = await agentId();
  const keyPair = KeyPair.fromRandom("ed25519");
  const publicKey = keyPair.getPublicKey().toString();
  await step(
    `connect a key to ${agentHandle}`,
    connectAgentKey(owner!, { agentId: id, publicKey, platform: flag("platform", "claude-desktop"), label: flag("label", "Claude on laptop") }),
  );
  await mkdir(dirname(connectionFile), { recursive: true });
  await writeFile(connectionFile, JSON.stringify({ account_id: owner, public_key: publicKey, private_key: keyPair.toString() }, null, 2));
  console.log(`  connection key ${publicKey} saved to ${connectionFile}`);
}

async function status() {
  const p = await policy.getPolicy();
  console.log(
    `${owner}: payments ${p.paused ? "PAUSED" : "on"}, registry ${p.registry}, available ${formatNear(p.available_balance)} NEAR, ` +
      `reserved ${formatNear(p.reserved_total)} NEAR, ${p.connections ?? 0} connection(s), ${p.pending ?? 0} waiting`,
  );
  for (const c of await policy.getConnections()) {
    console.log(`  key ${c.public_key.slice(0, 20)}… → agent #${c.agent_id} · ${c.platform} · "${c.label}" · used ${c.uses}×`);
  }
  for (const a of await policy.getActivity(8)) {
    const via = a.via?.kind === "connection" ? ` via "${a.via.label}"` : a.via?.kind === "executor" ? ` via ${a.via.account}` : "";
    console.log(`  #${a.leaf}${via}${a.client ? ` (${a.client})` : ""}: ${formatNear(a.amount)} NEAR → ${a.recipient}: ${a.outcome}${a.reason ? ` ${a.reason} (${describeReason(a.reason)})` : ""}`);
  }
}

switch (command) {
  case "setup":
    await setup();
    await status();
    break;
  case "connect":
    await connect();
    break;
  case "pending":
    for (const p of await policy.getPending()) {
      console.log(`  ${p.request_id} · #${p.leaf} · ${formatNear(p.amount)} NEAR → ${p.recipient} · until ${new Date(Number(p.expires_at / 1_000_000n)).toISOString()}`);
    }
    break;
  case "confirm": {
    const id = await agentId();
    const { value } = await step("confirm", confirmPayment(owner, id, rest[0] ?? fail("Give the request ID.")));
    console.log("  outcome:", JSON.stringify(value));
    break;
  }
  case "decline": {
    const id = await agentId();
    const { value } = await step("decline", declinePayment(owner, id, rest[0] ?? fail("Give the request ID.")));
    console.log("  outcome:", JSON.stringify(value));
    break;
  }
  case "disconnect": {
    const { public_key } = JSON.parse(await readFile(connectionFile, "utf8")) as { public_key: string };
    const keys = await rpc.viewAccessKeys(owner);
    await step("disconnect", disconnectAgentKey(owner, public_key, { keyPresent: keys.some((k) => k.publicKey === public_key) }));
    break;
  }
  case "status":
    await status();
    break;
  default:
    fail(`Unknown command ${command}`);
}

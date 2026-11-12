#!/usr/bin/env node
/**
 * Owner-side demo driver for CLI-controlled demo accounts.
 *
 * The web app does the same things through a wallet (Meteor). This script
 * signs with a full-access key from the local NEAR CLI legacy keychain
 * (~/.near-credentials/<network>/<account>.json), so the demo can be set up
 * and rehearsed without a browser. It never prints keys.
 *
 *   node scripts/demo-owner.ts setup        register $NEARFIREWALL_AGENT (default market-agent) and approve the three vendors
 *   node scripts/demo-owner.ts pause        pause agent payments on the owner's account
 *   node scripts/demo-owner.ts resume       resume them
 *   node scripts/demo-owner.ts tree         register desk, its leaf bot-1, and a 5 NEAR branch pool
 *   node scripts/demo-owner.ts pause-agent <handle>   pause an agent (and its branch) in the registry
 *   node scripts/demo-owner.ts resume-agent <handle>
 *   node scripts/demo-owner.ts transfer <handle> <account>   transfer the agent token
 *   node scripts/demo-owner.ts status       print the agents, mandates, and recent activity
 *
 * Environment: NEARFIREWALL_REGISTRY, NEARFIREWALL_OWNER, NEARFIREWALL_EXECUTOR,
 * NEARFIREWALL_LEAF_EXECUTOR, NEARFIREWALL_VENDORS (three comma-separated accounts), NEAR_RPC_URL.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Account, type KeyPairString } from "near-api-js";
import {
  NearRpc,
  PolicyClient,
  RegistryClient,
  describeReason,
  formatNear,
  nowNs,
  pauseAgent,
  pausePayments,
  resumeAgent,
  resumePayments,
  transferAgent,
  type WalletTransaction,
} from "@nearfirewall/sdk";
import { approvedVendors, buildPlan, describeStep, toTransaction, validatePlanLive, type PlanContext } from "@nearfirewall/templates";
import { loadDemoEnv } from "../apps/runner/src/env.ts";

// Works in PowerShell, cmd, and Bash: settings come from scripts/demo.env unless already set.
loadDemoEnv();

const env = process.env;
const need = (name: string) => env[name] ?? fail(`Set ${name}.`);
function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const rpcUrl = env.NEAR_RPC_URL ?? "https://rpc.testnet.near.org";
const network = rpcUrl.includes("mainnet") ? "mainnet" : "testnet";
const registryId = need("NEARFIREWALL_REGISTRY");
const owner = need("NEARFIREWALL_OWNER");
const rpc = new NearRpc(rpcUrl);
const registry = new RegistryClient(rpc, registryId);
const policy = new PolicyClient(rpc, owner);

async function ownerAccount(): Promise<Account> {
  const file = join(homedir(), ".near-credentials", network, `${owner}.json`);
  const { private_key } = JSON.parse(await readFile(file, "utf8")) as { private_key: string };
  return new Account(owner, rpcUrl, private_key as KeyPairString);
}

/** Signs a single-call owner transaction built by the SDK. */
async function send(account: Account, tx: WalletTransaction, label: string) {
  for (const action of tx.actions) {
    if (action.type !== "FunctionCall") throw new Error(`${label}: only function calls are supported here`);
    const response = await account.callFunctionRaw({
      contractId: tx.receiverId,
      methodName: action.params.methodName,
      args: action.params.args,
      gas: BigInt(action.params.gas),
      deposit: BigInt(action.params.deposit),
      waitUntil: "FINAL",
    });
    console.log(`  ${label}: ok  tx ${response.transaction.hash}`);
  }
}

const ctx = (): PlanContext => ({ now: nowNs(), owner, payer: owner, registryId });

async function runPlan(input: unknown) {
  const plan = buildPlan(approvedVendors, input, ctx());
  const result = await validatePlanLive(plan, ctx(), { registry, policy });
  for (const issue of result.issues) console.log(`  ${issue.level}: ${issue.message}`);
  if (!result.ok) fail("Validation failed; nothing was signed.");
  const account = await ownerAccount();
  for (const step of plan.steps) {
    await send(account, await toTransaction(step, ctx(), registry), describeStep(step));
  }
}

async function agentId(handle: string) {
  const agent = await registry.find(handle);
  if (!agent) fail(`No agent ${handle}.`);
  return agent.agent_id;
}

async function status() {
  const p = await policy.getPolicy();
  console.log(`${owner}: payments ${p.paused ? "PAUSED" : "on"}, revision ${p.revision}, available ${formatNear(p.available_balance)} NEAR, spent today ${formatNear(p.account_used_today)} NEAR`);
  for (const agent of await registry.agentsOf(owner)) {
    const mandate = await policy.getMandate(agent.agent_id);
    const usage = await policy.getUsage(agent.agent_id);
    console.log(
      `  #${agent.agent_id} ${agent.handle} [${agent.status.state}] executor ${agent.executor}, generation ${agent.generation}` +
        (mandate ? `, budget ${formatNear(usage.mandate_used_today)}/${formatNear(mandate.daily_cap)} NEAR (${mandate.status})` : ", no mandate"),
    );
  }
  console.log("Recent payments:");
  for (const a of await policy.getActivity(10)) {
    console.log(`  #${a.leaf} ${formatNear(a.amount)} NEAR -> ${a.recipient}: ${a.outcome}${a.reason ? ` ${a.reason} (${describeReason(a.reason)})` : ""}`);
  }
}

async function main([command, ...args]: string[]) {
  const account = () => ownerAccount();
  switch (command) {
    case "setup": {
      const [v1, v2, v3] = need("NEARFIREWALL_VENDORS").split(",").map((s) => s.trim());
      if (!v1 || !v2 || !v3) fail("NEARFIREWALL_VENDORS needs three accounts.");
      const handle = env.NEARFIREWALL_AGENT ?? "market-agent";
      if (!(await registry.resolve(handle))) {
        await runPlan({
          handle,
          executor: need("NEARFIREWALL_EXECUTOR"),
          description: "Pays approved vendors",
          // Above every vendor's own cap, so vendor limits are what the demo shows.
          maxPerPayment: "5",
          dailyBudget: "10",
          recipients: [
            { recipient: v1, perPayment: "3", daily: "6" },
            { recipient: v2, perPayment: "2", daily: "4" },
            { recipient: v3, perPayment: "3", daily: "6" },
          ],
        });
      } else {
        console.log(`${handle} already exists; skipping setup. Set NEARFIREWALL_AGENT to a new handle for a fresh daily budget.`);
      }
      break;
    }
    case "tree": {
      const [v1, v2] = need("NEARFIREWALL_VENDORS").split(",").map((s) => s.trim());
      await runPlan({
        handle: "desk",
        executor: need("NEARFIREWALL_EXECUTOR"),
        maxPerPayment: "3",
        dailyBudget: "5",
        recipients: [
          { recipient: v1, perPayment: "3", daily: "6" },
          { recipient: v2, perPayment: "2", daily: "4" },
        ],
        leaves: [{ label: "bot-1", executor: need("NEARFIREWALL_LEAF_EXECUTOR"), maxPerPayment: "3" }],
      });
      break;
    }
    case "pause":
      await send(await account(), pausePayments(owner), "pause payments");
      break;
    case "resume":
      await send(await account(), resumePayments(owner), "resume payments");
      break;
    case "pause-agent":
      await send(await account(), pauseAgent(registryId, await agentId(args[0] ?? fail("Give a handle."))), `pause ${args[0]}`);
      break;
    case "resume-agent":
      await send(await account(), resumeAgent(registryId, await agentId(args[0] ?? fail("Give a handle."))), `resume ${args[0]}`);
      break;
    case "transfer":
      await send(
        await account(),
        transferAgent(registryId, await agentId(args[0] ?? fail("Give a handle.")), args[1] ?? fail("Give a receiver.")),
        `transfer ${args[0]} to ${args[1]}`,
      );
      break;
    case "status":
      await status();
      return;
    default:
      fail("Commands: setup | tree | pause | resume | pause-agent <h> | resume-agent <h> | transfer <h> <to> | status");
  }
  await status();
}

main(process.argv.slice(2)).catch((error) => fail(error instanceof Error ? error.message : String(error)));

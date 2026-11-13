#!/usr/bin/env node
/**
 * Tries everything a guardian key must NOT be able to do, and reports whether the
 * network or the contract refused each attempt. Every line should say "refused".
 *
 *   node scripts/guardian-probe.ts <owner> [--label watcher]
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Account, type KeyPairString } from "near-api-js";
import { TGAS, parseNear } from "@nearfirewall/sdk";

const [owner, ...rest] = process.argv.slice(2);
if (!owner) throw new Error("Usage: node scripts/guardian-probe.ts <owner> [--label watcher]");
const labelAt = rest.indexOf("--label");
const label = labelAt >= 0 ? (rest[labelAt + 1] ?? "watcher") : "watcher";
const rpcUrl = process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com";
const { private_key } = JSON.parse(await readFile(join(homedir(), ".near-credentials", "testnet", owner, `guardian-${label}.json`), "utf8")) as { private_key: string };
const guardian = new Account(owner, rpcUrl, private_key as KeyPairString);

async function attempt(what: string, run: () => Promise<{ status: unknown }>) {
  try {
    const response = await run();
    const failure = (response.status as { Failure?: unknown }).Failure;
    console.log(failure ? `refused by the contract: ${what}` : `!! ALLOWED: ${what}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason = /method|receiver|permission|allowance|FunctionCall|does not have/i.test(message) ? "refused by the network" : "refused";
    console.log(`${reason}: ${what}  (${message.replace(/\s+/g, " ").slice(0, 110)})`);
  }
}

const call = (methodName: string, args: object, deposit = 0n) =>
  guardian.callFunctionRaw({ contractId: owner, methodName, args, gas: 30n * TGAS, deposit, waitUntil: "FINAL" });

await attempt("unblock a recipient", () => call("unblock_recipient", { recipient: "nfw-vendor-1112.testnet" }));
await attempt("approve a recipient for the agent", () => call("approve_recipient", { agent_id: "1", recipient: "attacker.testnet", per_payment_cap: "1", daily_cap: "1", expires_at: null }));
await attempt("pay as an agent (agent_execute)", () => call("agent_execute", { action: { type: "TransferNear", recipient: "attacker.testnet", amount: parseNear("1").toString() }, request_id: "a".repeat(64), client: null }));
await attempt("pause the owner's payments", () => call("pause", {}));
await attempt("add another guardian", () => call("add_guardian_key", { public_key: "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp", label: "x" }));
await attempt("send NEAR directly", () => guardian.transfer({ receiverId: "attacker.testnet", amount: parseNear("1") }));
await attempt("call a different contract", () => guardian.callFunctionRaw({ contractId: "attacker.testnet", methodName: "guardian_block", args: {}, gas: 30n * TGAS, deposit: 0n, waitUntil: "FINAL" }));

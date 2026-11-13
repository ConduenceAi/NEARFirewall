#!/usr/bin/env node
/**
 * Plays a guardian watcher: signs `guardian_block` with a guardian key, the only
 * thing that key can do. In production a watcher process (for example one that
 * fingerprints a vendor's site) would call this when it detects a hijack.
 *
 *   node scripts/guardian.ts <owner> block <recipient> [reason...] [--label watcher]
 *
 * The key is read from ~/.near-credentials/<network>/<owner>/guardian-<label>.json
 * (created by `scripts/v2-owner.ts <owner> guardian-add`) and never printed.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Account, type KeyPairString } from "near-api-js";
import { TGAS, guardianBlockArgs } from "@nearfirewall/sdk";

const [owner, command, recipient, ...rest] = process.argv.slice(2);
const labelAt = rest.indexOf("--label");
const label = labelAt >= 0 ? (rest[labelAt + 1] ?? "watcher") : "watcher";
const reason = rest.filter((_, i) => i !== labelAt && i !== labelAt + 1).join(" ") || undefined;
if (!owner || command !== "block" || !recipient) {
  console.error("Usage: node scripts/guardian.ts <owner> block <recipient> [reason...] [--label watcher]");
  process.exit(2);
}
const network = owner.endsWith(".near") ? "mainnet" : "testnet";
const rpcUrl = process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com";
const file = join(homedir(), ".near-credentials", network, owner, `guardian-${label}.json`);
const { private_key } = JSON.parse(await readFile(file, "utf8")) as { private_key: string };

const guardian = new Account(owner, rpcUrl, private_key as KeyPairString);
try {
  const response = await guardian.callFunctionRaw({
    contractId: owner,
    methodName: "guardian_block",
    args: guardianBlockArgs(recipient, reason),
    gas: 30n * TGAS,
    deposit: 0n,
    waitUntil: "FINAL",
  });
  const status = response.status as { SuccessValue?: string; Failure?: unknown };
  if (status.Failure) {
    console.error("Refused:", JSON.stringify(status.Failure).slice(0, 300));
    process.exit(1);
  }
  const added = Buffer.from(status.SuccessValue ?? "", "base64").toString("utf8") === "true";
  console.log(`${added ? "Blocked" : "Already blocked"} ${recipient}  tx ${response.transaction.hash}`);
} catch (error) {
  console.error("Refused:", error instanceof Error ? error.message.slice(0, 300) : String(error));
  process.exit(1);
}

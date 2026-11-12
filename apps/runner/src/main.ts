#!/usr/bin/env node
/**
 * NEARFirewall agent runner.
 *
 *   node apps/runner/src/main.ts <scenario.json>            submit every step
 *   node apps/runner/src/main.ts <scenario.json> --preview  dry run with the payer's preview view
 *   node apps/runner/src/main.ts --resolve                  resolve uncertain requests in the journal
 *
 * Optional flags: --executor <account> (also loads its key from the keychain),
 * --agent <handle>, --payer <account>. Settings load from scripts/demo.env when present.
 *
 * Environment: NEARFIREWALL_REGISTRY, NEARFIREWALL_EXECUTOR, NEARFIREWALL_EXECUTOR_KEY
 * (a function-call key restricted to `registry.execute`), NEAR_RPC_URL, NEARFIREWALL_JOURNAL.
 * The key is read from the environment only and is never printed.
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Account, type KeyPairString } from "near-api-js";
import {
  ExecutorClient,
  MemoryJournalStore,
  NearRpc,
  OperationJournal,
  PolicyClient,
  RegistryClient,
  describeReason,
  formatNear,
  newRequestId,
  parseNear,
  type JournalStore,
  type Operation,
  type PayResult,
  type SubmitExecute,
} from "@nearfirewall/sdk";
import { loadDemoEnv } from "./env.ts";
import { parseScenario, readConfig, substitute, type RunnerConfig, type Scenario } from "./scenario.ts";

class FileJournalStore implements JournalStore {
  readonly path: string;
  constructor(path: string) {
    this.path = path;
  }
  async load(): Promise<Operation[]> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as Operation[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
  async save(operations: Operation[]) {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(operations, null, 2));
  }
}

/**
 * Finds the executor's key in the NEAR CLI legacy keychain when it is not given
 * in the environment: ~/.near-credentials/<network>/<executor>/<key>.json, or
 * <executor>.json. The key itself is never printed.
 */
async function keyFromKeychain(config: RunnerConfig): Promise<string | undefined> {
  if (!config.executorId) return undefined;
  const network = config.rpcUrl.includes("mainnet") ? "mainnet" : "testnet";
  const base = join(homedir(), ".near-credentials", network);
  const candidates: string[] = [];
  try {
    const dir = join(base, config.executorId);
    candidates.push(...(await readdir(dir)).filter((f) => f.endsWith(".json")).map((f) => join(dir, f)));
  } catch {
    // No per-key directory.
  }
  candidates.push(join(base, `${config.executorId}.json`));
  for (const file of candidates) {
    try {
      const { private_key } = JSON.parse(await readFile(file, "utf8")) as { private_key?: string };
      if (private_key) return private_key;
    } catch {
      // Try the next file.
    }
  }
  return undefined;
}

async function makeSubmit(config: RunnerConfig): Promise<SubmitExecute> {
  config.executorKey ??= await keyFromKeychain(config);
  if (!config.executorId || !config.executorKey) {
    throw new Error(
      "Set NEARFIREWALL_EXECUTOR (and NEARFIREWALL_EXECUTOR_KEY, or keep the key in ~/.near-credentials) to submit payments, or use --preview.",
    );
  }
  const account = new Account(config.executorId, config.rpcUrl, config.executorKey as KeyPairString);
  return async (args, gas) => {
    const response = await account.callFunctionRaw({
      contractId: config.registryId,
      methodName: "execute",
      args,
      gas,
      deposit: 0n,
      waitUntil: "FINAL",
    });
    return { txHash: response.transaction.hash, status: response.status };
  };
}

function describe(result: PayResult): string {
  const op = result.operation;
  switch (op.state) {
    case "settled":
      return "settled";
    case "denied":
      return `denied ${op.reason}: ${op.reason ? describeReason(op.reason) : ""}`;
    case "failed":
      return "failed: the transfer did not go through and the reservation was released";
    default:
      return `${op.state}${op.detail ? ` (${op.detail})` : ""}`;
  }
}

function matches(expected: string | undefined, op: Operation) {
  if (!expected) return undefined;
  return expected === op.state || expected === op.reason;
}

async function run(scenario: Scenario, config: RunnerConfig, preview: boolean) {
  const rpc = new NearRpc(config.rpcUrl);
  const registry = new RegistryClient(rpc, config.registryId);
  const policy = new PolicyClient(rpc, scenario.payer);
  const agent = await registry.find(scenario.agent);
  if (!agent) throw new Error(`Agent ${scenario.agent} not found in ${config.registryId}`);
  console.log(`${scenario.title}\nagent ${agent.handle} (#${agent.agent_id}), payer ${scenario.payer}\n`);

  if (preview) {
    const path = await registry.getPath(agent.agent_id);
    for (const step of scenario.steps) {
      const result = await policy.preview({
        path,
        executor: agent.executor,
        action: { type: "TransferNear", recipient: step.recipient, amount: parseNear(step.amount) },
        requestId: newRequestId(),
      });
      const verdict = result.allowed ? "would be allowed by the payer" : `would be denied ${result.reason}`;
      console.log(`  ${step.label ?? ""} ${step.amount} NEAR -> ${step.recipient}: ${verdict}`);
    }
    console.log("\nPreview runs the payer's checks against current usage; it does not count earlier steps.");
    return true;
  }

  const submit = await makeSubmit(config);
  const journal = new OperationJournal(new FileJournalStore(config.journalPath));
  const client = new ExecutorClient(submit, journal, (payer) => new PolicyClient(rpc, payer));
  const ids = new Map<string, string>();
  let allMatched = true;

  for (const step of scenario.steps) {
    const base = { payer: scenario.payer, agentId: agent.agent_id, recipient: step.recipient, amount: parseNear(step.amount) };
    let results: PayResult[];
    if (step.duplicateOf) {
      // Bypass the local journal so the payer itself has to reject the reused ID.
      const fresh = new ExecutorClient(submit, new OperationJournal(new MemoryJournalStore()), (p) => new PolicyClient(rpc, p));
      results = [await fresh.pay({ ...base, requestId: ids.get(step.duplicateOf)! })];
    } else {
      const copies = step.parallel ?? 1;
      results = await Promise.all(Array.from({ length: copies }, () => client.pay(base)));
    }
    if (step.label && results[0]) ids.set(step.label, results[0].operation.requestId);
    for (const result of results) {
      const ok = matches(step.expect, result.operation);
      if (ok === false) allMatched = false;
      const mark = ok === undefined ? " " : ok ? "✓" : "✗";
      const tx = result.operation.txHash ? `  tx ${result.operation.txHash}` : "";
      console.log(`${mark} ${(step.label ?? "").padEnd(8)} ${formatNear(base.amount).padStart(6)} NEAR -> ${step.recipient}: ${describe(result)}${tx}`);
    }
  }

  const unresolved = journal.unresolved();
  if (unresolved.length > 0) {
    console.log(`\n${unresolved.length} request(s) are uncertain. Run with --resolve to settle them from chain state.`);
  }
  return allMatched;
}

async function resolveAll(config: RunnerConfig) {
  const rpc = new NearRpc(config.rpcUrl);
  const journal = new OperationJournal(new FileJournalStore(config.journalPath));
  await journal.load();
  const client = new ExecutorClient(await makeSubmit(config), journal, (payer) => new PolicyClient(rpc, payer));
  for (const op of journal.unresolved()) {
    const result = await client.resolve(op.requestId);
    console.log(`${op.requestId.slice(0, 12)}… ${describe(result)}`);
  }
}

/** Returns the value after `--name`, if given. */
function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(argv: string[]) {
  loadDemoEnv();
  // Flags override the environment, which works the same in every shell.
  const executor = flag(argv, "executor");
  if (executor) {
    process.env.NEARFIREWALL_EXECUTOR = executor;
    delete process.env.NEARFIREWALL_EXECUTOR_KEY;
  }
  const agent = flag(argv, "agent");
  if (agent) process.env.NEARFIREWALL_AGENT = agent;
  const payer = flag(argv, "payer");
  if (payer) process.env.NEARFIREWALL_OWNER = payer;
  const config = readConfig(process.env);
  if (argv.includes("--resolve")) return resolveAll(config);
  const valueFlags = new Set(["executor", "agent", "payer"].flatMap((n) => [flag(argv, n)]).filter(Boolean));
  const file = argv.find((a) => !a.startsWith("--") && !valueFlags.has(a));
  if (!file) {
    console.error("Usage: main.ts <scenario.json> [--preview] [--executor <account>] [--agent <handle>] [--payer <account>] | --resolve");
    process.exitCode = 2;
    return;
  }
  const scenario = parseScenario(JSON.parse(substitute(await readFile(file, "utf8"), process.env)));
  const matched = await run(scenario, config, argv.includes("--preview"));
  if (!matched) process.exitCode = 1;
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

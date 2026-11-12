import { z } from "zod";

const nearAmount = z.string().regex(/^\d+(\.\d{1,24})?$/, "amount in NEAR, such as 2.5");

export const ScenarioStep = z.object({
  /** Name shown in the output; also used by `duplicateOf`. */
  label: z.string().optional(),
  recipient: z.string(),
  amount: nearAmount,
  /** Send this many copies at the same time, each with its own request ID. */
  parallel: z.number().int().min(1).max(20).optional(),
  /** Resend the request ID of an earlier step to show the payer rejects it. */
  duplicateOf: z.string().optional(),
  /** What the scenario expects, for the summary: `settled`, or a reason code. */
  expect: z.string().optional(),
});
export type ScenarioStep = z.infer<typeof ScenarioStep>;

export const Scenario = z.object({
  title: z.string(),
  payer: z.string(),
  /** Agent handle or numeric ID. */
  agent: z.string(),
  steps: z.array(ScenarioStep).min(1),
});
export type Scenario = z.infer<typeof Scenario>;

/**
 * Replaces `${OWNER}`, `${AGENT}`, `${VENDOR1}`..`${VENDOR3}`, and `${ATTACKER}` in scenario
 * text with values from the environment, so one scenario works for any demo accounts.
 */
export function substitute(text: string, env: Record<string, string | undefined>): string {
  const vendors = (env.NEARFIREWALL_VENDORS ?? "vendor.testnet,vendor2.testnet,vendor3.testnet").split(",").map((v) => v.trim());
  const vars: Record<string, string | undefined> = {
    OWNER: env.NEARFIREWALL_OWNER ?? "alice.testnet",
    AGENT: env.NEARFIREWALL_AGENT ?? "market-agent",
    VENDOR1: vendors[0],
    VENDOR2: vendors[1],
    VENDOR3: vendors[2],
    ATTACKER: env.NEARFIREWALL_ATTACKER ?? "attacker.testnet",
  };
  return text.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, name: string) => {
    const value = vars[name];
    if (!value) throw new Error(`Scenario uses \${${name}}, which is not set`);
    return value;
  });
}

export function parseScenario(json: unknown): Scenario {
  const scenario = Scenario.parse(json);
  const labels = new Set<string>();
  for (const step of scenario.steps) {
    if (step.duplicateOf && !labels.has(step.duplicateOf)) {
      throw new Error(`duplicateOf "${step.duplicateOf}" must name an earlier step`);
    }
    if (step.label) labels.add(step.label);
  }
  return scenario;
}

export interface RunnerConfig {
  rpcUrl: string;
  registryId: string;
  executorId?: string;
  executorKey?: string;
  journalPath: string;
}

export function readConfig(env: Record<string, string | undefined>): RunnerConfig {
  const registryId = env.NEARFIREWALL_REGISTRY;
  if (!registryId) throw new Error("Set NEARFIREWALL_REGISTRY to the registry account ID.");
  const key = env.NEARFIREWALL_EXECUTOR_KEY;
  if (key !== undefined && !/^ed25519:[1-9A-HJ-NP-Za-km-z]+$/.test(key)) {
    throw new Error("NEARFIREWALL_EXECUTOR_KEY must be an ed25519:... secret key.");
  }
  return {
    rpcUrl: env.NEAR_RPC_URL ?? "https://rpc.testnet.near.org",
    registryId,
    executorId: env.NEARFIREWALL_EXECUTOR,
    executorKey: key,
    journalPath: env.NEARFIREWALL_JOURNAL ?? ".runner/journal.json",
  };
}

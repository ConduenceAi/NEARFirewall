/**
 * A plan is the list of owner actions a template produces. Steps name agents by
 * handle, because IDs and generations only exist once earlier steps have run.
 * `toTransaction` turns one step into a wallet transaction, resolving handles
 * against the registry at the moment the owner signs it.
 */
import {
  createChild,
  registerAgent,
  setAccountDailyCap,
  setMandate,
  setRecord,
  setX402Config,
  setX402Rules,
  approveRecipient,
  RegistryClient,
  type CapX402,
  type Capabilities,
  type RecipientRuleInput,
  type WalletTransaction,
  type X402RulesInput,
} from "@nearfirewall/sdk";

export type PlanStep =
  | {
      kind: "register_agent";
      handle: string;
      executor: string | null;
      capabilities: Capabilities;
      /** The largest x402 payment the agent may request. */
      x402?: CapX402 | null;
      expiresAt?: bigint | null;
      locks?: number;
      description?: string | null;
    }
  | {
      kind: "create_child";
      parentHandle: string;
      label: string;
      executor: string | null;
      capabilities: Capabilities;
      x402?: CapX402 | null;
      expiresAt?: bigint | null;
      locks?: number;
      description?: string | null;
    }
  /** Turns x402 on for the payer, in `asset` (USDC). */
  | { kind: "set_x402_config"; asset: string; accountDailyCap: bigint | null }
  /** The agent's x402 limits. The agent needs a mandate first. */
  | { kind: "set_x402_rules"; agentHandle: string; rules: X402RulesInput }
  | {
      kind: "set_mandate";
      agentHandle: string;
      dailyCap: bigint;
      expiresAt?: bigint | null;
      fixed?: boolean;
      recipients: RecipientRuleInput[];
      confirmAbove?: bigint | null;
    }
  | { kind: "approve_recipient"; agentHandle: string; rule: RecipientRuleInput }
  | { kind: "set_record"; agentHandle: string; key: string; value: string }
  | { kind: "set_account_daily_cap"; cap: bigint | null };

export interface Plan {
  templateId: string;
  templateVersion: number;
  title: string;
  steps: PlanStep[];
}

export interface PlanContext {
  /** Current time in nanoseconds. Passed in so building stays deterministic. */
  now: bigint;
  /** The account that will hold the agents and sign registry steps. */
  owner: string;
  /** The account whose policy pays. Often the same as `owner`. */
  payer: string;
  registryId: string;
}

/** Full handle of a child created by a `create_child` step. */
export function childHandle(step: Extract<PlanStep, { kind: "create_child" }>): string {
  return `${step.label}.${step.parentHandle}`;
}

/** Handles of every agent a plan creates, in order. */
export function createdHandles(plan: Plan): string[] {
  return plan.steps.flatMap((s) =>
    s.kind === "register_agent" ? [s.handle] : s.kind === "create_child" ? [childHandle(s)] : [],
  );
}

export function describeStep(step: PlanStep): string {
  switch (step.kind) {
    case "register_agent":
      return `Register agent ${step.handle}`;
    case "create_child":
      return `Create ${childHandle(step)}`;
    case "set_mandate":
      return `Approve ${step.agentHandle} to pay ${step.recipients.length} recipient(s)`;
    case "approve_recipient":
      return `Approve ${step.rule.recipient} for ${step.agentHandle}`;
    case "set_record":
      return `Set ${step.key} on ${step.agentHandle}`;
    case "set_account_daily_cap":
      return step.cap === null ? "Remove the account-wide daily cap" : "Set the account-wide daily cap";
    case "set_x402_config":
      return "Turn on x402 payments in USDC";
    case "set_x402_rules":
      return `Set ${step.agentHandle}'s x402 limits (${step.rules.sellers.length} approved seller(s)${step.rules.unlisted ? ", a small budget for others" : ""})`;
  }
}

async function agentOrThrow(registry: RegistryClient, handle: string) {
  const agent = await registry.resolve(handle);
  if (!agent) throw new Error(`Agent ${handle} does not exist yet. Run the earlier steps first.`);
  return agent;
}

/** Converts one plan step into a wallet transaction, resolving handles on chain. */
export async function toTransaction(step: PlanStep, ctx: PlanContext, registry: RegistryClient): Promise<WalletTransaction> {
  switch (step.kind) {
    case "register_agent":
      return registerAgent(ctx.registryId, step.handle, step);
    case "create_child": {
      const parent = await agentOrThrow(registry, step.parentHandle);
      return createChild(ctx.registryId, parent.agent_id, step.label, step);
    }
    case "set_mandate": {
      const agent = await agentOrThrow(registry, step.agentHandle);
      const path = await registry.getPath(agent.agent_id);
      return setMandate(ctx.payer, { ...step, agentId: agent.agent_id, path });
    }
    case "approve_recipient": {
      const agent = await agentOrThrow(registry, step.agentHandle);
      return approveRecipient(ctx.payer, agent.agent_id, step.rule);
    }
    case "set_record": {
      const agent = await agentOrThrow(registry, step.agentHandle);
      return setRecord(ctx.registryId, agent.agent_id, step.key, step.value);
    }
    case "set_account_daily_cap":
      return setAccountDailyCap(ctx.payer, step.cap);
    case "set_x402_config":
      return setX402Config(ctx.payer, step.asset, step.accountDailyCap);
    case "set_x402_rules": {
      const agent = await agentOrThrow(registry, step.agentHandle);
      // Pin each approved agent to its current holder, so a later transfer voids the approval.
      const agents = await Promise.all(
        (step.rules.agents ?? []).map(async (a) => {
          if (a.generation != null) return a;
          const payee = await new RegistryClient(registry.rpc, a.registry).getAgent(a.agentId);
          if (!payee) throw new Error(`There is no agent #${a.agentId} in ${a.registry}.`);
          return { ...a, generation: payee.generation };
        }),
      );
      return setX402Rules(ctx.payer, agent.agent_id, { ...step.rules, agents });
    }
  }
}

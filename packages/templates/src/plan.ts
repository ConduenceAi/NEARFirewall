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
  approveRecipient,
  type Capabilities,
  type RegistryClient,
  type RecipientRuleInput,
  type WalletTransaction,
} from "@nearfirewall/sdk";

export type PlanStep =
  | {
      kind: "register_agent";
      handle: string;
      executor: string | null;
      capabilities: Capabilities;
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
      expiresAt?: bigint | null;
      locks?: number;
      description?: string | null;
    }
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
  }
}

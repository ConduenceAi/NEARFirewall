/**
 * Plan validation. It runs before the owner signs and catches mistakes the
 * contracts would reject anyway, or would accept but the owner almost
 * certainly did not intend. The contracts remain the enforcement boundary.
 */
import {
  MAX_DEPTH,
  MAX_RECIPIENTS,
  SUPPORTED_LOCKS,
  formatNear,
  type Capabilities,
  type PolicyClient,
  type RegistryClient,
} from "@nearfirewall/sdk";
import { childHandle, type Plan, type PlanContext, type PlanStep } from "./plan.ts";

export type IssueCode =
  | "RECIPIENT_IS_EXECUTOR"
  | "RECIPIENT_IS_PAYER"
  | "ZERO_CAP"
  | "PER_PAYMENT_ABOVE_DAILY"
  | "DUPLICATE_RECIPIENT"
  | "TOO_MANY_RECIPIENTS"
  | "CHILD_WIDER_THAN_PARENT"
  | "CHILD_OUTLIVES_PARENT"
  | "EXECUTOR_IS_OWNER"
  | "EXPIRY_IN_PAST"
  | "INVALID_LABEL"
  | "UNSUPPORTED_LOCK"
  | "UNSUPPORTED_ACTION"
  | "UNKNOWN_AGENT"
  | "TOO_DEEP"
  | "RULE_ABOVE_CAPABILITY"
  | "SENSITIVE_RECORD"
  | "HANDLE_TAKEN"
  | "PARENT_NOT_HELD"
  | "PARENT_REMOVED"
  | "CAPABILITIES_LOCKED"
  | "PAYMENTS_NOT_ENABLED"
  | "UNKNOWN_CONTRACT"
  | "BUDGET_ABOVE_BALANCE";

export interface ValidationIssue {
  level: "error" | "warning";
  code: IssueCode;
  message: string;
  /** Index of the step the issue belongs to. */
  step?: number;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])$/;
const SENSITIVE_KEY = /salary|wage|ssn|passport|tax|password|secret|private|iban|account-number/i;
const LOOKS_HASHED = /^(0x)?[0-9a-f]{64}$|^(sha256|enc|ipfs|ar):/i;

interface AgentShape {
  capabilities: Capabilities;
  expiresAt: bigint | null;
  executor: string;
  depth: number;
}

function capMax(c: Capabilities): bigint | null {
  return c.transfer_near ? c.transfer_near.max_per_payment : null;
}

function within(inner: Capabilities, outer: Capabilities): boolean {
  const i = capMax(inner);
  const o = capMax(outer);
  return i === null || (o !== null && i <= o);
}

function expiryWithin(inner: bigint | null, outer: bigint | null): boolean {
  if (outer === null) return true;
  return inner !== null && inner <= outer;
}

function finish(issues: ValidationIssue[]): ValidationResult {
  return { ok: !issues.some((i) => i.level === "error"), issues };
}

/** Checks that need no network access. */
export function validatePlan(plan: Plan, ctx: PlanContext): ValidationResult {
  const issues: ValidationIssue[] = [];
  const add = (level: ValidationIssue["level"], code: IssueCode, message: string, step?: number) =>
    issues.push({ level, code, message, step });

  const agents = new Map<string, AgentShape>();
  const executors = new Set<string>();

  plan.steps.forEach((step, i) => {
    switch (step.kind) {
      case "register_agent":
      case "create_child": {
        const handle = step.kind === "register_agent" ? step.handle : childHandle(step);
        const label = step.kind === "register_agent" ? step.handle : step.label;
        if (!LABEL.test(label)) add("error", "INVALID_LABEL", `"${label}" must be 2-32 characters of a-z, 0-9 and '-'.`, i);
        if (step.executor === ctx.owner) {
          add("error", "EXECUTOR_IS_OWNER", "The executor must be a separate account from the owner.", i);
        }
        if (step.locks !== undefined && (step.locks & ~SUPPORTED_LOCKS) !== 0) {
          add("error", "UNSUPPORTED_LOCK", "This release supports only the no-transfer and capability locks.", i);
        }
        if (step.expiresAt != null && step.expiresAt <= ctx.now) {
          add("error", "EXPIRY_IN_PAST", "The expiry must be in the future.", i);
        }
        if (capMax(step.capabilities) === null) {
          add("warning", "UNSUPPORTED_ACTION", `${handle} is not allowed to make any payments.`, i);
        } else if (capMax(step.capabilities) === 0n) {
          add("error", "ZERO_CAP", `${handle} has a zero per-payment capability.`, i);
        }
        let depth = 0;
        if (step.kind === "create_child") {
          const parent = agents.get(step.parentHandle);
          if (parent) {
            depth = parent.depth + 1;
            if (!within(step.capabilities, parent.capabilities)) {
              add("error", "CHILD_WIDER_THAN_PARENT", `${handle} cannot have a higher payment cap than ${step.parentHandle}.`, i);
            }
            if (!expiryWithin(step.expiresAt ?? null, parent.expiresAt)) {
              add("error", "CHILD_OUTLIVES_PARENT", `${handle} cannot expire later than ${step.parentHandle}.`, i);
            }
            if (depth >= MAX_DEPTH) add("error", "TOO_DEEP", `Agent trees can be at most ${MAX_DEPTH} levels deep.`, i);
          }
        }
        executors.add(step.executor);
        agents.set(handle, {
          capabilities: step.capabilities,
          expiresAt: step.expiresAt ?? null,
          executor: step.executor,
          depth,
        });
        break;
      }
      case "set_mandate":
      case "approve_recipient": {
        const rules = step.kind === "set_mandate" ? step.recipients : [step.rule];
        if (step.kind === "set_mandate") {
          if (step.dailyCap <= 0n) add("error", "ZERO_CAP", "The daily budget must be greater than zero.", i);
          if (rules.length > MAX_RECIPIENTS) {
            add("error", "TOO_MANY_RECIPIENTS", `A mandate can approve at most ${MAX_RECIPIENTS} recipients.`, i);
          }
          if (step.expiresAt != null && step.expiresAt <= ctx.now) {
            add("error", "EXPIRY_IN_PAST", "The approval's expiry must be in the future.", i);
          }
        }
        const agent = agents.get(step.agentHandle);
        if (!agent) {
          add("warning", "UNKNOWN_AGENT", `${step.agentHandle} is not created by this plan; it must already exist.`, i);
        }
        const seen = new Set<string>();
        for (const rule of rules) {
          const who = rule.recipient;
          if (seen.has(who)) add("error", "DUPLICATE_RECIPIENT", `${who} is listed twice.`, i);
          seen.add(who);
          if (who === ctx.payer) add("error", "RECIPIENT_IS_PAYER", "The payer cannot approve itself as a recipient.", i);
          if (executors.has(who) || agent?.executor === who) {
            add("error", "RECIPIENT_IS_EXECUTOR", `${who} is an agent executor. An agent must never be able to pay itself.`, i);
          }
          if (rule.perPaymentCap <= 0n || rule.dailyCap <= 0n) {
            add("error", "ZERO_CAP", `${who} needs a per-payment and a daily limit above zero.`, i);
          }
          if (rule.perPaymentCap > rule.dailyCap) {
            add("error", "PER_PAYMENT_ABOVE_DAILY", `${who}'s per-payment limit is above its daily limit.`, i);
          }
          const capability = agent ? capMax(agent.capabilities) : null;
          if (capability !== null && rule.perPaymentCap > capability) {
            add(
              "warning",
              "RULE_ABOVE_CAPABILITY",
              `${who} allows ${formatNear(rule.perPaymentCap)} NEAR per payment, but the agent can only request ${formatNear(capability)} NEAR.`,
              i,
            );
          }
        }
        break;
      }
      case "set_record": {
        if (SENSITIVE_KEY.test(step.key) && !LOOKS_HASHED.test(step.value)) {
          add("warning", "SENSITIVE_RECORD", `Records are public. Store a hash or an encrypted pointer for ${step.key}.`, i);
        }
        break;
      }
      case "set_account_daily_cap":
        if (step.cap !== null && step.cap <= 0n) add("error", "ZERO_CAP", "The account-wide cap must be greater than zero.", i);
        break;
    }
  });
  return finish(issues);
}

export interface LiveClients {
  registry: RegistryClient;
  policy: PolicyClient;
  /** Policy code hash from the deployment manifest. */
  expectedPolicyCodeHash?: string;
}

/** Static checks plus checks against the current chain state. */
export async function validatePlanLive(plan: Plan, ctx: PlanContext, clients: LiveClients): Promise<ValidationResult> {
  const { issues } = validatePlan(plan, ctx);
  const add = (level: ValidationIssue["level"], code: IssueCode, message: string, step?: number) =>
    issues.push({ level, code, message, step });
  const created = new Set<string>();

  for (const [i, step] of plan.steps.entries()) {
    if (step.kind === "register_agent") {
      if (await clients.registry.resolve(step.handle)) add("error", "HANDLE_TAKEN", `The handle ${step.handle} is taken.`, i);
      created.add(step.handle);
    }
    if (step.kind === "create_child") {
      const handle = childHandle(step);
      if (await clients.registry.resolve(handle)) add("error", "HANDLE_TAKEN", `The handle ${handle} is taken.`, i);
      if (!created.has(step.parentHandle)) {
        const parent = await clients.registry.resolve(step.parentHandle);
        if (!parent) {
          add("error", "UNKNOWN_AGENT", `${step.parentHandle} does not exist.`, i);
        } else {
          if (parent.status.state === "removed") add("error", "PARENT_REMOVED", `${step.parentHandle} was removed.`, i);
          if (parent.holder !== ctx.owner) {
            add("warning", "PARENT_NOT_HELD", `${ctx.owner} does not hold ${step.parentHandle}; it must hold an ancestor.`, i);
          }
          if (!within(step.capabilities, parent.capabilities)) {
            add("error", "CHILD_WIDER_THAN_PARENT", `${handle} cannot have a higher payment cap than ${step.parentHandle}.`, i);
          }
          if (!expiryWithin(step.expiresAt ?? null, parent.expires_at)) {
            add("error", "CHILD_OUTLIVES_PARENT", `${handle} cannot expire later than ${step.parentHandle}.`, i);
          }
          if (parent.depth + 1 >= MAX_DEPTH) add("error", "TOO_DEEP", `Agent trees can be at most ${MAX_DEPTH} levels deep.`, i);
        }
      }
      created.add(handle);
    }
    if ((step.kind === "set_mandate" || step.kind === "approve_recipient") && !created.has(step.agentHandle)) {
      if (!(await clients.registry.resolve(step.agentHandle))) {
        add("error", "UNKNOWN_AGENT", `${step.agentHandle} does not exist.`, i);
      }
    }
  }

  const needsPolicy = plan.steps.some((s) => s.kind === "set_mandate" || s.kind === "approve_recipient" || s.kind === "set_account_daily_cap");
  if (needsPolicy) {
    const state = await clients.policy.state(clients.expectedPolicyCodeHash);
    if (state.kind === "none") {
      add("error", "PAYMENTS_NOT_ENABLED", `Payments are not enabled on ${ctx.payer} yet.`);
    } else if (state.kind === "other") {
      add("error", "UNKNOWN_CONTRACT", `${ctx.payer} runs a contract that is not the NEARFirewall policy.`);
    } else {
      const policy = await clients.policy.getPolicy();
      for (const [i, step] of plan.steps.entries()) {
        if (step.kind === "set_mandate" && step.dailyCap > policy.available_balance) {
          add(
            "warning",
            "BUDGET_ABOVE_BALANCE",
            `The daily budget (${formatNear(step.dailyCap)} NEAR) is above the available balance (${formatNear(policy.available_balance)} NEAR).`,
            i,
          );
        }
      }
    }
  }
  return finish(issues);
}

export type { PlanStep };

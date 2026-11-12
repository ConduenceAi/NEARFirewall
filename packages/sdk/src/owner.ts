/**
 * Unsigned owner transactions, in the action format wallets accept through
 * NEAR Connect: `{ receiverId, actions: [{ type, params }] }`.
 *
 * Every owner write attaches 1 yoctoNEAR, so it can only be signed with a
 * full-access key. Function-call keys (such as an agent's executor key) cannot
 * attach deposits.
 */
import { ONE_YOCTO, TGAS, nsToJson, parseNear } from "./amounts.ts";
import type { Action, Capabilities, PathNode } from "./types.ts";

export type WalletAction =
  | {
      type: "FunctionCall";
      params: { methodName: string; args: Record<string, unknown>; gas: string; deposit: string };
    }
  | { type: "DeployContract"; params: { code: Uint8Array } }
  | { type: "UseGlobalContract"; params: { contractIdentifier: { codeHash: string } } };

export interface WalletTransaction {
  receiverId: string;
  actions: WalletAction[];
}

/** Default storage deposit for registering or creating an agent. Unused deposit is refunded. */
export const AGENT_STORAGE_DEPOSIT = parseNear("0.15");
/** Default storage deposit for a record. Unused deposit is refunded. */
export const RECORD_STORAGE_DEPOSIT = parseNear("0.02");

const OWNER_GAS = 30n * TGAS;
const MINT_GAS = 60n * TGAS;
const INIT_GAS = 100n * TGAS;

function call(methodName: string, args: Record<string, unknown>, deposit: bigint, gas = OWNER_GAS): WalletAction {
  return {
    type: "FunctionCall",
    params: { methodName, args: jsonSafe(args) as Record<string, unknown>, gas: gas.toString(), deposit: deposit.toString() },
  };
}

/** Converts bigints to decimal strings for contract JSON arguments. */
export function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object" && !(value instanceof Uint8Array)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonSafe(v)]));
  }
  return value;
}

export function toWireCapabilities(caps: Capabilities): Record<string, unknown> {
  return {
    transfer_near: caps.transfer_near ? { max_per_payment: caps.transfer_near.max_per_payment.toString() } : null,
  };
}

export function toWireAction(action: Action): Record<string, unknown> {
  return { type: action.type, recipient: action.recipient, amount: action.amount.toString() };
}

export function transferCapability(maxPerPayment: bigint): Capabilities {
  return { transfer_near: { max_per_payment: maxPerPayment } };
}

// ------------------------------------------------------------------ registry

export interface AgentInput {
  executor: string;
  capabilities: Capabilities;
  expiresAt?: bigint | null;
  locks?: number;
  description?: string | null;
}

function agentArgs(input: AgentInput) {
  return {
    executor: input.executor,
    capabilities: toWireCapabilities(input.capabilities),
    expires_at: nsToJson(input.expiresAt),
    locks: input.locks ?? null,
    description: input.description ?? null,
  };
}

export function registerAgent(
  registryId: string,
  handle: string,
  input: AgentInput,
  deposit = AGENT_STORAGE_DEPOSIT,
): WalletTransaction {
  return { receiverId: registryId, actions: [call("register_agent", { handle, ...agentArgs(input) }, deposit, MINT_GAS)] };
}

export function createChild(
  registryId: string,
  parentId: string,
  label: string,
  input: AgentInput,
  deposit = AGENT_STORAGE_DEPOSIT,
): WalletTransaction {
  return {
    receiverId: registryId,
    actions: [call("create_child", { parent_id: parentId, label, ...agentArgs(input) }, deposit, MINT_GAS)],
  };
}

function oneYoctoCall(receiverId: string, method: string, args: Record<string, unknown> = {}): WalletTransaction {
  return { receiverId, actions: [call(method, args, ONE_YOCTO)] };
}

export const setExecutor = (registryId: string, agentId: string, executor: string) =>
  oneYoctoCall(registryId, "set_executor", { agent_id: agentId, executor });
export const pauseAgent = (registryId: string, agentId: string) => oneYoctoCall(registryId, "pause", { agent_id: agentId });
export const resumeAgent = (registryId: string, agentId: string) => oneYoctoCall(registryId, "resume", { agent_id: agentId });
export const removeAgent = (registryId: string, agentId: string) =>
  oneYoctoCall(registryId, "remove_agent", { agent_id: agentId });
export const setCapabilities = (registryId: string, agentId: string, capabilities: Capabilities) =>
  oneYoctoCall(registryId, "set_capabilities", { agent_id: agentId, capabilities: toWireCapabilities(capabilities) });
export const extendExpiry = (registryId: string, agentId: string, expiresAt: bigint | null) =>
  oneYoctoCall(registryId, "extend_expiry", { agent_id: agentId, expires_at: nsToJson(expiresAt) });
export const burnLocks = (registryId: string, agentId: string, locks: number) =>
  oneYoctoCall(registryId, "burn_locks", { agent_id: agentId, locks });
export const removeRecord = (registryId: string, agentId: string, key: string) =>
  oneYoctoCall(registryId, "remove_record", { agent_id: agentId, key });
export const transferAgent = (registryId: string, agentId: string, receiverId: string) =>
  oneYoctoCall(registryId, "nft_transfer", { receiver_id: receiverId, token_id: agentId, approval_id: null, memo: null });

export function setRecord(
  registryId: string,
  agentId: string,
  key: string,
  value: string,
  deposit = RECORD_STORAGE_DEPOSIT,
): WalletTransaction {
  return { receiverId: registryId, actions: [call("set_record", { agent_id: agentId, key, value }, deposit)] };
}

// ------------------------------------------------------------------ account policy

export interface RecipientRuleInput {
  recipient: string;
  perPaymentCap: bigint;
  dailyCap: bigint;
  expiresAt?: bigint | null;
}

function wireRule(rule: RecipientRuleInput) {
  return {
    recipient: rule.recipient,
    per_payment_cap: rule.perPaymentCap.toString(),
    daily_cap: rule.dailyCap.toString(),
    expires_at: nsToJson(rule.expiresAt),
  };
}

export type PolicyCode = { code: Uint8Array } | { globalCodeHash: string };

/**
 * Deploys the policy to the payer's own account and initializes it in one
 * transaction. The payer signs it, and the receiver is the payer itself.
 *
 * The `globalCodeHash` form points the account at a published global contract
 * (NEP-591), which avoids locking balance for the code. Whether wallets can
 * sign that action is checked in Phase 0 (spike S2).
 */
export function enablePayments(
  payerId: string,
  registryId: string,
  code: PolicyCode,
  accountDailyCap?: bigint | null,
): WalletTransaction {
  const deploy: WalletAction =
    "code" in code
      ? { type: "DeployContract", params: { code: code.code } }
      : { type: "UseGlobalContract", params: { contractIdentifier: { codeHash: code.globalCodeHash } } };
  return {
    receiverId: payerId,
    actions: [
      deploy,
      call("initialize", { registry: registryId, account_daily_cap: accountDailyCap?.toString() ?? null }, 0n, INIT_GAS),
    ],
  };
}

export interface MandateInput {
  agentId: string;
  path: PathNode[];
  dailyCap: bigint;
  expiresAt?: bigint | null;
  fixed?: boolean;
  recipients: RecipientRuleInput[];
}

export function setMandate(payerId: string, input: MandateInput): WalletTransaction {
  return oneYoctoCall(payerId, "set_mandate", {
    agent_id: input.agentId,
    path: input.path.map((n) => ({ agent_id: n.agent_id, generation: Number(n.generation) })),
    daily_cap: input.dailyCap.toString(),
    expires_at: nsToJson(input.expiresAt),
    fixed: input.fixed ?? false,
    recipients: input.recipients.map(wireRule),
  });
}

export function approveRecipient(payerId: string, agentId: string, rule: RecipientRuleInput): WalletTransaction {
  return oneYoctoCall(payerId, "approve_recipient", { agent_id: agentId, ...wireRule(rule) });
}

export const removeRecipient = (payerId: string, agentId: string, recipient: string) =>
  oneYoctoCall(payerId, "remove_recipient", { agent_id: agentId, recipient });
export const revokeMandate = (payerId: string, agentId: string) =>
  oneYoctoCall(payerId, "revoke_mandate", { agent_id: agentId });
export const pausePayments = (payerId: string) => oneYoctoCall(payerId, "pause");
export const resumePayments = (payerId: string) => oneYoctoCall(payerId, "resume");
export const setAccountDailyCap = (payerId: string, cap: bigint | null) =>
  oneYoctoCall(payerId, "set_account_daily_cap", { cap: cap === null ? null : cap.toString() });

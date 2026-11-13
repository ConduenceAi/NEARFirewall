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
  | { type: "UseGlobalContract"; params: { contractIdentifier: { codeHash: string } } }
  | { type: "CreateAccount" }
  | { type: "Transfer"; params: { deposit: string } }
  | {
      type: "AddKey";
      params: {
        publicKey: string;
        // Always a function-call permission with an explicit allowance and method list.
        // A full-access permission is deliberately not representable here.
        accessKey: { permission: { receiverId: string; allowance: string; methodNames: string[] } };
      };
    }
  | { type: "DeleteKey"; params: { publicKey: string } };

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
const CONFIRM_GAS = 120n * TGAS;

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
  /** Executor account for the registry's `execute`. Leave empty for agents that act only through connection keys. */
  executor?: string | null;
  capabilities: Capabilities;
  expiresAt?: bigint | null;
  locks?: number;
  description?: string | null;
}

function agentArgs(input: AgentInput) {
  return {
    executor: input.executor || null,
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
  /** Payments to this recipient above this amount wait for the owner ("ask me first"). */
  confirmAbove?: bigint | null;
}

function wireRule(rule: RecipientRuleInput) {
  return {
    recipient: rule.recipient,
    per_payment_cap: rule.perPaymentCap.toString(),
    daily_cap: rule.dailyCap.toString(),
    expires_at: nsToJson(rule.expiresAt),
    confirm_above: rule.confirmAbove == null ? null : rule.confirmAbove.toString(),
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
  /** Payments by this branch above this amount wait for the owner ("ask me first"). */
  confirmAbove?: bigint | null;
}

export function setMandate(payerId: string, input: MandateInput): WalletTransaction {
  return oneYoctoCall(payerId, "set_mandate", {
    agent_id: input.agentId,
    path: input.path.map((n) => ({ agent_id: n.agent_id, generation: Number(n.generation) })),
    daily_cap: input.dailyCap.toString(),
    expires_at: nsToJson(input.expiresAt),
    fixed: input.fixed ?? false,
    recipients: input.recipients.map(wireRule),
    confirm_above: input.confirmAbove == null ? null : input.confirmAbove.toString(),
  });
}

export function approveRecipient(payerId: string, agentId: string, rule: RecipientRuleInput): WalletTransaction {
  const { confirm_above: _ignored, ...args } = wireRule(rule);
  return oneYoctoCall(payerId, "approve_recipient", { agent_id: agentId, ...args });
}

/** Sets the "ask me first" threshold of a mandate, or of one recipient. `null` removes it. */
export function setConfirmAbove(payerId: string, agentId: string, amount: bigint | null, recipient?: string): WalletTransaction {
  return oneYoctoCall(payerId, "set_confirm_above", {
    agent_id: agentId,
    recipient: recipient ?? null,
    amount: amount === null ? null : amount.toString(),
  });
}

/** Confirms a payment waiting for the owner. The registry checks the agent again, then it is sent. */
export function confirmPayment(payerId: string, agentId: string, requestId: string, expectedRevision?: number): WalletTransaction {
  return { receiverId: payerId, actions: [call("confirm", { agent_id: agentId, request_id: requestId, expected_revision: expectedRevision ?? null }, ONE_YOCTO, CONFIRM_GAS)] };
}

export const declinePayment = (payerId: string, agentId: string, requestId: string) =>
  oneYoctoCall(payerId, "decline", { agent_id: agentId, request_id: requestId });

/** Anyone may expire a waiting payment after its deadline; no deposit needed. */
export function expirePayment(payerId: string, agentId: string, requestId: string): WalletTransaction {
  return { receiverId: payerId, actions: [call("expire", { agent_id: agentId, request_id: requestId }, 0n)] };
}

// ------------------------------------------------------------------ owner's registry

/** Storage deposit for a registry that points at shared (global) code. */
export const REGISTRY_DEPOSIT_GLOBAL = parseNear("0.3");
/** Storage deposit for a registry with its own copy of the code (about 340 KB). */
export const REGISTRY_DEPOSIT_DIRECT = parseNear("3.6");

/**
 * Creates the owner's registry on `agents.<owner>` in one transaction signed by
 * the owner: create the account, fund its storage, deploy the code, and
 * initialize it with the owner. No key is added, so nobody can change its code.
 */
export function createRegistry(
  ownerId: string,
  registryId: string,
  code: PolicyCode,
  deposit = "code" in code ? REGISTRY_DEPOSIT_DIRECT : REGISTRY_DEPOSIT_GLOBAL,
): WalletTransaction {
  if (!registryId.endsWith(`.${ownerId}`)) throw new Error(`${registryId} must be a sub-account of ${ownerId}`);
  const deploy: WalletAction =
    "code" in code
      ? { type: "DeployContract", params: { code: code.code } }
      : { type: "UseGlobalContract", params: { contractIdentifier: { codeHash: code.globalCodeHash } } };
  return {
    receiverId: registryId,
    actions: [
      { type: "CreateAccount" },
      { type: "Transfer", params: { deposit: deposit.toString() } },
      deploy,
      call("new", { owner: ownerId }, 0n, INIT_GAS),
    ],
  };
}

// ------------------------------------------------------------------ connections

/** Default gas allowance for a connection key: it only pays network fees. */
export const CONNECTION_ALLOWANCE = parseNear("0.25");

export interface ConnectionInput {
  agentId: string;
  /** The new key's public key, `ed25519:…`. Generate it fresh for every connection. */
  publicKey: string;
  /** Platform id from the catalog, for example `claude-desktop`. */
  platform: string;
  label: string;
  allowance?: bigint;
}

/**
 * Adds a connection key to the owner's own account and records which agent it
 * acts for, in one transaction. The key can call only `agent_execute` on the
 * owner's account, cannot attach a deposit, and spends at most `allowance` on fees.
 */
export function connectAgentKey(ownerId: string, input: ConnectionInput): WalletTransaction {
  if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(input.publicKey)) throw new Error("Expected an ed25519 public key");
  const allowance = input.allowance ?? CONNECTION_ALLOWANCE;
  if (allowance <= 0n) throw new Error("The allowance must be above zero");
  return {
    receiverId: ownerId,
    actions: [
      {
        type: "AddKey",
        params: {
          publicKey: input.publicKey,
          accessKey: { permission: { receiverId: ownerId, allowance: allowance.toString(), methodNames: ["agent_execute"] } },
        },
      },
      call(
        "connect_agent_key",
        { agent_id: input.agentId, public_key: input.publicKey, platform: input.platform, label: input.label },
        ONE_YOCTO,
      ),
    ],
  };
}

/**
 * Removes a connection. Deletes the key too, unless it is already gone
 * (`keyPresent: false`), because deleting a missing key fails the transaction.
 */
export function disconnectAgentKey(ownerId: string, publicKey: string, opts: { keyPresent: boolean } = { keyPresent: true }): WalletTransaction {
  const actions: WalletAction[] = [call("disconnect_agent_key", { public_key: publicKey }, ONE_YOCTO)];
  if (opts.keyPresent) actions.push({ type: "DeleteKey", params: { publicKey } });
  return { receiverId: ownerId, actions };
}

export const removeRecipient = (payerId: string, agentId: string, recipient: string) =>
  oneYoctoCall(payerId, "remove_recipient", { agent_id: agentId, recipient });
export const revokeMandate = (payerId: string, agentId: string) =>
  oneYoctoCall(payerId, "revoke_mandate", { agent_id: agentId });
export const pausePayments = (payerId: string) => oneYoctoCall(payerId, "pause");
export const resumePayments = (payerId: string) => oneYoctoCall(payerId, "resume");
export const setAccountDailyCap = (payerId: string, cap: bigint | null) =>
  oneYoctoCall(payerId, "set_account_daily_cap", { cap: cap === null ? null : cap.toString() });

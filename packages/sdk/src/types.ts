import { z } from "zod";

/** Decimal string of a u128, decoded to bigint. */
export const U128 = z
  .string()
  .regex(/^\d+$/, "expected a decimal integer string")
  .transform((s) => BigInt(s));

/** Decimal string of a u64 (JSON `U64`), decoded to bigint. */
export const U64 = U128;

/** A plain JSON number used for u64 fields that near-sdk serializes as numbers. */
export const NumU64 = z.union([z.number(), z.string().regex(/^\d+$/)]).transform((v) => BigInt(v));

export const AccountId = z.string().min(2).max(64);

export const REASONS = [
  "AGENT_NOT_FOUND",
  "AGENT_REMOVED",
  "AGENT_PAUSED",
  "AGENT_EXPIRED",
  "BRANCH_PAUSED",
  "BRANCH_REMOVED",
  "BRANCH_EXPIRED",
  "EXECUTOR_MISMATCH",
  "ACTION_NOT_ALLOWED",
  "CAP_EXCEEDED",
  "PAYER_NOT_AUTHORIZED",
  "INVALID_REQUEST",
  "UNTRUSTED_CALLER",
  "PAYMENTS_PAUSED",
  "DUPLICATE_REQUEST",
  "REVISION_MISMATCH",
  "NO_MANDATE",
  "MANDATE_STALE",
  "MANDATE_REVOKED",
  "MANDATE_EXPIRED",
  "RECIPIENT_NOT_APPROVED",
  "RECIPIENT_RULE_EXPIRED",
  "PER_PAYMENT_CAP",
  "RECIPIENT_DAILY_CAP",
  "MANDATE_DAILY_CAP",
  "ACCOUNT_DAILY_CAP",
  "INSUFFICIENT_BALANCE",
  "UNKNOWN_CONNECTION",
  "AUTHORIZATION_FAILED",
  "CONFIRMATION_DECLINED",
  "CONFIRMATION_EXPIRED",
  "TOO_MANY_PENDING",
  "RECIPIENT_BLOCKED",
  "X402_NOT_ENABLED",
  "ASSET_NOT_ACCEPTED",
  "UNLISTED_DAILY_CAP",
] as const;
export const Reason = z.enum(REASONS);
export type Reason = z.infer<typeof Reason>;

export const TransferNear = z.object({
  type: z.literal("TransferNear"),
  recipient: AccountId,
  amount: U128,
});
/**
 * Fund one x402 payment: the policy checks `pay_to` (the seller) and `amount`
 * (in the token's smallest unit) and moves exactly that much of `asset` to the
 * connection's x402 payment account, which then pays the seller.
 */
export const X402Pay = z.object({
  type: z.literal("X402Pay"),
  asset: AccountId,
  pay_to: AccountId,
  amount: U128,
});
export const Action = z.discriminatedUnion("type", [TransferNear, X402Pay]);
export type Action = z.infer<typeof Action>;

export const Capabilities = z.object({
  transfer_near: z.object({ max_per_payment: U128 }).nullable().optional(),
});
export type Capabilities = z.infer<typeof Capabilities>;

/** The largest x402 payment an agent may request, in the token's smallest unit. */
export const CapX402 = z.object({ max_per_payment: U128 });
export type CapX402 = z.infer<typeof CapX402>;

export const PathNode = z.object({ agent_id: z.string(), generation: NumU64 });
export type PathNode = z.infer<typeof PathNode>;

export const Outcome = z.discriminatedUnion("status", [
  z.object({ status: z.literal("settled"), request_id: z.string() }),
  z.object({ status: z.literal("failed"), request_id: z.string() }),
  z.object({ status: z.literal("denied"), reason: Reason, detail: z.string().nullable().optional() }),
  z.object({ status: z.literal("awaiting_confirmation"), request_id: z.string(), expires_at: NumU64 }),
]);
export type Outcome = z.infer<typeof Outcome>;

export const AgentStatus = z.discriminatedUnion("state", [
  z.object({ state: z.literal("active") }),
  z.object({ state: z.literal("paused"), by_depth: z.number() }),
  z.object({ state: z.literal("removed") }),
]);
export type AgentStatus = z.infer<typeof AgentStatus>;

export const AgentView = z.object({
  agent_id: z.string(),
  handle: z.string(),
  holder: AccountId.nullable(),
  parent: z.string().nullable(),
  ancestors: z.array(z.string()),
  depth: z.number(),
  executor: AccountId.nullable(),
  capabilities: Capabilities,
  /** Absent on registries deployed before x402. */
  x402: CapX402.nullable().optional(),
  status: AgentStatus,
  expires_at: U64.nullable(),
  locks: z.number(),
  generation: U64,
  created_at: U64,
});
export type AgentView = z.infer<typeof AgentView>;

export const RecordEntry = z.object({ key: z.string(), value: z.string() });
export type RecordEntry = z.infer<typeof RecordEntry>;

export const RegistryActivity = z.object({
  seq: NumU64,
  at: NumU64,
  payer: AccountId,
  request_id: z.string(),
  action: Action,
  outcome: z.enum(["routed", "denied"]),
  reason: Reason.nullable(),
});
export type RegistryActivity = z.infer<typeof RegistryActivity>;

export const RecipientRule = z.object({
  per_payment_cap: U128,
  daily_cap: U128,
  expires_at: NumU64.nullable(),
  /** Payments to this recipient above this amount wait for the owner ("ask me first"). */
  confirm_above: U128.nullable().optional(),
});
export type RecipientRule = z.infer<typeof RecipientRule>;

export const Mandate = z.object({
  path: z.array(PathNode),
  status: z.enum(["Active", "Revoked"]),
  fixed: z.boolean(),
  expires_at: NumU64.nullable(),
  daily_cap: U128,
  recipients: z.record(z.string(), RecipientRule),
  /** Payments by this branch above this amount wait for the owner ("ask me first"). */
  confirm_above: U128.nullable().optional(),
});
export type Mandate = z.infer<typeof Mandate>;

export const PolicyView = z.object({
  account: AccountId,
  registry: AccountId,
  paused: z.boolean(),
  revision: NumU64,
  account_daily_cap: U128.nullable(),
  account_used_today: U128,
  safety_buffer: U128,
  reserved_total: U128,
  available_balance: U128,
  day: NumU64,
  connections: z.number().optional(),
  pending: z.number().optional(),
  blocked: z.number().optional(),
  guardians: z.number().optional(),
});
export type PolicyView = z.infer<typeof PolicyView>;

export const UsageView = z.object({
  day: NumU64,
  mandate_used_today: U128,
  recipient_used_today: U128.nullable(),
  account_used_today: U128,
});
export type UsageView = z.infer<typeof UsageView>;

/**
 * How a request reached the policy. For `x402`, the record's recipient is the
 * seller and its amount is in the x402 token (USDC), not NEAR.
 */
export const Via = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("executor"), account: AccountId }),
  z.object({ kind: z.literal("connection"), public_key: z.string(), label: z.string() }),
  z.object({ kind: z.literal("x402"), public_key: z.string(), label: z.string(), payment_account: AccountId }),
]);
export type Via = z.infer<typeof Via>;

/** True when a record's amount is in the x402 token rather than NEAR. */
export function isX402(via: Via | null | undefined): boolean {
  return via?.kind === "x402";
}

/** Account-wide x402 settings. */
export const X402Config = z.object({
  /** The token sellers are paid in: the USDC contract on this network. */
  asset: AccountId,
  account_daily_cap: U128.nullable(),
});
export type X402Config = z.infer<typeof X402Config>;

export const X402Limit = z.object({ per_payment_cap: U128, daily_cap: U128 });
export type X402Limit = z.infer<typeof X402Limit>;

/** The x402 limits on one mandate, in the token's smallest unit. */
export const X402Rules = z.object({
  /** Shared daily pool for x402 payments by the mandate's branch. */
  daily_cap: U128,
  /** Sellers the owner approved, each with its own limits. */
  sellers: z.record(z.string(), X402Limit),
  /** Any seller not listed: a per-payment cap and one daily pool shared by all of them. */
  unlisted: X402Limit.nullable(),
});
export type X402Rules = z.infer<typeof X402Rules>;

export const X402UsageView = z.object({
  day: NumU64,
  mandate_used_today: U128,
  seller_used_today: U128.nullable(),
  unlisted_used_today: U128,
  account_used_today: U128,
});
export type X402UsageView = z.infer<typeof X402UsageView>;

export const PaymentRequestRecord = z.object({
  leaf: z.string(),
  request_id: z.string(),
  recipient: AccountId,
  amount: U128,
  day: NumU64,
  created_at: NumU64,
  status: z.enum(["Pending", "Settled", "Failed", "Declined", "Expired"]),
  mandates: z.array(z.string()),
  via: Via.nullable().optional(),
  client: z.string().nullable().optional(),
});
export type PaymentRequestRecord = z.infer<typeof PaymentRequestRecord>;

export const PolicyActivity = z.object({
  seq: NumU64,
  at: NumU64,
  leaf: z.string(),
  request_id: z.string(),
  recipient: AccountId,
  amount: U128,
  outcome: z.enum(["settled", "failed", "denied", "awaiting", "declined", "expired"]),
  reason: Reason.nullable(),
  via: Via.nullable().optional(),
  client: z.string().nullable().optional(),
});
export type PolicyActivity = z.infer<typeof PolicyActivity>;

export const Preview = z.object({
  allowed: z.boolean(),
  reason: Reason.nullable(),
  mandates: z.array(z.string()),
  needs_confirmation: z.boolean().optional(),
});

/** An agent key on the owner's account and the agent it acts for. */
export const Connection = z.object({
  public_key: z.string(),
  agent_id: z.string(),
  platform: z.string(),
  label: z.string(),
  created_at: NumU64,
  last_used: NumU64.nullable(),
  uses: z.number(),
});
export type Connection = z.infer<typeof Connection>;

/** An account no agent may pay. `by` is `owner` or `guardian:<label>`. */
export const BlockedRecipient = z.object({
  recipient: AccountId,
  at: NumU64,
  by: z.string(),
  reason: z.string().nullable().optional(),
});
export type BlockedRecipient = z.infer<typeof BlockedRecipient>;

/** A watcher key that can add to the blocklist and do nothing else. */
export const Guardian = z.object({
  public_key: z.string(),
  label: z.string(),
  created_at: NumU64,
  last_used: NumU64.nullable(),
  blocks: z.number(),
});
export type Guardian = z.infer<typeof Guardian>;

/** A payment waiting for the owner ("ask me first"). */
export const PendingConfirmation = z.object({
  leaf: z.string(),
  request_id: z.string(),
  recipient: AccountId,
  amount: U128,
  day: NumU64,
  created_at: NumU64,
  expires_at: NumU64,
  path: z.array(PathNode),
  mandates: z.array(z.string()),
  via: Via.nullable().optional(),
  client: z.string().nullable().optional(),
});
export type PendingConfirmation = z.infer<typeof PendingConfirmation>;
export type Preview = z.infer<typeof Preview>;

/** Lock bits, matching the registry contract. */
export const LOCKS = {
  NO_TRANSFER: 1 << 0,
  NO_CAPABILITY_RAISE: 1 << 1,
} as const;
export const SUPPORTED_LOCKS = LOCKS.NO_TRANSFER | LOCKS.NO_CAPABILITY_RAISE;

export const MAX_DEPTH = 8;
/** The only method a connection key may call on the owner's account. */
export const AGENT_EXECUTE_METHOD = "agent_execute";
/** The only method a guardian key may call on the owner's account. */
export const GUARDIAN_BLOCK_METHOD = "guardian_block";
/** The registry account for an owner: a sub-account of the owner's own account. */
export function registryAccountFor(owner: string): string {
  return `agents.${owner}`;
}
export const MAX_RECIPIENTS = 50;

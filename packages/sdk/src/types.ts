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
] as const;
export const Reason = z.enum(REASONS);
export type Reason = z.infer<typeof Reason>;

export const TransferNear = z.object({
  type: z.literal("TransferNear"),
  recipient: AccountId,
  amount: U128,
});
export const Action = z.discriminatedUnion("type", [TransferNear]);
export type Action = z.infer<typeof Action>;

export const Capabilities = z.object({
  transfer_near: z.object({ max_per_payment: U128 }).nullable().optional(),
});
export type Capabilities = z.infer<typeof Capabilities>;

export const PathNode = z.object({ agent_id: z.string(), generation: NumU64 });
export type PathNode = z.infer<typeof PathNode>;

export const Outcome = z.discriminatedUnion("status", [
  z.object({ status: z.literal("settled"), request_id: z.string() }),
  z.object({ status: z.literal("failed"), request_id: z.string() }),
  z.object({ status: z.literal("denied"), reason: Reason, detail: z.string().nullable().optional() }),
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
  executor: AccountId,
  capabilities: Capabilities,
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
});
export type RecipientRule = z.infer<typeof RecipientRule>;

export const Mandate = z.object({
  path: z.array(PathNode),
  status: z.enum(["Active", "Revoked"]),
  fixed: z.boolean(),
  expires_at: NumU64.nullable(),
  daily_cap: U128,
  recipients: z.record(z.string(), RecipientRule),
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
});
export type PolicyView = z.infer<typeof PolicyView>;

export const UsageView = z.object({
  day: NumU64,
  mandate_used_today: U128,
  recipient_used_today: U128.nullable(),
  account_used_today: U128,
});
export type UsageView = z.infer<typeof UsageView>;

export const PaymentRequestRecord = z.object({
  leaf: z.string(),
  request_id: z.string(),
  recipient: AccountId,
  amount: U128,
  day: NumU64,
  created_at: NumU64,
  status: z.enum(["Pending", "Settled", "Failed"]),
  mandates: z.array(z.string()),
});
export type PaymentRequestRecord = z.infer<typeof PaymentRequestRecord>;

export const PolicyActivity = z.object({
  seq: NumU64,
  at: NumU64,
  leaf: z.string(),
  request_id: z.string(),
  recipient: AccountId,
  amount: U128,
  outcome: z.enum(["settled", "failed", "denied"]),
  reason: Reason.nullable(),
});
export type PolicyActivity = z.infer<typeof PolicyActivity>;

export const Preview = z.object({
  allowed: z.boolean(),
  reason: Reason.nullable(),
  mandates: z.array(z.string()),
});
export type Preview = z.infer<typeof Preview>;

/** Lock bits, matching the registry contract. */
export const LOCKS = {
  NO_TRANSFER: 1 << 0,
  NO_CAPABILITY_RAISE: 1 << 1,
} as const;
export const SUPPORTED_LOCKS = LOCKS.NO_TRANSFER | LOCKS.NO_CAPABILITY_RAISE;

export const MAX_DEPTH = 8;
export const MAX_RECIPIENTS = 50;

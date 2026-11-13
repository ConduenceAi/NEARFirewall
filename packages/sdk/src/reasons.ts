import type { Reason } from "./types.ts";

/** Plain-language explanations of every reason code, for apps and logs. */
export const REASON_TEXT: Record<Reason, string> = {
  AGENT_NOT_FOUND: "No agent has this ID.",
  AGENT_REMOVED: "The agent was removed.",
  AGENT_PAUSED: "The agent is paused.",
  AGENT_EXPIRED: "The agent has expired.",
  BRANCH_PAUSED: "An agent above this one is paused, which pauses its whole branch.",
  BRANCH_REMOVED: "An agent above this one was removed.",
  BRANCH_EXPIRED: "An agent above this one has expired.",
  EXECUTOR_MISMATCH: "The request did not come from the agent's executor.",
  ACTION_NOT_ALLOWED: "The agent is not allowed to request this action.",
  CAP_EXCEEDED: "The amount is above the agent's per-payment capability.",
  PAYER_NOT_AUTHORIZED: "The payer does not hold the agent making this request.",
  INVALID_REQUEST: "The request is malformed.",
  UNTRUSTED_CALLER: "The payment policy only accepts requests from its trusted registry.",
  PAYMENTS_PAUSED: "The payer has paused agent payments.",
  DUPLICATE_REQUEST: "This request ID was already used.",
  REVISION_MISMATCH: "The payer's policy changed since the agent last read it.",
  NO_MANDATE: "The payer has not approved this agent or any agent above it.",
  MANDATE_STALE: "The agent or an agent above it changed holder or executor since the payer approved it.",
  MANDATE_REVOKED: "The payer revoked this approval.",
  MANDATE_EXPIRED: "The payer's approval has expired.",
  RECIPIENT_NOT_APPROVED: "The payer has not approved this recipient for the agent.",
  RECIPIENT_RULE_EXPIRED: "The approval for this recipient has expired.",
  PER_PAYMENT_CAP: "The amount is above this recipient's per-payment limit.",
  RECIPIENT_DAILY_CAP: "This payment would exceed the recipient's daily limit.",
  MANDATE_DAILY_CAP: "This payment would exceed the agent's daily budget.",
  ACCOUNT_DAILY_CAP: "This payment would exceed the account's daily limit across all agents.",
  INSUFFICIENT_BALANCE: "The account does not have enough available balance.",
  UNKNOWN_CONNECTION: "This key is not a connected agent key on the account.",
  AUTHORIZATION_FAILED: "The registry could not be reached to check the agent, so nothing was sent.",
  CONFIRMATION_DECLINED: "The owner declined this payment, or a recheck at confirmation refused it.",
  CONFIRMATION_EXPIRED: "Nobody confirmed this payment in time, so it was released.",
  TOO_MANY_PENDING: "Too many payments are already waiting for the owner's confirmation.",
  RECIPIENT_BLOCKED: "This recipient is on the owner's blocklist, so no agent may pay it.",
};

export function describeReason(reason: Reason): string {
  return REASON_TEXT[reason];
}

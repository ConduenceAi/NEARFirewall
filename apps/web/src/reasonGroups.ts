/** Reader-facing grouping of the SDK's reason codes, used by the docs page. */
export interface ReasonGroup {
  title: string;
  items: { text: string; fix: string }[];
}

export const REASON_GROUPS: ReasonGroup[] = [
  {
    title: "Stopped by the registry (never reached your account)",
    items: [
      { text: "The agent or a parent is paused", fix: "Resume it in Agents." },
      { text: "The agent or a parent expired or was removed", fix: "Register a new agent, or create one under a live parent." },
      { text: "The request did not come from the agent's executor", fix: "Check the key and account the runner uses." },
      { text: "The amount is above the agent's per-payment capability", fix: "Lower the request, or register the agent with a higher capability." },
      { text: "The payer does not hold the agent", fix: "Only the agent's holder can make it pay from their account." },
    ],
  },
  {
    title: "Stopped by your account's policy",
    items: [
      { text: "The payer has paused agent payments", fix: "Resume payments in Payments." },
      { text: "The payer has not approved this agent", fix: "Approve the agent and its recipients in Payments." },
      { text: "The approval is stale, revoked or expired", fix: "Approve again. A transfer or executor change makes older approvals stale." },
      { text: "The recipient is not approved, or its approval expired", fix: "Approve the recipient with its own limits." },
      { text: "Above the recipient's per-payment limit", fix: "Lower the amount, or raise that recipient's limit." },
      { text: "Over the recipient's daily limit", fix: "Wait for 00:00 UTC, or raise the recipient's daily limit." },
      { text: "Over the agent's daily budget", fix: "Wait for the next UTC day, or raise the budget." },
      { text: "Over the account's daily cap", fix: "Wait for the next UTC day, or change the account cap." },
      { text: "Not enough available balance", fix: "Top up the account. Balance reserved for storage is not available to agents." },
      { text: "The policy changed since the agent last read it, or the request ID was reused", fix: "The agent should read the policy again and retry with a new request." },
    ],
  },
];

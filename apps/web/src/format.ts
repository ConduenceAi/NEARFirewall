import { formatNear, formatUsdc, isX402, type AgentView, type Capabilities, type Via } from "@nearfirewall/sdk";

export const near = (yocto: bigint) => `${formatNear(yocto)} NEAR`;

/** An activity amount: USDC for x402 payments, NEAR otherwise. */
export const amountText = (entry: { amount: bigint; via?: Via | null }) =>
  isX402(entry.via) ? `${formatUsdc(entry.amount)} USDC (x402)` : near(entry.amount);

export function capText(caps: Capabilities): string {
  return caps.transfer_near ? `up to ${near(caps.transfer_near.max_per_payment)} per payment` : "no payments";
}

export function statusText(agent: AgentView): string {
  switch (agent.status.state) {
    case "active":
      return "Active";
    case "paused":
      return agent.status.by_depth < agent.depth ? "Paused by a parent" : "Paused";
    case "removed":
      return "Removed";
  }
}

export function timeText(ns: bigint | null | undefined): string {
  if (ns === null || ns === undefined) return "never";
  return new Date(Number(ns / 1_000_000n)).toLocaleString();
}

/** Throws when a wallet result reports a failure, so actions surface it. */
export function ensureOk<T extends { failure?: string }>(result: T): T {
  if (result.failure) throw new Error(result.failure);
  return result;
}

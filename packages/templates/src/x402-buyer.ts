import { z } from "zod";
import { DAY_NS, LOCKS, USDC_CONTRACT, parseUsdc, x402Capability } from "@nearfirewall/sdk";
import type { Plan, PlanStep } from "./plan.ts";
import type { Template } from "./template.ts";

const usdcAmount = z.string().regex(/^\d+(\.\d{1,6})?$/, "Enter an amount in USDC, such as 0.05");
const accountId = z
  .string()
  .min(2)
  .max(64)
  .regex(/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/, "Enter a valid NEAR account ID");
const label = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])$/, "2-32 characters of a-z, 0-9 and '-'");

export const X402BuyerInput = z.object({
  handle: label,
  description: z.string().max(512).optional(),
  network: z.enum(["testnet", "mainnet"]).default("testnet"),
  /** Largest single x402 payment the agent may ever request. */
  maxPerPayment: usdcAmount,
  /** Daily x402 budget across every seller. */
  dailyBudget: usdcAmount,
  /** Seller accounts approved by name, each with its own limits. */
  sellers: z
    .array(z.object({ seller: accountId, perPayment: usdcAmount, daily: usdcAmount }))
    .max(50)
    .default([]),
  /** Websites approved by host, such as api.example.com. `payTo` pins the account the site must be paid at. */
  sites: z
    .array(
      z.object({
        site: z.string().regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$/, "Enter a host such as api.example.com").max(128),
        perPayment: usdcAmount,
        daily: usdcAmount,
        payTo: accountId.optional(),
      }),
    )
    .max(50)
    .default([]),
  /** Other agents approved by their NFT. Each is pinned to its current holder when the plan is signed. */
  agents: z
    .array(z.object({ registry: accountId, agentId: z.string().regex(/^\d{1,20}$/, "An agent ID such as 7"), perPayment: usdcAmount, daily: usdcAmount }))
    .max(50)
    .default([]),
  /**
   * Any other seller: a small per-payment cap and one daily pool shared by all
   * of them. Leave out to refuse sellers that are not listed.
   */
  unlisted: z.object({ perPayment: usdcAmount, daily: usdcAmount }).nullable().default({ perPayment: "0.05", daily: "0.25" }),
  /** Optional cap on every agent's x402 payments together, per day. */
  accountDailyCap: usdcAmount.optional(),
  /** Leave false when x402 is already on for the account. */
  turnOnX402: z.boolean().default(true),
  expiresInDays: z.number().int().positive().optional(),
  nonTransferable: z.boolean().default(true),
});
export type X402BuyerInput = z.infer<typeof X402BuyerInput>;

/**
 * An agent that buys from x402 sellers in USDC: approved sellers with their own
 * limits, a small shared budget for any other seller, and a daily cap. It has
 * no NEAR budget. Connect it, then set up its key's x402 payment account.
 */
export const x402Buyer: Template<X402BuyerInput> = {
  id: "x402-buyer",
  version: 1,
  title: "x402 buyer",
  description: "An agent that pays x402 sellers in USDC: approved sellers with their own limits, and a small daily budget for anyone else.",
  input: X402BuyerInput,
  defaults: {
    network: "testnet",
    sellers: [],
    sites: [],
    agents: [],
    unlisted: { perPayment: "0.05", daily: "0.25" },
    turnOnX402: true,
    nonTransferable: true,
  },
  build(input, ctx): Plan {
    const expiresAt = input.expiresInDays === undefined ? null : ctx.now + BigInt(input.expiresInDays) * DAY_NS;
    const steps: PlanStep[] = [
      {
        kind: "register_agent",
        handle: input.handle,
        executor: null,
        capabilities: {},
        x402: x402Capability(parseUsdc(input.maxPerPayment)),
        expiresAt,
        locks: input.nonTransferable ? LOCKS.NO_TRANSFER : 0,
        description: input.description ?? null,
      },
    ];
    if (input.turnOnX402) {
      steps.push({
        kind: "set_x402_config",
        asset: USDC_CONTRACT[input.network],
        accountDailyCap: input.accountDailyCap ? parseUsdc(input.accountDailyCap) : null,
      });
    }
    // The approval of the agent itself, with no NEAR budget: it pays only through x402.
    steps.push({ kind: "set_mandate", agentHandle: input.handle, dailyCap: 0n, expiresAt, recipients: [] });
    steps.push({
      kind: "set_x402_rules",
      agentHandle: input.handle,
      rules: {
        dailyCap: parseUsdc(input.dailyBudget),
        sellers: input.sellers.map((s) => ({ seller: s.seller, perPaymentCap: parseUsdc(s.perPayment), dailyCap: parseUsdc(s.daily) })),
        unlisted: input.unlisted ? { perPaymentCap: parseUsdc(input.unlisted.perPayment), dailyCap: parseUsdc(input.unlisted.daily) } : null,
        sites: input.sites.map((s) => ({ site: s.site, payTo: s.payTo ?? null, perPaymentCap: parseUsdc(s.perPayment), dailyCap: parseUsdc(s.daily) })),
        // The generation is read when the step is signed (see toTransaction).
        agents: input.agents.map((a) => ({ registry: a.registry, agentId: a.agentId, perPaymentCap: parseUsdc(a.perPayment), dailyCap: parseUsdc(a.daily) })),
      },
    });
    return { templateId: this.id, templateVersion: this.version, title: `${this.title}: ${input.handle}`, steps };
  },
};

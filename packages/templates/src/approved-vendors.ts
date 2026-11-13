import { z } from "zod";
import { DAY_NS, LOCKS, parseNear, transferCapability } from "@nearfirewall/sdk";
import type { Plan, PlanStep } from "./plan.ts";
import type { Template } from "./template.ts";

const nearAmount = z.string().regex(/^\d+(\.\d{1,24})?$/, "Enter an amount in NEAR, such as 2.5");
const accountId = z
  .string()
  .min(2)
  .max(64)
  .regex(/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/, "Enter a valid NEAR account ID");
const label = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])$/, "2-32 characters of a-z, 0-9 and '-'");

export const ApprovedVendorsInput = z.object({
  handle: label,
  /** Executor account for `execute`. Leave empty when the agent will connect with a key instead. */
  executor: accountId.optional(),
  description: z.string().max(512).optional(),
  /** Largest single payment the agent may ever request. */
  maxPerPayment: nearAmount,
  /** Daily budget across every recipient (shared by any leaf agents). */
  dailyBudget: nearAmount,
  /** Payments above this amount wait for the owner to confirm ("ask me first"). */
  confirmAbove: nearAmount.optional(),
  recipients: z
    .array(
      z.object({
        recipient: accountId,
        perPayment: nearAmount,
        daily: nearAmount,
        expiresInDays: z.number().int().positive().optional(),
      }),
    )
    .min(1, "Add at least one recipient")
    .max(50),
  leaves: z
    .array(z.object({ label, executor: accountId.optional(), maxPerPayment: nearAmount }))
    .max(20)
    .default([]),
  expiresInDays: z.number().int().positive().optional(),
  nonTransferable: z.boolean().default(false),
  freezeCapabilities: z.boolean().default(false),
  fixedMandate: z.boolean().default(false),
});
export type ApprovedVendorsInput = z.infer<typeof ApprovedVendorsInput>;

const days = (now: bigint, n?: number) => (n === undefined ? null : now + BigInt(n) * DAY_NS);

/**
 * One agent (optionally with leaf agents under it), a shared daily budget, and
 * recipients that each have their own per-payment and daily limits.
 */
export const approvedVendors: Template<ApprovedVendorsInput> = {
  id: "approved-vendors",
  version: 1,
  title: "Approved vendors",
  description: "An agent that pays only the vendors you approve, each with its own limits, inside one daily budget.",
  input: ApprovedVendorsInput,
  defaults: { leaves: [], nonTransferable: false, freezeCapabilities: false, fixedMandate: false },
  build(input, ctx): Plan {
    const locks = (input.nonTransferable ? LOCKS.NO_TRANSFER : 0) | (input.freezeCapabilities ? LOCKS.NO_CAPABILITY_RAISE : 0);
    const expiresAt = days(ctx.now, input.expiresInDays);
    const steps: PlanStep[] = [
      {
        kind: "register_agent",
        handle: input.handle,
        executor: input.executor ?? null,
        capabilities: transferCapability(parseNear(input.maxPerPayment)),
        expiresAt,
        locks,
        description: input.description ?? null,
      },
    ];
    for (const leaf of input.leaves) {
      steps.push({
        kind: "create_child",
        parentHandle: input.handle,
        label: leaf.label,
        executor: leaf.executor ?? null,
        capabilities: transferCapability(parseNear(leaf.maxPerPayment)),
        expiresAt,
        locks: input.nonTransferable ? LOCKS.NO_TRANSFER : 0,
      });
    }
    steps.push({
      kind: "set_mandate",
      agentHandle: input.handle,
      dailyCap: parseNear(input.dailyBudget),
      expiresAt,
      fixed: input.fixedMandate,
      confirmAbove: input.confirmAbove ? parseNear(input.confirmAbove) : null,
      recipients: input.recipients.map((r) => ({
        recipient: r.recipient,
        perPaymentCap: parseNear(r.perPayment),
        dailyCap: parseNear(r.daily),
        expiresAt: days(ctx.now, r.expiresInDays),
      })),
    });
    return {
      templateId: this.id,
      templateVersion: this.version,
      title: `${this.title}: ${input.handle}`,
      steps,
    };
  },
};

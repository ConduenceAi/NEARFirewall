import type { z } from "zod";
import type { Plan, PlanContext } from "./plan.ts";

/**
 * A template turns a few inputs into a plan for one use case. `build` must be
 * deterministic: no clock reads, no randomness, no network. Everything it needs
 * comes from `input` and `ctx`.
 *
 * Custom templates implement this interface in the caller's own code. Nothing
 * is registered on chain or with any server.
 */
export interface Template<I> {
  id: string;
  version: number;
  title: string;
  description: string;
  input: z.ZodType<I>;
  defaults: Partial<I>;
  build(input: I, ctx: PlanContext): Plan;
}

/** Parses raw input against the template's schema, then builds the plan. */
export function buildPlan<I>(template: Template<I>, rawInput: unknown, ctx: PlanContext): Plan {
  const input = template.input.parse({ ...template.defaults, ...(rawInput as object) });
  return template.build(input, ctx);
}

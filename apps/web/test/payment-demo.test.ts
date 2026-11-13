import { describe, expect, it } from "vitest";
import { parseNear } from "@nearfirewall/sdk";
import { evaluateDemoPayment, INITIAL_SPEND, parseDemoRequest } from "../src/payment-demo.ts";

describe("landing payment demo", () => {
  it("parses a single positive NEAR payment and its recipient", () => {
    expect(parseDemoRequest("Please send 2.75 NEAR to Noa Market for the feed.")).toEqual({ recipient: "noa", amount: parseNear("2.75") });
    for (const prompt of ["Pay Noa Market -2 NEAR", "Pay Noa Market 1,000 NEAR", "Pay Noa Market 0 NEAR", "Pay Noa Market 1.000001 NEAR", "Pay Noa Market and Dragons Market 1 NEAR", "Pay Noa Market 1 NEAR or 2 NEAR", "What is 2 NEAR at Noa Market?"]) {
      expect(parseDemoRequest(prompt)).toBeNull();
    }
  });

  it("checks the agent ceiling, recipient, per-payment limit, and confirmation threshold", () => {
    const preview = (amount: string, recipient: "noa" | "dragons" = "noa") => evaluateDemoPayment({ recipient, amount: parseNear(amount) }, INITIAL_SPEND, 0n);
    expect(preview("2").status).toBe("settled");
    expect(preview("3").status).toBe("pending");
    expect(preview("4")).toMatchObject({ status: "blocked", previewBlocked: true });
    expect(preview("6")).toMatchObject({ status: "blocked", previewBlocked: false });
    expect(preview("2", "dragons")).toMatchObject({ status: "blocked", previewBlocked: true });
  });

  it("counts pending reservations and settled payments against the same daily budget", () => {
    const request = { recipient: "noa" as const, amount: parseNear("3") };
    expect(evaluateDemoPayment(request, INITIAL_SPEND, parseNear("3")).status).toBe("blocked");
    expect(evaluateDemoPayment(request, parseNear("4"), 0n).status).toBe("blocked");
    expect(evaluateDemoPayment(request, INITIAL_SPEND, 0n).status).toBe("pending");
  });
});

export * from "./plan.ts";
export * from "./template.ts";
export * from "./validate.ts";
export { approvedVendors, ApprovedVendorsInput } from "./approved-vendors.ts";
export { x402Buyer, X402BuyerInput } from "./x402-buyer.ts";

import { approvedVendors } from "./approved-vendors.ts";
import { x402Buyer } from "./x402-buyer.ts";
import type { Template } from "./template.ts";

/** Built-in templates, by ID. */
export const templates: Record<string, Template<any>> = {
  [approvedVendors.id]: approvedVendors,
  [x402Buyer.id]: x402Buyer,
};

export function getTemplate(id: string): Template<any> | undefined {
  return templates[id];
}

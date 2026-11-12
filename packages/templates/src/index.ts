export * from "./plan.ts";
export * from "./template.ts";
export * from "./validate.ts";
export { approvedVendors, ApprovedVendorsInput } from "./approved-vendors.ts";

import { approvedVendors } from "./approved-vendors.ts";
import type { Template } from "./template.ts";

/** Built-in templates, by ID. */
export const templates: Record<string, Template<any>> = {
  [approvedVendors.id]: approvedVendors,
};

export function getTemplate(id: string): Template<any> | undefined {
  return templates[id];
}

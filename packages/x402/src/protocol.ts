/**
 * The x402 v2 wire format for the NEAR `exact` scheme.
 *
 * - A seller answers 402 with a `PAYMENT-REQUIRED` header: base64 JSON of a
 *   `PaymentRequired`, whose `accepts` lists the payments it takes.
 * - The buyer retries with a `PAYMENT-SIGNATURE` header: base64 JSON of a
 *   `PaymentPayload` holding one signed NEP-366 delegate action for a single
 *   NEP-141 `ft_transfer` of exactly `amount` to `payTo`, with 1 yoctoNEAR.
 * - The seller's facilitator relays it, and the seller answers with a
 *   `PAYMENT-RESPONSE` header: base64 JSON of a `SettlementResponse`.
 */
import { z } from "zod";

export const X402_VERSION = 2;

/** Header names. HTTP headers are case-insensitive; Node lowercases them. */
export const HEADERS = {
  required: "payment-required",
  signature: "payment-signature",
  response: "payment-response",
} as const;

export const ResourceInfo = z.looseObject({
  url: z.string(),
  description: z.string().optional(),
  mimeType: z.string().optional(),
});
export type ResourceInfo = z.infer<typeof ResourceInfo>;

export const PaymentRequirements = z.looseObject({
  scheme: z.string(),
  network: z.string(),
  /** Atomic units of `asset`, as a decimal string. */
  amount: z.string().regex(/^\d+$/),
  /** The NEP-141 token contract. */
  asset: z.string(),
  /** The account that must receive the transfer. */
  payTo: z.string(),
  maxTimeoutSeconds: z.number().int().positive(),
  extra: z.record(z.string(), z.unknown()).nullable().optional(),
});
export type PaymentRequirements = z.infer<typeof PaymentRequirements>;

export const PaymentRequired = z.looseObject({
  x402Version: z.number(),
  error: z.string().optional(),
  resource: ResourceInfo,
  /** Parsed one by one, so an entry for another chain does not hide ours. */
  accepts: z.array(z.unknown()),
});
export type PaymentRequired = z.infer<typeof PaymentRequired>;

export const PaymentPayload = z.looseObject({
  x402Version: z.literal(X402_VERSION),
  resource: ResourceInfo.optional(),
  accepted: PaymentRequirements,
  payload: z.object({ signedDelegateAction: z.string().min(1) }).strict(),
});
export type PaymentPayload = z.infer<typeof PaymentPayload>;

export const SettlementResponse = z.looseObject({
  success: z.boolean(),
  transaction: z.string(),
  network: z.string(),
  payer: z.string().optional(),
  errorReason: z.string().optional(),
  errorMessage: z.string().optional(),
});
export type SettlementResponse = z.infer<typeof SettlementResponse>;

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  // Accept the URL-safe alphabet and missing padding too.
  const normalized = text.trim().replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** Encodes a header value: base64 of UTF-8 JSON. */
export function encodeHeader(value: unknown): string {
  return toBase64(new TextEncoder().encode(JSON.stringify(value)));
}

/** Decodes a header value and checks its shape. Throws on anything malformed. */
export function decodeHeader<S extends z.ZodType>(text: string, schema: S): z.infer<S> {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fromBase64(text)));
  } catch {
    throw new Error("The x402 header is not base64-encoded JSON.");
  }
  return schema.parse(json);
}

/**
 * Picks the first payment option this buyer can make: the `exact` scheme on
 * `network`, in `asset`. Returns the option exactly as the seller sent it,
 * because the payload must echo it back unchanged.
 */
export function selectRequirement(
  required: PaymentRequired,
  want: { network: string; asset: string },
): { raw: Record<string, unknown>; requirement: PaymentRequirements } | null {
  for (const entry of required.accepts) {
    const parsed = PaymentRequirements.safeParse(entry);
    if (!parsed.success) continue;
    const r = parsed.data;
    if (r.scheme === "exact" && r.network === want.network && r.asset === want.asset) {
      return { raw: entry as Record<string, unknown>, requirement: r };
    }
  }
  return null;
}

/** Lowercases header names, and joins repeated headers, so lookups are simple. */
export function normalizeHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

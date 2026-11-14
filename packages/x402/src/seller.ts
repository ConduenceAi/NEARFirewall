/**
 * x402 paywall for a seller (for example an agent selling a service), for Node
 * HTTP handlers. Prices are in USDC on NEAR.
 *
 *   const charge = createPaywall({ facilitatorUrl, apiKey, network: "testnet", payTo, price: parseUsdc("0.05") });
 *   http.createServer(async (req, res) => {
 *     const result = await charge(req, res);
 *     if (!result.paid) return; // the paywall already answered (402 or an error)
 *     res.end("the paid content");
 *   });
 *
 * A request without payment gets 402 with a `PAYMENT-REQUIRED` header. A
 * request with a `PAYMENT-SIGNATURE` header is checked against this seller's
 * own terms, then verified and settled by the facilitator, which relays the
 * buyer's transfer and pays the gas. Only then is `paid` true.
 *
 * `payTo` must already be registered with the USDC contract (NEP-145
 * `storage_deposit`), or facilitators refuse the payment.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { USDC_CONTRACT, X402_NETWORK, type NearNetwork } from "@nearfirewall/sdk";
import {
  HEADERS,
  PaymentPayload,
  SettlementResponse,
  X402_VERSION,
  fromBase64,
  encodeHeader,
  type PaymentRequirements,
} from "./protocol.ts";

export const VerifyResponse = z.looseObject({
  isValid: z.boolean(),
  payer: z.string().optional(),
  invalidReason: z.string().optional(),
  invalidMessage: z.string().optional(),
});
export type VerifyResponse = z.infer<typeof VerifyResponse>;

/** Client for an x402 facilitator's `/verify`, `/settle`, and `/supported`. */
export class FacilitatorClient {
  readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl: string, apiKey?: string, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }

  verify(paymentPayload: unknown, paymentRequirements: PaymentRequirements): Promise<VerifyResponse> {
    return this.post("/verify", { x402Version: X402_VERSION, paymentPayload, paymentRequirements }, VerifyResponse);
  }

  settle(paymentPayload: unknown, paymentRequirements: PaymentRequirements): Promise<SettlementResponse> {
    return this.post("/settle", { x402Version: X402_VERSION, paymentPayload, paymentRequirements }, SettlementResponse);
  }

  async supported(): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}/supported`);
    if (!response.ok) throw new Error(`The facilitator answered HTTP ${response.status}.`);
    return response.json();
  }

  private async post<S extends z.ZodType>(path: string, body: unknown, schema: S): Promise<z.infer<S>> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers["x-api-key"] = this.apiKey;
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`The facilitator answered HTTP ${response.status} to ${path}.`);
    return schema.parse(await response.json());
  }
}

export interface PaywallOptions {
  /** The facilitator that verifies and settles payments for this seller. */
  facilitatorUrl: string;
  /** The facilitator's API key, if it needs one. Keep it server-side. */
  apiKey?: string;
  network: NearNetwork;
  /** The account paid. It must be registered with the USDC contract. */
  payTo: string;
  /** Price in USDC's smallest unit (see `parseUsdc`), or a function of the request. */
  price: bigint | ((req: IncomingMessage) => bigint);
  /** Defaults to Circle USDC on `network`. */
  asset?: string;
  maxTimeoutSeconds?: number;
  description?: string;
  mimeType?: string;
  /** This seller's NEARFirewall agent, shown to buyers. Informational only. */
  agent?: { registry: string; agentId: string };
  /** The resource's public URL. Defaults to the request's host and path. */
  resourceUrl?: (req: IncomingMessage) => string;
  fetchImpl?: typeof fetch;
}

export type PaywallResult =
  | { paid: true; settlement: SettlementResponse; payer?: string }
  | { paid: false };

const DEFAULT_TIMEOUT_SECONDS = 60;

function defaultResourceUrl(req: IncomingMessage): string {
  const host = req.headers.host ?? "localhost";
  const proto = (req.socket as { encrypted?: boolean }).encrypted ? "https" : "http";
  return `${proto}://${host}${req.url ?? "/"}`;
}

function sameTerms(a: PaymentRequirements, b: PaymentRequirements): boolean {
  return (
    a.scheme === b.scheme &&
    a.network === b.network &&
    a.asset === b.asset &&
    a.payTo === b.payTo &&
    a.amount === b.amount &&
    a.maxTimeoutSeconds === b.maxTimeoutSeconds
  );
}

/** Returns a function that charges one request, answering 402 itself when it is not paid. */
export function createPaywall(options: PaywallOptions) {
  const facilitator = new FacilitatorClient(options.facilitatorUrl, options.apiKey, options.fetchImpl);
  const asset = options.asset ?? USDC_CONTRACT[options.network];
  const network = X402_NETWORK[options.network];

  return async function charge(req: IncomingMessage, res: ServerResponse): Promise<PaywallResult> {
    const price = typeof options.price === "function" ? options.price(req) : options.price;
    if (price <= 0n) throw new Error("The x402 price must be above zero.");
    const requirements: PaymentRequirements = {
      scheme: "exact",
      network,
      amount: price.toString(),
      asset,
      payTo: options.payTo,
      maxTimeoutSeconds: options.maxTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
      ...(options.agent ? { extra: { nearfirewall: { registry: options.agent.registry, agentId: options.agent.agentId } } } : {}),
    };
    const resource = {
      url: (options.resourceUrl ?? defaultResourceUrl)(req),
      ...(options.description ? { description: options.description } : {}),
      ...(options.mimeType ? { mimeType: options.mimeType } : {}),
    };
    const challenge = (error?: string) => {
      const required = { x402Version: X402_VERSION, ...(error ? { error } : {}), resource, accepts: [requirements] };
      res.statusCode = 402;
      res.setHeader("PAYMENT-REQUIRED", encodeHeader(required));
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.end(JSON.stringify(required));
      return { paid: false } as const;
    };

    const header = req.headers[HEADERS.signature];
    if (typeof header !== "string" || header.length === 0) return challenge();

    // Keep the buyer's payload exactly as sent: the facilitator verifies it as is.
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fromBase64(header)));
    } catch {
      return challenge("invalid_payload");
    }
    const payload = PaymentPayload.safeParse(raw);
    if (!payload.success) return challenge("invalid_payload");
    if (!sameTerms(payload.data.accepted, requirements)) return challenge("invalid_payment_requirements");

    try {
      const verified = await facilitator.verify(raw, requirements);
      if (!verified.isValid) return challenge(verified.invalidReason ?? "invalid_payment");
      const settlement = await facilitator.settle(raw, requirements);
      res.setHeader("PAYMENT-RESPONSE", encodeHeader(settlement));
      if (!settlement.success) return challenge(settlement.errorReason ?? "settlement_failed");
      return { paid: true, settlement, ...(settlement.payer ? { payer: settlement.payer } : {}) };
    } catch (error) {
      res.statusCode = 502;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : "The facilitator could not be reached." }));
      return { paid: false };
    }
  };
}

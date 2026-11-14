/**
 * A small x402 facilitator for the NEAR `exact` scheme, for demos and for
 * sellers who host their own. It serves `/verify`, `/settle`, and `/supported`.
 *
 * Verification follows the NEAR scheme's rules, failing closed:
 * - the payload repeats the seller's terms exactly;
 * - the payment is one signed NEP-366 delegate holding a single `ft_transfer`
 *   on the asset contract, of exactly `amount` to `payTo`, with 1 yoctoNEAR;
 * - the signature is valid for a full-access key of the sender (function-call
 *   keys cannot attach the deposit);
 * - the nonce is unused, and the delegate expires within the seller's timeout;
 * - the sender holds the amount, and `payTo` is registered with the token.
 * Settlement re-verifies, relays the delegate from a relayer account that pays
 * the gas and the 1 yoctoNEAR, and succeeds only when the transfer did.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { Account, actions, decodeSignedDelegate, encodeDelegateAction, type SignedDelegate } from "near-api-js";
import { USDC_CONTRACT, X402_NETWORK, ftBalanceOf, isTokenRegistered, type NearNetwork, type NearRpc } from "@nearfirewall/sdk";
import { PaymentPayload, PaymentRequirements, X402_VERSION, fromBase64, type SettlementResponse } from "./protocol.ts";

/** Submits a signed delegate. Returns the outer transaction and whether the inner transfer succeeded. */
export type Relay = (signed: SignedDelegate) => Promise<{ transaction: string; success: boolean; error?: string }>;

export interface FacilitatorOptions {
  network: NearNetwork;
  rpc: NearRpc;
  /** The account that relays payments and pays their gas. It never receives or holds the token. */
  relayerId: string;
  relay: Relay;
  /** Defaults to Circle USDC on `network`. */
  asset?: string;
}

export type VerifyResult =
  | { isValid: true; payer: string }
  | { isValid: false; invalidReason: string; invalidMessage: string };

/** Gas the relayed `ft_transfer` may ask for. */
const MAX_TRANSFER_GAS = 100n * 10n ** 12n;

function invalid(invalidReason: string, invalidMessage: string): VerifyResult {
  return { isValid: false, invalidReason, invalidMessage };
}

export class Facilitator {
  readonly network: string;
  readonly asset: string;
  private readonly options: FacilitatorOptions;
  /** Delegates already settled or being settled, by hash, until they expire. */
  private readonly seen = new Map<string, bigint>();

  constructor(options: FacilitatorOptions) {
    this.options = options;
    this.network = X402_NETWORK[options.network];
    this.asset = options.asset ?? USDC_CONTRACT[options.network];
  }

  supported() {
    return {
      kinds: [{ x402Version: X402_VERSION, scheme: "exact", network: this.network }],
      extensions: [],
      signers: { [this.network]: [this.options.relayerId] },
    };
  }

  async verify(paymentPayload: unknown, paymentRequirements: unknown): Promise<VerifyResult> {
    const checked = await this.check(paymentPayload, paymentRequirements);
    return "signed" in checked ? { isValid: true, payer: checked.payer } : checked;
  }

  async settle(paymentPayload: unknown, paymentRequirements: unknown): Promise<SettlementResponse> {
    const checked = await this.check(paymentPayload, paymentRequirements);
    if (!("signed" in checked)) {
      return { success: false, transaction: "", network: this.network, errorReason: checked.invalidReason, errorMessage: checked.invalidMessage };
    }
    const key = createHash("sha256").update(checked.raw).digest("hex");
    for (const [k, expiry] of this.seen) if (expiry < checked.height) this.seen.delete(k);
    if (this.seen.has(key)) {
      return { success: false, transaction: "", network: this.network, errorReason: "duplicate_settlement", errorMessage: "This payment was already submitted." };
    }
    this.seen.set(key, checked.signed.delegateAction.maxBlockHeight);
    try {
      const result = await this.options.relay(checked.signed);
      return result.success
        ? { success: true, transaction: result.transaction, network: this.network, payer: checked.payer }
        : { success: false, transaction: result.transaction, network: this.network, errorReason: "settlement_failed", errorMessage: result.error ?? "The transfer failed." };
    } catch (error) {
      return {
        success: false,
        transaction: "",
        network: this.network,
        errorReason: "unexpected_settle_error",
        errorMessage: error instanceof Error ? error.message.slice(0, 300) : "The relay failed.",
      };
    }
  }

  private async check(
    paymentPayload: unknown,
    paymentRequirements: unknown,
  ): Promise<{ signed: SignedDelegate; payer: string; raw: string; height: bigint } | Extract<VerifyResult, { isValid: false }>> {
    const fail = (reason: string, message: string) => invalid(reason, message) as Extract<VerifyResult, { isValid: false }>;
    const requirements = PaymentRequirements.safeParse(paymentRequirements);
    if (!requirements.success) return fail("invalid_payment_requirements", "The payment requirements are malformed.");
    const payload = PaymentPayload.safeParse(paymentPayload);
    if (!payload.success) return fail("invalid_payload", "The payment payload is malformed.");
    const r = requirements.data;
    const accepted = payload.data.accepted;
    if (r.scheme !== "exact" || accepted.scheme !== "exact") return fail("invalid_scheme", "Only the exact scheme is supported.");
    if (r.network !== this.network || accepted.network !== this.network) return fail("invalid_network", `Only ${this.network} is supported.`);
    if (r.asset !== this.asset) return fail("invalid_payment_requirements", "This facilitator settles only USDC.");
    if (accepted.asset !== r.asset || accepted.payTo !== r.payTo || accepted.amount !== r.amount) {
      return fail("invalid_payment_requirements", "The payload does not repeat the seller's terms.");
    }

    const raw = payload.data.payload.signedDelegateAction;
    let signed: SignedDelegate;
    try {
      signed = decodeSignedDelegate(fromBase64(raw));
    } catch {
      return fail("invalid_payload", "The signed delegate action could not be decoded.");
    }
    const d = signed.delegateAction;
    if (d.senderId === this.options.relayerId) return fail("invalid_payload", "The relayer cannot be the payer.");
    if (d.receiverId !== r.asset) return fail("invalid_payload", "The transfer is not on the token contract.");
    const call = d.actions.length === 1 ? d.actions[0]!.functionCall : undefined;
    if (!call) return fail("invalid_payload", "The delegate must hold exactly one function call.");
    if (call.methodName !== "ft_transfer") return fail("unsupported_asset_transfer_method", "Only ft_transfer is accepted.");
    if (call.deposit !== 1n) return fail("invalid_payload", "ft_transfer must attach exactly 1 yoctoNEAR.");
    if (call.gas > MAX_TRANSFER_GAS) return fail("invalid_payload", "The transfer asks for too much gas.");
    let args: { receiver_id?: unknown; amount?: unknown };
    try {
      args = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(call.args)));
    } catch {
      return fail("invalid_payload", "The transfer arguments are not JSON.");
    }
    if (args.receiver_id !== r.payTo) return fail("invalid_payload", "The transfer does not pay the seller.");
    if (String(args.amount) !== r.amount) return fail("invalid_payload", "The transfer amount differs from the price.");
    const hash = createHash("sha256").update(encodeDelegateAction(d)).digest();
    if (!d.publicKey.verify(new Uint8Array(hash), signed.signature.data)) return fail("invalid_payload", "The signature is not valid.");

    try {
      const { rpc } = this.options;
      const block = await rpc.call<{ header: { height: number } }>("block", { finality: "final" });
      const height = BigInt(block.header.height);
      const key = await rpc.call<{ nonce: number | string; permission: unknown }>("query", {
        request_type: "view_access_key",
        finality: "final",
        account_id: d.senderId,
        public_key: d.publicKey.toString(),
      });
      if (key.permission !== "FullAccess") return fail("invalid_payload", "Function-call keys cannot attach the deposit; a full-access key must sign.");
      if (d.nonce <= BigInt(key.nonce)) return fail("delegate_action_nonce_already_used", "The nonce was already used.");
      if (d.nonce >= height * 1_000_000n) return fail("invalid_payload", "The nonce is too large.");
      const timeoutBlocks = BigInt(Math.max(1, Math.ceil(r.maxTimeoutSeconds)));
      const remaining = d.maxBlockHeight - height;
      if (remaining <= 0n) return fail("delegate_action_expired", "The payment has expired.");
      if (remaining > timeoutBlocks) {
        return fail("delegate_action_timeout_window_exceeds_maxTimeout", "The payment stays valid longer than the seller allows.");
      }
      if ((await ftBalanceOf(rpc, r.asset, d.senderId)) < BigInt(r.amount)) return fail("insufficient_funds", "The payer does not hold the amount.");
      if (!(await isTokenRegistered(rpc, r.asset, r.payTo))) {
        return fail("invalid_payment_requirements", "The seller's account is not registered with the token.");
      }
      return { signed, payer: d.senderId, raw, height };
    } catch (error) {
      return fail("unexpected_verify_error", error instanceof Error ? error.message.slice(0, 300) : "The chain could not be read.");
    }
  }
}

/** Relays with a near-api-js account, and reports whether the inner transfer succeeded. */
export function relayWithAccount(relayer: Account, asset: string): Relay {
  return async (signed) => {
    const response = await relayer.signAndSendTransaction({
      receiverId: signed.delegateAction.senderId,
      actions: [actions.signedDelegate({ delegateAction: signed.delegateAction, signature: signed.signature })],
      waitUntil: "FINAL",
      throwOnFailure: false,
    });
    const receipts = (response as unknown as { receipts_outcome?: { outcome: { executor_id: string; status: unknown } }[] }).receipts_outcome ?? [];
    const transfer = receipts.find((r) => r.outcome.executor_id === asset);
    const status = transfer?.outcome.status as { SuccessValue?: string; Failure?: unknown } | undefined;
    const success = status !== undefined && "SuccessValue" in status;
    return {
      transaction: response.transaction.hash,
      success,
      ...(success ? {} : { error: JSON.stringify(status?.Failure ?? response.status).slice(0, 300) }),
    };
  };
}

/** HTTP front for a facilitator: `GET /supported`, `POST /verify`, `POST /settle`, `GET /health`. */
export function createFacilitatorServer(facilitator: Facilitator, options: { apiKey?: string; maxBodyBytes?: number } = {}): RequestListener {
  const maxBody = options.maxBodyBytes ?? 65_536;
  const keyDigest = options.apiKey ? createHash("sha256").update(options.apiKey).digest() : null;
  const authorized = (req: IncomingMessage) => {
    if (!keyDigest) return true;
    const header = req.headers["x-api-key"] ?? /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ""))?.[1];
    return typeof header === "string" && timingSafeEqual(createHash("sha256").update(header).digest(), keyDigest);
  };
  const send = (res: ServerResponse, status: number, body: unknown) => {
    const text = JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(text);
  };
  return async (req, res) => {
    const path = new URL(req.url ?? "/", "http://facilitator.invalid").pathname;
    try {
      if (req.method === "GET" && path === "/health") return send(res, 200, { ok: true });
      if (req.method === "GET" && path === "/supported") return send(res, 200, facilitator.supported());
      if (req.method !== "POST" || (path !== "/verify" && path !== "/settle")) return send(res, 404, { error: "Not found." });
      if (!authorized(req)) return send(res, 401, { error: "A valid X-API-Key is required." });
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > maxBody) return send(res, 413, { error: "The request body is too large." });
        chunks.push(chunk as Buffer);
      }
      let body: { x402Version?: unknown; paymentPayload?: unknown; paymentRequirements?: unknown };
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return send(res, 400, { error: "The body is not valid JSON." });
      }
      if (body.x402Version !== X402_VERSION) {
        return send(res, 200, path === "/verify"
          ? invalid("invalid_x402_version", "Only x402 version 2 is supported.")
          : { success: false, transaction: "", network: facilitator.network, errorReason: "invalid_x402_version" });
      }
      return send(res, 200, path === "/verify"
        ? await facilitator.verify(body.paymentPayload, body.paymentRequirements)
        : await facilitator.settle(body.paymentPayload, body.paymentRequirements));
    } catch (error) {
      return send(res, 500, { error: error instanceof Error ? error.message.slice(0, 300) : "The request failed." });
    }
  };
}

/**
 * x402 buyer for an agent connection.
 *
 * When a seller answers 402, the buyer:
 *   1. picks the seller's USDC-on-NEAR option (the `exact` scheme);
 *   2. asks the owner's policy, through `agent_execute`, to fund exactly that
 *      amount for that seller. Every rule is checked on-chain: the agent's x402
 *      capability, approved sellers, the small budget for unlisted sellers, the
 *      branch and account caps, pause, and the blocklist;
 *   3. once the funding is final, signs the seller's `ft_transfer` from the
 *      key's payment account and retries the request with it.
 *
 * Nothing is signed for the seller unless the owner's policy funded it. The
 * payment account holds no USDC between payments, so the most the agent's key
 * can ever move is what the policy just approved.
 */
import { Account, type KeyPairString } from "near-api-js";
import {
  X402_NETWORK,
  ftBalanceOf,
  formatUsdc,
  newRequestId,
  type AgentConnection,
  type AgentRef,
  type NearNetwork,
  type NearRpc,
} from "@nearfirewall/sdk";
import { signFtTransferDelegate } from "./delegate.ts";
import {
  HEADERS,
  PaymentRequired,
  SettlementResponse,
  X402_VERSION,
  decodeHeader,
  encodeHeader,
  selectRequirement,
  type PaymentRequirements,
} from "./protocol.ts";

export interface HttpResponse {
  status: number;
  url: string;
  /** Lowercased names. */
  headers: Record<string, string>;
  body: string;
  truncated?: boolean;
  /** Set when the body was not returned, for example because it is not text. */
  note?: string;
}

/** Makes one GET request. The MCP server passes a fetch that applies the owner's browsing rules. */
export type Transport = (request: { url: string; headers: Record<string, string> }) => Promise<HttpResponse>;

export interface X402Payment {
  resource: string;
  payTo: string;
  /** In USDC's smallest unit. */
  amount: bigint;
  asset: string;
  requestId: string;
  /** The website that asked for payment, as sent to the owner's policy. */
  site?: string;
  /** The agent the seller claimed to be, which the policy checks on-chain when the owner approved it. */
  payeeAgent?: AgentRef;
  fundingTx?: string;
  settlement?: SettlementResponse;
}

const SITE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$/;

/** The website an x402 rule names: the lowercase host (and port, if not the default) of a URL. */
export function siteOf(url: string): string | null {
  try {
    const host = new URL(url).host.toLowerCase();
    return host.length <= 128 && SITE.test(host) ? host : null;
  } catch {
    return null;
  }
}

/** The NEARFirewall agent a seller claims to be, from `extra.nearfirewall` in its terms. */
export function claimedAgent(extra: unknown): AgentRef | null {
  const claim = (extra as { nearfirewall?: { registry?: unknown; agentId?: unknown } } | null | undefined)?.nearfirewall;
  if (!claim || typeof claim.registry !== "string" || typeof claim.agentId !== "string") return null;
  if (!ACCOUNT_ID.test(claim.registry) || claim.registry.length > 64 || !/^\d{1,20}$/.test(claim.agentId)) return null;
  return { registry: claim.registry, agent_id: claim.agentId };
}

export type X402FetchResult =
  /** The seller did not ask for payment. */
  | { status: "free"; response: HttpResponse }
  /** Paid, and the seller returned the resource. */
  | { status: "paid"; response: HttpResponse; payment: X402Payment }
  /**
   * Not paid. When `payment` is present the policy had already funded the
   * payment account, and that USDC is still there (see `returnUnspent`).
   */
  | { status: "refused"; reason: string; response?: HttpResponse; payment?: X402Payment };

export interface BuyerOptions {
  connection: AgentConnection;
  /** The connection key: the same key that signs `agent_execute`. */
  secretKey: KeyPairString;
  network: NearNetwork;
  rpc: NearRpc;
  transport?: Transport;
  /** Optional local ceiling per payment, in USDC's smallest unit. The on-chain rules apply regardless. */
  maxPayment?: bigint | null;
  /** How long to wait for the funded USDC to show at final finality. */
  fundingTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Runs payments one at a time. Buyers that share a key (for example one per
   * gateway request) must share one serializer.
   */
  serialize?: Serializer;
}

/** Runs tasks one after another, whether each succeeds or fails. */
export type Serializer = <T>(task: () => Promise<T>) => Promise<T>;

export function serializer(): Serializer {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>) => {
    const run = tail.then(task);
    tail = run.catch(() => undefined);
    return run;
  };
}

const ACCOUNT_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/** A plain fetch with no browsing rules, for code that is not an AI agent. */
export const plainTransport: Transport = async ({ url, headers }) => {
  const response = await fetch(url, { headers, redirect: "follow" });
  const out: Record<string, string> = {};
  response.headers.forEach((value, name) => (out[name.toLowerCase()] = value));
  return { status: response.status, url: response.url || url, headers: out, body: await response.text() };
};

export class X402Buyer {
  readonly connection: AgentConnection;
  readonly network: NearNetwork;
  readonly rpc: NearRpc;
  private readonly secretKey: KeyPairString;
  private readonly transport: Transport;
  private readonly maxPayment: bigint | null;
  private readonly fundingTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Payments run one at a time: they share the key's nonces and the payment account. */
  private readonly serialize: Serializer;

  constructor(options: BuyerOptions) {
    this.connection = options.connection;
    this.secretKey = options.secretKey;
    this.network = options.network;
    this.rpc = options.rpc;
    this.transport = options.transport ?? plainTransport;
    this.maxPayment = options.maxPayment ?? null;
    this.fundingTimeoutMs = options.fundingTimeoutMs ?? 30_000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.serialize = options.serialize ?? serializer();
  }

  /** The account this key pays sellers from. */
  get paymentAccount(): string {
    return this.connection.x402Account;
  }

  /**
   * Fetches `url`, paying through x402 if the seller asks. `maxAmount` is the
   * most the caller will pay for this one request, in USDC's smallest unit.
   */
  fetch(url: string, opts: { transport?: Transport; maxAmount?: bigint | null } = {}): Promise<X402FetchResult> {
    return this.serialize(() => this.fetchOnce(url, opts));
  }

  private async fetchOnce(url: string, opts: { transport?: Transport; maxAmount?: bigint | null }): Promise<X402FetchResult> {
    const transport = opts.transport ?? this.transport;
    const first = await transport({ url, headers: {} });
    if (first.status !== 402) return { status: "free", response: first };

    const required = readChallenge(first);
    if ("error" in required) return { status: "refused", reason: required.error, response: first };
    const config = await this.connection.policy.getX402Config();
    if (!config) return { status: "refused", reason: "The owner has not turned on x402 payments.", response: first };
    const network = X402_NETWORK[this.network];
    const choice = selectRequirement(required.value, { network, asset: config.asset });
    if (!choice) {
      return { status: "refused", reason: `The seller does not accept USDC on ${network}. It offered: ${describeOffers(required.value)}.`, response: first };
    }
    const { requirement } = choice;
    const amount = BigInt(requirement.amount);
    if (amount <= 0n || !ACCOUNT_ID.test(requirement.payTo) || requirement.payTo.length > 64) {
      return { status: "refused", reason: "The seller's payment details are malformed.", response: first };
    }
    if (opts.maxAmount != null && amount > opts.maxAmount) {
      return {
        status: "refused",
        reason: `The seller asks ${formatUsdc(amount)} USDC, above the most allowed for this request (${formatUsdc(opts.maxAmount)} USDC).`,
        response: first,
      };
    }
    if (this.maxPayment != null && amount > this.maxPayment) {
      return {
        status: "refused",
        reason: `The seller asks ${formatUsdc(amount)} USDC, above this client's ceiling of ${formatUsdc(this.maxPayment)} USDC.`,
        response: first,
      };
    }

    // The owner's policy decides. Nothing is signed for the seller unless it funds the payment.
    // The site is the host that answered 402 (after redirects); the agent claim comes from
    // the seller's terms and is checked on-chain against the seller's registry.
    const site = siteOf(first.url);
    const payeeAgent = claimedAgent(requirement.extra);
    const before = await ftBalanceOf(this.rpc, config.asset, this.paymentAccount).catch(() => 0n);
    const requestId = newRequestId();
    const funding = await this.connection.fundX402(config.asset, requirement.payTo, amount, requestId, { site, payeeAgent });
    const payment: X402Payment = {
      resource: required.value.resource.url,
      payTo: requirement.payTo,
      amount,
      asset: config.asset,
      requestId,
      ...(site ? { site } : {}),
      ...(payeeAgent ? { payeeAgent } : {}),
      ...(funding.txHash ? { fundingTx: funding.txHash } : {}),
    };
    if (funding.outcome?.status !== "settled") {
      // Denied or failed: nothing moved. Uncertain: report it and let the owner check.
      return { status: "refused", reason: funding.message, response: first };
    }
    if (!(await this.waitForBalance(config.asset, before + amount))) {
      return {
        status: "refused",
        reason: `The funding did not show in the payment account in time. ${formatUsdc(amount)} USDC may be waiting there.`,
        payment,
      };
    }

    const signedDelegateAction = await this.signFor(requirement, amount);
    const body = { x402Version: X402_VERSION, resource: required.value.resource, accepted: choice.raw, payload: { signedDelegateAction } };
    const second = await transport({ url, headers: { "PAYMENT-SIGNATURE": encodeHeader(body) } });
    const settlement = readSettlement(second);
    if (settlement) payment.settlement = settlement;
    if (second.status === 402 || settlement?.success === false) {
      const why = settlement?.errorReason ?? readChallengeError(second) ?? `HTTP ${second.status}`;
      return {
        status: "refused",
        reason: `The seller did not accept the payment (${why}). The ${formatUsdc(amount)} USDC the owner approved is still in the payment account.`,
        response: second,
        payment,
      };
    }
    return { status: "paid", response: second, payment };
  }

  /** Signs the seller's transfer from the payment account, valid for the seller's timeout. */
  private async signFor(requirement: PaymentRequirements, amount: bigint): Promise<string> {
    const block = await this.rpc.call<{ header: { height: number } }>("block", { finality: "final" });
    const key = await this.rpc.call<{ nonce: number | string }>("query", {
      request_type: "view_access_key",
      finality: "final",
      account_id: this.paymentAccount,
      public_key: this.connection.publicKey,
    });
    const timeoutBlocks = BigInt(Math.max(1, Math.ceil(requirement.maxTimeoutSeconds)));
    return signFtTransferDelegate({
      secretKey: this.secretKey,
      senderId: this.paymentAccount,
      asset: requirement.asset,
      payTo: requirement.payTo,
      amount,
      nonce: BigInt(key.nonce) + 1n,
      maxBlockHeight: BigInt(block.header.height) + timeoutBlocks,
    });
  }

  private async waitForBalance(asset: string, target: bigint): Promise<boolean> {
    const deadline = Date.now() + this.fundingTimeoutMs;
    for (;;) {
      const balance = await ftBalanceOf(this.rpc, asset, this.paymentAccount).catch(() => -1n);
      if (balance >= target) return true;
      if (Date.now() >= deadline) return false;
      await this.sleep(1_000);
    }
  }

  /** USDC sitting in the payment account, for example after a seller refused a funded payment. */
  async unspent(): Promise<bigint> {
    const config = await this.connection.policy.getX402Config();
    return config ? ftBalanceOf(this.rpc, config.asset, this.paymentAccount).catch(() => 0n) : 0n;
  }

  /**
   * Sends any USDC left in the payment account back to the owner. It only ever
   * pays the owner's own account. Uses the account's own NEAR for the fee.
   */
  returnUnspent(): Promise<{ amount: bigint; txHash?: string }> {
    return this.serialize(() => this.returnUnspentOnce());
  }

  private async returnUnspentOnce(): Promise<{ amount: bigint; txHash?: string }> {
    const config = await this.connection.policy.getX402Config();
    if (!config) return { amount: 0n };
    const amount = await ftBalanceOf(this.rpc, config.asset, this.paymentAccount);
    if (amount === 0n) return { amount };
    const account = new Account(this.paymentAccount, this.rpc.url, this.secretKey);
    const response = await account.callFunctionRaw({
      contractId: config.asset,
      methodName: "ft_transfer",
      args: { receiver_id: this.connection.account, amount: amount.toString(), memo: "x402 unspent" },
      gas: 30n * 10n ** 12n,
      deposit: 1n,
      waitUntil: "FINAL",
    });
    return { amount, txHash: response.transaction.hash };
  }
}

function readChallenge(response: HttpResponse): { value: PaymentRequired } | { error: string } {
  const header = response.headers[HEADERS.required];
  let value: PaymentRequired | null = null;
  try {
    if (header) value = decodeHeader(header, PaymentRequired);
    else {
      const parsed = PaymentRequired.safeParse(JSON.parse(response.body));
      if (parsed.success) value = parsed.data;
    }
  } catch {
    return { error: "The seller's x402 payment details could not be read." };
  }
  if (!value) return { error: "The seller asked for payment (HTTP 402) but sent no x402 payment details." };
  if (value.x402Version !== X402_VERSION) {
    return { error: `The seller uses x402 version ${value.x402Version}; payments in USDC on NEAR need version ${X402_VERSION}.` };
  }
  return { value };
}

function readChallengeError(response: HttpResponse): string | null {
  const challenge = readChallenge(response);
  return "value" in challenge ? (challenge.value.error ?? null) : null;
}

function readSettlement(response: HttpResponse): SettlementResponse | null {
  const header = response.headers[HEADERS.response];
  if (!header) return null;
  try {
    return decodeHeader(header, SettlementResponse);
  } catch {
    return null;
  }
}

function describeOffers(required: PaymentRequired): string {
  const offers = required.accepts
    .map((a) => (a && typeof a === "object" ? `${(a as { scheme?: unknown }).scheme ?? "?"} on ${(a as { network?: unknown }).network ?? "?"}` : null))
    .filter(Boolean);
  return offers.length ? offers.join("; ") : "nothing usable";
}

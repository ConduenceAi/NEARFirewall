/**
 * Agent side of a connection: an AI agent holds a function-call key on the
 * owner's account that can call only `agent_execute`. It asks the owner's
 * policy to pay; the policy asks the owner's registry about the agent, checks
 * every rule, and pays, waits for the owner, or refuses.
 *
 * The SDK does not sign. The caller provides `submit`, which signs and sends
 * `agent_execute` with the connection key (for example with near-api-js).
 */
import { TGAS, formatNear } from "./amounts.ts";
import { PolicyClient, RegistryClient, ftBalanceOf, isTokenRegistered } from "./clients.ts";
import { MemoryJournalStore, OperationJournal, newRequestId, parseFinalStatus, type Operation } from "./executor.ts";
import { toWireAction } from "./owner.ts";
import type { NearRpc } from "./rpc.ts";
import { describeReason } from "./reasons.ts";
import { loadAccessRules, type AccessRules } from "./access.ts";
import type { Action, Connection, Mandate, Outcome, PathNode, X402Rules } from "./types.ts";
import { formatUsdc, x402AccountFor } from "./x402.ts";

/** Gas for `agent_execute`: the registry check, the policy check, the transfer, and settlement. */
export const AGENT_EXECUTE_GAS = 120n * TGAS;
/** x402 funding also calls the token contract, so it needs more (the policy requires 125 Tgas). */
export const X402_EXECUTE_GAS = 150n * TGAS;

/** What this connection may pay through x402 right now. Amounts are in USDC's smallest unit. */
export interface AgentX402Rules {
  /** False when the owner has not turned x402 on, or an approval on the path has no x402 rules. */
  enabled: boolean;
  /** The token sellers must ask for: the owner's USDC contract. */
  asset: string | null;
  /** Largest single x402 payment the agent and every agent above it allow, or null when x402 is not allowed. */
  maxPerPayment: bigint | null;
  /** Sellers approved by every approval on the path, with the tightest limits. */
  sellers: { seller: string; perPayment: bigint; daily: bigint; usedToday: bigint }[];
  /** Any other seller, or null when sellers must be approved by name. `daily` is shared by all of them. */
  unlisted: { perPayment: bigint; daily: bigint; usedToday: bigint } | null;
  budgets: { agentId: string; handle: string; daily: bigint; usedToday: bigint }[];
  account: { daily: bigint | null; usedToday: bigint };
  /** The account this key controls and pays sellers from. Funded per payment by the policy. */
  paymentAccount: string;
  /** Whether the owner has prepared the payment account (created and registered with the token). */
  paymentAccountReady: boolean;
  /** USDC sitting in the payment account, for example after a seller failed to settle. */
  unspent: bigint;
  /** Why x402 is off, in plain language. */
  note?: string;
}

export type SubmitAgentExecute = (
  args: { action: Record<string, unknown>; request_id: string; client: string | null },
  gas: bigint,
) => Promise<{ txHash?: string; status: unknown }>;

export interface AgentRules {
  account: string;
  agentId: string;
  handle: string;
  connection: Connection;
  paused: boolean;
  agentStatus: string;
  /** Largest single payment the agent and every agent above it allow. */
  maxPerPayment: bigint | null;
  /** Recipients approved by every approval on the agent's path, with the tightest limits. */
  recipients: { recipient: string; perPayment: bigint; daily: bigint; usedToday: bigint; confirmAbove: bigint | null }[];
  budgets: { agentId: string; handle: string; daily: bigint; usedToday: bigint }[];
  availableBalance: bigint;
  /** Approved recipients the owner has since blocked. Every agent is refused for these. */
  blocked: string[];
}

export interface AgentPayResult {
  operation: Operation;
  outcome?: Outcome;
  message: string;
  txHash?: string;
}

function minBig(values: (bigint | null | undefined)[]): bigint | null {
  const present = values.filter((v): v is bigint => typeof v === "bigint");
  return present.length === 0 ? null : present.reduce((a, b) => (b < a ? b : a));
}

export function describeOutcome(outcome: Outcome, amount: bigint, recipient: string): string {
  switch (outcome.status) {
    case "settled":
      return `Paid ${formatNear(amount)} NEAR to ${recipient}.`;
    case "failed":
      return `The transfer of ${formatNear(amount)} NEAR to ${recipient} failed; nothing was spent.`;
    case "awaiting_confirmation":
      return `Waiting for the owner to confirm ${formatNear(amount)} NEAR to ${recipient}. Nothing has moved yet.`;
    case "denied":
      return `Blocked (${outcome.reason}): ${describeReason(outcome.reason)}${outcome.detail ? ` (${outcome.detail})` : ""}`;
  }
}

export class AgentConnection {
  readonly rpc: NearRpc;
  readonly account: string;
  readonly publicKey: string;
  readonly submit: SubmitAgentExecute;
  readonly journal: OperationJournal;
  /** The name the agent's client reported, recorded with each request. A hint only. */
  client: string | null;
  private cached?: Connection;

  constructor(opts: {
    rpc: NearRpc;
    account: string;
    publicKey: string;
    submit: SubmitAgentExecute;
    journal?: OperationJournal;
    client?: string | null;
  }) {
    this.rpc = opts.rpc;
    this.account = opts.account;
    this.publicKey = opts.publicKey;
    this.submit = opts.submit;
    this.journal = opts.journal ?? new OperationJournal(new MemoryJournalStore());
    this.client = opts.client ?? null;
  }

  get policy(): PolicyClient {
    return new PolicyClient(this.rpc, this.account);
  }

  /** The connection record for this key. Fails if the key is not connected. */
  async connection(): Promise<Connection> {
    const connection = await this.policy.getConnection(this.publicKey);
    if (!connection) throw new Error(`This key is not connected on ${this.account}. Connect it from the NEARFirewall app.`);
    this.cached = connection;
    return connection;
  }

  async registry(): Promise<RegistryClient> {
    const policy = await this.policy.getPolicy();
    return new RegistryClient(this.rpc, policy.registry);
  }

  /** What this agent may spend right now. */
  async rules(): Promise<AgentRules> {
    const connection = await this.connection();
    const [policyView, registry] = await Promise.all([this.policy.getPolicy(), this.registry()]);
    const agent = await registry.getAgent(connection.agent_id);
    if (!agent) throw new Error(`Agent #${connection.agent_id} is not in ${registry.registryId}`);
    const path = await registry.getPath(agent.agent_id);
    const nodes = await Promise.all(path.map((n) => registry.getAgent(n.agent_id)));
    const mandates = (
      await Promise.all(path.map(async (n) => ({ node: n, mandate: await this.policy.getMandate(n.agent_id) })))
    ).filter((m): m is { node: (typeof path)[number]; mandate: Mandate } => m.mandate !== null && m.mandate.status === "Active");

    const maxPerPayment = nodes.some((n) => !n?.capabilities.transfer_near)
      ? null
      : minBig(nodes.map((n) => n?.capabilities.transfer_near?.max_per_payment));
    const blocklist = new Set((await this.policy.getBlocklist().catch(() => [])).map((b) => b.recipient));
    const recipientSets = mandates.map((m) => m.mandate.recipients);
    const approved = recipientSets.length === 0 ? [] : Object.keys(recipientSets[0]!).filter((r) => recipientSets.every((s) => r in s));
    const names = approved.filter((r) => !blocklist.has(r));
    const own = mandates.at(-1);
    const recipients = await Promise.all(
      names.map(async (recipient) => {
        const rules = recipientSets.map((s) => s[recipient]!);
        const usage = own ? await this.policy.getUsage(own.node.agent_id, recipient) : null;
        return {
          recipient,
          perPayment: minBig([...rules.map((r) => r.per_payment_cap), maxPerPayment])!,
          daily: minBig([...rules.map((r) => r.daily_cap), ...mandates.map((m) => m.mandate.daily_cap)])!,
          usedToday: usage?.recipient_used_today ?? 0n,
          confirmAbove: minBig([...rules.map((r) => r.confirm_above), ...mandates.map((m) => m.mandate.confirm_above)]),
        };
      }),
    );
    const budgets = await Promise.all(
      mandates.map(async (m) => ({
        agentId: m.node.agent_id,
        handle: nodes.find((n) => n?.agent_id === m.node.agent_id)?.handle ?? `#${m.node.agent_id}`,
        daily: m.mandate.daily_cap,
        usedToday: (await this.policy.getUsage(m.node.agent_id)).mandate_used_today,
      })),
    );
    return {
      account: this.account,
      agentId: agent.agent_id,
      handle: agent.handle,
      connection,
      paused: policyView.paused,
      agentStatus: agent.status.state,
      maxPerPayment,
      recipients,
      budgets,
      availableBalance: policyView.available_balance,
      blocked: approved.filter((r) => blocklist.has(r)),
    };
  }

  /** The owner's browsing rules for this agent: its own and those of every agent above it. */
  async accessRules(): Promise<AccessRules> {
    const connection = await this.connection();
    return loadAccessRules(await this.registry(), connection.agent_id);
  }

  /** Would this payment be allowed by the owner's policy? Reads only; nothing moves. */
  async preview(recipient: string, amount: bigint) {
    const connection = await this.connection();
    const registry = await this.registry();
    const path = await registry.getPath(connection.agent_id);
    const action: Action = { type: "TransferNear", recipient, amount };
    return this.policy.preview({ path, executor: this.account, action, requestId: newRequestId() });
  }

  /** Asks the owner's policy to pay. Records the request so an uncertain result can be resolved safely. */
  async pay(recipient: string, amount: bigint, requestId = newRequestId()): Promise<AgentPayResult> {
    const connection = this.cached ?? (await this.connection());
    await this.journal.prepare({ payer: this.account, agentId: connection.agent_id, recipient, amount, requestId });
    const before = this.journal.get(requestId);
    await this.journal.update(requestId, { state: "submitted", attempts: (before?.attempts ?? 0) + 1 });
    const action: Action = { type: "TransferNear", recipient, amount };
    try {
      const { txHash, status } = await this.submit(
        { action: toWireAction(action), request_id: requestId, client: this.client },
        AGENT_EXECUTE_GAS,
      );
      if (txHash) await this.journal.update(requestId, { txHash });
      const parsed = parseFinalStatus(status);
      if (parsed.status === "error") {
        const operation = await this.journal.update(requestId, { state: "uncertain", detail: parsed.message });
        return { operation, txHash, message: `The result is uncertain (${parsed.message}). Check activity before retrying.` };
      }
      const operation = await this.journal.recordOutcome(requestId, parsed);
      return { operation, outcome: parsed, txHash, message: describeOutcome(parsed, amount, recipient) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const operation = await this.journal.update(requestId, { state: "uncertain", detail: message });
      return { operation, message: `The request may not have gone through (${message}). It is safe to check its status with the same request ID.` };
    }
  }

  /** This connection's recent outcomes, newest first. */
  async activity(limit = 20) {
    const connection = await this.connection();
    const all = await this.policy.getActivity(64);
    return all
      .filter((a) => a.leaf === connection.agent_id && (!a.via || a.via.kind === "executor" || a.via.public_key === this.publicKey))
      .slice(0, limit);
  }

  // ---------------------------------------------------------------- x402

  /** The x402 payment account this key controls: the implicit account of the key. */
  get x402Account(): string {
    return x402AccountFor(this.publicKey);
  }

  /** What this agent may pay through x402 right now. */
  async x402Rules(): Promise<AgentX402Rules> {
    const connection = await this.connection();
    const paymentAccount = this.x402Account;
    const config = await this.policy.getX402Config();
    const off = (note: string): AgentX402Rules => ({
      enabled: false,
      asset: config?.asset ?? null,
      maxPerPayment: null,
      sellers: [],
      unlisted: null,
      budgets: [],
      account: { daily: null, usedToday: 0n },
      paymentAccount,
      paymentAccountReady: false,
      unspent: 0n,
      note,
    });
    if (!config) return off("The owner has not turned on x402 payments.");

    const registry = await this.registry();
    const path = await registry.getPath(connection.agent_id);
    const nodes = await Promise.all(path.map((n) => registry.getAgent(n.agent_id)));
    const maxPerPayment = nodes.some((n) => !n?.x402) ? null : minBig(nodes.map((n) => n?.x402?.max_per_payment));
    const withMandates = (
      await Promise.all(path.map(async (n) => ({ node: n, mandate: await this.policy.getMandate(n.agent_id) })))
    ).filter((m): m is { node: PathNode; mandate: Mandate } => m.mandate !== null && m.mandate.status === "Active");
    const ruled = await Promise.all(withMandates.map(async (m) => ({ ...m, rules: await this.policy.getX402Rules(m.node.agent_id) })));

    const [ready, unspent] = await Promise.all([
      this.rpc.accountExists(paymentAccount).then((exists) => (exists ? isTokenRegistered(this.rpc, config.asset, paymentAccount) : false)).catch(() => false),
      ftBalanceOf(this.rpc, config.asset, paymentAccount).catch(() => 0n),
    ]);
    if (ruled.length === 0) return { ...off("The owner has not approved this agent."), paymentAccountReady: ready, unspent };
    if (ruled.some((r) => r.rules === null)) {
      return { ...off("An approval on this agent's path has no x402 rules."), paymentAccountReady: ready, unspent };
    }
    const sets = ruled.map((r) => r.rules as X402Rules);
    const own = ruled.at(-1)!;
    const names = Object.keys(sets[0]!.sellers).filter((s) => sets.every((rules) => s in rules.sellers));
    const blocked = new Set((await this.policy.getBlocklist().catch(() => [])).map((b) => b.recipient));
    const sellers = await Promise.all(
      names
        .filter((s) => !blocked.has(s))
        .map(async (seller) => ({
          seller,
          perPayment: minBig([...sets.map((r) => r.sellers[seller]!.per_payment_cap), maxPerPayment])!,
          daily: minBig([...sets.map((r) => r.sellers[seller]!.daily_cap), ...sets.map((r) => r.daily_cap)])!,
          usedToday: (await this.policy.getX402Usage(own.node.agent_id, seller)).seller_used_today ?? 0n,
        })),
    );
    const ownUsage = await this.policy.getX402Usage(own.node.agent_id);
    const unlisted = sets.every((r) => r.unlisted)
      ? {
          perPayment: minBig([...sets.map((r) => r.unlisted!.per_payment_cap), maxPerPayment])!,
          daily: minBig([...sets.map((r) => r.unlisted!.daily_cap), ...sets.map((r) => r.daily_cap)])!,
          usedToday: ownUsage.unlisted_used_today,
        }
      : null;
    const budgets = await Promise.all(
      ruled.map(async (r) => ({
        agentId: r.node.agent_id,
        handle: nodes.find((n) => n?.agent_id === r.node.agent_id)?.handle ?? `#${r.node.agent_id}`,
        daily: r.rules!.daily_cap,
        usedToday: (await this.policy.getX402Usage(r.node.agent_id)).mandate_used_today,
      })),
    );
    return {
      enabled: maxPerPayment !== null,
      asset: config.asset,
      maxPerPayment,
      sellers,
      unlisted,
      budgets,
      account: { daily: config.account_daily_cap, usedToday: ownUsage.account_used_today },
      paymentAccount,
      paymentAccountReady: ready,
      unspent,
      ...(maxPerPayment === null ? { note: "This agent's x402 capability is not set, so the registry refuses x402 payments." } : {}),
    };
  }

  /** Would this x402 payment be allowed by the owner's policy? Reads only; nothing moves. */
  async previewX402(asset: string, payTo: string, amount: bigint) {
    const connection = await this.connection();
    const registry = await this.registry();
    const path = await registry.getPath(connection.agent_id);
    const action: Action = { type: "X402Pay", asset, pay_to: payTo, amount };
    return this.policy.preview({ path, executor: this.account, action, requestId: newRequestId() });
  }

  /**
   * Asks the owner's policy to fund one x402 payment: on success, exactly
   * `amount` of `asset` is now in this key's payment account, ready to pay
   * `payTo`. The caller then signs the seller's transfer from that account.
   */
  async fundX402(asset: string, payTo: string, amount: bigint, requestId = newRequestId()): Promise<AgentPayResult> {
    const connection = this.cached ?? (await this.connection());
    await this.journal.prepare({ payer: this.account, agentId: connection.agent_id, recipient: payTo, amount, requestId });
    const before = this.journal.get(requestId);
    await this.journal.update(requestId, { state: "submitted", attempts: (before?.attempts ?? 0) + 1 });
    const action: Action = { type: "X402Pay", asset, pay_to: payTo, amount };
    try {
      const { txHash, status } = await this.submit(
        { action: toWireAction(action), request_id: requestId, client: this.client },
        X402_EXECUTE_GAS,
      );
      if (txHash) await this.journal.update(requestId, { txHash });
      const parsed = parseFinalStatus(status);
      if (parsed.status === "error") {
        const operation = await this.journal.update(requestId, { state: "uncertain", detail: parsed.message });
        return { operation, txHash, message: `The funding result is uncertain (${parsed.message}). Check activity before retrying.` };
      }
      const operation = await this.journal.recordOutcome(requestId, parsed);
      return { operation, outcome: parsed, txHash, message: describeX402Funding(parsed, amount, payTo) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const operation = await this.journal.update(requestId, { state: "uncertain", detail: message });
      return { operation, message: `The funding request may not have gone through (${message}). Check activity before retrying.` };
    }
  }
}

export function describeX402Funding(outcome: Outcome, amount: bigint, payTo: string): string {
  switch (outcome.status) {
    case "settled":
      return `The owner's policy approved ${formatUsdc(amount)} USDC for ${payTo}.`;
    case "failed":
      return `The owner's account could not move ${formatUsdc(amount)} USDC (is there enough USDC, and is the payment account set up?). Nothing was spent.`;
    case "awaiting_confirmation":
      return `Waiting for the owner to confirm ${formatUsdc(amount)} USDC to ${payTo}.`;
    case "denied":
      return `Blocked (${outcome.reason}): ${describeReason(outcome.reason)}${outcome.detail ? ` (${outcome.detail})` : ""}`;
  }
}

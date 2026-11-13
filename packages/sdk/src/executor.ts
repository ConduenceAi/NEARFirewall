/**
 * Executor side: build `registry.execute` calls, track them in an operation
 * journal, and resolve uncertain submissions without ever paying twice.
 *
 * Safety rule: an uncertain request is only ever resubmitted with the same
 * request ID. The payer's policy rejects a request ID it has already seen, so
 * a resubmission can never produce a second payment.
 */
import { TGAS } from "./amounts.ts";
import { fromBase64 } from "./rpc.ts";
import type { PolicyClient } from "./clients.ts";
import { toWireAction } from "./owner.ts";
import { Outcome } from "./types.ts";
import type { Action, Reason } from "./types.ts";

/** Gas for `registry.execute`: routing, the policy check, the transfer, and settlement. */
export const EXECUTE_GAS = 150n * TGAS;

export function newRequestId(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface PaymentRequest {
  payer: string;
  agentId: string;
  recipient: string;
  amount: bigint;
  requestId?: string;
  expectedRevision?: number;
}

export function executeArgs(request: PaymentRequest & { requestId: string }) {
  const action: Action = { type: "TransferNear", recipient: request.recipient, amount: request.amount };
  return {
    payer: request.payer,
    agent_id: request.agentId,
    grant_id: null,
    action: toWireAction(action),
    request_id: request.requestId,
    expected_revision: request.expectedRevision ?? null,
  };
}

/**
 * Reads the final value of an execute transaction. The registry and the policy
 * return an Outcome; a panic anywhere shows up as a failure status.
 */
export function parseFinalStatus(status: unknown): Outcome | { status: "error"; message: string } {
  if (status && typeof status === "object") {
    if ("SuccessValue" in status && typeof status.SuccessValue === "string") {
      const text = new TextDecoder().decode(fromBase64(status.SuccessValue));
      const parsed = Outcome.safeParse(text ? JSON.parse(text) : null);
      return parsed.success ? parsed.data : { status: "error", message: `Unexpected result: ${text}` };
    }
    if ("Failure" in status) return { status: "error", message: JSON.stringify(status.Failure) };
  }
  return { status: "error", message: `Unexpected status: ${JSON.stringify(status)}` };
}

// ------------------------------------------------------------------ journal

/** `awaiting` means the payment waits for the owner's confirmation ("ask me first"). */
export type OperationState = "prepared" | "submitted" | "settled" | "denied" | "failed" | "uncertain" | "awaiting";

export interface Operation {
  requestId: string;
  agentId: string;
  payer: string;
  recipient: string;
  amount: string;
  state: OperationState;
  reason?: Reason;
  detail?: string;
  txHash?: string;
  attempts: number;
  createdAt: number;
  updatedAt: number;
}

export interface JournalStore {
  load(): Promise<Operation[]>;
  save(operations: Operation[]): Promise<void>;
}

export class MemoryJournalStore implements JournalStore {
  private data: Operation[] = [];
  async load() {
    return structuredClone(this.data);
  }
  async save(operations: Operation[]) {
    this.data = structuredClone(operations);
  }
}

const FINAL_STATES: OperationState[] = ["settled", "denied", "failed"];

export class OperationJournal {
  private readonly store: JournalStore;
  private ops = new Map<string, Operation>();
  private loaded = false;

  constructor(store: JournalStore) {
    this.store = store;
  }

  async load() {
    if (this.loaded) return;
    for (const op of await this.store.load()) this.ops.set(op.requestId, op);
    this.loaded = true;
  }

  private async persist() {
    await this.store.save([...this.ops.values()]);
  }

  get(requestId: string) {
    return this.ops.get(requestId);
  }

  list() {
    return [...this.ops.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  unresolved() {
    return this.list().filter((op) => !FINAL_STATES.includes(op.state));
  }

  async prepare(request: PaymentRequest & { requestId: string }): Promise<Operation> {
    await this.load();
    const existing = this.ops.get(request.requestId);
    if (existing) return existing;
    const now = Date.now();
    const op: Operation = {
      requestId: request.requestId,
      agentId: request.agentId,
      payer: request.payer,
      recipient: request.recipient,
      amount: request.amount.toString(),
      state: "prepared",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.ops.set(op.requestId, op);
    await this.persist();
    return op;
  }

  async update(requestId: string, patch: Partial<Operation>): Promise<Operation> {
    const op = this.ops.get(requestId);
    if (!op) throw new Error(`Unknown request ${requestId}`);
    if (FINAL_STATES.includes(op.state) && patch.state && patch.state !== op.state) {
      throw new Error(`Request ${requestId} is already ${op.state}`);
    }
    Object.assign(op, patch, { updatedAt: Date.now() });
    await this.persist();
    return op;
  }

  async recordOutcome(requestId: string, outcome: Outcome): Promise<Operation> {
    switch (outcome.status) {
      case "settled":
        return this.update(requestId, { state: "settled" });
      case "failed":
        return this.update(requestId, { state: "failed" });
      case "awaiting_confirmation":
        return this.update(requestId, { state: "awaiting" });
      case "denied":
        // A duplicate denial means an earlier attempt reached the payer; resolve it from chain state.
        if (outcome.reason === "DUPLICATE_REQUEST") return this.update(requestId, { state: "uncertain" });
        return this.update(requestId, { state: "denied", reason: outcome.reason, detail: outcome.detail ?? undefined });
    }
  }
}

// ------------------------------------------------------------------ executor client

/** Signs and sends one `registry.execute` call. Implemented with the executor's restricted key. */
export type SubmitExecute = (args: ReturnType<typeof executeArgs>, gas: bigint) => Promise<{ txHash?: string; status: unknown }>;

export interface PayResult {
  operation: Operation;
  outcome?: Outcome;
  error?: string;
}

export class ExecutorClient {
  readonly submit: SubmitExecute;
  readonly journal: OperationJournal;
  readonly policyFor: (payer: string) => PolicyClient;

  constructor(submit: SubmitExecute, journal: OperationJournal, policyFor: (payer: string) => PolicyClient) {
    this.submit = submit;
    this.journal = journal;
    this.policyFor = policyFor;
  }

  /** Submits a payment request and records its outcome. */
  async pay(request: PaymentRequest): Promise<PayResult> {
    const requestId = request.requestId ?? newRequestId();
    const op = await this.journal.prepare({ ...request, requestId });
    if (FINAL_STATES.includes(op.state)) return { operation: op };
    return this.attempt({ ...request, requestId });
  }

  private async attempt(request: PaymentRequest & { requestId: string }): Promise<PayResult> {
    const { requestId } = request;
    const before = this.journal.get(requestId);
    await this.journal.update(requestId, { state: "submitted", attempts: (before?.attempts ?? 0) + 1 });
    try {
      const { txHash, status } = await this.submit(executeArgs(request), EXECUTE_GAS);
      if (txHash) await this.journal.update(requestId, { txHash });
      const parsed = parseFinalStatus(status);
      if (parsed.status === "error") {
        const operation = await this.journal.update(requestId, { state: "uncertain", detail: parsed.message });
        return { operation, error: parsed.message };
      }
      const operation = await this.journal.recordOutcome(requestId, parsed);
      // A duplicate denial: an earlier attempt reached the payer. Read its record; never resubmit here.
      if (operation.state === "uncertain") return this.resolve(requestId, false);
      return { operation, outcome: parsed };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const operation = await this.journal.update(requestId, { state: "uncertain", detail: message });
      return { operation, error: message };
    }
  }

  /**
   * Resolves an uncertain request from the payer's on-chain record. If the
   * payer has no record, the request never reached it (or was denied before
   * reserving), so it is resubmitted once with the same request ID.
   */
  async resolve(requestId: string, resubmit = true): Promise<PayResult> {
    const op = this.journal.get(requestId);
    if (!op) throw new Error(`Unknown request ${requestId}`);
    if (FINAL_STATES.includes(op.state)) return { operation: op };
    const record = await this.policyFor(op.payer).getRequest(op.agentId, requestId);
    if (record?.status === "Settled") return { operation: await this.journal.update(requestId, { state: "settled" }) };
    if (record?.status === "Failed") return { operation: await this.journal.update(requestId, { state: "failed" }) };
    if (record?.status === "Pending") return { operation: await this.journal.update(requestId, { state: "uncertain" }) };
    if (record?.status === "Declined" || record?.status === "Expired") {
      const reason = record.status === "Declined" ? "CONFIRMATION_DECLINED" : "CONFIRMATION_EXPIRED";
      return { operation: await this.journal.update(requestId, { state: "denied", reason }) };
    }
    if (!resubmit) return { operation: op };
    return this.attempt({
      payer: op.payer,
      agentId: op.agentId,
      recipient: op.recipient,
      amount: BigInt(op.amount),
      requestId,
    });
  }
}

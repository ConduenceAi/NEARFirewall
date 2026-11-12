import { z } from "zod";
import type { NearRpc } from "./rpc.ts";
import { EMPTY_CODE_HASH } from "./rpc.ts";
import {
  AgentView,
  Mandate,
  PathNode,
  PaymentRequestRecord,
  PolicyActivity,
  PolicyView,
  Preview,
  RecordEntry,
  RegistryActivity,
  UsageView,
} from "./types.ts";
import type { Action } from "./types.ts";
import { toWireAction } from "./owner.ts";

async function viewParsed<S extends z.ZodType>(rpc: NearRpc, contract: string, method: string, args: unknown, schema: S) {
  return schema.parse(await rpc.view(contract, method, args)) as z.infer<S>;
}

/** Read-only client for the registry. */
export class RegistryClient {
  readonly rpc: NearRpc;
  readonly registryId: string;

  constructor(rpc: NearRpc, registryId: string) {
    this.rpc = rpc;
    this.registryId = registryId;
  }

  getAgent(agentId: string) {
    return viewParsed(this.rpc, this.registryId, "get_agent", { agent_id: agentId }, AgentView.nullable());
  }

  resolve(handle: string) {
    return viewParsed(this.rpc, this.registryId, "resolve", { handle }, AgentView.nullable());
  }

  /** Resolves a handle or a numeric agent ID. */
  async find(handleOrId: string) {
    return /^\d+$/.test(handleOrId) ? this.getAgent(handleOrId) : this.resolve(handleOrId);
  }

  getPath(agentId: string) {
    return viewParsed(this.rpc, this.registryId, "get_path", { agent_id: agentId }, z.array(PathNode));
  }

  getChildren(agentId: string, fromIndex = 0, limit = 50) {
    return viewParsed(
      this.rpc,
      this.registryId,
      "get_children",
      { agent_id: agentId, from_index: fromIndex, limit },
      z.array(AgentView),
    );
  }

  getRecords(agentId: string) {
    return viewParsed(this.rpc, this.registryId, "get_records", { agent_id: agentId }, z.array(RecordEntry));
  }

  getRecord(agentId: string, key: string) {
    return viewParsed(this.rpc, this.registryId, "get_record", { agent_id: agentId, key }, z.string().nullable());
  }

  getActivity(agentId: string, limit = 32) {
    return viewParsed(this.rpc, this.registryId, "get_activity", { agent_id: agentId, limit }, z.array(RegistryActivity));
  }

  /** Agent tokens held by an account, as agent views. */
  async agentsOf(accountId: string): Promise<AgentView[]> {
    const tokens = z
      .array(z.object({ token_id: z.string() }))
      .parse(await this.rpc.view(this.registryId, "nft_tokens_for_owner", { account_id: accountId, limit: 100 }));
    const views = await Promise.all(tokens.map((t) => this.getAgent(t.token_id)));
    return views.filter((v): v is AgentView => v !== null);
  }
}

export type PolicyState =
  | { kind: "none" }
  | { kind: "enabled"; codeHash: string }
  | { kind: "other"; codeHash: string };

/** Read-only client for a payer's account policy. */
export class PolicyClient {
  readonly rpc: NearRpc;
  readonly payerId: string;

  constructor(rpc: NearRpc, payerId: string) {
    this.rpc = rpc;
    this.payerId = payerId;
  }

  /**
   * Reports whether payments are enabled on the account. `expectedCodeHash` is
   * the policy hash from the deployment manifest.
   */
  async state(expectedCodeHash?: string): Promise<PolicyState> {
    const account = await this.rpc.viewAccount(this.payerId);
    if (account.codeHash === EMPTY_CODE_HASH) return { kind: "none" };
    if (expectedCodeHash && account.codeHash !== expectedCodeHash) return { kind: "other", codeHash: account.codeHash };
    return { kind: "enabled", codeHash: account.codeHash };
  }

  getPolicy() {
    return viewParsed(this.rpc, this.payerId, "get_policy", {}, PolicyView);
  }

  getRevision() {
    return viewParsed(this.rpc, this.payerId, "get_revision", {}, z.number());
  }

  getMandate(agentId: string) {
    return viewParsed(this.rpc, this.payerId, "get_mandate", { agent_id: agentId }, Mandate.nullable());
  }

  getUsage(agentId: string, recipient?: string) {
    return viewParsed(this.rpc, this.payerId, "get_usage", { agent_id: agentId, recipient: recipient ?? null }, UsageView);
  }

  getRequest(leaf: string, requestId: string) {
    return viewParsed(
      this.rpc,
      this.payerId,
      "get_request",
      { leaf, request_id: requestId },
      PaymentRequestRecord.nullable(),
    );
  }

  getActivity(limit = 20, before?: bigint) {
    return viewParsed(
      this.rpc,
      this.payerId,
      "get_activity",
      { before: before === undefined ? null : Number(before), limit },
      z.array(PolicyActivity),
    );
  }

  /** Runs the payer-side checks for a request without changing state. */
  preview(input: { path: PathNode[]; executor: string; action: Action; requestId: string; expectedRevision?: number }) {
    return viewParsed(
      this.rpc,
      this.payerId,
      "preview",
      {
        ctx: {
          path: input.path.map((n) => ({ agent_id: n.agent_id, generation: Number(n.generation) })),
          executor: input.executor,
          action: toWireAction(input.action),
          request_id: input.requestId,
          expected_revision: input.expectedRevision ?? null,
        },
      },
      Preview,
    );
  }
}

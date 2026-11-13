import { useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { describeReason } from "@nearfirewall/sdk";
import { policyOf } from "../config.ts";
import { useWorkspaceRegistry } from "../workspace-registry.tsx";
import { near, timeText } from "../format.ts";
import { useAsync } from "../hooks.ts";
import { useWallet } from "../wallet.tsx";

type Kind = "paid" | "blocked" | "registry" | "failed" | "awaiting";

interface Entry {
  key: string;
  at: bigint;
  agent: string;
  recipient: string;
  amount: bigint;
  kind: Kind;
  detail: string;
  connection?: string;
}

const FILTERS: { id: "all" | Kind; label: string; tone: "lime" | "sky" | "coral" }[] = [
  { id: "all", label: "All", tone: "lime" },
  { id: "paid", label: "Paid", tone: "lime" },
  { id: "blocked", label: "Blocked", tone: "coral" },
  { id: "registry", label: "Registry", tone: "coral" },
  { id: "failed", label: "Failed", tone: "sky" },
  { id: "awaiting", label: "Awaiting confirmation", tone: "sky" },
];

const DOT: Record<Kind, string> = { paid: "", blocked: "denied", registry: "denied", failed: "failed", awaiting: "failed" };

const POLICY_OUTCOMES = {
  settled: { kind: "paid", detail: "Paid" },
  denied: { kind: "blocked", detail: "Denied" },
  failed: { kind: "failed", detail: "Transfer failed. The reservation was released." },
  awaiting: { kind: "awaiting", detail: "Waiting for owner confirmation" },
  declined: { kind: "blocked", detail: "Declined by the owner" },
  expired: { kind: "blocked", detail: "Confirmation expired" },
} as const;

/**
 * Settled and blocked attempts, read from the bounded activity logs that both
 * contracts keep on chain. No indexer or backend is involved.
 */
export function ActivityPanel() {
  const { accountId } = useWallet();
  const { registry, policyCodeHash } = useWorkspaceRegistry();
  const [filter, setFilter] = useState<"all" | Kind>("all");
  const [agentFilter, setAgentFilter] = useState<string>("all");

  const data = useAsync(async () => {
    if (!accountId) return [] as Entry[];
    const policy = policyOf(accountId);
    const state = await policy.state(policyCodeHash);
    const view = state.kind === "enabled" ? await policy.getPolicy() : null;
    const payments = view?.registry === registry.registryId ? await policy.getActivity(64) : [];
    const agents = await registry.agentsOf(accountId);
    const handles = new Map(agents.map((a) => [a.agent_id, a.handle]));
    const routed = await Promise.all(
      agents.map(async (a) => (await registry.getActivity(a.agent_id)).map((entry) => ({ agent: a.handle, ...entry }))),
    );

    const entries: Entry[] = payments.map((p) => ({
      key: `p-${p.seq}`,
      at: p.at,
      agent: handles.get(p.leaf) ?? `#${p.leaf}`,
      recipient: p.recipient,
      amount: p.amount,
      ...POLICY_OUTCOMES[p.outcome],
      detail: p.outcome === "denied" && p.reason ? describeReason(p.reason) : POLICY_OUTCOMES[p.outcome].detail,
      connection: p.via?.kind === "connection" ? [p.via.label, p.client].filter(Boolean).join(" · ") : undefined,
    }));
    for (const e of routed.flat()) {
      if (e.outcome !== "denied") continue;
      entries.push({
        key: `r-${e.agent}-${e.seq}`,
        at: e.at,
        agent: e.agent,
        recipient: e.action.recipient,
        amount: e.action.amount,
        kind: "registry",
        detail: e.reason ? describeReason(e.reason) : "Blocked before reaching your account",
      });
    }
    return entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  }, [accountId, registry, policyCodeHash]);

  const all = data.data ?? [];
  const agentNames = useMemo(() => [...new Set(all.map((e) => e.agent))].sort(), [all]);
  const byAgent = all.filter((e) => agentFilter === "all" || e.agent === agentFilter);
  const shown = byAgent.filter((e) => filter === "all" || e.kind === filter);
  const count = (id: "all" | Kind) => (id === "all" ? byAgent.length : byAgent.filter((e) => e.kind === id).length);

  if (!accountId) return <p className="muted">Connect a wallet to see activity.</p>;

  return (
    <section className="activity-panel" aria-labelledby="activity-heading">
      <h1 id="activity-heading" className="visually-hidden">Activity</h1>
      <div className="toolbar">
        <div className="pills" role="group" aria-label="Filter by outcome">
          {FILTERS.map((f) => (
            <button key={f.id} className={`pill ${f.tone === "lime" ? "" : f.tone}`} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
              {f.label} <span className="count">{count(f.id)}</span>
            </button>
          ))}
        </div>
        <button className="icon-btn" onClick={data.reload} disabled={data.loading} aria-label="Refresh" title="Refresh">
          <RefreshCw size={18} className={data.loading ? "spin" : ""} />
        </button>
      </div>

      {agentNames.length > 1 && (
        <>
          <div className="pill-group-label">Agent</div>
          <div className="pills" role="group" aria-label="Filter by agent">
            {["all", ...agentNames].map((name) => (
              <button key={name} className="pill sky" aria-pressed={agentFilter === name} onClick={() => setAgentFilter(name)}>
                {name === "all" ? "Every agent" : name}
              </button>
            ))}
          </div>
        </>
      )}

      {data.error && <p className="notice error">{data.error}</p>}

      {shown.length === 0 ? (
        <p className="empty">{data.loading ? "Loading…" : all.length === 0 ? "Nothing has been attempted yet." : "No entries match these filters."}</p>
      ) : (
        <ul className="feed">
          {shown.map((e) => (
            <li key={e.key}>
              <span className={`dot ${DOT[e.kind]}`} aria-hidden="true" />
              <span className="title">
                {e.agent} → {e.recipient}
              </span>
              <span className="amount">{near(e.amount)}</span>
              <span className="sub">{e.kind === "registry" ? `Blocked by the registry: ${e.detail}` : e.detail}{e.connection && ` · ${e.connection}`}</span>
              <span className="when">{timeText(e.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

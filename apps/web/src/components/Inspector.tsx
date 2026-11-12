/**
 * Right-hand panel for the agent map. For an agent it shows:
 * - its identity and the parameters stored in the registry;
 * - who can manage it and who it can charge;
 * - the effective rules for a payment, computed the way the contracts apply
 *   them: every approval on the agent's path must allow the payment, and every
 *   capability on the path caps it;
 * - records, recent activity, and anything not configured yet.
 */
import { useEffect, type ReactNode } from "react";
import { AlertTriangle, ArrowRight, Check, CircleDashed, ExternalLink, Info, X } from "lucide-react";
import {
  LOCKS,
  describeReason,
  pauseAgent,
  pausePayments,
  removeRecipient,
  resumeAgent,
  resumePayments,
  type AgentView,
  type Mandate,
  type PathNode,
  type WalletTransaction,
} from "@nearfirewall/sdk";
import { config, explorerAccount, explorerContract, explorerNft, policyOf, registry } from "../config.ts";
import { capText, ensureOk, near, statusText, timeText } from "../format.ts";
import { useAction, useAsync } from "../hooks.ts";
import { href } from "../router.ts";
import { useWallet } from "../wallet.tsx";
import type { MapData } from "./AgentMap.tsx";

export type Selection =
  | { kind: "account" }
  | { kind: "agent"; agent: AgentView }
  | { kind: "recipient"; owner: AgentView; account: string };

interface Gap {
  level: "block" | "warn" | "info";
  text: string;
  action?: { label: string; path: string };
}

function Gaps({ items }: { items: Gap[] }) {
  if (items.length === 0) {
    return (
      <p className="insp-ok">
        <Check size={15} aria-hidden="true" /> Everything needed is configured.
      </p>
    );
  }
  return (
    <ul className="insp-gaps">
      {items.map((g) => (
        <li key={g.text} className={g.level}>
          {g.level === "block" ? <AlertTriangle size={15} aria-hidden="true" /> : g.level === "warn" ? <CircleDashed size={15} aria-hidden="true" /> : <Info size={15} aria-hidden="true" />}
          <div className="insp-gap-content">
            <p>{g.text}</p>
            {g.action && (
              <a href={href(g.action.path)} className="text-link">
                {g.action.label} <ArrowRight size={13} aria-hidden="true" />
              </a>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

function Facts({ rows }: { rows: readonly (readonly [string, ReactNode])[] }) {
  return (
    <dl className="insp-facts">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function ExplorerLink({ url, children }: { url: string; children: ReactNode }) {
  return (
    <a className="insp-explorer" href={url} target="_blank" rel="noreferrer" title="Open in explorer">
      <span>{children}</span><ExternalLink size={13} aria-hidden="true" />
      <span className="visually-hidden"> (opens in explorer)</span>
    </a>
  );
}

function AccountLink({ account }: { account: string }) {
  return <ExplorerLink url={explorerAccount(account)}>{account}</ExplorerLink>;
}

function AgentLink({ id, label }: { id: string; label?: string }) {
  return <ExplorerLink url={explorerNft(config.registryId, id)}>{label ?? `#${id}`}</ExplorerLink>;
}

function Section({ title, explorerUrl, children }: { title: string; explorerUrl?: string; children: ReactNode }) {
  return (
    <section className="insp-section">
      <h3>{explorerUrl ? <ExplorerLink url={explorerUrl}>{title}</ExplorerLink> : title}</h3>
      {children}
    </section>
  );
}

export function Inspector({
  selection,
  data,
  onClose,
  onChanged,
}: {
  selection: Selection;
  data: MapData;
  onClose(): void;
  onChanged(): void;
}) {
  const { send } = useWallet();
  const action = useAction();
  const exec = async (label: string, tx: WalletTransaction) => {
    if (await action.run(label, async () => ensureOk(await send(tx)))) onChanged();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const title =
    selection.kind === "account" ? data.account : selection.kind === "agent" ? selection.agent.handle : selection.account;
  const kindLabel = selection.kind === "account" ? "Your account" : selection.kind === "agent" ? "Agent" : "Recipient";

  return (
    <aside className="inspector" aria-label={`${kindLabel} details`}>
      <header className="insp-head">
        <div className="insp-heading">
          <span className="eyebrow">{kindLabel}</span>
          <h2>{selection.kind === "agent" ? <AgentLink id={selection.agent.agent_id} label={title} /> : <AccountLink account={title} />}</h2>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close details" title="Close">
          <X size={17} />
        </button>
      </header>
      <div className="insp-body">
        {action.message && <p className={`notice ${action.message.kind}`}>{action.message.text}</p>}
        {selection.kind === "account" && <AccountDetails data={data} busy={action.busy} exec={exec} />}
        {selection.kind === "agent" && <AgentDetails agent={selection.agent} data={data} busy={action.busy} exec={exec} />}
        {selection.kind === "recipient" && (
          <RecipientDetails owner={selection.owner} account={selection.account} data={data} busy={action.busy} exec={exec} />
        )}
      </div>
    </aside>
  );
}

type Exec = (label: string, tx: WalletTransaction) => Promise<void>;

// ------------------------------------------------------------------ account

function AccountDetails({ data, busy, exec }: { data: MapData; busy: boolean; exec: Exec }) {
  const p = data.policy;
  const approved = data.agents.filter((a) => data.mandates.get(a.agent_id)?.status === "Active").length;
  const gaps: Gap[] = [];
  if (data.state.kind === "none") {
    gaps.push({ level: "block", text: "Payments are not enabled, so no agent can pay from this account.", action: { label: "Enable payments", path: "/app/payments" } });
  }
  if (data.state.kind === "other") {
    gaps.push({ level: "block", text: "This account runs a different contract. NEARFirewall will not install its policy here." });
  }
  if (p?.paused) gaps.push({ level: "block", text: "All agent payments are paused.", action: { label: "Payments", path: "/app/payments" } });
  if (data.agents.length === 0) gaps.push({ level: "warn", text: "You hold no agents yet.", action: { label: "Register an agent", path: "/app/agents" } });
  else if (p && approved === 0) {
    gaps.push({ level: "warn", text: "No agent is approved to pay anyone.", action: { label: "Approve recipients", path: "/app/payments" } });
  }
  if (p && p.account_daily_cap === null) {
    gaps.push({ level: "info", text: "No account-wide daily cap. Each agent is limited only by its own budget.", action: { label: "Set a cap", path: "/app/payments" } });
  }

  return (
    <>
      <p className="insp-summary">
        Your wallet owns every agent here and is the only account they can charge. Your policy contract runs on this account and checks every request.
      </p>
      <Section title="Payment policy" explorerUrl={p ? explorerContract(data.account) : undefined}>
        {p ? (
          <Facts
            rows={[
              ["Payments", p.paused ? "Paused" : "On"],
              ["Available to agents", near(p.available_balance)],
              ["Spent today", near(p.account_used_today)],
              ["Account daily cap", p.account_daily_cap === null ? "None" : near(p.account_daily_cap)],
              ["Reserved in flight", near(p.reserved_total)],
              ["Safety buffer", near(p.safety_buffer)],
              ["Policy revision", p.revision.toString()],
              ["Trusted registry", <ExplorerLink url={explorerContract(p.registry)}>{p.registry}</ExplorerLink>],
            ]}
          />
        ) : (
          <p className="hint">Not installed on this account.</p>
        )}
      </Section>
      <Section title="Agents">
        <Facts
          rows={[
            ["Held", String(data.agents.length)],
            ["Approved to pay", String(approved)],
          ]}
        />
      </Section>
      <Section title="Setup checks">
        <Gaps items={gaps} />
      </Section>
      {p && (
        <div className="insp-actions">
          {p.paused ? (
            <button disabled={busy} onClick={() => void exec("Resume payments", resumePayments(data.account))}>
              Resume all payments
            </button>
          ) : (
            <button className="danger" disabled={busy} onClick={() => void exec("Pause payments", pausePayments(data.account))}>
              Pause all agent payments
            </button>
          )}
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ agent

interface PathEntry {
  node: PathNode;
  agent: AgentView | null;
  mandate: Mandate | null;
  stale: boolean;
}

async function loadAgentDetail(data: MapData, agent: AgentView) {
  const path = await registry.getPath(agent.agent_id);
  const known = new Map(data.agents.map((a) => [a.agent_id, a]));
  const policy = policyOf(data.account);
  const enabled = data.state.kind === "enabled";
  const entries: PathEntry[] = await Promise.all(
    path.map(async (node, i) => {
      const view = known.get(node.agent_id) ?? (await registry.getAgent(node.agent_id));
      const mandate = enabled ? await policy.getMandate(node.agent_id) : null;
      const stale =
        mandate !== null &&
        (mandate.path.length !== i + 1 ||
          mandate.path.some((m, j) => m.agent_id !== path[j]?.agent_id || m.generation !== path[j]?.generation));
      return { node, agent: view, mandate, stale };
    }),
  );
  const own = entries.at(-1)?.mandate ?? null;
  const [records, registryActivity, policyActivity, recipientUsage] = await Promise.all([
    registry.getRecords(agent.agent_id),
    registry.getActivity(agent.agent_id, 10),
    enabled ? policy.getActivity(64) : Promise.resolve([]),
    own
      ? Promise.all(
          Object.keys(own.recipients).map(async (r) => [r, (await policy.getUsage(agent.agent_id, r)).recipient_used_today ?? 0n] as const),
        )
      : Promise.resolve([] as (readonly [string, bigint])[]),
  ]);
  return {
    entries,
    records,
    registryDenials: registryActivity.filter((a) => a.outcome === "denied"),
    payments: policyActivity.filter((a) => a.leaf === agent.agent_id).slice(0, 6),
    recipientUsage: new Map(recipientUsage),
  };
}

function minBig(values: bigint[]): bigint | null {
  return values.length === 0 ? null : values.reduce((a, b) => (b < a ? b : a));
}

function AgentDetails({ agent, data, busy, exec }: { agent: AgentView; data: MapData; busy: boolean; exec: Exec }) {
  const detail = useAsync(() => loadAgentDetail(data, agent), [agent, data]);
  const d = detail.data;
  const now = BigInt(Date.now()) * 1_000_000n;

  const expired = (t: bigint | null | undefined) => t !== null && t !== undefined && t <= now;
  const holders = d ? [...new Set(d.entries.map((e) => e.agent?.holder).filter((h): h is string => !!h))] : [];

  // Effective rules, as the registry and the policy apply them.
  const blocks: string[] = [];
  let effective: { recipient: string; perPayment: bigint; daily: bigint }[] = [];
  let capability: bigint | null = null;
  if (d) {
    for (const e of d.entries) {
      const self = e.node.agent_id === agent.agent_id;
      const name = e.agent?.handle ?? `#${e.node.agent_id}`;
      if (e.agent?.status.state === "paused") blocks.push(self ? "This agent is paused." : `${name} above it is paused, which pauses this branch.`);
      if (e.agent?.status.state === "removed") blocks.push(`${name} above it was removed.`);
      if (expired(e.agent?.expires_at)) blocks.push(self ? "This agent has expired." : `${name} above it has expired.`);
    }
    const caps = d.entries.map((e) => e.agent?.capabilities.transfer_near?.max_per_payment);
    capability = caps.some((c) => c === undefined) ? null : minBig(caps as bigint[]);
    if (capability === null) blocks.push("Its capabilities (or a parent's) do not allow payments.");
    if (agent.holder !== data.account) blocks.push("You no longer hold this agent, so it cannot charge your account.");
    if (data.state.kind !== "enabled") blocks.push("Payments are not enabled on your account.");
    if (data.policy?.paused) blocks.push("All agent payments on your account are paused.");

    const governing = d.entries.filter((e) => e.mandate !== null);
    if (data.state.kind === "enabled" && governing.length === 0) blocks.push("No approval covers this agent or any agent above it.");
    for (const e of governing) {
      const name = e.agent?.handle ?? `#${e.node.agent_id}`;
      if (e.mandate!.status === "Revoked") blocks.push(`The approval on ${name} was revoked.`);
      else if (e.stale) blocks.push(`The approval on ${name} is stale: a holder or executor changed after it was set.`);
      else if (expired(e.mandate!.expires_at)) blocks.push(`The approval on ${name} has expired.`);
    }
    if (governing.length > 0) {
      const sets = governing.map((e) => e.mandate!.recipients);
      const names = Object.keys(sets[0]!).filter((r) => sets.every((s) => r in s));
      effective = names.map((r) => {
        const rules = sets.map((s) => s[r]!);
        const perPayment = minBig([...rules.map((x) => x.per_payment_cap), ...(capability !== null ? [capability] : [])])!;
        const daily = minBig([...rules.map((x) => x.daily_cap), ...governing.map((e) => e.mandate!.daily_cap)])!;
        return { recipient: r, perPayment, daily };
      });
    }
  }

  const own = d?.entries.at(-1)?.mandate ?? null;
  const gaps: Gap[] = [];
  if (d) {
    const governing = d.entries.filter((e) => e.mandate !== null);
    if (data.state.kind === "none") gaps.push({ level: "block", text: "Payments are not enabled on your account.", action: { label: "Enable payments", path: "/app/payments" } });
    if (data.state.kind === "enabled" && governing.length === 0) {
      gaps.push({ level: "block", text: "No approved recipients, so this agent cannot pay anyone.", action: { label: "Approve recipients", path: "/app/payments" } });
    } else if (governing.length > 0 && effective.length === 0) {
      gaps.push({ level: "block", text: "No recipient is approved by every approval on its path, so it cannot pay anyone." });
    }
    if (agent.expires_at === null) gaps.push({ level: "info", text: "Never expires. An expiry can only be set at registration." });
    if ((agent.locks & LOCKS.NO_TRANSFER) === 0) gaps.push({ level: "info", text: "Transferable. A transfer voids your approvals for it.", action: { label: "Lock in Agents", path: "/app/agents" } });
    if ((agent.locks & LOCKS.NO_CAPABILITY_RAISE) === 0) gaps.push({ level: "info", text: "Its capabilities can still be raised.", action: { label: "Freeze in Agents", path: "/app/agents" } });
    if (d.records.length === 0) gaps.push({ level: "info", text: "No public records, such as a description or MCP endpoint.", action: { label: "Add records", path: "/app/agents" } });
    if (own && own.status === "Active" && !own.fixed) gaps.push({ level: "info", text: "Its approval can be edited. Mark it fixed to make it revoke-only." });
  }

  const paused = agent.status.state === "paused";

  return (
    <>
      <div className={`insp-verdict ${blocks.length ? "blocked" : "ok"}`}>
        {d ? (
          blocks.length ? (
            <>
              <strong>Cannot pay right now</strong>
              <ul>
                {blocks.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </>
          ) : (
            <>
              <strong>Can pay {effective.length} recipient{effective.length === 1 ? "" : "s"}</strong>
              <span>Within the limits below, with no further signature from you.</span>
            </>
          )
        ) : (
          <span>{detail.error ?? "Checking its rules…"}</span>
        )}
      </div>

      {d && effective.length > 0 && (
        <Section title="Effective rules for a payment">
          <ul className="insp-rules">
            {effective.map((rule) => {
              const usedToday = d.recipientUsage.get(rule.recipient);
              return (
                <li key={rule.recipient}>
                  <strong><AccountLink account={rule.recipient} /></strong>
                  <Facts rows={[
                    ["Per payment", near(rule.perPayment)],
                    ["Per day", near(rule.daily)],
                    ...(own ? [["Used today", usedToday === undefined ? "—" : near(usedToday)] as const] : []),
                  ]} />
                </li>
              );
            })}
          </ul>
          <p className="hint">The tightest of this agent's capability, every approval on its path, and each recipient's limits.</p>
        </Section>
      )}

      {d && (
        <Section title="Budgets on its path">
          {d.entries.some((e) => e.mandate) ? (
            <ul className="insp-list">
              {d.entries
                .filter((e) => e.mandate)
                .map((e) => {
                  const m = e.mandate!;
                  const used = data.usage.get(e.node.agent_id)?.mandate_used_today;
                  return (
                    <li key={e.node.agent_id}>
                      <strong><AgentLink id={e.node.agent_id} label={e.agent?.handle} /></strong>
                      <span className="insp-list-meta">
                        {e.node.agent_id === agent.agent_id ? "Own budget" : "Shared branch budget"} · {used !== undefined ? `${near(used)} of ` : ""}
                        {near(m.daily_cap)} per day · {m.status}
                        {m.fixed ? " · fixed" : ""}
                        {e.stale ? " · stale" : ""} · expires {timeText(m.expires_at)}
                      </span>
                    </li>
                  );
                })}
            </ul>
          ) : (
            <p className="hint">None.</p>
          )}
        </Section>
      )}

      <Section title="Identity">
        <Facts
          rows={[
            ["Token ID", <AgentLink id={agent.agent_id} />],
            ["Holder", agent.holder ? <AccountLink account={agent.holder} /> : "none (removed)"],
            ["Executor", <AccountLink account={agent.executor} />],
            ["Registry", <ExplorerLink url={explorerContract(config.registryId)}>{config.registryId}</ExplorerLink>],
            ["Status", statusText(agent)],
            ["Can request", capText(agent.capabilities)],
            ["Expires", timeText(agent.expires_at)],
            ["Parent", agent.parent ? <AgentLink id={agent.parent} /> : "none (top level)"],
            ["Depth", String(agent.depth)],
            ["Generation", agent.generation.toString()],
            ["Registered", timeText(agent.created_at)],
          ]}
        />
      </Section>

      <Section title="Access">
        <ul className="insp-list">
          <li>
            <strong>Owns and manages it:</strong>
            <span className="insp-account-list">
              {holders.length ? holders.map((holder) => <AccountLink key={holder} account={holder} />) : "…"}
            </span>
            {holders.length > 1 ? "Holders of this agent and its ancestors." : null}
          </li>
          <li>
            <strong>Can request payments:</strong> its executor, <AccountLink account={agent.executor} />, with a key limited to the registry
          </li>
          <li>
            <strong>Can be charged:</strong> {agent.holder ? <AccountLink account={agent.holder} /> : "No current holder"}{agent.holder === data.account ? " (yours)" : ""}
          </li>
          <li className="muted">Delegated roles (manager, proposer) are planned and not available yet.</li>
        </ul>
      </Section>

      <Section title="Locks">
        <Facts
          rows={[
            ["Non-transferable", (agent.locks & LOCKS.NO_TRANSFER) !== 0 ? "Yes, permanently" : "No"],
            ["Capabilities can only narrow", (agent.locks & LOCKS.NO_CAPABILITY_RAISE) !== 0 ? "Yes, permanently" : "No"],
          ]}
        />
      </Section>

      <Section title="Records">
        {d?.records.length ? (
          <Facts rows={d.records.map((r) => [r.key, r.value] as [string, ReactNode])} />
        ) : (
          <p className="hint">{d ? "None. Records let apps read the agent's public details." : "…"}</p>
        )}
      </Section>

      <Section title="Setup checks">{d ? <Gaps items={gaps} /> : <p className="hint">…</p>}</Section>

      {d && (d.payments.length > 0 || d.registryDenials.length > 0) && (
        <Section title="Recent activity">
          <ul className="insp-list">
            {d.payments.map((a) => (
              <li key={`p${a.seq}`} className={a.outcome === "settled" ? "" : "deny"}>
                {near(a.amount)} → <AccountLink account={a.recipient} /> · {a.outcome === "settled" ? "paid" : a.reason ? describeReason(a.reason) : a.outcome}
              </li>
            ))}
            {d.registryDenials.slice(0, 4).map((a) => (
              <li key={`r${a.seq}`} className="deny">
                {near(a.action.amount)} → <AccountLink account={a.action.recipient} /> · {a.reason ? describeReason(a.reason) : "blocked"}
              </li>
            ))}
          </ul>
          <a className="text-link" href={href("/app/activity")}>
            All activity <ArrowRight size={13} />
          </a>
        </Section>
      )}

      <div className="insp-actions">
        {agent.status.state !== "removed" &&
          (paused ? (
            <button disabled={busy} onClick={() => void exec("Resume", resumeAgent(config.registryId, agent.agent_id))}>
              Resume agent
            </button>
          ) : (
            <button disabled={busy} onClick={() => void exec("Pause", pauseAgent(config.registryId, agent.agent_id))}>
              Pause agent and its branch
            </button>
          ))}
        <a className="btn" href={href("/app/payments")}>
          Manage approvals
        </a>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ recipient

function RecipientDetails({ owner, account, data, busy, exec }: { owner: AgentView; account: string; data: MapData; busy: boolean; exec: Exec }) {
  const mandate = data.mandates.get(owner.agent_id);
  const rule = mandate?.recipients[account];
  const usage = useAsync(() => policyOf(data.account).getUsage(owner.agent_id, account), [owner.agent_id, account]);
  const now = BigInt(Date.now()) * 1_000_000n;
  const gaps: Gap[] = [];
  if (rule?.expires_at && rule.expires_at <= now) gaps.push({ level: "block", text: "This approval has expired." });
  if (rule && rule.expires_at === null) gaps.push({ level: "info", text: "No expiry: the approval lasts until you remove it." });

  return (
    <>
      <p className="insp-summary">
        <strong><AgentLink id={owner.agent_id} label={owner.handle} /></strong> may pay this account, and agents below it may too if the approval covers their branch.
      </p>
      {rule ? (
        <Section title="Limits" explorerUrl={explorerContract(data.account)}>
          <Facts
            rows={[
              ["Per payment", near(rule.per_payment_cap)],
              ["Per day", near(rule.daily_cap)],
              ["Used today", usage.data?.recipient_used_today !== undefined && usage.data.recipient_used_today !== null ? near(usage.data.recipient_used_today) : "…"],
              ["Expires", timeText(rule.expires_at)],
              ["Agent daily budget", `${near(mandate!.daily_cap)}/day`],
            ]}
          />
        </Section>
      ) : (
        <p className="hint">This recipient is no longer approved.</p>
      )}
      <Section title="Setup checks">
        <Gaps items={gaps} />
      </Section>
      {rule && mandate && mandate.status === "Active" && !mandate.fixed && (
        <div className="insp-actions">
          <button className="danger" disabled={busy} onClick={() => void exec("Remove recipient", removeRecipient(data.account, owner.agent_id, account))}>
            Remove this recipient
          </button>
        </div>
      )}
    </>
  );
}

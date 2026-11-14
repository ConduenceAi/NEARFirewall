import { useEffect, useState } from "react";
import {
  approveRecipient,
  confirmPayment,
  declinePayment,
  describeReason,
  enablePayments,
  expirePayment,
  parseNear,
  pausePayments,
  removeRecipient,
  resumePayments,
  revokeMandate,
  setAccountDailyCap,
  setConfirmAbove,
  setMandate,
  type AgentView,
  type Mandate,
  type PathNode,
  Outcome,
  type PolicyClient,
  type WalletTransaction,
} from "@nearfirewall/sdk";
import { config, policyOf } from "../config.ts";
import { useWorkspaceRegistry } from "../workspace-registry.tsx";
import { ensureOk, near, timeText } from "../format.ts";
import { useAction, useAsync } from "../hooks.ts";
import { useWallet } from "../wallet.tsx";
import { VendorsWizard } from "./VendorsWizard.tsx";
import { Safeguards } from "./Safeguards.tsx";
import { X402Section } from "./X402Panel.tsx";

type Execute = (label: string, tx: WalletTransaction | (() => WalletTransaction | Promise<WalletTransaction>), handle?: (value: unknown) => void) => Promise<boolean>;

export function PaymentsPanel({ onPendingChanged }: { onPendingChanged(): void }) {
  const { accountId, send } = useWallet();
  const { policyCodeHash } = useWorkspaceRegistry();
  const action = useAction();
  const state = useAsync(
    () => (accountId ? policyOf(accountId).state(policyCodeHash) : Promise.resolve(null)),
    [accountId, action.busy, policyCodeHash],
  );

  if (!accountId) return <p className="muted">Connect a wallet to manage payments.</p>;
  const exec: Execute = (label, tx, handle) => action.run(label, async () => {
    const result = ensureOk(await send(typeof tx === "function" ? await tx() : tx));
    handle?.(result.value);
  });

  return (
    <section>
      <h1 className="visually-hidden">Payments</h1>
      {action.message && <p className={`notice ${action.message.kind}`}>{action.message.text}</p>}
      {state.error && <p className="notice error">{state.error}</p>}
      {!state.data && !state.error && <p role="status">Checking your payment policy…</p>}
      {state.data?.kind === "none" && <EnableCard accountId={accountId} busy={action.busy} exec={exec} />}
      {state.data?.kind === "other" && (
        <p className="notice error">
          This account already runs a different contract (code hash {state.data.codeHash}). NEARFirewall will not replace it.
          Use an account without a contract.
        </p>
      )}
      {state.data?.kind === "enabled" && <Policy policy={policyOf(accountId)} busy={action.busy} exec={exec} onPendingChanged={onPendingChanged} />}
    </section>
  );
}

function EnableCard({ accountId, busy, exec }: { accountId: string; busy: boolean; exec: Execute }) {
  const [cap, setCap] = useState("");
  const { registry: { registryId } } = useWorkspaceRegistry();
  const enable = () => exec("Enable payments", async () => {
    const accountCap = cap ? parseNear(cap) : null;
    if (config.policyGlobalCodeHash) {
      return enablePayments(accountId, registryId, { globalCodeHash: config.policyGlobalCodeHash }, accountCap);
    }
    const response = await fetch(config.policyWasmUrl);
    if (!response.ok || response.headers.get("content-type")?.includes("text/html")) {
      throw new Error("Policy WASM is unavailable. Run the contract build and copy the WASM into apps/web/public.");
    }
    const code = new Uint8Array(await response.arrayBuffer());
    return enablePayments(accountId, registryId, { code }, accountCap);
  });
  return (
    <div className="card" id="enable-payments">
      <h3>Enable agent payments on your account</h3>
      <p>
        This installs the NEARFirewall payment policy on <strong>{accountId}</strong> and connects it to the registry
        <code> {registryId}</code>. Agents can then pay only the recipients
        you approve, within the limits you set. You keep full control of your account.
      </p>
      {!config.policyGlobalCodeHash && (
        <p className="hint">The contract code is stored on your account, which locks part of your balance for storage.</p>
      )}
      <label>
        Optional account-wide daily cap across all agents (NEAR)
        <input value={cap} onChange={(e) => setCap(e.target.value)} inputMode="decimal" />
      </label>
      <button disabled={busy} onClick={() => void enable()}>
        Enable payments
      </button>
    </div>
  );
}

function Policy({ policy, busy, exec, onPendingChanged }: { policy: PolicyClient; busy: boolean; exec: Execute; onPendingChanged(): void }) {
  const payer = policy.payerId;
  const { registry } = useWorkspaceRegistry();
  const view = useAsync(() => policy.getPolicy(), [payer, busy]);
  const compatible = view.data?.registry === registry.registryId;
  const agents = useAsync(() => compatible ? registry.agentsOf(payer) : Promise.resolve([]), [payer, compatible, busy]);
  const [cap, setCap] = useState("");
  const v = view.data;
  if (view.error) return <p className="notice error">Could not read the payment policy. {view.error}</p>;
  if (v && !compatible) return <p className="notice error">This account’s policy trusts <code>{v.registry}</code>. Use that registry to manage its approvals, or connect a fresh named account for a new registry and policy.</p>;

  return (
    <>
      {v && (
        <div className="card">
          <div className="row">
            <h3>Policy</h3>
            <span className={`badge ${v.paused ? "paused" : "active"}`}>{v.paused ? "Payments paused" : "Payments on"}</span>
            <span className="badge">revision {v.revision.toString()}</span>
          </div>
          <dl className="facts">
            <dt>Available to agents</dt>
            <dd>{near(v.available_balance)}</dd>
            <dt>Spent today, all agents</dt>
            <dd>{near(v.account_used_today)}</dd>
            <dt>Account daily cap</dt>
            <dd>{v.account_daily_cap === null ? "none" : near(v.account_daily_cap)}</dd>
            <dt>Reserved in flight</dt>
            <dd>{near(v.reserved_total)}</dd>
          </dl>
          <div className="actions">
            {v.paused ? (
              <button disabled={busy} onClick={() => exec("Resume payments", resumePayments(payer))}>
                Resume payments
              </button>
            ) : (
              <button className="danger" disabled={busy} onClick={() => exec("Pause payments", pausePayments(payer))}>
                Pause all agent payments
              </button>
            )}
            <input value={cap} onChange={(e) => setCap(e.target.value)} placeholder="cap in NEAR" inputMode="decimal" />
            <button disabled={busy || !cap} onClick={() => exec("Set account cap", () => setAccountDailyCap(payer, parseNear(cap)))}>
              Set daily cap
            </button>
            {v.account_daily_cap !== null && (
              <button disabled={busy} onClick={() => exec("Remove account cap", setAccountDailyCap(payer, null))}>
                Remove cap
              </button>
            )}
          </div>
        </div>
      )}
      {v?.pending !== undefined && <PendingPayments policy={policy} agents={agents.data ?? []} paused={v.paused} revision={Number(v.revision)} busy={busy} exec={exec} onPendingChanged={onPendingChanged} />}
      {v?.blocked !== undefined && <Safeguards policy={policy} busy={busy} exec={exec} />}
      {agents.error && <p className="notice error">{agents.error}</p>}
      <h3>Approved agents</h3>
      {(agents.data ?? []).map((agent) => (
        <MandateCard key={agent.agent_id} agent={agent} policy={policy} busy={busy} exec={exec} confirmations={v?.pending !== undefined} />
      ))}
      {compatible && <VendorsWizard payer={payer} busy={busy} confirmations={v?.pending !== undefined} onSigned={() => { view.reload(); agents.reload(); }} />}
      {compatible && <X402Section policy={policy} agents={agents.data ?? []} busy={busy} exec={exec} />}
    </>
  );
}

function PendingPayments({ policy, agents, paused, revision, busy, exec, onPendingChanged }: {
  policy: PolicyClient; agents: AgentView[]; paused: boolean; revision: number; busy: boolean; exec: Execute; onPendingChanged(): void;
}) {
  const pending = useAsync(() => policy.getPending(), [policy.payerId]);
  const refresh = pending.reload;
  useEffect(() => {
    const timer = window.setInterval(refresh, 15000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  const payer = policy.payerId;
  const handles = new Map(agents.map((agent) => [agent.agent_id, agent.handle]));

  return <section className="card waiting-payments" aria-labelledby="waiting-title">
    <div className="row"><h3 id="waiting-title">Ask me first</h3><button type="button" onClick={refresh} disabled={pending.loading}>Refresh</button></div>
    {pending.error && <p className="notice error">{pending.error}</p>}
    {!pending.error && !pending.data?.length && <p>{pending.loading || pending.data === undefined ? "Checking for waiting payments…" : "No payments are waiting for you."}</p>}
    {pending.data?.map((payment) => {
      const expired = payment.expires_at <= BigInt(Date.now()) * 1_000_000n;
      const confirmation = async (approve: boolean) => {
        const tx = approve ? confirmPayment(payer, payment.leaf, payment.request_id, revision)
          : (expired ? expirePayment : declinePayment)(payer, payment.leaf, payment.request_id);
        await exec(approve ? "Confirm payment" : expired ? "Release reservation" : "Decline payment", tx, approve ? (value) => {
          const result = Outcome.parse(value);
          if (result.status === "denied") throw new Error(describeReason(result.reason));
          if (result.status !== "settled") throw new Error("The transfer did not settle. Check Activity for the outcome.");
        } : undefined);
        refresh();
        onPendingChanged();
      };
      return <article key={`${payment.leaf}:${payment.request_id}`} className="insp-section">
        <strong>{near(payment.amount)} → {payment.recipient}</strong>
        <p className="hint">{handles.get(payment.leaf) ?? `Agent #${payment.leaf}`}{payment.via?.kind === "connection" && ` · ${payment.via.label}`}{payment.client && ` · ${payment.client}`}<br />{expired ? "Expired" : "Confirm by"} {timeText(payment.expires_at)}</p>
        <div className="actions">
          <button className="primary" type="button" disabled={busy || paused || expired} onClick={() => void confirmation(true)}>Confirm payment</button>
          <button type="button" disabled={busy} onClick={() => void confirmation(false)}>{expired ? "Release reservation" : "Decline"}</button>
        </div>
      </article>;
    })}
  </section>;
}

function pathsEqual(a: PathNode[], b: PathNode[]) {
  return a.length === b.length && a.every((n, i) => n.agent_id === b[i]?.agent_id && n.generation === b[i]?.generation);
}

function MandateCard({
  agent,
  policy,
  busy,
  exec,
  confirmations,
}: {
  agent: AgentView;
  policy: PolicyClient;
  busy: boolean;
  exec: Execute;
  confirmations: boolean;
}) {
  const { registry } = useWorkspaceRegistry();
  const data = useAsync(async () => {
    const mandate = await policy.getMandate(agent.agent_id);
    if (!mandate) return null;
    const [path, usage] = await Promise.all([
      registry.getPath(agent.agent_id),
      Promise.all(Object.keys(mandate.recipients).map((r) => policy.getUsage(agent.agent_id, r).then((u) => [r, u] as const))),
    ]);
    return { mandate, path, usage: new Map(usage) };
  }, [agent.agent_id, busy, registry]);
  const [recipient, setRecipient] = useState("");
  const [per, setPer] = useState("");
  const [daily, setDaily] = useState("");
  const [threshold, setThreshold] = useState("");
  const [thresholdRecipient, setThresholdRecipient] = useState("");

  const d = data.data;
  if (!d) return null;
  const { mandate } = d;
  const selectedThreshold = thresholdRecipient ? mandate.recipients[thresholdRecipient]?.confirm_above : mandate.confirm_above;
  const stale = !pathsEqual(mandate.path, d.path);
  const editable = mandate.status === "Active" && !mandate.fixed;
  const used = d.usage.values().next().value?.mandate_used_today ?? 0n;
  const payer = policy.payerId;

  return (
    <div className="card">
      <div className="row">
        <strong>{agent.handle}</strong>
        <span className={`badge ${mandate.status === "Active" ? "active" : "removed"}`}>{mandate.status}</span>
        {mandate.fixed && <span className="badge">fixed</span>}
        {stale && <span className="badge paused">stale: the agent changed holder or executor</span>}
      </div>
      <p>
        Daily budget for this branch: {near(used)} of {near(mandate.daily_cap)} used today. Expires {timeText(mandate.expires_at)}.
      </p>
      {confirmations && <>
        <p>Ask me first {mandate.confirm_above == null ? "is off for this branch" : `above ${near(mandate.confirm_above)}`}.</p>
        {editable && <form className="actions" onSubmit={(e) => {
          e.preventDefault();
          void exec("Update confirmation threshold", () => setConfirmAbove(payer, agent.agent_id, threshold.trim() ? parseNear(threshold) : null, thresholdRecipient || undefined));
        }}>
          <select aria-label="Apply confirmation threshold to" value={thresholdRecipient} onChange={(e) => setThresholdRecipient(e.target.value)}>
            <option value="">Entire branch</option>
            {Object.keys(mandate.recipients).map((who) => <option key={who} value={who}>{who}</option>)}
          </select>
          <input aria-label="Ask me first above (NEAR)" placeholder={selectedThreshold == null ? "NEAR · blank to clear" : `${near(selectedThreshold)} · blank to clear`} inputMode="decimal" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
          <button type="submit" disabled={busy}>Save confirmation threshold</button>
        </form>}
      </>}
      {stale && !mandate.fixed && (
        <button disabled={busy} onClick={() => exec("Re-approve", reapprove(payer, agent.agent_id, mandate, d.path))}>
          Re-approve for the current holder and executor
        </button>
      )}
      <table>
        <thead>
          <tr>
            <th>Recipient</th>
            <th>Per payment</th>
            <th>Daily</th>
            <th>Used today</th>
            <th>Expires</th>
            {confirmations && <th>Ask me first above</th>}
            <th />
          </tr>
        </thead>
        <tbody>
          {Object.entries(mandate.recipients).map(([who, rule]) => (
            <tr key={who}>
              <td>{who}</td>
              <td>{near(rule.per_payment_cap)}</td>
              <td>{near(rule.daily_cap)}</td>
              <td>{near(d.usage.get(who)?.recipient_used_today ?? 0n)}</td>
              <td>{timeText(rule.expires_at)}</td>
              {confirmations && <td>{rule.confirm_above == null ? "—" : near(rule.confirm_above)}</td>}
              <td>
                {editable && (
                  <button disabled={busy} onClick={() => exec("Remove recipient", removeRecipient(payer, agent.agent_id, who))}>
                    Remove
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {editable && (
        <form
          className="inline"
          onSubmit={(e) => {
            e.preventDefault();
            void exec(
              "Approve recipient",
              () => approveRecipient(payer, agent.agent_id, { recipient: recipient.trim(), perPaymentCap: parseNear(per), dailyCap: parseNear(daily) }),
            );
          }}
        >
          <input value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="recipient.testnet" required />
          <input value={per} onChange={(e) => setPer(e.target.value)} placeholder="per payment" inputMode="decimal" required />
          <input value={daily} onChange={(e) => setDaily(e.target.value)} placeholder="per day" inputMode="decimal" required />
          <button disabled={busy} type="submit">
            Approve recipient
          </button>
        </form>
      )}
      {mandate.status === "Active" && (
        <button className="danger" disabled={busy} onClick={() => exec("Revoke", revokeMandate(payer, agent.agent_id))}>
          Revoke this approval
        </button>
      )}
    </div>
  );
}

function reapprove(payer: string, agentId: string, mandate: Mandate, path: PathNode[]) {
  return setMandate(payer, {
    agentId,
    path,
    dailyCap: mandate.daily_cap,
    expiresAt: mandate.expires_at,
    fixed: mandate.fixed,
    confirmAbove: mandate.confirm_above,
    recipients: Object.entries(mandate.recipients).map(([recipient, r]) => ({
      recipient,
      perPaymentCap: r.per_payment_cap,
      dailyCap: r.daily_cap,
      expiresAt: r.expires_at,
      confirmAbove: r.confirm_above,
    })),
  });
}

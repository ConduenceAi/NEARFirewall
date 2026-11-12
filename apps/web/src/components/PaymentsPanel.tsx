import { useState } from "react";
import {
  approveRecipient,
  enablePayments,
  parseNear,
  pausePayments,
  removeRecipient,
  resumePayments,
  revokeMandate,
  setAccountDailyCap,
  setMandate,
  type AgentView,
  type Mandate,
  type PathNode,
  type PolicyClient,
  type WalletTransaction,
} from "@nearfirewall/sdk";
import { config, policyOf, registry } from "../config.ts";
import { ensureOk, near, timeText } from "../format.ts";
import { useAction, useAsync } from "../hooks.ts";
import { useWallet } from "../wallet.tsx";
import { VendorsWizard } from "./VendorsWizard.tsx";

export function PaymentsPanel() {
  const { accountId, send } = useWallet();
  const action = useAction();
  const state = useAsync(
    () => (accountId ? policyOf(accountId).state(config.policyCodeHash) : Promise.resolve(null)),
    [accountId, action.busy],
  );

  if (!accountId) return <p className="muted">Connect a wallet to manage payments.</p>;
  const exec = (label: string, tx: WalletTransaction) => action.run(label, async () => ensureOk(await send(tx)));

  return (
    <section>
      <h1 className="visually-hidden">Payments</h1>
      {action.message && <p className={`notice ${action.message.kind}`}>{action.message.text}</p>}
      {state.error && <p className="notice error">{state.error}</p>}
      {state.data?.kind === "none" && <EnableCard accountId={accountId} busy={action.busy} exec={exec} />}
      {state.data?.kind === "other" && (
        <p className="notice error">
          This account already runs a different contract (code hash {state.data.codeHash}). NEARFirewall will not replace it.
          Use an account without a contract.
        </p>
      )}
      {state.data?.kind === "enabled" && <Policy policy={policyOf(accountId)} busy={action.busy} exec={exec} />}
    </section>
  );
}

function EnableCard({ accountId, busy, exec }: { accountId: string; busy: boolean; exec: (l: string, tx: WalletTransaction) => Promise<boolean> }) {
  const [cap, setCap] = useState("");
  const enable = async () => {
    const accountCap = cap ? parseNear(cap) : null;
    if (config.policyGlobalCodeHash) {
      return exec("Enable payments", enablePayments(accountId, config.registryId, { globalCodeHash: config.policyGlobalCodeHash }, accountCap));
    }
    const response = await fetch(config.policyWasmUrl);
    if (!response.ok) throw new Error(`Could not load the policy WASM from ${config.policyWasmUrl}`);
    const code = new Uint8Array(await response.arrayBuffer());
    return exec("Enable payments", enablePayments(accountId, config.registryId, { code }, accountCap));
  };
  return (
    <div className="card" id="enable-payments">
      <h3>Enable agent payments on your account</h3>
      <p>
        This installs the NEARFirewall payment policy on <strong>{accountId}</strong> and connects it to the registry
        <code> {config.registryId}</code>. Your address and balance stay the same. Agents can then pay only the recipients
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

function Policy({ policy, busy, exec }: { policy: PolicyClient; busy: boolean; exec: (l: string, tx: WalletTransaction) => Promise<boolean> }) {
  const view = useAsync(() => policy.getPolicy(), [policy.payerId, busy]);
  const agents = useAsync(() => registry.agentsOf(policy.payerId), [policy.payerId, busy]);
  const [cap, setCap] = useState("");
  const v = view.data;
  const payer = policy.payerId;

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
            <button disabled={busy || !cap} onClick={() => exec("Set account cap", setAccountDailyCap(payer, parseNear(cap)))}>
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
      <h3>Approved agents</h3>
      {(agents.data ?? []).map((agent) => (
        <MandateCard key={agent.agent_id} agent={agent} policy={policy} busy={busy} exec={exec} />
      ))}
      <VendorsWizard payer={payer} busy={busy} />
    </>
  );
}

function pathsEqual(a: PathNode[], b: PathNode[]) {
  return a.length === b.length && a.every((n, i) => n.agent_id === b[i]?.agent_id && n.generation === b[i]?.generation);
}

function MandateCard({
  agent,
  policy,
  busy,
  exec,
}: {
  agent: AgentView;
  policy: PolicyClient;
  busy: boolean;
  exec: (l: string, tx: WalletTransaction) => Promise<boolean>;
}) {
  const data = useAsync(async () => {
    const mandate = await policy.getMandate(agent.agent_id);
    if (!mandate) return null;
    const [path, usage] = await Promise.all([
      registry.getPath(agent.agent_id),
      Promise.all(Object.keys(mandate.recipients).map((r) => policy.getUsage(agent.agent_id, r).then((u) => [r, u] as const))),
    ]);
    return { mandate, path, usage: new Map(usage) };
  }, [agent.agent_id, busy]);
  const [recipient, setRecipient] = useState("");
  const [per, setPer] = useState("");
  const [daily, setDaily] = useState("");

  const d = data.data;
  if (!d) return null;
  const { mandate } = d;
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
              approveRecipient(payer, agent.agent_id, { recipient: recipient.trim(), perPaymentCap: parseNear(per), dailyCap: parseNear(daily) }),
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
    recipients: Object.entries(mandate.recipients).map(([recipient, r]) => ({
      recipient,
      perPaymentCap: r.per_payment_cap,
      dailyCap: r.daily_cap,
      expiresAt: r.expires_at,
    })),
  });
}

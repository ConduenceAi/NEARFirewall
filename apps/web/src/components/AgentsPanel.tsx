import { useState } from "react";
import {
  LOCKS,
  burnLocks,
  createChild,
  parseNear,
  pauseAgent,
  registerAgent,
  removeAgent,
  removeRecord,
  resumeAgent,
  setRecord,
  transferAgent,
  transferCapability,
  DAY_NS,
  nowNs,
  type AgentView,
} from "@nearfirewall/sdk";
import { config, explorerAccount, registry } from "../config.ts";
import { capText, ensureOk, statusText, timeText } from "../format.ts";
import { useAction, useAsync } from "../hooks.ts";
import { useWallet } from "../wallet.tsx";

export function AgentsPanel() {
  const { accountId, send } = useWallet();
  const agents = useAsync(() => (accountId ? registry.agentsOf(accountId) : Promise.resolve([])), [accountId]);
  const action = useAction();

  if (!accountId) return <p className="muted">Connect a wallet to see your agents.</p>;

  const list = agents.data ?? [];
  const ids = new Set(list.map((a) => a.agent_id));
  const roots = list.filter((a) => !a.parent || !ids.has(a.parent));
  const childrenOf = (id: string) => list.filter((a) => a.parent === id);

  const exec = async (label: string, tx: Parameters<typeof send>[0]) => {
    const ok = await action.run(label, async () => ensureOk(await send(tx)));
    if (ok) agents.reload();
  };

  const renderAgent = (agent: AgentView) => (
    <li key={agent.agent_id}>
      <AgentCard agent={agent} exec={exec} busy={action.busy} />
      {childrenOf(agent.agent_id).length > 0 && <ul className="tree">{childrenOf(agent.agent_id).map(renderAgent)}</ul>}
    </li>
  );

  return (
    <section>
      <h1>Agents</h1>
      {action.message && <p className={`notice ${action.message.kind}`}>{action.message.text}</p>}
      {agents.error && <p className="notice error">{agents.error}</p>}
      {agents.loading && !agents.data && <p className="muted">Loading…</p>}
      {list.length === 0 && !agents.loading && <p className="muted">No agents yet. Register one below.</p>}
      <ul className="tree root">{roots.map(renderAgent)}</ul>
      <RegisterForm busy={action.busy} onSubmit={(tx) => exec("Register agent", tx)} />
    </section>
  );
}

function AgentCard({
  agent,
  exec,
  busy,
}: {
  agent: AgentView;
  exec: (label: string, tx: ReturnType<typeof pauseAgent>) => Promise<void>;
  busy: boolean;
}) {
  const [open, setOpen] = useState<"none" | "child" | "records">("none");
  const removed = agent.status.state === "removed";
  const paused = agent.status.state === "paused";
  const reg = config.registryId;

  return (
    <div className={`card agent ${removed ? "removed" : ""}`}>
      <div className="row">
        <strong>{agent.handle}</strong>
        <span className="badge">#{agent.agent_id}</span>
        <span className={`badge ${agent.status.state}`}>{statusText(agent)}</span>
        {(agent.locks & LOCKS.NO_TRANSFER) !== 0 && <span className="badge">non-transferable</span>}
        {(agent.locks & LOCKS.NO_CAPABILITY_RAISE) !== 0 && <span className="badge">capabilities frozen</span>}
      </div>
      <dl className="facts">
        <dt>Executor</dt>
        <dd>
          <a href={explorerAccount(agent.executor)} target="_blank" rel="noreferrer">
            {agent.executor}
          </a>
        </dd>
        <dt>Can request</dt>
        <dd>{capText(agent.capabilities)}</dd>
        <dt>Expires</dt>
        <dd>{timeText(agent.expires_at)}</dd>
        <dt>Generation</dt>
        <dd>{agent.generation.toString()}</dd>
      </dl>
      {!removed && (
        <div className="actions">
          {paused ? (
            <button disabled={busy} onClick={() => exec("Resume", resumeAgent(reg, agent.agent_id))}>
              Resume
            </button>
          ) : (
            <button disabled={busy} onClick={() => exec("Pause", pauseAgent(reg, agent.agent_id))}>
              Pause branch
            </button>
          )}
          <button disabled={busy} onClick={() => setOpen(open === "child" ? "none" : "child")}>
            Add leaf agent
          </button>
          <button disabled={busy} onClick={() => setOpen(open === "records" ? "none" : "records")}>
            Records
          </button>
          {(agent.locks & LOCKS.NO_TRANSFER) === 0 && (
            <>
              <button
                disabled={busy}
                onClick={() =>
                  confirm("Make this agent non-transferable forever? This cannot be undone.") &&
                  exec("Lock transfers", burnLocks(reg, agent.agent_id, LOCKS.NO_TRANSFER))
                }
              >
                Lock transfers
              </button>
              <button
                disabled={busy}
                onClick={() => {
                  const to = prompt("Transfer this agent to which account? Every payer approval for it stops working.");
                  if (to) exec("Transfer", transferAgent(reg, agent.agent_id, to.trim()));
                }}
              >
                Transfer
              </button>
            </>
          )}
          {(agent.locks & LOCKS.NO_CAPABILITY_RAISE) === 0 && (
            <button
              disabled={busy}
              onClick={() =>
                confirm("Freeze this agent's capabilities so they can only narrow? This cannot be undone.") &&
                exec("Freeze capabilities", burnLocks(reg, agent.agent_id, LOCKS.NO_CAPABILITY_RAISE))
              }
            >
              Freeze capabilities
            </button>
          )}
          <button
            className="danger"
            disabled={busy}
            onClick={() =>
              confirm(`Remove ${agent.handle}? Its token is burned and every agent below it stops working.`) &&
              exec("Remove", removeAgent(reg, agent.agent_id))
            }
          >
            Remove
          </button>
        </div>
      )}
      {open === "child" && <ChildForm parent={agent} busy={busy} onSubmit={(tx) => exec("Create leaf agent", tx)} />}
      {open === "records" && <Records agent={agent} busy={busy} exec={exec} />}
    </div>
  );
}

function ChildForm({ parent, busy, onSubmit }: { parent: AgentView; busy: boolean; onSubmit: (tx: ReturnType<typeof createChild>) => void }) {
  const [label, setLabel] = useState("");
  const [executor, setExecutor] = useState("");
  const [max, setMax] = useState("1");
  return (
    <form
      className="inline"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(
          createChild(config.registryId, parent.agent_id, label.trim(), {
            executor: executor.trim(),
            capabilities: transferCapability(parseNear(max)),
            expiresAt: parent.expires_at,
          }),
        );
      }}
    >
      <label>
        Label <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="bot-1" required />
      </label>
      <label>
        Executor account <input value={executor} onChange={(e) => setExecutor(e.target.value)} placeholder="runner-1.testnet" required />
      </label>
      <label>
        Max per payment (NEAR) <input value={max} onChange={(e) => setMax(e.target.value)} inputMode="decimal" required />
      </label>
      <button disabled={busy} type="submit">
        Create {label ? `${label}.${parent.handle}` : "leaf"}
      </button>
      <p className="hint">A leaf can only narrow its parent's rules. It inherits the parent's expiry.</p>
    </form>
  );
}

function Records({ agent, busy, exec }: { agent: AgentView; busy: boolean; exec: (label: string, tx: ReturnType<typeof setRecord>) => Promise<void> }) {
  const records = useAsync(() => registry.getRecords(agent.agent_id), [agent.agent_id, busy]);
  const [key, setKey] = useState("profile.description");
  const [value, setValue] = useState("");
  return (
    <div className="inline">
      <p className="hint">Records are public. Store a hash or an encrypted pointer for anything sensitive.</p>
      <table>
        <tbody>
          {(records.data ?? []).map((r) => (
            <tr key={r.key}>
              <td>
                <code>{r.key}</code>
              </td>
              <td>{r.value}</td>
              <td>
                <button disabled={busy} onClick={() => exec("Remove record", removeRecord(config.registryId, agent.agent_id, r.key))}>
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          exec("Set record", setRecord(config.registryId, agent.agent_id, key.trim(), value));
        }}
      >
        <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="namespace.name" required />
        <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="value" />
        <button disabled={busy} type="submit">
          Save record
        </button>
      </form>
    </div>
  );
}

function RegisterForm({ busy, onSubmit }: { busy: boolean; onSubmit: (tx: ReturnType<typeof registerAgent>) => void }) {
  const [handle, setHandle] = useState("");
  const [executor, setExecutor] = useState("");
  const [max, setMax] = useState("3");
  const [days, setDays] = useState("");
  const [description, setDescription] = useState("");
  const [noTransfer, setNoTransfer] = useState(false);
  const [freeze, setFreeze] = useState(false);
  return (
    <form
      className="card register-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(
          registerAgent(config.registryId, handle.trim(), {
            executor: executor.trim(),
            capabilities: transferCapability(parseNear(max)),
            expiresAt: days ? nowNs() + BigInt(Number(days)) * DAY_NS : null,
            locks: (noTransfer ? LOCKS.NO_TRANSFER : 0) | (freeze ? LOCKS.NO_CAPABILITY_RAISE : 0),
            description: description || null,
          }),
        );
      }}
    >
      <h2 className="form-wide">Register an agent</h2>
      <p className="hint form-wide">
        The agent is minted to you as an NFT. Its executor is a separate account whose only key can call
        <code> {config.registryId}.execute</code>.
      </p>
      <label>
        Handle <input value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="market-agent" required />
      </label>
      <label>
        Executor account <input value={executor} onChange={(e) => setExecutor(e.target.value)} placeholder="agent-runner.testnet" required />
      </label>
      <label>
        Max per payment (NEAR) <input value={max} onChange={(e) => setMax(e.target.value)} inputMode="decimal" required />
      </label>
      <label>
        Expires in days (optional) <input value={days} onChange={(e) => setDays(e.target.value)} inputMode="numeric" />
      </label>
      <label className="form-wide">
        Description <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={512} />
      </label>
      <label className="check">
        <input type="checkbox" checked={noTransfer} onChange={(e) => setNoTransfer(e.target.checked)} /> Non-transferable (permanent)
      </label>
      <label className="check">
        <input type="checkbox" checked={freeze} onChange={(e) => setFreeze(e.target.checked)} /> Capabilities can only narrow (permanent)
      </label>
      <button className="primary" disabled={busy} type="submit">
        Register
      </button>
    </form>
  );
}

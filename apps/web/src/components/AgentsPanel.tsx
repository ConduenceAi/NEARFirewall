import { useId, useRef, useState, type FormEvent } from "react";
import { ExternalLink, Info } from "lucide-react";
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
  type AgentView,
} from "@nearfirewall/sdk";
import { config, explorerAccount, registry, rpc } from "../config.ts";
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
      <h1 className="visually-hidden">Agents</h1>
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

const accountSuffix = config.network === "mainnet" ? "near" : "testnet";

function ChildForm({ parent, busy, onSubmit }: { parent: AgentView; busy: boolean; onSubmit: (tx: ReturnType<typeof createChild>) => Promise<void> }) {
  const [label, setLabel] = useState("");
  const executor = useExecutorAccount(parent.holder);
  const [max, setMax] = useState("1");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  return (
    <form
      className="inline"
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy || checking) return;
        setError(null);
        setChecking(true);
        try {
          const amount = parseNear(max);
          if (!parent.capabilities.transfer_near || amount > parent.capabilities.transfer_near.max_per_payment) {
            throw new Error("Choose a payment limit within the parent's limit.");
          }
          if (!await executor.verify()) return;
          await onSubmit(createChild(config.registryId, parent.agent_id, label.trim(), {
            executor: executor.value.trim(),
            capabilities: transferCapability(amount),
            expiresAt: parent.expires_at,
          }));
        } catch (error) {
          setError(error instanceof Error ? error.message : String(error));
        } finally {
          setChecking(false);
        }
      }}
    >
      <fieldset className="child-fields" disabled={busy || checking} aria-label="Leaf agent details">
        <div className="agent-field">
          <FieldLabel id={`${id}-label`} label="Label" help="The first part of the leaf agent's handle. Use 2–32 lowercase letters, digits, or hyphens. Start and end with a letter or digit." />
          <input id={`${id}-label`} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="bot-1" pattern={handlePattern} maxLength={32} autoCapitalize="none" spellCheck={false} required />
        </div>
        <ExecutorField executor={executor} example={`runner-1.${accountSuffix}`} />
        <div className="agent-field">
          <FieldLabel id={`${id}-max`} label="Max per payment (NEAR)" help="The most the leaf can request in one payment. It must fit within the parent's per-payment limit." />
          <input id={`${id}-max`} value={max} onChange={(e) => setMax(e.target.value)} inputMode="decimal" pattern={nearPattern} required />
        </div>
        {error && <p className="field-status error" role="alert">{error}</p>}
        <button type="submit">
          {checking ? "Checking account…" : `Create ${label ? `${label}.${parent.handle}` : "leaf"}`}
        </button>
      </fieldset>
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

const networkName = config.network === "mainnet" ? "Mainnet" : "Testnet";
const expiryFormat = new Intl.DateTimeFormat(undefined, {
  year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short",
});
const timeZone = expiryFormat.resolvedOptions().timeZone;
const maxExpiry = (1n << 64n) - 1n;
const handlePattern = "[a-z0-9][a-z0-9\\-]{0,30}[a-z0-9]";
const nearPattern = "[0-9]+(\\.[0-9]{1,24})?";

function FieldLabel({ id, titleId, label, help }: { id?: string; titleId?: string; label: string; help: string }) {
  const [open, setOpen] = useState(false);
  const helpId = useId();
  return (
    <div className="field-caption">
      <div className="field-title">
        {id ? <label htmlFor={id}>{label}</label> : <span id={titleId}>{label}</span>}
        <button
          className="field-info"
          type="button"
          aria-label={`About ${label}`}
          aria-expanded={open}
          aria-controls={helpId}
          onClick={() => setOpen(!open)}
        >
          <Info size={15} aria-hidden="true" />
        </button>
      </div>
      <p id={helpId} hidden={!open} className="hint field-help">{help}</p>
    </div>
  );
}

type ExecutorStatus = { kind: "checking" | "ok" | "error"; text: string };

function useExecutorAccount(owner: string | null) {
  const [value, setValue] = useState("");
  const [status, setStatus] = useState<ExecutorStatus | null>(null);
  const pending = useRef<Promise<boolean> | null>(null);

  function change(value: string) {
    pending.current = null;
    setStatus(null);
    setValue(value);
  }

  async function verify() {
    const id = value.trim();
    const message = id === owner || id === config.registryId
      ? "Enter a separate NEAR account for the agent runner."
      : id.length < 2 || id.length > 64 || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(id)
        ? "Enter a valid NEAR account ID."
        : null;
    if (message) {
      setStatus({ kind: "error", text: message });
      return false;
    }
    if (pending.current) return pending.current;

    setStatus({ kind: "checking", text: `Checking ${networkName}…` });
    const request = rpc.accountExists(id)
      .then((exists): ExecutorStatus => exists
        ? { kind: "ok", text: `Account exists on ${networkName}.` }
        : { kind: "error", text: `Account not found on ${networkName}. Check the ID or create the account first.` })
      .catch((): ExecutorStatus => ({ kind: "error", text: `Couldn't check ${networkName}. Try again in a moment.` }))
      .then((result) => {
        if (pending.current === request) {
          pending.current = null;
          setStatus(result);
        }
        return result.kind === "ok";
      });
    pending.current = request;
    return request;
  }

  return { value, change, status, verify };
}

function ExecutorField({ executor, example }: { executor: ReturnType<typeof useExecutorAccount>; example: string }) {
  const id = useId();
  return (
    <div className="agent-field executor-field">
      <FieldLabel id={id} label="Executor account" help="The separate NEAR account your runner uses to submit agent requests. Enter its public account ID. The runner needs a function-call key limited to the registry's execute method." />
      <input
        id={id}
        value={executor.value}
        onChange={(e) => executor.change(e.target.value)}
        onBlur={() => { if (executor.value.trim()) void executor.verify(); }}
        placeholder={example}
        autoCapitalize="none"
        spellCheck={false}
        required
        aria-describedby={`${id}-status`}
        aria-invalid={executor.status?.kind === "error" || undefined}
      />
      <div className={`field-status ${executor.status?.kind ?? ""}`} id={`${id}-status`} role="status">
        {executor.status?.text ?? `Use an existing ${networkName} account.`}
        {executor.status?.kind === "ok" && (
          <a href={explorerAccount(executor.value.trim())} target="_blank" rel="noreferrer" aria-label="View executor account on NearBlocks (opens in a new tab)">
            NearBlocks <ExternalLink size={12} aria-hidden="true" />
          </a>
        )}
      </div>
    </div>
  );
}

function localDateValue(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function localExpiry(date: string, hour: string, minute: string) {
  if (!date) return null;
  const value = new Date(`${date}T${hour}:${minute}`);
  if (!Number.isFinite(value.getTime()) || value.getHours() !== Number(hour) || value.getMinutes() !== Number(minute)) {
    throw new Error("Choose a valid date and time in your time zone.");
  }
  if (value.getTime() <= Date.now()) throw new Error("Choose a future expiry date and time.");
  if (BigInt(value.getTime()) * 1_000_000n > maxExpiry) throw new Error("Choose an earlier expiry date.");
  return value;
}

const hours = Array.from({ length: 24 }, (_, n) => String(n).padStart(2, "0"));
const minutes = Array.from({ length: 60 }, (_, n) => String(n).padStart(2, "0"));

function RegisterForm({ busy, onSubmit }: { busy: boolean; onSubmit: (tx: ReturnType<typeof registerAgent>) => Promise<void> }) {
  const { accountId } = useWallet();
  const [handle, setHandle] = useState("");
  const executor = useExecutorAccount(accountId);
  const [max, setMax] = useState("3");
  const [date, setDate] = useState("");
  const [hour, setHour] = useState("00");
  const [minute, setMinute] = useState("00");
  const [description, setDescription] = useState("");
  const [noTransfer, setNoTransfer] = useState(false);
  const [freeze, setFreeze] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  let expiry: Date | null = null;
  let expiryError: string | null = null;
  try {
    expiry = localExpiry(date, hour, minute);
  } catch (error) {
    if (error instanceof Error) expiryError = error.message;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || checking) return;
    setError(null);
    if (expiryError) return;
    setChecking(true);
    try {
      const amount = parseNear(max);
      if (amount >= (1n << 128n)) throw new Error("Enter a smaller maximum per payment.");
      if (new TextEncoder().encode(description).length > 512) throw new Error("Keep the description within 512 bytes.");
      if (!await executor.verify()) return;
      const expires = localExpiry(date, hour, minute);
      await onSubmit(registerAgent(config.registryId, handle.trim(), {
        executor: executor.value.trim(),
        capabilities: transferCapability(amount),
        expiresAt: expires ? BigInt(expires.getTime()) * 1_000_000n : null,
        locks: (noTransfer ? LOCKS.NO_TRANSFER : 0) | (freeze ? LOCKS.NO_CAPABILITY_RAISE : 0),
        description: description || null,
      }));
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setChecking(false);
    }
  }

  return (
    <form id="register-agent" className="card register-form" onSubmit={submit}>
      <h2 id={`${id}-heading`}>Register an agent</h2>
      <p className="hint">Registration mints the agent as an NFT to your connected wallet.</p>
      <fieldset disabled={busy || checking} aria-labelledby={`${id}-heading`}>
        <div className="agent-field">
          <FieldLabel id={`${id}-handle`} label="Handle" help="The agent's unique public name in the registry. Use 2–32 lowercase letters, digits, or hyphens. Start and end with a letter or digit." />
          <input id={`${id}-handle`} value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="market-agent" pattern={handlePattern} maxLength={32} autoCapitalize="none" spellCheck={false} required />
        </div>
        <ExecutorField executor={executor} example={`agent-runner.${accountSuffix}`} />
        <div className="agent-field">
          <FieldLabel id={`${id}-max`} label="Max per payment (NEAR)" help="The most this agent can request in a single payment. Recipient limits can lower this amount. Set it to 0 to block payments." />
          <input id={`${id}-max`} value={max} onChange={(e) => setMax(e.target.value)} inputMode="decimal" pattern={nearPattern} required />
        </div>
        <div className="agent-field" role="group" aria-labelledby={`${id}-expiry`} aria-describedby={`${id}-expiry-status`}>
          <FieldLabel titleId={`${id}-expiry`} label="Expiry (optional)" help="When the registry stops accepting requests from this agent and its descendants. Leave the date blank for no expiry. The time is based on your device's time zone." />
          <div className="expiry-picker">
            <label>
              Date
              <input type="date" value={date} min={localDateValue(new Date())} onChange={(e) => setDate(e.target.value)} aria-invalid={Boolean(expiryError) || undefined} />
            </label>
            <label>
              Hour (24h)
              <select value={hour} onChange={(e) => setHour(e.target.value)}>
                {hours.map((hour) => <option key={hour}>{hour}</option>)}
              </select>
            </label>
            <label>
              Minute
              <select value={minute} onChange={(e) => setMinute(e.target.value)}>
                {minutes.map((minute) => <option key={minute}>{minute}</option>)}
              </select>
            </label>
          </div>
          <p id={`${id}-expiry-status`} className={`field-status ${expiryError ? "error" : ""}`} aria-live="polite">
            {expiryError ?? (expiry ? `Expires ${expiryFormat.format(expiry)}` : `No expiry set · ${timeZone}`)}
          </p>
        </div>
        <div className="form-wide agent-field">
          <FieldLabel id={`${id}-description`} label="Description (optional)" help="A public note on the agent's NFT, up to 512 bytes. Use it to describe what the agent does." />
          <input id={`${id}-description`} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={512} placeholder="What does this agent do?" />
        </div>
        <div className="agent-check">
          <input id={`${id}-transfer`} type="checkbox" checked={noTransfer} onChange={(e) => setNoTransfer(e.target.checked)} />
          <FieldLabel id={`${id}-transfer`} label="Non-transferable (permanent)" help="Permanently prevents the agent's NFT from being transferred to another account." />
        </div>
        <div className="agent-check">
          <input id={`${id}-freeze`} type="checkbox" checked={freeze} onChange={(e) => setFreeze(e.target.checked)} />
          <FieldLabel id={`${id}-freeze`} label="Capabilities can only narrow (permanent)" help="Permanently allows the agent's capabilities to be reduced only. Its payment ceiling can be lowered, and a removed capability stays removed." />
        </div>
        {error && <p className="form-wide field-status error" role="alert">{error}</p>}
        <button className="primary register-submit" type="submit">
          {busy ? "Registering…" : checking ? "Checking account…" : "Register"}
        </button>
      </fieldset>
    </form>
  );
}

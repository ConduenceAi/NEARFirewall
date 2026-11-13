import { useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { AGENT_EXECUTE_METHOD, connectAgentKey, CONNECTION_ALLOWANCE, parseNear, type AgentView } from "@nearfirewall/sdk";
import { generateAgentKey } from "../agent-key.ts";
import { config, policyOf, rpc } from "../config.ts";
import { useWorkspaceRegistry } from "../workspace-registry.tsx";
import { ensureOk, near } from "../format.ts";
import { href } from "../router.ts";
import { useAction, useAsync } from "../hooks.ts";
import { platforms, searchPlatforms, type AgentPlatform } from "../platforms.ts";
import { useWallet } from "../wallet.tsx";
import { GatewaySetup } from "./GatewaySetup.tsx";

export function ConnectPanel({ agent, accountId, onClose, onChanged }: {
  agent: AgentView;
  accountId: string;
  onClose(): void;
  onChanged(): void;
}) {
  const { send } = useWallet();
  const dialog = useRef<HTMLDialogElement>(null);
  const action = useAction();
  const [catalog, setCatalog] = useState(false);
  const [query, setQuery] = useState("");
  const [platform, setPlatform] = useState<AgentPlatform>();
  const [label, setLabel] = useState("");
  const [allowance, setAllowance] = useState("0.25");
  const [key, setKey] = useState<Awaited<ReturnType<typeof generateAgentKey>>>();
  const [verified, setVerified] = useState(false);
  const policy = policyOf(accountId);
  const { mode, registry, policyCodeHash } = useWorkspaceRegistry();
  const readiness = useAsync(async () => {
    if ((await policy.state(policyCodeHash)).kind !== "enabled") return null;
    const view = await policy.getPolicy();
    if (view.registry !== registry.registryId || view.connections === undefined) return null;
    if (mode !== "per-user" && await registry.getOwner().catch(() => null) !== accountId) return null;
    return policy.getConnections();
  }, [accountId, mode, registry, policyCodeHash]);
  const connections = readiness.data;
  const matches = searchPlatforms(query);
  const featured = [...platforms.slice(0, 3)].sort((a, b) => {
    const recent = (id: string) => connections?.findLast((c) => c.platform === id)?.created_at ?? 0n;
    return recent(a.id) > recent(b.id) ? -1 : recent(a.id) < recent(b.id) ? 1 : 0;
  });

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  async function verify(publicKey: string) {
    const [record, accessKeys] = await Promise.all([policy.getConnection(publicKey), rpc.viewAccessKeys(accountId)]);
    const access = accessKeys.find((k) => k.publicKey === publicKey);
    if (record?.agent_id !== agent.agent_id || !access || access.fullAccess || access.receiverId !== accountId ||
        access.methodNames?.length !== 1 || access.methodNames[0] !== AGENT_EXECUTE_METHOD || access.allowance !== parseNear(allowance)) {
      throw new Error("The connection is not visible with the requested permissions. Check again after the wallet transaction finalizes.");
    }
    setVerified(true);
    onChanged();
  }

  async function create() {
    if (!platform?.setup && !platform?.gateway) return;
    await action.run("Connect agent", async () => {
      const name = label.trim();
      const fees = parseNear(allowance);
      if (!name || new TextEncoder().encode(name).length > 48) throw new Error("Enter a label of up to 48 bytes.");
      if (fees >= (1n << 128n)) throw new Error("Enter a smaller gas allowance.");
      const pair = await generateAgentKey();
      const tx = connectAgentKey(accountId, { agentId: agent.agent_id, publicKey: pair.publicKey, platform: platform.id, label: name, allowance: fees });
      setKey(pair);
      ensureOk(await send(tx));
      await verify(pair.publicKey);
    });
  }

  function pick(next: AgentPlatform) {
    setPlatform(next);
    setLabel(`${next.name} on this device`);
    action.clear();
  }

  function close() {
    if (action.busy) return;
    if (key && !verified && !window.confirm("Close and discard this key? If the wallet transaction completes, disconnect the key from the agent map.")) return;
    onClose();
  }

  return (
    <dialog ref={dialog} className="inspector connect-panel" aria-labelledby="connect-panel-title" onCancel={(e) => { e.preventDefault(); close(); }}>
      <header className="insp-head">
        <h2 id="connect-panel-title">Connect {agent.handle}</h2>
        <button type="button" className="icon-btn" aria-label="Close connection panel" disabled={action.busy} onClick={close}><X size={17} /></button>
      </header>
      <div className="insp-body">
        {readiness.error && <p className="notice error" role="alert">{readiness.error} <button type="button" onClick={readiness.reload}>Retry</button></p>}
        {readiness.data === undefined && !readiness.error && <p role="status">Checking your payment policy…</p>}
        {connections === null && <p>Connecting a key requires an owner registry and its payment policy. Check your setup in <a href={href("/app/payments")} onClick={onClose}>Payments</a>.</p>}
        {connections && !platform && (
          <>
            {catalog && <label>Search platforms <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus /></label>}
            {catalog ? (
              [...new Set(matches.map((p) => p.type))].map((type) => (
                <section className="insp-section" key={type}>
                  <h3>{type}</h3>
                  <div className="platform-tiles">{matches.filter((p) => p.type === type).map(tile)}</div>
                </section>
              ))
            ) : <div className="platform-tiles">{featured.map(tile)}<button type="button" onClick={() => setCatalog(true)}><Plus size={18} /> Browse platforms</button></div>}
            {catalog && matches.length === 0 && <p>No platforms match your search.</p>}
          </>
        )}
        {platform && !verified && (
          <>
            <h3>{platform.name}</h3>
            {!platform.setup && !platform.gateway ? (
              <p>Setup for this platform is unavailable in this release. Choose a local MCP client to connect now.</p>
            ) : (
              <form onSubmit={(e) => { e.preventDefault(); if (!action.busy && !key) void create(); }}>
                <fieldset disabled={action.busy || Boolean(key)}>
                  <label>Connection label <input required value={label} maxLength={48} onChange={(e) => setLabel(e.target.value)} /></label>
                  <label>Gas allowance (NEAR) <input required inputMode="decimal" value={allowance} pattern="[0-9]+(\.[0-9]{1,24})?" onChange={(e) => setAllowance(e.target.value)} /></label>
                  <p className="hint">The key can only call <code>agent_execute</code> on {accountId} with zero deposit. The gas allowance starts at {near(CONNECTION_ALLOWANCE)}. Review the permission and reject a full-access key in your wallet.</p>
                  <button type="submit" className="primary">{action.busy ? "Waiting for your wallet…" : "Create restricted key"}</button>
                </fieldset>
              </form>
            )}
            {!key && <button className="connect-back" type="button" disabled={action.busy} onClick={() => { setPlatform(undefined); action.clear(); }}>Back to platforms</button>}
            {key && !action.busy && <div className="actions">
              <button type="button" onClick={() => void action.run("Check connection", () => verify(key.publicKey))}>Check connection</button>
              <button type="button" onClick={() => { if (window.confirm("Discard this key and start over? If it was added, disconnect it from the agent map.")) { setKey(undefined); action.clear(); } }}>Discard key</button>
            </div>}
          </>
        )}
        {action.message?.kind === "error" && <p className="notice error" role="alert">{action.message.text}</p>}
        {key && verified && platform && (platform.gateway
          ? <GatewaySetup accountId={accountId} secretKey={key.secretKey} platform={platform} onDone={onClose} />
          : <ConnectionSetup accountId={accountId} secretKey={key.secretKey} platform={platform} onDone={onClose} />)}
      </div>
    </dialog>
  );

  function tile(p: AgentPlatform) {
    return <button key={p.id} type="button" onClick={() => pick(p)}><span aria-hidden="true">{p.initials}</span>{p.name}</button>;
  }
}

function ConnectionSetup({ accountId, secretKey, platform, onDone }: { accountId: string; secretKey: string; platform: AgentPlatform; onDone(): void }) {
  const [message, setMessage] = useState("");
  const [revealed, setRevealed] = useState(false);
  const env = { NEARFIREWALL_ACCOUNT: accountId, NEARFIREWALL_NETWORK: config.network, NEARFIREWALL_AGENT_KEY: secretKey };
  const snippet = JSON.stringify({ mcpServers: { nearfirewall: { command: "node", args: ["/absolute/path/to/NEARFirewall/packages/mcp/src/main.ts"], env } } }, null, 2);
  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setMessage(`${label} copied.`);
    } catch {
      setMessage("Clipboard unavailable. Reveal the key and copy it manually.");
    }
  }
  function download() {
    const url = URL.createObjectURL(new Blob([Object.entries(env).map(([name, value]) => `${name}=${value}`).join("\n") + "\n"], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "nearfirewall-agent.env";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <section className="connection-setup">
      <h3>Restricted key ready</h3>
      <p>Save the key in your local client before closing this panel. It gives that client access to request payments for this agent.</p>
      {revealed && <textarea readOnly aria-label="Agent private key" value={secretKey} rows={3} spellCheck={false} />}
      <div className="actions">
        <button type="button" onClick={() => setRevealed(!revealed)}>{revealed ? "Hide key" : "Reveal key"}</button>
        <button type="button" onClick={() => void copy(secretKey, "Key")}>Copy key</button>
        <button type="button" onClick={download}>Download .env</button>
      </div>
      <h3>Set up {platform.name}</h3>
      <ol>
        <li>Install Node.js 24+ and run <code>npm ci</code> in the NEARFirewall checkout.</li>
        <li>{platform.setup}</li>
        <li>Replace the placeholder with the absolute path to <code>packages/mcp/src/main.ts</code>. If your client cannot find Node.js, use the absolute path to its executable.</li>
        <li>Call <code>get_rules</code> to verify the connection before requesting a payment.</li>
      </ol>
      <button type="button" onClick={() => void copy(snippet, "MCP configuration")}>Copy MCP configuration</button>
      <p role="status">{message}</p>
      <button className="primary" type="button" onClick={onDone}>I’ve saved it</button>
    </section>
  );
}

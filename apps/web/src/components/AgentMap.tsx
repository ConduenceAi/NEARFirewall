/**
 * Agent map: the connected account at the top, the agents it holds as a tree,
 * and optionally the recipients each agent is approved to pay. It combines the
 * registry (identity, tree, locks) with the account's policy (approvals,
 * budgets), so one picture answers "who can spend what, under which rules".
 * Selecting a node opens the inspector with everything about it.
 */
import { useEffect, useMemo, useState } from "react";
import { Bot, CircleSlash, Eye, EyeOff, KeyRound, Lock, PauseCircle, RefreshCw, ShieldCheck, Snowflake, UserRound, Wallet } from "lucide-react";
import { LOCKS, type AgentView, type Connection, type Mandate, type PolicyState, type PolicyView, type UsageView } from "@nearfirewall/sdk";
import { policyOf } from "../config.ts";
import { useWorkspaceRegistry } from "../workspace-registry.tsx";
import { near } from "../format.ts";
import { useAsync } from "../hooks.ts";
import { useWallet } from "../wallet.tsx";
import { href } from "../router.ts";
import { Inspector, type Selection } from "./Inspector.tsx";
import { useMapGestures } from "./useMapGestures.ts";

export interface MapData {
  account: string;
  registryId: string;
  state: PolicyState;
  policy: PolicyView | null;
  agents: AgentView[];
  mandates: Map<string, Mandate>;
  usage: Map<string, UsageView>;
  connections: Connection[];
}

async function loadMap(account: string, { registry, policyCodeHash }: ReturnType<typeof useWorkspaceRegistry>): Promise<MapData> {
  const policy = policyOf(account);
  const [state, held] = await Promise.all([policy.state(policyCodeHash), registry.agentsOf(account)]);
  const agents = held.filter((a) => a.status.state !== "removed");
  const mandates = new Map<string, Mandate>();
  const usage = new Map<string, UsageView>();
  let view: PolicyView | null = null;
  let connections: Connection[] = [];
  if (state.kind === "enabled") {
    view = await policy.getPolicy();
    if (view.registry !== registry.registryId) throw new Error(`Your payment policy trusts ${view.registry}. Select that registry before managing its agents.`);
    if (view.connections !== undefined) connections = await policy.getConnections();
    await Promise.all(
      agents.map(async (a) => {
        const m = await policy.getMandate(a.agent_id);
        if (!m) return;
        mandates.set(a.agent_id, m);
        usage.set(a.agent_id, await policy.getUsage(a.agent_id));
      }),
    );
  }
  return { account, registryId: registry.registryId, state, policy: view, agents, mandates, usage, connections };
}

// ------------------------------------------------------------------ layout

const AGENT_W = 230;
const RECIPIENT_W = 180;
const ACCOUNT_W = 260;
const DETAIL_NODE_H = 112;
const COMPACT_NODE_H = 72;
const H_GAP = 26;
const V_GAP = 64;

type NodeKind = "account" | "registry" | "agent" | "connection" | "recipient";

interface LayoutNode {
  key: string;
  kind: NodeKind;
  children: LayoutNode[];
  agent?: AgentView;
  connection?: Connection;
  recipient?: { owner: AgentView; account: string };
  x: number;
  y: number;
  w: number;
  h: number;
}

function widthOf(kind: NodeKind) {
  return kind === "account" || kind === "registry" ? ACCOUNT_W : kind === "agent" ? AGENT_W : RECIPIENT_W;
}
function heightOf(kind: NodeKind) {
  return kind === "account" || kind === "agent" ? DETAIL_NODE_H : COMPACT_NODE_H;
}

function buildTree(data: MapData, showRecipients: boolean): LayoutNode {
  const ids = new Set(data.agents.map((a) => a.agent_id));
  const make = (kind: NodeKind, key: string, extra: Partial<LayoutNode> = {}): LayoutNode => ({
    key,
    kind,
    children: [],
    x: 0,
    y: 0,
    w: widthOf(kind),
    h: heightOf(kind),
    ...extra,
  });
  const agentNode = (agent: AgentView): LayoutNode => {
    const node = make("agent", `agent:${agent.agent_id}`, { agent });
    node.children = data.agents
      .filter((a) => a.parent === agent.agent_id)
      .sort((a, b) => Number(a.agent_id) - Number(b.agent_id))
      .map(agentNode);
    for (const connection of data.connections.filter((c) => c.agent_id === agent.agent_id)) {
      node.children.push(make("connection", `key:${connection.public_key}`, { connection }));
    }
    const mandate = data.mandates.get(agent.agent_id);
    if (showRecipients && mandate && mandate.status === "Active") {
      for (const account of Object.keys(mandate.recipients)) {
        node.children.push(make("recipient", `rcpt:${agent.agent_id}:${account}`, { recipient: { owner: agent, account } }));
      }
    }
    return node;
  };
  const root = make("account", "account");
  const registry = make("registry", "registry");
  root.children = [registry];
  registry.children = data.agents
    .filter((a) => !a.parent || !ids.has(a.parent))
    .sort((a, b) => Number(a.agent_id) - Number(b.agent_id))
    .map(agentNode);
  for (const connection of data.connections.filter((c) => !ids.has(c.agent_id))) {
    root.children.push(make("connection", `key:${connection.public_key}`, { connection }));
  }
  return root;
}

/** Tidy tree: leaves left to right, parents centered over their children. */
function layout(root: LayoutNode) {
  let cursor = 0;
  const levelY: number[] = [];
  const place = (node: LayoutNode, depth: number) => {
    levelY[depth] = Math.max(levelY[depth] ?? 0, node.h);
    if (node.children.length === 0) {
      node.x = cursor;
      cursor += node.w + H_GAP;
    } else {
      node.children.forEach((c) => place(c, depth + 1));
      const first = node.children[0]!;
      const last = node.children[node.children.length - 1]!;
      const center = (first.x + first.w / 2 + last.x + last.w / 2) / 2;
      node.x = center - node.w / 2;
      // A wide parent over narrow children must not overlap the next subtree.
      if (node.x + node.w + H_GAP > cursor) cursor = node.x + node.w + H_GAP;
    }
  };
  place(root, 0);
  const tops: number[] = [];
  levelY.reduce((y, h, i) => {
    tops[i] = y;
    return y + h + V_GAP;
  }, 0);
  const all: LayoutNode[] = [];
  const setY = (node: LayoutNode, depth: number) => {
    node.y = tops[depth]!;
    all.push(node);
    node.children.forEach((c) => setY(c, depth + 1));
  };
  setY(root, 0);
  const minX = Math.min(...all.map((n) => n.x));
  all.forEach((n) => (n.x -= minX));
  const width = Math.max(...all.map((n) => n.x + n.w));
  const height = Math.max(...all.map((n) => n.y + n.h));
  return { nodes: all, width, height };
}

// ------------------------------------------------------------------ rendering

function AgentCard({ agent, data }: { agent: AgentView; data: MapData }) {
  const mandate = data.mandates.get(agent.agent_id);
  const used = data.usage.get(agent.agent_id)?.mandate_used_today ?? 0n;
  const cap = agent.capabilities.transfer_near?.max_per_payment;
  const paused = agent.status.state === "paused";
  return (
    <>
      <span className="node-title">
        <Bot size={15} aria-hidden="true" />
        <strong>{agent.handle}</strong>
        {paused && <PauseCircle size={14} className="node-warn" aria-label="Paused" />}
        {(agent.locks & LOCKS.NO_TRANSFER) !== 0 && <Lock size={13} aria-label="Non-transferable" />}
        {(agent.locks & LOCKS.NO_CAPABILITY_RAISE) !== 0 && <Snowflake size={13} aria-label="Capabilities frozen" />}
      </span>
      <span className="node-sub">
        #{agent.agent_id}{agent.executor ? ` · ${agent.executor}` : ""}
      </span>
      <span className="node-chips">
        <span className="chip">{cap === undefined ? "no payments" : `≤ ${near(cap)}`}</span>
        {mandate ? (
          mandate.status === "Active" ? (
            <span className="chip ok">
              {near(used)} / {near(mandate.daily_cap)} today
            </span>
          ) : (
            <span className="chip warn">approval revoked</span>
          )
        ) : (
          <span className="chip muted">no approval</span>
        )}
      </span>
    </>
  );
}

export function AgentMap({ onConnect, connectionChanges }: { onConnect(agent: AgentView): void; connectionChanges: number }) {
  const { accountId } = useWallet();
  const workspace = useWorkspaceRegistry();
  const map = useAsync(() => (accountId ? loadMap(accountId, workspace) : Promise.resolve(null)), [accountId, connectionChanges, workspace]);
  const [showRecipients, setShowRecipients] = useState(true);
  const [selected, setSelected] = useState<Selection | null>(null);
  const data = map.data ?? null;
  const tree = useMemo(() => (data ? layout(buildTree(data, showRecipients)) : null), [data, showRecipients]);
  const hasCanvas = tree !== null;
  const { viewportRef, canvasRef } = useMapGestures(hasCanvas);

  // Keep the selection pointing at fresh data after a reload.
  useEffect(() => {
    if (data && selected?.kind === "connection") {
      const fresh = data.connections.find((c) => c.public_key === selected.connection.public_key);
      if (!fresh) setSelected(null);
      else if (fresh !== selected.connection) setSelected({ kind: "connection", connection: fresh });
      return;
    }
    if (!data || !selected || selected.kind !== "agent") return;
    const fresh = data.agents.find((a) => a.agent_id === selected.agent.agent_id);
    if (!fresh) setSelected(null);
    else if (fresh !== selected.agent) setSelected({ kind: "agent", agent: fresh });
  }, [data, selected]);

  if (!accountId) return null;

  const select = (node: LayoutNode) => {
    if (node.kind === "account") setSelected({ kind: "account" });
    else if (node.kind === "registry") setSelected({ kind: "registry" });
    else if (node.kind === "agent" && node.agent) setSelected({ kind: "agent", agent: node.agent });
    else if (node.connection) setSelected({ kind: "connection", connection: node.connection });
    else if (node.recipient) setSelected({ kind: "recipient", owner: node.recipient.owner, account: node.recipient.account });
  };
  const isSelected = (node: LayoutNode) =>
    selected !== null &&
    ((selected.kind === "account" && node.kind === "account") ||
      (selected.kind === "registry" && node.kind === "registry") ||
      (selected.kind === "connection" && node.connection?.public_key === selected.connection.public_key) ||
      (selected.kind === "agent" && node.agent?.agent_id === selected.agent.agent_id && node.kind === "agent") ||
      (selected.kind === "recipient" &&
        node.recipient?.account === selected.account &&
        node.recipient.owner.agent_id === selected.owner.agent_id));

  return (
    <section aria-labelledby="map-heading" className={selected ? "with-inspector" : undefined}>
      <h1 id="map-heading" className="visually-hidden">Agent map</h1>
      <div className="toolbar map-toolbar">
        <div className="actions">
          <button type="button" onClick={() => setShowRecipients((v) => !v)} aria-pressed={showRecipients}>
            {showRecipients ? <EyeOff size={16} /> : <Eye size={16} />} {showRecipients ? "Hide recipients" : "Show recipients"}
          </button>
          <button className="icon-btn" onClick={map.reload} disabled={map.loading} aria-label="Refresh" title="Refresh">
            <RefreshCw size={18} className={map.loading ? "spin" : ""} />
          </button>
        </div>
      </div>

      {map.error && <p className="notice error">{map.error}</p>}
      {!tree && <p className="empty">{map.loading ? "Loading the map…" : "Nothing to show yet."}</p>}

      {tree && data && (
        <div className="map-scroll" ref={viewportRef} role="region" aria-label="Map canvas" aria-describedby="map-zoom-help" tabIndex={0}>
          <div className="map-stage">
            <div className="map-canvas" ref={canvasRef} style={{ width: tree.width, height: tree.height }}>
              <svg className="map-edges" width={tree.width} height={tree.height} aria-hidden="true">
                {tree.nodes.flatMap((parent) =>
                  parent.children.map((child) => {
                    const x1 = parent.x + parent.w / 2;
                    const y1 = parent.y + parent.h;
                    const x2 = child.x + child.w / 2;
                    const y2 = child.y;
                    const mid = (y1 + y2) / 2;
                    const kind = child.kind === "connection" ? "connection" : parent.kind === "account" || parent.kind === "registry" ? "holds" : child.kind === "recipient" ? "pays" : "parent";
                    return <path key={`${parent.key}->${child.key}`} className={`edge ${kind}`} d={`M${x1},${y1} C${x1},${mid} ${x2},${mid} ${x2},${y2}`} />;
                  }),
                )}
              </svg>
              {tree.nodes.map((node) => (
                <button
                  key={node.key}
                  type="button"
                  className={`map-node ${node.kind}${isSelected(node) ? " selected" : ""}${node.agent?.status.state === "paused" ? " paused" : ""}`}
                  style={{ left: node.x, top: node.y, width: node.w, height: node.h }}
                  onClick={() => select(node)}
                  aria-pressed={isSelected(node)}
                >
                  {node.kind === "account" && (
                    <>
                      <span className="node-title">
                        <Wallet size={15} aria-hidden="true" />
                        <strong>{data.account}</strong>
                      </span>
                      <span className="node-sub">Your account · payer</span>
                      <span className="node-chips">
                        {data.state.kind === "enabled" ? (
                          data.policy?.paused ? (
                            <span className="chip warn"><PauseCircle size={12} /> payments paused</span>
                          ) : (
                            <span className="chip ok"><ShieldCheck size={12} /> policy on</span>
                          )
                        ) : data.state.kind === "other" ? (
                          <span className="chip warn"><CircleSlash size={12} /> other contract</span>
                        ) : (
                          <span className="chip muted">payments not enabled</span>
                        )}
                        {data.policy && <span className="chip">{near(data.policy.available_balance)} available</span>}
                      </span>
                    </>
                  )}
                  {node.kind === "registry" && <>
                    <span className="node-title"><ShieldCheck size={15} aria-hidden="true" /><strong>{data.registryId}</strong></span>
                    <span className="node-sub">Agent registry</span>
                  </>}
                  {node.kind === "agent" && node.agent && <AgentCard agent={node.agent} data={data} />}
                  {node.connection && <>
                    <span className="node-title"><KeyRound size={15} aria-hidden="true" /><strong>{node.connection.label}</strong></span>
                    <span className="node-sub">Restricted key</span>
                  </>}
                  {node.kind === "recipient" && node.recipient && (
                    <RecipientCard data={data} owner={node.recipient.owner} account={node.recipient.account} />
                  )}
                </button>
              ))}
            </div>
            {data.agents.length === 0 && (
              <p className="empty">
                No agents yet. <a href={href("/app/agents")}>Register your first agent</a> and it appears here under your account.
              </p>
            )}
          </div>
        </div>
      )}

      <p className="hint map-legend">
        <span className="holds"><i className="edge-swatch" aria-hidden="true" /> holds</span>
        <span className="parent"><i className="edge-swatch" aria-hidden="true" /> parent of</span>
        <span className="pays"><i className="edge-swatch" aria-hidden="true" /> may pay</span>
        <span className="connection"><i className="edge-swatch" aria-hidden="true" /> connected key</span>
        <span>Select any node for its rules.</span>
        {hasCanvas && <span id="map-zoom-help">Drag to pan. Pinch to zoom. With the map focused, use arrow keys to pan, + or − to zoom, and 0 to reset.</span>}
      </p>

      {selected && data && <Inspector selection={selected} data={data} onClose={() => setSelected(null)} onChanged={map.reload} onConnect={onConnect} />}
    </section>
  );
}

function RecipientCard({ data, owner, account }: { data: MapData; owner: AgentView; account: string }) {
  const rule = data.mandates.get(owner.agent_id)?.recipients[account];
  return (
    <>
      <span className="node-title">
        <UserRound size={14} aria-hidden="true" />
        <strong>{account}</strong>
      </span>
      {rule && (
        <span className="node-sub">
          {near(rule.per_payment_cap)} each · {near(rule.daily_cap)} a day
        </span>
      )}
    </>
  );
}

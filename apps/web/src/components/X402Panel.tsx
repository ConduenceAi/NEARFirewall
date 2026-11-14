import { useState, type FormEvent } from "react";
import {
  USDC_CONTRACT,
  RegistryClient,
  approveX402Agent,
  approveX402Seller,
  approveX402Site,
  formatUsdc,
  ftBalanceOf,
  isTokenRegistered,
  parseUsdc,
  removeX402Agent,
  removeX402Rules,
  removeX402Seller,
  removeX402Site,
  setMandate,
  setX402Capability,
  setX402Config,
  setX402Rules,
  setupX402Account,
  x402AccountFor,
  x402Capability,
  type AgentView,
  type PolicyClient,
  type WalletTransaction,
  type X402Config,
  type X402Rules,
} from "@nearfirewall/sdk";
import { config, explorerAccount, rpc } from "../config.ts";
import { useAsync } from "../hooks.ts";
import { useWorkspaceRegistry } from "../workspace-registry.tsx";
import { PolicyUpgrade } from "./PolicyUpgrade.tsx";

type Execute = (label: string, tx: WalletTransaction | (() => WalletTransaction | Promise<WalletTransaction>)) => Promise<boolean>;
type Run = (label: string, fn: () => Promise<unknown>) => Promise<boolean>;

const usdc = (units: bigint) => `${formatUsdc(units)} USDC`;
const usdcPattern = "\\d+(\\.\\d{1,6})?";
const short = (account: string) => (account.length > 20 ? `${account.slice(0, 8)}…${account.slice(-6)}` : account);
/** The default small budget for sellers the owner has not listed. */
const DEFAULT_UNLISTED = { per: "0.05", daily: "0.25" };

/**
 * x402 on the owner's account: the account-wide switch, then each agent's
 * x402 limits and each connection's payment account.
 */
export function X402Section({ policy, agents, busy, exec, run }: { policy: PolicyClient; agents: AgentView[]; busy: boolean; exec: Execute; run: Run }) {
  const status = useAsync(async () => ({ ...(await policy.x402Status()), features: await policy.features() }), [policy.payerId, busy]);
  if (status.error) return <p className="notice error">Could not read the x402 settings. {status.error}</p>;
  if (!status.data) return null;
  if (!status.data.supported) {
    return <PolicyUpgrade accountId={policy.payerId} features={status.data.features} busy={busy} exec={exec} run={run} />;
  }
  const cfg = status.data.config;
  return (
    <>
      <X402AccountCard policy={policy} cfg={cfg} busy={busy} exec={exec} />
      {cfg && agents.map((agent) => <X402AgentCard key={agent.agent_id} agent={agent} cfg={cfg} policy={policy} busy={busy} exec={exec} />)}
    </>
  );
}

function X402AccountCard({ policy, cfg, busy, exec }: { policy: PolicyClient; cfg: X402Config | null; busy: boolean; exec: Execute }) {
  const payer = policy.payerId;
  const asset = USDC_CONTRACT[config.network];
  const balance = useAsync(() => (cfg ? ftBalanceOf(rpc, cfg.asset, payer) : Promise.resolve(null)), [payer, cfg?.asset, busy]);
  const [cap, setCap] = useState("");
  return (
    <section className="card" aria-labelledby="x402-title">
      <div className="row">
        <h3 id="x402-title">x402 payments (USDC)</h3>
        <span className={`badge ${cfg ? "active" : "paused"}`}>{cfg ? "On" : "Off"}</span>
      </div>
      <p className="hint">
        Agents can buy from x402 sellers in USDC. Each payment is checked against the agent's x402 limits on-chain. Only then does exactly
        that amount move from your account to the connection's payment account, which pays the seller. Nothing is kept there between payments.
      </p>
      {cfg && (
        <dl className="facts">
          <dt>Token</dt>
          <dd><a href={explorerAccount(cfg.asset)} target="_blank" rel="noreferrer">{cfg.asset === asset ? "USDC" : short(cfg.asset)}</a></dd>
          <dt>Your USDC</dt>
          <dd>{balance.data == null ? "—" : usdc(balance.data)}</dd>
          <dt>Daily cap, all agents</dt>
          <dd>{cfg.account_daily_cap === null ? "none" : usdc(cfg.account_daily_cap)}</dd>
        </dl>
      )}
      <div className="actions">
        <input aria-label="x402 daily cap for all agents (USDC)" placeholder="daily cap, USDC" value={cap} onChange={(e) => setCap(e.target.value)} inputMode="decimal" pattern={usdcPattern} />
        {cfg ? (
          <>
            <button disabled={busy || !cap} onClick={() => exec("Set x402 daily cap", () => setX402Config(payer, cfg.asset, parseUsdc(cap)))}>Set daily cap</button>
            {cfg.account_daily_cap !== null && <button disabled={busy} onClick={() => exec("Remove x402 daily cap", setX402Config(payer, cfg.asset, null))}>Remove cap</button>}
            <button className="danger" disabled={busy} onClick={() => exec("Turn off x402", setX402Config(payer, null))}>Turn off x402</button>
          </>
        ) : (
          <button className="primary" disabled={busy} onClick={() => exec("Turn on x402", () => setX402Config(payer, asset, cap ? parseUsdc(cap) : null))}>
            Turn on x402 in USDC
          </button>
        )}
      </div>
    </section>
  );
}

function X402AgentCard({ agent, cfg, policy, busy, exec }: { agent: AgentView; cfg: X402Config; policy: PolicyClient; busy: boolean; exec: Execute }) {
  const { registry } = useWorkspaceRegistry();
  const payer = policy.payerId;
  const data = useAsync(async () => {
    const [mandate, rules, usage, connections] = await Promise.all([
      policy.getMandate(agent.agent_id),
      policy.getX402Rules(agent.agent_id),
      policy.getX402Usage(agent.agent_id),
      policy.getConnections(agent.agent_id),
    ]);
    const sellerUsage = new Map(
      await Promise.all(Object.keys(rules?.sellers ?? {}).map(async (s) => [s, (await policy.getX402Usage(agent.agent_id, s)).seller_used_today ?? 0n] as const)),
    );
    const siteUsage = new Map(
      await Promise.all(
        Object.keys(rules?.sites ?? {}).map(async (s) => [s, (await policy.getX402Usage(agent.agent_id, undefined, { site: s })).site_used_today ?? 0n] as const),
      ),
    );
    const payeeUsage = new Map(
      await Promise.all(
        Object.keys(rules?.agents ?? {}).map(async (p) => [p, (await policy.getX402Usage(agent.agent_id, undefined, { payee: p })).payee_used_today ?? 0n] as const),
      ),
    );
    const accounts = await Promise.all(
      connections.map(async (c) => {
        let account: string | null = null;
        try {
          account = x402AccountFor(c.public_key);
        } catch {
          return { connection: c, account, ready: false, unspent: 0n };
        }
        const exists = await rpc.accountExists(account).catch(() => false);
        const ready = exists && (await isTokenRegistered(rpc, cfg.asset, account).catch(() => false));
        const unspent = ready ? await ftBalanceOf(rpc, cfg.asset, account).catch(() => 0n) : 0n;
        return { connection: c, account, ready, unspent };
      }),
    );
    return { mandate, rules, usage, sellerUsage, siteUsage, payeeUsage, accounts };
  }, [agent.agent_id, cfg.asset, busy]);
  const [cap, setCap] = useState("");

  const d = data.data;
  if (data.error) return <p className="notice error">{agent.handle}: {data.error}</p>;
  if (!d) return null;
  const active = d.mandate?.status === "Active";
  const editable = active && !d.mandate?.fixed;
  const reg = registry.registryId;

  return (
    <div className="card">
      <div className="row">
        <strong>{agent.handle}</strong>
        <span className="badge">x402</span>
        <span className={`badge ${agent.x402 && d.rules && active ? "active" : "paused"}`}>{agent.x402 && d.rules && active ? "Can pay sellers" : "Cannot pay sellers yet"}</span>
      </div>

      <p>
        Largest x402 payment: {agent.x402 ? usdc(agent.x402.max_per_payment) : "not allowed (set below)"}. This cap lives on the agent's NFT and
        only narrows for agents below it.
      </p>
      <form className="actions" onSubmit={(e) => {
        e.preventDefault();
        void exec("Set x402 cap", () => setX402Capability(reg, agent.agent_id, cap.trim() ? x402Capability(parseUsdc(cap)) : null));
      }}>
        <input aria-label={`Largest x402 payment for ${agent.handle} (USDC)`} placeholder="USDC · blank refuses x402" value={cap} onChange={(e) => setCap(e.target.value)} inputMode="decimal" pattern={usdcPattern} />
        <button type="submit" disabled={busy}>Set x402 cap</button>
      </form>

      {!d.mandate && (
        <>
          <p>This agent is not approved on your account yet.</p>
          <button disabled={busy} onClick={() => exec("Approve for x402", async () => setMandate(payer, { agentId: agent.agent_id, path: await registry.getPath(agent.agent_id), dailyCap: 0n, recipients: [] }))}>
            Approve for x402 only (no NEAR budget)
          </button>
        </>
      )}
      {d.mandate && !active && <p className="hint">This agent's approval is revoked. Approve it again under Approved agents.</p>}
      {d.mandate?.fixed && <p className="hint">This approval is fixed, so its x402 limits cannot change. Revoke it and approve again to change them.</p>}

      {editable && <RulesForm agent={agent} payer={payer} rules={d.rules} busy={busy} exec={exec} />}

      {d.rules && (
        <>
          <p>
            Daily x402 budget: {usdc(d.usage.mandate_used_today)} of {usdc(d.rules.daily_cap)} used today.{" "}
            {d.rules.unlisted
              ? `Other sellers: up to ${usdc(d.rules.unlisted.per_payment_cap)} each, ${usdc(d.rules.unlisted.daily_cap)} a day together (${usdc(d.usage.unlisted_used_today)} used today).`
              : "Sellers that are not listed are refused."}
          </p>
          <table>
            <thead>
              <tr><th>Approved seller</th><th>Per payment</th><th>Daily</th><th>Used today</th><th /></tr>
            </thead>
            <tbody>
              {Object.entries(d.rules.sellers).map(([seller, limit]) => (
                <tr key={seller}>
                  <td>{seller}</td>
                  <td>{usdc(limit.per_payment_cap)}</td>
                  <td>{usdc(limit.daily_cap)}</td>
                  <td>{usdc(d.sellerUsage.get(seller) ?? 0n)}</td>
                  <td>{editable && <button disabled={busy} onClick={() => exec("Remove seller", removeX402Seller(payer, agent.agent_id, seller))}>Remove</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {editable && <SellerForm agentId={agent.agent_id} payer={payer} busy={busy} exec={exec} />}

          <h4>Approved agents</h4>
          <p className="hint">
            Pay another agent by its NFT. Before each payment, the policy checks that registry on-chain: the account being paid must hold that agent
            now, and if the agent has changed hands since you approved it, payment is refused.
          </p>
          {Object.keys(d.rules.agents).length > 0 && (
            <table>
              <thead>
                <tr><th>Agent</th><th>Per payment</th><th>Daily</th><th>Used today</th><th /></tr>
              </thead>
              <tbody>
                {Object.entries(d.rules.agents).map(([payee, rule]) => (
                  <tr key={payee}>
                    <td>
                      #{rule.agent_id} in <a href={explorerAccount(rule.registry)} target="_blank" rel="noreferrer">{rule.registry}</a>
                      {rule.generation !== null && <span className="hint"> · generation {rule.generation.toString()}</span>}
                    </td>
                    <td>{usdc(rule.per_payment_cap)}</td>
                    <td>{usdc(rule.daily_cap)}</td>
                    <td>{usdc(d.payeeUsage.get(payee) ?? 0n)}</td>
                    <td>{editable && <button disabled={busy} onClick={() => exec("Remove agent", removeX402Agent(payer, agent.agent_id, payee))}>Remove</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {editable && <PayeeAgentForm agentId={agent.agent_id} payer={payer} busy={busy} exec={exec} />}

          <h4>Approved websites</h4>
          <p className="hint">
            Pay a website by its address, such as <code>api.example.com</code>. Your agent's software reports which site asked for payment. Pin the
            account it must be paid at, and the rule is enforced fully on-chain.
          </p>
          {Object.keys(d.rules.sites).length > 0 && (
            <table>
              <thead>
                <tr><th>Website</th><th>Paid to</th><th>Per payment</th><th>Daily</th><th>Used today</th><th /></tr>
              </thead>
              <tbody>
                {Object.entries(d.rules.sites).map(([site, rule]) => (
                  <tr key={site}>
                    <td>{site}</td>
                    <td>{rule.pay_to ?? <span className="hint">any account the site names</span>}</td>
                    <td>{usdc(rule.per_payment_cap)}</td>
                    <td>{usdc(rule.daily_cap)}</td>
                    <td>{usdc(d.siteUsage.get(site) ?? 0n)}</td>
                    <td>{editable && <button disabled={busy} onClick={() => exec("Remove website", removeX402Site(payer, agent.agent_id, site))}>Remove</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {editable && <SiteForm agentId={agent.agent_id} payer={payer} busy={busy} exec={exec} />}
          {editable && (
            <button className="danger" disabled={busy} onClick={() => exec("Remove x402 limits", removeX402Rules(payer, agent.agent_id))}>
              Stop x402 for this agent
            </button>
          )}
        </>
      )}

      <h4>Payment accounts</h4>
      {d.accounts.length === 0 && <p className="hint">Connect this agent first. Each connection key gets its own payment account.</p>}
      <ul className="plain">
        {d.accounts.map(({ connection, account, ready, unspent }) => (
          <li key={connection.public_key}>
            <strong>{connection.label}</strong>{" "}
            {account ? <a href={explorerAccount(account)} target="_blank" rel="noreferrer"><code>{short(account)}</code></a> : <span className="hint">needs an ed25519 key</span>}{" "}
            <span className={`badge ${ready ? "active" : "paused"}`}>{ready ? "ready" : "not set up"}</span>
            {unspent > 0n && <span className="hint"> · {usdc(unspent)} unspent (the agent can return it)</span>}
            {account && !ready && (
              <button disabled={busy} onClick={() => exec("Set up payment account", setupX402Account(payer, connection.public_key))}>
                Set up (0.01 NEAR plus a refundable USDC registration)
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function RulesForm({ agent, payer, rules, busy, exec }: { agent: AgentView; payer: string; rules: X402Rules | null; busy: boolean; exec: Execute }) {
  const [daily, setDaily] = useState(rules ? formatUsdc(rules.daily_cap) : "1");
  const [allowUnlisted, setAllowUnlisted] = useState(rules ? rules.unlisted !== null : true);
  const [per, setPer] = useState(rules?.unlisted ? formatUsdc(rules.unlisted.per_payment_cap) : DEFAULT_UNLISTED.per);
  const [unlistedDaily, setUnlistedDaily] = useState(rules?.unlisted ? formatUsdc(rules.unlisted.daily_cap) : DEFAULT_UNLISTED.daily);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void exec(rules ? "Update x402 limits" : "Set x402 limits", () =>
      setX402Rules(payer, agent.agent_id, {
        dailyCap: parseUsdc(daily),
        // Keep every approval: this form changes only the budgets.
        sellers: Object.entries(rules?.sellers ?? {}).map(([seller, l]) => ({ seller, perPaymentCap: l.per_payment_cap, dailyCap: l.daily_cap })),
        sites: Object.entries(rules?.sites ?? {}).map(([site, r]) => ({ site, payTo: r.pay_to, perPaymentCap: r.per_payment_cap, dailyCap: r.daily_cap })),
        agents: Object.values(rules?.agents ?? {}).map((r) => ({
          registry: r.registry,
          agentId: r.agent_id,
          generation: r.generation,
          perPaymentCap: r.per_payment_cap,
          dailyCap: r.daily_cap,
        })),
        unlisted: allowUnlisted ? { perPaymentCap: parseUsdc(per), dailyCap: parseUsdc(unlistedDaily) } : null,
      }),
    );
  };
  return (
    <form className="inline" onSubmit={submit}>
      <label>Daily x402 budget (USDC) <input value={daily} onChange={(e) => setDaily(e.target.value)} inputMode="decimal" pattern={usdcPattern} required /></label>
      <label><input type="checkbox" checked={allowUnlisted} onChange={(e) => setAllowUnlisted(e.target.checked)} /> Allow a small budget for sellers I have not listed</label>
      {allowUnlisted && (
        <>
          <label>Each (USDC) <input value={per} onChange={(e) => setPer(e.target.value)} inputMode="decimal" pattern={usdcPattern} required /></label>
          <label>Per day, all of them (USDC) <input value={unlistedDaily} onChange={(e) => setUnlistedDaily(e.target.value)} inputMode="decimal" pattern={usdcPattern} required /></label>
        </>
      )}
      <button type="submit" disabled={busy}>{rules ? "Update x402 limits" : "Set x402 limits"}</button>
    </form>
  );
}

/** Approves another agent by its NFT, pinned to its current generation so a transfer voids it. */
function PayeeAgentForm({ agentId, payer, busy, exec }: { agentId: string; payer: string; busy: boolean; exec: Execute }) {
  const [registry, setRegistry] = useState("");
  const [id, setId] = useState("");
  const [per, setPer] = useState("");
  const [daily, setDaily] = useState("");
  return (
    <form
      className="inline"
      onSubmit={(e) => {
        e.preventDefault();
        void exec("Approve agent", async () => {
          const payee = await new RegistryClient(rpc, registry.trim()).getAgent(id.trim());
          if (!payee) throw new Error(`There is no agent #${id.trim()} in ${registry.trim()}.`);
          if (payee.status.state !== "active") throw new Error(`Agent #${payee.agent_id} is ${payee.status.state}.`);
          return approveX402Agent(payer, agentId, {
            registry: registry.trim(),
            agentId: payee.agent_id,
            perPaymentCap: parseUsdc(per),
            dailyCap: parseUsdc(daily),
            generation: payee.generation,
          });
        });
      }}
    >
      <input value={registry} onChange={(e) => setRegistry(e.target.value)} placeholder="agents.seller.testnet" aria-label="The agent's registry" required />
      <input value={id} onChange={(e) => setId(e.target.value)} placeholder="agent ID, such as 7" aria-label="Agent ID" inputMode="numeric" pattern="\d{1,20}" required />
      <input value={per} onChange={(e) => setPer(e.target.value)} placeholder="per payment, USDC" aria-label="Per payment (USDC)" inputMode="decimal" pattern={usdcPattern} required />
      <input value={daily} onChange={(e) => setDaily(e.target.value)} placeholder="per day, USDC" aria-label="Per day (USDC)" inputMode="decimal" pattern={usdcPattern} required />
      <button type="submit" disabled={busy}>Approve agent</button>
    </form>
  );
}

/** Approves a website by host, optionally pinned to the account it must be paid at. */
function SiteForm({ agentId, payer, busy, exec }: { agentId: string; payer: string; busy: boolean; exec: Execute }) {
  const [site, setSite] = useState("");
  const [payTo, setPayTo] = useState("");
  const [per, setPer] = useState("");
  const [daily, setDaily] = useState("");
  return (
    <form
      className="inline"
      onSubmit={(e) => {
        e.preventDefault();
        void exec("Approve website", () =>
          approveX402Site(payer, agentId, {
            // Accept a pasted link too: keep only the host.
            site: (/^https?:\/\//i.test(site.trim()) ? new URL(site.trim()).host : site.trim()).toLowerCase(),
            payTo: payTo.trim() || null,
            perPaymentCap: parseUsdc(per),
            dailyCap: parseUsdc(daily),
          }),
        );
      }}
    >
      <input value={site} onChange={(e) => setSite(e.target.value)} placeholder="api.example.com" aria-label="Website" required />
      <input value={payTo} onChange={(e) => setPayTo(e.target.value)} placeholder="paid to (optional)" aria-label="Account it must be paid at (optional)" />
      <input value={per} onChange={(e) => setPer(e.target.value)} placeholder="per payment, USDC" aria-label="Per payment (USDC)" inputMode="decimal" pattern={usdcPattern} required />
      <input value={daily} onChange={(e) => setDaily(e.target.value)} placeholder="per day, USDC" aria-label="Per day (USDC)" inputMode="decimal" pattern={usdcPattern} required />
      <button type="submit" disabled={busy}>Approve website</button>
    </form>
  );
}

function SellerForm({ agentId, payer, busy, exec }: { agentId: string; payer: string; busy: boolean; exec: Execute }) {
  const [seller, setSeller] = useState("");
  const [per, setPer] = useState("");
  const [daily, setDaily] = useState("");
  return (
    <form
      className="inline"
      onSubmit={(e) => {
        e.preventDefault();
        void exec("Approve seller", () => approveX402Seller(payer, agentId, seller.trim(), { perPaymentCap: parseUsdc(per), dailyCap: parseUsdc(daily) }));
      }}
    >
      <input value={seller} onChange={(e) => setSeller(e.target.value)} placeholder="seller.testnet" aria-label="Seller account" required />
      <input value={per} onChange={(e) => setPer(e.target.value)} placeholder="per payment, USDC" aria-label="Per payment (USDC)" inputMode="decimal" pattern={usdcPattern} required />
      <input value={daily} onChange={(e) => setDaily(e.target.value)} placeholder="per day, USDC" aria-label="Per day (USDC)" inputMode="decimal" pattern={usdcPattern} required />
      <button type="submit" disabled={busy}>Approve seller</button>
    </form>
  );
}

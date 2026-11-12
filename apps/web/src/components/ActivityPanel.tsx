import { describeReason } from "@nearfirewall/sdk";
import { config, policyOf, registry } from "../config.ts";
import { near, timeText } from "../format.ts";
import { useAsync } from "../hooks.ts";
import { useWallet } from "../wallet.tsx";

/**
 * Settled and blocked attempts, read from the bounded activity logs that both
 * contracts keep on chain. No indexer or backend is involved.
 */
export function ActivityPanel() {
  const { accountId } = useWallet();
  const data = useAsync(async () => {
    if (!accountId) return null;
    const state = await policyOf(accountId).state(config.policyCodeHash);
    const payments = state.kind === "enabled" ? await policyOf(accountId).getActivity(64) : [];
    const agents = await registry.agentsOf(accountId);
    const routed = await Promise.all(
      agents.map(async (a) => (await registry.getActivity(a.agent_id)).map((entry) => ({ agent: a.handle, ...entry }))),
    );
    const handles = new Map(agents.map((a) => [a.agent_id, a.handle]));
    return { payments, registryDenials: routed.flat().filter((e) => e.outcome === "denied"), handles };
  }, [accountId]);

  if (!accountId) return <p className="muted">Connect a wallet to see activity.</p>;
  const d = data.data;

  return (
    <section>
      <div className="row">
        <h2>Activity</h2>
        <button onClick={data.reload}>Refresh</button>
      </div>
      {data.error && <p className="notice error">{data.error}</p>}
      <h3>Payments from your account</h3>
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Agent</th>
            <th>Recipient</th>
            <th>Amount</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          {(d?.payments ?? []).map((p) => (
            <tr key={p.seq.toString()} className={p.outcome}>
              <td>{timeText(p.at)}</td>
              <td>{d?.handles.get(p.leaf) ?? `#${p.leaf}`}</td>
              <td>{p.recipient}</td>
              <td>{near(p.amount)}</td>
              <td>
                {p.outcome === "denied" && p.reason ? (
                  <span title={p.reason}>Blocked: {describeReason(p.reason)}</span>
                ) : p.outcome === "settled" ? (
                  "Paid"
                ) : (
                  "Failed, reservation released"
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Requests the registry blocked</h3>
      <p className="hint">These never reached your account: the agent or a parent was paused, expired, removed, or over its capability.</p>
      <table>
        <tbody>
          {(d?.registryDenials ?? []).map((e) => (
            <tr key={`${e.agent}-${e.seq}`}>
              <td>{timeText(e.at)}</td>
              <td>{e.agent}</td>
              <td>{e.action.recipient}</td>
              <td>{near(e.action.amount)}</td>
              <td>{e.reason ? describeReason(e.reason) : "Blocked"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

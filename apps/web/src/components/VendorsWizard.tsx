import { useState } from "react";
import { nowNs } from "@nearfirewall/sdk";
import {
  approvedVendors,
  buildPlan,
  describeStep,
  toTransaction,
  validatePlanLive,
  type Plan,
  type PlanContext,
  type ValidationIssue,
} from "@nearfirewall/templates";
import { config, policyOf, registry } from "../config.ts";
import { ensureOk } from "../format.ts";
import { useWallet } from "../wallet.tsx";

interface RecipientRow {
  recipient: string;
  perPayment: string;
  daily: string;
}

/**
 * Builds an "Approved vendors" plan, validates it against the chain, and walks
 * the owner through signing each step. Steps are signed one at a time because
 * later steps refer to agents that earlier steps create.
 */
export function VendorsWizard({ payer, busy }: { payer: string; busy: boolean }) {
  const { accountId, send } = useWallet();
  const [handle, setHandle] = useState("");
  const [existing, setExisting] = useState(false);
  const [executor, setExecutor] = useState("");
  const [maxPerPayment, setMax] = useState("3");
  const [dailyBudget, setBudget] = useState("10");
  const [rows, setRows] = useState<RecipientRow[]>([{ recipient: "", perPayment: "3", daily: "6" }]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(0);
  const [signing, setSigning] = useState(false);

  if (!accountId) return null;
  const ctx: PlanContext = { now: nowNs(), owner: accountId, payer, registryId: config.registryId };

  const review = async () => {
    setError(null);
    setDone(0);
    try {
      let built = buildPlan(
        approvedVendors,
        { handle, executor: existing ? "existing.invalid" : executor, maxPerPayment, dailyBudget, recipients: rows },
        ctx,
      );
      if (existing) built = { ...built, steps: built.steps.filter((s) => s.kind === "set_mandate") };
      const result = await validatePlanLive(built, ctx, {
        registry,
        policy: policyOf(payer),
        expectedPolicyCodeHash: config.policyCodeHash,
      });
      setPlan(built);
      setIssues(result.issues);
    } catch (e) {
      setPlan(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const signNext = async () => {
    if (!plan) return;
    const step = plan.steps[done];
    if (!step) return;
    setSigning(true);
    setError(null);
    try {
      ensureOk(await send(await toTransaction(step, ctx, registry)));
      setDone(done + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSigning(false);
    }
  };

  const blocking = issues.some((i) => i.level === "error");
  const update = (i: number, patch: Partial<RecipientRow>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <div className="card" id="approve-vendors">
      <h3>Approve vendors</h3>
      <p className="hint">One signature per step. Each recipient gets its own per-payment and daily limit, inside the agent's daily budget.</p>
      <label className="check">
        <input type="checkbox" checked={existing} onChange={(e) => setExisting(e.target.checked)} /> The agent is already registered
      </label>
      <label>
        Agent handle <input value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="market-agent" />
      </label>
      {!existing && (
        <>
          <label>
            Executor account <input value={executor} onChange={(e) => setExecutor(e.target.value)} placeholder="agent-runner.testnet" />
          </label>
          <label>
            Max per payment (NEAR) <input value={maxPerPayment} onChange={(e) => setMax(e.target.value)} inputMode="decimal" />
          </label>
        </>
      )}
      <label>
        Daily budget across all recipients (NEAR) <input value={dailyBudget} onChange={(e) => setBudget(e.target.value)} inputMode="decimal" />
      </label>
      <table>
        <thead>
          <tr>
            <th>Recipient</th>
            <th>Per payment</th>
            <th>Per day</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              <td>
                <input value={row.recipient} onChange={(e) => update(i, { recipient: e.target.value.trim() })} placeholder="vendor.testnet" />
              </td>
              <td>
                <input value={row.perPayment} onChange={(e) => update(i, { perPayment: e.target.value })} inputMode="decimal" />
              </td>
              <td>
                <input value={row.daily} onChange={(e) => update(i, { daily: e.target.value })} inputMode="decimal" />
              </td>
              <td>
                <button type="button" onClick={() => setRows(rows.filter((_, j) => j !== i))} disabled={rows.length === 1}>
                  ×
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="actions">
        <button type="button" onClick={() => setRows([...rows, { recipient: "", perPayment: "1", daily: "2" }])}>
          Add recipient
        </button>
        <button type="button" disabled={busy || signing} onClick={() => void review()}>
          Review
        </button>
      </div>
      {error && <p className="notice error">{error}</p>}
      {plan && (
        <div className="plan">
          {issues.length === 0 && <p className="notice ok">No problems found.</p>}
          <ul>
            {issues.map((issue, i) => (
              <li key={i} className={issue.level}>
                <strong>{issue.level === "error" ? "Error" : "Check"}:</strong> {issue.message}
              </li>
            ))}
          </ul>
          <ol>
            {plan.steps.map((step, i) => (
              <li key={i} className={i < done ? "done" : ""}>
                {describeStep(step)} {i < done && "✓"}
              </li>
            ))}
          </ol>
          {done < plan.steps.length ? (
            <button disabled={blocking || signing || busy} onClick={() => void signNext()}>
              Sign step {done + 1} of {plan.steps.length}
            </button>
          ) : (
            <p className="notice ok">All steps are signed. The agent can now pay these recipients within their limits.</p>
          )}
        </div>
      )}
    </div>
  );
}

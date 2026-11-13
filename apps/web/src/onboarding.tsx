/**
 * First-run guide: a progress wheel in the bottom-right corner and a dialog
 * that says what to do next and, behind an "i", why it matters.
 *
 * Progress comes from on-chain state (agents held, policy installed, mandates,
 * payment activity), so it is accurate, survives reloads, and follows the
 * account to any device. Only "reviewed activity" and "dismissed" are kept in
 * local storage.
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ArrowRight, Check, Copy, Info, X } from "lucide-react";
import { policyOf } from "./config.ts";
import { useWorkspaceRegistry } from "./workspace-registry.tsx";
import { href } from "./router.ts";

export type StepId = "connect" | "registry" | "register" | "enable" | "approve" | "link" | "run" | "review";

interface Progress {
  agents: { agent_id: string; handle: string; executor: string | null }[];
  enabled: boolean;
  otherContract: boolean;
  approved: boolean;
  firstPayment: boolean;
  connected: boolean;
}

interface Step {
  id: StepId;
  title: string;
  todo: ReactNode;
  why: string;
  action?: { label: string; path: string; target?: string };
}

const STORAGE = (account: string, key: string) => `nearfirewall:onboarding:${account}:${key}`;

function readFlag(account: string, key: string): boolean {
  try {
    return localStorage.getItem(STORAGE(account, key)) === "1";
  } catch {
    return false;
  }
}

function writeFlag(account: string, key: string) {
  try {
    localStorage.setItem(STORAGE(account, key), "1");
  } catch {
    // Storage can be blocked; the guide still works for this session.
  }
}

async function loadProgress(accountId: string, { registry, policyCodeHash }: ReturnType<typeof useWorkspaceRegistry>): Promise<Progress> {
  const policy = policyOf(accountId);
  const [agents, state] = await Promise.all([registry.agentsOf(accountId), policy.state(policyCodeHash)]);
  const view = state.kind === "enabled" ? await policy.getPolicy() : null;
  const enabled = view?.registry === registry.registryId;
  let approved = false;
  let firstPayment = false;
  if (enabled) {
    const [mandates, activity] = await Promise.all([
      Promise.all(agents.map((a) => policy.getMandate(a.agent_id))),
      policy.getActivity(1),
    ]);
    approved = mandates.some((m) => m !== null && m.status === "Active" && Object.keys(m.recipients).length > 0);
    firstPayment = activity.length > 0;
  }
  return {
    agents: agents.filter((a) => a.status.state !== "removed").map(({ agent_id, handle, executor }) => ({ agent_id, handle, executor })),
    enabled,
    otherContract: state.kind === "other" || (view !== null && !enabled),
    approved,
    firstPayment,
    connected: enabled && (view.connections ?? 0) > 0,
  };
}

function CopyLine({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="guide-code">
      <code>{text}</code>
      <button
        type="button"
        className="icon-btn"
        aria-label={copied ? "Copied" : "Copy command"}
        title={copied ? "Copied" : "Copy command"}
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? <Check size={15} /> : <Copy size={15} />}
      </button>
    </div>
  );
}

function buildSteps(accountId: string, p: Progress | undefined, { mode, registry }: ReturnType<typeof useWorkspaceRegistry>): Step[] {
  const agent = p?.agents[0];
  const handle = agent?.handle ?? "<your-agent>";
  const steps: Step[] = [
    {
      id: "connect",
      title: "Connect your wallet",
      todo: "Done. This account owns every agent you register, and it is the account your agents pay from.",
      why: "Your wallet signs every change to your rules. The policy on this account sends payments within those rules.",
    },
    {
      id: "registry",
      title: "Create your registry",
      todo: "Create the agents subaccount and approve its storage deposit in your wallet.",
      why: "Your registry holds the agent NFTs and checks their identities and capabilities before the policy can pay.",
      action: { label: "Create my registry", path: "/app/map", target: "create-registry" },
    },
    {
      id: "register",
      title: "Register your agent",
      todo: mode === "per-user" ? "Give the agent a handle and set its maximum payment, then sign in your wallet." : "Give the agent a handle and a separate executor account, then sign in your wallet.",
      why: "The registry mints the agent as an NFT you own. Its capabilities limit what any key can request for it.",
      action: { label: "Register an agent", path: "/app/agents", target: "register-agent" },
    },
    {
      id: "enable",
      title: "Enable payments on your account",
      todo: p?.otherContract
        ? "This account already runs a different contract, so NEARFirewall will not install its policy here. Connect an account without a contract."
        : "Choose Enable payments. Your wallet asks you to sign one transaction to your own account.",
      why: "The policy on your account checks each request against your rules. A direct deployment reserves part of your balance for contract storage.",
      action: p?.otherContract ? undefined : { label: "Enable payments", path: "/app/payments", target: "enable-payments" },
    },
    {
      id: "approve",
      title: "Approve who the agent can pay",
      todo: "Add recipients, each with its own per-payment and daily limit. Then set the agent's daily budget, review, and sign.",
      why: "The agent can only pay recipients you approve, within each recipient's limits and its overall daily budget. Everything else is blocked on-chain, even if the agent is compromised or tricked by a malicious prompt.",
      action: { label: "Approve recipients", path: "/app/payments", target: "approve-vendors" },
    },
    {
      id: "link",
      title: "Connect your agent",
      todo: "In Agents, choose Connect and set up a local MCP client. Use its get_rules tool to verify the connection.",
      why: "The key can call only agent_execute and cannot change your payment rules.",
      action: { label: "Open Agents", path: "/app/agents" },
    },
    {
      id: "run",
      title: "Let the agent make a payment",
      todo: (
        <>
          {agent?.executor ? <>
            <p>Run the demo with the separate executor account, or request a payment from a connected agent.</p>
            <CopyLine text={`npm run runner -- apps/runner/scenarios/readme-limits.json --payer ${accountId} --agent ${handle} --executor ${agent.executor} --registry ${registry.registryId}`} />
          </> : <p>Ask your connected client to preview and pay an approved recipient within your limits.</p>}
          <p className="hint">This step completes when the first payment, or the first blocked attempt, reaches your account.</p>
        </>
      ),
      why: "Payments within your limits go through with no further signature from you. The agent works on its own, and your rules decide what is allowed, not the agent's code.",
    },
    {
      id: "review",
      title: "Review what happened",
      todo: "Open Activity to see every settled and blocked attempt, with the reason for each.",
      why: "Every attempt is recorded on-chain, including blocked ones. If something looks wrong, pause all payments under Payments, or pause the agent under Agents. A pause applies to the very next request.",
      action: { label: "Open activity", path: "/app/activity" },
    },
  ];
  return steps.filter((step) => mode === "per-user" || (step.id !== "registry" && step.id !== "link"));
}

function isDone(id: StepId, p: Progress | undefined, reviewed: boolean, registryReady: boolean): boolean {
  if (id === "connect") return true;
  if (id === "registry") return registryReady;
  if (!p) return false;
  switch (id) {
    case "register":
      return p.agents.length > 0;
    case "enable":
      return p.enabled;
    case "approve":
      return p.approved;
    case "link":
      return p.connected || (p.firstPayment && p.agents.some((agent) => agent.executor));
    case "run":
      return p.firstPayment;
    case "review":
      return p.firstPayment && reviewed;
  }
}

/** The "i" next to a step: explains why, on hover, focus, or tap. */
function WhyTip({ text }: { text: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <span className={`why${open ? " open" : ""}`} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        className="why-btn"
        aria-label="Why this step?"
        aria-describedby={id}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onBlur={() => setOpen(false)}
      >
        <Info size={15} aria-hidden="true" />
      </button>
      <span role="tooltip" id={id} className="why-text">
        <strong>Why</strong> {text}
      </span>
    </span>
  );
}

/** Ring of segments. It turns one notch and fills one segment per completed step. */
function Wheel({ total, done, complete }: { total: number; done: number; complete: boolean }) {
  const r = 22;
  const c = 2 * Math.PI * r;
  const gap = 4;
  const seg = c / total - gap;
  return (
    <svg className="wheel" viewBox="0 0 56 56" width="56" height="56" aria-hidden="true">
      <g className="wheel-rotor" style={{ transform: `rotate(${done * (360 / total)}deg)` }}>
        {Array.from({ length: total }, (_, i) => (
          <circle
            key={i}
            cx="28"
            cy="28"
            r={r}
            fill="none"
            className={i < done ? "seg done" : "seg"}
            strokeWidth="5"
            strokeLinecap="round"
            strokeDasharray={`${seg} ${c - seg}`}
            strokeDashoffset={-(i * (c / total)) + c / 4}
          />
        ))}
      </g>
      {complete ? (
        <path className="wheel-check" d="M19 28.5l6 6 12-13" fill="none" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <text x="28" y="32.5" textAnchor="middle" className="wheel-count">
          {done}/{total}
        </text>
      )}
    </svg>
  );
}

function goTo(path: string, target?: string) {
  window.location.hash = path;
  if (!target) return;
  // Let the panel render, then bring the form into view and flash it.
  setTimeout(() => {
    const el = document.getElementById(target);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    el.classList.remove("guide-flash");
    void el.offsetWidth;
    el.classList.add("guide-flash");
  }, 250);
}

export function OnboardingGuide({ accountId, panel, registryReady }: { accountId: string; panel: string; registryReady: boolean }) {
  const workspace = useWorkspaceRegistry();
  const [progress, setProgress] = useState<Progress>();
  const [reviewed, setReviewed] = useState(() => readFlag(accountId, "reviewed"));
  const [dismissed, setDismissed] = useState(() => readFlag(accountId, "dismissed"));
  // "Hide the guide" lasts for this page session only; finishing setup dismisses it for good.
  const [hidden, setHidden] = useState(false);
  const [open, setOpen] = useState(!registryReady);
  const [justDone, setJustDone] = useState<string | null>(null);
  const prevDone = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    if (!registryReady) return;
    try {
      setProgress(await loadProgress(accountId, workspace));
    } catch {
      // Keep the last known progress; the next poll retries.
    }
  }, [accountId, registryReady, workspace]);

  const steps = buildSteps(accountId, progress, workspace);
  const doneFlags = steps.map((s) => isDone(s.id, progress, reviewed, registryReady));
  const doneCount = doneFlags.filter(Boolean).length;
  const complete = doneCount === steps.length;
  const current = steps.find((_, i) => !doneFlags[i]);

  // Reset when the account changes.
  useEffect(() => {
    setProgress(undefined);
    setReviewed(readFlag(accountId, "reviewed"));
    setDismissed(readFlag(accountId, "dismissed"));
    prevDone.current = null;
  }, [accountId]);

  // Poll chain state until setup is complete, and on navigation or tab focus.
  useEffect(() => {
    if (dismissed) return;
    void refresh();
    if (complete) return;
    const timer = setInterval(() => void refresh(), 6000);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    window.addEventListener("hashchange", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("hashchange", onFocus);
    };
  }, [refresh, complete, dismissed]);

  // Opening the Activity panel after the first payment completes the last step.
  useEffect(() => {
    if (panel === "activity" && progress?.firstPayment && !reviewed) {
      writeFlag(accountId, "reviewed");
      setReviewed(true);
    }
  }, [panel, progress?.firstPayment, reviewed, accountId]);

  // Open on first load, and again whenever a step completes.
  useEffect(() => {
    if (!progress) return;
    if (prevDone.current === null) {
      setOpen(!complete);
    } else if (doneCount > prevDone.current) {
      const finished = steps.filter((_, i) => doneFlags[i]).at(-1);
      setJustDone(finished?.title ?? null);
      // Open after the wheel has turned.
      setTimeout(() => setOpen(true), 650);
    }
    prevDone.current = doneCount;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doneCount, progress]);

  if (dismissed || hidden) return null;

  const close = () => {
    setOpen(false);
    setJustDone(null);
  };
  const finish = () => {
    writeFlag(accountId, "dismissed");
    setDismissed(true);
  };

  return (
    <div className="guide" data-open={open || undefined}>
      {open && (
        <section className="guide-dialog" role="dialog" aria-labelledby="guide-title" aria-live="polite">
          <header className="guide-head">
            <span className="eyebrow">
              {complete ? "Setup complete" : `Step ${steps.indexOf(current!) + 1} of ${steps.length}`}
            </span>
            <button type="button" className="icon-btn" aria-label="Close guide" title="Close" onClick={close}>
              <X size={16} />
            </button>
          </header>

          {justDone && !complete && (
            <p className="guide-done">
              <Check size={15} aria-hidden="true" /> {justDone}: done
            </p>
          )}

          {complete || !current ? (
            <>
              <h2 id="guide-title">Your agent is under your control.</h2>
              <p className="guide-todo">
                It has an identity you own and pays only whom you approved, within your limits. Every attempt is recorded on-chain.
              </p>
              <div className="guide-actions">
                <button type="button" className="primary" onClick={finish}>
                  Finish
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="guide-title-row">
                <h2 id="guide-title">{current.title}</h2>
                <WhyTip text={current.why} />
              </div>
              <div className="guide-todo">{current.todo}</div>
              {current.action && (
                <div className="guide-actions">
                  <button type="button" className="primary" onClick={() => goTo(current.action!.path, current.action!.target)}>
                    {current.action.label} <ArrowRight size={15} />
                  </button>
                </div>
              )}
            </>
          )}

          <ol className="guide-steps" aria-label="Setup steps">
            {steps.map((s, i) => (
              <li key={s.id} className={doneFlags[i] ? "done" : s === current ? "current" : ""}>
                <span className="guide-mark" aria-hidden="true">
                  {doneFlags[i] ? <Check size={12} /> : i + 1}
                </span>
                <span className="guide-step-title">
                  {s.title}
                  <span className="visually-hidden">{doneFlags[i] ? " (done)" : s === current ? " (current)" : ""}</span>
                </span>
                <WhyTip text={s.why} />
              </li>
            ))}
          </ol>
          {!complete && (
            <button type="button" className="guide-skip" onClick={() => setHidden(true)}>
              Hide the guide until next visit
            </button>
          )}
        </section>
      )}

      <button
        type="button"
        className={`guide-wheel${complete ? " complete" : ""}`}
        aria-label={open ? "Hide setup guide" : `Setup guide: ${doneCount} of ${steps.length} steps done`}
        aria-expanded={open}
        title={complete ? "Setup complete" : `${doneCount} of ${steps.length} steps done`}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <Wheel total={steps.length} done={doneCount} complete={complete} />
      </button>
    </div>
  );
}

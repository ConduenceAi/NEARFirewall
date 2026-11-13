import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, ArrowUp, Check, ChevronRight, CircleSlash, Clock3, Gauge, KeyRound, Link2, RotateCcw, ShieldCheck, Wallet } from "lucide-react";
import { near } from "../format.ts";
import { AGENT_PAYMENT_CAP, CONFIRM_ABOVE, evaluateDemoPayment, INITIAL_SPEND, parseDemoRequest, RECIPIENT_DAILY_CAP, RECIPIENT_PAYMENT_CAP, type DemoPayment } from "../payment-demo.ts";
import { href } from "../router.ts";

const SCENARIOS = [
  { label: "Trading · Fund a strategy wallet", detail: "Create a child agent and request 3 NEAR for its trading wallet", prompt: "Send 3 NEAR to Strategy Wallet to fund the trading account.", vendor: "Strategy Wallet", alternate: "Unknown Wallet", app: "Trading desk", logo: null, config: null, agent: "market-maker", parent: "treasury", icon: Wallet },
  { label: "HR · Background checks", detail: "Pay 2 NEAR for a new hire’s screening", prompt: "Pay ClearCheck 2 NEAR for the new hire’s background check.", vendor: "ClearCheck", alternate: "QuickScreen", app: "Claude Desktop", logo: "claude.svg", config: "claude_desktop_config.json", agent: "people-ops", icon: Check },
  { label: "Engineering · CI renewal", detail: "Review a 3 NEAR build service invoice", prompt: "Pay BuildCloud 3 NEAR to renew our CI build credits.", vendor: "BuildCloud", alternate: "FastBuild", app: "Cursor", logo: "cursor.svg", config: "~/.cursor/mcp.json", agent: "dev-ops", icon: Clock3 },
  { label: "Operations · Shipping labels", detail: "A 4 NEAR invoice exceeds the per-payment limit", prompt: "Pay ParcelDesk 4 NEAR for this week’s shipping labels.", vendor: "ParcelDesk", alternate: "QuickShip", app: "Custom runner", logo: null, config: null, agent: "fulfillment", icon: Gauge },
  { label: "Finance · New software vendor", detail: "Block a 2 NEAR invoice from an unapproved vendor", prompt: "Pay LedgerTrial 2 NEAR for a trial subscription.", vendor: "LedgerDesk", alternate: "LedgerTrial", app: "Claude Code", logo: "claude-code.svg", config: "Local MCP configuration", agent: "accounts-payable", icon: CircleSlash },
] as const;

const STATUS = { settled: "Settled", blocked: "Blocked", pending: "Needs approval", declined: "Declined" };

export function PaymentDemo() {
  const [scenario, setScenario] = useState<(typeof SCENARIOS)[number]>(SCENARIOS[0]);
  const [step, setStep] = useState<"connect" | "authorize" | "configure" | "chat">("connect");
  const [childCreated, setChildCreated] = useState(false);
  const [parentPaused, setParentPaused] = useState(false);
  const parent = "parent" in scenario ? scenario.parent : null;
  const [prompt, setPrompt] = useState<string>(SCENARIOS[0].prompt);
  const [payments, setPayments] = useState<DemoPayment[]>([]);
  const [error, setError] = useState("");
  const [view, setView] = useState<"chat" | "activity">("chat");
  const conversation = useRef<HTMLDivElement>(null);
  const name = (recipient: DemoPayment["recipient"]) => recipient === "noa" ? scenario.vendor : scenario.alternate;
  const appIcon = scenario.logo ? <img className="demo-agent-icon" src={`/integrations/${scenario.logo}`} width={40} height={40} alt="" /> : <span className="demo-agent-icon"><Gauge size={20} aria-hidden="true" /></span>;
  const spent = payments.reduce((sum, payment) => payment.status === "settled" ? sum + payment.amount : sum, INITIAL_SPEND);
  const reserved = payments.reduce((sum, payment) => payment.status === "pending" ? sum + payment.amount : sum, 0n);

  useEffect(() => {
    const log = conversation.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [payments.length, step, view]);

  function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (step !== "chat") return;
    const request = parseDemoRequest(prompt, scenario.vendor, scenario.alternate);
    if (!request) {
      setError("Include one positive amount in NEAR and one of this scenario’s vendors. Try one of the sample messages.");
      return;
    }
    const decision = parent && parentPaused
      ? { status: "blocked" as const, detail: "The treasury parent is paused, so its child cannot request payments.", previewBlocked: true }
      : evaluateDemoPayment(request, spent, reserved, scenario.vendor, scenario.alternate);
    setPayments([...payments, { ...request, ...decision, id: payments.length + 1, prompt: prompt.trim() }]);
    setPrompt("");
    setError("");
  }

  function resolve(payment: DemoPayment, approve: boolean) {
    setPayments((current) => current.map((item) => item.id !== payment.id || item.status !== "pending" ? item : {
      ...item,
      status: approve ? "settled" : "declined",
      detail: approve ? `You approved ${near(item.amount)} to ${name(item.recipient)}. The payment settled.` : "You declined the request. I released its budget reservation.",
    }));
  }

  function reset() {
    setStep("connect");
    setChildCreated(false);
    setParentPaused(false);
    setView("chat");
    setPayments([]);
    setPrompt(scenario.prompt);
    setError("");
  }

  const ownerActions = (payment: DemoPayment) => (
    <div className="demo-approval" role="group" aria-label={`Review request ${payment.id}`}>
      <button type="button" onClick={() => resolve(payment, false)}>Decline</button>
      <button type="button" className="primary" onClick={() => resolve(payment, true)}>Approve payment</button>
    </div>
  );

  return (
    <section className="landing-section walkthrough" id="payment-walkthrough" aria-labelledby="walkthrough-title">
      <div className="walkthrough-copy">
        <h2 id="walkthrough-title">Try it here.</h2>
        <p className="lead">Choose a trading or workplace scenario and see what happens when its agent requests a payment.</p>
        <div className="payment-scenarios" role="group" aria-label="Sample invoices">
          {SCENARIOS.map((option) => {
            const { label, detail, icon: Icon } = option;
            return (
            <button key={label} type="button" aria-pressed={scenario === option} onClick={() => { if (scenario !== option) reset(); setScenario(option); setPrompt(option.prompt); setView("chat"); }}>
              <span className="scenario-icon"><Icon size={19} aria-hidden="true" /></span>
              <span><strong>{label}</strong><small>{detail}</small></span>
              <ChevronRight size={17} aria-hidden="true" />
            </button>
            );
          })}
        </div>
        <a className="text-link demo-setup-link" href={href("/docs/connect-agent")}>Set up a real connection <ArrowRight size={15} aria-hidden="true" /></a>
      </div>

      <div className="walkthrough-panel">
        <header className="demo-panel-header">
          {appIcon}
          <div><h3>{scenario.app}</h3><p>{step === "chat" ? scenario.agent + " connected" : scenario.label}</p></div>
          <span className="demo-mode">Interactive demo</span>
          <button className="icon-btn" type="button" title="Restart demo" aria-label="Restart demo" onClick={reset}><RotateCcw size={16} aria-hidden="true" /></button>
        </header>

        {parent && (
          <div className="demo-activity demo-hierarchy">
            <strong>Demo wallet</strong>
            <ul>
              <li><span>{parent} · Parent · {near(AGENT_PAYMENT_CAP)} per payment</span>
                <ul>{childCreated && <li>{scenario.agent} · Child · {near(RECIPIENT_PAYMENT_CAP)} to {scenario.vendor}</li>}</ul>
              </li>
            </ul>
            {step === "chat" && <button type="button" onClick={() => setParentPaused(!parentPaused)}>{parentPaused ? "Resume treasury" : "Pause treasury"}</button>}
          </div>
        )}
        {parent && !childCreated ? (
          <div className="demo-connect">
            <h4>Create a trading agent under treasury</h4>
            <p>Treasury sets the branch ceiling. The child can request transfers to the approved strategy wallet, with owner approval above {near(CONFIRM_ABOVE)}.</p>
            <button type="button" className="primary" onClick={() => setChildCreated(true)}>Create child agent <ArrowRight size={16} aria-hidden="true" /></button>
            <small>Demo funds a strategy wallet with simulated NEAR.</small>
          </div>
        ) : step !== "chat" ? (
          <div className="demo-connect">
            <div className="demo-connection-icons" aria-hidden="true">
              {appIcon}
              <Link2 size={20} />
              <img src="/logo-green.png" width={48} height={48} alt="" />
            </div>
            <h4>{step === "connect" ? "Connect your payment agent" : step === "authorize" ? "Authorize a restricted key" : scenario.config ? "Load the MCP configuration" : "Start the demo runner"}</h4>
            <p>{step === "connect" ? scenario.agent + " can request vendor payments within your spending rules."
              : step === "authorize" ? "In the real setup, your wallet signs the key authorization. The agent uses that key to request payments under your rules."
              : scenario.config ? "Add the NEARFirewall MCP server to your client configuration. The demo loads the agent’s rules for you." : "The runner uses the restricted key to submit payment requests. Start it here to load the spending rules."}</p>
            {step === "authorize" && <div className="demo-policy"><KeyRound size={17} aria-hidden="true" /> <code>agent_execute</code><span>Restricted function-call key</span></div>}
            {step === "configure" && <div className="demo-policy"><code>{scenario.config ?? "Restricted-key runner"}</code></div>}
            <button className="primary" type="button" onClick={() => setStep(step === "connect" ? "authorize" : step === "authorize" ? "configure" : "chat")}>
              {step === "connect" ? "Connect " + scenario.app : step === "authorize" ? "Authorize demo key" : scenario.config ? "Load config and open chat" : "Start runner"} <ArrowRight size={16} aria-hidden="true" />
            </button>
            <small>Uses sample data. No wallet or real funds.</small>
          </div>
        ) : (
          <>
            <div className="demo-wallet-strip"><ShieldCheck size={17} aria-hidden="true" /><span>{scenario.vendor} budget <strong>{near(RECIPIENT_DAILY_CAP - spent - reserved)} left</strong></span>{reserved > 0n && <small>{near(reserved)} reserved</small>}</div>
            <div className="demo-views" role="group" aria-label="Demo view">
              <button type="button" aria-pressed={view === "chat"} onClick={() => setView("chat")}>Chat</button>
              <button type="button" aria-pressed={view === "activity"} onClick={() => setView("activity")}>Activity {payments.length > 0 && <span>{payments.length}</span>}</button>
            </div>
            {view === "chat" ? (
              <>
                <div className="demo-conversation" ref={conversation} role="log" aria-label="Demo agent conversation">
                  <div className="demo-reply">
                    <div className="demo-tool"><code>get_rules</code><span>Rules loaded</span></div>
                    <p>I can pay {scenario.vendor} up to {near(RECIPIENT_PAYMENT_CAP)} per invoice and {near(RECIPIENT_DAILY_CAP)} per day. I’ll ask you first above {near(CONFIRM_ABOVE)}. Which invoice should I pay?</p>
                  </div>
                  {payments.map((payment) => <div className="demo-exchange" key={payment.id}>
                    <p className="demo-bubble">{payment.prompt}</p>
                    <div className="demo-reply" data-status={payment.status}>
                      <div className="demo-tool"><code>preview_payment</code>{!payment.previewBlocked && <><ChevronRight size={13} aria-hidden="true" /><code>pay</code></>}</div>
                      <strong>{STATUS[payment.status]}</strong><p>{payment.detail}</p>
                      {payment.status === "pending" && ownerActions(payment)}
                    </div>
                  </div>)}
                </div>
                <form className="demo-composer" onSubmit={send}>
                  <label className="visually-hidden" htmlFor="demo-prompt">Message the agent</label>
                  <input id="demo-prompt" value={prompt} maxLength={200} placeholder="Ask the agent to pay an invoice…" autoComplete="off"
                    aria-invalid={Boolean(error)} aria-describedby={error ? "demo-prompt-error" : undefined}
                    onChange={(event) => { setPrompt(event.target.value); setError(""); }} />
                  <button className="primary icon-btn demo-send" type="submit" aria-label="Send message" title="Send message" disabled={!prompt.trim()}><ArrowUp size={18} aria-hidden="true" /></button>
                  {error && <p id="demo-prompt-error" role="alert">{error}</p>}
                </form>
              </>
            ) : (
              <div className="demo-activity">
                {payments.length === 0 ? <p>Send an invoice in Chat to see its outcome here.</p> : <ol>
                  {payments.toReversed().map((payment) => <li key={payment.id} data-status={payment.status}>
                    <span><Wallet size={16} aria-hidden="true" /> {name(payment.recipient)}</span>
                    <strong>{near(payment.amount)}</strong>
                    <small>{STATUS[payment.status]}</small>
                    {payment.status === "pending" && ownerActions(payment)}
                  </li>)}
                </ol>}
              </div>
            )}
            <footer className="demo-footer">Simulation · Agent ceiling {near(AGENT_PAYMENT_CAP)} per payment</footer>
          </>
        )}
      </div>
    </section>
  );
}

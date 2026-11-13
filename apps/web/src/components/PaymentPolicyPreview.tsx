import { useEffect, useRef, useState } from "react";
import { parseNear } from "@nearfirewall/sdk";
import { ArrowDownRight, ArrowRight, Bot, Check, CircleSlash, ExternalLink, Fingerprint, Minus, Pause, Play, ReceiptText, RotateCcw, ShieldCheck } from "lucide-react";
import { near } from "../format.ts";
import { href } from "../router.ts";

const AGENT_DAILY_CAP = parseNear("10");
const MARKETS = {
  noa: {
    name: "Noa Market",
    icon: "/noa-market.png",
    listing: "https://nearcatalog.xyz/project/noa-market-prediction-market-on-near",
    limits: { perPayment: parseNear("3"), daily: parseNear("6") },
  },
  dragons: {
    name: "Dragons Market",
    icon: "/dragons-market.png",
    listing: "https://nearhunt.xyz/p/4a9a7ae0-6943-4a34-b4e3-99198eeee530",
    limits: null,
  },
} as const;

const SCENARIOS = [
  { label: "Within limits", recipient: "noa", amount: parseNear("2") },
  { label: "Over the cap", recipient: "noa", amount: parseNear("4") },
  { label: "Unapproved recipient", recipient: "dragons", amount: parseNear("2") },
] as const;

const STAGES = [
  { label: "Request", icon: Bot },
  { label: "Registry", icon: Fingerprint },
  { label: "Wallet policy", icon: ShieldCheck },
  { label: "Activity", icon: ReceiptText },
] as const;

const AGENT_PAYMENT_CAP = parseNear("5");
const RECIPIENT_USED = parseNear("1");
const AGENT_USED = parseNear("3");
const AVAILABLE_BALANCE = parseNear("20");

export function PaymentPolicyPreview() {
  return (
    <section className="preview" aria-labelledby="preview-agent">
      <div className="preview-head">
        <h2 id="preview-agent">market-agent</h2>
        <div className="preview-budget">
          <strong>{near(AGENT_DAILY_CAP)}/day</strong>
          <small>Agent budget</small>
        </div>
      </div>
      <ul className="preview-list">
        {Object.values(MARKETS).map((market) => (
          <li key={market.name}>
            <a className="preview-market" href={market.listing} target="_blank" rel="noreferrer">
              <img src={market.icon} width={36} height={36} alt="" />
              <span>
                <strong>{market.name} <ExternalLink size={11} aria-hidden="true" /></strong>
                <small>
                  {market.limits
                    ? `${near(market.limits.perPayment)} per payment · ${near(market.limits.daily)}/day`
                    : "Recipient not approved"}
                </small>
              </span>
            </a>
            {market.limits ? (
              <span className="preview-decision enabled"><Check size={14} aria-hidden="true" /> Enabled</span>
            ) : (
              <span className="preview-decision blocked"><CircleSlash size={13} aria-hidden="true" /> Blocked</span>
            )}
          </li>
        ))}
      </ul>
      <a className="preview-link" href="#payment-walkthrough">
        Follow a payment <ArrowDownRight size={15} aria-hidden="true" />
      </a>
    </section>
  );
}

export function PaymentWalkthrough() {
  const [scenario, setScenario] = useState<(typeof SCENARIOS)[number]>(SCENARIOS[0]);
  const [step, setStep] = useState(0);
  const [visible, setVisible] = useState(false);
  const [playing, setPlaying] = useState(true);
  const [pageVisible, setPageVisible] = useState(!document.hidden);
  const sectionRef = useRef<HTMLElement>(null);
  const market = MARKETS[scenario.recipient];
  const { limits } = market;
  const amount = near(scenario.amount);
  const fitsPaymentCap = Boolean(limits && scenario.amount <= limits.perPayment);
  const blockedReason = !limits ? "Recipient not approved" : !fitsPaymentCap ? "Per-payment cap exceeded" : null;
  const finalStep = STAGES.length - 1;
  const titles = ["Agent submits a request", "Registry verifies the agent", "Wallet policy checks spending rules", blockedReason ? "Payment blocked" : "Payment settled"];

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { threshold: 0.2 });
    observer.observe(section);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const update = () => setPageVisible(!document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  useEffect(() => {
    if (!visible || !pageVisible || !playing || step === finalStep) return;
    const timer = window.setTimeout(() => setStep((current) => current + 1), step === 2 ? 9000 : 6000);
    return () => window.clearTimeout(timer);
  }, [visible, pageVisible, playing, step, scenario, finalStep]);

  const rule = (label: string, detail: string, result: "pass" | "block" | "skip") => {
    const Icon = result === "pass" ? Check : result === "block" ? CircleSlash : Minus;
    return (
      <li data-result={result}>
        <Icon size={16} aria-hidden="true" />
        <span className="visually-hidden">{result === "pass" ? "Passed" : result === "block" ? "Blocked" : "Skipped"}. </span>
        <strong>{label}</strong>
        <span>{detail}</span>
      </li>
    );
  };

  return (
    <section ref={sectionRef} className="landing-section walkthrough" id="payment-walkthrough" aria-labelledby="walkthrough-title">
      <header className="section-intro">
        <h2 id="walkthrough-title">From request to receipt.</h2>
        <p className="lead">Choose a simulated payment and follow it from the agent’s request to the activity record.</p>
      </header>

      <div className="walkthrough-panel">
        <div className="walkthrough-toolbar" role="group" aria-label="Payment scenario">
          {SCENARIOS.map((option) => (
            <button key={option.label} type="button" aria-pressed={option === scenario} onClick={() => { setScenario(option); setStep(0); setPlaying(true); }}>
              {option.label}
            </button>
          ))}
        </div>

        <ol className="payment-stages" aria-label="Payment steps">
          {STAGES.map(({ label, icon: Icon }, index) => (
            <li key={label} data-complete={index < step}>
              <button type="button" aria-current={index === step ? "step" : undefined} aria-controls="payment-step-detail" onClick={() => { setStep(index); setPlaying(false); }}>
                <span className="stage-icon">{index < step ? <Check size={17} aria-hidden="true" /> : <Icon size={17} aria-hidden="true" />}</span>
                {label}
              </button>
            </li>
          ))}
        </ol>
        <div className="payment-step-detail" id="payment-step-detail" aria-live={playing ? "off" : "polite"} aria-atomic="true">
          <h3>{titles[step]}</h3>
          {step === 0 && (
            <>
              <p>The runner for <code>market-agent</code> calls the registry with the payer, the recipient, the amount, and a unique request ID.</p>
              <p className="stage-recipient"><img src={market.icon} width={24} height={24} alt="" /> {market.name} <strong>{amount}</strong></p>
            </>
          )}
          {step === 1 && (
            <>
              <p>The registry checks the caller and the agent’s permissions before forwarding the request to the policy contract on the owner’s account.</p>
              <ul className="payment-checks">
                {rule("Executor", "Matches the registered runner", "pass")}
                {rule("Agent status", "Active and unexpired", "pass")}
                {rule("Agent capability", `${amount} fits the agent’s ${near(AGENT_PAYMENT_CAP)} request ceiling`, "pass")}
              </ul>
            </>
          )}
          {step === 2 && (
            <>
              <p>The wallet policy applies the owner’s approvals and limits. This simulation starts with payments enabled and an active spending approval for the agent.</p>
              <ul className="payment-checks">
                {rule("Recipient approval", limits ? `${market.name} is approved` : `${market.name} is not on the approved list`, limits ? "pass" : "block")}
                {rule("Per-payment cap", limits ? `${amount} requested · ${near(limits.perPayment)} allowed` : "Skipped after the recipient check", limits ? (fitsPaymentCap ? "pass" : "block") : "skip")}
                {rule("Daily budgets", limits && fitsPaymentCap
                  ? `${near(RECIPIENT_USED + scenario.amount)} of ${near(limits.daily)} for the recipient · ${near(AGENT_USED + scenario.amount)} of ${near(AGENT_DAILY_CAP)} for the agent after this request`
                  : "Skipped after an earlier rule blocked the request", fitsPaymentCap ? "pass" : "skip")}
                {rule("Available balance", fitsPaymentCap ? `${near(AVAILABLE_BALANCE)} available · no account-wide cap set` : "Skipped after an earlier rule blocked the request", fitsPaymentCap ? "pass" : "skip")}
              </ul>
            </>
          )}
          {step === finalStep && (
            <>
              <p>{blockedReason
                ? "The policy rejects the request before sending a transfer and records the reason in Activity."
                : "The policy reserves the amount against the daily budgets, sends the transfer from the owner’s account, and records the settlement once the transfer succeeds."}</p>
              <p className="payment-result" data-result={blockedReason ? "block" : "pass"}>
                {blockedReason ? <CircleSlash size={17} aria-hidden="true" /> : <Check size={17} aria-hidden="true" />}
                <strong>{market.name} · {amount} {blockedReason ? "requested" : "paid"}</strong>
                <span>{blockedReason ?? "Settled"}</span>
              </p>
            </>
          )}
        </div>
        <div className="walkthrough-footer">
          <a className="text-link" href={href("/docs/activity")}>How to read payment activity <ArrowRight size={15} aria-hidden="true" /></a>
          <div className="walkthrough-actions">
            <button type="button" onClick={() => {
              if (step === finalStep) { setStep(0); setPlaying(true); }
              else setPlaying(!playing);
            }}>
              {step === finalStep ? <><RotateCcw size={15} aria-hidden="true" /> Replay</> : playing ? <><Pause size={15} aria-hidden="true" /> Pause</> : <><Play size={15} aria-hidden="true" /> Play</>}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

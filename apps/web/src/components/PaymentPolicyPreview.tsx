import { useState } from "react";
import { parseNear } from "@nearfirewall/sdk";
import { ArrowDownRight, ArrowRight, Bot, Check, CircleSlash, ExternalLink, ReceiptText, ShieldCheck } from "lucide-react";
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
  const market = MARKETS[scenario.recipient];
  const { limits } = market;
  const blockedReason = !limits
    ? "The owner has not approved this recipient."
    : scenario.amount > limits.perPayment
      ? `The request exceeds this recipient’s ${near(limits.perPayment)} per-payment cap.`
      : null;

  return (
    <section className="landing-section walkthrough" id="payment-walkthrough" aria-labelledby="walkthrough-title">
      <header className="section-intro">
        <h2 id="walkthrough-title">From request to receipt.</h2>
        <p className="lead">Choose a preset to see how your account policy handles the agent’s request.</p>
      </header>

      <div className="walkthrough-panel">
        <div className="walkthrough-toolbar" role="group" aria-label="Payment scenario">
          {SCENARIOS.map((option) => (
            <button key={option.label} type="button" aria-pressed={option === scenario} onClick={() => setScenario(option)}>
              {option.label}
            </button>
          ))}
        </div>

        <ol className="payment-stages" aria-live="polite">
          <li>
            <span className="stage-icon"><Bot size={19} aria-hidden="true" /></span>
            <h3>Agent requests payment</h3>
            <p className="stage-recipient"><img src={market.icon} width={21} height={21} alt="" /> {market.name}</p>
            <p><strong>{near(scenario.amount)}</strong> requested by <code>market-agent</code>.</p>
          </li>
          <li>
            <span className="stage-icon"><ShieldCheck size={19} aria-hidden="true" /></span>
            <h3>Account checks the rules</h3>
            <p>{blockedReason ?? (limits && `Recipient approved. ${near(scenario.amount)} fits the ${near(limits.perPayment)} per-payment cap.`)}</p>
            {limits && <p className="stage-meta">{near(limits.daily)}/day for this recipient · {near(AGENT_DAILY_CAP)}/day for the agent</p>}
          </li>
          <li>
            <span className={`stage-icon ${blockedReason ? "blocked" : "enabled"}`}>
              {blockedReason ? <CircleSlash size={19} aria-hidden="true" /> : <ReceiptText size={19} aria-hidden="true" />}
            </span>
            <h3>{blockedReason ? "Transfer blocked" : "Transfer can proceed"}</h3>
            <p>{blockedReason
              ? "The account stops the request before funds move. Activity shows the rule that blocked it."
              : "With daily budget and balance available, the account sends the transfer and records the settlement."}</p>
          </li>
        </ol>
        <a className="walkthrough-docs text-link" href={href("/docs/activity")}>How to read payment activity <ArrowRight size={15} aria-hidden="true" /></a>
      </div>
    </section>
  );
}

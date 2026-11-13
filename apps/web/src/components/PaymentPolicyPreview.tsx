import { parseNear } from "@nearfirewall/sdk";
import { ArrowDownRight, Check, CircleSlash, ExternalLink } from "lucide-react";
import { near } from "../format.ts";

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
        Try a payment <ArrowDownRight size={15} aria-hidden="true" />
      </a>
    </section>
  );
}

import { ArrowDown, ArrowRight, Bot, Check, CircleSlash, Gauge, GitBranch, KeyRound, ListChecks, ShieldCheck, Wallet } from "lucide-react";
import { Topbar } from "../components/Topbar.tsx";
import { href } from "../router.ts";

const STEPS = [
  { icon: Wallet, title: "Connect your wallet", text: "Use Meteor or another NEAR wallet. Keep your existing address and balance." },
  { icon: Bot, title: "Register an agent", text: "Give the agent a handle and link its executor account." },
  { icon: ShieldCheck, title: "Enable payments", text: "Install the policy on your account so it can enforce your rules on-chain." },
  { icon: Gauge, title: "Approve recipients", text: "Set a limit per payment and per day, plus an overall budget for the agent." },
];

const CONTROLS = [
  { icon: Gauge, title: "Recipient limits", text: "Approve who gets paid and set their limits. The agent can pay automatically within those limits." },
  { icon: GitBranch, title: "Agent trees", text: "Delegate to child agents with narrower permissions. Pause an agent, a whole branch, or all account payments." },
  { icon: KeyRound, title: "Wallet and agent ownership", text: "Your keys stay in your wallet. You own each agent as an NFT, and a transfer invalidates the previous owner’s payment approvals." },
  { icon: ListChecks, title: "On-chain activity", text: "See settled, blocked, and failed attempts with the reason for each outcome." },
];

export function Landing() {
  return (
    <div className="landing">
      <Topbar current="home" />
      <main>
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-art" aria-hidden="true" />
          <div className="hero-inner">
            <div className="hero-copy">
              <span className="eyebrow"><i /> On-chain spending controls</span>
              <h1 id="hero-title">Let agents pay.<br /><span>Keep the keys.</span></h1>
              <p className="lead">Give agents a budget from your existing NEAR account. You choose who they can pay and how much. NEARFirewall enforces the rules on-chain.</p>
              <div className="cta-row">
                <a className="btn primary" href={href("/app/agents")}>Launch app <ArrowRight size={16} /></a>
                <a className="text-link" href={href("/docs")}>Read the docs <ArrowRight size={15} /></a>
              </div>
            </div>

            <div className="preview">
              <div className="preview-head">
                <div>
                  <span className="eyebrow">Example activity</span>
                  <h2>market-agent</h2>
                </div>
                <span className="preview-status"><i /> Payments on</span>
              </div>
              <ul className="preview-list">
                <li>
                  <Check className="preview-icon settled" size={19} aria-hidden="true" />
                  <div><strong>vendor.testnet</strong><small>Settled</small></div>
                  <span className="mono">2.00 NEAR</span>
                </li>
                <li>
                  <CircleSlash className="preview-icon blocked" size={18} aria-hidden="true" />
                  <div><strong>vendor.testnet</strong><small>Blocked · 3 NEAR limit</small></div>
                  <span className="mono">4.00 NEAR</span>
                </li>
              </ul>
            </div>

            <a className="hero-guide text-link" href="#how-it-works"><ArrowDown size={15} /> How it works</a>
          </div>
        </section>

        <section className="landing-section" id="how-it-works" aria-labelledby="steps-title">
          <h2 id="steps-title">Set up an agent</h2>
          <ol className="steps">
            {STEPS.map(({ icon: Icon, title, text }) => (
              <li key={title}>
                <Icon size={24} aria-hidden="true" />
                <h3>{title}</h3>
                <p>{text}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="landing-section safeguards" aria-labelledby="controls-title">
          <div>
            <h2 id="controls-title">On-chain safeguards</h2>
            <a className="text-link" href={href("/docs/safety")}>Read the security guide <ArrowRight size={15} /></a>
          </div>
          <ul className="control-list">
            {CONTROLS.map(({ icon: Icon, title, text }) => (
              <li key={title}>
                <Icon size={20} aria-hidden="true" />
                <div><h3>{title}</h3><p>{text}</p></div>
              </li>
            ))}
          </ul>
        </section>
      </main>

      <footer className="footer">
        <span>NEARFirewall</span>
        <span>Built on NEAR Testnet</span>
      </footer>
    </div>
  );
}

import { ArrowDown, ArrowRight, Plus, ShieldCheck } from "lucide-react";
import { PaymentDemo } from "../components/PaymentDemo.tsx";
import { PaymentPolicyPreview } from "../components/PaymentPolicyPreview.tsx";
import { Topbar } from "../components/Topbar.tsx";
import { WalletEntry } from "../components/WalletEntry.tsx";
import { config } from "../config.ts";
import { href } from "../router.ts";

const STEPS = [
  { title: "Connect your wallet", text: "Choose an available NEAR wallet for your network. Keep your existing address and balance." },
  { title: "Register an agent", text: "Give the agent a handle and a payment ceiling in your registry." },
  { title: "Enable payments", text: "Install the policy on your account so it can enforce your rules on-chain." },
  { title: "Approve recipients and connect", text: "Set the spending limits and connect the agent with a restricted key." },
];

const INTEGRATIONS = [
  { name: "Claude Desktop", icon: "claude.svg", position: "chat" },
  { name: "Claude Code", icon: "claude-code.svg", position: "code" },
  { name: "Cursor", icon: "cursor.svg", position: "runner" },
  { name: "Meteor Wallet", icon: "meteor.svg", position: "workflow" },
  { name: "Intear Wallet", icon: "intear.svg", position: "paid" },
  { name: "NEAR Mobile", icon: "near-mobile.webp", position: "blocked" },
];

const QUESTIONS = [
  { question: "Do I approve every payment?", answer: "Payments within your limits can settle automatically. Set an Ask me first threshold to confirm larger eligible requests in your wallet." },
  { question: "Who decides whether a payment goes through?", answer: "The registry checks the agent and its capabilities. Your account policy checks the recipient, limits, balance, and pause state before sending NEAR." },
  { question: "Can I stop an agent from paying?", answer: "You can pause payments, remove a recipient, or revoke a mandate. The next request checked by your account uses the updated policy. A transfer already dispatched can still settle." },
  { question: "Where do my funds stay?", answer: "Payments come directly from the existing NEAR account you connected. That account runs the payment policy and transfers funds when the checks pass." },
];

export function Landing() {
  return (
    <div className="landing">
      <Topbar />
      <main>
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-art" aria-hidden="true" />
          <div className="hero-inner">
            <div className="hero-copy">
              <div className="hero-eyebrow">
                <span>On-chain spending controls</span>
                <span className="hero-network"><i aria-hidden="true" />{config.network}</span>
              </div>
              <h1 id="hero-title">Let agents pay.<br /><span>Keep the keys.</span></h1>
              <p className="lead">Give agents a budget from your existing NEAR account. You choose who they can pay and how much. NEARFirewall enforces the rules on-chain.</p>
              <div className="cta-row">
                <WalletEntry placement="landing" />
                <a className="text-link" href={href("/docs")}>Read the docs <ArrowRight size={15} /></a>
              </div>
            </div>

            <PaymentPolicyPreview />

            <a className="hero-guide text-link" href="#how-it-works"><ArrowDown size={15} /> How it works</a>
          </div>
        </section>

        <section className="landing-section safeguards" id="how-it-works" aria-labelledby="controls-title">
          <div className="platform-showcase">
            <ul className="showcase-tiles" aria-label="Example agent apps and NEAR wallets">
              {INTEGRATIONS.map(({ name, icon, position }) => (
                <li key={name} className={`platform-tile tile-${position}`}><img src={`/integrations/${icon}`} width={26} height={26} alt="" /> {name}</li>
              ))}
              <li className="platform-tile tile-budget"><ShieldCheck size={20} aria-hidden="true" /> 10 NEAR daily cap</li>
            </ul>
            <header className="platform-copy">
              <h2 id="controls-title">Your agents.<br />Your rules.</h2>
              <p className="lead">Connect a local MCP client or custom runner. Choose a NEAR wallet from the options available for your network.</p>
              <a className="text-link" href="#payment-walkthrough">Try it here <ArrowDown size={16} aria-hidden="true" /></a>
            </header>
          </div>
        </section>

        <PaymentDemo />

        <section className="landing-section setup" aria-labelledby="steps-title">
          <div>
            <h2 id="steps-title">Set up an agent on NEAR.</h2>
            <p className="lead">Connect your wallet and choose the first recipient your agent may pay.</p>
            <a className="text-link" href={href("/docs/getting-started")}>Getting started guide <ArrowRight size={15} aria-hidden="true" /></a>
          </div>
          <ol className="steps">
            {STEPS.map(({ title, text }) => (
              <li key={title}>
                <div><h3>{title}</h3><p>{text}</p></div>
              </li>
            ))}
          </ol>
        </section>

        <section className="landing-section landing-faq" aria-labelledby="faq-title">
          <header className="section-intro"><h2 id="faq-title">Questions about agent payments</h2></header>
          <div className="faq-list">
            {QUESTIONS.map(({ question, answer }) => (
              <details key={question} name="landing-faq">
                <summary>{question} <Plus size={17} aria-hidden="true" /></summary>
                <p>{answer}</p>
              </details>
            ))}
          </div>
        </section>

      </main>
    </div>
  );
}

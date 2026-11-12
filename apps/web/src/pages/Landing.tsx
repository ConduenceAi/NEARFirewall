import { ArrowDown, ArrowRight, Bot, Gauge, GitBranch, KeyRound, Plus, ShieldCheck, Wallet } from "lucide-react";
import { PaymentPolicyPreview, PaymentWalkthrough } from "../components/PaymentPolicyPreview.tsx";
import { Topbar } from "../components/Topbar.tsx";
import { href } from "../router.ts";
import { useWallet } from "../wallet.tsx";

const STEPS = [
  { icon: Wallet, title: "Connect your wallet", text: "Use Meteor or another NEAR wallet. Keep your existing address and balance." },
  { icon: Bot, title: "Register an agent", text: "Give the agent a handle and link its executor account." },
  { icon: ShieldCheck, title: "Enable payments", text: "Install the policy on your account so it can enforce your rules on-chain." },
  { icon: Gauge, title: "Approve recipients", text: "Set a limit per payment and per day, plus an overall budget for the agent." },
];

const CONTROLS = [
  { icon: Gauge, title: "Limits per recipient", text: "Set a per-payment cap and daily cap for each recipient, inside an overall budget for the agent." },
  { icon: GitBranch, title: "Control each agent", text: "Give child agents narrower permissions. Pause one agent, its entire branch, or all agent payments from your account." },
  { icon: KeyRound, title: "Owner-controlled access", text: "Your keys stay in your wallet. Transferring an agent NFT invalidates the previous owner’s payment approvals." },
];

const QUESTIONS = [
  { question: "Do I approve every payment?", answer: "You sign to approve a recipient and set its limits. After setup, an agent can make payments automatically when the recipient and amount fit the policy." },
  { question: "Who decides whether a payment goes through?", answer: "The registry authenticates the executor. The policy on your NEAR account checks the recipient, caps, remaining budget, balance, and pause state before dispatching a transfer." },
  { question: "Can I stop an agent from paying?", answer: "You can pause payments, remove a recipient, or revoke a mandate. The next request checked by your account uses the updated policy. A transfer already dispatched can still settle." },
  { question: "Where do my funds stay?", answer: "Payments come directly from the existing NEAR account you connected. That account runs the payment policy and transfers funds when the checks pass." },
];

export function Landing() {
  const { accountId } = useWallet();
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
                <a className="btn primary" href={href("/app/map")}>{accountId ? "Open dashboard" : "Launch app"} <ArrowRight size={16} /></a>
                <a className="text-link" href={href("/docs")}>Read the docs <ArrowRight size={15} /></a>
              </div>
            </div>

            <PaymentPolicyPreview />

            <a className="hero-guide text-link" href="#how-it-works"><ArrowDown size={15} /> How it works</a>
          </div>
        </section>

        <section className="landing-section safeguards" id="how-it-works" aria-labelledby="controls-title">
          <header className="section-intro">
            <h2 id="controls-title">You set the spending rules.</h2>
            <p className="lead">Agents submit requests. The policy on your NEAR account decides what can be paid.</p>
          </header>
          <ul className="control-list">
            {CONTROLS.map(({ icon: Icon, title, text }) => (
              <li key={title}>
                <Icon size={20} aria-hidden="true" />
                <h3>{title}</h3>
                <p>{text}</p>
              </li>
            ))}
          </ul>
        </section>

        <PaymentWalkthrough />

        <section className="landing-section setup" aria-labelledby="steps-title">
          <div>
            <h2 id="steps-title">Set up an agent on NEAR.</h2>
            <p className="lead">Connect your wallet and choose the first recipient your agent may pay.</p>
            <a className="text-link" href={href("/docs/getting-started")}>Getting started guide <ArrowRight size={15} aria-hidden="true" /></a>
          </div>
          <ol className="steps">
            {STEPS.map(({ icon: Icon, title, text }) => (
              <li key={title}>
                <Icon size={21} aria-hidden="true" />
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

        <section className="landing-section launch-strip" aria-labelledby="launch-title">
          <h2 id="launch-title">Put your first agent on a budget.</h2>
          <a className="btn primary" href={href("/app/map")}>{accountId ? "Open dashboard" : "Launch app"} <ArrowRight size={16} aria-hidden="true" /></a>
        </section>
      </main>

      <footer className="footer">
        <span>NEARFirewall</span>
        <span>Built on NEAR Testnet</span>
      </footer>
    </div>
  );
}

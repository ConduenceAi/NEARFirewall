import { ArrowRight, BookOpen, Ban, Gauge, GitBranch, KeyRound, ShieldCheck, Wallet, Bot, Users } from "lucide-react";
import { Topbar } from "../components/Topbar.tsx";
import { SpotCard } from "../components/Brand.tsx";
import { href } from "../router.ts";

const STEPS = [
  { icon: Wallet, tone: "lime", title: "Connect your wallet", text: "Sign in with Meteor or any NEAR wallet. Your account keeps its address and its funds." },
  { icon: Bot, tone: "sky", title: "Register an agent", text: "Give the agent a handle and a separate executor account. It is minted to you as an NFT, so you own it." },
  { icon: ShieldCheck, tone: "coral", title: "Enable payments", text: "Install the payment policy on your account once. It pays directly from the account that already holds the funds." },
  { icon: Gauge, tone: "lime", title: "Approve recipients", text: "Set a per-payment and daily limit for each recipient, plus a daily budget for the agent." },
] as const;

const MARQUEE = [
  "per-recipient limits",
  "daily budgets",
  "pause in one click",
  "agent trees",
  "non-transferable locks",
  "on-chain activity log",
  "no custody",
  "no backend",
];

export function Landing() {
  return (
    <div className="landing">
      <Topbar current="home" />

      <section className="hero">
        <div className="hero-bg" />
        <div className="hero-grid" />
        <div className="hero-inner">
          <div>
            <span className="eyebrow">
              <i /> Built on NEAR
            </span>
            <h1>
              Let agents pay. <span className="shiny">Keep the keys.</span>
            </h1>
            <p className="lead">
              NEARFirewall lets an AI agent spend from your existing NEAR account, but only to the recipients you approve, and only
              up to the limits you set. Everything that fits the rules pays automatically. Everything else is blocked and logged.
            </p>
            <div className="cta-row">
              <a className="btn primary" href={href("/app/agents")}>
                Launch app <ArrowRight size={16} />
              </a>
              <a className="btn" href={href("/docs")}>
                <BookOpen size={16} /> Read the docs
              </a>
            </div>
            <div className="stats">
              <div>
                <strong>0</strong>
                <span>funds moved to a custodian</span>
              </div>
              <div>
                <strong>1 tx</strong>
                <span>to approve a recipient</span>
              </div>
              <div>
                <strong>100%</strong>
                <span>of attempts logged on chain</span>
              </div>
            </div>
          </div>

          <div className="board" aria-hidden="true">
            <div className="board-head">
              <span>market-agent</span>
              <span className="badge active">Payments on</span>
            </div>
            <div className="board-cols">
              <div className="board-col">
                <h4>Paid</h4>
                <div className="mini">
                  <span className="tag lime">Settled</span>
                  Pay vendor.testnet
                  <small>2 NEAR</small>
                </div>
                <div className="mini">
                  <span className="tag lime">Settled</span>
                  Pay ads.testnet
                  <small>0.5 NEAR</small>
                </div>
              </div>
              <div className="board-col">
                <h4>Blocked</h4>
                <div className="mini">
                  <span className="tag coral">Over limit</span>
                  Pay vendor.testnet
                  <small>4 NEAR &gt; 3 cap</small>
                </div>
                <div className="mini">
                  <span className="tag coral">Unknown</span>
                  Pay new.testnet
                  <small>not approved</small>
                </div>
              </div>
              <div className="board-col">
                <h4>Your move</h4>
                <div className="mini">
                  <span className="tag sky">Review</span>
                  Approve new.testnet?
                  <small>set limits</small>
                </div>
                <div className="mini">
                  <span className="tag sky">Paused</span>
                  bot-2.market-agent
                  <small>branch paused</small>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <div className="marquee" aria-hidden="true">
        <div className="marquee-track">
          {[...MARQUEE, ...MARQUEE, ...MARQUEE, ...MARQUEE].map((m, i) => (
            <span key={i}>◆ {m}</span>
          ))}
        </div>
      </div>

      <section>
        <div className="section-head">
          <span className="eyebrow">How it works</span>
          <h2>Four steps from zero to an agent that can pay</h2>
          <p className="lead">Each step is one wallet signature. You can see and undo every one of them.</p>
        </div>
        <div className="steps">
          {STEPS.map((s, i) => (
            <SpotCard key={s.title}>
              <span className={`ico ${s.tone}`}>
                <s.icon size={20} />
              </span>
              <h3>
                <span className="step-num">0{i + 1} </span>
                {s.title}
              </h3>
              <p>{s.text}</p>
            </SpotCard>
          ))}
        </div>
      </section>

      <section>
        <div className="section-head">
          <span className="eyebrow">Why it is safe</span>
          <h2>Rules the agent cannot talk its way around</h2>
          <p className="lead">The limits are enforced by contracts on NEAR, not by the agent and not by a server.</p>
        </div>
        <div className="bento">
          <SpotCard>
            <span className="ico lime">
              <Gauge size={20} />
            </span>
            <h3>Limits per recipient</h3>
            <p>
              Allow <code>vendor.testnet</code> up to 3 NEAR per payment and 6 NEAR per day, inside a 10 NEAR daily budget for
              the agent. A 4 NEAR request is refused. A payment to a stranger is refused.
            </p>
            <div className="flow">
              <span className="node">agent</span>
              <span className="arrow">→</span>
              <span className="node sky">registry</span>
              <span className="arrow">→</span>
              <span className="node lime">your account policy</span>
              <span className="arrow">→</span>
              <span className="node">approved recipient</span>
            </div>
          </SpotCard>
          <SpotCard>
            <span className="ico coral">
              <Ban size={20} />
            </span>
            <h3>Pause instantly</h3>
            <p>Pause one agent, a whole branch, or every payment from your account. The next attempt is blocked.</p>
          </SpotCard>
          <SpotCard>
            <span className="ico sky">
              <GitBranch size={20} />
            </span>
            <h3>Agent trees</h3>
            <p>Create leaf agents under an agent. Children can only narrow their parent's rules, never widen them.</p>
          </SpotCard>
          <SpotCard>
            <span className="ico lime">
              <KeyRound size={20} />
            </span>
            <h3>You hold the keys</h3>
            <p>The agent's key can only call the registry. It cannot touch your account, your keys or your funds directly.</p>
          </SpotCard>
          <SpotCard>
            <span className="ico coral">
              <Users size={20} />
            </span>
            <h3>Agent as an NFT</h3>
            <p>Ownership is a standard NEAR token. Transfer it and every old approval stops working, so a new holder starts at zero.</p>
          </SpotCard>
          <SpotCard>
            <h3>Every attempt leaves a trace</h3>
            <p>
              Paid, blocked and failed requests are stored in bounded logs on chain, with a plain-language reason. Filter them in
              the app. No indexer or backend is involved.
            </p>
          </SpotCard>
        </div>
      </section>

      <section className="cta">
        <div className="box">
          <h2>
            Ready to give an agent a <span className="shiny">budget?</span>
          </h2>
          <p className="lead" style={{ margin: "0 auto" }}>
            Connect a wallet, register your first agent and approve a recipient in a few minutes.
          </p>
          <div className="cta-row">
            <a className="btn primary" href={href("/app/agents")}>
              Launch app <ArrowRight size={16} />
            </a>
            <a className="btn" href={href("/docs/getting-started")}>
              Getting started guide
            </a>
          </div>
        </div>
      </section>

      <footer className="footer">
        <span>NEARFirewall</span>
        <span>Hackathon build on NEAR Testnet</span>
      </footer>
    </div>
  );
}

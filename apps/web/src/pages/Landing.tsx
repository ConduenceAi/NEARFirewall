import { ArrowDown, ArrowRight, Code2, KeyRound, Users, Wallet } from "lucide-react";
import { PaymentDemo } from "../components/PaymentDemo.tsx";
import { Topbar } from "../components/Topbar.tsx";
import { href } from "../router.ts";

export function Landing() {
  return (
    <div className="landing">
      <Topbar />
      <main>
        <section className="hero company-hero" aria-labelledby="hero-title">
          <div className="hero-art" aria-hidden="true" />
          <div className="hero-inner">
            <div className="hero-copy">
              <h1 id="hero-title">Let agents pay.<br /><span>Keep the keys.</span></h1>
              <p className="lead">When agents handle subscriptions and payroll, signing every payment slows the team down. Giving them full wallet access puts more money in reach than the job requires.</p>
              <div className="cta-row">
                <a className="primary text-link" href="#payment-walkthrough">Try it <ArrowDown size={16} aria-hidden="true" /></a>
                <a className="text-link" href={href("/docs")}>Read the docs <ArrowRight size={15} aria-hidden="true" /></a>
              </div>
            </div>

            <figure className="company-map" aria-label="One company wallet delegates payments to two departments">
              <div className="company-wallet">
                <Wallet size={21} aria-hidden="true" />
                <div><strong>Company wallet</strong><code>company.near</code></div>
              </div>
              <div className="company-branches">
                <div><Code2 size={19} aria-hidden="true" /><strong>Engineering</strong><code>engineering.company.near</code><small>Approved subscriptions</small></div>
                <div><Users size={19} aria-hidden="true" /><strong>HR</strong><code>hr.company.near</code><small>Weekly and monthly payroll</small></div>
              </div>
              <figcaption><KeyRound size={15} aria-hidden="true" /> Each agent gets a restricted key.</figcaption>
            </figure>
          </div>
        </section>

        <section className="landing-section department-section" id="how-it-works" aria-labelledby="departments-title">
          <header className="section-intro">
            <h2 id="departments-title">One wallet. Two sets of rules.</h2>
            <p className="lead">Keep your existing NEAR account. Set spending limits by department and verify delegated payments on-chain.</p>
          </header>
          <div className="department-grid">
            <article>
              <Code2 size={24} aria-hidden="true" />
              <h3>Engineering renews subscriptions</h3>
              <p>The agent pays approved vendors within their limits. The owner steps in when a new vendor needs approval.</p>
            </article>
            <article>
              <Users size={24} aria-hidden="true" />
              <h3>HR runs payroll</h3>
              <p>Each role has a rate and a weekly or monthly schedule. The owner approves new employees once, then HR can run their scheduled payments.</p>
            </article>
          </div>
        </section>

        <PaymentDemo />
      </main>
    </div>
  );
}

import { useEffect, useState, type ReactNode } from "react";
import { Info, Lightbulb, TriangleAlert } from "lucide-react";
import { Topbar } from "../components/Topbar.tsx";
import { REASON_GROUPS } from "../reasonGroups.ts";
import { href } from "../router.ts";

interface Section {
  id: string;
  title: string;
  sub?: boolean;
}

const TOC: Section[] = [
  { id: "overview", title: "Overview" },
  { id: "concepts", title: "Key ideas" },
  { id: "getting-started", title: "Getting started" },
  { id: "connect", title: "1. Connect a wallet", sub: true },
  { id: "register", title: "2. Register an agent", sub: true },
  { id: "enable", title: "3. Enable payments", sub: true },
  { id: "approve", title: "4. Approve recipients", sub: true },
  { id: "run", title: "5. Run the agent", sub: true },
  { id: "managing", title: "Managing agents" },
  { id: "tree", title: "Agent trees", sub: true },
  { id: "pause", title: "Pause, resume, remove", sub: true },
  { id: "locks", title: "Locks and transfers", sub: true },
  { id: "records", title: "Records", sub: true },
  { id: "activity", title: "Reading activity" },
  { id: "reasons", title: "Why a payment was blocked" },
  { id: "safety", title: "What can and cannot go wrong" },
  { id: "faq", title: "FAQ" },
];

function Callout({ kind, children }: { kind: "tip" | "note" | "warn"; children: ReactNode }) {
  const Icon = kind === "tip" ? Lightbulb : kind === "warn" ? TriangleAlert : Info;
  return (
    <div className={`callout ${kind}`}>
      <Icon size={18} className="icon" style={{ marginTop: 3 }} />
      <div>{children}</div>
    </div>
  );
}

export function Docs({ section }: { section?: string }) {
  const [current, setCurrent] = useState(section ?? "overview");

  useEffect(() => {
    if (!section) return;
    document.getElementById(section)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [section]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setCurrent(visible[0].target.id);
      },
      { rootMargin: "-80px 0px -65% 0px" },
    );
    TOC.forEach((s) => {
      const el = document.getElementById(s.id);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <Topbar current="docs" />
      <div className="docs-wrap">
        <nav className="toc" aria-label="On this page">
          {TOC.map((s) => (
            <a key={s.id} href={href(`/docs/${s.id}`)} className={`${s.sub ? "sub" : ""} ${current === s.id ? "current" : ""}`}>
              {s.title}
            </a>
          ))}
        </nav>

        <article className="doc">
          <h1>NEARFirewall documentation</h1>
          <p className="lead">Everything you need to let an agent pay from your NEAR account safely, from the first click to day-to-day control.</p>

          <h2 id="overview">Overview</h2>
          <p>
            NEARFirewall is a spending policy for AI agents. You keep your normal NEAR account. You register an agent, say who it may
            pay and how much, and the agent can then make those payments on its own. Anything outside the rules is refused before any
            money moves, and every attempt is recorded.
          </p>
          <p>There are three pieces, and you only ever use the first one:</p>
          <ul>
            <li>
              <strong>The NEARFirewall app</strong> (this site). You use it to register agents, enable payments, set limits, pause, and
              read the activity.
            </li>
            <li>
              <strong>The registry</strong>, a shared contract. It knows every agent, who owns it, and which account is allowed to act for
              it.
            </li>
            <li>
              <strong>Your account policy</strong>, a contract installed on your own account. It holds your approvals and limits and sends
              the payment itself.
            </li>
          </ul>
          <p>
            The agent itself runs somewhere else (your server, a laptop, a cloud function) using a restricted key. That key can submit
            payment requests and nothing else.
          </p>

          <h2 id="concepts">Key ideas</h2>
          <table>
            <thead>
              <tr>
                <th>Term</th>
                <th>What it means for you</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <strong>Owner</strong>
                </td>
                <td>You. The account that holds the agent's NFT and whose funds the agent spends. Only you can approve spending.</td>
              </tr>
              <tr>
                <td>
                  <strong>Agent</strong>
                </td>
                <td>A named identity (its handle, for example <code>market-agent</code>) minted to you as an NFT.</td>
              </tr>
              <tr>
                <td>
                  <strong>Executor</strong>
                </td>
                <td>
                  A separate NEAR account that acts for the agent. Its only key can call the registry's <code>execute</code> method, so it
                  cannot touch your account directly.
                </td>
              </tr>
              <tr>
                <td>
                  <strong>Capability</strong>
                </td>
                <td>What the agent is allowed to ask for at all, for example "transfer NEAR, up to 3 NEAR per payment".</td>
              </tr>
              <tr>
                <td>
                  <strong>Approval (mandate)</strong>
                </td>
                <td>Your permission, stored on your account, for the agent to pay from it. It has a daily budget across all recipients.</td>
              </tr>
              <tr>
                <td>
                  <strong>Recipient limit</strong>
                </td>
                <td>For each approved recipient: a maximum per payment and a maximum per UTC day.</td>
              </tr>
              <tr>
                <td>
                  <strong>Account daily cap</strong>
                </td>
                <td>An optional ceiling across all agents together.</td>
              </tr>
            </tbody>
          </table>
          <Callout kind="note">
            <p>
              A payment must satisfy <em>every</em> layer: the agent's capability, your approval, the recipient's limits, the agent's daily
              budget, the optional account cap, and your available balance. The tightest rule wins.
            </p>
          </Callout>

          <h2 id="getting-started">Getting started</h2>
          <p>You need a NEAR account with some balance (Testnet for now), and a second account to act as the agent's executor.</p>

          <h3 id="connect">1. Connect a wallet</h3>
          <ol>
            <li>
              Select <strong>Launch app</strong>, then <strong>Connect wallet</strong>.
            </li>
            <li>Pick Meteor or another NEAR wallet and approve the connection.</li>
            <li>
              Your account appears at the bottom of the left sidebar and the menu (<strong>Agents</strong>, <strong>Payments</strong>,{" "}
              <strong>Activity</strong>) unlocks.
            </li>
          </ol>
          <Callout kind="tip">
            <p>
              Every change you make asks your wallet to confirm a transaction with a 1 yoctoNEAR deposit. That tiny deposit forces the
              wallet to ask you, so nothing happens behind your back. The app never adds a function-call key to your account.
            </p>
          </Callout>

          <h3 id="register">2. Register an agent</h3>
          <ol>
            <li>
              Open <strong>Agents</strong> and scroll to <strong>Register an agent</strong>.
            </li>
            <li>
              Choose a unique <strong>handle</strong>, for example <code>market-agent</code>. Handles cannot be reused.
            </li>
            <li>
              Enter the <strong>executor account</strong>, the separate NEAR account the agent sends requests from. The form checks
              that it exists on the current network and links to its NearBlocks record.
            </li>
            <li>
              Set the <strong>max per payment</strong> capability. This is the agent's own ceiling, whatever you approve later.
            </li>
            <li>Optionally choose an expiry date, hour, and minute in your device's time zone and add a public description.</li>
            <li>
              Optionally tick <strong>Non-transferable</strong> or <strong>Capabilities can only narrow</strong>. Both are permanent. See{" "}
              <a href={href("/docs/locks")}>Locks and transfers</a>.
            </li>
            <li>Select <strong>Register</strong> and confirm in your wallet.</li>
          </ol>
          <p>The agent appears in your list and the NFT is in your account.</p>
          <Callout kind="note">
            <p>
              The executor needs a function-call key limited to <code>execute</code> on the registry, with no deposit. The agent runner
              holds that key. See <a href={href("/docs/run")}>Run the agent</a>.
            </p>
          </Callout>

          <h3 id="enable">3. Enable payments on your account</h3>
          <ol>
            <li>
              Open <strong>Payments</strong>.
            </li>
            <li>
              Optionally enter an <strong>account-wide daily cap</strong> across all agents.
            </li>
            <li>
              Select <strong>Enable payments</strong> and confirm. This installs the payment policy on your account and links it to the
              registry.
            </li>
          </ol>
          <p>
            Your address, balance and keys stay exactly the same. You only do this once per account. If the policy is stored directly on
            your account, a small part of your balance is locked to pay for its storage.
          </p>
          <Callout kind="warn">
            <p>
              If your account already runs a different contract, the app refuses to overwrite it. Use an account without a contract, or a
              fresh sub-account.
            </p>
          </Callout>

          <h3 id="approve">4. Approve recipients</h3>
          <ol>
            <li>
              In <strong>Payments</strong>, open <strong>Approve vendors</strong>.
            </li>
            <li>Type the agent's handle. Tick "already registered" if you registered it in step 2.</li>
            <li>
              Set the <strong>daily budget</strong> for the agent across all recipients.
            </li>
            <li>
              Add one row per recipient: the account, the <strong>per-payment</strong> limit and the <strong>per-day</strong> limit.
            </li>
            <li>
              Select <strong>Review</strong>. The app checks the plan and lists any problems, for example a recipient limit above the
              agent's own capability.
            </li>
            <li>Sign each step in your wallet. The plan shows which steps are done.</li>
          </ol>
          <p>
            Approvals last until you remove them or they expire. You can change a recipient's limits at any time by approving it again.
            Usage already counted today is kept.
          </p>

          <h3 id="run">5. Run the agent</h3>
          <p>
            The agent submits a typed payment request through its executor account. The registry checks that the request comes from the
            right executor, that the agent is active, unexpired and allowed to ask for this, and then forwards it to your account. Your
            account checks your limits independently and pays if everything passes.
          </p>
          <p>
            For a demo, the repository ships a runner that replays scenario files. Preview first (it only reads, no money moves), then
            run:
          </p>
          <pre>{`npm run runner -- apps/runner/scenarios/tree-1-leaf-pays.json --preview
npm run runner -- apps/runner/scenarios/tree-1-leaf-pays.json`}</pre>
          <p>
            A production agent uses the SDK's executor client with the same restricted key. The key is read from the environment and never
            printed or stored by NEARFirewall.
          </p>

          <h2 id="managing">Managing agents</h2>

          <h3 id="tree">Agent trees</h3>
          <p>
            Select <strong>Add leaf agent</strong> on an agent to create a child. Give it a label, its own executor and a max per payment.
            The child is named <code>label.parent</code>, inherits the parent's expiry, and is owned by you.
          </p>
          <ul>
            <li>A child can only narrow its parent: lower caps, fewer actions, earlier expiry. Never wider.</li>
            <li>Narrowing or pausing a parent applies to the whole branch on the next attempt.</li>
            <li>Trees can be up to 8 levels deep. A node cannot be moved. To move one, create a new agent under the new parent.</li>
            <li>
              A payment approval can sit on a parent and covers the children under it, or on a single leaf for tighter control.
            </li>
          </ul>

          <h3 id="pause">Pause, resume, remove</h3>
          <table>
            <thead>
              <tr>
                <th>Action</th>
                <th>Where</th>
                <th>Effect</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Pause branch</td>
                <td>Agents</td>
                <td>The agent and everything below it is blocked. Resume turns it back on.</td>
              </tr>
              <tr>
                <td>Pause all agent payments</td>
                <td>Payments</td>
                <td>Your account refuses every agent payment. The emergency stop.</td>
              </tr>
              <tr>
                <td>Revoke</td>
                <td>Payments, on an agent's approval</td>
                <td>Removes that agent's permission to spend from your account.</td>
              </tr>
              <tr>
                <td>Remove recipient</td>
                <td>Payments, on an agent's approval</td>
                <td>That recipient is no longer approved. Its usage for the day is preserved if you re-add it.</td>
              </tr>
              <tr>
                <td>Remove agent</td>
                <td>Agents</td>
                <td>Burns the agent's NFT and stops every agent below it. Permanent.</td>
              </tr>
            </tbody>
          </table>
          <p>The agent always uses the current policy. There is no cache to wait for.</p>

          <h3 id="locks">Locks and transfers</h3>
          <p>
            Locks are one-way switches. Once set they can never be cleared, so anyone relying on the agent can trust them.
          </p>
          <ul>
            <li>
              <strong>Non-transferable.</strong> The agent can never change owner.
            </li>
            <li>
              <strong>Capabilities frozen.</strong> The agent's capabilities can only narrow from now on.
            </li>
          </ul>
          <p>
            <strong>Transfer</strong> sends the agent's NFT to another account. Every approval you gave it stops working, because it was
            bound to the previous generation. The new holder starts with no spending authority until they approve it from their own
            account.
          </p>
          <Callout kind="warn">
            <p>Locks and removal cannot be undone. The app asks you to confirm before sending them.</p>
          </Callout>

          <h3 id="records">Records</h3>
          <p>
            <strong>Records</strong> lets you attach small key-value notes to an agent, such as a purpose or a link.
          </p>
          <Callout kind="warn">
            <p>Records are public on chain. Store a hash or an encrypted pointer for anything sensitive.</p>
          </Callout>

          <h2 id="activity">Reading activity</h2>
          <p>
            <strong>Activity</strong> shows one feed with everything that was attempted. It is read straight from bounded logs kept by
            the contracts, so it needs no indexer and only keeps recent entries.
          </p>
          <ul>
            <li>
              Use the pills at the top to filter by outcome: <strong>All</strong>, <strong>Paid</strong>, <strong>Blocked</strong>,{" "}
              <strong>Registry</strong> (stopped before reaching your account) and <strong>Failed</strong> (the transfer failed and the
              reservation was released).
            </li>
            <li>Use the agent pills to look at a single agent.</li>
            <li>Select the refresh icon to reload. The newest entries appear first.</li>
          </ul>

          <h2 id="reasons">Why a payment was blocked</h2>
          <p>Blocked entries always carry a reason. These are the common ones and what to do about them.</p>
          {REASON_GROUPS.map((group) => (
            <div key={group.title}>
              <h3>{group.title}</h3>
              <table>
                <thead>
                  <tr>
                    <th>Reason</th>
                    <th>What to do</th>
                  </tr>
                </thead>
                <tbody>
                  {group.items.map((item) => (
                    <tr key={item.text}>
                      <td>{item.text}</td>
                      <td>{item.fix}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}

          <h2 id="safety">What can and cannot go wrong</h2>
          <ul>
            <li>The agent's key can only call the registry. It cannot sign anything for your account.</li>
            <li>The agent cannot pay a recipient you did not approve, or more than the limits, even if it is compromised.</li>
            <li>The worst case for a leaked executor key is spending inside the limits you set. Pause or revoke to stop it.</li>
            <li>Simultaneous requests are checked against the same running totals, so they cannot all slip under a cap together.</li>
            <li>A payment that fails after being reserved releases the reservation and is logged as failed.</li>
            <li>Your funds stay on your account. NEARFirewall never takes custody.</li>
          </ul>
          <Callout kind="note">
            <p>This is a hackathon build on NEAR Testnet. Do not use it with real funds until it has been audited.</p>
          </Callout>

          <h2 id="faq">FAQ</h2>
          <h3>Does the agent hold my funds?</h3>
          <p>No. Funds stay on your account. The agent only sends requests, and your account decides.</p>
          <h3>Can I change limits after approving?</h3>
          <p>Yes. Approve the recipient again with new limits, or remove it. The next request uses the new rules.</p>
          <h3>What does a stale approval mean?</h3>
          <p>
            The agent changed holder or executor after you approved it. Approvals are bound to the agent's generation, so approve again if
            the change was intended.
          </p>
          <h3>What does "day" mean for daily limits?</h3>
          <p>A UTC day. Usage resets at 00:00 UTC.</p>
          <h3>Can someone else use my agent?</h3>
          <p>
            Not by default. The registry is designed so that a renter would need an access grant plus an approval on their own paying
            account, so they only spend their own funds. The app does not offer renting yet.
          </p>
          <h3>Does it work on mainnet?</h3>
          <p>The app supports a network setting, but this build targets Testnet.</p>
        </article>
      </div>
    </>
  );
}

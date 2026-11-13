import { useEffect, useRef, useState, type ReactNode } from "react";
import { Info, Lightbulb, Search, TriangleAlert, X } from "lucide-react";
import { Topbar } from "../components/Topbar.tsx";
import { REASON_GROUPS } from "../reasonGroups.ts";
import { href } from "../router.ts";
import { CheckLadder, GenerationBinding, PaymentLifecycle, SystemOverview } from "../components/diagrams/index.ts";

interface Section {
  id: string;
  title: string;
  sub?: boolean;
}

const TOC: Section[] = [
  { id: "overview", title: "Overview" },
  { id: "concepts", title: "Key ideas" },
  { id: "how-it-works", title: "How it works" },
  { id: "parts", title: "The parts", sub: true },
  { id: "lifecycle", title: "A payment, step by step", sub: true },
  { id: "rule-order", title: "Which rule wins", sub: true },
  { id: "nfts", title: "Agents as NFTs" },
  { id: "nft-basics", title: "Basics", sub: true },
  { id: "nft-technology", title: "Underlying technology", sub: true },
  { id: "generations", title: "Generations and approvals", sub: true },
  { id: "getting-started", title: "Getting started" },
  { id: "connect", title: "1. Connect a wallet", sub: true },
  { id: "register", title: "2. Register an agent", sub: true },
  { id: "enable", title: "3. Enable payments", sub: true },
  { id: "approve", title: "4. Approve recipients", sub: true },
  { id: "run", title: "5. Run the agent", sub: true },
  { id: "integrations", title: "Connect your AI agent" },
  { id: "integrations-now", title: "Available now", sub: true },
  { id: "integrations-platforms", title: "Claude, ChatGPT and others", sub: true },
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
  const [query, setQuery] = useState("");
  const [searchIndex, setSearchIndex] = useState<{ id: string; title: string; text: string }[]>([]);
  const tocRef = useRef<HTMLElement>(null);
  const articleRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const article = articleRef.current;
    if (!article) return;
    setSearchIndex(TOC.map(({ id, title }) => {
      const heading = article.querySelector(`#${id}`);
      const parts: string[] = [];
      let node = heading?.nextElementSibling;
      while (node && !/^H[23]$/.test(node.tagName)) {
        parts.push(node.textContent ?? "");
        node = node.nextElementSibling;
      }
      return { id, title, text: parts.join(" ").replace(/\s+/g, " ").trim() };
    }));
  }, []);

  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const results = terms.length ? searchIndex.filter(({ title, text }) => {
    const content = `${title} ${text}`.toLocaleLowerCase();
    return terms.every((term) => content.includes(term));
  }) : [];

  useEffect(() => {
    if (section) document.getElementById(section)?.scrollIntoView({ block: "start" });
    else window.scrollTo({ top: 0 });
  }, [section]);

  useEffect(() => {
    const headings = TOC.map(({ id }) => document.getElementById(id)).filter((heading) => heading !== null);
    if (!headings.length) return;

    let frame = 0;
    const update = () => {
      frame = 0;
      const offset = parseFloat(getComputedStyle(headings[0]!).scrollMarginTop) + 2;
      const atBottom = window.scrollY > 0 && Math.ceil(window.scrollY + window.innerHeight) >= document.documentElement.scrollHeight;
      const heading = atBottom ? headings.at(-1) : headings.findLast((item) => item.getBoundingClientRect().top <= offset);
      setCurrent(heading?.id ?? headings[0]!.id);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };

    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, []);

  useEffect(() => {
    const toc = tocRef.current;
    const link = toc?.querySelector('[aria-current="location"]');
    if (!toc || !link || toc.scrollHeight <= toc.clientHeight) return;

    const viewport = toc.getBoundingClientRect();
    const item = link.getBoundingClientRect();
    if (item.top < viewport.top) toc.scrollTop += item.top - viewport.top;
    else if (item.bottom > viewport.bottom) toc.scrollTop += item.bottom - viewport.bottom;
  }, [current]);

  return (
    <>
      <Topbar />
      <div className="docs-wrap">
        <nav ref={tocRef} className="toc" aria-label="On this page" tabIndex={0}>
          {TOC.map((s) => (
            <a
              key={s.id}
              href={href(`/docs/${s.id}`)}
              className={s.sub ? "sub" : undefined}
              aria-current={current === s.id ? "location" : undefined}
              onClick={(event) => {
                if (section === s.id && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
                  document.getElementById(s.id)?.scrollIntoView({ block: "start" });
                }
              }}
            >
              {s.title}
            </a>
          ))}
        </nav>

        <article className="doc" ref={articleRef}>
          <div className="docs-intro">
            <div>
            <h1>NEARFirewall documentation</h1>
            <p className="lead">Everything you need to let an agent pay from your NEAR account safely, from the first click to day-to-day control.</p>
            </div>

            <div className="docs-search" role="search">
              <label htmlFor="docs-search-input">Search documentation</label>
              <div className="docs-search-input">
                <Search size={18} aria-hidden="true" />
                <input id="docs-search-input" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by topic or keyword" autoComplete="off" />
                {query && <button type="button" aria-label="Clear search" onClick={() => setQuery("")}><X size={16} aria-hidden="true" /></button>}
              </div>
              {terms.length > 0 && (
                <div className="docs-search-results">
                  <p role="status">{results.length === 0 ? "No matching sections found." : `${results.length} ${results.length === 1 ? "section" : "sections"} found`}</p>
                  <ul>
                    {results.map(({ id, title, text }) => {
                      const position = text.toLocaleLowerCase().indexOf(terms[0]!);
                      const start = Math.max(0, position - 45);
                      const excerpt = text.slice(start, start + 150);
                      return <li key={id}>
                        <a href={href(`/docs/${id}`)} onClick={(event) => {
                          if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
                            setQuery("");
                            if (section === id) document.getElementById(id)?.scrollIntoView({ block: "start" });
                          }
                        }}>
                          <strong>{title}</strong>
                          {excerpt && <span>{start > 0 ? "…" : ""}{excerpt}{start + 150 < text.length ? "…" : ""}</span>}
                        </a>
                      </li>;
                    })}
                  </ul>
                </div>
              )}
            </div>
          </div>

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
              budget, the optional account cap, and your available balance. The tightest rule wins: see{" "}
              <a href={href("/docs/rule-order")}>which rule wins</a>.
            </p>
          </Callout>

          <h2 id="how-it-works">How it works</h2>
          <p>
            NEARFirewall is three pieces working together. Your wallet sets things up. At payment time the agent can only <em>ask</em>, and
            the decision is made on the blockchain by contracts that check your rules before any NEAR moves.
          </p>

          <h3 id="parts">The parts</h3>
          <SystemOverview />
          <ul>
            <li>
              <strong>You (wallet)</strong> sign every change: registering and managing agents in the registry, and setting the rules on your
              own account. Each change attaches 1 yoctoNEAR, so only your wallet's full key can make it.
            </li>
            <li>
              <strong>The registry</strong> holds every agent as an NFT, with its executor, capabilities, expiry, locks, place in the tree,
              and generation. It checks who is asking and forwards valid requests.
            </li>
            <li>
              <strong>Your account</strong> runs the payment policy: your approvals, recipients, limits, and budgets. It accepts requests only
              from the registry, checks them, and sends NEAR from your own balance.
            </li>
            <li>
              <strong>The executor</strong> is the agent's own small account. Its only key can call the registry's <code>execute</code>{" "}
              method. It cannot send NEAR, change rules, or touch your account.
            </li>
          </ul>

          <h3 id="lifecycle">A payment, step by step</h3>
          <PaymentLifecycle />
          <Callout kind="note">
            <p>
              Steps 1 to 3 and 4 to 7 run as separate on-chain receipts, a block or so apart. A pause or a rule change applies to every
              request checked after it; a transfer that has already been sent can still complete.
            </p>
          </Callout>

          <h3 id="rule-order">Which rule wins</h3>
          <p>Every check below must pass. The contracts run them in this order and stop at the first failure.</p>
          <CheckLadder />
          <p>
            Each failure has a reason code, listed under <a href={href("/docs/reasons")}>why a payment was blocked</a>.
          </p>

          <h2 id="nfts">Agents as NFTs</h2>
          <p>
            Every agent is a non-fungible token. The token is the agent's identity and proof of who owns it. It is deliberately not a
            key to anyone's money: spending power always comes from approvals that the paying account gives, and those approvals stop
            working the moment the token changes hands.
          </p>

          <h3 id="nft-basics">Basics</h3>
          <ul>
            <li>
              <strong>Registering an agent mints an NFT to your wallet.</strong> It appears in wallets and explorers in the collection
              "NEARFirewall Agents" (symbol <code>AGENT</code>), named after the agent's handle.
            </li>
            <li>
              <strong>Holding the NFT means you control the agent.</strong> You can pause it, change its executor, add leaf agents under it,
              burn locks, write its records, transfer it, or remove it.
            </li>
            <li>
              <strong>The NFT does not hold or move money.</strong> An agent can pay only from the account that holds it, and only within
              the approvals that account has set.
            </li>
            <li>
              <strong>Leaf agents are NFTs too.</strong> Each one is its own token, named under its parent (<code>bot-1.desk</code>), and it can
              only narrow its parent's rules. Holding a parent also lets you manage everything below it.
            </li>
            <li>
              <strong>Transferring is a clean handover.</strong> The new holder gets control of the agent but no spending power. Every
              approval for it stops working, and it can no longer charge your account. To make an agent permanently non-transferable, burn
              the transfer lock.
            </li>
            <li>
              <strong>Removing an agent burns its NFT.</strong> Agents below it stop working, and its handle and ID are never reused.
            </li>
          </ul>
          <Callout kind="tip">
            <p>
              Think of the NFT as the agent's ID card: it says who the agent is and who is responsible for it. The approvals on your account
              are its spending permit. A new owner gets the card but never the permit.
            </p>
          </Callout>

          <h3 id="nft-technology">Underlying technology</h3>
          <p>
            The registry contract is the NFT contract. It implements the NEAR NFT standard: core (NEP-171), metadata (NEP-177), approvals
            (NEP-178), and enumeration (NEP-181). Any wallet, explorer, or contract that understands NEAR NFTs can read agents.
          </p>
          <table>
            <thead>
              <tr>
                <th>Part</th>
                <th>How it works</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Token ID</td>
                <td>The agent ID: a sequential number that is never reused, even after removal. A new agent can never match an old approval.</td>
              </tr>
              <tr>
                <td>Token metadata</td>
                <td>The title is the handle, there is a single copy, and the token records when it was issued and when it expires.</td>
              </tr>
              <tr>
                <td>Agent record</td>
                <td>
                  Stored next to each token: handle, parent and ancestor list, executor, capabilities, status, expiry, locks, and generation.
                  Read it with <code>get_agent</code>, or by handle with <code>resolve</code>.
                </td>
              </tr>
              <tr>
                <td>Generation</td>
                <td>
                  A number from one registry-wide counter. It changes on every transfer and every executor change. An approval records the
                  generation of the agent and of each agent above it, and the payer's policy refuses a request whose path no longer matches
                  (<code>MANDATE_STALE</code>).
                </td>
              </tr>
              <tr>
                <td>Who can be charged</td>
                <td>
                  The registry routes a payment only when the paying account holds the requesting token itself; holding a parent is not
                  enough (<code>PAYER_NOT_AUTHORIZED</code>). A leaf transferred to someone else can never spend from your branch budget.
                </td>
              </tr>
              <tr>
                <td>Transfers</td>
                <td>
                  <code>nft_transfer</code> needs 1 yoctoNEAR, so only the holder's full-access key can send it, never an agent's restricted
                  key. Transfers are refused when the transfer lock is burned, or when the receiver is the agent's own executor. Token
                  approvals are cleared on every transfer.
                </td>
              </tr>
              <tr>
                <td>Agent tree</td>
                <td>
                  <code>create_child</code> mints a child to the parent's holder. Ancestry is fixed at creation, up to 8 levels. On every
                  payment the registry checks status, expiry, and capability for every agent on the path, all inside one contract.
                </td>
              </tr>
              <tr>
                <td>Locks</td>
                <td>
                  One-way flags on the token: <code>NO_TRANSFER</code> and <code>NO_CAPABILITY_RAISE</code>. They can never be cleared, so
                  payers and other apps can rely on them.
                </td>
              </tr>
              <tr>
                <td>Records</td>
                <td>
                  Namespaced key/value data on the token, such as <code>profile.description</code>, written by the holder. Records are public
                  and never grant authority.
                </td>
              </tr>
              <tr>
                <td>Removal</td>
                <td>
                  <code>remove_agent</code> burns the token and emits the standard burn event. The record stays as a tombstone, so the handle
                  and ID stay reserved, and descendants fail their path check.
                </td>
              </tr>
            </tbody>
          </table>
          <p>Useful read calls on the registry:</p>
          <pre>
            <code>{`nft_tokens_for_owner({ account_id })   // every agent you hold
nft_token({ token_id })               // the standard NFT view
get_agent({ agent_id })               // the full agent record
get_path({ agent_id })                // root-to-leaf path with generations
resolve({ handle })                   // look an agent up by handle
get_records({ agent_id })             // its public records`}</code>
          </pre>
          <Callout kind="note">
            <p>
              Everything on a blockchain is public, including the registry, every token, and every record. Store a hash or an encrypted
              pointer for anything private.
            </p>
          </Callout>

          <h3 id="generations">Generations and approvals</h3>
          <p>
            An approval on your account does not just name an agent. It records the generation of that agent and of every agent above it at
            the moment you approved. Each request carries the current generations along its path, and your account compares the two.
          </p>
          <GenerationBinding />
          <p>
            Transferring an agent, or changing its executor, gives it a new generation. Every approval that recorded the old one stops
            matching, so nobody inherits spending power with the token. To let a new holder pay, they set up their own approvals on their own
            account.
          </p>

          <h2 id="getting-started">Getting started</h2>
          <p>You need a NEAR account with some balance (Testnet for now), and a second account to act as the agent's executor.</p>

          <h3 id="connect">1. Connect a wallet</h3>
          <ol>
            <li>
              Select <strong>Connect wallet</strong> in the header to open the wallet picker.
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
            The agent submits a typed payment request through its executor account. The registry checks the agent, then forwards the
            request to your account, which checks your rules and pays if everything passes. See{" "}
            <a href={href("/docs/lifecycle")}>a payment, step by step</a> for the full flow.
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

          <h2 id="integrations">Connect your AI agent</h2>
          <p>
            NEARFirewall does not run your agent. Your agent runs wherever you build it, and it uses a key that can only <em>ask</em> for a
            payment. Your account's rules decide, on-chain, whether the payment happens. So the same protection applies whichever platform
            the agent runs on.
          </p>
          <Callout kind="warn">
            <p>
              Never give an agent your wallet's seed phrase or private key. A wallet's main key can do anything, including removing your
              rules. Give the agent only the restricted key NEARFirewall sets up for it.
            </p>
          </Callout>

          <h3 id="integrations-now">Available now: agents you run as code</h3>
          <p>
            Today an agent pays through its <strong>executor account</strong>, whose only key can call the registry's <code>execute</code>{" "}
            method (see <a href={href("/docs/register")}>Register an agent</a>). Any agent you run as code can use that key: a script, a
            server, or an agent framework. Keep the key in an environment variable or secret store, never in a prompt.
          </p>
          <p>
            <strong>TypeScript (Node.js 24)</strong>, with the NEARFirewall SDK:
          </p>
          <pre>{`import { Account } from "near-api-js";
import {
  ExecutorClient, MemoryJournalStore, NearRpc, OperationJournal,
  PolicyClient, RegistryClient, parseNear,
} from "@nearfirewall/sdk";

const rpc = new NearRpc("https://test.rpc.fastnear.com");
const registryId = "nfw-registry-1112.testnet";
const executor = new Account("my-executor.testnet", rpc.url, process.env.NEARFIREWALL_EXECUTOR_KEY);

// Sends registry.execute with the executor's restricted key.
const submit = async (args, gas) => {
  const r = await executor.callFunctionRaw({
    contractId: registryId, methodName: "execute", args, gas, deposit: 0n, waitUntil: "FINAL",
  });
  return { txHash: r.transaction.hash, status: r.status };
};

const payments = new ExecutorClient(
  submit,
  new OperationJournal(new MemoryJournalStore()),
  (payer) => new PolicyClient(rpc, payer),
);

const agent = await new RegistryClient(rpc, registryId).resolve("market-agent");
const result = await payments.pay({
  payer: "you.testnet",            // the account that holds the agent
  agentId: agent!.agent_id,
  recipient: "vendor.testnet",
  amount: parseNear("2"),
});
console.log(result.operation.state, result.operation.reason ?? "");`}</pre>
          <p>
            <strong>Give it to an LLM agent as a tool.</strong> In any agent framework, wrap that <code>pay</code> call in a tool such as{" "}
            <code>pay(recipient, amount)</code> and return the outcome to the model. The model sees "settled" or "blocked, with the reason";
            it never sees the key.
          </p>
          <p>
            <strong>Any other language.</strong> Use any NEAR library to sign a call to <code>execute</code> on the registry with the
            executor's key: 150 Tgas, no deposit, and these arguments (amount in yoctoNEAR, a fresh 64-character hex request ID each time):
          </p>
          <pre>{`{
  "payer": "you.testnet",
  "agent_id": "1",
  "grant_id": null,
  "action": { "type": "TransferNear", "recipient": "vendor.testnet", "amount": "2000000000000000000000000" },
  "request_id": "<64 hex characters>",
  "expected_revision": null
}`}</pre>
          <p>
            The transaction's final value is the outcome: <code>settled</code>, <code>failed</code>, or <code>denied</code> with a reason
            code. To try it without writing code, use the runner from <a href={href("/docs/run")}>step 5</a>.
          </p>

          <h3 id="integrations-platforms">
            Claude, ChatGPT and others <span className="badge">Coming soon</span>
          </h3>
          <p>
            Connecting chat assistants, coding agents, and no-code workflow tools directly is the next release. It is not available yet.
            Here is how it will work:
          </p>
          <ol>
            <li>
              In the app, open an agent and choose <strong>Connect</strong>. A side panel lists agent platforms: three common ones, plus
              a search over the rest.
            </li>
            <li>
              Pick a platform. Your browser creates a new key, and your wallet asks you to approve adding it to your account. The key can
              only ask your payment policy to act for that one agent. It cannot send NEAR directly, change your rules, or call anything
              else.
            </li>
            <li>The app shows the key once, with the exact setup steps for the platform you picked.</li>
            <li>
              Every payment is checked against your rules as today, and Activity shows which agent and which connection asked. To stop
              it, choose <strong>Disconnect</strong>: one signature deletes the key.
            </li>
          </ol>
          <table>
            <thead>
              <tr>
                <th>Platform type</th>
                <th>Examples</th>
                <th>How it will connect</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Chat assistants on your computer</td>
                <td>Claude Desktop</td>
                <td>
                  A local NEARFirewall MCP server, added to the app's MCP settings. The key stays on your computer.
                </td>
              </tr>
              <tr>
                <td>Coding agents</td>
                <td>Claude Code, Cursor, VS Code agent mode, Windsurf</td>
                <td>The same local MCP server.</td>
              </tr>
              <tr>
                <td>Chat assistants on the web</td>
                <td>Claude.ai, ChatGPT, Microsoft Copilot Studio</td>
                <td>A remote MCP connector pointing to your own NEARFirewall gateway, a small service you deploy that holds the key.</td>
              </tr>
              <tr>
                <td>Workflow tools</td>
                <td>n8n, Gumloop, Zapier, Make</td>
                <td>Their MCP or HTTP request steps, calling your gateway, with the access token kept in the tool's credential store.</td>
              </tr>
              <tr>
                <td>Agent frameworks</td>
                <td>OpenAI Agents SDK, LangChain, CrewAI, Vercel AI SDK</td>
                <td>Their MCP client, or the TypeScript SDK as shown above.</td>
              </tr>
              <tr>
                <td>Web3 agent kits</td>
                <td>NEAR AI agents, ElizaOS</td>
                <td>The SDK, or HTTP calls to your gateway.</td>
              </tr>
            </tbody>
          </table>
          <p>
            Each connected agent gets the same tools on every platform: <code>get_rules</code> (what it may spend),{" "}
            <code>preview_payment</code> (would this be allowed, and why not), and <code>pay</code>. The platform's own permission prompts
            still apply on top, for example a chat app asking before it uses a tool.
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

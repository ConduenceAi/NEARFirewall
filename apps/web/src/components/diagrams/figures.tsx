/**
 * The "How it works" figures show the connected-key and separate-executor
 * paths to the policy on the owner's account.
 */
import { Diagram, Edge, Lane, Node, Note, StepBadge } from "./Diagram.tsx";

export function ConnectedPayment() {
  return <Diagram title="A payment from a connected agent" desc="A restricted key asks the policy to pay. The policy asks the registry to authorize the agent, checks the owner's limits and either transfers NEAR, waits for confirmation, or refuses." width={400} height={300}>
    <Node x={120} y={8} w={160} h={45} label="Connected agent" sub="restricted key" tone="agent" />
    <Node x={15} y={113} w={158} h={52} label="Your registry" sub="identity and capabilities" tone="contract" />
    <Node x={227} y={113} w={158} h={52} label="Your account" sub="payment policy" tone="owner" />
    <Node x={15} y={240} w={158} h={48} label="Owner confirmation" sub="when required" tone="owner" dashed />
    <Node x={227} y={240} w={158} h={48} label="Approved recipient" sub="receives NEAR" tone="recipient" />
    <Edge points={[[265, 53], [305, 111]]} kind="call" label="agent_execute" labelAt={[302, 81]} anchor="start" />
    <Edge points={[[227, 128], [175, 128]]} kind="call" label="authorize" labelAt={[200, 112]} />
    <Edge points={[[173, 153], [225, 153]]} kind="returns" label="path" labelAt={[200, 171]} />
    <Edge points={[[305, 165], [305, 238]]} kind="pays" label="NEAR" labelAt={[315, 206]} anchor="start" />
    <Edge points={[[240, 165], [94, 238]]} kind="call" label="wait if required" labelAt={[153, 194]} />
  </Diagram>;
}

/** Figure 1: the parts and who calls whom. */
export function SystemOverview() {
  return (
    <Diagram
      title="The parts of NEARFirewall"
      desc="You manage agents in the registry and set rules on your own account. The agent's executor asks the registry to pay. The registry forwards the request to your account, whose policy pays an approved recipient or refuses."
      width={400}
      height={300}
      caption="You set everything up with your wallet. At payment time, the agent can only ask; your account decides."
    >
      <Node x={125} y={8} w={150} h={46} label="You" sub="wallet (owner)" tone="owner" />
      <Node x={8} y={128} w={150} h={50} label="Registry" sub="agent NFTs" tone="contract" />
      <Node x={242} y={128} w={150} h={50} label="Your account" sub="payment policy" tone="owner" />
      <Node x={8} y={242} w={150} h={50} label="Executor" sub="restricted key" tone="agent" />
      <Node x={242} y={242} w={150} h={50} label="Recipient" sub="approved vendor" tone="recipient" dashed />

      <Edge points={[[160, 54], [100, 126]]} kind="call" label="manage agents" labelAt={[96, 92]} anchor="end" />
      <Edge points={[[240, 54], [300, 126]]} kind="call" label="set rules" labelAt={[306, 92]} anchor="start" />
      <Edge points={[[83, 242], [83, 180]]} kind="call" label="① execute" labelAt={[92, 216]} anchor="start" />
      <Edge points={[[158, 153], [240, 153]]} kind="call" label="② forward" labelAt={[199, 145]} />
      <Edge points={[[317, 178], [317, 240]]} kind="pays" label="③ NEAR" labelAt={[326, 214]} anchor="start" />
    </Diagram>
  );
}

/** Figure 2: one payment request, step by step. */
export function PaymentLifecycle() {
  const ex = 52;
  const reg = 150;
  const acc = 258;
  const rec = 352;
  return (
    <>
      <Diagram
        title="A payment, step by step"
        desc="1, the executor calls execute on the registry. 2, the registry checks the agent and its path; a failure is returned as a denial. 3, the registry forwards the request to your account. 4, your account's policy checks every rule; a failure is returned as a denial. 5, the amount is reserved. 6, NEAR is sent to the recipient. 7, the result is recorded; a failed transfer releases the reservation. 8, the outcome is the transaction's final value."
        width={400}
        height={440}
      >
        <Lane x={ex} top={6} bottom={428} label="Executor" tone="agent" />
        <Lane x={reg} top={6} bottom={428} label="Registry" tone="contract" />
        <Lane x={acc} top={6} bottom={428} label="Your account" tone="owner" />
        <Lane x={rec} top={6} bottom={428} label="Recipient" tone="recipient" />

        <StepBadge x={14} y={70} n={1} />
        <Edge points={[[ex, 70], [reg - 2, 70]]} kind="call" label="execute" />

        <StepBadge x={14} y={112} n={2} />
        <Node x={reg - 48} y={98} w={96} h={28} label="check_path" tone="contract" />
        <Edge points={[[reg - 48, 132], [ex + 2, 132]]} kind="deny" label="✕ denied" labelAt={[(ex + reg) / 2 - 4, 146]} />

        <StepBadge x={14} y={170} n={3} />
        <Edge points={[[reg, 170], [acc - 2, 170]]} kind="call" label="forward" />

        <StepBadge x={14} y={212} n={4} />
        <Node x={acc - 40} y={198} w={80} h={28} label="check" tone="owner" />
        <Edge points={[[acc - 40, 234], [ex + 2, 234]]} kind="deny" label="✕ denied" labelAt={[(ex + reg) / 2 - 4, 248]} />

        <StepBadge x={14} y={276} n={5} />
        <Node x={acc - 40} y={262} w={80} h={28} label="reserve" tone="owner" />

        <StepBadge x={14} y={320} n={6} />
        <Edge points={[[acc, 320], [rec - 2, 320]]} kind="pays" label="NEAR" />

        <StepBadge x={14} y={362} n={7} />
        <Node x={acc - 44} y={348} w={88} h={28} label="on_settle" tone="owner" />

        <StepBadge x={14} y={406} n={8} />
        <Edge points={[[acc, 406], [ex + 2, 406]]} kind="returns" label="outcome" />
      </Diagram>
      <ol className="diagram-steps">
        <li>
          The agent's executor calls <code>execute</code> on the registry with a typed request: recipient, amount, and a unique request ID.
        </li>
        <li>
          The registry checks the agent and every agent above it: not removed, not paused, not expired, and allowed to ask for this
          amount. It also checks that the paying account holds the agent. Any failure ends here with a reason; nothing reaches your
          account.
        </li>
        <li>The registry forwards the request, with the agent's path and generations, to the policy on your account.</li>
        <li>
          Your account checks every rule: payments on, an approval that is current, the recipient approved, every limit, and your
          available balance. Any failure ends here with a reason.
        </li>
        <li>The amount is reserved against every limit it counts toward, so simultaneous requests can never overspend.</li>
        <li>Your account sends the NEAR to the recipient, or holds the reservation for owner confirmation if required.</li>
        <li>The result is recorded. If the transfer failed, the reservation is released and nothing is lost.</li>
        <li>The outcome (settled, failed, or denied with a reason) is the transaction's final value, and it appears in Activity.</li>
      </ol>
    </>
  );
}

/** Figure 3: approvals are tied to generations along the agent's path. */
export function GenerationBinding() {
  return (
    <div className="diagram-pair">
      <Diagram
        title="Approved"
        desc="desk, agent 1 at generation 3, has the leaf bot-1, agent 2 at generation 5, and bot-2, agent 3 at generation 6. The approval on desk records 1 at 3. The approval on bot-1 records 1 at 3 and 2 at 5. A request from bot-1 carries the path 1 at 3, 2 at 5, which matches both approvals."
        width={300}
        height={250}
        maxWidth={360}
        caption="Before: the request path matches what each approval recorded."
      >
        <Node x={90} y={8} w={120} h={44} label="desk #1" sub="generation 3" tone="agent" />
        <Node x={8} y={98} w={124} h={44} label="bot-1 #2" sub="generation 5" tone="agent" />
        <Node x={168} y={98} w={124} h={44} label="bot-2 #3" sub="generation 6" tone="agent" />
        <Edge points={[[130, 52], [74, 96]]} kind="parent" />
        <Edge points={[[170, 52], [226, 96]]} kind="parent" />
        <Note
          x={8}
          y={160}
          w={284}
          lines={["approval on desk:   #1@3", "approval on bot-1:  #1@3, #2@5", "bot-1 asks with:    #1@3, #2@5  ✓", "→ both budgets count the payment"]}
        />
      </Diagram>
      <Diagram
        title="After desk is transferred"
        desc="desk was transferred, so its generation changed from 3 to 9. A request from bot-1 now carries the path 1 at 9, 2 at 5. Both approvals recorded 1 at 3, so the policy refuses with MANDATE_STALE. A request from desk itself is refused by the registry with PAYER_NOT_AUTHORIZED, because you no longer hold it."
        width={300}
        height={250}
        maxWidth={360}
        caption="After: one transfer voids every approval along that branch."
      >
        <Node x={75} y={8} w={150} h={44} label="desk #1" sub="gen 9 · new holder" tone="agent" />
        <Node x={8} y={98} w={124} h={44} label="bot-1 #2" sub="generation 5" tone="agent" />
        <Node x={168} y={98} w={124} h={44} label="bot-2 #3" sub="generation 6" tone="agent" />
        <Edge points={[[130, 52], [74, 96]]} kind="parent" />
        <Edge points={[[170, 52], [226, 96]]} kind="parent" />
        <Note
          x={8}
          y={160}
          w={284}
          lines={["bot-1 asks with:  #1@9, #2@5", "✕ approvals expect #1@3: MANDATE_STALE", "desk asks to pay:", "✕ not your agent: PAYER_NOT_AUTHORIZED"]}
        />
      </Diagram>
    </div>
  );
}

/** Figure 4: every check, in the order the contracts run them. */
export function CheckLadder() {
  return (
    <figure className="diagram ladder">
      <div className="ladder-group">
        <h4>In the registry</h4>
        <ol>
          <li>The agent exists, and the request comes from its executor.</li>
          <li>The request ID is valid.</li>
          <li>
            For every agent from the top of the tree down to the requesting one: not removed, not paused, not expired, and its capability
            allows this amount. A problem above the agent is reported as <code>BRANCH_*</code>, with the agent that limited it.
          </li>
          <li>
            The paying account holds the requesting agent itself (<code>PAYER_NOT_AUTHORIZED</code>).
          </li>
        </ol>
      </div>
      <div className="ladder-group">
        <h4>In your account's policy</h4>
        <ol>
          <li>The request came from your trusted registry, and its request ID was not used before.</li>
          <li>Payments are not paused, and the policy revision matches if the agent asked for that check.</li>
          <li>
            For every approval found along the agent's path: not revoked, not stale (<code>MANDATE_STALE</code>), not expired; the
            recipient is approved and its rule unexpired; then the per-payment limit, the recipient's daily limit, and the branch's daily
            budget.
          </li>
          <li>At least one approval covers the agent.</li>
          <li>The account-wide daily cap, if you set one.</li>
          <li>Your available balance, after storage, reservations, and the safety buffer.</li>
          <li>After these checks pass, an amount above the confirmation threshold waits for the owner.</li>
        </ol>
      </div>
      <figcaption>
        The first failed check returns its reason, and nothing is reserved or sent. A payment goes through only when every check
        passes, so the tightest rule always wins.
      </figcaption>
    </figure>
  );
}

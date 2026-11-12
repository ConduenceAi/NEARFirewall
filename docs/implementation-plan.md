# NEARFirewall Implementation Plan

This plan builds the system described in the [README](../README.md), one phase at a time. Phases 0–8 are the hackathon release on NEAR Testnet. Phases 9–13 follow it.

**Rules for every phase**

- A phase is done only when its exit criteria pass in CI or on Testnet, with evidence recorded.
- Contract interfaces, reason codes, and events are frozen at the end of Phase 0. Any later change updates the shared types crate, the SDK types, and this plan together.
- Each phase lists its dependencies. Work that has none can run in parallel.

## Phase overview

| Phase | Goal | Depends on | Release |
| --- | --- | --- | --- |
| 0 | Repository, shared types, CI, and Testnet spikes | — | Hackathon |
| 1 | Registry core: agent NFT, executor, generation, expiry, locks, `execute` | 0 | Hackathon |
| 2 | Account policy contract on the owner's account | 0 | Hackathon |
| 3 | Agent tree and branch mandates | 1, 2 | Hackathon |
| 4 | Records on agent tokens | 1 | Hackathon |
| 5 | TypeScript SDK, templates, and `validate` | 0 (types); 1–4 for live tests | Hackathon |
| 6 | Agent runner | 5 | Hackathon |
| 7 | Web app | 5 | Hackathon |
| 8 | Testnet deployment and demo | 1–7 | Hackathon |
| 9 | CLI and MCP server | 5 | After |
| 10 | Payment rule extensions | 8 | After |
| 11 | Team roles and payroll | 8 | After |
| 12 | Actions, subscriptions, and integrations | 10 | After |
| 13 | Hardening, audit, and mainnet | 9–12 | After |

```text
Phase 0 ──┬── Phase 1 ──┬── Phase 3 ──┐
          │             └── Phase 4 ──┤
          ├── Phase 2 ────────────────┤
          └── Phase 5 ──┬── Phase 6 ──┼── Phase 8 ── Phases 9–13
                        └── Phase 7 ──┘
```

## Repository layout

```text
contracts/
  types/            shared Rust crate: IDs, actions, reason codes, events, ExecContext
  registry/         agent NFT, tree, records, locks, execute router
  account-policy/   policy contract deployed on payer accounts
  tests/            near-workspaces integration tests (sandbox)
packages/
  sdk/              TypeScript client, Zod types, owner transaction builders, operation journal
  templates/        Template interface, built-in templates, validate()
  cli/              (Phase 9)
  mcp/              (Phase 9)
apps/
  web/              React + Vite + NEAR Connect (Meteor)
  runner/           agent runner with the restricted executor key
deployments/
  testnet.json      deployment manifest
scripts/            build, deploy, account setup, demo scenarios
```

## Shared definitions (frozen in Phase 0)

### Core types

```rust
pub type AgentId = String;          // NEP-171 token ID: decimal string of a sequential u64, never reused
pub const MAX_DEPTH: usize = 8;     // root is depth 0

pub enum Action {
    TransferNear { recipient: AccountId, amount: U128 },
    // Phase 10: TransferFt { token: AccountId, recipient: AccountId, amount: U128 }
    // Phase 12: CallContract { contract, method, args_constraints, max_deposit }
}

pub struct Capabilities {
    pub transfer_near: Option<CapTransferNear>, // None = action not allowed
}
pub struct CapTransferNear { pub max_per_payment: U128 }

pub struct PathNode { pub agent_id: AgentId, pub generation: u64 }

/// Sent by the registry to the payer's `on_execute`.
pub struct ExecContext {
    pub path: Vec<PathNode>,   // root first, leaf last
    pub executor: AccountId,
    pub action: Action,
    pub request_id: String,    // 32 bytes, hex, client-generated
    pub expected_revision: Option<u64>,
}

pub enum Outcome {
    Reserved { request_id: String },   // transfer dispatched, settlement pending
    Denied { reason: Reason, detail: Option<String> },
}
```

**Generations are globally unique.** Every generation value comes from one registry-wide counter, so a value is never repeated across agents or after a removal. Together with never-reused token IDs, this means no stale mandate can ever match a new agent.

### Reason codes

| Contract | Codes |
| --- | --- |
| Registry | `AGENT_NOT_FOUND`, `AGENT_REMOVED`, `AGENT_PAUSED`, `AGENT_EXPIRED`, `BRANCH_PAUSED`, `BRANCH_REMOVED`, `BRANCH_EXPIRED`, `EXECUTOR_MISMATCH`, `ACTION_NOT_ALLOWED`, `CAP_EXCEEDED`, `PAYER_NOT_AUTHORIZED` |
| Account policy | `UNTRUSTED_CALLER`, `PAYMENTS_PAUSED`, `DUPLICATE_REQUEST`, `REVISION_MISMATCH`, `NO_MANDATE`, `MANDATE_STALE`, `MANDATE_REVOKED`, `MANDATE_EXPIRED`, `RECIPIENT_NOT_APPROVED`, `RECIPIENT_RULE_EXPIRED`, `PER_PAYMENT_CAP`, `RECIPIENT_DAILY_CAP`, `MANDATE_DAILY_CAP`, `ACCOUNT_DAILY_CAP`, `INSUFFICIENT_BALANCE` |

Denials are returned as `Outcome::Denied` and emitted as events; they do not panic. Panics are reserved for invalid input and authorization failures on owner writes.

### Events (NEP-297, standard `nearfirewall`, version `1.0.0`)

- **Registry:** `agent_registered`, `agent_child_created`, `agent_removed`, `executor_changed`, `agent_paused`, `agent_resumed`, `capabilities_set`, `expiry_extended`, `locks_burned`, `record_set`, `record_removed`, `execution_routed`, `execution_denied`. The NFT standard's own `nft_mint`, `nft_transfer`, and `nft_burn` events are emitted as well.
- **Account policy:** `policy_initialized`, `mandate_set`, `mandate_revoked`, `recipient_approved`, `recipient_removed`, `payments_paused`, `payments_resumed`, `payment_reserved`, `payment_settled`, `payment_failed`, `payment_denied`.

---

## Phase 0: Foundations and Testnet spikes

**Goal:** remove the riskiest unknowns first, and freeze the interfaces so contracts, SDK, and app can be built in parallel.

**Work**

1. Scaffold the layout above: a Cargo workspace for `contracts/*` and a pnpm workspace for `packages/*` and `apps/*`.
2. Write `contracts/types` with the shared definitions above. Export the ABI with `cargo near abi`. Hand-write matching Zod schemas in `packages/sdk/src/types.ts`, plus a CI test that compares them with the ABI.
3. Set up CI: `cargo fmt --check`, `cargo clippy -D warnings`, unit tests, `near-workspaces` sandbox tests, `pnpm lint`, Vitest, and a reproducible WASM build that records the hash.
4. Run these Testnet spikes and record the results in this file:

| Spike | Question | Fallback |
| --- | --- | --- |
| S1 | Can Meteor through NEAR Connect sign one transaction to the user's own account containing a deploy action and an `initialize` function call? | Deploy and initialize with NEAR CLI for the demo account, and keep Meteor for every other owner action. |
| S2 | Does deploying the policy as a global contract (NEP-591) and pointing the user's account at it by hash work on Testnet, and can Meteor sign that action? | Use a regular deploy. Budget for the storage it locks on the user's account (about 1 NEAR per 100 KB of WASM). |
| S3 | Does a native transfer issued by the contract on `alice.testnet` show `alice.testnet` as the source in the receipt, and does a failed transfer refund and reach the callback? | None. This must hold. |
| S4 | Does a function-call key restricted to `registry.execute` with a gas allowance work from the runner, and is it rejected for every other method and receiver? | None. This must hold. |
| S5 | What is the gas cost of `execute` → `on_execute` → transfer → `on_settle` with an 8-node path? | Lower `MAX_DEPTH` if needed. |

**Exit criteria:** CI green on an empty build. Shared types merged. Results of S1–S5 recorded, and each fallback decision made.

## Phase 1: Registry core

**Goal:** agents exist as NEAR NFTs with an executor, a generation, an expiry, and the MVP locks, and the executor can route a typed request.

**Work**

1. **NFT standard.** Implement NEP-171, 177, 178, and 181 with `near-contract-standards`. Write `nft_transfer` and `nft_transfer_call` by hand around the library's internal transfer. Each one must:
   - Reject the transfer if `NO_TRANSFER` is burned.
   - Advance the generation and clear approvals.
   - Emit events.
2. **State.**
   ```rust
   pub struct AgentRecord {
       pub handle: String,              // unique; lowercase [a-z0-9-], 2–32 chars per label
       pub parent: Option<AgentId>,
       pub ancestors: Vec<AgentId>,     // root first, excluding self; fixed at creation
       pub executor: AccountId,
       pub capabilities: Capabilities,
       pub status: Status,              // Active | Paused { by_depth: u8 } | Removed
       pub expires_at: Option<u64>,     // nanoseconds
       pub locks: u32,                  // bit flags
       pub generation: u64,
   }
   ```
   Store records in `LookupMap<AgentId, AgentRecord>` and handles in `LookupMap<String, AgentId>`. Handles of removed agents stay reserved.
3. **`register_agent(handle, executor, capabilities, expires_at, locks, metadata)`.** It is `#[payable]`. Mint to the caller and charge storage from the attached deposit, refunding the surplus. Reject an executor equal to the caller.
4. **Owner operations.** These are callable by the holder, or by the holder of any ancestor once Phase 3 lands. They require 1 yoctoNEAR so that only full-access keys can call them.
   - `set_executor`: advances the generation.
   - `pause`: records the depth of whoever paused, so a holder deeper in the tree cannot resume what an ancestor paused.
   - `resume`.
   - `set_capabilities`: may only narrow if `NO_CAPABILITY_RAISE` is burned.
   - `extend_expiry`: extend only.
   - `burn_locks`: bits can only be added.
5. **`execute(payer, agent_id, grant_id, action, request_id, expected_revision)`.**
   - Check that the caller is the executor, the agent is active and not expired, the action is allowed, and the amount is within the cap.
   - Check that the payer is the holder of a node on the path. Grants for other payers come in Phase 11; `grant_id` stays `Option` and is rejected if set.
   - Build the `ExecContext` and call `payer.on_execute` with a fixed gas budget sized from S5.
   - On a registry-side denial, return `Denied`, emit `execution_denied`, and write a bounded per-agent activity entry (see item 7).
6. **Views:** `resolve(handle)`, `get_agent(id)`, `get_path(id)`, plus the standard NFT views.
7. **Bounded activity log.** Keep a fixed-size ring buffer of the last 32 outcomes per agent, paid for at registration. Its storage cannot grow, so a compromised executor cannot drain anyone's balance through denials.

**Tests:** handle validation and uniqueness; mint and storage refund; transfer advances the generation and clears approvals; `NO_TRANSFER` blocks transfers; a function-call key cannot transfer (no deposit); executor mismatch; expiry; pause and resume authority; `NO_CAPABILITY_RAISE`; the ring buffer stays the same size.

**Exit criteria:** all tests pass in sandbox, and the registry deploys to Testnet.

## Phase 2: Account policy contract

**Goal:** the owner's own account enforces mandates and recipient limits, and pays directly.

**Work**

1. **`initialize(registry, account_daily_cap)`.** Asserts that the caller is the account itself. It runs in the same batch as the deploy, using the path S1 or S2 chose.
2. **State.**
   ```rust
   pub struct Mandate {
       pub path: Vec<PathNode>,          // generations of the node and its ancestors at approval
       pub status: MandateStatus,        // Active | Revoked
       pub fixed: bool,
       pub expires_at: Option<u64>,
       pub daily_cap: U128,              // the shared pool for the branch
   }
   pub struct RecipientRule { pub per_payment_cap: U128, pub daily_cap: U128, pub expires_at: Option<u64> }
   pub struct Usage { pub settled: u128, pub reserved: u128 }
   ```
   Maps:
   - `mandates: AgentId → Mandate`
   - `rules: (AgentId, AccountId) → RecipientRule`
   - `usage_recipient: (AgentId, AccountId, day) → Usage`
   - `usage_mandate: (AgentId, day) → Usage`
   - `usage_account: day → Usage`
   - `requests: (leaf AgentId, request_id) → Request`
   - `reserved_total`, `revision`, `paused`

   Here `day` is `block_timestamp / 86_400_000_000_000`.
3. **Owner writes.** Each asserts that the caller is the account itself and that 1 yoctoNEAR is attached, then increments `revision`. The methods:
   - `set_mandate(agent_id, path, daily_cap, expires_at, fixed, recipients)`: initial recipients can be included in the same call, so one signature covers the whole approval.
   - `approve_recipient`
   - `remove_recipient`
   - `revoke_mandate`
   - `pause` and `resume`
   - `set_account_daily_cap`

   A fixed mandate rejects every edit except revocation.
4. **`on_execute(ctx)`.** Runs in this order:
   1. Check the caller is the trusted registry, payments are not paused, and the request is not a duplicate.
   2. If `expected_revision` is set, it must match.
   3. Find the mandates along `ctx.path`. There must be at least one.
   4. For each mandate found, its stored path must equal the matching prefix of `ctx.path`, including generations. Otherwise return `MANDATE_STALE`.
   5. Check status and expiry, then the recipient rule and the per-payment cap.
   6. Check the recipient, mandate, and account daily caps against settled plus reserved usage.
   7. Check available balance: `account_balance − storage cost − reserved_total − safety buffer`. The buffer defaults to 0.5 NEAR and is configurable.
   8. Reserve the amount on every counter, store the `Request`, and dispatch `Promise::new(recipient).transfer(amount).then(on_settle)`.
5. **`on_settle(key)`.** It is `#[private]`. On success, move the amount from reserved to settled. On failure, release the reservation. A second call is a no-op.
6. **Request retention.** Keep request records for 2 days so that duplicate request IDs are detected. Prune up to 5 expired records during each `on_execute`, so storage on the owner's account stays bounded.
7. **Bounded activity log.** Keep a ring buffer of the last 64 outcomes, settled and denied, preallocated at `initialize`. Denials write only into the ring buffer and the event log.
8. **Views:** `preview(ctx)` runs every check without changing state; also `get_mandate`, `get_rules`, `get_usage`, `get_request`, `get_activity`, and `get_revision`.

**Tests:**
- every denial code
- the README's limit example, step by step
- simultaneous requests near a cap
- removing and re-adding a recipient preserves usage
- a stale generation after a transfer
- a fixed mandate rejects edits
- a transfer to a missing account fails and releases the reservation
- duplicate request IDs and duplicate callbacks
- a direct `on_execute` call from another account
- a function-call key on the owner account cannot do owner writes
- ring buffer and request pruning stay within their bounds

**Exit criteria:** all tests pass in sandbox. On Testnet, a payment from `alice.testnet` settles and its receipt shows Alice as the source.

## Phase 3: Agent tree and branch mandates

**Goal:** leaf agents under a parent, branch control, and one budget pool per branch.

**Work**

1. **`create_child(parent_id, label, executor, capabilities, expires_at, locks)`.** It is `#[payable]` and called by the parent's holder.
   - The child's handle is `<label>.<parent handle>`, and its depth must stay within `MAX_DEPTH`.
   - Its capabilities and expiry must fit inside the parent's.
   - The child is minted to the parent's holder.
2. **`remove_agent(id)`.** Marks the agent `Removed` and burns the token. Descendants fail the ancestry check with `BRANCH_REMOVED`, at constant cost.
3. **Ancestor authority.** Owner operations accept the holder of any ancestor. Pause authority follows `Paused { by_depth }`.
4. **Path checks in `execute`.** Walk the stored ancestor list. Each node must be active and not expired, and must allow the action within its cap. Return `BRANCH_PAUSED`, `BRANCH_REMOVED`, or `BRANCH_EXPIRED` for an ancestor.
5. **Branch mandates.** The policy contract already looks up mandates along the path (Phase 2). Here, add tests for two leaves drawing from a parent's pool, and for a leaf mandate tighter than its branch mandate.
6. **`get_children(id, from, limit)`** for the app's tree view.

**Tests:**
- a depth-8 chain, and rejection at depth 9
- a child wider than its parent is rejected
- narrowing a parent narrows its existing children at execution
- a parent pause stops the leaf; a leaf holder cannot resume a pause set by an ancestor
- removing a parent stops its branch
- two leaves share one pool
- transferring the root invalidates branch mandates
- the gas measurement from S5 holds

**Exit criteria:** tests pass, and the measured gas for depth 8 is under the budget fixed in Phase 0.

## Phase 4: Records

**Goal:** applications can attach their own data to an agent token.

**Work**

1. **Writes.** `set_record(agent_id, key, value)` is `#[payable]`, and the writer pays for storage. `remove_record` refunds the storage.
2. **Key format.** Keys are `<namespace>.<name>`:
   - namespace: lowercase `[a-z0-9-]`, 1–32 characters
   - name: up to 64 characters
   - value: up to 1 KB
   - at most 64 records per agent
3. **Who writes.** Holder only in this phase.
4. **Views and events.** Views `get_records(agent_id, from, limit)` and `get_record(agent_id, key)`. Events `record_set` and `record_removed`.
5. **Documented keys.** Document the standard keys `profile.description`, `profile.url`, and `mcp.endpoint`.
6. **Policy boundary.** Neither contract reads records in any policy decision.

**Tests:** size limits; storage charged and refunded; a non-holder is rejected; records survive a transfer, and the new holder can edit them.

**Exit criteria:** tests pass.

## Phase 5: SDK, templates, and validation

**Goal:** one TypeScript library used by the runner, the web app, and later the CLI and MCP.

**Work**

1. **`packages/sdk`.**
   - **Types:** Zod schemas matching the ABI, with `bigint` amounts and decimal strings in JSON.
   - **Read client:** `resolve`, `getAgent`, `getPath`, `getChildren`, `getRecords`, `getMandate`, `getUsage`, `getActivity`, `preview`, `getAccountCodeHash`.
   - **Owner transaction builders:** each returns NEAR Connect action lists for wallet signing. They cover `registerAgent`, `createChild`, `setCapabilities`, `burnLocks`, `setRecord`, `enablePayments` (deploy and initialize), `setMandate`, `approveRecipient`, `removeRecipient`, `revokeMandate`, `pause`, and `resume`.
   - **Executor client:** `execute(request)` generates a 32-byte request ID and writes to an operation journal.
   - **Operation journal:** states are prepared, submitted, settled, denied, failed, and uncertain. Storage is pluggable (memory, file, or `localStorage`). An uncertain request is resolved by reading the transaction status and the payer's `get_request`. It is resubmitted only with the same request ID.
2. **`packages/templates`.**
   ```ts
   interface Template<I> {
     id: string; version: number; title: string; description: string;
     input: z.ZodType<I>; defaults: Partial<I>;
     build(input: I, ctx: { now: bigint; owner: string; payer: string }): Plan;
   }
   interface Plan { steps: { title: string; receiverId: string; actions: Action[] }[] }
   ```
   - `build` is deterministic: no clock reads, no randomness, no network.
   - Built-in **Approved vendors** template: one agent, an optional leaf, a daily budget, and recipients with their own caps.
3. **`validate(plan, chain?)`.** Static checks always run:
   - a recipient equal to the executor or the payer
   - a zero or missing cap
   - a child wider than its parent, or an expiry later than the parent's
   - an unsupported action
   - a duplicate recipient

   Live checks run when a chain client is given:
   - the parent's current capabilities and locks
   - the payer's code hash against the manifest
   - the payer's balance against the daily caps (a warning, not an error)

**Tests:** Vitest unit tests for every builder, every template, and every validation rule. Integration tests against the sandbox contracts from Phases 1–4.

**Exit criteria:** the runner and the web app can import the SDK, and the template's output, once signed in sandbox, produces the expected on-chain state.

## Phase 6: Agent runner

**Goal:** a script-driven agent that uses only the restricted key.

**Work**

1. `apps/runner` loads the executor's function-call key from an environment variable or keystore file. The key is never logged.
2. Scenario files in JSON list requests: recipient, amount, and optional delay or concurrency. Provide scenarios for the demo: success, unapproved recipient, over the cap, daily cap, branch pool, after pause, and duplicate request.
3. Use the SDK's operation journal on disk. Print each outcome with its reason code and transaction hash.

**Tests:** the scenarios run against the sandbox, and the journal recovers after the process is killed mid-request.

**Exit criteria:** every demo scenario produces its expected outcome against the sandbox.

## Phase 7: Web app

**Goal:** an owner manages everything from Meteor without a backend.

**Work**

1. **Connect:** NEAR Connect with Meteor, showing the account ID and balance.
2. **Agents:**
   - list with `nft_tokens_for_owner`, plus a tree view from `get_children`
   - register an agent, create a child, edit capabilities, burn locks, extend expiry, pause, resume, remove
   - edit records
3. **Enable payments:** read the account's code hash.
   - Empty: offer deploy and initialize in one signature.
   - Matches the manifest: show enabled.
   - Anything else: warn that the account already runs another contract, and stop.
4. **Approve recipients:** a wizard built on the Approved vendors template. Run `validate` before signing and show its errors inline. One signature per plan step.
5. **Activity:** the payer's `get_activity` and each agent's registry activity, with reason codes in plain language and links to the explorer.
6. **Controls:** remove a recipient, revoke a mandate, pause and resume payments, and set the account daily cap.

**Tests:** Playwright runs against the sandbox with a test wallet for every flow above.

**Exit criteria:** the full demo can be performed in the app against the sandbox.

## Phase 8: Testnet deployment and demo

**Goal:** the hackathon demo, with evidence.

**Work**

1. Build reproducibly and record the WASM hashes. Deploy the registry, and publish the policy as a global contract if S2 passed. Write `deployments/testnet.json` with the network, account IDs, hashes, ABI version, and source revision.
2. Create and fund the demo accounts. Give the executor its restricted key only.
3. Rehearse every scene in `docs/demo.md`, record the transaction hashes there, and capture the recording.

**Exit criteria:** every scene in `docs/demo.md` is ready, with evidence.

---

## Phase 9: CLI and MCP

**Work**

1. **CLI.** `packages/cli` (Commander) covers agent, tree, record, policy, and activity commands. It prepares unsigned owner transactions, or signs with a local full-access key only when the user explicitly passes one. `agent doctor` reports an executor key that is not restricted to `registry.execute`.
2. **MCP.** `packages/mcp` is a stdio server.
   - Read tools for agents, paths, records, mandates, usage, and activity.
   - `preview_payment` and `prepare_recipient_approval`, which returns an unsigned plan.
   - `execute_payment`, available only when the server starts with an executor key.

   Safety rules:
   - Tool inputs never accept keys.
   - Every call rereads the current policy.
   - An optional `--max-payment` ceiling applies per process.

**Exit criteria:** an agent framework on a laptop pays within a mandate through MCP, and `preview_payment` matches the SDK.

## Phase 10: Payment rule extensions

**Work**

1. **Payment count limits.** `max_payments_per_period` on recipient rules, with daily, weekly, and monthly periods. A monthly period is a calendar month in UTC. "One payment per billing period" is this rule set to 1.
2. **Human approval above a threshold.**
   - A request above `approve_above` is stored as pending, with its amount reserved.
   - The owner calls `approve(request_id, expected_revision)` or `reject`.
   - Anyone can call `expire` after the deadline.
   - Pending requests are capped in number so storage stays bounded.
3. **Fungible tokens.** Add `TransferFt` for NEP-141 tokens:
   - per-token caps
   - storage registration of the recipient (NEP-145)
   - `ft_transfer` with 1 yoctoNEAR attached from the policy contract
   - settlement through the callback result

**Exit criteria:** sandbox tests for each rule. The app shows pending approvals.

## Phase 11: Team roles and payroll

**Work**

1. **Grants.**
   - Roles are `MANAGE`, `PAUSE`, `PROPOSE`, `RECORDS(namespace)`, and `USE(payer)`, with expiry, revocation, and a `grantable` mask.
   - A grant is bound to the generation, and delegation depth is at most 2.
   - The executor can never be a grantee.
2. **Manager.** A grant that can edit records, executors, and children, but cannot transfer the token or burn locks. The holder can revoke it at any time.
3. **Propose and approve.**
   - A `PROPOSE` holder submits a pending change on the payer's policy contract: a new recipient, a limit change, or a payout run.
   - Only the owner applies it. Proposals expire, and their count is capped.
4. **Per-namespace record writers.** Writers come from `RECORDS(namespace)` grants.
5. **Tags.**
   - Up to 4 tags per agent, set by the root holder, each with its own pause switch.
   - Execution checks the tag switches as well as the path.
6. **Remaining locks.**
   - `NO_EXECUTOR_CHANGE` and `NO_NEW_CHILDREN`.
   - `PARENT_LET_GO`, which ends ancestor authority over a node and its descendants.
7. **Payroll team template.**
   - A company account is the payer.
   - HR holds `PROPOSE`, and employees are recipients with monthly caps and one payment per month.
   - Salary breakdowns are stored only as hashes in `payroll.*` records.

**Exit criteria:** an end-to-end payroll test in sandbox. HR proposes a hire, the owner approves, the payout run settles within the caps, and HR cannot change limits directly.

## Phase 12: Actions, subscriptions, and integrations

**Work**

1. **`CallContract` action.**
   - An allowlisted contract and method, a maximum attached deposit, and argument constraints: fixed values, allowed sets, and numeric ceilings on named JSON fields.
   - Unconstrained arguments are rejected by `validate` unless explicitly marked open.
   - This is the base for trading adapters.
2. **Trading desk template.** A parent agent with a shared pool, and leaf agents limited to specific venue contracts and methods.
3. **Subscriptions.**
   - **Dashboard cards:** recipient, last payment and its receipt, the next expected renewal, the authorization expiry, and the remaining budget.
   - **Renewal date:** the first settled payment plus one billing period, keeping the original billing day.
   - **Warnings:** low balance, permission expiring soon, or an expected amount above the cap.
   - **Scheduler:** an optional worker submits renewals, and `max_payments_per_period = 1` prevents duplicate charges.
4. **Telegram worker.** Read-only, opt-in, and relays finalized denials and upcoming renewals.
5. **Wallet integration.** A wallet surface for agent limits and pause, signing-origin checks, and blocking of flagged domains.
6. **Assets on other chains.** Design the enforcement point for an asset held on another network before building any adapter for it.

## Phase 13: Hardening and mainnet

**Work**

1. **Policy upgrades.** Versioned state, a `migrate` method callable only by the account itself, and an app flow that shows the new code hash before the owner signs. With global contracts, the owner opts in to the new hash explicitly.
2. **Testing.** Property-based tests for the counters and reservations, plus fuzzing of `on_execute` inputs and of interleaved callbacks.
3. **Audit.** An external audit of both contracts and of the SDK's transaction builders.
4. **Mainnet.** Mainnet deployment, a public manifest, and source verification. Monitoring through events, either with an indexer or with the bounded activity views.

---

## Risks and open decisions

| Item | Risk | Plan |
| --- | --- | --- |
| Deploy from Meteor | The connector may not sign deploy or global-contract actions. | Spike S1 and S2. Fall back to NEAR CLI for the demo account. |
| Contract storage on the user's account | A regular deploy locks part of the user's balance. | Prefer a global contract. Show the cost in the app before enabling. |
| Accounts that already run a contract | Deploying would replace that contract. | The app refuses unless the code hash is empty or matches the manifest. |
| Storage growth from denials | A compromised executor could fill storage with denied requests. | Denials go only to fixed-size ring buffers and events. Request records are pruned. |
| Disabling the policy | There is no "remove contract" action. | Disabling means pause plus revoking all mandates. A later release can offer a minimal replacement contract. |
| Activity without a backend | Reading events needs an indexer. | Use bounded on-chain activity views for the hackathon. Add an indexer later, as an option. |
| Tree depth and gas | Deep paths cost gas on every execution. | `MAX_DEPTH = 8`, measured in S5 and Phase 3. |
| Records are public | Sensitive data could leak. | Hashes and encrypted pointers only, enforced by documentation and `validate` warnings. |

## Mapping to the demo tracker

| Tracker component (`docs/demo.md`) | Phases |
| --- | --- |
| C1 registry | 1, 3, 4 |
| C2 account policy | 2 |
| C3 contract tests | 1–4 |
| C4 Testnet deployment and manifest | 0 (spikes), 8 |
| C5 demo accounts | 8 |
| C6 web app | 7 |
| C7 agent runner | 6 |
| C8 SDK, templates, and `validate` | 5 |
| C9 CLI and MCP | 9 |
| C10 Telegram worker | 12 |
| C11 demo assets | 8 |

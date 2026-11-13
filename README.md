# NEARFirewall

NEARFirewall registers agents and lets a user authorize them to pay from the user's existing NEAR account. Each recipient approval includes its own spending limits. Payments that fit the recipient's limits and the agent's overall budget execute automatically. The account that already holds the funds runs the policy and sends the payment.

**Status:** Live on NEAR Testnet. The registry and a demo payer are deployed (see [`deployments/testnet.json`](deployments/testnet.json)), and scripted agents have made and been refused real payments there. To run it, see the [Testnet runbook](docs/testnet-runbook.md).

## Hackathon MVP

1. **Connect Meteor.** Alice opens the NEARFirewall web app and connects her NEAR Testnet account through NEAR Connect. Her account ID identifies her in the app. [Meteor Wallet SDK](https://github.com/Meteor-Wallet/meteor_wallet_sdk) · [NEAR Connect](https://github.com/fastnear/near-connect)
2. **Register an agent.** Alice chooses a unique handle and links the agent to a separate executor account. The registry mints an agent token to Alice, which makes her the owner, and records the executor as the account allowed to submit its actions. She can create leaf agents under it, each with its own executor. A leaf can only narrow its parent's rules. The demo runner holds a function-call key for the registry's `execute` method. [NEAR access keys](https://docs.near.org/protocol/accounts-contracts/access-keys)
3. **Enable payments on her account.** Deploy the payment-policy contract to Alice's existing Testnet account and initialize it with the trusted registry. Alice's account keeps its address and funds. The policy contract pays directly from that account. Verify deployment and initialization on an eligible Testnet account before the demo. [NEAR deployment and transfer actions](https://docs.near.org/smart-contracts/anatomy/actions)
4. **Approve a recipient with its own limits.** Alice signs an owner transaction in Meteor that allows the agent to pay `vendor.testnet` up to 3 NEAR per payment and 6 NEAR per UTC day. She sets a separate 10 NEAR daily budget across all of the agent's recipients. The recipient approval is reusable until Alice removes it or it expires.
5. **Run the agent.** A 2 NEAR payment to `vendor.testnet` settles automatically. A 4 NEAR request to the same recipient exceeds its per-payment cap and is rejected. A payment to a new recipient is rejected and the app can prompt Alice to approve that recipient with its own limits.
6. **Review activity or pause.** The dashboard shows the outcome and its reason. Alice can remove a recipient, revoke the mandate, or pause agent payments from her account. The agent uses the current policy for each new attempt.

The core demo is a web app, a shared registry, the account policy contract, and a restricted agent runner. Regular owner actions use the public Meteor connector. Test deployment with the chosen Meteor flow. The NEAR CLI can deploy and initialize the contract for an owner-authorized demo account if the connector cannot submit the deployment action. [NEAR CLI](https://github.com/near/near-cli-rs)

## Architecture

| Component | Responsibilities |
| --- | --- |
| NEARFirewall app | Connect Meteor, register agents, show account balance and remaining budget, let owners approve recipients and manage limits, display execution outcomes. |
| Identity and access registry | Mint each agent as a NEAR NFT, resolve agent handles, authenticate the executor, enforce roles and grants, validate the action against the agent's declared capabilities, and route requests to the payer's policy contract. |
| Account policy contract | Run on the user's existing NEAR account. Store its mandates and enforce recipient approvals, spending limits, balance, and pause state before scheduling a transfer. |
| Agent runner | Submit a typed payment request using a restricted key on the separate executor account. |

The parts, and who calls whom:

```text
                  You (wallet) ── every change is signed by you, with 1 yoctoNEAR ──┐
                       │ manage agents                                set rules  │
                       ▼                                                          ▼
executor account ── execute ──▶ registry (agent NFTs) ── forward ──▶ your account (payment policy)
 (restricted key)                                                                 │ NEAR
                                                                                  ▼
                                                                              recipient
```

A payment, step by step:

```text
executor           registry                    your account (policy)               recipient
   │ 1 execute ──▶ │ 2 check agent and path     │                                    │
   │ ◀─ ✕ denied ── │   (nothing reaches you)    │                                    │
   │               │ 3 forward ───────────────▶ │ 4 check every rule                 │
   │ ◀────────────────────────── ✕ denied ───── │   (nothing reserved or sent)       │
   │               │                            │ 5 reserve the amount               │
   │               │                            │ 6 send NEAR ─────────────────────▶ │
   │               │                            │ 7 settle; a failed transfer is released
   │ ◀────────── 8 the outcome (settled, failed, denied + reason) is the transaction's value
```

Which rule wins: every check must pass, in this order, and the first failure returns its reason:

```text
registry   agent exists, request from its executor, request ID valid
           for each agent from the top of the tree down: not removed → not paused → not expired → capability allows the amount
           the paying account holds the requesting agent
policy     request from the trusted registry, request ID unused → payments on → policy revision (if asked)
           for each approval on the agent's path: not revoked → not stale → not expired
               → recipient approved → rule unexpired → per-payment → recipient daily → branch daily
           at least one approval → account daily cap → available balance
```

The registry accepts the registered executor, checks access, and forwards a typed payment request. The payer's contract accepts routed requests from the registry account configured at initialization and checks its own mandate independently. NEAR executes the registry call, policy call, transfer, and settlement callback in separate receipts. [NEAR cross-contract calls](https://docs.near.org/smart-contracts/anatomy/crosscontract)

## Agent identity and access

Each agent is a non-fungible token. The registry contract implements the NEAR NFT standard, and the token ID is the agent ID. Token IDs are assigned sequentially and never reused, so a new agent can never match an old mandate. The token holder is the agent's owner. Wallets, explorers, and other contracts discover agents through the standard views. Other protocols build on top of the token: they resolve an agent with `nft_token` and read its registry record. [NEP-171 core](https://github.com/near/NEPs/blob/master/neps/nep-0171.md) · [NEP-177 metadata](https://github.com/near/NEPs/blob/master/neps/nep-0177.md) · [NEP-178 approvals](https://github.com/near/NEPs/blob/master/neps/nep-0178.md) · [NEP-181 enumeration](https://github.com/near/NEPs/blob/master/neps/nep-0181.md)

The registry record, keyed by token ID, stores the unique handle, parent and ancestor list, executor account, metadata, capability rules, active status, expiry, locks, and generation. The owner can pause the agent and rotate its executor.

The token carries ownership of the agent, not access to anyone's funds. Every transfer advances the generation, as does an executor change. Grants issued under the prior generation stop working. Payer mandates are bound to the generation, so a new holder starts with no spending authority until each payer approves the agent again. Transfers clear token approvals as the standard requires. `nft_transfer` needs 1 yoctoNEAR, so only the holder's full-access key can move the token; the executor's restricted key cannot. An owner can mark an agent non-transferable at registration. Roles can include owner, administrator, operator, and a scoped `USE` grant for a future renter. The registry binds a renter's grant to their payer account and enforces its expiry and revocation.

The agent's runtime key lives on its executor account and is restricted to a zero-deposit call to `registry.execute`. The payer's owner keys stay under the owner's control. An owner can authorize payments by their own agent through a mandate on their account. A renter needs both a registry access grant and a mandate on the renter's own paying account. [NEAR access keys](https://docs.near.org/protocol/accounts-contracts/access-keys)

### Agent tree

An agent token can have a parent agent token. The owner registers a top-level agent. Its holder can create child agents under it. The agent that actually performs a task is usually a leaf. Each child is its own token with its own executor, minted to the parent's holder. A child transferred to another holder stays under its parent's control. It can no longer spend from the previous holder's account: the registry routes a payment only when the payer holds the agent making the request.

- **Children only narrow.** A child inherits its parent's capability rules and expiry and can only narrow them: fewer actions, lower per-action caps, an earlier expiry. The registry checks this when a node is created or edited. Each execution also checks the action against every node on the path, so narrowing a parent immediately narrows its whole branch.
- **Fixed ancestry.** The registry stores each node's ancestor list at creation, up to a maximum depth of 8. Nodes never move. To move an agent, create a new token under the new parent.
- **Branch control.** The holder of an ancestor can pause a branch, rotate a descendant's executor, or remove a descendant. On every execution the registry checks status, expiry, and locks along the stored ancestor list, all inside one contract. Pausing a node stops its whole branch on the next attempt.

### Locks and expiry

Each agent token has an optional expiry. A child's expiry cannot exceed its parent's. Expiry can be extended but never shortened. To stop an agent sooner, its owner pauses or removes it. An expired agent cannot execute.

Locks are one-way flags on a token. They cannot be cleared for the life of the token, so payers and other applications can read them and rely on them.

| Lock | Guarantee | Release |
| --- | --- | --- |
| `NO_TRANSFER` | The token cannot be transferred. | MVP |
| `NO_CAPABILITY_RAISE` | The agent's capability rules can only narrow. | MVP |
| `NO_EXECUTOR_CHANGE` | The executor cannot be rotated. | Planned |
| `NO_NEW_CHILDREN` | No child agents can be created under the token. | Planned |
| `PARENT_LET_GO` | The parent permanently gives up control of the node. | Planned |

### Records

Each agent token carries records: string keys and values that any application can read through the registry. Keys are namespaced by the application that uses them, for example `profile.description`, `mcp.endpoint`, or `payroll.breakdown_hash`.
- **Writing.** The token holder writes records in the first release. Later releases add per-namespace writer roles. The writer pays for the storage. Keys and values have size limits.
- **No authority.** Records never grant authority; the registry and the payer's policy do not read them when deciding a payment.
- **Public.** Store a hash or an encrypted pointer for anything sensitive, never the value itself.

## Recipient approvals and limits

A mandate is keyed by agent ID in the payer's account policy contract. It stores the generations of the agent and its ancestors at approval, a fixed flag, status, revision, expiry, and overall spending caps. Each recipient rule is keyed by the agent ID and recipient account ID and stores the per-payment limit, daily limit, and optional expiry. An optional account-wide daily cap aggregates across agents. A payment must fit the recipient rule, the agent's remaining budget, and any account-wide cap.

A payer can approve an agent at any level of a tree.
- **Branch pools.** A mandate on a parent covers its whole branch, and its overall budget is one pool shared by every agent below it. A leaf can also have its own mandate with tighter limits.
- **Path check.** The registry forwards the leaf and its ancestor path, with each node's generation. The payer looks up mandates along that path, and a payment must fit every mandate it finds. Usually only one or two counters update, whatever the depth.
- **Path binding.** When a mandate is set, it records the generation of its node and of every ancestor. A transfer or executor change anywhere on that path voids it.
- **Fixed mandates.** An owner can mark a mandate fixed when creating it. A fixed mandate cannot be edited, only revoked and replaced.

| Request | Result |
| --- | --- |
| Approved recipient, amount within all limits | Send automatically. |
| Recipient has no active rule | Return `RECIPIENT_NOT_APPROVED`. The app offers an owner-signed **Approve recipient** action that requires the recipient's payment and daily limits. |
| Amount exceeds a recipient or overall limit | Return the reason and identify the limit that blocked the request. |
| Mandate expired, paused, or revoked | Return the relevant denial. |

Only the owner can approve or remove a recipient, change a recipient limit or mandate, or resume payments. Require a direct call from the payer account with an attached 1 yoctoNEAR for owner writes. One owner signature saves the recipient and its limits together. After approval, the agent can submit a fresh request under the updated policy. The agent-wide budget stays in force. [NEAR function-call key restrictions](https://docs.near.org/protocol/accounts-contracts/access-keys)

Use native NEAR for the MVP. Represent amounts as checked `u128` in yoctoNEAR, decimal strings in JSON, and `bigint` in TypeScript. Derive the daily window from the chain timestamp in UTC. Track daily usage by stable agent and recipient account, and track aggregate usage by agent and payer. Editing a rule or removing and re-adding the same recipient preserves the amount already used that day. [NEAR transfer actions](https://docs.near.org/smart-contracts/anatomy/actions)

## Execution and settlement

1. **Submit a typed request.** The agent calls `registry.execute(payer, agent_id, grant_id, action, request_id, expected_revision)` with a `TransferNear` action containing the recipient and amount. The registry checks the executor, agent status, expiry, capability, and applicable access grant, plus the status, expiry, and locks of every ancestor. The grant ID is optional when the payer owns the agent.
2. **Recheck at the payer.** The registry forwards the authenticated leaf identity, its ancestor path with each node's generation, the executor, the typed action, and the request ID to the payer's policy contract. The payer checks the registry caller, the local mandate and revision, pause and expiry, recipient, amount, available balance, and remaining budgets.
3. **Reserve and dispatch.** In the same receipt, record the request ID and reserve its amount against the recipient, agent, and account budgets that apply. Construct the native transfer from the validated recipient and amount. Funds move from the payer's NEAR account to the recipient.
4. **Settle.** A private callback records success or failure. Success counts toward the original window. Failure releases the reservation. Duplicate requests and callbacks must be idempotent. Keep unresolved reservations pending until the transfer outcome is established. [NEAR cross-contract callbacks](https://docs.near.org/smart-contracts/anatomy/crosscontract)
5. **Report.** Return policy denials as structured outcomes with a reason code and emit a NEP-297 event from the rejecting contract. The app reads the relevant receipt and execution status before showing success or denial. An optional read-only Telegram worker can relay finalized denials to an opted-in owner. [NEP-297 events](https://github.com/near/NEPs/blob/master/neps/nep-0297.md) · [NEAR transaction status](https://docs.near.org/api/rpc/transactions) · [Telegram Bot API](https://core.telegram.org/bots/api#sendmessage)

Local recipient removal, mandate revocation, and pause take effect for requests whose payer-side check runs after the change. A registry pause stops new routing. An already routed request still encounters the payer's local policy. An already dispatched transfer can settle. The owner's ordinary wallet transactions use the owner's existing account authority. The payment contract governs delegated agent spending through its execution method.

## Contract and developer interfaces

| Interface | Planned methods |
| --- | --- |
| Registry | `register_agent` (mints the agent token), `resolve`, `set_executor`, `grant`, `revoke`, `pause`, `execute` |
| Registry, NFT standard | `nft_transfer`, `nft_transfer_call`, `nft_token`, `nft_metadata`, `nft_approve`, `nft_revoke`, `nft_is_approved`, `nft_tokens_for_owner`, `nft_supply_for_owner` |
| Registry, tree, locks, and records | `create_child`, `remove_agent`, `set_capabilities`, `extend_expiry`, `burn_locks`, `set_record`, `remove_record`, `get_records`, `get_path` |
| Account policy, owner | `initialize`, `set_mandate`, `approve_recipient(agent_id, recipient, per_payment_cap, daily_cap, expires_at)`, `remove_recipient`, `revoke_mandate`, `pause`, `resume` |
| Account policy, execution | `on_execute` from the trusted registry, private `on_settle`, and read-only `preview`, `get_mandate`, `get_usage`, `get_request` |
| TypeScript SDK and CLI | Resolve agents, prepare unsigned owner transactions for wallet signing, preview an action, submit as the registered executor, and read execution outcomes. |
| Templates | `@nearfirewall/templates`: built-in and custom templates with `build(input, { now })`, plus `validate(plan)`. |
| MCP | Read agent policy and execution state, preview payment requests, and prepare an unsigned recipient approval for owner review. Tool inputs never carry keys. Every call rereads the current policy. An optional per-process payment ceiling is set when the server starts. |

### Templates and validation

A template turns a few inputs into the owner transactions for one use case.
- **Shape.** It has display metadata, an input schema, defaults, and a deterministic `build(input, { now })`.
- **Output.** `build` returns unsigned owner actions: agents and children to create, capability rules, mandates, and recipient rules. Building is local; the owner still reviews and signs in the wallet.
- **Distribution.** `@nearfirewall/templates` ships the built-ins. Developers write their own against the same exported interface, without changing the contracts or registering anything on chain.

| Template | Release | Builds |
| --- | --- | --- |
| Approved vendors | MVP | One agent, a daily budget, and recipients with their own caps |
| Trading desk | Planned | A parent agent with leaf agents, a shared branch pool, and allowlisted venue actions |
| Payroll team | Planned | A payroll agent, employees as recipients with monthly caps, and a proposer role |
| Subscription | Planned | A merchant recipient with one payment per billing period |

Before the owner signs, `validate(plan)` in the SDK and the web app rejects unsafe or unsupported combinations, such as:
- a recipient that is the executor or the payer itself
- a missing or zero cap
- a child wider than its parent, or an expiry later than the parent's
- a plan that conflicts with a burned lock
- an unsupported action

The contracts enforce the hard rules regardless; validation catches mistakes before a signature.

### Operation states

The SDK, runner, and app track every payment request through these states:
- **Prepared**, then **submitted**.
- **Settled**, **denied**, or **failed** once the outcome is known.
- **Uncertain** after a timeout or a missing receipt. This is not a failure. It is resolved by reading the outcome, or by resubmitting with the same request ID, which the payer treats idempotently. An uncertain payment is never retried under a new request ID.

### Deployment

The deployment manifest records the network, registry address, expected account-policy WASM hash, ABI version, and source revision. Deploy only to an eligible Testnet account with an available deployment slot or a compatible policy upgrade path. Verify the deployed hash before enabling agent payments. Deploy and initialize owner authority in one batch authorized by the payer. The agent cannot change the payer's code or policy using its restricted executor key. [NEAR account keys](https://docs.near.org/protocol/accounts-contracts/access-keys) · [NEAR deployment actions](https://docs.near.org/smart-contracts/anatomy/actions)

## Technology stack

| Area | Technology |
| --- | --- |
| Contracts and events | Rust, Cargo, WASM, `near-sdk`, `near-contract-standards` for the NFT standard, Borsh state, Serde JSON, NEP-297. [NEAR Rust SDK](https://github.com/near/near-sdk-rs) · [near-contract-standards](https://github.com/near/near-sdk-rs/tree/master/near-contract-standards) · [NEP-297](https://github.com/near/NEPs/blob/master/neps/nep-0297.md) |
| Deploy and verify | `cargo-near`, NEAR CLI, and NEAR Testnet. [cargo-near](https://github.com/near/cargo-near) · [NEAR CLI](https://github.com/near/near-cli-rs) |
| Wallet and web app | React, Vite, TypeScript, Meteor through `@fastnear/near-connect`. [React](https://react.dev/learn) · [Vite](https://vite.dev/guide/) · [NEAR Connect](https://github.com/fastnear/near-connect) |
| SDK and runner | Node.js 24 (runs TypeScript directly), TypeScript, npm workspaces (a pnpm workspace file is included), Zod, `near-api-js` for the runner's signing, and NEAR JSON-RPC. Commander for the CLI. [near-api-js](https://github.com/near/near-api-js) · [npm workspaces](https://docs.npmjs.com/cli/using-npm/workspaces) · [Zod](https://zod.dev/) · [Commander](https://github.com/tj/commander.js) |
| Verification | Rust unit tests, `near-workspaces` with NEAR Sandbox, Vitest, Playwright, GitHub Actions. [NEAR Sandbox testing](https://docs.near.org/smart-contracts/testing/integration-test) · [near-workspaces](https://github.com/near/near-workspaces-rs) · [Vitest](https://vitest.dev/guide/) · [Playwright](https://playwright.dev/docs/intro) · [GitHub Actions](https://docs.github.com/en/actions) |
| Follow-up integrations | Model Context Protocol TypeScript SDK over stdio and Telegram Bot API. [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) · [Telegram Bot API](https://core.telegram.org/bots/api) |

## Testnet acceptance

- Start with Alice's funded Testnet account. Record its address and verify it is the source of the final payment receipt.
- Attempt to pay an unapproved recipient and verify that no funds move. Approve that recipient once in Meteor. Send two allowed payments and confirm both settle without further owner signatures.
- Give two recipients different caps. Exhaust one recipient's daily budget and verify that the other still works while the agent has overall budget. Verify that switching recipients cannot bypass the overall cap and that removing and re-adding a recipient preserves its daily usage.
- Exercise per-transfer and daily denials, simultaneous requests near the daily cap, stale policy versions, recipient removal, expiry, pause, duplicate requests, and settlement failure. Inspect the actual balance and receipts.
- Verify that the agent token appears under Alice in `nft_tokens_for_owner`. Transfer it to another account and verify that the next payment request is rejected until Alice's account approves the new generation.
- Create a leaf under the agent and verify that it cannot exceed its parent's capability rules or expiry. Approve the parent's branch with a shared pool and verify that two leaves draw from the same budget. Pause the parent and verify that the leaf's next request is rejected with `BRANCH_PAUSED`.
- Verify that the executor cannot add recipients, raise limits, or bypass the payer's policy. Show the blocked reason and transaction result in the web app.

## Future wallet integration

A native wallet interface can surface agent limits, approved recipients, pause controls, and activity. The wallet's signing layer can check the verified dApp origin before accepting a signing request. The wallet browser or an installed browser extension can block navigation to domains flagged by an authenticated feed. These domain controls apply to the browsing and signing surfaces. Agent payments are independently governed by the payer account's on-chain policy. [Chrome request rules](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest)

Planned policy extensions:
- A manager role that edits records, executors, and children without being able to transfer the token or burn locks.
- Propose and approve: a role such as HR proposes recipients or limits, and only the owner approves.
- Per-namespace record writers.
- Tags that group agents across branches, each with its own pause switch.
- A maximum number of payments per period, and human approval above a threshold.
- The remaining locks.

The [implementation plan](docs/implementation-plan.md) orders this work by phase.

Additional work can extend the same model to fungible assets, typed trading adapters, paid rentals, and an optional Telegram alert worker. Asset transfers use the account's own token balance and the applicable token standards. [NEP-141 fungible tokens](https://github.com/near/NEPs/blob/master/neps/nep-0141.md) · [NEP-145 storage management](https://github.com/near/NEPs/blob/master/neps/nep-0145.md)

## Repository

```text
contracts/types            shared Rust types: actions, capabilities, reason codes, ExecContext, Outcome
contracts/registry         agent NFT, tree, locks, records, execute router
contracts/account-policy   policy contract deployed on payer accounts
packages/sdk               TypeScript client, owner transaction builders, executor client, operation journal
packages/templates         templates, plans, and validate()
apps/runner                agent runner and demo scenarios
apps/web                   web app (React, Vite, NEAR Connect)
deployments                deployment manifests
docs                       implementation plan and Testnet runbook
```

```bash
git clone https://github.com/ConduenceAi/NEARFirewall.git
cd NEARFirewall
cargo test --workspace          # contract unit tests
npm ci
npm test                        # SDK, templates, runner tests
npm run typecheck
npm run web:dev                 # web app on http://localhost:5173
npm run runner -- apps/runner/scenarios/readme-limits.json --preview
```

Building deployable WASM needs `cargo-near` (`npm run contracts:build`). On Windows, `.cargo/config.toml` lets the contract unit tests build without NASM. The [Testnet runbook](docs/testnet-runbook.md) covers accounts, deployment, the restricted executor key, and running the demo.

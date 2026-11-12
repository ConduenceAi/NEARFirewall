# NEARFirewall

NEARFirewall registers agents and lets a user authorize them to pay from the user's existing NEAR account. The user approves recipients and sets spending limits. Payments to an approved recipient within those limits execute automatically. The account that already holds the funds runs the policy and sends the payment.

**Status:** Implementation specification. The first deployment target is NEAR Testnet.

## Hackathon MVP

1. **Connect Meteor.** Alice opens the NEARFirewall web app and connects her NEAR Testnet account through NEAR Connect. Her account ID identifies her in the app. [Meteor Wallet SDK](https://github.com/Meteor-Wallet/meteor_wallet_sdk) · [NEAR Connect](https://github.com/fastnear/near-connect)
2. **Register an agent.** Alice chooses a unique handle and links the agent to a separate executor account. The registry records Alice as owner and the executor as the account allowed to submit its actions. The demo runner holds a function-call key for the registry's `execute` method. [NEAR access keys](https://docs.near.org/protocol/accounts-contracts/access-keys)
3. **Enable payments on her account.** Deploy the payment-policy contract to Alice's existing Testnet account and initialize it with the trusted registry. Alice's account keeps its address and funds. The policy contract pays directly from that account. Verify deployment and initialization on an eligible Testnet account before the demo. [NEAR deployment and transfer actions](https://docs.near.org/smart-contracts/anatomy/actions)
4. **Approve a recipient and set limits.** Alice signs an owner transaction in Meteor that allows the agent to pay `vendor.testnet`, up to 5 NEAR per transfer and 10 NEAR per UTC day. The recipient approval is reusable until Alice removes it or the mandate expires.
5. **Run the agent.** A 2 NEAR payment to `vendor.testnet` settles automatically. A payment to a new recipient is rejected and the app can prompt Alice to approve that recipient. A request above a hard limit is rejected even when its recipient is approved.
6. **Review activity or pause.** The dashboard shows the outcome and its reason. Alice can remove a recipient, revoke the mandate, or pause agent payments from her account. The agent uses the current policy for each new attempt.

The core demo is a web app, a shared registry, the account policy contract, and a restricted agent runner. Regular owner actions use the public Meteor connector. Test deployment with the chosen Meteor flow. The NEAR CLI can deploy and initialize the contract for an owner-authorized demo account if the connector cannot submit the deployment action. [NEAR CLI](https://github.com/near/near-cli-rs)

## Architecture

| Component | Responsibilities |
| --- | --- |
| NEARFirewall app | Connect Meteor, register agents, show account balance and remaining budget, let owners approve recipients and manage limits, display execution outcomes. |
| Identity and access registry | Resolve agent handles, authenticate the executor, enforce roles and grants, validate the action against the agent's declared capabilities, and route requests to the payer's policy contract. |
| Account policy contract | Run on the user's existing NEAR account. Store its mandates and enforce recipient approvals, spending limits, balance, and pause state before scheduling a transfer. |
| Agent runner | Submit a typed payment request using a restricted key on the separate executor account. |

```text
Alice → NEARFirewall app → Meteor → register agent / approve recipient / set limits
Agent executor → registry.execute → Alice's account policy → approved recipient
                                           │
                                           └─ denial or settlement → activity log
```

The registry accepts the registered executor, checks access, and forwards a typed payment request. The payer's contract accepts routed requests from the registry account configured at initialization and checks its own mandate independently. NEAR executes the registry call, policy call, transfer, and settlement callback in separate receipts. [NEAR cross-contract calls](https://docs.near.org/smart-contracts/anatomy/crosscontract)

## Agent identity and access

A registry record stores the agent ID, unique handle, owner, executor account, metadata, capability rules, active status, and generation. The owner can pause the agent and rotate its executor. Changing ownership or the executor advances the generation and invalidates grants issued under the prior generation. Roles can include owner, administrator, operator, and a scoped `USE` grant for a future renter. The registry binds a renter's grant to their payer account and enforces its expiry and revocation.

The agent's runtime key lives on its executor account and is restricted to a zero-deposit call to `registry.execute`. The payer's owner keys stay under the owner's control. An owner can authorize payments by their own agent through a mandate on their account. A renter needs both a registry access grant and a mandate on the renter's own paying account. [NEAR access keys](https://docs.near.org/protocol/accounts-contracts/access-keys)

## Recipient approvals and limits

A mandate is keyed by agent ID in the payer's account policy contract. It stores the authorized executor and generation, status, revision, expiry, recipient allowlist, per-transfer cap, and daily cap. An optional account-wide daily cap aggregates across agents. A capability rule limits what the agent can request. The mandate limits what the user's account will pay.

| Request | Result |
| --- | --- |
| Approved recipient, amount within all limits | Send automatically. |
| Recipient absent from the allowlist | Return `RECIPIENT_NOT_APPROVED`. The app offers an owner-signed **Approve recipient** action. |
| Amount exceeds a transfer or daily limit | Return the relevant limit denial. The owner manages limits separately. |
| Mandate expired, paused, or revoked | Return the relevant denial. |

Only the owner can add or remove a recipient, change a mandate, or resume payments. Require a direct call from the payer account with an attached 1 yoctoNEAR for owner writes. The agent's restricted execution path has no owner write access. A recipient approval updates policy state. The agent submits a fresh payment request under the updated policy. Recipient approval never changes a spending cap. [NEAR function-call key restrictions](https://docs.near.org/protocol/accounts-contracts/access-keys)

Use native NEAR for the MVP. Represent amounts as checked `u128` in yoctoNEAR, decimal strings in JSON, and `bigint` in TypeScript. Derive the daily window from the chain timestamp in UTC. Key usage by stable agent and day so policy edits preserve already-used budget. [NEAR transfer actions](https://docs.near.org/smart-contracts/anatomy/actions)

## Execution and settlement

1. **Submit a typed request.** The agent calls `registry.execute(payer, agent_id, grant_id, action, request_id, expected_revision)` with a `TransferNear` action containing the recipient and amount. The registry checks the executor, agent status, capability and applicable access grant. The grant ID is optional when the payer owns the agent.
2. **Recheck at the payer.** The registry forwards the authenticated agent identity, executor, generation, typed action, and request ID to the payer's policy contract. The payer checks the registry caller, the local mandate and revision, pause and expiry, recipient, amount, available balance, and remaining budgets.
3. **Reserve and dispatch.** In the same receipt, record the request ID and reserve its amount against the agent and account limits. Construct the native transfer from the validated recipient and amount. Funds move from the payer's NEAR account to the recipient.
4. **Settle.** A private callback records success or failure. Success counts toward the original window. Failure releases the reservation. Duplicate requests and callbacks must be idempotent. Keep unresolved reservations pending until the transfer outcome is established. [NEAR cross-contract callbacks](https://docs.near.org/smart-contracts/anatomy/crosscontract)
5. **Report.** Return policy denials as structured outcomes with a reason code and emit a NEP-297 event from the rejecting contract. The app reads the relevant receipt and execution status before showing success or denial. An optional read-only Telegram worker can relay finalized denials to an opted-in owner. [NEP-297 events](https://github.com/near/NEPs/blob/master/neps/nep-0297.md) · [NEAR transaction status](https://docs.near.org/api/rpc/transactions) · [Telegram Bot API](https://core.telegram.org/bots/api#sendmessage)

Local recipient removal, mandate revocation, and pause take effect for requests whose payer-side check runs after the change. A registry pause stops new routing. An already routed request still encounters the payer's local policy. An already dispatched transfer can settle. The owner's ordinary wallet transactions use the owner's existing account authority. The payment contract governs delegated agent spending through its execution method.

## Contract and developer interfaces

| Interface | Planned methods |
| --- | --- |
| Registry | `register_agent`, `resolve`, `set_executor`, `grant`, `revoke`, `pause`, `execute` |
| Account policy, owner | `initialize`, `set_mandate`, `approve_recipient`, `remove_recipient`, `revoke_mandate`, `pause`, `resume` |
| Account policy, execution | `on_execute` from the trusted registry, private `on_settle`, and read-only `preview`, `get_mandate`, `get_usage`, `get_request` |
| TypeScript SDK and CLI | Resolve agents, prepare unsigned owner transactions for wallet signing, preview an action, submit as the registered executor, and read execution outcomes. |
| MCP | Read agent policy and execution state, preview payment requests, and prepare an unsigned recipient approval for owner review. |

The deployment manifest records the network, registry address, expected account-policy WASM hash, ABI version, and source revision. Deploy only to an eligible Testnet account with an available deployment slot or a compatible policy upgrade path. Verify the deployed hash before enabling agent payments. Deploy and initialize owner authority in one batch authorized by the payer. The agent cannot change the payer's code or policy using its restricted executor key. [NEAR account keys](https://docs.near.org/protocol/accounts-contracts/access-keys) · [NEAR deployment actions](https://docs.near.org/smart-contracts/anatomy/actions)

## Technology stack

| Area | Technology |
| --- | --- |
| Contracts and events | Rust, Cargo, WASM, `near-sdk`, Borsh state, Serde JSON, NEP-297. [NEAR Rust SDK](https://github.com/near/near-sdk-rs) · [NEP-297](https://github.com/near/NEPs/blob/master/neps/nep-0297.md) |
| Deploy and verify | `cargo-near`, NEAR CLI, and NEAR Testnet. [cargo-near](https://github.com/near/cargo-near) · [NEAR CLI](https://github.com/near/near-cli-rs) |
| Wallet and web app | React, Vite, TypeScript, Meteor through `@fastnear/near-connect`. [React](https://react.dev/learn) · [Vite](https://vite.dev/guide/) · [NEAR Connect](https://github.com/fastnear/near-connect) |
| SDK and runner | Node.js, TypeScript, pnpm workspaces, Zod, `near-api-js` and NEAR JSON-RPC. Commander for the CLI. [near-api-js](https://github.com/near/near-api-js) · [pnpm workspaces](https://pnpm.io/workspaces) · [Zod](https://zod.dev/) · [Commander](https://github.com/tj/commander.js) |
| Verification | Rust unit tests, `near-workspaces` with NEAR Sandbox, Vitest, Playwright, GitHub Actions. [NEAR Sandbox testing](https://docs.near.org/smart-contracts/testing/integration-test) · [near-workspaces](https://github.com/near/near-workspaces-rs) · [Vitest](https://vitest.dev/guide/) · [Playwright](https://playwright.dev/docs/intro) · [GitHub Actions](https://docs.github.com/en/actions) |
| Follow-up integrations | Model Context Protocol TypeScript SDK over stdio and Telegram Bot API. [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) · [Telegram Bot API](https://core.telegram.org/bots/api) |

## Testnet acceptance

- Start with Alice's funded Testnet account. Record its address and verify it is the source of the final payment receipt.
- Attempt to pay an unapproved recipient and verify that no funds move. Approve that recipient once in Meteor. Send two allowed payments and confirm both settle without further owner signatures.
- Exercise per-transfer and daily denials, simultaneous requests near the daily cap, stale policy versions, recipient removal, expiry, pause, duplicate requests, and settlement failure. Inspect the actual balance and receipts.
- Verify that the executor cannot add recipients, raise limits, or bypass the payer's policy. Show the blocked reason and transaction result in the web app.

## Future wallet integration

A native wallet interface can surface agent limits, approved recipients, pause controls, and activity. The wallet's signing layer can check the verified dApp origin before accepting a signing request. The wallet browser or an installed browser extension can block navigation to domains flagged by an authenticated feed. These domain controls apply to the browsing and signing surfaces. Agent payments are independently governed by the payer account's on-chain policy. [Chrome request rules](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest)

Additional work can extend the same model to fungible assets, typed trading adapters, paid rentals, and an optional Telegram alert worker. Asset transfers use the account's own token balance and the applicable token standards. [NEP-141 fungible tokens](https://github.com/near/NEPs/blob/master/neps/nep-0141.md) · [NEP-145 storage management](https://github.com/near/NEPs/blob/master/neps/nep-0145.md)

## Repository

```bash
git clone https://github.com/ConduenceAi/NEARFirewall.git
cd NEARFirewall
```

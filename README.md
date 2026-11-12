# NEARFirewall

NEARFirewall is a NEAR-native protocol for registering agents, delegating access to them, and enforcing what they can do with a user's funds. An owner registers an agent once. Each renter receives a separate, expiring access grant and funds a vault under their own financial mandate. The vault checks the renter's authorization, the agent's capabilities, and the financial limits before it spends.

**Status:** Implementation specification. The contracts, SDK, CLI, MCP server, and marketplace below are planned. The first deployment target is NEAR Testnet.

## Architecture

| Layer | Question it answers | Enforcement point |
| --- | --- | --- |
| Agent access | Who may manage or use this agent? | The Access Controller checks ownership, role scope, the grant's validity, and delegation rules. |
| Agent permissions | Which operations may the agent perform? | The Permission Manager matches a typed action against the active network, contract, method, and resource rules. |
| Financial access | What may the agent do with this user's money? | The Financial Controller checks the selected vault's balance, restrictions, and budget before reserving funds. |

Deploy one shared Rust contract for the MVP. The registry, access controller, permission manager, financial controller, execution manager, and audit functions are Rust modules with separate state keys. Keeping those checks in a single contract call lets the execution manager verify current state, consume a request, and reserve its funds in the same receipt. Each vault is a segregated balance in that contract's ledger, with its own owner and limits. Execution and settlement are separate NEAR receipts. [NEAR contract state](https://docs.near.org/smart-contracts/anatomy/storage) · [NEAR asynchronous calls](https://docs.near.org/smart-contracts/anatomy/crosscontract)

| Module | State and responsibilities | Proposed entry points |
| --- | --- | --- |
| Identity Registry | Unique names, agent account and execution key, identity NFT, metadata, ownership generation | `register_agent`, `resolve_agent`, `rotate_agent_key`, NFT methods |
| Access Controller | Scoped role grants, temporary rental grants, expiry, revocation, pause state | `grant_access`, `revoke_access`, `check_access`, `pause_agent` |
| Permission Manager | Versioned allowlists for typed operations and their parameters | `set_policy`, `check_permission` |
| Financial Controller | Vault ownership, funded balances, limits, reservations, settlement | `create_vault`, `deposit_near`, `set_vault_limits`, `set_mandate`, `get_mandate`, `pause_vault`, `withdraw_available` |
| Execution Manager | Renter requests, agent verification, replay protection, dispatch, callback | `request_action`, `cancel_request`, `preview_action`, `execute_intent`, private `on_execution_result` |
| Audit and listings | Versioned events, execution records, owner-managed listings and rental requests | `get_execution`, `publish_listing`, `list_listings`, `request_rental`, `approve_rental` |

### Contract state

| Record | Primary key | Fields used during authorization |
| --- | --- | --- |
| `Agent` | `agent_id` | Canonical name, execution account and public key, ownership and key generations, pause state |
| `AccessGrant` | `grant_id` | Agent, principal, role, action scope, issuer, ownership generation, expiry, revision, revocation status |
| `ActionPolicy` | `agent_id` | Ownership generation, revision, allowed action rules, network, adapter, target, method, and parameter restrictions |
| `Vault` | `vault_id` | Vault owner, credited and reserved balances, vault-wide daily ceiling, control revision, pause state |
| `Mandate` | `vault_id`, `agent_id`, `grant_id` | Revision, allowed asset and recipients, per-transfer limit, daily limit, expiry, optional lifetime count |
| `Usage` | Vault or mandate key, asset, and UTC day | Pending and settled daily spend. Separate lifetime counters track execution counts. |
| `Execution` | `intent_id` | Renter, action, selected grant and vault, revision snapshot, expiry, nonce, reservation bucket, status |

Use a separate name-to-agent index and a monotonic nonce per renter and vault. Store contract timestamps as integer nanoseconds and expose them as decimal strings. Compute amounts and revisions with checked arithmetic. A vault's available balance is its credited balance minus pending reservations. Successful settlement debits the credited balance and removes the reservation in the same callback.

### Agent identity and ownership

- Register a canonical lowercase label within the application registry, such as `market-agent.alice`. The contract validates a bounded ASCII label format, enforces uniqueness, and uses an immutable agent ID for joins. A registry name resolves to an agent record. Creating an actual NEAR account is a separate transaction.
- Mint a NEP-171 identity NFT keyed by the agent ID. Use NFT ownership as the authority for agent administration. NEP-177 metadata can hold a display name, description, and content URI. Authorization reads the typed on-chain record. [NEP-171 NFT standard](https://github.com/near/NEPs/blob/master/neps/nep-0171.md) · [NEP-177 metadata](https://github.com/near/NEPs/blob/master/neps/nep-0177.md)
- Track an ownership generation on the agent. A completed NFT ownership change invalidates the prior generation's role grants, policies, execution key registration, and listings. Freeze new agent operations during an asynchronous NFT transfer-and-call. If the NFT returns, restore the original owner's configuration. If the transfer completes, the new owner configures and reactivates the agent. Renter vault ownership and withdrawal rights stay with the respective vault owner.
- Bind the agent to a dedicated NEAR account and registered public key. An owner can rotate the key, which increments its generation and invalidates unsubmitted requests tied to the old key. At execution, require a direct call from the registered account and compare its transaction signing key to the registered key. The demo runner uses a function-call key restricted to zero-deposit `execute_intent` calls on the protocol contract. [NEAR access keys](https://docs.near.org/protocol/accounts-contracts/access-keys) · [Rust SDK account and signer context](https://docs.rs/near-sdk/latest/near_sdk/env/index.html)

### Agent access

| Role | Scope |
| --- | --- |
| Owner | Derived from NFT ownership. Controls identity configuration, keys, roles, listings, policies, and agent pause. |
| Administrator | Manages configuration and the grant types the owner explicitly authorizes. Ownership, key rotation, and spending from renter vaults stay outside this role. |
| Operator | Runs or pauses agent operations if those actions are included in its grant. Financial execution still requires a registered execution key and a valid request. |
| Consumer | Requests actions through an approved rental grant, within that grant's expiry, using a vault the consumer owns. |
| Auditor | Uses inspection and audit views. Protocol state and events are public on NEAR. |

A grant records the agent ID, grantee account, role, permitted actions, issuer, expiry, status, and ownership generation. Multiple controllers receive independent grants. In the MVP, the owner or an administrator with explicit grant authority can issue lower-privilege roles. For a later delegated grant chain, record the parent grant and enforce a subset of its capabilities and expiry. Revoking or expiring a parent also invalidates its descendants. A renter may cancel their own access and withdraw their vault's unreserved balance.

### Agent permissions

Use a tagged action type, starting with `TransferNear { recipient, amount_yocto }`. Resolve each action to a known adapter, network, and operation. For contract calls, the adapter also declares the receiver and method, validates the typed parameters, and constructs the call internally. For a native transfer, the approved execution method is `execute_intent` on the deployed protocol contract, and the transfer itself is a native NEAR action.

Rules explicitly allow a capability on the deployment's configured network and bind it to permitted resources such as recipients, asset identifiers, and, for contract calls, the exact receiver and method. Check the intersection of the agent policy and the renter's access scope. Unknown actions, missing matches, expired rules, and out-of-scope parameters fail closed. Optional execution counts apply to the specific policy scope and are reserved at dispatch along with the financial counters.

Public market data and public on-chain balances are available through read clients. A service that exposes private data must enforce the agent and renter scopes at its own API boundary. Trading and order cancellation require individually approved operations and an adapter for the target protocol.

`check_permission` and `preview_action` return a decision, the matching policy version, and a reason code. Their answers describe the state at query time. Only the write path in `execute_intent` can authorize a transfer. [NEAR transfers and function-call actions](https://docs.near.org/smart-contracts/anatomy/actions) · [NEAR contract RPC](https://docs.near.org/api/rpc/contracts)

### Financial mandates

The vault owner funds their vault with a payable `deposit_near` call and creates a mandate bound to the agent, rental grant, and vault. A mandate grants authority over deposited funds only. The agent owner can set a stricter agent-wide policy. Only the vault owner can set or raise that vault's financial limits.

| Control | Implementation |
| --- | --- |
| Per-transfer and daily spend | Compare exact integer amounts against per-transfer, per-mandate daily, and vault-wide daily ceilings. Key daily usage by UTC day derived from the authorization block timestamp. The vault-wide cap aggregates across rental grants. |
| Asset, recipient, and protocol scope | Use the native asset identifier in the MVP. Match recipients against both policy and mandate allowlists. Match future fungible assets by contract account and future trading routes by approved adapter and target. |
| Expiry and count | Check both grant and mandate expiry on-chain. Optional execution caps count pending plus successful operations for the mandate's lifetime. |
| Pause and withdrawal | The agent owner can pause new agent actions. The vault owner can independently pause new spending and withdraw available funds using the same reservation ledger. |
| Exposure and approval | A later trading adapter will track position and pending-order exposure separately from transfers. A human approval rule will bind approval to the exact action and active revisions. The testnet MVP uses native NEAR units and strict spending caps. |

Represent NEAR amounts as checked `u128` values in yoctoNEAR. Use decimal strings in JSON and `bigint` in TypeScript. Account for storage separately from vault deposits, with bounded inputs, storage charged to the relevant caller, and paginated queries. Keep usage counters keyed by stable scope rather than policy revision so policy updates cannot reset consumed budget. [NEAR storage and staking](https://docs.near.org/smart-contracts/anatomy/storage) · [NEP-145 storage management for future fungible assets](https://github.com/near/NEPs/blob/master/neps/nep-0145.md)

## Execution, replay protection, and settlement

1. **Authorize the exact action.** The renter signs a direct wallet transaction calling `request_action(agent_id, vault_id, grant_id, action, expires_at_ns, expected_nonce)`. The contract derives the renter from the caller and checks that they own the vault and hold the active grant. It records the request, the mandate key, the network and protocol account, and the current ownership and key generations and grant, policy, mandate, and vault-control revisions. The expiry is bounded by the grant and mandate. The contract checks and advances the renter's nonce for that vault when it creates the request.
2. **Submit as the registered agent.** The agent signs `execute_intent(intent_id)` with its dedicated account and current execution key. The contract checks the immediate predecessor, signer account, and signing key against the registration. The execution method accepts only the request ID, so the submitted action comes from the record the renter authorized.
3. **Check current state.** Verify that the request is ready and unexpired. Recheck ownership and key generations, grant, policy, mandate, vault-control revisions, pauses, allowed operation and resource scope, funded balance, and remaining budgets. Each policy change, relevant grant or mandate change, or pause/resume advances the corresponding revision. A stale or cancelled request requires a fresh renter authorization.
4. **Reserve and dispatch.** In one contract receipt, transition the request from `Ready` to `Pending`, reserve its amount and any count against the correct vault and mandate buckets, and schedule the native transfer. Concurrent requests see those reservations. The vault uses the stored recipient and amount when constructing the promise.
5. **Settle from the receipt.** A private callback reads the transfer result for that pending execution. Success commits the reserved amount as spent. Failure releases its reservation after the transfer has failed. Settle against the original day and mandate buckets even if the policy changed while the transfer was pending. A duplicate callback cannot settle twice. A failed transfer consumes its request ID and needs a new request for retry.
6. **Report final status.** Emit the request ID, actor IDs, policy revision, and result in a structured event. Clients read the final execution record and receipt outcomes before showing success. Keep unresolved reservations held if a callback fails, and flag them for reconciliation against authoritative receipt outcomes. Revocation blocks new authorizations. Previously dispatched transfers settle from their original receipts. [NEAR asynchronous calls and callbacks](https://docs.near.org/smart-contracts/anatomy/crosscontract) · [NEAR transaction status RPC](https://docs.near.org/api/rpc/transactions) · [NEP-297 events](https://github.com/near/NEPs/blob/master/neps/nep-0297.md)

The enforcement boundary is the shared vault contract and any future adapter that calls an equivalent verifier as part of execution. NEARFirewall's contract account holds pooled testnet funds, and its upgrade authority is part of the trust model. Use a dedicated testnet deployment account and document who controls it. Agent keys have no deployment authority or direct vault withdrawal rights.

## Technology stack and implementation references

| Area | Selected technology | How it will be used |
| --- | --- | --- |
| Smart contracts | Rust, Cargo, WebAssembly, `near-sdk`, `near-contract-standards` | Compile the shared NEAR contract, use SDK types and persistent collections, and reuse the standard NFT implementation with protocol ownership hooks. [Rust SDK and standards](https://github.com/near/near-sdk-rs) |
| Encoding and audit | Borsh, Serde JSON, NEP-297 | Serialize versioned contract state with Borsh, use JSON at client boundaries, and emit structured `EVENT_JSON` audit records. Keep stored execution records as the source for status. [Borsh](https://borsh.io/) · [Rust SDK](https://github.com/near/near-sdk-rs) · [NEP-297](https://github.com/near/NEPs/blob/master/neps/nep-0297.md) |
| Build and deploy | `cargo-near`, NEAR CLI, NEAR Testnet | Build and deploy the WASM, initialize the contract, and publish a deployment manifest with the network, account ID, WASM hash, ABI version, and source revision. [cargo-near](https://github.com/near/cargo-near) · [NEAR CLI](https://github.com/near/near-cli-rs) |
| Shared client SDK | TypeScript, Node.js LTS, pnpm workspaces, Zod, `near-api-js`, NEAR JSON-RPC | Validate shared request and response types, implement paginated reads and transaction status checks, and build transactions for an injected signer. [pnpm workspaces](https://pnpm.io/workspaces) · [Zod](https://zod.dev/) · [near-api-js](https://github.com/near/near-api-js) |
| CLI and test agent | Node.js, TypeScript, Commander, `near-api-js` | Build `agentctl` for administration and requests. The demo runner reads a ready intent and submits its ID using its restricted testnet signing key. [Commander](https://github.com/tj/commander.js) · [NEAR JavaScript API](https://github.com/near/near-api-js) |
| MCP integration | Model Context Protocol TypeScript SDK over stdio | Expose agent discovery, access and policy inspection, and action previews. A request-preparation tool returns an unsigned wallet payload for the renter to review and sign. [MCP server SDK](https://github.com/modelcontextprotocol/typescript-sdk) · [MCP server guide](https://modelcontextprotocol.io/docs/develop/build-server) |
| Reference marketplace | React, Vite, TypeScript, `@fastnear/near-connect` | Display on-chain listings and rental requests and send state changes through a connected NEAR Testnet wallet. Read status from the contract and RPC. [React](https://react.dev/learn) · [Vite](https://vite.dev/guide/) · [NEAR Connect](https://github.com/fastnear/near-connect) |
| Tests and CI | Rust unit tests, `near-workspaces`, NEAR Sandbox, Vitest, Playwright, GitHub Actions | Test policy math, deploy the real WASM locally for multi-account and receipt tests, exercise the TypeScript packages and browser flows, and gate testnet releases. [near-workspaces](https://github.com/near/near-workspaces-rs) · [NEAR Sandbox testing](https://docs.near.org/smart-contracts/testing/integration-test) · [Vitest](https://vitest.dev/guide/) · [Playwright](https://playwright.dev/docs/intro) · [GitHub Actions](https://docs.github.com/en/actions) |

The planned repository layout is `contracts/protocol`, `packages/sdk`, `packages/cli`, `packages/mcp`, and `apps/marketplace`. Pin dependencies in Cargo and pnpm lockfiles when the packages are created. Supply the network, RPC URL, and protocol account through the deployment manifest. Wallets retain user signing keys. The runner's key stays in local or CI secret storage, separate from public client configuration.

## Marketplace and developer interfaces

An owner publishes a listing that points to an active agent and includes public metadata. A renter requests a time-limited session. The owner or an authorized administrator approves a pending request once and issues its Consumer grant in the same receipt. The renter creates and funds their own vault, sets a mandate for that grant, and submits an action from their wallet. The reference app shows the grant's expiry, available and pending funds, current revisions, and the settled outcome. The MVP rental is time-limited access. Listing fees, payment settlement, and refunds are follow-up work.

The proposed SDK exposes `resolveAgent`, `checkAccess`, `checkPermission`, `getMandate`, `previewAction`, `buildRequestAction`, `buildExecuteIntent`, and `getExecution`. CLI, marketplace, and MCP clients use the same schemas and contract methods. The examples use agent, vault, and grant IDs obtained from the contract and the intent ID returned by `action request`.

```bash
agentctl agent resolve --name market-agent.alice
agentctl access check --agent "$AGENT_ID" --principal bob.testnet
agentctl action preview --agent "$AGENT_ID" --vault "$VAULT_ID" --grant "$GRANT_ID" --request transfer.json
agentctl action request --agent "$AGENT_ID" --vault "$VAULT_ID" --grant "$GRANT_ID" --request transfer.json
agentctl action execute --intent "$INTENT_ID"
agentctl execution get --intent "$INTENT_ID"
```

The `transfer.json` file holds the typed action the renter reviews before signing.

```json
{
  "type": "transfer_near",
  "recipient": "approved-recipient.testnet",
  "amount_yocto": "2000000000000000000000000"
}
```

## Testnet delivery and acceptance

1. **Registry and access.** Register an agent and mint its NFT. Bind the execution key, add an administrator and operator, publish a listing, and approve two renters with independent grants. Confirm ownership transfer, role revocation, and key rotation invalidate old authority.
2. **Vault and policy.** Bob deposits testnet NEAR into his vault and grants the listed agent a 5 NEAR per-transfer limit and 10 NEAR daily limit for a single recipient. A second renter sets their own tighter mandate. Confirm each renter's requests can spend only from their own vault.
3. **Execution.** Bob authorizes and the agent submits three transfers of 2, 3, and 3 NEAR. A fourth request for 3 NEAR fails the daily limit. After Alice revokes Bob's grant, a previously created 2 NEAR request fails even though the remaining budget could cover it. The second renter's valid grant can still be used.
4. **Failure and concurrency.** Exercise wrong caller or key, unlisted recipient, expired grant, stale revisions, duplicate submission, insufficient balance, concurrent requests against a shared budget, failure and success callbacks, and the UTC day boundary. Verify the ledger balance and audit results after each receipt sequence.
5. **Developer surfaces.** Run the approved rental flow through the marketplace and CLI. Confirm MCP returns the same preview as the SDK and hands off a request that the renter can inspect and sign. Publish the testnet deployment manifest and demo transaction hashes when those flows pass.

## Extensions

- **Fungible assets.** Implement `ft_on_transfer` for an allowlisted token contract and credit the correct vault after validating the sender and deposit instructions. Dispatch `ft_transfer` through the reservation ledger. Track token contract IDs and use integer base units for each asset. Handle token account registration under NEP-145. [NEP-141 fungible-token standard](https://github.com/near/NEPs/blob/master/neps/nep-0141.md) · [NEP-145 storage management](https://github.com/near/NEPs/blob/master/neps/nep-0145.md)
- **Trading and exposure.** Add a typed adapter per approved protocol. Each adapter validates the receiver, method, input and output assets, maximum input, minimum output, and final recipient. Reserve input and exposure before dispatch, then reconcile actual input, output, and remaining exposure from the adapter's result. Asset-denominated limits work with integer balances. Cross-asset monetary limits require a defined price source, quote freshness rule, and rounding policy.
- **Human approvals.** Add an approval record from the vault owner or explicitly designated approver. Bind it to the exact request ID, revisions, and expiry. Consume it in the same receipt that reserves funds.
- **Additional networks and paid rentals.** A compatible execution adapter on each network must enforce that network's action and financial limits. Paid rentals add a separate payment and refund lifecycle tied to the access grant. A renter's trading balance belongs to their vault ledger.

## Repository

```bash
git clone https://github.com/ConduenceAi/NEARFirewall.git
cd NEARFirewall
```

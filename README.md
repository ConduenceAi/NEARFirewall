# NEARFirewall

NEARFirewall is a NEAR-native protocol for registering agents, delegating access to them, and enforcing what they can do with a user's funds. An owner registers an agent once. Other accounts receive scoped, expiring grants to manage or use it. Each user who lets an agent spend money funds a vault of their own and sets a mandate in it. The vault checks every action against that mandate before any funds move.

**Status:** Implementation specification. The contracts, SDK, CLI, MCP server, and marketplace below are planned. The first deployment target is NEAR Testnet.

## Design principles

- **Enforcement happens where the funds are held.** A permission stored on chain restricts nothing unless the account holding the funds checks it before spending. NEARFirewall's guarantees cover funds in a NEARFirewall vault. They do not extend to other wallets the user or agent controls, or to the agent's off-chain behavior.
- **Authority and custody are separate contracts.** A shared registry holds identity and access state and never holds funds. Each user's funds sit in a single-tenant vault that enforces that user's mandate on its own.
- **Agents act on their own within limits.** The vault owner sets limits once. The agent executes without a signature per action. Human approval is required only above a threshold the vault owner chooses.
- **The agent's on-chain key can do one thing.** The agent runtime holds only a function-call key that can call `registry.execute`. It cannot sign grants, mandate changes, transfers, or token calls.
- **Every check is live.** No pre-signed authorization outlives a change. Each execution rechecks current generations and revisions at the enforcement point.

## Architecture

| Layer | Question it answers | Enforcement point |
| --- | --- | --- |
| Agent access | Who may manage or use this agent? | The registry checks ownership, role scope, grant validity, delegation limits, and agent status. |
| Agent permissions | Which operations may the agent perform? | The registry checks the action against the agent's declared capabilities. The vault checks it against the vault owner's mandate. The effective permission is the intersection of the two. |
| Financial access | What may the agent do with this user's money? | The vault checks balance, asset, recipient, per-transaction and per-window limits, execution count, and expiry, then reserves the funds in the same receipt. |

```text
  CLI / SDK / MCP ── unsigned transactions ──▶ user's wallet ──▶ registry | vault
                                                                   (grant, mandate, pause, withdraw)

  agent runtime (any host)
   function-call key: receiver = registry, method = execute
        │
        │ execute(vault, grant_id, action, request_id, expected)
        ▼
  ┌─────────────────────────────┐   on_execute(...)    ┌──────────────────────────────┐
  │ registry (shared)           │ ───────────────────▶ │ vault (single tenant)        │
  │ agents, grants, caps,       │                      │ balances, mandates, usage,   │
  │ generations, router         │                      │ reservations, approvals      │
  └─────────────────────────────┘                      └──────────────┬───────────────┘
                                                                      │ transfer / ft_transfer
                                                                      ▼
                                                        recipient ──▶ on_settle callback
```

| Contract | Responsibilities | Holds funds | Upgrades |
| --- | --- | --- | --- |
| `registry` | Agent identity and discovery, ownership, role grants and delegation, agent-wide capability caps, pause state, and routing executions to vaults | No | Owned by a multisig or DAO account under a published timelock. Versioned state with lazy migration. |
| `vault` | Custody for one owner, mandates per agent, usage windows, reservation ledger, pending approvals, settlement | Yes, for its owner only | None. To migrate, the owner withdraws and deploys a new vault. |
| `market` (optional) | Listings, payment, and issuing rental grants through a scoped right the agent owner delegates to it | Only payments in flight | Independent of the protocol |

The registry receives one call per execution and forwards it to the target vault in a single cross-contract call. The vault accepts `on_execute` only from the registry account fixed at its initialization. It then enforces the mandate independently, so a faulty or compromised registry can cause at most the spends each vault owner already allowed. [NEAR asynchronous calls](https://docs.near.org/smart-contracts/anatomy/crosscontract) · [NEAR contract state](https://docs.near.org/smart-contracts/anatomy/storage)

Timing differs by who changes what:

| Change | Takes effect | Why |
| --- | --- | --- |
| Vault owner: mandate change, pause, withdrawal | Atomically with the next spend | Checked in the same contract and receipt that reserves funds |
| Agent owner: grant revocation, agent pause, ownership change | Within the receipt that precedes the vault receipt (about one block) | Checked by the registry before it calls the vault |
| Agent runtime key deleted | Immediately, in one native transaction | NEAR rejects any transaction signed with a deleted key |

## Agent identity

An agent is a registry record anchored to a NEAR account.

```rust
struct Agent {
    id: u64,                          // immutable join key
    handle: String,                   // unique, lowercase [a-z0-9-]{3,48}
    owner: AccountId,                 // a user, multisig, or DAO account
    pending_owner: Option<AccountId>, // two-step ownership transfer
    executor: AccountId,              // the agent's NEAR account; the only caller of execute
    attestation_keys: Vec<PublicKey>, // keys the agent uses for off-chain identity proofs
    metadata_uri: Option<String>,
    metadata_hash: Option<[u8; 32]>,  // pins the published description
    caps: AgentCaps,                  // owner-declared ceiling on what the agent may ever do
    status: Status,                   // Active | Paused | Retired
    generation: u32,                  // incremented on owner or executor change
}
```

- **Handle.** The registry enforces a unique handle and uses the immutable ID for every join. A handle resolves to one agent record.
- **Owner.** Ownership is a registry field, not a token. A transfer is proposed by the current owner and accepted by the new one. Team ownership uses a multisig or DAO account as the owner. [NEAR multisig contract](https://github.com/near/core-contracts/tree/master/multisig2)
- **Executor.** Any NEAR account can be the executor. A sub-account such as `trading-bot.alice.testnet` is a naming convenience, not part of the identity, so the agent keeps its ID if ownership or the executor changes.
- **Keys.** The owner keeps the executor's full-access key and adds a function-call key for the runtime, restricted to the `execute` method on the registry. Function-call keys cannot attach deposits, so the runtime cannot transfer NEAR or call `ft_transfer`. Rotating or revoking the runtime key is a native NEAR key operation. [NEAR access keys](https://docs.near.org/protocol/access-keys) · [NEP-141](https://github.com/near/NEPs/blob/master/neps/nep-0141.md)
- **Authentication.** `execute` requires `predecessor_account_id == agent.executor`. It does not compare the transaction's signing key, because a relayer signs the outer transaction of a meta-transaction. [NEAR meta-transactions](https://docs.near.org/protocol/transactions/meta-tx)
- **Generation.** Changing the owner or executor increments `generation`. Every grant stores the generation it was issued under and stops being valid when the two differ.
- **Off-chain identity proofs.** A counterparty sends a challenge. The agent signs it with an attestation key, using the NEP-413 message envelope for domain separation. The counterparty checks the signature against the keys listed in the agent record. A contract cannot read another account's access keys, so the registry list is the authority for these keys. [NEP-413](https://github.com/near/NEPs/blob/master/neps/nep-0413.md)
- **Metadata** describes the agent. Authorization reads only typed on-chain state: `caps`, grants, and mandates.

## Agent access

| Role | Bit | Granted by | Scope |
| --- | --- | --- | --- |
| Owner | Field, not a bit | Registration or two-step transfer | Everything for the agent, including resume, executor change, and ownership transfer |
| `MANAGE_GRANTS` | 1 | Owner | Issue and revoke grants within the holder's `grantable` mask |
| `SET_CAPS` | 2 | Owner | Change the agent-wide capability ceiling |
| `SET_METADATA` | 4 | Owner | Change the metadata URI, hash, and attestation keys |
| `PAUSE` | 8 | Owner | Pause the agent. Resuming stays with the owner. |
| `USE` | 16 | Owner, `MANAGE_GRANTS` holder, or a delegated marketplace | Route executions to the vault bound in the grant |

An administrator is a grant with `MANAGE_GRANTS | SET_CAPS | SET_METADATA | PAUSE`. An operator is a grant with `PAUSE`, plus whatever runtime control the agent host provides off chain. A consumer or renter holds `USE`. Auditing needs no role, because registry and vault state and events are public.

```rust
struct Grant {
    id: u64,
    agent_id: u64,
    grantee: AccountId,
    roles: u32,
    grantable: u32,              // subset of roles the grantee may grant onward
    vault: Option<AccountId>,    // for USE: the vault this principal acts from
    parent: Option<u64>,         // delegation chain, maximum depth 2
    issuer: AccountId,
    agent_generation: u32,
    expires_at_ns: u64,
    max_uses: Option<u32>,
    uses: u32,
    revision: u32,
    revoked: bool,
}
```

Rules enforced by the registry:

- A grantor can grant only roles in its own `grantable` mask, with an expiry no later than its own grant's expiry.
- No grant can contain ownership. The executor account can never be a grantee, so an agent cannot grant itself authority.
- A grant is valid only while it is unrevoked, unexpired, under its use limit, and issued under the agent's current generation. Its parent chain must also be valid.
- Revoking a parent invalidates its descendants at check time, without iterating over them.
- The grantee can renounce a grant at any time.
- An agent owner acting from their own vault needs no `USE` grant.

`agentctl agent doctor` reads the executor's access keys over RPC and warns if the runtime could hold any key other than the restricted function-call key, because contracts cannot perform this check.

## Agent permissions

Actions are typed. The contracts never forward calldata supplied by the agent.

```rust
enum Action {
    TransferNear { to: AccountId, amount: u128 },
    TransferFt { token: AccountId, to: AccountId, amount: u128 },
}
```

- `AgentCaps` in the registry declares which action types, tokens, and adapters the agent may ever use. This is the agent owner's limit on their own agent.
- The mandate in the vault declares what the vault owner allows with their funds.
- An action must pass both. Unknown actions, missing matches, expired rules, and out-of-scope parameters fail closed.
- Reading public market data or public balances needs no protocol permission. A service that exposes private data must check the caller's grant at its own API boundary.
- `check_access`, `check_permission`, and `preview` are views. They return `{ allowed, reason_code, revisions }`, describing state at query time. Only `execute` can move funds.

## Financial mandates

```rust
struct Mandate {
    revision: u32,
    active: bool,
    expires_at_ns: u64,
    max_executions: Option<u32>,
    executions: u32,
    assets: Map<TokenId, AssetLimit>, // "near" or a NEP-141 contract
    recipients: Set<AccountId>,       // empty means no recipient is allowed
    adapters: Set<AccountId>,         // reserved for trading adapters
}

struct AssetLimit {
    per_tx: u128,
    per_window: u128,
    approve_above: Option<u128>,
}
```

| Control | Implementation |
| --- | --- |
| Per-transaction limit | `per_tx` per asset, in exact base units (yoctoNEAR or token base units) |
| Daily limit | `per_window` per asset. The window is `block_timestamp / 86_400 s`. A fixed window allows up to twice the limit across a boundary, so the UI states this. A vault-wide ceiling per asset aggregates across all agents. |
| Allowed assets | Keys of `assets`. NEP-141 tokens are credited through `ft_on_transfer` from allowlisted token contracts. [NEP-145 storage management](https://github.com/near/NEPs/blob/master/neps/nep-0145.md) |
| Allowed recipients | `recipients`. This bounds the damage from a compromised agent key or registry. |
| Expiry and count | `expires_at_ns` on both mandate and grant. `max_executions` counts pending and settled executions. |
| Human approval | Above `approve_above`, the request is stored as pending with its amount reserved. The vault owner approves it with a direct transaction. |
| Pause and withdrawal | The vault owner can pause new spending and withdraw `credited − reserved` at any time, without the agent owner's involvement. |
| Valuation | Limits are per asset, computed from the typed action. The vault never accepts a value declared by the caller. Cross-asset or fiat limits require a price feed with a freshness bound and rounding rule (see Extensions). |

Only the vault owner can set or raise a mandate. Usage counters are keyed by agent, asset, and window, not by mandate revision, so a mandate change cannot reset consumed budget. Amounts use checked `u128` arithmetic, decimal strings in JSON, and `bigint` in TypeScript. Storage is charged to the caller that creates it.

## Execution, replay protection, and settlement

1. **Submit.** The agent signs a transaction with its function-call key, calling `registry.execute(vault, grant_id, action, request_id, expected)`. `request_id` is 32 client-generated bytes. `expected` optionally carries the revisions the agent read before submitting.
2. **Registry checks.** The predecessor must be the agent's executor, and the agent must be active. The grant must be valid, carry `USE`, and be bound to this vault, unless the agent owner also owns the vault. The action must fall within `caps`, and the expected revisions must match. The registry increments the grant's use count and calls `vault.on_execute` with the agent ID, grant ID, generation, action, and request ID.
3. **Vault checks and reservation.** The vault accepts the call only from its registry. It requires an unpaused vault, an active and unexpired mandate with a matching revision, and an unused request ID. The action must use an allowed asset and recipient, stay within the per-transaction, per-window, and vault-wide limits, have executions remaining, and fit the available balance. In the same receipt, the vault reserves the amount and the execution count.
4. **Approval threshold.** Above `approve_above`, the request is stored as pending with its reservation held. `approve(request_id, expected_revision)` from the vault owner rechecks the mandate revision and expiry, then dispatches. `reject` releases the reservation. Anyone can call `expire` to release a pending request after its expiry.
5. **Dispatch and settle.** The vault builds the transfer or `ft_transfer` from the stored action and attaches a private `on_settle` callback with reserved gas. On success, the callback debits the credited balance and clears the reservation. On failure, it releases the reservation. Settlement is idempotent by request status, and it applies to the original window even if the mandate changed while the transfer was pending.
6. **Report.** Each step emits a NEP-297 event with the request ID, agent, grant, vault, revisions, and result. Clients read the stored request status and the receipt outcomes before showing success. [NEP-297 events](https://github.com/near/NEPs/blob/master/neps/nep-0297.md) · [NEAR transaction status RPC](https://docs.near.org/api/rpc/transactions)

**Replay.** NEAR access-key nonces prevent transaction replay. The vault's request-ID set makes retries idempotent. The MVP uses no off-chain bearer authorizations.

**Concurrency.** A contract executes its receipts one at a time, so check-and-reserve inside `on_execute` is atomic with respect to the vault's state. Concurrent requests see each other's reservations.

**Stale authorization.** Each execution rechecks generation, grant, caps, mandate, and vault control revisions against live state. Pending approvals store the mandate revision and recheck it at approval.

## Custody options

| Option | What it can enforce | What it cannot enforce |
| --- | --- | --- |
| Existing wallet with a function-call key for the agent | Which contract and methods the key can call, and its gas allowance. No deposits. | Amounts, recipients, cumulative limits, or anything done through the wallet's other keys |
| Dedicated vault (MVP) | Everything in the mandate, for the vault's balance | Funds the user keeps elsewhere |
| User smart account running the vault checks (future) | Everything in the mandate, for the account's balance | Actions through any other key or module installed on that account |

The protocol guarantees one thing: funds in a NEARFirewall vault move only within the vault owner's mandate, assuming correct vault code and an uncompromised vault-owner key. It cannot guarantee that an external agent checks permissions before acting off chain, keeps users' data separate, or limits what it does with other wallets or chains.

## Contract interfaces

### Registry

| Method | Caller | Effect |
| --- | --- | --- |
| `register_agent(handle, executor, metadata, caps)` | Anyone; becomes the owner | Creates the agent. The executor must differ from the caller. |
| `propose_owner(id, account)` / `accept_owner(id)` | Owner / proposed owner | Transfers ownership and increments `generation` |
| `set_executor(id, account)` | Owner | Changes the executor and increments `generation` |
| `set_caps`, `set_metadata` | Owner or holder of the matching role | Updates and increments the matching revision |
| `grant(...)`, `revoke(grant_id)`, `renounce(grant_id)` | See Agent access | Issues or ends a grant |
| `pause(id)` / `resume(id)` | Owner or `PAUSE` holder / owner | Stops or resumes routing |
| `execute(vault, grant_id, action, request_id, expected)` | The agent's executor only | Checks and routes one execution |
| `get_agent`, `resolve(handle)`, `get_grant`, `check_access`, `check_permission`, `preview`, `list_*` | Anyone (views) | Paginated reads with reason codes |

Events: `agent_registered`, `owner_changed`, `executor_changed`, `caps_changed`, `metadata_changed`, `grant_issued`, `grant_revoked`, `agent_paused`, `agent_resumed`, `execution_routed`.

### Vault

| Method | Caller | Effect |
| --- | --- | --- |
| `new(owner, registry)` | Deployer, once | Fixes the owner and the trusted registry |
| `deposit()` (payable), `ft_on_transfer` | Anyone; allowlisted token contracts | Credits the vault |
| `set_mandate(agent_id, mandate)`, `revoke_mandate(agent_id)` | Owner | Creates or ends a mandate and increments its revision |
| `set_vault_caps`, `pause()`, `resume()` | Owner | Updates controls and increments the control revision |
| `withdraw(token, amount, to)` | Owner | Withdraws unreserved funds |
| `on_execute(...)` | Registry only | Checks, reserves, then dispatches or holds for approval |
| `approve(request_id, expected_revision)`, `reject(request_id)` | Owner | Resolves a pending request |
| `expire(request_id)` | Anyone | Releases an expired pending request |
| `on_settle(request_id)` | Private callback | Settles or releases the reservation |
| `get_mandate`, `get_balances`, `get_usage`, `get_request` | Anyone (views) | Reads vault state |

Events: `deposited`, `withdrawn`, `mandate_set`, `mandate_revoked`, `vault_paused`, `vault_resumed`, `execution_pending`, `execution_approved`, `execution_rejected`, `execution_dispatched`, `execution_settled`, `execution_failed`.

For the MVP, the CLI deploys a vault to a sub-account of its owner, such as `vault.bob.testnet`. Only the parent account can create its sub-accounts, so the owner signs this. The deployment manifest publishes the vault's WASM hash, and the CLI compares a vault's on-chain code hash against it before any interaction. A later version deploys vaults by global contract hash at deterministic account IDs, so anyone can verify a vault's code from its account ID. [NEP-591 global contracts](https://github.com/near/NEPs/blob/master/neps/nep-0591.md) · [NEP-616 deterministic account IDs](https://github.com/near/NEPs/blob/master/neps/nep-0616.md)

## Marketplace

The marketplace is an optional contract and app. Nothing in the protocol depends on it.

1. The agent owner grants the `market` account a grant with `grantable = USE` and an expiry. The market can then issue only `USE` grants, each expiring no later than its own grant. It loses this right on revocation.
2. The owner lists the agent with a price per day, a maximum duration, and a terms URI.
3. A renter deploys and funds their own vault and sets a mandate for the agent.
4. `market.rent(listing_id, days, vault)` takes the payment and calls `registry.grant(USE, grantee = renter, vault, expires)`. On success, the callback forwards the payment to the agent owner. On failure, it refunds the renter.
5. The renter's grant expires on schedule or when the owner revokes it. The renter can revoke the mandate, pause the vault, or withdraw at any time, including if the agent goes offline.

Renting never transfers ownership, keys, or authority beyond the renter's own mandate. An owner can issue the same `USE` grant directly from the CLI without the marketplace. Refunds on early revocation, usage-based billing, and reputation are follow-up work.

An agent serving several renters must key each renter's session state and configuration by `grant_id`. Each vault isolates funds on chain. Isolating data is the agent host's responsibility.

## Developer interfaces

| Integration level | What the developer does | What it guarantees |
| --- | --- | --- |
| Identity | Registers the agent, publishes metadata, and answers identity challenges with an attestation key | Counterparties can verify which agent they are dealing with |
| Permission check | Calls `preview` or `check_*` before acting | Fewer failed transactions. This level is advisory, and an agent can skip it. |
| Enforced execution | Moves money only through `registry.execute` | Vault funds move only within the mandate |

Minimum integration for an external agent:

1. A NEAR executor account whose runtime holds only a function-call key for `registry.execute`.
2. One `register_agent` call.
3. Money-moving actions submitted as typed actions through `execute`.
4. Per-user state keyed by `grant_id`.

### CLI

Commands that need a human's authority produce an unsigned transaction for the user's wallet. Only `action execute` signs, using the agent's restricted key.

```bash
agentctl agent register --handle market-agent --executor trading-bot.alice.testnet --caps caps.json
agentctl agent inspect market-agent
agentctl agent doctor market-agent
agentctl access grant market-agent --to carol.testnet --roles pause,metadata --expires 7d
agentctl access revoke "$GRANT_ID"
agentctl agent pause market-agent
agentctl vault create
agentctl vault deposit --token usdc.testnet --amount 1000
agentctl mandate set market-agent --vault vault.bob.testnet --file mandate.json
agentctl action preview --agent market-agent --vault vault.bob.testnet --grant "$GRANT_ID" --action transfer.json
agentctl action execute --agent market-agent --vault vault.bob.testnet --grant "$GRANT_ID" --action transfer.json
agentctl action approve "$REQUEST_ID"
```

```json
{
  "type": "transfer_ft",
  "token": "usdc.testnet",
  "to": "shop.testnet",
  "amount": "300000000"
}
```

### TypeScript SDK

```ts
const fw = new NearFirewall({ network: "testnet", registry: "registry.testnet" });

const agent = await fw.agents.resolve("market-agent");
const grantTx = fw.access.buildGrant({
  agentId: agent.id,
  grantee: "bob.testnet",
  roles: ["use"],
  vault: "vault.bob.testnet",
  expiresIn: "7d",
});
await wallet.signAndSendTransaction(grantTx);

const decision = await fw.preview({ agentId: agent.id, vault, grantId, action });
const runner = fw.executor({ accountId: "trading-bot.alice.testnet", keyStore });
const result = await runner.execute({ vault, grantId, action, expected: decision.revisions });
// result.status: "settled" | "pending_approval" | "rejected"
```

A thin Python client exposes the same views and the `execute` call for Python agent frameworks. Agents in any framework can wrap a money-moving tool with `preview` followed by `execute`. A `pending_approval` result maps to the framework's human-in-the-loop pause.

### MCP server

| Tools | Kind | Signer |
| --- | --- | --- |
| `resolve_agent`, `inspect_agent`, `check_access`, `check_permissions`, `check_financial_mandate`, `preview_action`, `get_execution` | Read-only | None |
| `prepare_register_agent`, `prepare_grant`, `prepare_revoke`, `prepare_mandate`, `prepare_pause`, `prepare_withdraw`, `prepare_approve` | Return an unsigned transaction and a readable summary | The human's wallet. The server never holds human keys. |
| `execute_action` | Submits an execution | The agent's restricted function-call key |

## Security model

| Threat | Mitigation | Enforced by |
| --- | --- | --- |
| Agent runtime key stolen | The owner deletes the key natively and pauses the agent. Recipient allowlists and caps bound any loss. | NEAR runtime, registry, vault |
| Malicious agent owner | Each vault owner's mandate bounds every spend. Vault owners can pause and withdraw independently. | Vault |
| Agent grants itself authority | The runtime key cannot call `grant`. The executor can never be a grantee. | NEAR runtime, registry |
| Unauthorized delegation | Grants are subsets of the grantor's `grantable` mask and expiry, with depth at most 2 | Registry |
| Stale grant or mandate | Live rechecks, generation and revision counters, and caller-supplied expected revisions | Registry, vault |
| Replay or duplicate submission | Access-key nonces and the request-ID set | NEAR runtime, vault |
| Concurrent overspend | Check-and-reserve in one receipt, with idempotent settlement | Vault |
| Understated value | Limits are computed from the typed action in asset base units | Vault |
| Faulty or compromised registry | Vaults enforce mandates independently, so damage is bounded by each mandate | Vault |
| Vault upgrade attack | Vault code is immutable, and its hash is verified against the deployment manifest | Deployment, CLI |
| Owner key loss | Owners can be multisig or DAO accounts | NEAR multisig |
| Agent impersonation | Unique handles. Challenges are signed with registry-listed attestation keys. Clients verify the executor. | Registry, SDK |
| Stuck reservation after a failed callback | Static gas reserved for `on_settle`, and owner reconciliation against the token balance | Vault |

## Technology stack and implementation references

| Area | Selected technology | How it will be used |
| --- | --- | --- |
| Smart contracts | Rust, Cargo, WebAssembly, `near-sdk`, `near-contract-standards` | Compile the `registry`, `vault`, and `market` contracts. Use SDK types, persistent collections, and NEP-141 receiver interfaces. [Rust SDK and standards](https://github.com/near/near-sdk-rs) |
| Encoding and audit | Borsh, Serde JSON, NEP-297 | Serialize versioned state with Borsh, use JSON at client boundaries, and emit structured `EVENT_JSON` records. Stored request records are the source of truth for status. [Borsh](https://borsh.io/) · [NEP-297](https://github.com/near/NEPs/blob/master/neps/nep-0297.md) |
| Build and deploy | `cargo-near`, NEAR CLI, NEAR Testnet | Build and deploy each WASM. Publish a deployment manifest with the network, account IDs, WASM hashes, ABI version, and source revision. [cargo-near](https://github.com/near/cargo-near) · [NEAR CLI](https://github.com/near/near-cli-rs) |
| Shared client SDK | TypeScript, Node.js LTS, pnpm workspaces, Zod, `near-api-js`, NEAR JSON-RPC | Validate shared request and response types, implement paginated reads and transaction status checks, and build transactions for an injected signer. [pnpm workspaces](https://pnpm.io/workspaces) · [Zod](https://zod.dev/) · [near-api-js](https://github.com/near/near-api-js) |
| CLI and test agent | Node.js, TypeScript, Commander, `near-api-js` | Build `agentctl` for administration and execution. The demo agent submits executions with its restricted testnet key. [Commander](https://github.com/tj/commander.js) |
| MCP integration | Model Context Protocol TypeScript SDK over stdio | Expose reads, previews, unsigned transaction preparation, and agent execution. [MCP server SDK](https://github.com/modelcontextprotocol/typescript-sdk) · [MCP server guide](https://modelcontextprotocol.io/docs/develop/build-server) |
| Reference marketplace | React, Vite, TypeScript, `@fastnear/near-connect` | Display listings, rentals, vault balances, mandates, and execution status, and send state changes through a connected NEAR Testnet wallet. [React](https://react.dev/learn) · [Vite](https://vite.dev/guide/) · [NEAR Connect](https://github.com/fastnear/near-connect) |
| Tests and CI | Rust unit tests, `near-workspaces`, NEAR Sandbox, Vitest, Playwright, GitHub Actions | Test policy math, deploy the real WASM locally for multi-account and receipt tests, assert every rejection path, exercise the TypeScript packages and browser flows, and gate testnet releases. [near-workspaces](https://github.com/near/near-workspaces-rs) · [NEAR Sandbox testing](https://docs.near.org/smart-contracts/testing/integration-test) · [Vitest](https://vitest.dev/guide/) · [Playwright](https://playwright.dev/docs/intro) · [GitHub Actions](https://docs.github.com/en/actions) |

The planned repository layout is `contracts/registry`, `contracts/vault`, `contracts/market`, `packages/sdk`, `packages/cli`, `packages/mcp`, and `apps/marketplace`. Pin dependencies in Cargo and pnpm lockfiles when the packages are created. Supply the network, RPC URL, and contract accounts through the deployment manifest. Wallets keep user signing keys. The agent runtime's function-call key stays in local or CI secret storage, separate from public client configuration.

## Hackathon MVP

Use Meteor as the owner signer through the existing NEAR Connect dApp integration. The demo runs as a web app on NEAR Testnet and uses the published connector. Alice signs the setup transactions to fund the vault and set the agent's grant and mandate. She can sign a pause or revocation from the same app. The agent submits subsequent actions with its own restricted key. [Meteor Wallet SDK](https://github.com/Meteor-Wallet/meteor_wallet_sdk) · [NEAR Connect](https://github.com/fastnear/near-connect)

1. Set a native NEAR limit of 5 NEAR per transfer and 10 NEAR per window for one approved recipient. Leave the optional human approval threshold unset for this demo.
2. Submit an allowed transfer from the agent and show the settled result. Submit a transfer over the limit and show the vault's denial and unchanged balance. Show the reason in the app using the execution outcome. Telegram can relay the same denial event as a follow-up.
3. Have Alice pause the vault in Meteor. Submit another action that fits the original limits and verify that the vault blocks it.

The core demo depends on the registry, vault, a restricted agent runner, and the web app. Native Meteor controls and domain blocking remain future wallet integrations. Marketplace, MCP, and the optional approval flow are covered by the broader testnet plan below.

## Testnet delivery and acceptance

1. **Registry and access.** Alice registers an agent with a restricted executor key and grants Carol `PAUSE | SET_METADATA`. Confirm that Carol cannot grant or resume, that the executor cannot become a grantee, and that an ownership transfer invalidates every earlier grant.
2. **Vaults and mandates.** Bob and Dana each deploy and fund their own vault and set different mandates for the agent. Bob's mandate allows 5 NEAR per transfer, 10 NEAR per window, and one recipient. Confirm that each execution draws only from the vault named in the grant.
3. **Execution.** The agent executes transfers of 2, 3, and 3 NEAR from Bob's vault without any signature from Bob. A fourth transfer of 3 NEAR fails the window limit. A transfer to an unlisted recipient fails. After Alice revokes Bob's grant, the next execution fails in the registry, while Dana's executions continue.
4. **Approval and failure handling.** A request above Bob's approval threshold waits as pending and settles after Bob approves. A mandate change before approval makes that approval fail. Exercise the wrong caller, a direct call to the vault, an expired grant, stale revisions, duplicate request IDs, insufficient balance, concurrent requests against one budget, failed transfers, and the window boundary. Check balances and events after each receipt sequence.
5. **Key compromise.** Alice deletes the runtime key, and the next submission is rejected by the network. She adds a new restricted key and execution resumes without any registry change.
6. **Developer surfaces.** Run the rental flow through the marketplace and through the CLI alone. Confirm that MCP returns the same preview as the SDK and that its prepare tools produce transactions the user can inspect and sign. Publish the deployment manifest and demo transaction hashes when these flows pass.

## Future wallet integration

The wallet becomes the owner's interface for agent grants, spending limits, approvals, revocation, and alerts. The first wallet integration can surface the existing vault controls directly in the wallet. A later smart-account integration moves those controls to the account that holds the protected balance. The registry continues to resolve agent identity and access.

| Control | Enforcement point | Behavior |
| --- | --- | --- |
| Block navigation | The wallet's in-app browser or installed browser extension | A wallet security feed carries scoped domain reports from authorized publishers. The wallet verifies the feed, matches the normalized host, and blocks matching navigation, including redirects. A browser extension can install dynamic block rules through Manifest V3. [Chrome request rules](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest) · [Android WebView navigation](https://developer.android.com/reference/android/webkit/WebViewClient) · [Apple WebKit navigation](https://developer.apple.com/documentation/webkit/wknavigationdelegate) |
| Reject a signing request | The wallet's connection and signing layer | Bind supported dApp sessions to the origin verified by the browser or connector. Check that origin again on every signing request so an already connected site loses signing access when it is flagged. Show the rejection in wallet activity. |
| Enforce agent spending | The user's smart-account contract | Give the agent a restricted execution route. Validate the exact action, target, asset, recipient, amount, and remaining budget against the current mandate. Check pause and reserve funds before dispatch, including when a pending approval is released. Any route that can move agent-managed funds must apply the same checks. [NEAR access keys](https://docs.near.org/protocol/accounts-contracts/access-keys) · [NEAR asynchronous calls](https://docs.near.org/smart-contracts/anatomy/crosscontract) |

An authorized watcher can publish or flag a domain through a versioned feed. Feed entries identify the host, reason, publisher, and expiry. Domain reports govern the wallet's browsing and signing surfaces. The smart account independently enforces transaction rules against the actual on-chain action, including requests submitted directly by an agent. The account owner controls spending limits and can pause or revoke a grant. An opt-in alert worker can relay finalized denial events to Telegram alongside wallet notifications. [NEP-297 events](https://github.com/near/NEPs/blob/master/neps/nep-0297.md) · [Telegram Bot API](https://core.telegram.org/bots/api#sendmessage)

Acceptance cases cover a flagged site opened in the wallet browser, a site flagged after connecting, and a direct agent request above the spending limit. Browser-wide navigation blocking requires an installed extension with the relevant browser permissions. Once the smart account dispatches a transfer, a later pause applies to subsequent dispatches and the earlier transfer can still settle.

## Extensions

- **Trading adapters.** Add one typed adapter per approved protocol. Each validates the route, input and output assets, maximum input, minimum output, and final recipient, and builds the call itself. Reserve the input and exposure before dispatch, then reconcile actual amounts from the adapter's result.
- **Fiat-denominated limits.** Require a defined on-chain price source, a quote freshness rule, and a rounding policy.
- **Signed approvals.** Let the vault owner approve with a NEP-413 message verified on chain against an approval key registered in the vault, bound to the request ID, revisions, and a deadline.
- **Deterministic vaults.** Deploy vault code once as a global contract by hash, and create each vault at a deterministic account ID derived from its code and initial state.
- **Cross-chain execution.** Hold a vault balance in NEAR Intents under the vault's own account and authenticate by predecessor, never by registering an agent key. Contract-enforced swaps need on-chain escrow with fixed parameters. [NEAR Intents](https://docs.near.org/chain-abstraction/intents/overview)
- **Paid rentals.** Add refunds on early revocation and usage-based billing to the marketplace.

## Repository

```bash
git clone https://github.com/ConduenceAi/NEARFirewall.git
cd NEARFirewall
```

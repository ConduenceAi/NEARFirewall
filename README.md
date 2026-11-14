# NEARFirewall

NEARFirewall lets AI agents pay vendors from an owner's existing NEAR account under rules enforced on-chain. The owner registers agents as NFTs, approves recipients and budgets, and gives each connection a restricted key. An agent can settle routine payments automatically while the owner reviews larger requests and can pause delegated spending or revoke a connection.

Built for [NEAR HACKATHON](https://nearhackathon.com/#tracks). The native NEAR payment flow has been exercised on Testnet with both a scripted executor and a local MCP client. The [Testnet runbook](docs/testnet-runbook.md) describes both setups.

| Demo links | URL |
| --- | --- |
| Hosted dashboard | |
| Public demo post on X | |

## Hackathon tracks

| Track | What NEARFirewall demonstrates |
| --- | --- |
| **NFTs That Do Something** (`nfts`) | Each agent is a NEP-171 NFT whose registry record defines who can operate it, which actions it can request, and where it sits in the agent tree. Child agents can only narrow their parent's capabilities. Transferring an agent advances its generation and invalidates spending approvals tied to the previous generation. |
| **Agent Economy** (`agents`) | A connected agent can pay approved vendors for services without asking the owner to sign every routine payment. The MCP server exposes spending rules, payment previews, execution, and activity. For x402 APIs, the buyer asks the on-chain policy to fund the requested USDC amount before retrying the paid request. |
| **AI Security & Defense** (`security`) | A NEAR function-call key limits the agent to the policy entry point. The payer's contract applies recipient approvals, per-payment and daily caps, shared branch budgets, and owner confirmation thresholds. A pause or key revocation stops new payments through that authorization. |

## Try it

### Browser demo

From the repository root, run the commands below with Node.js 24 or later, then open [the local dashboard](http://localhost:5173/). The landing-page demo uses simulated funds and works without a wallet or contract build.

```sh
npm ci
npm run web:dev
```

| Do this | See this |
| --- | --- |
| Go to **Try it here**, choose **HR · Background checks**, and follow the prompts to connect, authorize the demo key, and load the configuration. Send the prefilled 2 NEAR request to ClearCheck. | The payment settles automatically and appears under **Activity**. |
| Send `Pay ClearCheck 3 NEAR`. | **Needs approval** appears. Use **Approve payment** or **Decline** to resolve the request. |
| Send `Pay ClearCheck 4 NEAR`. | **Blocked** appears because the request exceeds the recipient's 3 NEAR per-payment limit. |

### Live NEAR Testnet

To inspect the original deployment without a wallet, open the [agent registry](https://testnet.nearblocks.io/address/nfw-registry-1112.testnet) and the [demo payer](https://testnet.nearblocks.io/address/nfw-alice-1112.testnet). The [deployment manifest](deployments/testnet.json) records their contract hashes.

| Open this transaction | See this in the result or receipts |
| --- | --- |
| [Register `market-agent`](https://testnet.nearblocks.io/txns/35bpskVhyYweNFFL6P666SViFPRD8rewyaqqXJw8K95X) | The registry mints the agent NFT to the payer and records its executor. |
| [Pay an approved recipient 2 NEAR](https://testnet.nearblocks.io/txns/HVq1agkCLkrR2UiZBewqycyBBPYryopyXZZ8miP2mKxd) | The payer's account transfers funds to the recipient and records settlement. |
| [Pay an unapproved recipient](https://testnet.nearblocks.io/txns/5Uop2dgdYLT4TnChHySkezrhaoPWzvrcFNqX63X5mbNm) | The policy returns `RECIPIENT_NOT_APPROVED` and sends no funds. |
| [Spend from an exhausted branch budget](https://testnet.nearblocks.io/txns/Hh9aWJyLYyK8NkJkTPJfaWKGyCuN722kotDZJJPk5gFo) | The shared branch budget rejects the leaf agent's next payment with `MANDATE_DAILY_CAP`. |
| [Transfer a leaf NFT](https://testnet.nearblocks.io/txns/5fyiVadcpZ6XeweDMFP4VYN7mwYLncK4YspRnVngyWCX) and [request another payment from the old payer](https://testnet.nearblocks.io/txns/5JhNpxeKHzwPQDjFmyatFWebc6BdzvzxNdmCk2uBU4oy) | The NFT changes hands. The old payer's next payment is refused. |

See the [full transaction list](docs/live_links.md) for deployment receipts, replay handling, and pause controls.

### Run a fresh Testnet demo

Use a fresh named Testnet account with enough balance for contract storage and the payments you plan to send. See the runbook for the deployment balance estimate. For the dashboard flow, connect it with a supported Testnet wallet. Install Rust, the `wasm32-unknown-unknown` target, and [cargo-near](https://github.com/near/cargo-near) alongside Node.js.

```sh
npm ci
npm run contracts:build
```

Copy these two build outputs into `apps/web/public/` before starting the dashboard with `npm run web:dev`. The default configuration uses Testnet and creates a registry for each owner. If you copy `apps/web/.env.example` to `apps/web/.env.local`, leave `VITE_REGISTRY_ID` empty for this flow.

- `target/near/nearfirewall_registry/nearfirewall_registry.wasm`
- `target/near/nearfirewall_account_policy/nearfirewall_account_policy.wasm`

| Do this | See this |
| --- | --- |
| Connect the wallet, choose **Create my registry**, then register an agent under **Agents**. Set **Max per payment** to 5 NEAR and leave the executor field empty for local MCP. | The new agent NFT appears in the registry at `agents.<your-account>`. |
| Under **Payments**, choose **Enable payments** and approve a Testnet recipient. Set a 5 NEAR per-payment cap, a daily budget of at least 7 NEAR for both the agent and recipient, and **Ask me first above** 4 NEAR. | The dashboard shows the recipient and its spending rules. |
| Choose **Connect** on the agent, sign the restricted-key transaction, and load the displayed MCP configuration in a local client. | `get_rules` returns the agent's current limits. |
| Request 2 NEAR and then 4.5 NEAR for the approved recipient. | The first payment settles. The second appears in the dashboard's **Ask me first** queue, where the owner can confirm or decline it. |

For a signed Testnet walkthrough, the [Testnet runbook](docs/testnet-runbook.md#fresh-owner-registry-and-local-mcp) includes the CLI route used to verify local MCP over stdio. The runbook records dashboard testing with a mock wallet.

### x402 API payments

An agent can use `fetch_paid` over MCP or `POST /api/x402/fetch` on the gateway to buy an API response in USDC on NEAR.

1. The API returns HTTP `402 Payment Required` with its price and payment terms.
2. The buyer requests funding from the owner's on-chain policy. The policy checks seller rules, per-payment and daily caps, and the applicable branch and account budgets. When approved, it funds the connection's payment account with the exact amount.
3. The buyer signs the USDC transfer and retries the request. The included seller paywall releases the response after its facilitator verifies and settles the payment. The `return_unspent_usdc` MCP tool sends leftover funds back to the owner.

Before the first purchase, the owner sets these rules on-chain, under **Payments → x402 payments (USDC)** or with the **x402 buyer** template:

- Turn x402 on for the account, in USDC, with an optional account-wide daily cap.
- Give the agent an x402 cap per payment, at registration or later. The cap lives on the agent NFT, and child agents can only narrow it.
- Set a daily x402 budget and a small shared budget for sellers that are not approved (default 0.05 USDC each and 0.25 USDC a day for all of them together).
- Approve payees, each with its own limits. Agents can pay each other, so a payee can be more than a wallet address:

  | Approve | Paid when | Enforced |
  | --- | --- | --- |
  | **An agent**, by its NFT (registry and agent ID) | The account being paid holds that agent now, and the agent has not changed hands since approval | On-chain: the policy reads the seller's registry before it pays |
  | **A seller account** | The seller asks to be paid at that account | On-chain |
  | **A website**, such as `api.example.com` | The agent's client fetched that site. If the owner pins an account, the site must ask to be paid there | On-chain when pinned. Otherwise the policy relies on the client's report of the site |

  A payment uses the first rule that matches, in this order, then falls back to the shared budget for unapproved sellers.
- Set up each connection's payment account. This sends 0.01 NEAR and registers the account with USDC.

**Wallets that refuse contract deployments.** Some wallets, Meteor among them, will not sign a contract deployment. Choose **Use a one-time setup key** when creating the registry or enabling payments. The wallet signs only one transaction, which adds a temporary key generated in the page. The page then installs the contract with that key, and the same transaction deletes the key. Later upgrades are ordinary wallet calls: both contracts have an owner-only `upgrade_code`, and an owner can freeze the registry's code for good. Registries created before this release have no keys and no `upgrade_code`, so they cannot gain x402. For x402, use a fresh account.

| Do this | See this |
| --- | --- |
| `npm test -- packages/x402` | The buyer, seller paywall, and facilitator, with mocked chain reads. Tests cover a full purchase over HTTP, the payee labels sent to the policy, price limits, policy refusal, signature and nonce checks, and duplicate settlement. |
| `node scripts/x402-demo.ts setup --buyer <a>.testnet --seller <b>.testnet` | Sets up two Testnet owners whose keys are in the NEAR CLI keychain. The buyer agent is approved to pay the seller's agent by its NFT, and gets a small budget for unknown shops. It then prints the next steps. |
| `node scripts/x402-facilitator.ts --relayer <b>.testnet` and `node scripts/x402-seller.ts` | A local facilitator that relays payments and pays the gas, and three paid sellers: the seller's agent, unknown shops, and a dataset priced above the cap. |

The linked Testnet receipts document native NEAR payments. x402 has been verified with the local tests and a local run of the seller and facilitator scripts. It has not yet run on Testnet.

### Deploy the dashboard and gateway to Vercel

Import the repository with the project Root Directory set to `./` so Vercel reads [`vercel.json`](vercel.json). The dashboard serves `/`, and the gateway serves `/api`, `/mcp`, and `/health` on the same domain. Use the deployment origin as the gateway address in the dashboard's Connect panel.

In Vercel's Environment Variables, set `NEARFIREWALL_ACCOUNT`, `NEARFIREWALL_AGENT_KEY` (the restricted connection key), `GATEWAY_TOKEN` (at least 32 characters), and `PORT=8787`. The gateway serves a single connection. Set `NEARFIREWALL_NETWORK` if the connection uses mainnet. To verify routing, run `vercel dev --local` from the repository root with Docker running and those gateway settings in your environment, then open `/` and `/health` on the local URL.

To support creating registries and enabling payments on fresh accounts, also configure the contract WASM URLs or the corresponding global code hashes from [`apps/web/.env.example`](apps/web/.env.example). The browser demo runs without those contract files.

## How it works

1. **Register an agent.** The owner's registry mints an NFT, stores the agent's capabilities and ancestry, and resolves that identity when the agent makes a request.
2. **Authorize a connection.** The owner adds a function-call key limited to `agent_execute` on the payer's account with zero attached deposit. The policy maps the signing key to the registered agent.
3. **Evaluate spending rules.** The registry checks the agent and its ancestors. The payer's contract checks the approved recipient, the remaining budgets, the current agent generation, and any confirmation threshold.
4. **Settle and record the outcome.** The payer's account sends native NEAR if the request is approved. The policy reserves the amount while a transfer or confirmation is pending and releases the reservation if the request is declined or the transfer fails.

The owner can give a branch of agents one shared budget while setting tighter rules on individual children. Pausing a parent stops new payments across its branch. See the [implementation plan](docs/implementation-plan.md) for contract design and planned extensions.

## What the tests verify

```sh
npm test
npm run typecheck
npm run web:build
cargo test --workspace
```

- Rust tests cover NFT minting and transfers, inherited capabilities, stale authorizations, recipient and branch caps, pending confirmations, and settlement.
- TypeScript tests cover the SDK, templates, MCP tools, gateway, browser demo, and x402. The full suite needs loopback HTTP access for local fixtures.

## Repository layout

| Path | Purpose |
| --- | --- |
| [`contracts/registry`](contracts/registry) | NFT registry, agent hierarchy, and capability checks |
| [`contracts/account-policy`](contracts/account-policy) | Spending rules, key authorization, confirmation, and settlement |
| [`contracts/types`](contracts/types) | Shared Rust actions, outcomes, and reason codes |
| [`apps/web`](apps/web) | React dashboard and browser demo |
| [`apps/runner`](apps/runner) and [`scripts`](scripts) | Testnet scenarios and owner-side demo tooling |
| [`packages/sdk`](packages/sdk) and [`packages/templates`](packages/templates) | TypeScript clients, wallet transaction builders, and reusable payment plans |
| [`packages/mcp`](packages/mcp) and [`apps/gateway`](apps/gateway) | Local MCP and self-hosted HTTP/remote MCP access |
| [`packages/x402`](packages/x402) | USDC-on-NEAR x402 buyer and seller paywall |
| [`deployments`](deployments) and [`docs`](docs) | Testnet deployment records and documentation |

## Hackathon notes

- **Build window.** The repository's recorded project history starts on November 11, 2026, within the event's eligible build window. [Official hackathon rules](https://nearhackathon.com/HACKATHON.md)
- **Libraries.** The contracts use Rust, `near-sdk`, and `near-contract-standards`. The app and tooling use React, Vite, TypeScript, NEAR Connect, `near-api-js`, Zod, and the MCP TypeScript SDK. The repository includes a [third-party Edge license notice](third-party/Edge-LICENSE).

### Contributors

- Anjali Jha ([`@blizet`](https://github.com/blizet))
- Sarthak Dengre ([`@DengreSarthak`](https://github.com/DengreSarthak))

### Other hackathon entry

| Contributor | Independent project | Repository |
| --- | --- | --- |
| Sarthak Dengre | | |

### License

NEARFirewall is released under the [MIT License](LICENSE). See the [third-party Edge notice](third-party/Edge-LICENSE) for its BSD 3-Clause terms.

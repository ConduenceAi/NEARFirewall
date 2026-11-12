# Live links: NEARFirewall on NEAR Testnet

This page lists the live Testnet deployment of NEARFirewall: the accounts the demo uses, the transactions it produced, and the endpoints it talks to. Each link says where it goes.

All explorer links open **NearBlocks**, the NEAR Testnet block explorer. Two kinds of page appear:

- **Account page** (`https://testnet.nearblocks.io/address/<account>`): the account's balance, its transaction history, its access keys, and the deployed contract and its code hash, if the account has one.
- **Transaction page** (`https://testnet.nearblocks.io/txns/<hash>`): one transaction, with its signer, receiver, actions, status, and the receipts it created. Cross-contract steps, such as `execute` → `on_execute` → transfer → `on_settle`, appear in the receipts.

Deployed and run on 2026-11-12. Code hashes are recorded in [`deployments/testnet.json`](../deployments/testnet.json).

## Accounts

None of these is a personal wallet. All of them were created through the Testnet faucet and sign with the NEAR CLI. Their keys are in the NEAR CLI legacy keychain (`~/.near-credentials/testnet`) on the machine that created them, never in this repository.

| Account | Role | Link | What the link shows |
| --- | --- | --- | --- |
| `nfw-registry-1112.testnet` | Registry and agent NFT contract. It signed its own deploy and upgrade. | [Open](https://testnet.nearblocks.io/address/nfw-registry-1112.testnet) | The registry contract (code hash `Hgkuzff54ttMpomBhTGKBjSqgJVeRYeNv1ADfkVU8qwC`), the deploy and upgrade transactions, and every `execute` call from executors. |
| `nfw-alice-1112.testnet` | Demo payer ("Alice"). Runs the account policy on its own account, registers agents, sets budgets, and pauses and resumes. | [Open](https://testnet.nearblocks.io/address/nfw-alice-1112.testnet) | The policy contract on the payer's own account (code hash `BYswoXdW6iiULfmEjUJvb6QpE4PzeC5SphEYvRzbAgPX`), the balance that payments come out of, and the outgoing transfers to vendors. |
| `nfw-runner-1112.testnet` | Executor for `market-agent` and `desk` | [Open](https://testnet.nearblocks.io/address/nfw-runner-1112.testnet) | Its one access key: a function-call key that can only call `execute` on the registry. It also shows the `execute` transactions it submitted. |
| `nfw-runner1-1112.testnet` | Executor for the leaf `bot-1.desk` | [Open](https://testnet.nearblocks.io/address/nfw-runner1-1112.testnet) | The same kind of restricted key, and the leaf's `execute` transactions. |
| `nfw-vendor-1112.testnet` | Approved recipient: 3 NEAR per payment, 6 NEAR per day | [Open](https://testnet.nearblocks.io/address/nfw-vendor-1112.testnet) | Incoming payments from the payer. |
| `nfw-vendor2-1112.testnet` | Approved recipient: 2 NEAR per payment, 4 NEAR per day | [Open](https://testnet.nearblocks.io/address/nfw-vendor2-1112.testnet) | Incoming payments from the payer. |
| `nfw-vendor3-1112.testnet` | Approved recipient: 3 NEAR per payment, 6 NEAR per day. Also received the transferred leaf token in scene 10. | [Open](https://testnet.nearblocks.io/address/nfw-vendor3-1112.testnet) | Incoming payments, and the agent token it now holds. |

## Deployment transactions

| What | Link | Where it goes |
| --- | --- | --- |
| Registry first deploy | [`CTefKf7q…1jYz`](https://testnet.nearblocks.io/txns/CTefKf7qZKvhvKdLshrFe3cMEfrypV4QWJoSJX1i1jYz) | The transaction that deployed the registry contract to `nfw-registry-1112.testnet`. |
| Registry upgrade (transferred-agent fix) | [`2wikh95Q…Mjk4`](https://testnet.nearblocks.io/txns/2wikh95QW74aXrDCtyjSaKGiAj7pygnCo4NurMRbMjk4) | The redeploy that requires the payer to hold the agent asking to pay. |
| Policy deploy and `initialize` on the payer (scene 2) | [`3818aKKy…sebd`](https://testnet.nearblocks.io/txns/3818aKKyAfj61rCchRJ8u5kiWe7vSuwQnHwDhmeXsebd) | A single batch transaction that installs the policy on `nfw-alice-1112.testnet` and sets the trusted registry. |

## Demo transactions by scene

### Scene 1: register an agent

| Step | Link | Where it goes |
| --- | --- | --- |
| Register `market-agent` | [`35bpskVh…K95X`](https://testnet.nearblocks.io/txns/35bpskVhyYweNFFL6P666SViFPRD8rewyaqqXJw8K95X) | Mints the agent token to the payer and links it to the executor `nfw-runner-1112.testnet`. |

### Scene 3: unapproved recipient is blocked

| Step | Link | Where it goes |
| --- | --- | --- |
| Pay an unapproved recipient | [`5Uop2dgd…mbNm`](https://testnet.nearblocks.io/txns/5Uop2dgdYLT4TnChHySkezrhaoPWzvrcFNqX63X5mbNm) | Rejected with `RECIPIENT_NOT_APPROVED`. The receipts show no transfer. |

### Scene 4: approve recipients with their own limits

| Step | Link | Where it goes |
| --- | --- | --- |
| One `set_mandate` with three vendors and a 10 NEAR daily budget | [`5gpwHc1s…KpuS`](https://testnet.nearblocks.io/txns/5gpwHc1syCh5YDveM7Fp5zKrckkBbeX8ERcrQN66KpuS) | The payer's owner call that sets every vendor's limits in one transaction. |

### Scene 5: automatic payment from the payer's account

| Step | Link | Where it goes |
| --- | --- | --- |
| Pay `vendor` 2 NEAR | [`HVq1agkC…mKxd`](https://testnet.nearblocks.io/txns/HVq1agkCLkrR2UiZBewqycyBBPYryopyXZZ8miP2mKxd) | The receipts show runner → registry `execute` → payer `on_execute` → **payer → vendor transfer of 2 NEAR** → payer `on_settle`. |

### Scene 6: limits are enforced

| Step | Request | Link | Result |
| --- | --- | --- | --- |
| a | 4 NEAR to `vendor` | [`HdTHaN9s…zcsk`](https://testnet.nearblocks.io/txns/HdTHaN9s4t5f5gYFVy3PifkmAJCasn7Wz3U33hs5zcsk) | Rejected: over `vendor`'s per-payment cap |
| b | 3 NEAR to `vendor` | [`4ySqXuSR…ULAj`](https://testnet.nearblocks.io/txns/4ySqXuSRueDiNRT3RnQvwoMJMK1n9dyF4jBtXUhbULAj) | Settled |
| c | 3 NEAR to `vendor` | [`FayQL3pQ…Ai11`](https://testnet.nearblocks.io/txns/FayQL3pQNm9xwgAStMfdQrGRTEe7U2nANF4cbGXwAi11) | Rejected: `vendor`'s daily cap |
| d | 2 NEAR to `vendor2` | [`BDyB43Yc…5XtVg`](https://testnet.nearblocks.io/txns/BDyB43YczcnCr92nr1GSqiwk9UHGqppYvx64EEG5XtVg) | Settled |
| e | 2 NEAR to `vendor2` | [`8NFg2Gws…fiTY`](https://testnet.nearblocks.io/txns/8NFg2Gws3MtYCrqxN5zv8j1nZ5Vg92gD6aFSydYsfiTY) | Settled |
| f | 2 NEAR to `vendor3` | [`3nuvASkD…YGcb`](https://testnet.nearblocks.io/txns/3nuvASkDwkkehXdLoSfcPT2nNEgKqJyQWczFd3aAYGcb) | Rejected with `MANDATE_DAILY_CAP`: the agent's 10 NEAR daily budget |

### Scene 8: pause stops payments

| Step | Link | Where it goes |
| --- | --- | --- |
| Pause | [`5Gmra1NM…RDH1g`](https://testnet.nearblocks.io/txns/5Gmra1NMhyJHXenbGWPofZvHSBDpMFUFTEYC83gRDH1g) | The payer's `pause` call. |
| Payment after the pause | [`Fz6nGA99…yV21n`](https://testnet.nearblocks.io/txns/Fz6nGA99zJchPn1dDtu2xcGKhuBW8VbS8hiDKnjyV21n) | Rejected with `PAYMENTS_PAUSED`. No transfer. |
| Resume | [`5Exgw7re…Re2XC`](https://testnet.nearblocks.io/txns/5Exgw7remWa5aHsus1rfLsj1PExR4X2hMWb27F7Re2XC) | The payer's `resume` call. |

### Scene 9: replayed request

| Step | Link | Where it goes |
| --- | --- | --- |
| Original payment | [`Aoa1uPEe…T3zx`](https://testnet.nearblocks.io/txns/Aoa1uPEe4kHxdLMhEJV7Mac7cJMooqP8x6BrYDWpT3zx) | The first settlement for this request ID. |
| Same request ID resubmitted | [`FAUVUrkF…yTXm`](https://testnet.nearblocks.io/txns/FAUVUrkFQMWSFANBQWgX4GeKoCYocdHYbFJYCM3yyTXm) | Refused by the payer and resolved as the original settlement. Nothing is paid twice. |

### Scene 10: transferring the agent token

| Step | Link | Where it goes |
| --- | --- | --- |
| Transfer `bot-1.desk` to `nfw-vendor3-1112.testnet` | [`5fyiVadc…WCX`](https://testnet.nearblocks.io/txns/5fyiVadcpZ6XeweDMFP4VYN7mwYLncK4YspRnVngyWCX) | The NFT transfer. The agent's generation advances from 3 to 4. |
| The leaf's next payment from the old payer | [`5JhNpxeK…4oy`](https://testnet.nearblocks.io/txns/5JhNpxeKHzwPQDjFmyatFWebc6BdzvzxNdmCk2uBU4oy) | Rejected: the payer no longer holds the agent. |

### Scene 11: leaf agents and branch control

| Step | Link | Where it goes |
| --- | --- | --- |
| Register `desk` | [`ERBUCTxK…3tgz`](https://testnet.nearblocks.io/txns/ERBUCTxKWvLCiuupnZJU7BzEgttdbCZPEVyYQnV83tgz) | Mints the parent agent. |
| Create leaf `bot-1.desk` | [`CX5eQYJ1…eLAJX`](https://testnet.nearblocks.io/txns/CX5eQYJ13X67CoSXLNcHHXqmjpooxrJDNB6rENqeLAJX) | Mints the leaf under `desk`, with executor `nfw-runner1-1112.testnet`. |
| Approve the branch with a 5 NEAR daily pool | [`HJubaCct…t2K1T`](https://testnet.nearblocks.io/txns/HJubaCctWwSPXcjnysgcBYDiEFPhkYTeDCf85zot2K1T) | The payer's mandate for the whole `desk` branch. |
| Leaf pays 3 NEAR | [`64m9rqMb…FDyx`](https://testnet.nearblocks.io/txns/64m9rqMbhqKatEMosShnNazG3iP3HDNAePD7Sy7YFDyx) | Settled from the shared pool. |
| Parent pays 2 NEAR | [`6mjFK31M…rry7G`](https://testnet.nearblocks.io/txns/6mjFK31MtVPJZGP9cp8ymFo77W14nbx4u3GUQRcrry7G) | Settled. The pool is now at 5 of 5. |
| Leaf asks for 1 more NEAR | [`Hh9aWJyL…Pk5gFo`](https://testnet.nearblocks.io/txns/Hh9aWJyLYyK8NkJkTPJfaWKGyCuN722kotDZJJPk5gFo) | Rejected with `MANDATE_DAILY_CAP`: the shared pool is used up. |
| Leaf pays after `desk` is paused | [`37YobYSY…Ufxy1`](https://testnet.nearblocks.io/txns/37YobYSYjM6AkkZJSrAwRiZeiWC8kfoniZNiDBjUfxy1) | Rejected with `BRANCH_PAUSED`. |

## Endpoints and local links

| Link | Where it goes |
| --- | --- |
| [https://test.rpc.fastnear.com](https://test.rpc.fastnear.com) | FastNEAR's Testnet JSON-RPC endpoint, which the SDK, runner, and scripts use (`NEAR_RPC_URL`). It accepts JSON-RPC POST requests and is not a page to browse. |
| [http://localhost:5173](http://localhost:5173) | The NEARFirewall web app, served by `npm run web:dev`. It works only on this machine while the dev server is running. |
| [https://testnet.nearblocks.io](https://testnet.nearblocks.io) | The NearBlocks Testnet explorer home page. Search it for any account or transaction hash. |

## Checking from the terminal

The same information is available without a browser:

```bash
near account view-account-summary nfw-registry-1112.testnet network-config testnet now   # registry: balance, storage, code hash, keys
near account view-account-summary nfw-alice-1112.testnet network-config testnet now      # payer: the same, for the policy account
source scripts/demo.env && node scripts/demo-owner.ts status                             # agents, budgets used today, recent payments
```

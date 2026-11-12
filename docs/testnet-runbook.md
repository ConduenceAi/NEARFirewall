# Testnet runbook

This runbook covers running the NEARFirewall demo on NEAR Testnet:
- **Part A** uses the deployment that already exists.
- **Part B** sets up a new deployment from scratch.

Every command below was run on Windows (Git Bash) on 2026-11-12, with `cargo-near` 0.23.0 and NEAR CLI (`near`) 0.31.1.

## Current deployment

| Role | Account |
| --- | --- |
| Registry | `nfw-registry-1112.testnet` |
| Demo payer ("Alice"), running the account policy | `nfw-alice-1112.testnet` |
| Executor of `market-agent` and `desk` (one key: `execute` on the registry only) | `nfw-runner-1112.testnet` |
| Executor of the leaf `bot-1.desk` (same kind of key) | `nfw-runner1-1112.testnet` |
| Vendors | `nfw-vendor-1112.testnet`, `nfw-vendor2-1112.testnet`, `nfw-vendor3-1112.testnet` |

Code hashes are in [`deployments/testnet.json`](../deployments/testnet.json). The demo accounts' keys are in the NEAR CLI legacy keychain on the machine that created them (`~/.near-credentials/testnet`). Everything below that signs must run on that machine, or on one you copy the keychain to.

## Part A: run the demo

### Once per terminal

```bash
cd NEARFirewall
npm ci                      # first time only
source scripts/demo.env     # account names and the RPC endpoint; copy from scripts/demo.env.example
```

### See the current state

```bash
node scripts/demo-owner.ts status
```

This shows the payer's available balance, each agent (holder, executor, and generation), its budget used today, and the last 10 payment outcomes with reasons.

### Run the agent (scenes 3, 5, 6, 8, 9)

The runner signs with the executor's restricted key. It finds the key in the keychain by itself.

```bash
npm run runner -- apps/runner/scenarios/readme-limits.json --preview   # dry run against the payer's checks
npm run runner -- apps/runner/scenarios/blocked.json                   # scene 3 and the duplicate-request check
npm run runner -- apps/runner/scenarios/readme-limits.json             # scene 6
node scripts/demo-owner.ts pause                                       # scene 8
npm run runner -- apps/runner/scenarios/after-pause.json
node scripts/demo-owner.ts resume
```

Each line prints ✓ when the outcome matches what the scenario expects, together with the transaction hash. Open a hash at `https://testnet.nearblocks.io/txns/<hash>`.

**Budgets reset at 00:00 UTC.** To rerun the limit scenes on the same day, set up a fresh agent; its usage starts at zero. The payer needs about 10 NEAR available for scene 6, so check `status` first. To top up from any funded testnet account:

```bash
near tokens <funded-account> send-near $NEARFIREWALL_OWNER '10 NEAR' network-config testnet sign-with-legacy-keychain send

export NEARFIREWALL_AGENT=market-agent-2
node scripts/demo-owner.ts setup      # registers the agent and approves the three vendors through the template
npm run runner -- apps/runner/scenarios/readme-limits.json
```

### Agent tree (scenes 10 and 11)

`desk` and its leaf `bot-1.desk` already exist. The leaf's executor is `nfw-runner1-1112.testnet`, so those runs set `NEARFIREWALL_EXECUTOR` to that account.

```bash
NEARFIREWALL_EXECUTOR=$NEARFIREWALL_LEAF_EXECUTOR npm run runner -- apps/runner/scenarios/tree-1-leaf-pays.json
npm run runner -- apps/runner/scenarios/tree-2-parent-pays.json
NEARFIREWALL_EXECUTOR=$NEARFIREWALL_LEAF_EXECUTOR npm run runner -- apps/runner/scenarios/tree-3-pool-exhausted.json
node scripts/demo-owner.ts pause-agent desk
NEARFIREWALL_EXECUTOR=$NEARFIREWALL_LEAF_EXECUTOR npm run runner -- apps/runner/scenarios/tree-4-branch-paused.json
node scripts/demo-owner.ts resume-agent desk
```

On 2026-11-12, `bot-1.desk` was transferred to `nfw-vendor3-1112.testnet` for scene 10. It can no longer spend from the payer, so `tree-1` and `tree-3` now end in `PAYER_NOT_AUTHORIZED`. To show scene 11 again, create a new tree from the web app (Agents → Add leaf agent), or run `node scripts/demo-owner.ts tree` with a new handle.

### Web app with Meteor (scenes 1, 2, 4, 7)

```bash
npm run web:dev      # http://localhost:5173, configured by apps/web/.env.local
```

1. **Connect wallet**, then choose Meteor and sign in with your own Testnet account. Create one in Meteor if needed, and fund it with at least 15 NEAR.
2. **Payments → Enable payments.** This sends one transaction to your own account: it deploys the policy and calls `initialize`. About 2.4 NEAR of your balance becomes locked for the code's storage. This is spike S1: note whether Meteor signs it. If it does not, use the CLI command in step B4 with your account.
3. **Agents → Register an agent.** Use a new handle, executor `nfw-runner-1112.testnet` (or your own restricted executor), and 5 NEAR max per payment.
4. **Payments → Approve vendors.** Check "already registered", add the three vendors with 3/6, 2/4 and 3/6 NEAR limits and a 10 NEAR budget, then **Review** and **Sign step 1**.
5. Run the agent against your account, with your account as the payer:

   ```bash
   NEARFIREWALL_OWNER=<your-account>.testnet NEARFIREWALL_AGENT=<your-handle> npm run runner -- apps/runner/scenarios/readme-limits.json
   ```

6. **Activity** shows every payment and every blocked attempt, with its reason.

## Part B: set up a new deployment

### B1. Tools

- Rust stable with `rustup target add wasm32-unknown-unknown`
- Node.js 24
- `cargo-near`
- NEAR CLI

The last two install from their GitHub releases (`near/cargo-near`, `near/near-cli-rs`). Download the archive for your platform, check it against its `.sha256` file, and put the binary on your PATH (for example `~/.cargo/bin`).

### B2. Build and test

```bash
cargo test --workspace
npm ci && npm test && npm run typecheck
npm run contracts:build     # cargo near build --no-abi for both contracts
cp target/near/nearfirewall_account_policy/nearfirewall_account_policy.wasm apps/web/public/
```

`--no-abi` is required on Windows, where `cargo-near`'s ABI step fails to link. The deployable WASM files are `target/near/nearfirewall_registry/nearfirewall_registry.wasm` (about 331 KB) and `target/near/nearfirewall_account_policy/nearfirewall_account_policy.wasm` (about 238 KB).

### B3. Accounts and the registry

Faucet accounts start with 10 NEAR. Use your own names in place of `<you>`.

```bash
for n in registry alice runner vendor vendor2 vendor3; do
  near account create-account sponsor-by-faucet-service <you>-$n.testnet \
    autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
done

near contract deploy <you>-registry.testnet \
  use-file target/near/nearfirewall_registry/nearfirewall_registry.wasm \
  with-init-call new json-args '{}' prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' \
  network-config testnet sign-with-legacy-keychain send
```

### B4. Enable payments on the payer (CLI path)

This is one transaction, signed by the payer: deploy the policy, then `initialize` with the trusted registry.

```bash
near contract deploy <you>-alice.testnet \
  use-file target/near/nearfirewall_account_policy/nearfirewall_account_policy.wasm \
  with-init-call initialize json-args '{"registry":"<you>-registry.testnet","account_daily_cap":null}' \
  prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-legacy-keychain send
```

Top up the payer from the vendor accounts (`near tokens <vendor> send-near <payer> '8 NEAR' ...`). After storage, it needs about 20 NEAR to run every scene.

### B5. Restrict the executor (spike S4)

```bash
near account add-key <you>-runner.testnet grant-function-call-access \
  --allowance '1 NEAR' --contract-account-id <you>-registry.testnet --function-names execute \
  autogenerate-new-keypair save-to-legacy-keychain network-config testnet sign-with-legacy-keychain send

near account list-keys <you>-runner.testnet network-config testnet now     # note the full-access key
near account delete-keys <you>-runner.testnet public-keys <full-access-public-key> \
  network-config testnet sign-with-legacy-keychain send
```

Afterwards, `list-keys` must show exactly one key: `only do ["execute"] function calls on <you>-registry.testnet`.

### B6. Configure and run

1. Copy `scripts/demo.env.example` to `scripts/demo.env` and put in your account names.
2. Copy `apps/web/.env.example` to `apps/web/.env.local` with your registry ID and the policy's code hash. Read the code hash with `near account view-account-summary <payer> network-config testnet now`, or from `view_account`.
3. Write `deployments/testnet.json`.
4. Continue with Part A.

### Upgrading a contract

The registry's state layout has not changed, so redeploy without an init call:

```bash
near contract deploy <you>-registry.testnet use-file target/near/nearfirewall_registry/nearfirewall_registry.wasm \
  without-init-call network-config testnet sign-with-legacy-keychain send
```

## Spike results (2026-11-12)

| Spike | Result |
| --- | --- |
| S1: Meteor signs deploy plus `initialize` | **Not yet tested.** It needs a person in the browser. The CLI path works. |
| S2: global contract | **Not yet tested.** |
| S3: payment comes from the payer's own account; failure reaches the callback | **Confirmed** for success. Receipt: `nfw-alice-1112.testnet → nfw-vendor-1112.testnet: Transfer 2 NEAR`, then `on_settle`, final value `settled`. The failure path is unit-tested only. |
| S4: restricted executor key | **Confirmed.** The key listing allows only `execute` on the registry, and every runner call went through that key. |
| S5: gas | Every scenario ran within the runner's 150 Tgas. Depth-8 gas has not been measured on chain yet. |

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `RPC HTTP 429` | The public RPC is rate-limiting | Use `NEAR_RPC_URL=https://test.rpc.fastnear.com` (the default in `scripts/demo.env`). The SDK retries 429 and 5xx responses with backoff. |
| `cargo near build` fails at `link.exe` on Windows | The ABI step builds a native DLL | Add `--no-abi` (already in `npm run contracts:build`) |
| `INSUFFICIENT_BALANCE` | Available balance is the account balance minus code storage, in-flight reservations, and a 0.5 NEAR safety buffer | Top up the payer |
| `CAP_EXCEEDED` instead of `PER_PAYMENT_CAP` | The agent's own capability is below the vendor's limit, so the registry blocks the request first | Register agents with a capability above the vendors' per-payment limits |
| `PAYER_NOT_AUTHORIZED` | The payer does not hold the requesting agent, for example after a transfer | Use the holder's account as the payer |
| A request is `uncertain` | Network timeout | `npm run runner -- --resolve`. It reads the payer's on-chain record and only resubmits with the same request ID. |

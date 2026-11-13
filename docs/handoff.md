# NEARFirewall: handoff plan for the remaining work

Written 2026-11-13 for an engineer or AI agent continuing this repository. Read `README.md`, `docs/implementation-plan.md` ("Revision 2") and `docs/demo.md` first. Nothing below is committed; `git status` shows the working tree.

## What NEARFirewall is

An agent gets a restricted key on its owner's NEAR account. The owner's payment-policy contract, on that same account, decides on-chain whether the agent's payment is sent, waits for the owner ("ask me first"), or is blocked. Agents are NFTs in the owner's own registry (`agents.<owner>`). Local MCP server and a gateway let Claude, ChatGPT, n8n and similar platforms use the key.

## State today

**Built and passing:** `cargo test --workspace` (policy 85, registry 48, types 4), `npm test` (109 tests, 12 files), root and web type-checks.

**Verified on Testnet with a fresh owner `nfw-owner-1114.testnet`** (new contracts: registry hash `EbdKyaLuPKyfZPkrc7KKDX3mLCGohnpvkzmQavKj8dq1`, policy hash `38swDQ3scgWAZkXkXPedBqz7GFMLujTowxjr94LEE1fR`):
- Registry created on `agents.nfw-owner-1114.testnet` in one keyless transaction, payments enabled, agent `trader` registered with no executor, rules set.
- Connection key (only `agent_execute`), guardian key (only `guardian_block`) and browsing records added.
- Real MCP server over stdio: rules, a settled payment, an attacker blocked, a 4.5 NEAR payment held for confirmation, a per-payment-cap denial.
- Owner blocked an approved vendor: the waiting payment was refused at confirmation with `RECIPIENT_BLOCKED` and its reservation released, and new payments were refused.

**Code present but not yet exercised live:** the gateway (`apps/gateway`), `fetch_url` (`packages/mcp/src/guarded-fetch.ts`), guardian scripts, and the web UI for safeguards and gateway setup.

## Incomplete work, in priority order

### 1. Finish the live Testnet verification (small, do first)

Commands are in `docs/testnet-runbook.md` and the headers of each script.

1. **Guardian steps failed on a wrong label, not a bug.** The guardian key was saved as `site-watcher`, but the scripts default to `watcher`. Rerun with the label:
   ```bash
   node scripts/guardian.ts nfw-owner-1114.testnet block nfw-vendor-1112.testnet "fingerprint mismatch" --label site-watcher
   node scripts/guardian.ts nfw-owner-1114.testnet block nfw-vendor-1112.testnet --label site-watcher   # expect "Already blocked"
   node scripts/guardian-probe.ts nfw-owner-1114.testnet --label site-watcher                         # every line must say "refused"
   node scripts/mcp-smoke.ts nfw-owner-1114.testnet --steps pay                                       # expect RECIPIENT_BLOCKED
   node scripts/v2-owner.ts nfw-owner-1114.testnet unblock nfw-vendor-1112.testnet
   ```
   If any probe line says `!! ALLOWED`, that is a contract bug: stop and fix.
2. **Gateway as a separate process, over HTTP:**
   ```bash
   node scripts/gateway-smoke.ts nfw-owner-1114.testnet --fetch https://example.com/   # allowed by the owner's rules
   node scripts/gateway-smoke.ts nfw-owner-1114.testnet --fetch https://www.iana.org/  # must be refused: not on the allowed list
   ```
   Expect REST and remote-MCP payments to settle, the attacker to be blocked, and unauthenticated calls to return 401.
3. **Finish the lifecycle:** `node scripts/v2-owner.ts nfw-owner-1114.testnet disconnect`, then `guardian-remove --label site-watcher`. Confirm the agent's next MCP call fails with "not connected".
4. Record every transaction hash in `docs/demo.md` (see step 3).

The faucet-funded demo accounts hold little NEAR. Do not create many accounts to farm the faucet.

### 2. Make the web app trust the new contracts (important, one-line fixes)

`apps/web/.env.local` (gitignored) still pins the **old** hashes, so the app would mark every new registry or policy "untrusted". Set:
```
VITE_REGISTRY_CODE_HASH=EbdKyaLuPKyfZPkrc7KKDX3mLCGohnpvkzmQavKj8dq1
VITE_POLICY_CODE_HASH=38swDQ3scgWAZkXkXPedBqz7GFMLujTowxjr94LEE1fR
```
Rebuild with `npm run contracts:build`, then copy both `target/near/*/*.wasm` into `apps/web/public/`. Document the hashes in `apps/web/.env.example`. Also:
- Add `RECIPIENT_BLOCKED` (and `UNKNOWN_CONNECTION`, `AUTHORIZATION_FAILED`, `CONFIRMATION_*`, `TOO_MANY_PENDING` if missing) to `apps/web/src/reasonGroups.ts`.
- Run `npm run web:dev`, connect a wallet, and exercise: Payments → Blocked recipients and Guardians (`Safeguards.tsx`), Connect panel for a cloud platform (`GatewaySetup.tsx`), and the map/inspector showing blocked recipients. Fix whatever a browser shows. Add Playwright or component tests if time allows.

### 3. Documentation (nothing about R6/R7 is written yet)

Grep shows zero mentions of guardian, gateway, `fetch_url`, `RECIPIENT_BLOCKED` or `access.allowed_domains` in `Docs.tsx`, `README.md` or the runbook. Add, in NEARFirewall's own terms (no outside project names in `README.md` or the Docs page; platform names belong only in the platform catalog and `docs/implementation-plan.md`):
- **`apps/web/src/pages/Docs.tsx`:**
  - In "Connect your AI agent": replace the "Coming soon" gateway text with the real steps (generate the token in the Connect panel, run `apps/gateway`, serve over HTTPS, paste the MCP URL or call the REST API). Include the REST routes `GET /api/status|rules|activity`, `POST /api/preview|pay`.
  - New sections: "Blocked recipients and guardians" and "Browsing rules" (`access.allowed_domains`, `access.blocked_domains`, `fetch_url`). Be explicit that payment rules are enforced on-chain, but browsing rules are enforced only where the agent runs.
  - Add a gateway/guardian figure in `components/diagrams/figures.tsx` if wanted. Update the "Which rule wins" ladder: the blocklist is checked right after the request is validated, before any approval.
  - Add `RECIPIENT_BLOCKED` to the reasons table.
- **`README.md`:** repository layout (add `packages/mcp`, `apps/gateway`, `scripts`), the stack row for MCP and the gateway, and the status line.
- **`docs/testnet-runbook.md`:** new commands (`block`, `unblock`, `guardian-add`, `guardian-remove`, `access`, `gateway-smoke`), the new hashes, and `nfw-owner-1114`.
- **`docs/implementation-plan.md`:** set R6, R7, R8 statuses (currently "Not started"); note the Docker caveat below.
- **`docs/demo.md`:** move V6/V7/V8 evidence in (hashes from step 1); update the change log; the file is gitignored on purpose and must never be committed.
- **`deployments/`:** add `testnet-v2.json` (a manifest for the per-user registry release: both code hashes, the example owner, source revision) and a zod schema for it in `packages/sdk/src/manifest.ts`. Keep `testnet.json` as is: the app uses it to recognise the original shared-registry demo.

### 4. Known gaps that need a person or environment I did not have

| Gap | What to do |
| --- | --- |
| **Docker image never built** (the daemon was not running). The install steps and start command were replayed in a clean folder and worked. | Start Docker, run `docker build -f apps/gateway/Dockerfile -t nearfirewall-gateway .`, then `docker run` with the env from the Connect panel, and check `/health`. |
| **No wallet has signed any of this.** Whether Meteor signs the registry-creation batch (`CreateAccount`, `Transfer`, deploy, `new`), `AddKey` with a function-call permission, and `UseGlobalContract` is unknown (plan spikes S1, S2, S6, S7). | A person must run the web app and approve each transaction in Meteor. Fallbacks: the CLI scripts. |
| **Global contracts (NEP-591) not published.** Each user currently pays ~7 NEAR of storage for two direct deployments. Publishing is estimated at tens of NEAR per contract (about 10× storage), more than a faucet account holds. | Publish both WASMs once from a funded account with `near contract deploy-as-global`, then use `VITE_*_GLOBAL_CODE_HASH`. Verify the real cost before promising anything. |
| **Platform setup steps are unverified** (ChatGPT, Claude on the web, n8n, Gumloop, Zapier, Make) in `apps/web/src/platforms.ts`. | Check each against that product's current docs; fix wording; the panel already says menus change. |
| **No Vercel or Cloudflare gateway template.** Only Docker and plain Node exist. | Add only if tested. |
| **MCP not tried in the real Claude Desktop or Claude Code.** It was exercised through the MCP SDK client over stdio and HTTP. | Paste the Connect panel's config into Claude Desktop and run get_rules and a payment. |
| **Automated cross-contract tests** (`near-workspaces`) do not exist; NEAR Sandbox does not run on Windows. | Add them on Linux or in CI (`.github/workflows/ci.yml` already runs Rust and TS checks). |
| **Demo recording** (tracker item C11). | A person records `docs/demo.md` scenes. |
| **No state migration.** A policy or registry layout change needs a fresh account (older demo accounts `nfw-alice-1112`, `nfw-owner-1113` run older contracts). | Phase 13 in the plan: versioned state and a `migrate` method. |

### 5. Optional hardening

- Add the guarded fetch's DNS-rebinding and redirect tests to a Linux CI run, plus a gateway test that proves tokens never reach logs under load.
- Rate limits and the 50/100 blocklist bounds are guesses; measure on Testnet.
- Gas: `agent_execute` uses 120 Tgas. Measure at agent-tree depth 8.

## How to verify when done

```bash
cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace            # 137 tests today
npm test                          # always via npm: it fixes a Windows drive-letter issue in Vitest
npx tsc -p tsconfig.json --noEmit && npx tsc -p apps/web/tsconfig.json --noEmit
npm run web:build
npm run contracts:build           # cargo-near with --no-abi (ABI generation fails to link on Windows)
```
Then the live checks in step 1 against Testnet.

## Rules for whoever continues

- Never commit `docs/demo.md` or `docs/architecture-research.md`; they are gitignored on purpose. Update `docs/demo.md` after every repository change.
- `README.md` and the Docs page must not name outside projects. Tooling and NEAR documentation links are fine.
- Never print, log or commit a private key, seed phrase or gateway token. Keys for the demo accounts live in `~/.near-credentials/testnet`.
- Never give an agent an owner's full-access key. Agents get only the restricted keys the app generates.
- Do not commit unless the user asks.
- In scripts that patch files, prefer writing a script file over shell heredocs: backslashes in a heredoc get mangled in this environment.

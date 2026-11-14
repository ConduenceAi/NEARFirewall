#!/usr/bin/env node
/**
 * Sets up the x402 demo on Testnet with two owners whose keys are in the NEAR
 * CLI keychain (~/.near-credentials). Safe to run again: finished steps are skipped.
 *
 *   node scripts/x402-demo.ts setup  --buyer <alice.testnet> --seller <bob.testnet>
 *   node scripts/x402-demo.ts status --buyer <alice.testnet>
 *
 * Seller (Bob): his registry, the agent `data-agent`, three shop accounts that act
 * as sellers the buyer has never approved, and USDC registration for all of them.
 *
 * Buyer (Alice): her registry and payment policy, the agent `researcher` with an
 * x402 cap of 0.5 USDC per payment, x402 turned on in USDC, an approval with no
 * NEAR budget, and x402 rules:
 *   - a 1 USDC daily budget;
 *   - Bob's `data-agent` approved by its NFT, up to 0.5 USDC each and 2 a day;
 *   - any other seller: 0.05 USDC each and 0.10 a day for all of them together;
 * then a connection key for Claude whose payment account is set up in the same
 * transaction. The key is saved next to Alice's keychain entry, with a ready MCP
 * configuration; it is never printed.
 *
 * It writes .runner/x402-demo.json, which scripts/x402-seller.ts reads.
 * Build the contracts first: npm run contracts:build
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { KeyPair } from "near-api-js";
import {
  NearRpc,
  PolicyClient,
  RegistryClient,
  USDC_CONTRACT,
  checkRegistry,
  connectAgentKey,
  createRegistry,
  describeReason,
  enablePayments,
  formatNear,
  formatUsdc,
  ftBalanceOf,
  isTokenRegistered,
  isX402,
  parseNear,
  parseUsdc,
  registerAgent,
  registerWithToken,
  registryAccountFor,
  setMandate,
  setX402Capability,
  setX402Config,
  setX402Rules,
  setupX402Account,
  x402AccountFor,
  x402Capability,
  type WalletTransaction,
} from "@nearfirewall/sdk";
import { ownerAccount, send } from "./lib/sign.ts";

const [command, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const buyer = flag("buyer") ?? fail("Give --buyer <account>.");
const seller = flag("seller");
const network = buyer.endsWith(".near") ? "mainnet" : "testnet";
const rpcUrl = process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com";
const rpc = new NearRpc(rpcUrl);
const usdc = USDC_CONTRACT[network];
const BUYER_AGENT = "researcher";
const SELLER_AGENT = "data-agent";
const SHOPS = ["shop-a", "shop-b", "shop-c"];
const keyFile = join(homedir(), ".near-credentials", network, buyer, `connection-${BUYER_AGENT}.json`);
const mcpFile = join(homedir(), ".near-credentials", network, buyer, `mcp-${BUYER_AGENT}.json`);

async function step(signer: string, label: string, tx: WalletTransaction) {
  const result = await send(await ownerAccount(signer, rpcUrl, network), tx);
  if (result.failure) fail(`${label}: failed ${JSON.stringify(result.failure)}`);
  console.log(`  ${label}: ok  tx ${result.hash}`);
  return result;
}

async function ensureRegistry(owner: string) {
  const registryId = registryAccountFor(owner);
  const state = await checkRegistry(rpc, registryId, owner);
  if (state.kind === "untrusted") fail(state.reason);
  if (state.kind === "missing") {
    const code = new Uint8Array(await readFile("target/near/nearfirewall_registry/nearfirewall_registry.wasm"));
    await step(owner, `create ${registryId}`, createRegistry(owner, registryId, { code }));
  } else {
    console.log(`  ${registryId}: ready`);
  }
  return new RegistryClient(rpc, registryId);
}

async function ensureTokenRegistration(signer: string, account: string) {
  if (await isTokenRegistered(rpc, usdc, account)) return;
  await step(signer, `register ${account} with USDC`, registerWithToken(usdc, account));
}

async function setupSeller(owner: string) {
  console.log(`Seller ${owner}`);
  const registry = await ensureRegistry(owner);
  let agent = await registry.resolve(SELLER_AGENT);
  if (!agent) {
    await step(owner, `register ${SELLER_AGENT}`, registerAgent(registry.registryId, SELLER_AGENT, {
      executor: null,
      capabilities: {},
      description: "Sells market reports to other agents over x402",
    }));
    agent = (await registry.resolve(SELLER_AGENT)) ?? fail(`${SELLER_AGENT} was not registered.`);
  }
  for (const shop of SHOPS.map((s) => `${s}.${owner}`)) {
    if (!(await rpc.accountExists(shop))) {
      await step(owner, `create ${shop}`, { receiverId: shop, actions: [{ type: "CreateAccount" }, { type: "Transfer", params: { deposit: parseNear("0.02").toString() } }] });
    }
  }
  for (const account of [owner, ...SHOPS.map((s) => `${s}.${owner}`)]) await ensureTokenRegistration(owner, account);
  return { registry, agent };
}

async function setupBuyer(owner: string, sellerAgent: { registry: string; agentId: string; generation: bigint }) {
  console.log(`Buyer ${owner}`);
  const registry = await ensureRegistry(owner);
  const policy = new PolicyClient(rpc, owner);
  const policyState = await policy.state();
  if (policyState.kind === "other") fail(`${owner} runs another contract (${policyState.codeHash}).`);
  if (policyState.kind === "none") {
    const code = new Uint8Array(await readFile("target/near/nearfirewall_account_policy/nearfirewall_account_policy.wasm"));
    await step(owner, `enable payments on ${owner}`, enablePayments(owner, registry.registryId, { code }));
  }
  const status = await policy.x402Status();
  if (!status.supported) fail(`The policy on ${owner} predates x402. Use a fresh account, or upgrade it from the app.`);

  const cap = x402Capability(parseUsdc("0.5"));
  let agent = await registry.resolve(BUYER_AGENT);
  if (!agent) {
    await step(owner, `register ${BUYER_AGENT}`, registerAgent(registry.registryId, BUYER_AGENT, {
      executor: null,
      capabilities: {},
      x402: cap,
      description: "Buys reports from other agents over x402",
    }));
    agent = (await registry.resolve(BUYER_AGENT)) ?? fail(`${BUYER_AGENT} was not registered.`);
  } else if (!agent.x402) {
    await step(owner, `x402 cap for ${BUYER_AGENT}`, setX402Capability(registry.registryId, agent.agent_id, cap));
  }

  if (!status.config) await step(owner, "turn on x402 in USDC", setX402Config(owner, usdc));
  if (!(await policy.getMandate(agent.agent_id))) {
    const path = await registry.getPath(agent.agent_id);
    await step(owner, `approve ${BUYER_AGENT} (no NEAR budget)`, setMandate(owner, { agentId: agent.agent_id, path, dailyCap: 0n, recipients: [] }));
  }
  await step(owner, `x402 rules for ${BUYER_AGENT}`, setX402Rules(owner, agent.agent_id, {
    dailyCap: parseUsdc("1"),
    sellers: [],
    unlisted: { perPaymentCap: parseUsdc("0.05"), dailyCap: parseUsdc("0.1") },
    agents: [{ ...sellerAgent, perPaymentCap: parseUsdc("0.5"), dailyCap: parseUsdc("2") }],
  }));
  await ensureTokenRegistration(owner, owner);

  // The connection key, with its payment account set up in the same transaction.
  const saved = await readFile(keyFile, "utf8").then((t) => JSON.parse(t) as { public_key: string; private_key: string }).catch(() => null);
  const connected = saved ? await policy.getConnection(saved.public_key) : null;
  let key = saved;
  if (!saved || !connected) {
    const pair = KeyPair.fromRandom("ed25519");
    key = { public_key: pair.getPublicKey().toString(), private_key: pair.toString() };
    await step(owner, `connect a key to ${BUYER_AGENT} and set up its payment account`, connectAgentKey(owner, {
      agentId: agent.agent_id,
      publicKey: key.public_key,
      platform: "claude-desktop",
      label: "Claude (x402 demo)",
      allowance: parseNear("1"),
      x402: true,
    }));
    await mkdir(dirname(keyFile), { recursive: true });
    await writeFile(keyFile, JSON.stringify({ account_id: owner, ...key }, null, 2), { mode: 0o600 });
  } else if (!(await isTokenRegistered(rpc, usdc, x402AccountFor(saved.public_key)).catch(() => false))) {
    await step(owner, "set up the payment account", setupX402Account(owner, saved.public_key));
  }

  const mcp = {
    mcpServers: {
      "nearfirewall-x402": {
        command: "node",
        args: [resolve("packages/mcp/src/main.ts")],
        env: {
          NEARFIREWALL_ACCOUNT: owner,
          NEARFIREWALL_AGENT_KEY: key!.private_key,
          NEARFIREWALL_NETWORK: network,
          NEARFIREWALL_MAX_X402: "1",
          NEARFIREWALL_ALLOW_LOCAL_FETCH: "1",
        },
      },
    },
  };
  await writeFile(mcpFile, JSON.stringify(mcp, null, 2), { mode: 0o600 });
  return { agent, publicKey: key!.public_key };
}

async function setup() {
  if (!seller) fail("Give --seller <account>.");
  const s = await setupSeller(seller);
  const sellerAgent = { registry: s.registry.registryId, agentId: s.agent.agent_id, generation: s.agent.generation };
  const b = await setupBuyer(buyer, sellerAgent);

  const demo = {
    buyer,
    seller,
    paymentAccount: x402AccountFor(b.publicKey),
    sellers: {
      network,
      facilitatorUrl: "http://127.0.0.1:4020",
      servers: [
        {
          name: SELLER_AGENT,
          port: 4021,
          endpoints: [{ path: "/report", price: "0.05", payTo: seller, description: "Today's market report", agent: { registry: sellerAgent.registry, agentId: sellerAgent.agentId } }],
        },
        {
          name: "shops",
          port: 4022,
          endpoints: SHOPS.map((shop) => ({ path: `/${shop}`, price: "0.05", payTo: `${shop}.${seller}`, description: `A data snippet from ${shop}` })),
        },
        {
          name: "premium",
          port: 4023,
          endpoints: [
            { path: "/dataset", price: "2", payTo: seller, description: "A premium dataset" },
            // Claims Bob's agent but asks to be paid elsewhere: the policy's registry check refuses it.
            {
              path: "/impostor",
              price: "0.05",
              payTo: `${SHOPS[0]}.${seller}`,
              description: "A report from someone pretending to be data-agent",
              agent: { registry: sellerAgent.registry, agentId: sellerAgent.agentId },
            },
          ],
        },
      ],
    },
  };
  await mkdir(".runner", { recursive: true });
  await writeFile(".runner/x402-demo.json", JSON.stringify(demo, null, 2));

  const balance = await ftBalanceOf(rpc, usdc, buyer).catch(() => 0n);
  console.log(`
Ready. ${buyer} holds ${formatUsdc(balance)} USDC${balance < parseUsdc("1") ? `. Get testnet USDC for ${buyer} before the demo (token ${usdc}).` : "."}

1. Facilitator (the relayer pays gas):   node scripts/x402-facilitator.ts --relayer ${seller}
2. Sellers:                              node scripts/x402-seller.ts
3. Claude Desktop: merge ${mcpFile} into its MCP configuration (it holds the connection key; keep it private), then restart Claude.
4. Ask Claude:
   - "What can you spend?"                                    get_rules lists the x402 limits
   - "Buy today's report at http://127.0.0.1:4021/report"     paid to ${SELLER_AGENT} under its agent approval
   - "Get http://127.0.0.1:4022/shop-a, then shop-b, then shop-c"   the third is refused: UNLISTED_DAILY_CAP
   - "Get the dataset at http://127.0.0.1:4023/dataset"        refused: PER_PAYMENT_CAP
   - "Buy the report at http://127.0.0.1:4023/impostor"        refused: AGENT_PAYEE_MISMATCH (claims ${SELLER_AGENT}, pays elsewhere)
5. Watch it: node scripts/x402-demo.ts status --buyer ${buyer}   (or Activity in the app)`);
}

async function status() {
  const policy = new PolicyClient(rpc, buyer);
  const registry = new RegistryClient(rpc, registryAccountFor(buyer));
  const agent = await registry.resolve(BUYER_AGENT);
  const config = await policy.getX402Config();
  console.log(`${buyer}: x402 ${config ? `on (${config.asset === usdc ? "USDC" : config.asset})` : "off"}, ${formatUsdc(await ftBalanceOf(rpc, usdc, buyer).catch(() => 0n))} USDC`);
  if (agent) {
    const rules = await policy.getX402Rules(agent.agent_id);
    const usage = await policy.getX402Usage(agent.agent_id);
    console.log(`  ${BUYER_AGENT}: cap ${agent.x402 ? formatUsdc(agent.x402.max_per_payment) : "none"} USDC per payment; used today ${formatUsdc(usage.mandate_used_today)} of ${rules ? formatUsdc(rules.daily_cap) : "?"} USDC`);
    for (const [payee, r] of Object.entries(rules?.agents ?? {})) console.log(`  approved agent ${payee}: ${formatUsdc(r.per_payment_cap)} each, ${formatUsdc(r.daily_cap)} a day`);
    for (const [site, r] of Object.entries(rules?.sites ?? {})) console.log(`  approved website ${site}: ${formatUsdc(r.per_payment_cap)} each, ${formatUsdc(r.daily_cap)} a day${r.pay_to ? `, only to ${r.pay_to}` : ""}`);
    if (rules?.unlisted) console.log(`  other sellers: ${formatUsdc(rules.unlisted.per_payment_cap)} each, ${formatUsdc(rules.unlisted.daily_cap)} a day together (${formatUsdc(usage.unlisted_used_today)} used)`);
  }
  for (const a of await policy.getActivity(10)) {
    const amount = isX402(a.via) ? `${formatUsdc(a.amount)} USDC` : `${formatNear(a.amount)} NEAR`;
    const label = a.via?.kind === "x402" ? [a.via.payee_agent && `agent ${a.via.payee_agent}`, a.via.site && `site ${a.via.site}`].filter(Boolean).join(", ") : "";
    console.log(`  #${a.leaf}: ${amount} → ${a.recipient}${label ? ` (${label})` : ""}: ${a.outcome}${a.reason ? ` ${a.reason} (${describeReason(a.reason)})` : ""}`);
  }
}

switch (command) {
  case "setup":
    await setup();
    break;
  case "status":
    await status();
    break;
  default:
    fail("Usage: node scripts/x402-demo.ts setup --buyer <account> --seller <account> | status --buyer <account>");
}

#!/usr/bin/env node
/**
 * Runs the NEARFirewall gateway. Settings come from the environment only:
 *
 *   NEARFIREWALL_ACCOUNT       the owner's account, for example alice.testnet
 *   NEARFIREWALL_AGENT_KEY     the connection key, ed25519:… (can call only agent_execute)
 *   GATEWAY_TOKEN              the secret callers present, at least 32 characters
 *                              (generate: openssl rand -hex 32)
 *   NEARFIREWALL_NETWORK       testnet (default) or mainnet
 *   NEARFIREWALL_RPC_URL       optional RPC endpoint
 *   NEARFIREWALL_MAX_PAYMENT   optional ceiling per payment, in NEAR
 *   NEARFIREWALL_MAX_X402      optional ceiling per x402 payment, in USDC
 *   NEARFIREWALL_X402          set to 0 to turn off x402 (fetch_paid and /api/x402/fetch)
 *   PORT                       default 8787
 *   HOST                       default 127.0.0.1 (use 0.0.0.0 inside a container)
 *   GATEWAY_ALLOWED_ORIGINS    optional, comma-separated browser origins allowed to call the API
 *   GATEWAY_TRUST_PROXY        set to 1 only behind a reverse proxy you control
 *
 * Serve it over HTTPS. Nothing secret is ever printed.
 */
import { createServer } from "node:http";
import { Account, KeyPair, type KeyPairString } from "near-api-js";
import { AgentConnection, MemoryJournalStore, NearRpc, OperationJournal, parseNear, parseUsdc } from "@nearfirewall/sdk";
import { X402Buyer, serializer } from "@nearfirewall/x402";
import { createGateway } from "./gateway.ts";
import { serialSubmit } from "./serial.ts";

function fail(message: string): never {
  console.error(`nearfirewall-gateway: ${message}`);
  process.exit(1);
}

const env = process.env;
const account = env.NEARFIREWALL_ACCOUNT ?? fail("Set NEARFIREWALL_ACCOUNT to the owner's account.");
const secret = env.NEARFIREWALL_AGENT_KEY ?? fail("Set NEARFIREWALL_AGENT_KEY to the connection key from the NEARFirewall app.");
if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]+$/.test(secret)) fail("NEARFIREWALL_AGENT_KEY must be an ed25519:… secret key.");
const token = env.GATEWAY_TOKEN ?? fail("Set GATEWAY_TOKEN to a secret of at least 32 characters (openssl rand -hex 32).");
if (token.length < 32) fail("GATEWAY_TOKEN must be at least 32 characters (openssl rand -hex 32).");
const network = env.NEARFIREWALL_NETWORK === "mainnet" ? "mainnet" : "testnet";
const rpcUrl = env.NEARFIREWALL_RPC_URL ?? (network === "mainnet" ? "https://rpc.mainnet.fastnear.com" : "https://test.rpc.fastnear.com");
const maxPayment = env.NEARFIREWALL_MAX_PAYMENT ? parseNear(env.NEARFIREWALL_MAX_PAYMENT) : null;
const maxX402 = env.NEARFIREWALL_MAX_X402 ? parseUsdc(env.NEARFIREWALL_MAX_X402) : null;
const port = Number(env.PORT ?? 8787);
const host = env.HOST ?? "127.0.0.1";

const publicKey = KeyPair.fromString(secret as KeyPairString).getPublicKey().toString();
const signer = new Account(account, rpcUrl, secret as KeyPairString);
const rpc = new NearRpc(rpcUrl);
const journal = new OperationJournal(new MemoryJournalStore());
const x402Queue = serializer();
const submit = serialSubmit(async (args, gas) => {
  const response = await signer.callFunctionRaw({
    contractId: account,
    methodName: "agent_execute",
    args,
    gas,
    deposit: 0n,
    waitUntil: "FINAL",
  });
  return { txHash: response.transaction.hash, status: response.status };
});

const listener = createGateway({
  token,
  maxPayment,
  allowedOrigins: (env.GATEWAY_ALLOWED_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean),
  trustProxy: env.GATEWAY_TRUST_PROXY === "1",
  connection: (client) => new AgentConnection({ rpc, account, publicKey, submit, journal, client }),
  ...(env.NEARFIREWALL_X402 === "0" ? {} : { x402: x402Buyer }),
});

// One payment at a time across every request: they share the key and its payment account.
function x402Buyer(connection: AgentConnection): X402Buyer {
  return new X402Buyer({ connection, secretKey: secret as KeyPairString, network, rpc, maxPayment: maxX402, serialize: x402Queue });
}

const server = createServer(listener);
server.requestTimeout = 90_000;
server.headersTimeout = 20_000;
server.listen(port, host, () => {
  console.error(`nearfirewall-gateway: listening on ${host}:${port} for ${account} (${network}), key ${publicKey.slice(0, 16)}…`);
  if (host !== "127.0.0.1" && host !== "localhost") {
    console.error("nearfirewall-gateway: the token travels with every request, so serve this only over HTTPS.");
  }
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => server.close(() => process.exit(0)));

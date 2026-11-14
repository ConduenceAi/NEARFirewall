#!/usr/bin/env node
/**
 * Runs the NEARFirewall MCP server over stdio.
 *
 * Settings come from the environment only, never from tool inputs:
 *   NEARFIREWALL_ACCOUNT    the owner's account, for example alice.testnet
 *   NEARFIREWALL_AGENT_KEY  the connection key, ed25519:… (can call only agent_execute)
 *   NEARFIREWALL_NETWORK    testnet (default) or mainnet
 *   NEARFIREWALL_RPC_URL    optional RPC endpoint
 *   NEARFIREWALL_MAX_PAYMENT optional local ceiling per payment, in NEAR
 *   NEARFIREWALL_MAX_X402    optional local ceiling per x402 payment, in USDC
 *   NEARFIREWALL_ALLOW_LOCAL_FETCH  set to 1 only for a local demo: lets fetch_url and
 *                            fetch_paid reach localhost and private addresses
 *
 * x402 payments use the same key: it also controls the key's x402 payment
 * account, which the owner's policy funds one payment at a time.
 *
 * Diagnostics go to stderr; stdout carries only MCP messages. The key is never printed.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Account, KeyPair, type KeyPairString } from "near-api-js";
import { AgentConnection, NearRpc, parseNear, parseUsdc } from "@nearfirewall/sdk";
import { X402Buyer } from "@nearfirewall/x402";
import { createServer } from "./server.ts";

function fail(message: string): never {
  console.error(`nearfirewall-mcp: ${message}`);
  process.exit(1);
}

const env = process.env;
const account = env.NEARFIREWALL_ACCOUNT ?? fail("Set NEARFIREWALL_ACCOUNT to the owner's account.");
const secret = env.NEARFIREWALL_AGENT_KEY ?? fail("Set NEARFIREWALL_AGENT_KEY to the connection key from the NEARFirewall app.");
if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]+$/.test(secret)) fail("NEARFIREWALL_AGENT_KEY must be an ed25519:… secret key.");
const network = env.NEARFIREWALL_NETWORK === "mainnet" ? "mainnet" : "testnet";
const rpcUrl = env.NEARFIREWALL_RPC_URL ?? (network === "mainnet" ? "https://rpc.mainnet.fastnear.com" : "https://test.rpc.fastnear.com");
const maxPayment = env.NEARFIREWALL_MAX_PAYMENT ? parseNear(env.NEARFIREWALL_MAX_PAYMENT) : null;
const maxX402 = env.NEARFIREWALL_MAX_X402 ? parseUsdc(env.NEARFIREWALL_MAX_X402) : null;

const publicKey = KeyPair.fromString(secret as KeyPairString).getPublicKey().toString();
const signer = new Account(account, rpcUrl, secret as KeyPairString);
const rpc = new NearRpc(rpcUrl);

const connection = new AgentConnection({
  rpc,
  account,
  publicKey,
  submit: async (args, gas) => {
    const response = await signer.callFunctionRaw({
      contractId: account,
      methodName: "agent_execute",
      args,
      gas,
      deposit: 0n,
      waitUntil: "FINAL",
    });
    return { txHash: response.transaction.hash, status: response.status };
  },
});

const x402 = new X402Buyer({ connection, secretKey: secret as KeyPairString, network, rpc, maxPayment: maxX402 });

const allowLocal = env.NEARFIREWALL_ALLOW_LOCAL_FETCH === "1";
if (allowLocal) console.error("nearfirewall-mcp: NEARFIREWALL_ALLOW_LOCAL_FETCH=1, so local and private addresses can be fetched. Use only for a local demo.");

const server = createServer(connection, { maxPayment, x402, ...(allowLocal ? { fetchOptions: { allowPrivate: true } } : {}) });
await server.connect(new StdioServerTransport());
console.error(`nearfirewall-mcp: ready for ${account} (${network}), key ${publicKey.slice(0, 16)}…`);

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
 *
 * Diagnostics go to stderr; stdout carries only MCP messages. The key is never printed.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Account, KeyPair, type KeyPairString } from "near-api-js";
import { AgentConnection, NearRpc, parseNear } from "@nearfirewall/sdk";
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

const publicKey = KeyPair.fromString(secret as KeyPairString).getPublicKey().toString();
const signer = new Account(account, rpcUrl, secret as KeyPairString);

const connection = new AgentConnection({
  rpc: new NearRpc(rpcUrl),
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

const server = createServer(connection, { maxPayment });
await server.connect(new StdioServerTransport());
console.error(`nearfirewall-mcp: ready for ${account} (${network}), key ${publicKey.slice(0, 16)}…`);

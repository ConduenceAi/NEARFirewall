#!/usr/bin/env node
/**
 * Runs an x402 facilitator for USDC on NEAR: sellers call it to verify and
 * settle buyers' payments. The relayer account pays the gas and the
 * 1 yoctoNEAR of each relayed transfer; it never holds the buyer's USDC.
 *
 *   node scripts/x402-facilitator.ts --relayer <account> [--port 4020] [--host 127.0.0.1]
 *
 * The relayer's key comes from the NEAR CLI keychain (~/.near-credentials).
 * Set X402_FACILITATOR_API_KEY to require that key from sellers (recommended
 * whenever the port is reachable by others). NEAR_RPC_URL overrides the RPC.
 */
import { createServer } from "node:http";
import { NearRpc, USDC_CONTRACT } from "@nearfirewall/sdk";
import { Facilitator, createFacilitatorServer, relayWithAccount } from "@nearfirewall/x402";
import { ownerAccount } from "./lib/sign.ts";

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const relayerId = flag("relayer") ?? (console.error("Usage: node scripts/x402-facilitator.ts --relayer <account> [--port 4020]"), process.exit(1));
const network = relayerId.endsWith(".near") ? "mainnet" : "testnet";
const rpcUrl = process.env.NEAR_RPC_URL ?? (network === "mainnet" ? "https://rpc.mainnet.fastnear.com" : "https://test.rpc.fastnear.com");
const port = Number(flag("port", "4020"));
const host = flag("host", "127.0.0.1")!;
const apiKey = process.env.X402_FACILITATOR_API_KEY || undefined;

const relayer = await ownerAccount(relayerId, rpcUrl, network);
const facilitator = new Facilitator({
  network,
  rpc: new NearRpc(rpcUrl),
  relayerId,
  relay: relayWithAccount(relayer, USDC_CONTRACT[network]),
});
createServer(createFacilitatorServer(facilitator, { apiKey })).listen(port, host, () => {
  console.log(`x402 facilitator for ${facilitator.network} on http://${host}:${port} (relayer ${relayerId}${apiKey ? ", API key required" : ""})`);
  if (!apiKey && host !== "127.0.0.1") console.log("Warning: anyone who can reach this port can make the relayer pay gas. Set X402_FACILITATOR_API_KEY.");
});

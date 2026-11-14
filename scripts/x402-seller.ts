#!/usr/bin/env node
/**
 * Runs demo x402 sellers: paid HTTP endpoints priced in USDC on NEAR, each
 * behind `createPaywall`. Payments are verified and settled by a facilitator.
 *
 *   node scripts/x402-seller.ts [config]      default config: .runner/x402-demo.json
 *
 * `scripts/x402-demo.ts setup` writes the config. Each server is a separate
 * website (its own port), so websites can be approved one by one:
 *
 *   {
 *     "network": "testnet",
 *     "facilitatorUrl": "http://127.0.0.1:4020",
 *     "servers": [
 *       { "name": "data-agent", "port": 4021, "endpoints": [
 *         { "path": "/report", "price": "0.05", "payTo": "bob.testnet", "description": "...",
 *           "agent": { "registry": "agents.bob.testnet", "agentId": "1" } } ] }
 *     ]
 *   }
 *
 * Set X402_FACILITATOR_API_KEY if the facilitator requires one.
 */
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { z } from "zod";
import { formatUsdc, parseUsdc } from "@nearfirewall/sdk";
import { createPaywall } from "@nearfirewall/x402";

const Endpoint = z.object({
  path: z.string().startsWith("/"),
  price: z.string(),
  payTo: z.string(),
  description: z.string().default("Paid content"),
  agent: z.object({ registry: z.string(), agentId: z.string() }).optional(),
});
const Config = z.object({
  network: z.enum(["testnet", "mainnet"]).default("testnet"),
  facilitatorUrl: z.string().url(),
  host: z.string().default("127.0.0.1"),
  servers: z.array(z.object({ name: z.string(), port: z.number().int(), endpoints: z.array(Endpoint).min(1) })).min(1),
});

const file = process.argv[2] ?? ".runner/x402-demo.json";
const raw = JSON.parse(await readFile(file, "utf8"));
// The setup script's file holds the seller config under `sellers`.
const config = Config.parse(raw.sellers ?? raw);
const apiKey = process.env.X402_FACILITATOR_API_KEY || undefined;

for (const server of config.servers) {
  const routes = new Map(
    server.endpoints.map((e) => [
      e.path,
      {
        endpoint: e,
        charge: createPaywall({
          facilitatorUrl: config.facilitatorUrl,
          ...(apiKey ? { apiKey } : {}),
          network: config.network,
          payTo: e.payTo,
          price: parseUsdc(e.price),
          description: e.description,
          mimeType: "application/json",
          ...(e.agent ? { agent: e.agent } : {}),
        }),
      },
    ]),
  );
  createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://seller.invalid").pathname;
    if (path === "/") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        seller: server.name,
        endpoints: server.endpoints.map((e) => ({ path: e.path, price_usdc: e.price, pay_to: e.payTo, agent: e.agent ?? null, description: e.description })),
      }, null, 2));
      return;
    }
    const route = routes.get(path);
    if (!route) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }
    const result = await route.charge(req, res);
    if (!result.paid) return;
    console.log(`[${server.name}] ${path}: paid ${route.endpoint.price} USDC by ${result.payer ?? "?"} (transaction ${result.settlement.transaction})`);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      seller: server.name,
      item: route.endpoint.description,
      // Stand-in content for the demo.
      data: { generated_at: new Date().toISOString(), summary: `Paid content from ${server.name}${path}` },
      paid: { usdc: route.endpoint.price, transaction: result.settlement.transaction },
    }));
  }).listen(server.port, config.host, () => {
    for (const e of server.endpoints) {
      console.log(`[${server.name}] http://${config.host}:${server.port}${e.path} - ${formatUsdc(parseUsdc(e.price))} USDC to ${e.payTo}${e.agent ? ` - agent #${e.agent.agentId} in ${e.agent.registry}` : ""}`);
    }
  });
}

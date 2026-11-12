import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseScenario, readConfig, substitute } from "../src/scenario.ts";

const dir = join(import.meta.dirname, "..", "scenarios");

describe("scenarios", () => {
  it("every bundled scenario parses", () => {
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(() => parseScenario(JSON.parse(substitute(readFileSync(join(dir, file), "utf8"), {})))).not.toThrow();
    }
  });

  it("rejects a duplicate of a later or unknown step", () => {
    const base = { title: "t", payer: "a.testnet", agent: "x" };
    expect(() => parseScenario({ ...base, steps: [{ recipient: "v.testnet", amount: "1", duplicateOf: "nope" }] })).toThrow();
  });
});

describe("substitute", () => {
  it("fills demo accounts from the environment", () => {
    const env = { NEARFIREWALL_OWNER: "o.testnet", NEARFIREWALL_VENDORS: "a.testnet,b.testnet,c.testnet" };
    expect(substitute('["${OWNER}","${VENDOR2}"]', env)).toBe('["o.testnet","b.testnet"]');
    expect(() => substitute("${NOPE}", env)).toThrow(/NOPE/);
  });
});

describe("config", () => {
  it("requires a registry and validates the key format without echoing it", () => {
    expect(() => readConfig({})).toThrow(/NEARFIREWALL_REGISTRY/);
    try {
      readConfig({ NEARFIREWALL_REGISTRY: "r.testnet", NEARFIREWALL_EXECUTOR_KEY: "not-a-key-secret" });
      throw new Error("expected failure");
    } catch (error) {
      expect(String(error)).not.toContain("not-a-key-secret");
    }
    expect(readConfig({ NEARFIREWALL_REGISTRY: "r.testnet" }).rpcUrl).toContain("testnet");
  });
});

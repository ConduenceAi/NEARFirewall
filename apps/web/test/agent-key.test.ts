import { KeyPair, type KeyPairString } from "near-api-js";
import { describe, expect, it } from "vitest";
import { generateAgentKey } from "../src/agent-key.ts";
import { searchPlatforms } from "../src/platforms.ts";

describe("agent connection setup", () => {
  it("creates a fresh key the MCP signer can load", async () => {
    const [first, second] = await Promise.all([generateAgentKey(), generateAgentKey()]);
    const signer = KeyPair.fromString(first.secretKey as KeyPairString);
    expect(signer.getPublicKey().toString()).toBe(first.publicKey);
    expect(second.publicKey).not.toBe(first.publicKey);
  });

  it("finds platforms by alias and type", () => {
    expect(searchPlatforms("  ANTHROPIC coding  ").map((p) => p.id)).toContain("claude-code");
    expect(searchPlatforms("  ANTHROPIC coding  ").map((p) => p.id)).not.toContain("claude-desktop");
    expect(searchPlatforms("remote MCP").find((p) => p.id === "chatgpt")?.setup).toBeUndefined();
  });
});

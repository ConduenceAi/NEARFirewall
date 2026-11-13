import { base58 } from "@scure/base";
import { fromBase64 } from "@nearfirewall/sdk";

export async function generateAgentKey() {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("Use HTTPS or localhost in a browser with Web Crypto support.");
  const pair = await subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const jwk = await subtle.exportKey("jwk", pair.privateKey);
  if (!jwk.d || !jwk.x) throw new Error("The browser could not export the agent key.");
  const decode = (value: string) => fromBase64(value.replaceAll("-", "+").replaceAll("_", "/"));
  const seed = decode(jwk.d);
  const publicBytes = decode(jwk.x);
  // NEAR expects the Ed25519 secret as the 32-byte seed followed by the public key.
  const secret = new Uint8Array(64);
  secret.set(seed);
  secret.set(publicBytes, 32);
  return { publicKey: `ed25519:${base58.encode(publicBytes)}`, secretKey: `ed25519:${base58.encode(secret)}` };
}

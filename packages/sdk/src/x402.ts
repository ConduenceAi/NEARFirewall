/**
 * x402 constants and helpers shared by the SDK, the x402 client, and the app.
 *
 * x402 payments are paid in USDC on NEAR (a NEP-141 token with 6 decimals).
 * Each connection key controls its own payment account: the implicit account of
 * that key. The owner's policy moves exactly one payment's worth of USDC to it
 * before each payment, so it holds nothing in between.
 */

/** Circle USDC on NEAR. */
export const USDC_CONTRACT = {
  testnet: "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af",
  mainnet: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
} as const;

export const USDC_DECIMALS = 6;
const UNITS_PER_USDC = 10n ** BigInt(USDC_DECIMALS);

/** x402 network identifiers (CAIP-2 style). */
export const X402_NETWORK = {
  testnet: "near:testnet",
  mainnet: "near:mainnet",
} as const;

export type NearNetwork = keyof typeof X402_NETWORK;

/** Parses a decimal USDC amount such as "0.05" into its smallest unit. */
export function parseUsdc(amount: string | number): bigint {
  const text = String(amount).trim();
  if (!/^\d+(\.\d{1,6})?$/.test(text)) throw new Error(`Invalid USDC amount: ${text}`);
  const [whole = "0", fraction = ""] = text.split(".");
  return BigInt(whole) * UNITS_PER_USDC + BigInt(fraction.padEnd(USDC_DECIMALS, "0"));
}

/** Formats USDC smallest units as a decimal string without trailing zeros. */
export function formatUsdc(units: bigint): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const fraction = (abs % UNITS_PER_USDC).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${abs / UNITS_PER_USDC}${fraction ? `.${fraction}` : ""}`;
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Decodes base58 (the Bitcoin alphabet NEAR uses for keys). */
export function base58Decode(text: string): Uint8Array {
  let value = 0n;
  for (const ch of text) {
    const digit = BASE58.indexOf(ch);
    if (digit < 0) throw new Error(`Invalid base58 character: ${ch}`);
    value = value * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (value > 0n) {
    bytes.unshift(Number(value & 0xffn));
    value >>= 8n;
  }
  for (const ch of text) {
    if (ch !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

/**
 * The x402 payment account of a connection key: the implicit account of an
 * ed25519 key, which is its 32 bytes as lowercase hex. Matches the policy's
 * `get_x402_account`.
 */
export function x402AccountFor(publicKey: string): string {
  const match = /^ed25519:([1-9A-HJ-NP-Za-km-z]+)$/.exec(publicKey);
  if (!match) throw new Error("x402 needs an ed25519 connection key");
  const bytes = base58Decode(match[1]!);
  if (bytes.length !== 32) throw new Error("An ed25519 public key is 32 bytes");
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** NEAR amount helpers. Amounts are always bigint yoctoNEAR internally. */

export const YOCTO_PER_NEAR = 10n ** 24n;
export const ONE_YOCTO = 1n;
export const TGAS = 10n ** 12n;

/** Parses a decimal NEAR amount such as "2.5" into yoctoNEAR. */
export function parseNear(amount: string | number): bigint {
  const text = String(amount).trim();
  if (!/^\d+(\.\d{1,24})?$/.test(text)) throw new Error(`Invalid NEAR amount: ${text}`);
  const [whole = "0", fraction = ""] = text.split(".");
  return BigInt(whole) * YOCTO_PER_NEAR + BigInt(fraction.padEnd(24, "0"));
}

/** Formats yoctoNEAR as a decimal NEAR string without trailing zeros. */
export function formatNear(yocto: bigint, maxFractionDigits = 5): string {
  const negative = yocto < 0n;
  const abs = negative ? -yocto : yocto;
  const whole = abs / YOCTO_PER_NEAR;
  let fraction = (abs % YOCTO_PER_NEAR).toString().padStart(24, "0").slice(0, maxFractionDigits);
  fraction = fraction.replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/** Current time in nanoseconds, as the chain measures it. */
export function nowNs(): bigint {
  return BigInt(Date.now()) * 1_000_000n;
}

export const DAY_NS = 86_400_000_000_000n;

/** Contracts take u64 timestamps as JSON numbers. */
export function nsToJson(ns: bigint | undefined | null): number | null {
  return ns === undefined || ns === null ? null : Number(ns);
}

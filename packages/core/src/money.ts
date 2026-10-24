/**
 * Money is always an integer number of token base units (bigint). Kohaku settles in a
 * 6-decimal stablecoin, so 1 USDC = 1_000_000 units and the smallest price is 0.000001.
 * Nothing in the clearing path divides, so no rounding rule is ever needed; display
 * formatting is the only place decimals appear.
 */
export const TOKEN_DECIMALS = 6;
export const UNIT = 10n ** BigInt(TOKEN_DECIMALS);

export function usd(amount: string | number): bigint {
  const s = typeof amount === "number" ? amount.toFixed(TOKEN_DECIMALS) : amount.trim();
  const neg = s.startsWith("-");
  const [whole = "0", frac = ""] = (neg ? s.slice(1) : s).split(".");
  if (frac.length > TOKEN_DECIMALS) throw new Error(`too many decimals in ${s}`);
  const units = BigInt(whole) * UNIT + BigInt((frac + "0".repeat(TOKEN_DECIMALS)).slice(0, TOKEN_DECIMALS));
  return neg ? -units : units;
}

/** Format base units as a decimal string, trimming trailing zeros but keeping `minDecimals`. */
export function formatUnits(units: bigint, minDecimals = 2): string {
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const whole = abs / UNIT;
  let frac = (abs % UNIT).toString().padStart(TOKEN_DECIMALS, "0").replace(/0+$/, "");
  if (frac.length < minDecimals) frac = frac.padEnd(minDecimals, "0");
  const wholeStr = whole.toLocaleString("en-US");
  return `${neg ? "-" : ""}${wholeStr}${frac ? "." + frac : ""}`;
}

export function formatUsd(units: bigint, minDecimals = 2): string {
  const s = formatUnits(units, minDecimals);
  return s.startsWith("-") ? `-$${s.slice(1)}` : `$${s}`;
}

export function toBigInt(v: bigint | string | number): bigint {
  return typeof v === "bigint" ? v : BigInt(v);
}

export function abs(v: bigint): bigint {
  return v < 0n ? -v : v;
}

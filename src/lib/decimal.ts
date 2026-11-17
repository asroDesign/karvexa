/**
 * Exact fixed-point Decimal arithmetic backed by BigInt (scale = 4 => 10_000n).
 * Guarantees ZERO IEEE-754 floating-point drift across accounting & inventory calculations.
 */

const SCALE = 4;
const FACTOR = BigInt(10000);
const HALF = BigInt(5000);

export type DecimalInput = string | bigint;

export function parseDecimal(value: DecimalInput | null | undefined): bigint {
  if (value === null || value === undefined) return BigInt(0);
  if (typeof value === "bigint") return value;
  const trimmed = value.trim();
  if (!trimmed) return BigInt(0);
  const match = /^([+-])?(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) {
    throw new Error(`Invalid decimal value: "${value}"`);
  }
  const sign = match[1] === "-" ? BigInt(-1) : BigInt(1);
  const intPart = BigInt(match[2]);
  const rawFrac = match[3] ?? "";
  const paddedFrac = (rawFrac + "0000").slice(0, SCALE);
  const fracPart = BigInt(paddedFrac);
  // Round half-up if extra digits beyond scale 4
  let carry = BigInt(0);
  if (rawFrac.length > SCALE && Number(rawFrac[SCALE]) >= 5) {
    carry = BigInt(1);
  }
  return sign * (intPart * FACTOR + fracPart + carry);
}

export function formatDecimal(scaled: bigint, decimals: 2 | 4 = 2): string {
  const negative = scaled < BigInt(0);
  const abs = negative ? -scaled : scaled;

  if (decimals === 4) {
    const intPart = abs / FACTOR;
    const fracPart = (abs % FACTOR).toString().padStart(4, "0");
    return `${negative ? "-" : ""}${intPart.toString()}.${fracPart}`;
  }

  // Round to 2 decimal places (divide by 100 with half-up)
  const scaled2 = (abs + BigInt(50)) / BigInt(100);
  const intPart = scaled2 / BigInt(100);
  const fracPart = (scaled2 % BigInt(100)).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${intPart.toString()}.${fracPart}`;
}

export function addDec(a: DecimalInput, b: DecimalInput): bigint {
  return parseDecimal(a) + parseDecimal(b);
}

export function subDec(a: DecimalInput, b: DecimalInput): bigint {
  return parseDecimal(a) - parseDecimal(b);
}

export function mulDec(a: DecimalInput, b: DecimalInput): bigint {
  const pa = parseDecimal(a);
  const pb = parseDecimal(b);
  const prod = pa * pb;
  const negative = prod < BigInt(0);
  const abs = negative ? -prod : prod;
  const rounded = (abs + HALF) / FACTOR;
  return negative ? -rounded : rounded;
}

export function divDec(a: DecimalInput, b: DecimalInput): bigint {
  const pa = parseDecimal(a);
  const pb = parseDecimal(b);
  if (pb === BigInt(0)) {
    throw new Error("Division by zero in decimal math");
  }
  const negative = (pa < BigInt(0)) !== (pb < BigInt(0));
  const absA = pa < BigInt(0) ? -pa : pa;
  const absB = pb < BigInt(0) ? -pb : pb;
  const scaled = (absA * FACTOR + absB / BigInt(2)) / absB;
  return negative ? -scaled : scaled;
}

export function isZeroDec(a: DecimalInput): boolean {
  return parseDecimal(a) === BigInt(0);
}

export function isPositiveDec(a: DecimalInput): boolean {
  return parseDecimal(a) > BigInt(0);
}

export function isNegativeDec(a: DecimalInput): boolean {
  return parseDecimal(a) < BigInt(0);
}

export function sumDecimals(values: DecimalInput[]): bigint {
  return values.reduce<bigint>((acc, v) => acc + parseDecimal(v), BigInt(0));
}

export function eqDec(a: DecimalInput, b: DecimalInput): boolean {
  return parseDecimal(a) === parseDecimal(b);
}

export function gtDec(a: DecimalInput, b: DecimalInput): boolean {
  return parseDecimal(a) > parseDecimal(b);
}

export function ltDec(a: DecimalInput, b: DecimalInput): boolean {
  return parseDecimal(a) < parseDecimal(b);
}

export function toMoneyString(value: DecimalInput): string {
  return formatDecimal(parseDecimal(value), 2);
}

export function toQtyString(value: DecimalInput): string {
  return formatDecimal(parseDecimal(value), 4);
}

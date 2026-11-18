/**
 * Exact Jalali (Solar Hijri) <-> Gregorian ISO YYYY-MM-DD converter (Zero External Dependency).
 * Backend canonical storage rule (Master Prompt 08 §2.16):
 * - PostgreSQL stores canonical Gregorian `DATE` (`YYYY-MM-DD`).
 * - Clients may display and submit Jalali (`YYYY/MM/DD` or `YYYY-MM-DD`, e.g., `1404/06/24`)
 *   via `*_jalali` fields or canonical ISO dates; server validates and normalizes deterministically.
 */

function div(a: number, b: number): number {
  return Math.trunc(a / b);
}

function jalaliToJdn(jy: number, jm: number, jd: number): number {
  const epbase = jy - (jy >= 0 ? 474 : 473);
  const epyear = 474 + (epbase % 2820);
  return (
    jd +
    (jm <= 7 ? (jm - 1) * 31 : (jm - 1) * 30 + 6) +
    div(epyear * 682 - 110, 2816) +
    (epyear - 1) * 365 +
    div(epbase, 2820) * 1029983 +
    (1948320 - 1)
  );
}

function jdnToGregorian(jdn: number): { gy: number; gm: number; gd: number } {
  const j = 4 * jdn + 139361631;
  const j2 = j + div(div(4 * jdn + 183187720, 146097) * 3, 4) * 4 - 3908;
  const i = div(j2 % 1461, 4) * 5 + 308;
  const gd = div(i % 153, 5) + 1;
  const gm = (div(i, 153) % 12) + 1;
  const gy = div(j2, 1461) - 100100 + div(8 - gm, 6);
  return { gy, gm, gd };
}

function gregorianToJdn(gy: number, gm: number, gd: number): number {
  const d =
    div((gy + div(gm - 8, 6) + 100100) * 1461, 4) +
    div(153 * ((gm + 9) % 12) + 2, 5) +
    gd -
    34840408;
  return d - div(div(gy + 100100 + div(gm - 8, 6), 100) * 3, 4) + 752;
}

function jdnToJalali(jdn: number): { jy: number; jm: number; jd: number } {
  const { gy } = jdnToGregorian(jdn);
  let jy = gy - 621;
  const jdn1f = jalaliToJdn(jy, 1, 1);
  let k = jdn - jdn1f;
  if (k < 0) {
    jy -= 1;
    k = jdn - jalaliToJdn(jy, 1, 1);
  }
  if (k < 186) {
    const jm = 1 + div(k, 31);
    const jd = 1 + (k % 31);
    return { jy, jm, jd };
  }
  const k2 = k - 186;
  const jm = 7 + div(k2, 30);
  const jd = 1 + (k2 % 30);
  return { jy, jm, jd };
}

export function normalizePersianDigits(input: string): string {
  const fa = "۰۱۲۳۴۵۶۷۸۹";
  const ar = "٠١٢٣٤٥٦٧٨٩";
  return input
    .replace(/[۰-۹]/g, (c) => String(fa.indexOf(c)))
    .replace(/[٠-٩]/g, (c) => String(ar.indexOf(c)));
}

export function jalaliToGregorianIso(jalaliStr: string): string {
  const clean = normalizePersianDigits(jalaliStr.trim()).replace(/\//g, "-");
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(clean);
  if (!m) {
    throw new Error(`Invalid Jalali date format: "${jalaliStr}". Expected YYYY/MM/DD or YYYY-MM-DD.`);
  }
  const jy = Number(m[1]);
  const jm = Number(m[2]);
  const jd = Number(m[3]);
  if (jy < 1200 || jy > 1600 || jm < 1 || jm > 12 || jd < 1 || jd > 31) {
    throw new Error(`Out-of-range Jalali date: "${jalaliStr}"`);
  }
  const { gy, gm, gd } = jdnToGregorian(jalaliToJdn(jy, jm, jd));
  return `${String(gy).padStart(4, "0")}-${String(gm).padStart(2, "0")}-${String(gd).padStart(2, "0")}`;
}

export function currentJalaliDate(now: Date = new Date(), timeZone = "Asia/Tehran"): string {
  const parts = new Intl.DateTimeFormat("en-US-u-ca-persian", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone,
  }).formatToParts(now);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}/${part("month")}/${part("day")}`;
}

export function gregorianIsoToJalali(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate.trim());
  if (!m) return isoDate;
  const { jy, jm, jd } = jdnToJalali(gregorianToJdn(Number(m[1]), Number(m[2]), Number(m[3])));
  return `${String(jy).padStart(4, "0")}/${String(jm).padStart(2, "0")}/${String(jd).padStart(2, "0")}`;
}

/**
 * Resolves either canonical Gregorian ISO (`YYYY-MM-DD`, year >= 1900) OR Jalali (`13xx/14xx`, `YYYY/MM/DD` or `YYYY-MM-DD`)
 * into canonical Gregorian ISO `YYYY-MM-DD` for PostgreSQL storage.
 */
export function resolveCanonicalDate(dateInput?: string | null, jalaliInput?: string | null): string {
  if (jalaliInput && jalaliInput.trim()) {
    return jalaliToGregorianIso(jalaliInput);
  }
  if (dateInput && dateInput.trim()) {
    const clean = normalizePersianDigits(dateInput.trim()).replace(/\//g, "-");
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(clean);
    if (!m) {
      throw new Error(`Invalid date format: "${dateInput}"`);
    }
    const year = Number(m[1]);
    if (year >= 1200 && year <= 1600) {
      return jalaliToGregorianIso(clean);
    }
    return `${String(year).padStart(4, "0")}-${String(Number(m[2])).padStart(2, "0")}-${String(Number(m[3])).padStart(2, "0")}`;
  }
  return new Date().toISOString().slice(0, 10);
}

/**
 * Multi-currency money helpers.
 *
 * Amounts are always stored as integers in a currency's minor unit
 * (for example centavos for PHP, cents for USD, whole won for KRW).
 * Never store monetary amounts as floating-point values, and never
 * combine balances of different currencies without explicit conversion.
 */
import { DEFAULT_CURRENCY, DEFAULT_LOCALE } from "../config.ts";

/** ISO 4217 currency code, e.g. "PHP", "USD", "KRW". */
export type CurrencyCode = string;

/** Integer amount in the currency's minor unit. */
export type MinorUnits = number;

/** Currencies highlighted in the UI. Any valid ISO 4217 code also works. */
export const FEATURED_CURRENCIES: CurrencyCode[] = [
  "PHP",
  "USD",
  "KRW",
  "JPY",
  "EUR",
  "GBP",
];

export function isValidCurrency(code: string): boolean {
  try {
    new Intl.NumberFormat(DEFAULT_LOCALE, { style: "currency", currency: code });
    return true;
  } catch {
    return false;
  }
}

/** Number of minor-unit digits for a currency (PHP/USD: 2, KRW/JPY: 0). */
export function minorUnitDigits(currency: CurrencyCode = DEFAULT_CURRENCY): number {
  const options = new Intl.NumberFormat(DEFAULT_LOCALE, {
    style: "currency",
    currency,
  }).resolvedOptions();
  return options.maximumFractionDigits ?? 2;
}

/** Convert integer minor units to the major-unit value for display formatting. */
export function toMajorUnits(amountMinor: MinorUnits, currency: CurrencyCode): number {
  return amountMinor / 10 ** minorUnitDigits(currency);
}

/**
 * Parses a user-entered major-unit amount (e.g. "1200.50") into integer
 * minor units by string manipulation only — never through floats, so
 * values stay exact. Rejects blanks, signs, non-numeric input, and more
 * fraction digits than the currency supports (e.g. any fraction for JPY).
 */
export function parseAmountToMinorUnits(
  input: string,
  currency: CurrencyCode = DEFAULT_CURRENCY,
): MinorUnits {
  const value = input.trim();
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new Error("Enter an amount like 1200 or 1200.50.");
  }
  const digits = minorUnitDigits(currency);
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > digits) {
    throw new Error(
      digits === 0
        ? `${currency} amounts cannot have decimal places.`
        : `Enter at most ${digits} decimal places for ${currency}.`,
    );
  }
  const minor = Number(whole) * 10 ** digits + Number(fraction.padEnd(digits, "0") || "0");
  if (!Number.isSafeInteger(minor)) {
    throw new Error("That amount is too large.");
  }
  return minor;
}

/** Converts integer minor units back to an editable major-unit string, exactly. */
export function minorUnitsToAmountInput(
  amountMinor: MinorUnits,
  currency: CurrencyCode = DEFAULT_CURRENCY,
): string {
  if (!Number.isInteger(amountMinor)) {
    throw new Error("Money amounts must be integers in minor units.");
  }
  const digits = minorUnitDigits(currency);
  const sign = amountMinor < 0 ? "-" : "";
  const absolute = Math.abs(amountMinor);
  if (digits === 0) return `${sign}${absolute}`;
  const padded = String(absolute).padStart(digits + 1, "0");
  return `${sign}${padded.slice(0, -digits)}.${padded.slice(-digits)}`;
}

/** Format integer minor units with Intl.NumberFormat for the given currency. */
export function formatMoney(
  amountMinor: MinorUnits,
  currency: CurrencyCode = DEFAULT_CURRENCY,
  locale: string = DEFAULT_LOCALE,
): string {
  if (!Number.isInteger(amountMinor)) {
    throw new Error("Money amounts must be integers in minor units.");
  }
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
  }).format(toMajorUnits(amountMinor, currency));
}

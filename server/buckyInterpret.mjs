import { errors } from "./errors.mjs";
import { metaDiagnosticError } from "./metaDiagnostics.mjs";
import { isValidCurrencyCode } from "./money.mjs";

/**
 * Bucky model-assisted interpretation (Phase D).
 *
 * The deterministic interpreter in the browser is the safe default. When it
 * cannot parse a bookkeeping request, the user may explicitly ask the
 * server-side model for a second interpretation. The model only ever
 * returns a *structured proposal* (kind, amount, date, names) — it never
 * writes anything. Before any proposal reaches the user it is validated
 * here against the strict schema and the real goal/employee names the
 * client supplied, and then cross-checked again in the browser against
 * the user's own words (amount and date must match deterministic
 * extraction exactly) before entering the identical preview → confirm →
 * validated save pipeline. Any failure means "no proposal" and the user
 * keeps using the deterministic interpreter. Live requests go through the
 * same gates and single-attempt session limiter as every other live call.
 */

export const BUCKY_INTERPRET_MAX_BODY_BYTES = 16_384;
export const BUCKY_INTERPRET_TEXT_MAX_LENGTH = 500;

export const BUCKY_INTERPRET_KINDS = ["income", "expense", "savings-contribution", "salary-payment"];
const PAYMENT_TYPES = ["salary", "bonus", "advance"];

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(obj, keys) {
  return Object.keys(obj).every((k) => keys.includes(k));
}

function cleanString(value, max) {
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/\s+/g, " ");
  if (!text || text.length > max) return null;
  return text;
}

function cleanNameList(value, maxItems, maxLength) {
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const names = value.map((v) => cleanString(v, maxLength));
  if (names.some((n) => n === null)) return null;
  return names;
}

/**
 * Strictly validate the client payload. The context carries only names of
 * the user's real savings goals and employees (never amounts owed, rates,
 * or raw records) so the model can only reference things that exist; the
 * browser re-resolves every name against local data regardless.
 */
export function validateInterpretRequest(payload) {
  if (!isRecord(payload) || !hasOnlyKeys(payload, ["text", "mode", "context"])) {
    throw errors.invalidRequest();
  }
  const text = cleanString(payload.text, BUCKY_INTERPRET_TEXT_MAX_LENGTH);
  if (!text) throw errors.invalidRequest();
  const mode = payload.mode === undefined ? "fallback" : payload.mode;
  if (mode !== "fallback" && mode !== "live") throw errors.invalidRequest();

  const c = payload.context;
  if (
    !isRecord(c) ||
    !hasOnlyKeys(c, ["profileName", "profileKind", "currency", "bucketNames", "employeeNames"])
  ) {
    throw errors.invalidRequest();
  }
  const profileName = cleanString(c.profileName, 80);
  if (!profileName || (c.profileKind !== "personal" && c.profileKind !== "business")) {
    throw errors.invalidRequest();
  }
  if (!isValidCurrencyCode(c.currency)) throw errors.invalidRequest();
  const bucketNames = cleanNameList(c.bucketNames, 20, 80);
  const employeeNames = cleanNameList(c.employeeNames, 50, 80);
  if (!bucketNames || !employeeNames) throw errors.invalidRequest();

  return {
    text,
    mode,
    context: { profileName, profileKind: c.profileKind, currency: c.currency, bucketNames, employeeNames },
  };
}

export const BUCKY_INTERPRET_JSON_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: [...BUCKY_INTERPRET_KINDS, "none"] },
    // Integer minor units in the profile currency. Nullable so the model
    // can say "none" without inventing a figure.
    amountMinor: { type: ["integer", "null"], minimum: 1 },
    date: { type: ["string", "null"], pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    description: { type: ["string", "null"], maxLength: 80 },
    category: { type: ["string", "null"], maxLength: 40 },
    bucketName: { type: ["string", "null"], maxLength: 80 },
    employeeName: { type: ["string", "null"], maxLength: 80 },
    paymentType: { type: ["string", "null"], enum: ["salary", "bonus", "advance", null] },
  },
  required: ["kind", "amountMinor", "date", "description", "category", "bucketName", "employeeName", "paymentType"],
  additionalProperties: false,
};

export function buildInterpretPrompt({ text, context }) {
  return [
    `You interpret one bookkeeping request for the Bucketa profile "${context.profileName}" (${context.profileKind}, currency ${context.currency}).`,
    "Extract ONLY what the user explicitly stated. Never invent an amount, date, person, or goal. If anything needed is missing or ambiguous, return kind \"none\".",
    "Amounts are integer minor units (for example ₱1,000.00 in PHP is 100000). Dates are YYYY-MM-DD; if the user gave no explicit date, use null instead of guessing.",
    `Savings goals that exist: ${context.bucketNames.length ? context.bucketNames.join(", ") : "(none)"}. bucketName must copy one of these exactly, or be null.`,
    `Employees that exist: ${context.employeeNames.length ? context.employeeNames.join(", ") : "(none)"}. employeeName must copy one of these exactly, or be null.`,
    "kind is one of: income, expense, savings-contribution, salary-payment, none. paymentType is salary, bonus, or advance only for salary-payment, else null. A salary rate or rate change is not a payment: return kind \"none\".",
    "You never save anything; a human reviews and confirms every record.",
    `Request: ${text}`,
  ].join("\n");
}

function isValidDateString(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function schemaError(subReason) {
  return metaDiagnosticError("schema_validation", { subReason });
}

/** Canonical list spelling for a model-supplied name, or null. */
function resolveListedName(name, list) {
  if (typeof name !== "string") return null;
  const wanted = name.trim().toLowerCase();
  return list.find((n) => n.toLowerCase() === wanted) ?? null;
}

/**
 * Validate untrusted model output against the schema and the real names.
 * Returns a normalised proposal or { kind: "none" }. Throws a safe
 * diagnostic error on structural problems; the caller then falls back to
 * "no proposal". Even a returned proposal is re-validated in the browser
 * against the user's exact words before it can be previewed.
 */
export function validateModelInterpretation(parsed, context) {
  if (!isRecord(parsed)) throw schemaError("unknown_schema_failure");
  const KEYS = ["kind", "amountMinor", "date", "description", "category", "bucketName", "employeeName", "paymentType"];
  if (!KEYS.every((k) => Object.hasOwn(parsed, k)) || !hasOnlyKeys(parsed, KEYS)) {
    throw schemaError("unexpected_keys");
  }
  if (parsed.kind === "none") return { kind: "none" };
  if (!BUCKY_INTERPRET_KINDS.includes(parsed.kind)) throw schemaError("invalid_kind");
  if (!Number.isSafeInteger(parsed.amountMinor) || parsed.amountMinor <= 0) {
    throw schemaError("invalid_amount");
  }
  if (!isValidDateString(parsed.date)) throw schemaError("invalid_date");
  const description = parsed.description === null ? null : cleanString(parsed.description, 80);
  if (parsed.description !== null && !description) throw schemaError("invalid_field_length");
  const category = parsed.category === null ? null : cleanString(parsed.category, 40);
  if (parsed.category !== null && !category) throw schemaError("invalid_field_length");

  let bucketName = null;
  let employeeName = null;
  let paymentType = null;
  if (parsed.kind === "savings-contribution") {
    bucketName = resolveListedName(parsed.bucketName, context.bucketNames);
    if (!bucketName) throw schemaError("unknown_bucket");
  }
  if (parsed.kind === "salary-payment") {
    employeeName = resolveListedName(parsed.employeeName, context.employeeNames);
    if (!employeeName) throw schemaError("unknown_employee");
    if (!PAYMENT_TYPES.includes(parsed.paymentType)) throw schemaError("invalid_payment_type");
    paymentType = parsed.paymentType;
  }
  return {
    kind: parsed.kind,
    amountMinor: parsed.amountMinor,
    date: parsed.date,
    description,
    category,
    bucketName,
    employeeName,
    paymentType,
  };
}

import type { Bucket, Employee, Product, Profile, Transaction } from "../data/types.ts";
import { parseAmountToMinorUnits } from "./currency.ts";
import { isValidCalendarDate } from "./recordForm.ts";
import { bucketSavedMinor } from "./finance.ts";

/**
 * Bucky bookkeeping actions — deterministic intent interpretation.
 *
 * This module turns a typed or spoken request into a *proposed* action.
 * It never writes data. The panel must show the proposal in a structured
 * preview, get explicit user confirmation, validate the built record, and
 * save it through the app's commit-confirmed data function. Keeping
 * interpretation separate from execution means a future model-powered
 * interpreter can be added later: it would have to produce this same
 * ProposedBuckyAction shape and pass through the identical preview,
 * validation, confirmation, and save pipeline. A model must never write
 * to the database directly.
 */

export const SALARY_CATEGORY = "Salaries";

export type BuckyActionKind = "income" | "expense" | "savings-contribution" | "salary-payment";

export interface ProposedBuckyAction {
  /** Stable ID, generated once when the preview is created. Reused as the
   * transaction ID, so a repeated confirmation cannot create a duplicate. */
  id: string;
  kind: BuckyActionKind;
  transactionType: Transaction["type"];
  profileId: string;
  profileName: string;
  currency: string;
  amountMinor: number;
  /** YYYY-MM-DD */
  date: string;
  description: string;
  category: string | null;
  bucketId: string | null;
  bucketName: string | null;
  employeeName: string | null;
  /** Existing employee record ID when the name matched one, else null.
   * Used as the transaction's relatedId so payment history links to
   * exactly one employee. Bucky never creates employee records. */
  employeeId: string | null;
  /** True when the name matched an existing employee record. */
  employeeMatched: boolean;
  /** For salary-payment actions: which kind of compensation payment. */
  paymentType: "salary" | "bonus" | "advance" | null;
  warnings: string[];
}

export type BuckyActionInterpretation =
  | { status: "proposal"; action: ProposedBuckyAction }
  | { status: "clarification"; question: string }
  | { status: "unsupported" }
  | { status: "not-action" };

export interface BuckyActionContext {
  profile: Profile;
  buckets: Bucket[];
  employees: Employee[];
  transactions: Transaction[];
  /** Local today as YYYY-MM-DD. */
  today: string;
  createId: () => string;
}

const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
  september: 9, sep: 9, sept: 9, october: 10, oct: 10, november: 11, nov: 11,
  december: 12, dec: 12,
};
const MONTH_PATTERN = Object.keys(MONTHS).join("|");
const SYMBOL_CURRENCIES: Record<string, string> = {
  "₱": "PHP", "$": "USD", "€": "EUR", "£": "GBP", "¥": "JPY", "₩": "KRW",
};
const QUESTION_START = /^(how|what|why|when|which|who|do|does|did|is|are|can|could|show|tell|give me)\b/i;
const IMPERATIVE_START = /^(record|add|log|pay|paid|deposit|contribute|put|spent|received|earned|create|save)\b/i;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function shiftDay(today: string, delta: number): string {
  const [y, m, d] = today.split("-").map(Number);
  const date = new Date(Date.UTC(y, (m ?? 1) - 1, (d ?? 1) + delta));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

interface ExtractedDate {
  date: string;
  text: string;
  /**
   * The explicit date expression exactly as written, when one was supplied
   * but is not a real calendar date (e.g. "2026-02-30", "February 30, 2026").
   * An explicit invalid date must never silently fall back to today:
   * callers turn this into a clarification and produce no preview.
   */
  invalidDate?: string;
}

/** Extracts an explicit date (or today/yesterday/tomorrow) and removes it. */
function extractDate(text: string, today: string): ExtractedDate {
  let match = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/.exec(text);
  if (match) {
    const date = `${match[1]}-${pad(Number(match[2]))}-${pad(Number(match[3]))}`;
    if (isValidCalendarDate(date)) return { date, text: text.replace(match[0], " ") };
    return { date: today, text, invalidDate: match[0] };
  }
  match = new RegExp(`\\b(${MONTH_PATTERN})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "i").exec(text);
  if (match) {
    const date = `${match[3]}-${pad(MONTHS[match[1].toLowerCase()] ?? 0)}-${pad(Number(match[2]))}`;
    if (isValidCalendarDate(date)) return { date, text: text.replace(match[0], " ") };
    return { date: today, text, invalidDate: match[0] };
  }
  match = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_PATTERN})\\.?\\s+(\\d{4})\\b`, "i").exec(text);
  if (match) {
    const date = `${match[3]}-${pad(MONTHS[match[2].toLowerCase()] ?? 0)}-${pad(Number(match[1]))}`;
    if (isValidCalendarDate(date)) return { date, text: text.replace(match[0], " ") };
    return { date: today, text, invalidDate: match[0] };
  }
  if (/\btoday\b/i.test(text)) return { date: today, text: text.replace(/\btoday\b/i, " ") };
  if (/\byesterday\b/i.test(text)) return { date: shiftDay(today, -1), text: text.replace(/\byesterday\b/i, " ") };
  if (/\btomorrow\b/i.test(text)) return { date: shiftDay(today, 1), text: text.replace(/\btomorrow\b/i, " ") };
  return { date: today, text };
}

/** Clarification for an impossible explicitly supplied date. No preview, no write. */
function invalidDateClarification(invalidDate: string): BuckyActionInterpretation {
  return {
    status: "clarification",
    question: `“${invalidDate}” isn't a real calendar date, so I can't use it. Please correct the date — for example, February 28, 2026 — and try again. Nothing was saved.`,
  };
}

interface AmountToken {
  amountText: string;
  currency: string | null;
  raw: string;
}

/** Finds the monetary amount. Marked amounts (₱, $, "pesos", codes) win. */
function extractAmount(text: string): AmountToken | null {
  const marked = /(?:(₱|\$|€|£|¥|₩)\s*(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s*(pesos?|php|usd|dollars?|eur|euros?|gbp|pounds?|jpy|yen|krw|won))/i.exec(text);
  if (marked) {
    if (marked[2]) {
      return { amountText: marked[2].replace(/,/g, ""), currency: SYMBOL_CURRENCIES[marked[1]] ?? null, raw: marked[0] };
    }
    const word = (marked[4] ?? "").toLowerCase();
    const currency = /peso|php/.test(word) ? "PHP"
      : /usd|dollar/.test(word) ? "USD"
      : /eur/.test(word) ? "EUR"
      : /gbp|pound/.test(word) ? "GBP"
      : /jpy|yen/.test(word) ? "JPY"
      : "KRW";
    return { amountText: marked[3].replace(/,/g, ""), currency, raw: marked[0] };
  }
  const plain = /(\d[\d,]*(?:\.\d+)?)/.exec(text);
  if (plain) return { amountText: plain[1].replace(/,/g, ""), currency: null, raw: plain[0] };
  return null;
}

function parseAmount(token: AmountToken, currency: string): number | null {
  try {
    const minor = parseAmountToMinorUnits(token.amountText, currency);
    return minor > 0 ? minor : null;
  } catch {
    return null;
  }
}

function cleanPhrase(value: string): string {
  return value
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/^(the|a|an)\s+/i, "")
    .trim();
}

function capitalise(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function duplicateWarning(ctx: BuckyActionContext, draft: {
  transactionType: Transaction["type"];
  bucketId: string | null;
  amountMinor: number;
  currency: string;
  date: string;
  description: string;
}): string | null {
  const wanted = draft.description.trim().toLowerCase().replace(/\s+/g, " ");
  const exists = ctx.transactions.some((t) =>
    t.profileId === ctx.profile.id &&
    t.type === draft.transactionType &&
    (t.bucketId ?? null) === draft.bucketId &&
    t.amountMinor === draft.amountMinor &&
    t.currency === draft.currency &&
    t.date.slice(0, 10) === draft.date &&
    t.description.trim().toLowerCase().replace(/\s+/g, " ") === wanted,
  );
  return exists
    ? "A matching record with the same type, amount, date, and description already exists. Check the preview carefully — saving will add another one."
    : null;
}

function extractCategory(text: string): { category: string | null; text: string } {
  const match = /\bcategory\s+([a-z][a-z &/-]*?)(?=\s+(?:for|from|on)\b|$)/i.exec(text);
  if (!match) return { category: null, text };
  return { category: capitalise(cleanPhrase(match[1])), text: text.replace(match[0], " ") };
}

function extractDescription(text: string): string {
  const forMatch = /\b(?:for|from|on)\s+(.+)$/i.exec(text);
  if (forMatch) return capitalise(cleanPhrase(forMatch[1].replace(/\bplease\b/gi, " ")));
  const remainder = text
    .replace(/\b(record|add|log|create|save|spent|received|earned|paid|pay|income|expense|expenses|please|my|me)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return capitalise(cleanPhrase(remainder));
}

type BucketMatch =
  | { bucket: Bucket }
  | { ambiguous: Bucket[] }
  | { bucket: null };

function matchBucket(textLower: string, buckets: Bucket[]): BucketMatch {
  const exact = buckets.filter((b) => textLower.includes(b.name.trim().toLowerCase()));
  if (exact.length > 0) {
    // Nested names ("iPhone" vs "iPhone Fund"): the longest is most specific.
    return { bucket: [...exact].sort((a, b) => b.name.length - a.name.length)[0] };
  }
  let bestScore = 0;
  let best: Bucket[] = [];
  for (const bucket of buckets) {
    const tokens = bucket.name.toLowerCase().split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !["savings", "goal", "bucket"].includes(t));
    const score = tokens.filter((t) => new RegExp(`\\b${t}\\b`).test(textLower)).length;
    if (score > bestScore) { bestScore = score; best = [bucket]; }
    else if (score === bestScore && score > 0) best.push(bucket);
  }
  if (bestScore === 0) return { bucket: null };
  if (best.length > 1) return { ambiguous: best };
  return { bucket: best[0] };
}

const GENERIC_GOAL_PHRASES = new Set([
  "savings", "goal", "bucket", "savings goal", "savings bucket",
  "my savings", "the savings", "a savings", "my goal", "the goal",
  "my bucket", "the bucket", "my savings goal", "my savings bucket",
]);

/**
 * The savings-goal name the user explicitly supplied, or null when the
 * command names no goal ("add ₱100 to my savings goal"). Distinguishing
 * these two cases matters: an unnamed command may safely fall back to a
 * sole existing goal, but an explicitly named goal that matches nothing
 * must never be silently replaced by a different goal.
 */
export function explicitSavingsGoalName(text: string): string | null {
  const patterns = [
    /\b(?:to|into|in|for)\s+(?:(?:my|the|a)\s+)?(.+?)\s+(?:savings\s+)?(?:goal|bucket)\b/i,
    /\b(?:to|into|in)\s+(?:(?:my|the|a)\s+)?(.+?)\s+savings\b/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const cleaned = cleanPhrase(
      match[1]
        .replace(/(?:₱|\$|€|£|¥|₩)\s*\d[\d,]*(?:\.\d+)?/g, " ")
        .replace(/\b\d[\d,]*(?:\.\d+)?\s*(?:pesos?|php|usd|dollars?|eur|euros?|gbp|pounds?|jpy|yen|krw|won)\b/gi, " ")
        .replace(/\b(?:please|just)\b/gi, " "),
    );
    const normalized = cleaned.toLowerCase().replace(/\s+/g, " ").trim();
    if (!normalized || GENERIC_GOAL_PHRASES.has(normalized)) return null;
    return capitalise(cleaned);
  }
  return null;
}

function cleanPersonName(raw: string): string {
  const words = raw
    .replace(/['’]s\b/gi, "")
    .split(/\s+/)
    .map((w) => w.replace(/[^A-Za-z.'-]/g, ""))
    .filter((w) => w && !/^(salary|salaries|wage|wages|payment|payments|for|to|on|the|my|please|today|record|add|log|create|deposit|pay|paid)$/i.test(w))
    .slice(0, 3);
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function extractEmployeeName(text: string, employees: Employee[], profileId: string): { name: string; matched: Employee | null; ambiguous: Employee[] } {
  const lower = text.toLowerCase();
  const own = employees.filter((e) => e.profileId === profileId);
  const nameMatches = own.filter((e) => lower.includes(e.name.trim().toLowerCase()));
  if (nameMatches.length === 1) return { name: nameMatches[0].name, matched: nameMatches[0], ambiguous: [] };
  if (nameMatches.length > 1) {
    // Same name, different people: a position mentioned in the request
    // disambiguates; otherwise Bucky must ask, never guess.
    const byRole = nameMatches.filter((e) => e.role && lower.includes(e.role.trim().toLowerCase()));
    if (byRole.length === 1) return { name: byRole[0].name, matched: byRole[0], ambiguous: [] };
    return { name: nameMatches[0].name, matched: null, ambiguous: nameMatches };
  }
  const patterns = [
    /(?:salary|salaries|wage|wages|bonus|advance)(?:\s+payment)?\s+(?:for|to)\s+([A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*){0,2})/i,
    /([A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*){0,2})['’]s\s+(?:salary|wage)/i,
    /\bpay(?:ing|ed|s)?\s+(?:to\s+)?([A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*){0,2})/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) {
      const name = cleanPersonName(match[1]);
      if (name) return { name, matched: null, ambiguous: [] };
    }
  }
  return { name: "", matched: null, ambiguous: [] };
}

function currencyCheck(token: AmountToken, expected: string, expectedLabel: string): string | null {
  if (token.currency && token.currency !== expected) {
    return `You mentioned ${token.currency}, but ${expectedLabel} uses ${expected}. Bucky never converts currencies — please restate the amount in ${expected}, or check the preview currency first.`;
  }
  return null;
}

function buildSalary(text: string, ctx: BuckyActionContext, paymentType: "salary" | "bonus" | "advance" = "salary"): BuckyActionInterpretation {
  const typeLabel = paymentType === "salary" ? "Salary" : paymentType === "bonus" ? "Bonus" : "Advance";
  const typeCategory = paymentType === "salary" ? SALARY_CATEGORY : paymentType === "bonus" ? "Bonuses" : "Advances";
  if (ctx.profile.kind !== "business") {
    return {
      status: "clarification",
      question: `Salary payments can only be recorded for a business profile, and “${ctx.profile.name}” is a personal profile. Switch Bucky to your business profile and ask again — nothing was saved.`,
    };
  }
  const dated = extractDate(text, ctx.today);
  if (dated.invalidDate) return invalidDateClarification(dated.invalidDate);
  const token = extractAmount(dated.text);
  if (!token) {
    return { status: "clarification", question: "How much is the salary payment? For example: “Pay Roger ₱1,000 salary for November 1, 2026”. Nothing was saved." };
  }
  const currencyProblem = currencyCheck(token, ctx.profile.currency, `the business “${ctx.profile.name}”`);
  if (currencyProblem) return { status: "clarification", question: currencyProblem };
  const amountMinor = parseAmount(token, ctx.profile.currency);
  if (amountMinor === null) {
    return { status: "clarification", question: "I couldn't read that salary amount clearly. Please restate it, for example ₱1,000. Nothing was saved." };
  }
  const withoutAmount = dated.text.replace(token.raw, " ");
  const { name, matched, ambiguous } = extractEmployeeName(withoutAmount, ctx.employees, ctx.profile.id);
  if (ambiguous.length > 1) {
    return {
      status: "clarification",
      question: `There are ${ambiguous.length} employees named “${name}” (${ambiguous.map((e) => e.role ?? "no position recorded").join("; ")}). Which one — please include their position, for example “${typeLabel.toLowerCase()} for ${name} the ${ambiguous[0].role ?? "…"}”. Nothing was saved.`,
    };
  }
  if (!name) {
    return { status: "clarification", question: `Who is this ${typeLabel.toLowerCase()} payment for? For example: “Pay Roger ₱1,000 ${typeLabel.toLowerCase()}”. Nothing was saved.` };
  }
  const description = `${typeLabel} payment — ${name}`;
  const warnings: string[] = [];
  if (!matched) {
    warnings.push(`No employee record named “${name}” exists for this business. The name will be recorded exactly as written; no employee record will be created.`);
  } else if (matched.status !== "active") {
    warnings.push(`“${name}” is marked inactive in employee records. The payment can still be recorded if this is a final or corrected payment.`);
  }
  warnings.push(`This records one ${typeLabel.toLowerCase()} payment as a business expense. It is not a payroll run — no payslips, deductions, or schedules are created.`);
  const dup = duplicateWarning(ctx, {
    transactionType: "expense", bucketId: null, amountMinor,
    currency: ctx.profile.currency, date: dated.date, description,
  });
  if (dup) warnings.push(dup);
  return {
    status: "proposal",
    action: {
      id: ctx.createId(),
      kind: "salary-payment",
      transactionType: "expense",
      profileId: ctx.profile.id,
      profileName: ctx.profile.name,
      currency: ctx.profile.currency,
      amountMinor,
      date: dated.date,
      description,
      category: typeCategory,
      bucketId: null,
      bucketName: null,
      employeeName: name,
      employeeId: matched?.id ?? null,
      employeeMatched: Boolean(matched),
      paymentType,
      warnings,
    },
  };
}

function buildSavings(text: string, ctx: BuckyActionContext): BuckyActionInterpretation {
  const savingsBuckets = ctx.buckets.filter(
    (b) => b.profileId === ctx.profile.id && b.kind === "savings",
  );
  if (savingsBuckets.length === 0) {
    return {
      status: "clarification",
      question: `There is no existing savings goal for “${ctx.profile.name}” yet. Create the goal first in Personal Finance or Buckets — Bucky can't create goals — then ask again. Nothing was saved.`,
    };
  }
  const dated = extractDate(text, ctx.today);
  if (dated.invalidDate) return invalidDateClarification(dated.invalidDate);
  const lower = dated.text.toLowerCase();
  const match = matchBucket(lower, savingsBuckets);
  if ("ambiguous" in match) {
    return {
      status: "clarification",
      question: `Which savings goal do you mean: ${match.ambiguous.map((b) => `“${b.name}”`).join(" or ")}? Please name one goal. Nothing was saved.`,
    };
  }
  let bucket = match.bucket;
  if (!bucket) {
    // An explicitly named goal that matches nothing is a target-not-found,
    // never a reason to substitute a different goal — not even the only one.
    const namedGoal = explicitSavingsGoalName(dated.text);
    if (namedGoal) {
      return {
        status: "clarification",
        question: `I couldn't find a savings goal named “${namedGoal}” for “${ctx.profile.name}”. Your savings ${savingsBuckets.length === 1 ? "goal is" : "goals are"}: ${savingsBuckets.map((b) => `“${b.name}”`).join(", ")}. Please name one of them, or create the new goal first. Nothing was saved.`,
      };
    }
    bucket = savingsBuckets.length === 1 ? savingsBuckets[0] : null;
  }
  if (!bucket) {
    return {
      status: "clarification",
      question: `Which savings goal should receive this? You have: ${savingsBuckets.map((b) => `“${b.name}”`).join(", ")}. Please name one goal. Nothing was saved.`,
    };
  }
  const token = extractAmount(dated.text);
  if (!token) {
    return { status: "clarification", question: `How much should I add to “${bucket.name}”? Nothing was saved.` };
  }
  const currencyProblem = currencyCheck(token, bucket.currency, `the goal “${bucket.name}”`);
  if (currencyProblem) return { status: "clarification", question: currencyProblem };
  const amountMinor = parseAmount(token, bucket.currency);
  if (amountMinor === null) {
    return { status: "clarification", question: "I couldn't read that amount clearly. Please restate it, for example ₱1,000. Nothing was saved." };
  }
  const description = `Deposit to ${bucket.name}`;
  const warnings: string[] = [];
  if (!match.bucket) {
    warnings.push(`You didn't name a goal, so your only savings goal “${bucket.name}” was selected. Check the preview before confirming.`);
  }
  if (bucket.targetMinor) {
    const after = bucketSavedMinor(ctx.transactions, bucket) + amountMinor;
    if (after > bucket.targetMinor) warnings.push("This contribution takes the goal past its target amount.");
  }
  const dup = duplicateWarning(ctx, {
    transactionType: "savings-deposit", bucketId: bucket.id, amountMinor,
    currency: bucket.currency, date: dated.date, description,
  });
  if (dup) warnings.push(dup);
  return {
    status: "proposal",
    action: {
      id: ctx.createId(),
      kind: "savings-contribution",
      transactionType: "savings-deposit",
      profileId: ctx.profile.id,
      profileName: ctx.profile.name,
      currency: bucket.currency,
      amountMinor,
      date: dated.date,
      description,
      category: null,
      bucketId: bucket.id,
      bucketName: bucket.name,
      employeeName: null,
      employeeId: null,
      employeeMatched: false,
      paymentType: null,
      warnings,
    },
  };
}

function buildRecord(text: string, type: "income" | "expense", ctx: BuckyActionContext): BuckyActionInterpretation {
  const dated = extractDate(text, ctx.today);
  if (dated.invalidDate) return invalidDateClarification(dated.invalidDate);
  const token = extractAmount(dated.text);
  if (!token) {
    return {
      status: "clarification",
      question: `How much is the ${type}? For example: “Record ₱500 ${type} for ${type === "income" ? "my salary" : "groceries"}”. Nothing was saved.`,
    };
  }
  const currencyProblem = currencyCheck(token, ctx.profile.currency, `the profile “${ctx.profile.name}”`);
  if (currencyProblem) return { status: "clarification", question: currencyProblem };
  const amountMinor = parseAmount(token, ctx.profile.currency);
  if (amountMinor === null) {
    return { status: "clarification", question: "I couldn't read that amount clearly. Please restate it, for example ₱500. Nothing was saved." };
  }
  const withoutAmount = dated.text.replace(token.raw, " ");
  const { category, text: withoutCategory } = extractCategory(withoutAmount);
  const description = extractDescription(withoutCategory);
  if (!description) {
    return {
      status: "clarification",
      question: `What should the description be for this ${type}? For example: “…for ${type === "income" ? "freelance work" : "groceries"}”. Nothing was saved.`,
    };
  }
  const warnings: string[] = [];
  const dup = duplicateWarning(ctx, {
    transactionType: type, bucketId: null, amountMinor,
    currency: ctx.profile.currency, date: dated.date, description,
  });
  if (dup) warnings.push(dup);
  return {
    status: "proposal",
    action: {
      id: ctx.createId(),
      kind: type,
      transactionType: type,
      profileId: ctx.profile.id,
      profileName: ctx.profile.name,
      currency: ctx.profile.currency,
      amountMinor,
      date: dated.date,
      description,
      category,
      bucketId: null,
      bucketName: null,
      employeeName: null,
      employeeId: null,
      employeeMatched: false,
      paymentType: null,
      warnings,
    },
  };
}

/**
 * Interprets one typed/spoken request. Pure and deterministic: the same
 * input and context always produce the same interpretation, which makes
 * the safety behaviour testable without any model call.
 */
export function interpretBuckyAction(text: string, ctx: BuckyActionContext): BuckyActionInterpretation {
  const raw = text.trim();
  if (!raw) return { status: "not-action" };
  const lower = raw.toLowerCase();

  // Ordinary questions are analysis, never actions.
  if (QUESTION_START.test(raw) && !IMPERATIVE_START.test(raw)) return { status: "not-action" };

  // Destructive or out-of-scope verbs are honestly declined, never executed.
  if (/\b(delete|remove|erase|edit|update|rename|undo)\b/.test(lower)) return { status: "unsupported" };
  if (/\bwithdraw/.test(lower)) return { status: "unsupported" };

  const hasSalaryWord = /\b(salary|salaries|wage|wages)\b/.test(lower);
  const paymentType: "salary" | "bonus" | "advance" | null = /\bbonus(es)?\b/.test(lower)
    ? "bonus"
    : /\badvance(s)?\b/.test(lower)
      ? "advance"
      : hasSalaryWord
        ? "salary"
        : null;
  const hasActionVerb = /\b(record|add|log|pay|paid|paying|deposit|contribute|create|save|spent|received|earned)\b/.test(lower);
  const ownEmployees = ctx.employees.filter((e) => e.profileId === ctx.profile.id);
  const mentionsEmployee = ownEmployees.some((e) => lower.includes(e.name.trim().toLowerCase()));

  // Salary-rate changes are employee-record maintenance, not payments.
  // Bucky never treats a rate as money already paid.
  if (hasSalaryWord && /\b(rate|raise|increase|set|change|update)\b/.test(lower) && !/\bpayment\b/.test(lower)) {
    return {
      status: "clarification",
      question: "That sounds like a salary-rate change, not a payment. Rates are managed on the Employees page — a rate is never recorded as money paid. To record an actual payment, say for example: “Record ₱1,000 salary payment for Roger today”. Nothing was saved.",
    };
  }

  // Compensation payments: salary, bonus, or advance — always an expense,
  // never a payroll module. The type must be explicit; Bucky never guesses.
  if (paymentType && (hasActionVerb || mentionsEmployee)) {
    return buildSalary(raw, ctx, paymentType);
  }
  if (/^pay\b/.test(lower) && mentionsEmployee && extractAmount(raw)) {
    return {
      status: "clarification",
      question: "Is that a salary payment, a bonus, or an advance? Please say which — for example: “Pay Roger ₱1,000 salary”. Nothing was saved.",
    };
  }

  // Savings contribution to an existing goal.
  const savingsBuckets = ctx.buckets.filter(
    (b) => b.profileId === ctx.profile.id && b.kind === "savings",
  );
  const mentionsBucket = savingsBuckets.some((b) => lower.includes(b.name.trim().toLowerCase()));
  const hasSavingsCue = /\b(savings|goal|bucket)\b/.test(lower) || mentionsBucket;
  const hasDepositVerb = /\b(add|deposit|contribute|put|move|transfer|record|save)\b/.test(lower);
  if (hasSavingsCue && hasDepositVerb) return buildSavings(raw, ctx);
  if (/\b(transfer|send|move)\b/.test(lower)) return { status: "unsupported" };

  // Income / expense records.
  const isExpense = /\bexpense\b/.test(lower) || /\bspent\b/.test(lower) || /^paid\b/.test(lower);
  const isIncome = /\bincome\b/.test(lower) || /\b(received|earned)\b/.test(lower);
  if (isExpense && isIncome) {
    return { status: "clarification", question: "Should that be recorded as income or as an expense? Please say one. Nothing was saved." };
  }
  if (isExpense) return buildRecord(raw, "expense", ctx);
  if (isIncome) return buildRecord(raw, "income", ctx);
  if (/\b(record|add|log|create)\b/.test(lower) && extractAmount(raw)) {
    return { status: "clarification", question: "Is that income or an expense? Please say which, with a short description. Nothing was saved." };
  }
  return { status: "not-action" };
}

/** Builds the exact record a confirmed action will save. Validated by callers. */
export function buildBuckyTransaction(action: ProposedBuckyAction, timestamp: string): Transaction {
  return {
    id: action.id,
    profileId: action.profileId,
    bucketId: action.bucketId,
    type: action.transactionType,
    amountMinor: action.amountMinor,
    currency: action.currency,
    date: action.date,
    description: action.description,
    category: action.category,
    origin: "manual",
    // Matched salary/bonus/advance payments link to exactly one employee
    // record; everything else stays unlinked.
    relatedId: action.employeeId,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/* ------------------------------------------------------------------ */
/* Add Product — one deterministic business operation.                 */
/*                                                                     */
/* Deliberately separate from ProposedBuckyAction: a product is not a  */
/* transaction. This interpreter only *proposes*; the panel must show  */
/* a structured preview, get explicit confirmation, then create the    */
/* product through validateProduct + productsRepo.create — the exact   */
/* validation Products & Inventory uses. The model-proposal allowlist  */
/* below stays transaction-only: no model output can create products.  */
/* ------------------------------------------------------------------ */

export interface ProposedBuckyProduct {
  /** Stable ID, generated once when the preview is created and reused
   * as the product ID, so a repeated confirmation cannot duplicate it. */
  id: string;
  profileId: string;
  profileName: string;
  name: string;
  /** Selling price in integer minor units of `currency`. */
  priceMinor: number;
  currency: string;
  /** Required-field defaults, always shown in the preview. */
  sku: null;
  category: null;
  costMinor: null;
  stock: 0;
  status: "active";
  warnings: string[];
}

export type BuckyProductInterpretation =
  | { status: "proposal"; product: ProposedBuckyProduct }
  | { status: "clarification"; question: string }
  | { status: "not-action" };

export interface BuckyProductContext {
  profile: Profile;
  /** Products the caller knows about (used for duplicate warnings). */
  products: Product[];
  createId: () => string;
}

const PRODUCT_INTENT =
  /\b(?:add|create|new)\b[^.?!]*\b(?:products?|items?|inventory|menu)\b|\b(?:add|create)\s+(?:a\s+|an\s+)?product\b/i;

/**
 * Interprets "add <name> to my products … selling price is ₱35" style
 * commands. Returns "not-action" for anything without an explicit
 * product cue, so ordinary income/expense/savings commands are never
 * hijacked. Missing name or price, a personal profile, or a currency
 * that differs from the business's own currency all produce a
 * clarification — Bucky never converts or silently infers currency.
 */
export function interpretBuckyProductCommand(
  text: string,
  ctx: BuckyProductContext,
): BuckyProductInterpretation {
  const raw = text.trim();
  if (!raw) return { status: "not-action" };
  if (QUESTION_START.test(raw) && !IMPERATIVE_START.test(raw)) return { status: "not-action" };
  if (!PRODUCT_INTENT.test(raw)) return { status: "not-action" };

  if (ctx.profile.kind !== "business") {
    return {
      status: "clarification",
      question: `Products belong to a business profile, and “${ctx.profile.name}” is a personal profile. Switch Bucky to your business profile and ask again — nothing was created.`,
    };
  }

  const token = extractAmount(raw);
  if (!token) {
    return {
      status: "clarification",
      question: "What's the selling price? For example: “Add Burger to my products. Selling price is ₱35.” Nothing was created.",
    };
  }
  const currencyProblem = currencyCheck(token, ctx.profile.currency, `the business “${ctx.profile.name}”`);
  if (currencyProblem) return { status: "clarification", question: currencyProblem };
  const priceMinor = parseAmount(token, ctx.profile.currency);
  if (priceMinor === null) {
    return {
      status: "clarification",
      question: "I couldn't read that selling price clearly. Please restate it, for example ₱35. Nothing was created.",
    };
  }

  // Name: the text that remains once the command scaffolding and the
  // price clause are removed. The price clause ("selling price is ₱35")
  // is stripped first so its amount cannot leak into the name. The
  // clause runs to the next comma or the end of the text — not to the
  // first period, which may be a decimal point inside the price.
  let rest = raw
    .replace(/^bucky[,.]?\s+/i, " ")
    .replace(/\b(?:selling\s+price|price|costs?)\b[^,]*/i, " ")
    .replace(token.raw, " ")
    .replace(/\b(?:add|create|new)\b/i, " ")
    .replace(/\bto\s+my\s+(?:products?|items?|inventory|menu)\b/gi, " ")
    .replace(/\b(?:products?|items?|inventory|menu)\b/gi, " ")
    .replace(/\b(?:called|named)\b/gi, " ")
    .replace(/\bplease\b/gi, " ");
  let name = capitalise(cleanPhrase(rest));
  name = name.replace(/\s+(?:for|at)$/i, "").replace(/^[.!?,\s]+|[.!?,\s]+$/g, "").trim();
  if (!name) {
    return {
      status: "clarification",
      question: "What's the product called? For example: “Add Burger to my products. Selling price is ₱35.” Nothing was created.",
    };
  }

  const warnings: string[] = [];
  const sameName = ctx.products.filter(
    (p) => p.profileId === ctx.profile.id && p.name.trim().toLowerCase() === name.toLowerCase(),
  );
  if (sameName.some((p) => p.priceMinor === priceMinor && p.currency === ctx.profile.currency)) {
    warnings.push(`“${name}” already exists in this business at the same price. Check the preview carefully — confirming will add another product with that name.`);
  } else if (sameName.length > 0) {
    warnings.push(`A product named “${name}” already exists in this business at a different price. Confirming will add another one.`);
  }

  return {
    status: "proposal",
    product: {
      id: ctx.createId(),
      profileId: ctx.profile.id,
      profileName: ctx.profile.name,
      name,
      priceMinor,
      currency: ctx.profile.currency,
      sku: null,
      category: null,
      costMinor: null,
      stock: 0,
      status: "active",
      warnings,
    },
  };
}

/** Builds the exact product record a confirmed proposal will create. */
export function buildBuckyProduct(proposal: ProposedBuckyProduct, timestamp: string): Product {
  return {
    id: proposal.id,
    profileId: proposal.profileId,
    name: proposal.name,
    sku: proposal.sku,
    category: proposal.category,
    priceMinor: proposal.priceMinor,
    costMinor: proposal.costMinor,
    currency: proposal.currency,
    stock: proposal.stock,
    status: proposal.status,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/** Human-readable preview lines for the confirmation card. */
export function buckyActionTitle(action: ProposedBuckyAction): string {
  switch (action.kind) {
    case "income": return "Record income";
    case "expense": return "Record expense";
    case "savings-contribution": return "Add to savings goal";
    case "salary-payment":
      return action.paymentType === "bonus"
        ? "Record bonus payment (business expense)"
        : action.paymentType === "advance"
          ? "Record salary advance (business expense)"
          : "Record salary payment (business expense)";
  }
}

/**
 * Phase D — model-assisted interpretation, cross-checked locally.
 *
 * A server-side model may *propose* an interpretation when the deterministic
 * interpreter could not parse a request, but its output is never trusted.
 * This function rebuilds the proposal from the user's own words and real
 * app data, and rejects anything that does not check out:
 *
 * - the amount and date must exactly match deterministic extraction from
 *   the original text (a model can never invent or alter figures);
 * - a savings goal must resolve to exactly one real bucket of this profile;
 * - a salary-payment employee must resolve to exactly one real employee
 *   record of this business (stricter than the deterministic path: the
 *   model path never records an unmatched name), and the payment type
 *   (salary / bonus / advance) must be explicit;
 * - descriptions and categories are length-capped and re-sanitised here.
 *
 * The result is the same ProposedBuckyAction the deterministic interpreter
 * produces, so it goes through the identical preview → confirm → validated
 * commit-confirmed save pipeline. Any failure is a clarification, never a
 * guess, and nothing is ever saved by this function.
 */
export interface ModelActionProposal {
  kind: string;
  amountMinor: number;
  date: string;
  description: string | null;
  category: string | null;
  bucketName: string | null;
  employeeName: string | null;
  paymentType: "salary" | "bonus" | "advance" | null;
}

const MODEL_AI_WARNING =
  "Interpreted with AI assistance, then checked word-by-word against your request and your records. Review every detail before confirming.";

function modelReject(question: string): BuckyActionInterpretation {
  return { status: "clarification", question: `${question} Nothing was saved.` };
}

export function buildActionFromModelProposal(
  originalText: string,
  proposal: ModelActionProposal,
  ctx: BuckyActionContext,
): BuckyActionInterpretation {
  const kinds: BuckyActionKind[] = ["income", "expense", "savings-contribution", "salary-payment"];
  if (!kinds.includes(proposal.kind as BuckyActionKind)) {
    return modelReject("The AI interpretation didn't describe a record Bucky can prepare.");
  }
  const kind = proposal.kind as BuckyActionKind;
  if (!Number.isSafeInteger(proposal.amountMinor) || proposal.amountMinor <= 0) {
    return modelReject("The AI interpretation didn't include a usable amount.");
  }
  if (!isValidCalendarDate(proposal.date)) {
    return modelReject("The AI interpretation didn't include a usable date.");
  }

  // Cross-check date and amount against the user's own words. The model
  // may only ever repeat what the user actually said.
  const dated = extractDate(originalText.trim(), ctx.today);
  if (dated.invalidDate) {
    return modelReject(
      `“${dated.invalidDate}” isn't a real calendar date. Please correct the date and try again.`,
    );
  }
  if (dated.date !== proposal.date) {
    return modelReject(
      `The AI suggested ${proposal.date}, but your words point to ${dated.date}. Please restate the date clearly, for example “November 1, 2026”.`,
    );
  }
  const token = extractAmount(dated.text);
  if (!token) {
    return modelReject("I couldn't find an amount in your own words to check the AI suggestion against.");
  }

  const warnings: string[] = [MODEL_AI_WARNING];
  const base = {
    id: ctx.createId(),
    profileId: ctx.profile.id,
    profileName: ctx.profile.name,
    date: proposal.date,
  };

  if (kind === "savings-contribution") {
    const savingsBuckets = ctx.buckets.filter(
      (b) => b.profileId === ctx.profile.id && b.kind === "savings",
    );
    // Deterministic target validation wins over the model: an explicitly
    // named goal that matches no real goal can never be substituted with
    // a different goal the model happened to pick.
    const namedGoal = explicitSavingsGoalName(originalText);
    if (namedGoal) {
      const deterministic = matchBucket(originalText.toLowerCase(), savingsBuckets);
      if (!("bucket" in deterministic) || !deterministic.bucket) {
        return modelReject(
          `You named a savings goal “${namedGoal}”, but it doesn't match your goals (${savingsBuckets.map((b) => `“${b.name}”`).join(", ")}). Please name one of them — Bucky won't substitute another goal.`,
        );
      }
    }
    const wanted = (proposal.bucketName ?? "").trim().toLowerCase();
    const matches = savingsBuckets.filter((b) => b.name.trim().toLowerCase() === wanted);
    if (matches.length === 0) {
      return modelReject(
        savingsBuckets.length > 0
          ? `The AI named a savings goal that doesn't match your goals (${savingsBuckets.map((b) => `“${b.name}”`).join(", ")}). Please name one of them.`
          : "There is no existing savings goal for this profile yet, and Bucky can't create goals.",
      );
    }
    if (matches.length > 1) {
      return modelReject("More than one savings goal matches that name. Please say which one.");
    }
    const bucket = matches[0];
    const currencyProblem = currencyCheck(token, bucket.currency, `the goal “${bucket.name}”`);
    if (currencyProblem) return modelReject(currencyProblem);
    const amountMinor = parseAmount(token, bucket.currency);
    if (amountMinor === null || amountMinor !== proposal.amountMinor) {
      return modelReject("The AI amount doesn't match the amount in your own words. Please restate the amount.");
    }
    const description = `Deposit to ${bucket.name}`;
    if (bucket.targetMinor) {
      const after = bucketSavedMinor(ctx.transactions, bucket) + amountMinor;
      if (after > bucket.targetMinor) warnings.push("This contribution takes the goal past its target amount.");
    }
    const dup = duplicateWarning(ctx, {
      transactionType: "savings-deposit", bucketId: bucket.id, amountMinor,
      currency: bucket.currency, date: proposal.date, description,
    });
    if (dup) warnings.push(dup);
    return {
      status: "proposal",
      action: {
        ...base,
        kind,
        transactionType: "savings-deposit",
        currency: bucket.currency,
        amountMinor,
        description,
        category: null,
        bucketId: bucket.id,
        bucketName: bucket.name,
        employeeName: null,
        employeeId: null,
        employeeMatched: false,
        paymentType: null,
        warnings,
      },
    };
  }

  if (kind === "salary-payment") {
    if (ctx.profile.kind !== "business") {
      return modelReject(
        `Salary payments can only be recorded for a business profile, and “${ctx.profile.name}” is a personal profile.`,
      );
    }
    if (proposal.paymentType !== "salary" && proposal.paymentType !== "bonus" && proposal.paymentType !== "advance") {
      return modelReject("Was that a salary payment, a bonus, or an advance? Please say which.");
    }
    const wanted = (proposal.employeeName ?? "").trim().toLowerCase();
    const matches = ctx.employees.filter(
      (e) => e.profileId === ctx.profile.id && e.name.trim().toLowerCase() === wanted,
    );
    if (matches.length === 0) {
      return modelReject(
        "The AI named an employee who has no employee record for this business. Bucky never invents employees — add the employee on the Employees page, or check the name.",
      );
    }
    if (matches.length > 1) {
      return modelReject(
        `There are ${matches.length} employees with that name (${matches.map((e) => e.role ?? "no position recorded").join("; ")}). Please include their position.`,
      );
    }
    const employee = matches[0];
    const currencyProblem = currencyCheck(token, ctx.profile.currency, `the business “${ctx.profile.name}”`);
    if (currencyProblem) return modelReject(currencyProblem);
    const amountMinor = parseAmount(token, ctx.profile.currency);
    if (amountMinor === null || amountMinor !== proposal.amountMinor) {
      return modelReject("The AI amount doesn't match the amount in your own words. Please restate the amount.");
    }
    const typeLabel = proposal.paymentType === "salary" ? "Salary" : proposal.paymentType === "bonus" ? "Bonus" : "Advance";
    const typeCategory = proposal.paymentType === "salary" ? SALARY_CATEGORY : proposal.paymentType === "bonus" ? "Bonuses" : "Advances";
    const description = `${typeLabel} payment — ${employee.name}`;
    if (employee.status !== "active") {
      warnings.push(`“${employee.name}” is marked inactive in employee records. The payment can still be recorded if this is a final or corrected payment.`);
    }
    warnings.push(`This records one ${typeLabel.toLowerCase()} payment as a business expense. It is not a payroll run — no payslips, deductions, or schedules are created.`);
    const dup = duplicateWarning(ctx, {
      transactionType: "expense", bucketId: null, amountMinor,
      currency: ctx.profile.currency, date: proposal.date, description,
    });
    if (dup) warnings.push(dup);
    return {
      status: "proposal",
      action: {
        ...base,
        kind,
        transactionType: "expense",
        currency: ctx.profile.currency,
        amountMinor,
        description,
        category: typeCategory,
        bucketId: null,
        bucketName: null,
        employeeName: employee.name,
        employeeId: employee.id,
        employeeMatched: true,
        paymentType: proposal.paymentType,
        warnings,
      },
    };
  }

  // Income / expense records.
  const description = capitalise(cleanPhrase((proposal.description ?? "").slice(0, 80)));
  if (!description) {
    return modelReject(`What should the description be for this ${kind}? Please include a short description.`);
  }
  const currencyProblem = currencyCheck(token, ctx.profile.currency, `the profile “${ctx.profile.name}”`);
  if (currencyProblem) return modelReject(currencyProblem);
  const amountMinor = parseAmount(token, ctx.profile.currency);
  if (amountMinor === null || amountMinor !== proposal.amountMinor) {
    return modelReject("The AI amount doesn't match the amount in your own words. Please restate the amount.");
  }
  const category = proposal.category
    ? capitalise(cleanPhrase(proposal.category.slice(0, 40))) || null
    : null;
  const dup = duplicateWarning(ctx, {
    transactionType: kind, bucketId: null, amountMinor,
    currency: ctx.profile.currency, date: proposal.date, description,
  });
  if (dup) warnings.push(dup);
  return {
    status: "proposal",
    action: {
      ...base,
      kind,
      transactionType: kind,
      currency: ctx.profile.currency,
      amountMinor,
      description,
      category,
      bucketId: null,
      bucketName: null,
      employeeName: null,
      employeeId: null,
      employeeMatched: false,
      paymentType: null,
      warnings,
    },
  };
}

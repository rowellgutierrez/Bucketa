import { errors } from "./errors.mjs";
import { metaDiagnosticError } from "./metaDiagnostics.mjs";
import { isValidCurrencyCode, minorUnitDigits } from "./money.mjs";

/**
 * Bucky Agent 1.0 — server-side financial reasoning support.
 *
 * The model never sees raw records. The browser sends only the aggregated
 * summary produced by buildBuckyModelSummary (totals/counts per currency),
 * this module validates that payload strictly, and every figure shown to
 * the user is recomputed here from the validated summary. Model prose is
 * treated as untrusted: unknown actions are rejected, invented numbers
 * fail a grounding check, and a deterministic fallback answers whenever
 * the live model is unavailable, disabled, or fails validation. The
 * fallback is always labelled as such — never as Meta output.
 */

export const BUCKY_ADVICE_MAX_BODY_BYTES = 16_384;
export const BUCKY_QUESTION_MAX_LENGTH = 500;

export const BUCKY_ALLOWED_ACTIONS = {
  "view-transactions": { label: "View transactions", route: "/transactions" },
  "review-categories": { label: "Review expense categories", route: "/transactions" },
  "view-inventory": { label: "View inventory", route: "/products" },
  "review-savings": { label: "Review savings buckets", route: "/buckets" },
  "open-scanner": { label: "Open the scanner", route: "/scanner" },
  "view-pos": { label: "View POS reports", route: "/pos" },
};

const INSIGHT_KINDS = [
  "cash-flow", "categories", "month-change", "duplicates",
  "savings", "inventory", "pos", "data-quality",
];

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

function isSafeCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isSafeAmount(value) {
  return Number.isSafeInteger(value);
}

/** Format integer minor units using the currency's own decimal digits. */
export function formatMinor(amountMinor, currency) {
  const digits = minorUnitDigits(currency);
  const sign = amountMinor < 0 ? "-" : "";
  const abs = Math.abs(amountMinor);
  if (digits === 0) return `${sign}${currency} ${abs}`;
  const padded = String(abs).padStart(digits + 1, "0");
  return `${sign}${currency} ${padded.slice(0, -digits)}.${padded.slice(-digits)}`;
}

/**
 * Strictly validate the client payload. Returns a normalised copy or
 * throws a safe PublicError. Unknown keys are rejected so raw records or
 * unexpected fields can never be smuggled into a model prompt.
 */
export function validateAdviceRequest(payload) {
  if (!isRecord(payload) || !hasOnlyKeys(payload, ["question", "mode", "summary"])) {
    throw errors.invalidRequest();
  }
  const question = cleanString(payload.question, BUCKY_QUESTION_MAX_LENGTH);
  if (!question) throw errors.invalidRequest();
  const mode = payload.mode === undefined ? "fallback" : payload.mode;
  if (mode !== "fallback" && mode !== "live") throw errors.invalidRequest();

  const s = payload.summary;
  if (
    !isRecord(s) ||
    !hasOnlyKeys(s, ["profileName", "profileKind", "currencies", "insightKinds", "duplicateGroupCount", "lowStockCount", "limitations"])
  ) {
    throw errors.invalidRequest();
  }
  const profileName = cleanString(s.profileName, 80);
  if (!profileName || (s.profileKind !== "personal" && s.profileKind !== "business")) {
    throw errors.invalidRequest();
  }
  if (!Array.isArray(s.currencies) || s.currencies.length > 8) throw errors.invalidRequest();
  const currencies = s.currencies.map((c) => {
    if (
      !isRecord(c) ||
      !hasOnlyKeys(c, ["currency", "incomeMinor", "expenseMinor", "netCashFlowMinor", "transactionCount", "posRevenueMinor", "posSaleCount", "topExpenseCategories", "monthExpenseChangePct"]) ||
      !isValidCurrencyCode(c.currency) ||
      !isSafeAmount(c.incomeMinor) || c.incomeMinor < 0 ||
      !isSafeAmount(c.expenseMinor) || c.expenseMinor < 0 ||
      !isSafeAmount(c.netCashFlowMinor) ||
      !isSafeCount(c.transactionCount) ||
      !isSafeAmount(c.posRevenueMinor) || c.posRevenueMinor < 0 ||
      !isSafeCount(c.posSaleCount) ||
      !Array.isArray(c.topExpenseCategories) || c.topExpenseCategories.length > 3
    ) {
      throw errors.invalidRequest();
    }
    const topExpenseCategories = c.topExpenseCategories.map((t) => {
      const category = isRecord(t) ? cleanString(t.category, 60) : null;
      if (!category || !isRecord(t) || !hasOnlyKeys(t, ["category", "totalMinor"]) || !isSafeAmount(t.totalMinor) || t.totalMinor < 0) {
        throw errors.invalidRequest();
      }
      return { category, totalMinor: t.totalMinor };
    });
    const pct = c.monthExpenseChangePct;
    if (!(pct === null || (typeof pct === "number" && Number.isFinite(pct) && pct >= -1000 && pct <= 10000))) {
      throw errors.invalidRequest();
    }
    return {
      currency: c.currency,
      incomeMinor: c.incomeMinor,
      expenseMinor: c.expenseMinor,
      netCashFlowMinor: c.netCashFlowMinor,
      transactionCount: c.transactionCount,
      posRevenueMinor: c.posRevenueMinor,
      posSaleCount: c.posSaleCount,
      topExpenseCategories,
      monthExpenseChangePct: pct,
    };
  });
  if (
    !Array.isArray(s.insightKinds) || s.insightKinds.length > 20 ||
    !s.insightKinds.every((k) => INSIGHT_KINDS.includes(k)) ||
    !isSafeCount(s.duplicateGroupCount) || !isSafeCount(s.lowStockCount) ||
    !Array.isArray(s.limitations) || s.limitations.length > 6
  ) {
    throw errors.invalidRequest();
  }
  const limitations = s.limitations.map((l) => cleanString(l, 300));
  if (limitations.some((l) => l === null)) throw errors.invalidRequest();

  return {
    question,
    mode,
    summary: {
      profileName,
      profileKind: s.profileKind,
      currencies,
      insightKinds: [...s.insightKinds],
      duplicateGroupCount: s.duplicateGroupCount,
      lowStockCount: s.lowStockCount,
      limitations,
    },
  };
}

/** Verified evidence, computed here from the validated summary only. */
export function buildVerifiedEvidence(summary) {
  const evidence = [];
  for (const c of summary.currencies) {
    if (c.transactionCount > 0) {
      evidence.push({ label: `${c.currency} income`, value: formatMinor(c.incomeMinor, c.currency) });
      evidence.push({ label: `${c.currency} expenses`, value: formatMinor(c.expenseMinor, c.currency) });
      evidence.push({ label: `${c.currency} net cash flow (not profit)`, value: formatMinor(c.netCashFlowMinor, c.currency) });
    }
    if (c.posSaleCount > 0) {
      evidence.push({ label: `${c.currency} POS revenue (separate)`, value: formatMinor(c.posRevenueMinor, c.currency) });
    }
    const top = c.topExpenseCategories[0];
    if (top) evidence.push({ label: `${c.currency} largest expense category`, value: `${top.category}: ${formatMinor(top.totalMinor, c.currency)}` });
    if (c.monthExpenseChangePct !== null) {
      evidence.push({ label: `${c.currency} expense change vs last month`, value: `${c.monthExpenseChangePct.toFixed(0)}%` });
    }
  }
  if (summary.duplicateGroupCount > 0) {
    evidence.push({ label: "Possible duplicate groups", value: String(summary.duplicateGroupCount) });
  }
  if (summary.lowStockCount > 0) {
    evidence.push({ label: "Low-stock products", value: String(summary.lowStockCount) });
  }
  return evidence.slice(0, 8);
}

function resolveActions(ids) {
  return ids
    .filter((id) => Object.hasOwn(BUCKY_ALLOWED_ACTIONS, id))
    .map((id) => ({ id, ...BUCKY_ALLOWED_ACTIONS[id] }));
}

/**
 * Deterministic fallback: answers from the validated summary in code.
 * Used whenever the live model is not requested, not gated, unavailable,
 * or its response fails validation. Always labelled via `source`.
 */
export function buildDeterministicAdvice({ question, summary }) {
  const q = question.toLowerCase();
  const evidence = buildVerifiedEvidence(summary);
  const limitations = [
    ...summary.limitations,
    "This answer was calculated locally from your recorded summaries because the live Meta model was not used.",
  ];
  const hasData = summary.currencies.some((c) => c.transactionCount > 0 || c.posSaleCount > 0);

  if (!hasData) {
    return {
      answer: `I don't have any saved income, expense, or POS records for ${summary.profileName} yet, so I can't identify patterns. Add a record manually or scan a handwritten record first.`,
      explanation: "No relevant records exist in the selected profile, so there is nothing grounded to explain.",
      evidence: [],
      suggestedActions: resolveActions(["open-scanner", "view-transactions"]),
      limitations,
    };
  }

  const perCurrency = summary.currencies
    .filter((c) => c.transactionCount > 0 || c.posSaleCount > 0)
    .map((c) => {
      const parts = [];
      if (c.transactionCount > 0) {
        parts.push(`income ${formatMinor(c.incomeMinor, c.currency)}, expenses ${formatMinor(c.expenseMinor, c.currency)}, net cash flow ${formatMinor(c.netCashFlowMinor, c.currency)}`);
      }
      if (c.posSaleCount > 0) parts.push(`POS revenue ${formatMinor(c.posRevenueMinor, c.currency)} from ${c.posSaleCount} sale${c.posSaleCount === 1 ? "" : "s"} (kept separate from transaction income)`);
      return `${c.currency}: ${parts.join("; ")}`;
    })
    .join(" · ");

  if (/duplicate|twice|double/.test(q)) {
    return {
      answer: summary.duplicateGroupCount > 0
        ? `I found ${summary.duplicateGroupCount} possible duplicate group${summary.duplicateGroupCount === 1 ? "" : "s"} for ${summary.profileName} (same description, type, amount, currency, and date). They may be legitimate repeats — please review them; I never delete records.`
        : `I found no possible duplicate groups for ${summary.profileName} using the same description, type, amount, currency, and date.`,
      explanation: "Duplicate detection is an exact deterministic match over recorded fields.",
      evidence,
      suggestedActions: resolveActions(["view-transactions"]),
      limitations,
    };
  }
  if (/stock|inventory|restock|product/.test(q)) {
    return {
      answer: summary.lowStockCount > 0
        ? `${summary.lowStockCount} active product${summary.lowStockCount === 1 ? " is" : "s are"} at 3 or fewer units for ${summary.profileName}. Check inventory before deciding what to restock — I can't see supplier prices or lead times.`
        : `No active products are at 3 or fewer units for ${summary.profileName} based on recorded stock.`,
      explanation: "Based on current recorded stock levels for active products only.",
      evidence,
      suggestedActions: resolveActions(["view-inventory"]),
      limitations,
    };
  }
  if (/categor/.test(q) || /most|biggest|largest/.test(q)) {
    const tops = summary.currencies
      .filter((c) => c.topExpenseCategories[0])
      .map((c) => `${c.currency}: ${c.topExpenseCategories[0].category} (${formatMinor(c.topExpenseCategories[0].totalMinor, c.currency)})`);
    return {
      answer: tops.length > 0
        ? `Largest recorded expense categor${tops.length === 1 ? "y" : "ies"} for ${summary.profileName} — ${tops.join(" · ")}.`
        : `There are no categorised expenses recorded for ${summary.profileName} yet.`,
      explanation: "Category totals are summed in code per currency and never combined across currencies.",
      evidence,
      suggestedActions: resolveActions(["review-categories"]),
      limitations,
    };
  }
  if (/increase|expense|spending|compare|month/.test(q)) {
    const changed = summary.currencies.filter((c) => c.monthExpenseChangePct !== null);
    const answer = changed.length > 0
      ? changed.map((c) => `${c.currency} expenses ${c.monthExpenseChangePct >= 0 ? "rose" : "fell"} ${Math.abs(c.monthExpenseChangePct).toFixed(0)}% compared with last month`).join(" · ") +
        `. For context: ${perCurrency}. A change can reflect more records saved this month, not only higher prices, so review the underlying records before acting.`
      : `There isn't enough dated expense history for ${summary.profileName} to compare this month with last month yet. ${perCurrency}.`;
    return {
      answer,
      explanation: "Month comparison uses recorded expenses in each currency separately; net cash flow is not profit.",
      evidence,
      suggestedActions: resolveActions(["review-categories", "view-transactions"]),
      limitations,
    };
  }
  if (/pos|sale|revenue|earn|business/.test(q)) {
    const withPos = summary.currencies.filter((c) => c.posSaleCount > 0);
    return {
      answer: withPos.length > 0
        ? `Recorded POS revenue for ${summary.profileName} — ${withPos.map((c) => `${formatMinor(c.posRevenueMinor, c.currency)} from ${c.posSaleCount} sale${c.posSaleCount === 1 ? "" : "s"}`).join(" · ")}. This is revenue, not profit: product purchase costs are not snapshotted on sale lines, so cost of goods sold is unknown. Transaction income is reported separately so nothing is double-counted.`
        : `No completed POS sales are recorded for ${summary.profileName} yet, so I can't report POS revenue. ${perCurrency}.`,
      explanation: "POS revenue is counted from completed sales only and kept separate from transaction income.",
      evidence,
      suggestedActions: resolveActions(["view-pos", "view-transactions"]),
      limitations,
    };
  }
  if (/saving|goal|bucket|improve|reduce|priorit/.test(q)) {
    return {
      answer: `Here's what I can verify for ${summary.profileName}: ${perCurrency}. Practical next steps: review the largest expense category first, categorise any uncategorised expenses so the analysis is trustworthy, and check savings buckets before moving money. I can't recommend amounts beyond these recorded figures.`,
      explanation: "Savings and prioritisation suggestions are limited to patterns visible in the recorded summaries.",
      evidence,
      suggestedActions: resolveActions(["review-savings", "review-categories"]),
      limitations,
    };
  }
  return {
    answer: `Financial overview for ${summary.profileName}: ${perCurrency}. Net cash flow is recorded income minus recorded expenses — it is not profit and not a bank balance.`,
    explanation: "All figures are calculated in code from recorded transactions and completed POS sales, per currency.",
    evidence,
    suggestedActions: resolveActions(["view-transactions", "review-categories"]),
    limitations,
  };
}

export const BUCKY_ADVICE_JSON_SCHEMA = {
  type: "object",
  properties: {
    // Length/emptiness limits mirror validateModelAdvice exactly, so the
    // model is never instructed to produce output the validator rejects.
    answer: { type: "string", minLength: 1, maxLength: 1200 },
    explanation: { type: "string", minLength: 1, maxLength: 1200 },
    // No evidence property: evidence figures are computed and attached by
    // the server, so the model is never asked to produce them (the prompt
    // says the same). Keeping an optional, always-discarded property in a
    // strict schema was unnecessary compatibility surface. The local
    // validator still tolerates and discards well-formed legacy evidence.
    suggestedActionIds: {
      type: "array",
      maxItems: 4,
      items: { type: "string", enum: Object.keys(BUCKY_ALLOWED_ACTIONS) },
    },
    limitations: {
      type: "array",
      maxItems: 6,
      items: { type: "string", minLength: 1, maxLength: 300 },
    },
  },
  required: ["answer", "explanation", "suggestedActionIds", "limitations"],
  additionalProperties: false,
};

export function buildBuckyAdvicePrompt({ question, summary }) {
  return [
    `You are Bucky, a financial assistant inside Bucketa, answering a question for the profile "${summary.profileName}" (${summary.profileKind}).`,
    "Use ONLY the aggregated summary below. Never invent transactions, amounts, products, or dates. Never combine currencies.",
    "Net cash flow is recorded income minus recorded expenses: it is not profit and not a bank balance. POS revenue is separate from transaction income.",
    "If the summary cannot answer the question, say so plainly and state what records would be needed. Do not give professional financial advice; keep suggestions practical and tied to the figures.",
    "Return only answer, explanation, suggestedActionIds, and limitations. Evidence figures are computed and attached by the server, so do not return an evidence field.",
    `Suggested actions may only use these ids: ${Object.keys(BUCKY_ALLOWED_ACTIONS).join(", ")}.`,
    `Question: ${question}`,
    `Aggregated summary (integer minor units per currency): ${JSON.stringify(summary)}`,
  ].join("\n");
}

/** Numbers a model may legitimately mention, derived from the summary. */
function allowedNumbers(summary) {
  const allowed = new Set();
  const add = (n) => {
    if (typeof n !== "number" || !Number.isFinite(n)) return;
    allowed.add(String(Math.round(n)));
    allowed.add(n.toFixed(0));
    allowed.add(n.toFixed(1));
    allowed.add(n.toFixed(2));
  };
  for (const c of summary.currencies) {
    const digits = minorUnitDigits(c.currency);
    const divisor = 10 ** digits;
    for (const minor of [c.incomeMinor, c.expenseMinor, c.netCashFlowMinor, c.posRevenueMinor, ...c.topExpenseCategories.map((t) => t.totalMinor)]) {
      add(minor);
      add(minor / divisor);
      add(Math.abs(minor / divisor));
    }
    add(c.transactionCount);
    add(c.posSaleCount);
    if (c.monthExpenseChangePct !== null) {
      add(c.monthExpenseChangePct);
      add(Math.abs(c.monthExpenseChangePct));
    }
  }
  add(summary.duplicateGroupCount);
  add(summary.lowStockCount);
  return allowed;
}

/**
 * Reject model text containing material numbers that are not in the
 * summary. Small integers (< 100, e.g. "3 steps") are tolerated;
 * decimals, percentages, and numbers >= 100 must be grounded.
 */
export function findUngroundedNumbers(text, summary) {
  const allowed = allowedNumbers(summary);
  const ungrounded = [];
  for (const match of String(text).matchAll(/\d[\d,]*(\.\d+)?%?/g)) {
    const raw = match[0].replace(/,/g, "");
    const isPercent = raw.endsWith("%");
    const numericText = raw.replace("%", "");
    const value = Number(numericText);
    if (!Number.isFinite(value)) continue;
    const hasDecimal = numericText.includes(".");
    if (!hasDecimal && !isPercent && value < 100) continue;
    // Decimals must match a summary figure exactly — never by rounding
    // (99999.99 must not pass just because it rounds to an allowed
    // 100000). Integers and percentages may use the summary's own
    // rounded display forms.
    const candidates = hasDecimal
      ? [numericText, String(value)]
      : [numericText, String(value), value.toFixed(1), value.toFixed(2), String(Math.round(value))];
    if (!candidates.some((c) => allowed.has(c))) ungrounded.push(match[0]);
  }
  return ungrounded;
}

/**
 * Validate untrusted model output. Throws (safe caller falls back) on any
 * structural problem, unknown action, empty/overlong text, or ungrounded
 * number. Model-supplied evidence is validated but never used as facts —
 * the caller attaches server-computed evidence instead.
 */
const ADVICE_KEYS = ["answer", "explanation", "evidence", "suggestedActionIds", "limitations"];
const ADVICE_REQUIRED_KEYS = ["answer", "explanation", "suggestedActionIds", "limitations"];

function schemaError(subReason) {
  return metaDiagnosticError("schema_validation", { subReason });
}

export function validateModelAdvice(parsed, summary) {
  if (!isRecord(parsed)) throw schemaError("unknown_schema_failure");
  if (!ADVICE_REQUIRED_KEYS.every((k) => Object.hasOwn(parsed, k))) {
    throw schemaError("missing_required_keys");
  }
  if (!hasOnlyKeys(parsed, ADVICE_KEYS)) throw schemaError("unexpected_keys");

  if (typeof parsed.answer !== "string" || !parsed.answer.trim()) throw schemaError("invalid_answer");
  if (parsed.answer.length > 1200) throw schemaError("invalid_field_length");
  if (typeof parsed.explanation !== "string" || !parsed.explanation.trim()) throw schemaError("invalid_field_type");
  if (parsed.explanation.length > 1200) throw schemaError("invalid_field_length");
  const answer = cleanString(parsed.answer, 1200);
  const explanation = cleanString(parsed.explanation, 1200);
  if (!answer) throw schemaError("invalid_answer");
  if (!explanation) throw schemaError("invalid_field_type");

  // Evidence is optional (server evidence is authoritative); when the
  // model supplies it, it must still be well-formed — and is discarded.
  // Label/value limits are checked on the raw strings, before cleaning,
  // so padded over-limit values cannot slip past the schema limits.
  if (parsed.evidence !== undefined) {
    if (!Array.isArray(parsed.evidence) || parsed.evidence.length > 6) throw schemaError("invalid_evidence");
    for (const e of parsed.evidence) {
      if (
        !isRecord(e) || !hasOnlyKeys(e, ["label", "value"]) ||
        typeof e.label !== "string" || !e.label.trim() || e.label.length > 80 ||
        typeof e.value !== "string" || !e.value.trim() || e.value.length > 80 ||
        !cleanString(e.label, 80) || !cleanString(e.value, 80)
      ) {
        throw schemaError("invalid_evidence");
      }
    }
  }
  if (
    !Array.isArray(parsed.suggestedActionIds) || parsed.suggestedActionIds.length > 4 ||
    !parsed.suggestedActionIds.every((id) => typeof id === "string" && Object.hasOwn(BUCKY_ALLOWED_ACTIONS, id))
  ) {
    throw schemaError("invalid_actions");
  }
  if (!Array.isArray(parsed.limitations) || parsed.limitations.length > 6) throw schemaError("invalid_limitations");
  // Raw-length checks happen before cleaning, matching the schema's
  // maxLength semantics (cleanString trims first and would otherwise let
  // padded over-limit strings through).
  if (parsed.limitations.some((l) => typeof l !== "string" || !l.trim() || l.length > 300)) {
    throw schemaError("invalid_limitations");
  }
  const limitations = parsed.limitations.map((l) => cleanString(l, 300));
  if (limitations.some((l) => l === null)) throw schemaError("invalid_limitations");

  // Limitations are shown to the user, so they are grounded exactly like
  // the answer and explanation: no invented amounts or percentages.
  const ungrounded = findUngroundedNumbers(`${answer} ${explanation} ${limitations.join(" ")}`, summary);
  if (ungrounded.length > 0) throw metaDiagnosticError("grounding_validation");

  return {
    answer,
    explanation,
    suggestedActions: resolveActions(parsed.suggestedActionIds),
    limitations,
  };
}

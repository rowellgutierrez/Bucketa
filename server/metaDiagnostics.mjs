import { PublicError } from "./errors.mjs";

/**
 * Safe Meta failure diagnostics.
 *
 * Every Meta failure keeps the exact existing public error
 * (code "meta_unavailable", HTTP 502, same message) and additionally
 * carries a whitelisted diagnostic: a category, an optional upstream
 * HTTP status, and elapsed time. Categories and statuses are the ONLY
 * diagnostic data ever logged or returned — never credentials, headers,
 * request/response bodies, model output, or stack traces.
 */
export const META_DIAGNOSTIC_CATEGORIES = [
  "auth_failure",
  "endpoint_not_found",
  "rate_limited",
  "upstream_http",
  "network_error",
  "timeout",
  "invalid_envelope",
  "invalid_json",
  "schema_validation",
  "grounding_validation",
  "unknown",
];

/**
 * Fixed-enum sub-reasons for schema_validation failures. Only the
 * sub-reason identifier is ever reported — never the rejected content.
 */
export const SCHEMA_DIAGNOSTIC_SUBREASONS = [
  "missing_required_keys",
  "unexpected_keys",
  "invalid_answer",
  "invalid_evidence",
  "invalid_actions",
  "invalid_limitations",
  "invalid_field_type",
  "invalid_field_length",
  "unknown_schema_failure",
];

export class MetaDiagnosticError extends PublicError {
  constructor(category, { upstreamStatus = null, elapsedMs = null, subReason = null } = {}) {
    super(
      "meta_unavailable",
      502,
      "The Meta Model API could not be reached or returned an unusable response.",
    );
    this.name = "MetaDiagnosticError";
    this.diagnosticCategory = META_DIAGNOSTIC_CATEGORIES.includes(category)
      ? category
      : "unknown";
    this.upstreamStatus =
      Number.isInteger(upstreamStatus) && upstreamStatus >= 100 && upstreamStatus <= 599
        ? upstreamStatus
        : null;
    this.elapsedMs =
      typeof elapsedMs === "number" && Number.isFinite(elapsedMs) && elapsedMs >= 0
        ? Math.round(elapsedMs)
        : null;
    this.diagnosticSubReason = SCHEMA_DIAGNOSTIC_SUBREASONS.includes(subReason)
      ? subReason
      : null;
  }
}

export function metaDiagnosticError(category, details) {
  return new MetaDiagnosticError(category, details);
}

/**
 * Extract a log/return-safe diagnostic from any thrown value. Anything
 * that is not a MetaDiagnosticError collapses to category "unknown"
 * with no status — nested causes, messages, and stacks are dropped.
 */
export function safeMetaDiagnostic(error) {
  if (error instanceof MetaDiagnosticError) {
    return {
      category: error.diagnosticCategory,
      upstreamStatus: error.upstreamStatus,
      elapsedMs: error.elapsedMs,
      subReason: error.diagnosticSubReason,
    };
  }
  return { category: "unknown", upstreamStatus: null, elapsedMs: null, subReason: null };
}

/**
 * One structured server log line containing only whitelisted fields.
 * Scope is a fixed caller-supplied label (e.g. "bucky-advise/live").
 */
export function metaDiagnosticLogLine(scope, diagnostic, elapsedMs) {
  const category = META_DIAGNOSTIC_CATEGORIES.includes(diagnostic?.category)
    ? diagnostic.category
    : "unknown";
  const status =
    Number.isInteger(diagnostic?.upstreamStatus) &&
    diagnostic.upstreamStatus >= 100 &&
    diagnostic.upstreamStatus <= 599
      ? diagnostic.upstreamStatus
      : "-";
  const elapsed =
    typeof elapsedMs === "number" && Number.isFinite(elapsedMs) && elapsedMs >= 0
      ? Math.round(elapsedMs)
      : (diagnostic?.elapsedMs ?? "-");
  const sub = SCHEMA_DIAGNOSTIC_SUBREASONS.includes(diagnostic?.subReason)
    ? ` subReason=${diagnostic.subReason}`
    : "";
  return `meta-diagnostic scope=${scope} category=${category} upstreamStatus=${status} elapsedMs=${elapsed}${sub}`;
}

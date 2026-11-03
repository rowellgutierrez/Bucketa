/**
 * Typed client for the Bucky Agent endpoint (POST /api/bucky/advise).
 *
 * The browser sends ONLY the aggregated summary from
 * buildBuckyModelSummary (totals/counts per currency) — never raw
 * records, descriptions, or database access. The Meta API key stays
 * server-side. A live-test token is never hard-coded, persisted, or
 * logged; it is forwarded only when a caller supplies one at runtime
 * for an explicitly requested live answer.
 */
import type { buildBuckyModelSummary } from "./buckyAgent.ts";

export type BuckyModelSummary = ReturnType<typeof buildBuckyModelSummary>;

export interface BuckyAdviceAction {
  id: string;
  label: string;
  route: string;
}

export interface BuckyAdviceResponse {
  /** "meta-live" = validated Meta model output; otherwise calculated locally. */
  source: "meta-live" | "deterministic-fallback";
  model: string | null;
  answer: string;
  explanation: string;
  evidence: { label: string; value: string }[];
  suggestedActions: BuckyAdviceAction[];
  limitations: string[];
  /** Safe failure category when a live request fell back; never secrets. */
  diagnostic?: { category: string; upstreamStatus: number | null; subReason?: string | null };
}

export class BuckyApiError extends Error {
  readonly code: string;
  readonly status: number | null;
  constructor(code: string, message: string, status: number | null = null) {
    super(message);
    this.name = "BuckyApiError";
    this.code = code;
    this.status = status;
  }
}

const OFFLINE_MESSAGE =
  "The AI Insights backend could not be reached. Your calculated answer above still applies.";
const GENERIC_MESSAGE = "The AI Insights request could not be completed. Your calculated answer above still applies.";

const ERROR_MESSAGES: Record<string, string> = {
  request_too_large: "That question is too long for AI Insights.",
  invalid_request: "AI Insights could not understand that request.",
  live_disabled: "Live AI is not enabled on this server. The calculated answer still applies.",
  live_unauthorized: "Live AI was not authorized for this request.",
  live_limit_reached: "The live test request limit for this server session has been reached.",
  meta_unavailable: "The AI model could not be reached. The calculated answer still applies.",
  not_found: "The AI Insights service was not found.",
  internal_error: "Something went wrong on the server.",
};

export interface BuckyAdviceOptions {
  mode?: "fallback" | "live";
  /** Runtime-supplied local live-test token; never hard-coded or stored. */
  liveTestToken?: string;
  /** Bounded recent turns (max 6) for conversational context. */
  history?: { role: "user" | "bucky"; text: string }[];
}

function isAdviceResponse(payload: unknown): payload is BuckyAdviceResponse {
  if (!payload || typeof payload !== "object") return false;
  const r = payload as Record<string, unknown>;
  return (
    (r.source === "meta-live" || r.source === "deterministic-fallback") &&
    (r.model === null || typeof r.model === "string") &&
    typeof r.answer === "string" &&
    typeof r.explanation === "string" &&
    Array.isArray(r.evidence) &&
    Array.isArray(r.suggestedActions) &&
    Array.isArray(r.limitations)
  );
}

/**
 * Ask the Bucky advisor. Defaults to the server's deterministic fallback
 * (labelled in the response). Live mode requires a runtime token and
 * fails before any network call without one — it never silently
 * downgrades a caller's explicit live request on the client side.
 */
export async function requestBuckyAdvice(
  question: string,
  summary: BuckyModelSummary,
  options: BuckyAdviceOptions = {},
): Promise<BuckyAdviceResponse> {
  const mode = options.mode ?? "fallback";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (mode === "live") {
    const token = options.liveTestToken;
    if (!token || token.trim().length === 0) {
      throw new BuckyApiError(
        "live_token_required",
        "Enter the live test token provided by the local server operator before requesting a live AI answer.",
      );
    }
    headers["x-bucketa-live-test"] = token;
  } else if (mode !== "fallback") {
    throw new BuckyApiError("invalid_request", "Choose fallback or live mode before asking Bucky.");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35_000);
  let response: Response;
  try {
    response = await fetch("/api/bucky/advise", {
      method: "POST",
      headers,
      body: JSON.stringify({ question, mode, summary, ...(options.history?.length ? { history: options.history.slice(-6) } : {}) }),
      signal: controller.signal,
    });
  } catch {
    throw new BuckyApiError("backend_offline", OFFLINE_MESSAGE);
  } finally {
    clearTimeout(timer);
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const code =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error: unknown }).error)
        : "";
    throw new BuckyApiError(code || "bucky_error", ERROR_MESSAGES[code] ?? GENERIC_MESSAGE, response.status);
  }
  if (!isAdviceResponse(payload)) {
    throw new BuckyApiError("invalid_response", GENERIC_MESSAGE);
  }
  return payload;
}

/**
 * Phase D — model-assisted interpretation client.
 *
 * Sends ONLY the user's request text plus the names of their real savings
 * goals and employees (no records, no amounts, no rates). The server-side
 * model can only return a structured proposal; the caller must still
 * cross-check it locally (buildActionFromModelProposal) and show the
 * standard preview before anything can be saved. Live-only: without an
 * explicit token this fails before any network call, and the
 * deterministic interpreter remains the fallback.
 */
export interface BuckyInterpretContext {
  profileName: string;
  profileKind: "personal" | "business";
  currency: string;
  bucketNames: string[];
  employeeNames: string[];
}

export interface BuckyInterpretProposal {
  kind: string;
  amountMinor: number;
  date: string;
  description: string | null;
  category: string | null;
  bucketName: string | null;
  employeeName: string | null;
  paymentType: "salary" | "bonus" | "advance" | null;
}

export interface BuckyInterpretResponse {
  source: "meta-live" | "deterministic";
  model: string | null;
  proposal: BuckyInterpretProposal | null;
  diagnostic?: { category: string; upstreamStatus: number | null; subReason?: string | null };
}

function isInterpretProposal(value: unknown): value is BuckyInterpretProposal {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  const nullableString = (v: unknown) => v === null || typeof v === "string";
  return (
    typeof p.kind === "string" &&
    Number.isSafeInteger(p.amountMinor) &&
    typeof p.date === "string" &&
    nullableString(p.description) &&
    nullableString(p.category) &&
    nullableString(p.bucketName) &&
    nullableString(p.employeeName) &&
    (p.paymentType === null || p.paymentType === "salary" || p.paymentType === "bonus" || p.paymentType === "advance")
  );
}

function isInterpretResponse(payload: unknown): payload is BuckyInterpretResponse {
  if (!payload || typeof payload !== "object") return false;
  const r = payload as Record<string, unknown>;
  return (
    (r.source === "meta-live" || r.source === "deterministic") &&
    (r.model === null || typeof r.model === "string") &&
    (r.proposal === null || isInterpretProposal(r.proposal))
  );
}

export async function requestBuckyInterpret(
  text: string,
  context: BuckyInterpretContext,
  options: { liveTestToken?: string } = {},
): Promise<BuckyInterpretResponse> {
  const token = options.liveTestToken;
  if (!token || token.trim().length === 0) {
    throw new BuckyApiError(
      "live_token_required",
      "Enter the live test token provided by the local server operator before requesting a live AI interpretation.",
    );
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35_000);
  let response: Response;
  try {
    response = await fetch("/api/bucky/interpret", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-bucketa-live-test": token },
      body: JSON.stringify({ text, mode: "live", context }),
      signal: controller.signal,
    });
  } catch {
    throw new BuckyApiError("backend_offline", OFFLINE_MESSAGE);
  } finally {
    clearTimeout(timer);
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const code =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error: unknown }).error)
        : "";
    throw new BuckyApiError(code || "bucky_error", ERROR_MESSAGES[code] ?? GENERIC_MESSAGE, response.status);
  }
  if (!isInterpretResponse(payload)) {
    throw new BuckyApiError("invalid_response", GENERIC_MESSAGE);
  }
  return payload;
}

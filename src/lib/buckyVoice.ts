/**
 * Bucky Voice (Phase 1) — browser speech helpers.
 *
 * Everything here uses only built-in browser APIs (Web Speech recognition
 * and speech synthesis). No paid APIs, no audio ever leaves the device
 * through Bucketa code, and the microphone is only ever started from an
 * explicit user tap (see BuckyPanel). This module holds the pure,
 * testable logic: capability detection, the voice state machine,
 * recognition-error wording, spoken-text preparation, and detection of
 * spoken action requests Bucky cannot execute yet.
 */

export type BuckyVoicePhase =
  | "idle"
  | "listening"
  | "review"
  | "processing"
  | "speaking"
  | "denied"
  | "unsupported"
  | "error";

export type BuckyVoiceEvent =
  | "start"
  | "heard" // user confirmed the reviewed transcript; process it
  | "review" // recognition finished; transcript awaits user confirmation
  | "speak"
  | "stop" // user stopped listening or speaking
  | "end" // recognition/synthesis finished naturally
  | "denied"
  | "unsupported"
  | "error"
  | "reset";

/** Pure voice state transitions — the panel drives these from API events. */
export function voiceTransition(phase: BuckyVoicePhase, event: BuckyVoiceEvent): BuckyVoicePhase {
  switch (event) {
    case "start":
      return "listening";
    case "heard":
      return phase === "listening" || phase === "review" || phase === "processing" ? "processing" : phase;
    case "review":
      return phase === "listening" || phase === "review" ? "review" : phase;
    case "speak":
      return "speaking";
    case "stop":
    case "end":
    case "reset":
      return "idle";
    case "denied":
      return "denied";
    case "unsupported":
      return "unsupported";
    case "error":
      return "error";
    default:
      return phase;
  }
}

/* --- Minimal structural types for the Web Speech API (not in TS DOM lib). --- */

export interface SpeechRecognitionAlternativeLike {
  transcript: string;
}
export interface SpeechRecognitionResultLike {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechRecognitionAlternativeLike;
}
export interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: { length: number; [index: number]: SpeechRecognitionResultLike };
}
export interface SpeechRecognitionErrorEventLike {
  error: string;
}
export interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

interface WindowWithSpeech {
  SpeechRecognition?: SpeechRecognitionCtor;
  webkitSpeechRecognition?: SpeechRecognitionCtor;
  speechSynthesis?: unknown;
}

/** The browser's SpeechRecognition constructor, or null when unsupported. */
export function getSpeechRecognitionCtor(win: unknown): SpeechRecognitionCtor | null {
  if (!win || typeof win !== "object") return null;
  const w = win as WindowWithSpeech;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function isSpeechRecognitionSupported(win: unknown): boolean {
  return getSpeechRecognitionCtor(win) !== null;
}

export function isSpeechSynthesisSupported(win: unknown): boolean {
  if (!win || typeof win !== "object") return false;
  const w = win as WindowWithSpeech & { SpeechSynthesisUtterance?: unknown };
  return typeof w.speechSynthesis === "object" && w.speechSynthesis !== null && typeof w.SpeechSynthesisUtterance === "function";
}

/** Split a recognition event into its final and interim transcript text. */
export function transcriptsFromEvent(event: SpeechRecognitionEventLike): { finalText: string; interimText: string } {
  let finalText = "";
  let interimText = "";
  for (let i = event.resultIndex; i < event.results.length; i += 1) {
    const result = event.results[i];
    const text = result?.[0]?.transcript ?? "";
    if (result?.isFinal) finalText += text;
    else interimText += text;
  }
  return { finalText: finalText.trim(), interimText: interimText.trim() };
}

/**
 * Accumulate final transcript segments in continuous mode without
 * duplicating text. Some browsers re-emit the same final segment (or a
 * growing prefix of it) across result events; naive concatenation would
 * repeat words. Empty segments never erase what was already heard.
 */
export function appendFinalTranscript(existing: string, next: string): string {
  const current = existing.trim();
  const segment = next.trim();
  if (!segment) return current;
  if (!current) return segment;
  if (current === segment || current.endsWith(segment)) return current;
  if (segment.startsWith(current)) return segment;
  return `${current} ${segment}`;
}

/** Upper bound on automatic restarts after an unexpected recognition end. */
export const MAX_RECOGNITION_RESTARTS = 3;

/**
 * Trailing silence after the last recognition result (interim or final)
 * before Bucky stops listening on its own and moves the transcript to
 * review. ~3 seconds feels like a natural end of speech while tolerating
 * short mid-sentence pauses. Done remains the manual fallback; reaching
 * this timeout never runs or saves anything by itself.
 */
export const SILENCE_TIMEOUT_MS = 3000;

/** Pure decision: has enough silence passed since the last result? */
export function hasSilenceElapsed(lastResultAt: number, now: number, thresholdMs = SILENCE_TIMEOUT_MS): boolean {
  if (!Number.isFinite(lastResultAt) || lastResultAt <= 0) return false;
  return now - lastResultAt >= thresholdMs;
}

/**
 * Whether a finished listening session may be interpreted automatically.
 * Only a clean settle with actual speech qualifies: after a recognition
 * error the transcript may be incomplete, so it must stay in review for
 * a manual Run; a cancelled session is never processed at all. Even when
 * this returns true, processing only *interprets* — every write still
 * needs the structured preview and an explicit Confirm.
 */
export function shouldAutoProcessTranscript(options: {
  heard: string;
  errorCode: string;
  cancelled: boolean;
}): boolean {
  return options.heard.trim().length > 0 && !options.errorCode && !options.cancelled;
}

/* --- Speech synthesis voice choice (built-in voices only). --- */

export interface SpeechVoiceLike {
  name: string;
  lang: string;
  default?: boolean;
  localService?: boolean;
}

/**
 * Picks the most natural-sounding already-installed English voice.
 * Browsers otherwise fall back to the OS default, which is often the
 * most robotic option. Ranking prefers voices marketed as
 * Natural/Neural, then well-known high-quality names, then any English
 * voice, then the browser default. Returns null when nothing matches —
 * the caller then leaves the utterance voice unset (browser default).
 * No external TTS service is involved.
 */
export function pickPreferredVoice(voices: readonly SpeechVoiceLike[]): SpeechVoiceLike | null {
  if (!voices.length) return null;
  const score = (voice: SpeechVoiceLike): number => {
    const name = voice.name.toLowerCase();
    const lang = voice.lang.toLowerCase();
    let points = 0;
    if (lang.startsWith("en")) points += 40; else return -1;
    if (lang === "en-us") points += 8;
    if (/natural|neural/.test(name)) points += 30;
    if (/google us english/.test(name)) points += 26;
    if (/samantha|zira|aria|jenny|guy/.test(name)) points += 18;
    if (/microsoft/.test(name)) points += 10;
    if (voice.localService) points += 2;
    if (voice.default) points += 1;
    return points;
  };
  let best: SpeechVoiceLike | null = null;
  let bestScore = -1;
  for (const voice of voices) {
    const points = score(voice);
    if (points > bestScore) {
      best = voice;
      bestScore = points;
    }
  }
  return bestScore >= 0 ? best : null;
}

/**
 * Whether an unexpectedly ended recognition session may restart.
 * Never restarts after an explicit stop/cancel, after an error or
 * permission denial, or once the bounded restart budget is spent — this
 * is what prevents restart loops in continuous mode.
 */
export function canRestartRecognition(options: {
  cancelled: boolean;
  stopRequested: boolean;
  errorCode: string;
  restarts: number;
}): boolean {
  if (options.cancelled || options.stopRequested) return false;
  if (options.errorCode) return false;
  return options.restarts < MAX_RECOGNITION_RESTARTS;
}

/** Clear, safe wording for recognition failures. "aborted" is a user stop. */
export function speechRecognitionErrorMessage(code: string): { message: string; phase: BuckyVoicePhase } {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return {
        message: "Microphone access was denied. Allow microphone permission in your browser settings, then tap the microphone again.",
        phase: "denied",
      };
    case "audio-capture":
      return { message: "No microphone was found. Connect one, or type your question instead.", phase: "error" };
    case "no-speech":
      return { message: "I didn't hear anything. Tap the microphone and try again, or type your question.", phase: "error" };
    case "network":
      return { message: "Speech recognition needs a network connection in this browser. Type your question instead.", phase: "error" };
    case "language-not-supported":
      return { message: "English speech recognition isn't available in this browser. Type your question instead.", phase: "error" };
    case "aborted":
      return { message: "", phase: "idle" };
    default:
      return { message: "Speech recognition ran into a problem. Type your question instead.", phase: "error" };
  }
}

const ACTION_PATTERN =
  /\b(add|record|pay|paid|transfer|move|deposit|withdraw|delete|remove|create|save|send|buy|sell)\b[^.?!]*\b(to|for|from|₱|php|peso|pesos|\d)/i;
const QUESTION_PATTERN = /^(how|what|why|when|which|do|does|did|is|are|can|could|give|show|tell)\b/i;

/**
 * Spoken/typed requests that ask Bucky to *change* financial data in ways
 * the bookkeeping action pipeline does not support (deletes, edits,
 * withdrawals, transfers, creating goals/employees, …). Supported writes —
 * recording income/expenses, adding to a named savings goal, and recording
 * a salary payment as a business expense — are interpreted by
 * buckyActions.ts and always require a preview plus explicit confirmation;
 * everything trapped here must be answered honestly, never pretended
 * completed. Savings-goal questions like "How is my savings goal doing?"
 * are questions, not actions, and must not be trapped here.
 */
export function detectUnsupportedAction(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (QUESTION_PATTERN.test(t) && !/\b(add|record|pay|transfer|deposit|withdraw|delete)\b/i.test(t)) return false;
  if (/how is my savings/i.test(t)) return false;
  if (/\b(delete|remove)\b/i.test(t)) return true;
  return ACTION_PATTERN.test(t);
}

export const UNSUPPORTED_ACTION_ANSWER =
  "I can't do that one yet. I can record income or an expense, add a contribution to an existing savings goal, or record a salary payment as a business expense — always with a preview you confirm first, and nothing is saved before that. " +
  "For anything else, use Personal Finance or Business records, or the Bucky Record Scanner, where you review and confirm every entry before anything is saved.";

/**
 * Prepare an answer for speech: plain, short, and read only after a
 * user-initiated voice question or an explicit Listen tap. Long answers
 * are cut at a sentence boundary so speech stays brief; the full answer
 * always remains visible as text.
 */
export function prepareSpeechText(answer: string, facts: { label: string; value: string }[] = [], maxLength = 340): string {
  const factText = facts.slice(0, 2).map((f) => `${f.label}: ${f.value}.`).join(" ");
  let text = `${answer.trim()} ${factText}`.replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength);
  const sentenceEnd = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  text = sentenceEnd > 80 ? cut.slice(0, sentenceEnd + 1) : `${cut.trim()}…`;
  return text;
}

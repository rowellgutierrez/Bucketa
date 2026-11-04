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
  onstart?: (() => void) | null;
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
 * A clean settle with actual speech qualifies, and so does a settle
 * whose only error is benign ("no-speech" / "aborted"): browsers fire
 * those *after* final speech was already captured (trailing silence,
 * session teardown), and treating them as failures stranded finished
 * messages unsent. After a genuine recognition error
 * (network, audio-capture, permission, …) the transcript may be
 * incomplete, so it is discarded — never auto-run and never parked in
 * a manual review step; the user simply speaks again. A cancelled
 * session is never processed at all. Even when this returns true,
 * processing only *interprets* — every write still needs the
 * structured preview and an explicit Confirm.
 */
export function shouldAutoProcessTranscript(options: {
  heard: string;
  errorCode: string;
  cancelled: boolean;
}): boolean {
  if (options.heard.trim().length === 0 || options.cancelled) return false;
  return options.errorCode === "" || options.errorCode === "no-speech" || options.errorCode === "aborted";
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
/**
 * Bucky's single voice personality: warm, friendly, slightly animated but
 * professional. Applied on top of the user's volume setting as a subtle
 * clamp — never squeaky or cartoonish. Browser voices differ per device,
 * so this only nudges rate/pitch; it cannot make voices identical.
 */
export function buckyUtteranceTuning(settings: { rate: number; pitch: number }): { rate: number; pitch: number } {
  const clamp = (v: number, min: number, max: number, fallback: number) =>
    Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  return {
    rate: clamp(settings.rate, 0.95, 1.05, 1.0),
    pitch: clamp(settings.pitch, 1.15, 1.25, 1.2),
  };
}

export function pickPreferredVoice(voices: readonly SpeechVoiceLike[]): SpeechVoiceLike | null {
  if (!voices.length) return null;
  const score = (voice: SpeechVoiceLike): number => {
    const name = voice.name.toLowerCase();
    const lang = voice.lang.toLowerCase();
    let points = 0;
    if (lang.startsWith("en")) points += 40; else return -1;
    if (lang === "en-us") points += 8;
    if (/natural|neural/.test(name)) points += 30;
    if (/neutral|androgynous/.test(name)) points += 20;
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
      return { message: "The selected speech language isn't supported by this browser. Choose English or type your question instead.", phase: "error" };
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

/** Start capture only after completed speech and a short quiet gap; cancellation invalidates the queued callback. */
export function queueAfterSpeech(isCurrent:()=>boolean,run:()=>void,schedule:(callback:()=>void,delay:number)=>unknown){
 if(!isCurrent())return;
 schedule(()=>{if(isCurrent())run();},250);
}

/* --- Echo prevention & turn-taking (Phase A hardening) --- */

function normalizeSpeech(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * True when a recognised transcript is very likely Bucky's own spoken
 * output leaking back through the speakers. Recognition is paused while
 * Bucky speaks, so this is a second line of defence: a transcript that
 * substantially overlaps the last spoken text must never be processed
 * as a new user turn.
 */
export function isEchoOfSpeech(transcript: string, lastSpoken: string): boolean {
  const heard = normalizeSpeech(transcript);
  const spoken = normalizeSpeech(lastSpoken);
  if (!heard || !spoken) return false;
  if (heard === spoken) return true;
  if (spoken.includes(heard) && heard.length >= 12) return true;
  if (heard.includes(spoken) && spoken.length >= 12) return true;
  const heardWords = new Set(heard.split(" "));
  const spokenWords = spoken.split(" ").filter(Boolean);
  if (spokenWords.length < 4 || heardWords.size < 3) return false;
  const overlap = spokenWords.filter((w) => heardWords.has(w)).length / spokenWords.length;
  return overlap >= 0.85 && heard.length >= 12;
}

/**
 * Barge-in decision. Full-duplex interruption is NOT claimed: the Web
 * Speech API gives no reliable echo-cancelled stream while synthesis is
 * playing, so Bucketa only interrupts when the browser still delivered a
 * confident final transcript that is not Bucky's own voice. In practice
 * recognition is paused during speech, so interruption usually means the
 * user taps Stop or finishes speaking first — documented limitation.
 */
export function shouldInterruptSpeech(options: { transcript: string; lastSpoken: string; isFinal: boolean }): boolean {
  if (!options.isFinal) return false;
  if (options.transcript.trim().length < 3) return false;
  return !isEchoOfSpeech(options.transcript, options.lastSpoken);
}

/** User-facing label for each voice phase (Listening/Thinking/Speaking/Error). */
export function voicePhaseLabel(phase: BuckyVoicePhase, micPending = false): string {
  if (micPending) return "Starting microphone";
  switch (phase) {
    case "listening": return "Listening";
    case "processing": return "Thinking";
    case "speaking": return "Speaking";
    case "review": return "Review what I heard";
    case "denied": return "Microphone blocked";
    case "unsupported": return "Voice unavailable";
    case "error": return "Voice error";
    default: return "Ready";
  }
}

/** Session cancellation/re-arm guard only; capture and playback remain in the shared panel. */
export function createContinuousVoiceSession(schedule:(callback:()=>void,delay:number)=>number,clear:(id:number)=>void){
 let active=false,generation=0,timer:number|undefined,silentRetries=0;
 const stop=()=>{active=false;generation++;if(timer!==undefined)clear(timer);timer=undefined;};
 const resume=(ready:()=>boolean,listen:()=>void)=>{
  if(!active)return;
  if(timer!==undefined)clear(timer);
  const token=generation;
  timer=schedule(()=>{timer=undefined;if(active&&generation===token&&ready())listen();},250);
 };
 return{start(){stop();active=true;silentRetries=0;},stop,isActive:()=>active,resume,heard(){silentRetries=0;},silentEnd(ready:()=>boolean,listen:()=>void){if(!active)return false;if(++silentRetries>2){stop();return false;}resume(ready,listen);return true;}};
}

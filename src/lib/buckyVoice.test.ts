import assert from "node:assert/strict";
import test from "node:test";
import {
  appendFinalTranscript,
  buckyUtteranceTuning,
  canRestartRecognition,
  hasSilenceElapsed,
  pickPreferredVoice,
  shouldAutoProcessTranscript,
  SILENCE_TIMEOUT_MS,
  detectUnsupportedAction,
  getSpeechRecognitionCtor,
  isSpeechRecognitionSupported,
  isSpeechSynthesisSupported,
  MAX_RECOGNITION_RESTARTS,
  prepareSpeechText,
  speechRecognitionErrorMessage,
  transcriptsFromEvent,
  voiceTransition,
} from "./buckyVoice.ts";

test("voice state machine covers listening, processing, speaking, and stop", () => {
  assert.equal(voiceTransition("idle", "start"), "listening");
  assert.equal(voiceTransition("listening", "heard"), "processing");
  assert.equal(voiceTransition("processing", "speak"), "speaking");
  assert.equal(voiceTransition("speaking", "end"), "idle");
  assert.equal(voiceTransition("speaking", "stop"), "idle");
  assert.equal(voiceTransition("listening", "stop"), "idle");
  assert.equal(voiceTransition("idle", "heard"), "idle"); // stray results never process
  assert.equal(voiceTransition("listening", "denied"), "denied");
  assert.equal(voiceTransition("idle", "unsupported"), "unsupported");
});

test("capability detection finds standard and webkit constructors", () => {
  class FakeRecognition {}
  assert.equal(getSpeechRecognitionCtor({ SpeechRecognition: FakeRecognition }), FakeRecognition);
  assert.equal(getSpeechRecognitionCtor({ webkitSpeechRecognition: FakeRecognition }), FakeRecognition);
  assert.equal(getSpeechRecognitionCtor({}), null);
  assert.equal(getSpeechRecognitionCtor(null), null);
  assert.equal(isSpeechRecognitionSupported({ webkitSpeechRecognition: FakeRecognition }), true);
  assert.equal(isSpeechRecognitionSupported({}), false);
  assert.equal(isSpeechSynthesisSupported({ speechSynthesis: {}, SpeechSynthesisUtterance: class {} }), true);
  assert.equal(isSpeechSynthesisSupported({ speechSynthesis: {} }), false);
  assert.equal(isSpeechSynthesisSupported({}), false);
});

test("transcripts split final text from interim text", () => {
  const event = {
    resultIndex: 0,
    results: {
      length: 2,
      0: { isFinal: false, length: 1, 0: { transcript: "how is my" } },
      1: { isFinal: true, length: 1, 0: { transcript: " savings goal doing" } },
    },
  };
  assert.deepEqual(transcriptsFromEvent(event), {
    finalText: "savings goal doing",
    interimText: "how is my",
  });
});

test("recognition errors map to safe phases and wording", () => {
  assert.equal(speechRecognitionErrorMessage("not-allowed").phase, "denied");
  assert.match(speechRecognitionErrorMessage("not-allowed").message, /denied/i);
  assert.equal(speechRecognitionErrorMessage("service-not-allowed").phase, "denied");
  assert.equal(speechRecognitionErrorMessage("aborted").phase, "idle");
  assert.equal(speechRecognitionErrorMessage("aborted").message, "");
  assert.equal(speechRecognitionErrorMessage("no-speech").phase, "error");
  assert.equal(speechRecognitionErrorMessage("something-else").phase, "error");
});

test("spoken action requests are detected; savings questions are not trapped", () => {
  assert.equal(detectUnsupportedAction("Add 1000 pesos to my iPhone savings goal"), true);
  assert.equal(detectUnsupportedAction("Record Roger's 1000 salary payment for November 1"), true);
  assert.equal(detectUnsupportedAction("Delete that duplicate expense"), true);
  assert.equal(detectUnsupportedAction("How is my savings goal doing?"), false);
  assert.equal(detectUnsupportedAction("Why are my expenses increasing?"), false);
  assert.equal(detectUnsupportedAction("How much POS revenue did I make?"), false);
  assert.equal(detectUnsupportedAction("What is low on stock?"), false);
  assert.equal(detectUnsupportedAction(""), false);
});

test("speech text is short, plain, and includes at most two facts", () => {
  const text = prepareSpeechText("Your expenses rose this month.", [
    { label: "This month expenses", value: "PHP 500.00" },
    { label: "Last month expenses", value: "PHP 300.00" },
    { label: "Ignored", value: "PHP 1.00" },
  ]);
  assert.match(text, /expenses rose/);
  assert.match(text, /This month expenses: PHP 500\.00\./);
  assert.doesNotMatch(text, /Ignored/);

  const long = prepareSpeechText(`${"This is a grounded sentence. ".repeat(30)}`);
  assert.ok(long.length <= 345, `expected a trimmed utterance, got ${long.length} chars`);
  assert.ok(long.endsWith(".") || long.endsWith("…"));
});

test("final transcript accumulation joins segments without duplicating them", () => {
  assert.equal(appendFinalTranscript("", "record 500"), "record 500");
  assert.equal(appendFinalTranscript("record 500", "for groceries"), "record 500 for groceries");
  // Browsers may re-emit the same final segment or a growing prefix.
  assert.equal(appendFinalTranscript("record 500", "record 500"), "record 500");
  assert.equal(appendFinalTranscript("record", "record 500 for groceries"), "record 500 for groceries");
  assert.equal(appendFinalTranscript("record 500", ""), "record 500");
  assert.equal(appendFinalTranscript("", ""), "");
});

test("review step gates processing: heard only processes from review/listening", () => {
  assert.equal(voiceTransition("listening", "review"), "review");
  assert.equal(voiceTransition("review", "heard"), "processing");
  assert.equal(voiceTransition("review", "reset"), "idle");
  assert.equal(voiceTransition("idle", "review"), "idle"); // stray ends never open review
});

test("recognition restart is bounded and never after stop, cancel, or error", () => {
  const base = { cancelled: false, stopRequested: false, errorCode: "", restarts: 0 };
  assert.equal(canRestartRecognition(base), true);
  assert.equal(canRestartRecognition({ ...base, restarts: MAX_RECOGNITION_RESTARTS - 1 }), true);
  assert.equal(canRestartRecognition({ ...base, restarts: MAX_RECOGNITION_RESTARTS }), false);
  assert.equal(canRestartRecognition({ ...base, cancelled: true }), false);
  assert.equal(canRestartRecognition({ ...base, stopRequested: true }), false);
  assert.equal(canRestartRecognition({ ...base, errorCode: "not-allowed" }), false);
  assert.equal(canRestartRecognition({ ...base, errorCode: "network" }), false);
});

test("trailing silence ends listening only after the full quiet window", () => {
  assert.equal(SILENCE_TIMEOUT_MS, 3000);
  const t0 = 100_000;
  assert.equal(hasSilenceElapsed(t0, t0 + SILENCE_TIMEOUT_MS - 1), false);
  assert.equal(hasSilenceElapsed(t0, t0 + SILENCE_TIMEOUT_MS), true);
  assert.equal(hasSilenceElapsed(t0, t0 + SILENCE_TIMEOUT_MS + 5000), true);
  // No result yet (or a cleared timestamp) never auto-finishes.
  assert.equal(hasSilenceElapsed(0, t0 + SILENCE_TIMEOUT_MS + 5000), false);
  assert.equal(hasSilenceElapsed(Number.NaN, t0 + SILENCE_TIMEOUT_MS + 5000), false);
});

test("auto-processing after speech requires a clean, non-cancelled settle", () => {
  assert.equal(shouldAutoProcessTranscript({ heard: "record 500 expense", errorCode: "", cancelled: false }), true);
  // After an error the transcript may be incomplete: review only, never auto-run.
  assert.equal(shouldAutoProcessTranscript({ heard: "record 500", errorCode: "network", cancelled: false }), false);
  assert.equal(shouldAutoProcessTranscript({ heard: "record 500", errorCode: "no-speech", cancelled: false }), false);
  assert.equal(shouldAutoProcessTranscript({ heard: "record 500", errorCode: "", cancelled: true }), false);
  assert.equal(shouldAutoProcessTranscript({ heard: "   ", errorCode: "", cancelled: false }), false);
  assert.equal(shouldAutoProcessTranscript({ heard: "", errorCode: "", cancelled: false }), false);
});

test("Bucky voice tuning stays warm and subtle, never squeaky", () => {
  assert.deepEqual(buckyUtteranceTuning({ rate: 0.95, pitch: 1.05 }), { rate: 0.95, pitch: 1.05 });
  assert.deepEqual(buckyUtteranceTuning({ rate: 1.5, pitch: 1.5 }), { rate: 1.02, pitch: 1.12 });
  assert.deepEqual(buckyUtteranceTuning({ rate: 0.5, pitch: 0.5 }), { rate: 0.9, pitch: 1.0 });
  assert.deepEqual(buckyUtteranceTuning({ rate: Number.NaN, pitch: Number.NaN }), { rate: 0.95, pitch: 1.05 });
});

test("preferred synthesis voice ranks natural English voices first", () => {
  const voices = [
    { name: "Microsoft David - English (United States)", lang: "en-US", localService: true },
    { name: "Microsoft Aria Online (Natural) - English (United States)", lang: "en-US" },
    { name: "Deutsch Stimme", lang: "de-DE" },
  ];
  assert.equal(pickPreferredVoice(voices)?.name, voices[1].name);
  assert.equal(pickPreferredVoice([{ name: "Google US English", lang: "en-US" }, { name: "Microsoft David", lang: "en-US", localService: true }])?.name, "Google US English");
  assert.equal(pickPreferredVoice([{ name: "Voix française", lang: "fr-FR" }]), null);
  assert.equal(pickPreferredVoice([]), null);
});

 test('unsupported recognition languages offer a safe language or typing fallback',()=>{
  const result=speechRecognitionErrorMessage('language-not-supported');
  assert.equal(result.phase,'error');assert.match(result.message,/selected speech language/);
 });

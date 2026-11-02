import {
  DEFAULT_VOICE_SETTINGS,
  VOICE_SETTINGS_KEY,
  loadVoiceSettings,
  saveVoiceSettings,
} from "./buckyVoiceSettings.ts";

const assert: {
  equal(a: unknown, b: unknown): void;
  deepEqual(a: unknown, b: unknown): void;
} = (await import("node:" + "assert/strict")).default;
const test: (name: string, body: () => void) => void = (await import("node:" + "test")).default;

const store = new Map<string, string>();
const listeners = new Map<string, Set<(event: unknown) => void>>();
(globalThis as { window?: unknown }).window = {
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  },
  addEventListener: (name: string, fn: (event: unknown) => void) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name)!.add(fn);
  },
  removeEventListener: (name: string, fn: (event: unknown) => void) => {
    listeners.get(name)?.delete(fn);
  },
  dispatchEvent: (event: { type: string }) => {
    for (const fn of listeners.get(event.type) ?? []) fn(event);
    return true;
  },
};

test("legacy stored preferences keep working and gain the responses default", () => {
  store.clear();
  // Exactly what earlier Bucky versions wrote: no responsesOn field.
  store.set(VOICE_SETTINGS_KEY, JSON.stringify({ volume: 0.5, rate: 1.2, pitch: 0.8 }));
  assert.deepEqual(loadVoiceSettings(), {
    language: "en-US",
    volume: 0.5,
    rate: 1.2,
    pitch: 0.8,
    responsesOn: true,
  });
});

test("settings round-trip through the same storage key, clamped to range", () => {
  store.clear();
  saveVoiceSettings({ volume: 0.25, rate: 1.5, pitch: 0.5, responsesOn: false });
  assert.deepEqual(loadVoiceSettings(), {
    language: "en-US",
    volume: 0.25,
    rate: 1.5,
    pitch: 0.5,
    responsesOn: false,
  });
  store.set(VOICE_SETTINGS_KEY, JSON.stringify({ volume: 9, rate: 0, pitch: -1, responsesOn: "yes" }));
  assert.deepEqual(loadVoiceSettings(), { ...DEFAULT_VOICE_SETTINGS, volume: 1, rate: 0.5, pitch: 0.5 });
});

test("defaults apply when nothing is stored", () => {
  store.clear();
  assert.deepEqual(loadVoiceSettings(), DEFAULT_VOICE_SETTINGS);
});

 test("Filipino input preference persists and unsupported language codes fall back safely", () => {
   store.clear(); saveVoiceSettings({...DEFAULT_VOICE_SETTINGS,language:'fil-PH'});
   assert.equal(loadVoiceSettings().language,'fil-PH');
   store.set(VOICE_SETTINGS_KEY,JSON.stringify({...DEFAULT_VOICE_SETTINGS,language:'unsupported'}));
   assert.equal(loadVoiceSettings().language,'en-US');
 });

/** Shared Bucky voice preferences (browser TTS only, never a paid speech API).
 * Stored under the original localStorage key so existing users keep their
 * tuning. Settings and BuckyPanel both read/write through here; a same-tab
 * event plus the cross-tab `storage` event keep open views in sync without
 * a page reload. */

export type BuckySpeechLanguage = "en-US" | "fil-PH";

export interface VoiceSettings {
  /** Recognition language; answers currently remain in English. */
  language?: BuckySpeechLanguage;
  /** 0–1 */
  volume: number;
  /** 0.5–1.5 multiplier */
  rate: number;
  /** 0.5–1.5 multiplier */
  pitch: number;
  /** Whether Bucky speaks answers aloud. */
  responsesOn: boolean;
}

export const VOICE_SETTINGS_KEY = "bucketa.buckyVoiceSettings";
export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  language: "en-US",
  volume: 0.9,
  rate: 1.0,
  pitch: 1.2,
  responsesOn: true,
};

const CHANGE_EVENT = "bucketa:bucky-voice-settings-changed";

function clampVoice(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

export function loadVoiceSettings(): VoiceSettings {
  try {
    const raw = window.localStorage.getItem(VOICE_SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_VOICE_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<VoiceSettings>;
    return {
      language: parsed.language === "fil-PH" ? "fil-PH" : "en-US",
      volume: clampVoice(parsed.volume, 0, 1, DEFAULT_VOICE_SETTINGS.volume),
      rate: clampVoice(parsed.rate, 0.5, 1.5, DEFAULT_VOICE_SETTINGS.rate),
      pitch: clampVoice(parsed.pitch, 0.5, 1.5, DEFAULT_VOICE_SETTINGS.pitch),
      responsesOn:
        typeof parsed.responsesOn === "boolean"
          ? parsed.responsesOn
          : DEFAULT_VOICE_SETTINGS.responsesOn,
    };
  } catch {
    return { ...DEFAULT_VOICE_SETTINGS };
  }
}

export function saveVoiceSettings(settings: VoiceSettings): void {
  try {
    window.localStorage.setItem(VOICE_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage unavailable (private mode, blocked): settings still apply
    // for this session via the change event below.
  }
  try {
    window.dispatchEvent(new CustomEvent<VoiceSettings>(CHANGE_EVENT, { detail: settings }));
  } catch {
    // Non-browser environment; nothing to notify.
  }
}

/** Subscribe to preference changes (same-tab and cross-tab). Returns unsubscribe. */
export function onVoiceSettingsChanged(listener: (settings: VoiceSettings) => void): () => void {
  const onCustom = (event: Event) => {
    const detail = (event as CustomEvent<VoiceSettings>).detail;
    listener(detail ?? loadVoiceSettings());
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === VOICE_SETTINGS_KEY) listener(loadVoiceSettings());
  };
  window.addEventListener(CHANGE_EVENT, onCustom);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onCustom);
    window.removeEventListener("storage", onStorage);
  };
}

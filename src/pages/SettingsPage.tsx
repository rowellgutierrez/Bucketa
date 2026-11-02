import { useEffect, useState } from "react";
import PageHeader from "../components/ui/PageHeader";
import Card from "../components/ui/Card";
import {
  DEFAULT_VOICE_SETTINGS,
  loadVoiceSettings,
  onVoiceSettingsChanged,
  saveVoiceSettings,
  type VoiceSettings,
} from "../lib/buckyVoiceSettings";

export default function SettingsPage() {
  const [voice, setVoice] = useState<VoiceSettings>(() => loadVoiceSettings());

  // Stay in sync if Bucky's own Voice on/off toggle changes the same
  // preferences while this page is open (and vice versa).
  useEffect(
    () =>
      onVoiceSettingsChanged((next) => {
        setVoice(next);
      }),
    [],
  );

  function update(patch: Partial<VoiceSettings>) {
    setVoice((prev) => {
      const next = { ...prev, ...patch };
      saveVoiceSettings(next);
      return next;
    });
  }

  return (
    <section className="page settings-page">
      <PageHeader
        className="workspace-page-header"
        eyebrow="GENERAL"
        title="Settings"
        description="Preferences for Bucketa on this device."
      />

      <Card className="settings-card" aria-labelledby="bucky-voice-heading">
        <h2 id="bucky-voice-heading">Bucky &amp; Voice</h2>
        <p className="muted">
          Bucky uses your browser's built-in speech — no paid speech service.
          Changes save automatically on this device and apply the next time
          Bucky speaks, without reloading the page. Some browsers ignore
          pitch or volume.
        </p>

        <div className="settings-row">
          <div>
            <strong>Voice responses</strong>
            <p className="field-hint">Bucky speaks answers aloud after voice questions and Listen taps.</p>
          </div>
          <button
            className="btn ghost"
            type="button"
            aria-pressed={voice.responsesOn}
            onClick={() => update({ responsesOn: !voice.responsesOn })}
          >
            {voice.responsesOn ? "On" : "Off"}
          </button>
        </div>

        <div className="settings-sliders">
          <label htmlFor="settings-voice-volume">
            <span>Volume <output htmlFor="settings-voice-volume">{Math.round(voice.volume * 100)}%</output></span>
            <input
              id="settings-voice-volume"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={voice.volume}
              aria-valuetext={`${Math.round(voice.volume * 100)} percent`}
              onChange={(e) => update({ volume: Number(e.target.value) })}
            />
          </label>
          <label htmlFor="settings-voice-speed">
            <span>Speed <output htmlFor="settings-voice-speed">{voice.rate.toFixed(2)}×</output></span>
            <input
              id="settings-voice-speed"
              type="range"
              min={0.5}
              max={1.5}
              step={0.05}
              value={voice.rate}
              aria-valuetext={`${voice.rate.toFixed(2)} times normal speed`}
              onChange={(e) => update({ rate: Number(e.target.value) })}
            />
          </label>
          <label htmlFor="settings-voice-pitch">
            <span>Pitch <output htmlFor="settings-voice-pitch">{voice.pitch.toFixed(2)}×</output></span>
            <input
              id="settings-voice-pitch"
              type="range"
              min={0.5}
              max={1.5}
              step={0.05}
              value={voice.pitch}
              aria-valuetext={`${voice.pitch.toFixed(2)} times normal pitch`}
              onChange={(e) => update({ pitch: Number(e.target.value) })}
            />
          </label>
        </div>

        <div className="row-actions">
          <button
            className="btn ghost"
            type="button"
            onClick={() => update({ ...DEFAULT_VOICE_SETTINGS })}
          >
            Reset voice settings
          </button>
          <a className="btn ghost" href="#/dashboard">Open Bucky on Home</a>
        </div>
      </Card>
    </section>
  );
}

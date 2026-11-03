import { useEffect, useState, useSyncExternalStore } from "react";
import PageHeader from "../components/ui/PageHeader";
import Card from "../components/ui/Card";
import DemoWorkspace from "../components/DemoWorkspace";
import {
  DEFAULT_VOICE_SETTINGS,
  loadVoiceSettings,
  onVoiceSettingsChanged,
  saveVoiceSettings,
  type VoiceSettings,
} from "../lib/buckyVoiceSettings";
import { loadOwnerProfile, onOwnerProfileChanged, saveOwnerProfile, type OwnerProfile } from "../lib/ownerProfile";
import { getBuckyLiveSettings, subscribeBuckyLiveSettings, updateBuckyLiveSettings } from "../lib/buckyLiveSettings";

export default function SettingsPage() {
  const [voice, setVoice] = useState<VoiceSettings>(() => loadVoiceSettings());
  // Bucky live Meta AI: memory-only shared state (buckyLiveSettings).
  // Neither the toggle nor the token is ever persisted on this device.
  const live = useSyncExternalStore(subscribeBuckyLiveSettings, getBuckyLiveSettings, getBuckyLiveSettings);
  const [owner, setOwner] = useState<OwnerProfile>(() => loadOwnerProfile());
  useEffect(() => onOwnerProfileChanged(setOwner), []);
  function updateOwner(patch: Partial<OwnerProfile>) {
    setOwner((prev) => saveOwnerProfile({ ...prev, ...patch }));
  }

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

      <Card className="settings-card" aria-labelledby="owner-profile-heading">
        <div className="settings-section-head"><h2 id="owner-profile-heading">Owner Profile</h2><p className="muted">Your name lives only on this device (browser storage). It never changes business records, currencies, or profiles in your database.</p></div>
        <div className="settings-fields">
          <div className="field"><label htmlFor="owner-first-name">First name</label><input id="owner-first-name" className="input" value={owner.firstName} onChange={(e) => updateOwner({ firstName: e.target.value })} autoComplete="given-name" placeholder="e.g. Maria" /></div>
          <div className="field"><label htmlFor="owner-last-name">Last name</label><input id="owner-last-name" className="input" value={owner.lastName} onChange={(e) => updateOwner({ lastName: e.target.value })} autoComplete="family-name" placeholder="e.g. Santos" /></div>
        </div>
        <div className="settings-row">
          <div><strong>Greeting on Home</strong><p className="field-hint">Home says hello using your first name.</p></div>
          <button className="btn ghost settings-toggle" type="button" aria-pressed={owner.showGreeting} onClick={() => updateOwner({ showGreeting: !owner.showGreeting })}>{owner.showGreeting ? "On" : "Off"}</button>
        </div>
      </Card>

      <Card className="settings-card" aria-labelledby="bucky-voice-heading">
        <div className="settings-section-head"><h2 id="bucky-voice-heading">Bucky &amp; Voice</h2>
        <p className="muted">
          Voice preferences save automatically on this device. Your browser
          controls voice availability and may ignore pitch or volume.
        </p></div>

        <div className="settings-row">
          <div>
            <strong>Live Meta AI for Bucky</strong>
            <p className="field-hint">Off by default. When on, ordinary Bucky questions (typed or spoken) are answered by the live Meta model through Bucketa's gated server — one request per question, sharing the server's limit of 3 live requests per server session across Bucky, the Scanner, and Creative Studio. When off, Bucky answers deterministically from your recorded data and no paid request is made.</p>
          </div>
          <button
            className="btn ghost settings-toggle"
            type="button"
            aria-pressed={live.enabled}
            onClick={() => updateBuckyLiveSettings({ enabled: !live.enabled })}
          >
            {live.enabled ? "On" : "Off"}
          </button>
        </div>

        {live.enabled && (
          <div className="settings-row settings-row-control">
            <div>
              <label htmlFor="bucky-live-token-setting"><strong>Live test token</strong></label>
              <p className="field-hint">From the local server operator. Kept only in this app's memory for this session — never saved to this device, and cleared when the app reloads. Bucky cannot send live requests without it.</p>
            </div>
            <input
              id="bucky-live-token-setting"
              className="input settings-control"
              type="password"
              autoComplete="off"
              value={live.token}
              onChange={(e) => updateBuckyLiveSettings({ token: e.target.value })}
              placeholder="Token from the local server operator"
            />
          </div>
        )}

        <div className="settings-row">
          <div>
            <strong>Voice responses</strong>
            <p className="field-hint">Bucky speaks answers aloud after voice questions and Listen taps.</p>
          </div>
          <button
            className="btn ghost settings-toggle"
            type="button"
            aria-pressed={voice.responsesOn}
            onClick={() => update({ responsesOn: !voice.responsesOn })}
          >
            {voice.responsesOn ? "On" : "Off"}
          </button>
        </div>

        <div className="settings-row settings-row-control"><div><label htmlFor="settings-speech-language"><strong>Speech input language</strong></label>
          <p className="field-hint">Availability depends on your browser. Bucky's written and spoken answers currently use English.</p></div>
          <select id="settings-speech-language" className="input settings-control" value={voice.language ?? 'en-US'} onChange={event => update({language: event.target.value as 'en-US' | 'fil-PH'})}><option value="en-US">English</option><option value="fil-PH">Filipino / Tagalog</option></select>
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
      <DemoWorkspace/>
      <Card className="help-guide" aria-labelledby="help-guide-heading">
        <h2 id="help-guide-heading">Help &amp; Guide</h2>
        <p className="muted">A quick guide to your workspace. Financial records stay in this browser, separated by profile and currency.</p>
        <details><summary>Business profiles &amp; Home</summary><p>Create, rename, or switch businesses in Buckets. Home lets you filter Personal, Business, or All activity and choose dates. Income minus expenses is recorded net cash flow, not profit or a bank balance. Currencies are never combined. Use See more for the matching transaction history; POS receipts and sales remain in Sales / POS.</p><a href="#/buckets">Open business profiles</a></details>
        <details><summary>Personal Finance &amp; savings goals</summary><p>Create a personal profile, record income or expenses, and use savings buckets to track goals. Savings deposits and withdrawals are records of money set aside; they are not income or expenses. Bucketa does not move money or connect to bank accounts.</p><a href="#/personal">Open Personal Finance</a></details>
        <details><summary>Business Buckets</summary><p>Savings tracks money set aside, Budget organizes planned spending, and Allocated marks money assigned to a purpose. Keep each within the selected business. Check each bucket's currency before assigning records. Goal progress uses the records assigned to that bucket, in its own currency.</p><a href="#/buckets">Open Buckets</a></details>
        <details><summary>Transactions &amp; history</summary><p>Use business selection, dates, and available filters to find records. Full history is read-only; normal business management offers Edit and Delete where allowed. Savings and protected records retain their own rules. Scanner corrections keep the original profile, currency, and bucket.</p><a href="#/transactions">Open Transactions</a></details>
        <details><summary>Products, inventory &amp; Smart Scan</summary><p>Register products with price, currency, and stock. SKU and barcode help identify each item. Generated BKT- codes are internal store codes, not official GS1 registration. Preview or print labels from the product list. Product-photo analysis proposes editable visual details; you supply price and stock and confirm saving.</p><p>Smart Scan uses native browser barcode detection where supported. Grant rear-camera access on HTTPS or localhost and point at a clear barcode. Manual entry remains available when detection is unsupported. After a detection, tap Scan again before the next camera scan. Manual barcode entry is still available. Always review cart quantities.</p><a href="#/products">Open Products &amp; Inventory</a></details>
        <details><summary>Sales / POS</summary><p>Select the correct business and add products manually or with Smart Scan. Scanning changes only the cart. Review quantities, payment received, and the total before confirming checkout. Stock is checked and deducted only when checkout succeeds. Receipts and past sales are available here.</p><a href="#/pos">Open Sales / POS</a></details>
        <details><summary>Employees &amp; salaries</summary><p>Configured salary rates describe an agreement; they are not recorded payments. Select the employee, choose salary, bonus, or advance, then review and confirm the payment. History shows recorded payments for that employee and business, separated by currency.</p><a href="#/employees">Open Employees</a></details>
        <details><summary>Bucky Record Scanner</summary><p>Take a photo or upload an image, extract a draft, expand entries to edit, and review dates, amounts, currency, and written-total differences. Confirm the final save only after checking every required field. No financial record is saved merely by uploading or extracting an image.</p><a href="#/scanner">Open Record Scanner</a></details>
        <details><summary>Bucky Financial Intelligence</summary><p>Ask from Home or open the floating mascot. The conversation stays available as you navigate, until the app reloads. Select the profile you want Bucky to analyze. Supported bookkeeping requests produce a preview; only Confirm save writes a record. Confirm or cancel a pending preview before closing or scanning.</p><p>Speak uses browser speech recognition where available; Listen reads an answer aloud. Camera and microphone permission, speech recognition, and voice quality vary by browser and device. Recognition may use the browser provider's online services. Tune spoken responses above.</p><a href="#/dashboard">Open Bucky on Home</a></details>
        <details><summary>Your data, privacy &amp; feature availability</summary><p>Your records stay in this browser. Another browser or device has separate records. Private browsing is temporary; clearing browser data can remove your records.</p><p>Features marked Demo or Mock use fictional examples, not information read from your photo. Review those examples carefully. Bucky's financial totals come from your saved records. Optional AI features may be unavailable; a demo result is not a live AI result.</p><p>Camera scanning and speech depend on your browser, device, permission, and connection. Choose English or Filipino / Tagalog before tapping Speak. Recognition may use your browser provider's online services; Bucky currently answers in English. Use typing or manual barcode entry whenever voice or scanning is unavailable.</p></details>
      </Card>
    </section>
  );
}

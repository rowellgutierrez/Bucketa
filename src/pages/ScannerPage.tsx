import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { bucketsRepo, profilesRepo } from "../data/db";
import type { Bucket, Profile } from "../data/types";
import { formatMoney } from "../lib/currency";
import {
  fetchScannerHealth,
  prepareScannerImage,
  requestExtraction,
  ScannerApiError,
  type ExtractResponse,
  type PreparedScannerImage,
  type ScannerHealth,
  type ScannerRecordType,
} from "../lib/scannerApi";

type HealthStatus = "checking" | "ready" | "offline";
type DataStatus = "loading" | "ready" | "error";

const RECORD_TYPES: { value: ScannerRecordType; label: string }[] = [
  { value: "expenses", label: "Expenses" },
  { value: "sales", label: "Sales" },
  { value: "salaries", label: "Salaries" },
  { value: "financial records", label: "Financial records" },
];

function errorMessage(error: unknown): string {
  if (error instanceof ScannerApiError || error instanceof Error) return error.message;
  return "Something went wrong. Please try again.";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function confidenceLabel(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

export default function ScannerPage() {
  const [healthStatus, setHealthStatus] = useState<HealthStatus>("checking");
  const [health, setHealth] = useState<ScannerHealth | null>(null);
  const [healthError, setHealthError] = useState("");
  const [healthAttempt, setHealthAttempt] = useState(0);

  const [dataStatus, setDataStatus] = useState<DataStatus>("loading");
  const [dataError, setDataError] = useState("");
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [profileId, setProfileId] = useState("");
  const [bucketId, setBucketId] = useState("");
  const [recordType, setRecordType] = useState<ScannerRecordType>("expenses");

  const [prepared, setPrepared] = useState<PreparedScannerImage | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [fileName, setFileName] = useState("");
  const [imageError, setImageError] = useState("");
  const [preparing, setPreparing] = useState(false);

  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState("");
  const [result, setResult] = useState<ExtractResponse | null>(null);

  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const previewUrlRef = useRef("");

  const activeProfile = profiles.find((profile) => profile.id === profileId) ?? null;
  const profileBuckets = useMemo(
    () => buckets.filter((bucket) => bucket.profileId === profileId),
    [buckets, profileId],
  );
  const activeBucket = profileBuckets.find((bucket) => bucket.id === bucketId) ?? null;
  const expectedCurrency = activeBucket?.currency ?? activeProfile?.currency ?? "PHP";

  const checkConnection = useCallback(async () => {
    setHealthStatus("checking");
    setHealthError("");
    try {
      const nextHealth = await fetchScannerHealth();
      setHealth(nextHealth);
      setHealthStatus("ready");
    } catch (error) {
      setHealth(null);
      setHealthError(errorMessage(error));
      setHealthStatus("offline");
    }
  }, []);

  useEffect(() => {
    void checkConnection();
  }, [checkConnection, healthAttempt]);

  useEffect(() => {
    previewUrlRef.current = previewUrl;
  }, [previewUrl]);

  useEffect(
    () => () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    },
    [],
  );

  const loadProfiles = useCallback(async () => {
    setDataStatus("loading");
    setDataError("");
    try {
      const [allProfiles, allBuckets] = await Promise.all([
        profilesRepo.listAll(),
        bucketsRepo.listAll(),
      ]);
      const sortedProfiles = [...allProfiles].sort(
        (a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name),
      );
      const sortedBuckets = [...allBuckets].sort(
        (a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name),
      );
      setProfiles(sortedProfiles);
      setBuckets(sortedBuckets);
      setProfileId((current) =>
        sortedProfiles.some((profile) => profile.id === current)
          ? current
          : (sortedProfiles[0]?.id ?? ""),
      );
      setDataStatus("ready");
    } catch (error) {
      setDataError(errorMessage(error));
      setDataStatus("error");
    }
  }, []);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  useEffect(() => {
    if (!profileBuckets.some((bucket) => bucket.id === bucketId)) setBucketId("");
  }, [bucketId, profileBuckets]);

  async function onImageSelected(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setPreparing(true);
    setImageError("");
    setExtractError("");
    setResult(null);
    try {
      const nextPrepared = await prepareScannerImage(file);
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      const nextPreviewUrl = URL.createObjectURL(nextPrepared.blob);
      setPrepared(nextPrepared);
      setPreviewUrl(nextPreviewUrl);
      setFileName(file.name);
    } catch (error) {
      setPrepared(null);
      setImageError(errorMessage(error));
    } finally {
      setPreparing(false);
    }
  }

  function clearImage() {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    setPrepared(null);
    setPreviewUrl("");
    setFileName("");
    setImageError("");
    setResult(null);
    setExtractError("");
  }

  async function onExtract() {
    if (!prepared || !activeProfile || extracting) return;
    setExtracting(true);
    setExtractError("");
    setResult(null);
    try {
      const nextResult = await requestExtraction({
        imageBase64: prepared.imageBase64,
        mediaType: prepared.mediaType,
        expectedCurrency,
        recordType,
      });
      setResult(nextResult);
    } catch (error) {
      setExtractError(errorMessage(error));
    } finally {
      setExtracting(false);
    }
  }

  const canExtract =
    healthStatus === "ready" && Boolean(prepared && activeProfile) && !extracting && !preparing;

  return (
    <section className="page scanner-page">
      <header className="dash-header">
        <div>
          <h1>AI Record Scanner</h1>
          <p className="muted dash-subtitle">
            Photograph handwritten records and preview what was read. This
            preview is read-only — nothing is saved to your records.
          </p>
        </div>
        <span className="currency-badge">Mock mode</span>
      </header>

      <section className="card scanner-status" aria-labelledby="scanner-status-heading">
        <h2 id="scanner-status-heading" className="inline-form-title">Scanner connection</h2>
        {healthStatus === "checking" && <p role="status">Checking scanner connection…</p>}
        {healthStatus === "ready" && health && (
          <>
            <p className="notice" role="status">
              Backend connected in mock mode. Test scans use fictional sample
              records; no live Meta request is made.
            </p>
            <p className="muted scanner-status-meta">
              Meta live: {health.liveMeta === "enabled-gated" ? "enabled (gated)" : "disabled"} ·
              Live requests used: {health.liveRequestsUsed} of {health.liveRequestsLimit}
            </p>
          </>
        )}
        {healthStatus === "offline" && (
          <>
            <p className="alert-error" role="alert">Scanner backend offline: {healthError}</p>
            <p className="muted">
              Start the local server with <code>npm run server</code>, then retry.
              The rest of Bucketa still works without it.
            </p>
            <button className="btn" type="button" onClick={() => setHealthAttempt((v) => v + 1)}>
              Retry connection
            </button>
          </>
        )}
      </section>

      {dataStatus === "loading" && <div className="card" role="status">Loading profiles and buckets…</div>}
      {dataStatus === "error" && (
        <div className="card">
          <p className="alert-error" role="alert">Could not load profiles: {dataError}</p>
          <button className="btn" type="button" onClick={() => void loadProfiles()}>Retry</button>
        </div>
      )}

      {dataStatus === "ready" && profiles.length === 0 && (
        <div className="card empty-state">
          <p>No personal or business profile yet.</p>
          <p className="muted">
            Create one in <a href="#/personal">Personal Finance</a> or{" "}
            <a href="#/buckets">Business Buckets</a>, then return here to scan
            records for it.
          </p>
        </div>
      )}

      {dataStatus === "ready" && activeProfile && (
        <section className="card scanner-form" aria-labelledby="scanner-setup-heading">
          <h2 id="scanner-setup-heading" className="inline-form-title">Scan a record</h2>
          <div className="form-row">
            <div className="field">
              <label htmlFor="scanner-profile">Profile</label>
              <select
                id="scanner-profile"
                className="input"
                value={profileId}
                onChange={(event) => { setProfileId(event.target.value); setBucketId(""); setResult(null); }}
              >
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name} ({profile.kind === "personal" ? "Personal" : "Business"} · {profile.currency})
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="scanner-bucket">Bucket (optional)</label>
              <select
                id="scanner-bucket"
                className="input"
                value={bucketId}
                onChange={(event) => { setBucketId(event.target.value); setResult(null); }}
              >
                <option value="">No bucket</option>
                {profileBuckets.map((bucket) => (
                  <option key={bucket.id} value={bucket.id}>{bucket.name} · {bucket.currency}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="scanner-record-type">Record type</label>
              <select
                id="scanner-record-type"
                className="input"
                value={recordType}
                onChange={(event) => { setRecordType(event.target.value as ScannerRecordType); setResult(null); }}
              >
                {RECORD_TYPES.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
          </div>
          <p className="field-hint">
            Currency is set automatically from {activeBucket ? `bucket “${activeBucket.name}”` : `profile “${activeProfile.name}”`}:{" "}
            <strong>{expectedCurrency}</strong>. It cannot be changed here, so
            scanned records cannot conflict with the selected bucket.
          </p>

          <div className="scanner-capture">
            <input
              ref={cameraInputRef}
              className="scanner-file-input"
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              capture="environment"
              aria-label="Take a photo of a record"
              onChange={(event) => void onImageSelected(event)}
            />
            <input
              ref={fileInputRef}
              className="scanner-file-input"
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              aria-label="Upload a photo of a record"
              onChange={(event) => void onImageSelected(event)}
            />
            <div className="row-actions">
              <button className="btn" type="button" onClick={() => cameraInputRef.current?.click()}>
                Take photo
              </button>
              <button className="btn ghost" type="button" onClick={() => fileInputRef.current?.click()}>
                Upload image
              </button>
              {prepared && (
                <button className="btn ghost" type="button" onClick={clearImage}>
                  Remove image
                </button>
              )}
            </div>
            <p className="field-hint">
              JPEG, PNG, WebP, or GIF, up to 5 MB. Larger photos are resized
              on this device before upload; the server checks the image again.
            </p>
            {preparing && <p role="status">Preparing image…</p>}
            {imageError && <p className="alert-error" role="alert">{imageError}</p>}
            {prepared && previewUrl && (
              <figure className="scanner-preview">
                <img src={previewUrl} alt="Preview of the record selected for scanning" />
                <figcaption className="muted">
                  {fileName || "Selected image"} · {formatBytes(prepared.sizeBytes)}
                  {prepared.wasResized
                    ? ` (resized from ${formatBytes(prepared.originalSizeBytes)})`
                    : ""}
                </figcaption>
              </figure>
            )}
          </div>

          <div className="row-actions">
            <button className="btn" type="button" disabled={!canExtract} onClick={() => void onExtract()}>
              {extracting ? "Scanning…" : "Scan in mock mode"}
            </button>
            {healthStatus !== "ready" && (
              <span className="field-hint">Connect the scanner backend to enable scanning.</span>
            )}
            {!prepared && healthStatus === "ready" && (
              <span className="field-hint">Choose or take a photo to enable scanning.</span>
            )}
          </div>
          {extractError && <p className="alert-error" role="alert">{extractError}</p>}
        </section>
      )}

      {extracting && <div className="card" role="status">Reading the record in mock mode…</div>}

      {result && !extracting && (
        <section className="card scanner-results" aria-labelledby="scanner-results-heading">
          <div className="panel-head">
            <h2 id="scanner-results-heading">Preview — nothing saved</h2>
            <span className="count-badge">
              {result.entries.length} {result.entries.length === 1 ? "entry" : "entries"} ·{" "}
              {result.needsReviewCount} need review
            </span>
          </div>
          <p className="notice" role="status">
            Mock scan complete for {activeProfile?.name ?? "the selected profile"} in{" "}
            {result.currency}. Review the entries below; saving will be added
            only after editable review is approved.
          </p>
          {result.entries.length === 0 ? (
            <div className="empty-state">
              <p>No entries were read from this image.</p>
              <p className="muted">Try a clearer, closer photo with the record fully in frame.</p>
            </div>
          ) : (
            <>
              <div className="scanner-table-wrap">
                <table className="scanner-table">
                  <thead>
                    <tr>
                      <th scope="col">Description</th>
                      <th scope="col">Type</th>
                      <th scope="col">Amount</th>
                      <th scope="col">Date</th>
                      <th scope="col">Category</th>
                      <th scope="col">Confidence</th>
                      <th scope="col">Review</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.entries.map((entry, index) => (
                      <tr key={`${entry.description ?? "entry"}-${index}`}>
                        <td data-label="Description">{entry.description ?? "Not read"}</td>
                        <td data-label="Type">{entry.type ?? "Not read"}</td>
                        <td data-label="Amount">
                          {entry.amountMinor !== null
                            ? formatMoney(entry.amountMinor, result.currency)
                            : (entry.amountText ?? "Not read")}
                          {entry.currencyConflict && entry.currencyDetected
                            ? ` · image shows ${entry.currencyDetected}`
                            : ""}
                        </td>
                        <td data-label="Date">{entry.dateText ?? "Not read"}</td>
                        <td data-label="Category">{entry.categorySuggestion ?? "Not suggested"}</td>
                        <td data-label="Confidence">
                          <span className={entry.confidence >= 0.8 ? "confidence confidence-high" : "confidence confidence-low"}>
                            {confidenceLabel(entry.confidence)}
                          </span>
                        </td>
                        <td data-label="Review">
                          {entry.needsReview ? (
                            <span className="review-flag">
                              Needs review: {entry.reviewReasons.join(", ")}
                            </span>
                          ) : (
                            <span className="confidence confidence-high">Ready</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <dl className="scanner-totals">
                <div><dt>Income</dt><dd>{formatMoney(result.totals.incomeMinor, result.currency)}</dd></div>
                <div><dt>Expenses</dt><dd>{formatMoney(result.totals.expenseMinor, result.currency)}</dd></div>
                <div><dt>Net</dt><dd>{formatMoney(result.totals.netMinor, result.currency)}</dd></div>
                <div>
                  <dt>Counted</dt>
                  <dd>{result.totals.countedEntries} · Skipped {result.totals.skippedEntries}</dd>
                </div>
              </dl>
              <p className="field-hint">
                Totals are calculated by Bucketa from the amounts above, never
                by the model. Entries marked “Needs review” must be checked
                before they can ever be saved.
              </p>
            </>
          )}
        </section>
      )}
    </section>
  );
}

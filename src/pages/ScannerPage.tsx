import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type SyntheticEvent } from "react";
import { bucketsRepo, profilesRepo, saveScannerTransactions } from "../data/db";
import type { Bucket, Profile } from "../data/types";
import { formatMoney } from "../lib/currency";
import {
  fetchScannerHealth,
  isLiveScannerAvailable,
  prepareScannerImage,
  requestExtraction,
  ScannerApiError,
  type ExtractResponse,
  type PreparedScannerImage,
  type ScannerExtractionMode,
  type ScannerHealth,
  type ScannerRecordType,
} from "../lib/scannerApi";
import {
  applyScannerDraftEdit,
  buildScannerDrafts,
  buildScannerTransactions,
  createScannerBatchId,
  requiresExplicitConfirmation,
  scannerDraftTotals,
  scannerReviewWarnings,
  validateScannerDrafts,
  type ScannerDraft,
  type ScannerEntryType,
  type ScannerReviewContext,
} from "../lib/scannerReview";

type HealthStatus = "checking" | "ready" | "offline";
type DataStatus = "loading" | "ready" | "error";

/** A change that would discard the current unsaved scanner review. */
type PendingDraftDiscard =
  | { kind: "rescan" }
  | { kind: "profile"; profileId: string }
  | { kind: "bucket"; bucketId: string }
  | { kind: "recordType"; recordType: ScannerRecordType }
  | { kind: "image"; file: File }
  | { kind: "clearImage" };

function draftDiscardText(action: PendingDraftDiscard): {
  title: string;
  detail: string;
  confirmLabel: string;
} {
  switch (action.kind) {
    case "rescan":
      return {
        title: "Replace the current unsaved review?",
        detail:
          "A successful new scan will replace them. If the new scan fails, this review will be kept.",
        confirmLabel: "Continue to scan",
      };
    case "profile":
      return {
        title: "Change profile and discard this review?",
        detail: "The selected profile will change and this review will be discarded.",
        confirmLabel: "Discard review and change profile",
      };
    case "bucket":
      return {
        title: "Change bucket and discard this review?",
        detail: "The selected bucket will change and this review will be discarded.",
        confirmLabel: "Discard review and change bucket",
      };
    case "recordType":
      return {
        title: "Change record type and discard this review?",
        detail: "The record type will change and this review will be discarded.",
        confirmLabel: "Discard review and change record type",
      };
    case "image":
      return {
        title: "Replace the image and discard this review?",
        detail: "The new image will replace the current one and this review will be discarded.",
        confirmLabel: "Discard review and replace image",
      };
    case "clearImage":
      return {
        title: "Remove the image and discard this review?",
        detail: "The current image and this review will be removed.",
        confirmLabel: "Discard review and remove image",
      };
  }
}

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
  const [extractionMode, setExtractionMode] = useState<ScannerExtractionMode>("mock");
  const [liveTestToken, setLiveTestToken] = useState("");
  const [confirmingLiveSend, setConfirmingLiveSend] = useState(false);
  const [pendingDraftDiscard, setPendingDraftDiscard] = useState<PendingDraftDiscard | null>(null);
  const [pendingRemovalId, setPendingRemovalId] = useState<string | null>(null);
  const [liveQuotaStale, setLiveQuotaStale] = useState(false);
  const [result, setResult] = useState<ExtractResponse | null>(null);
  const [drafts, setDrafts] = useState<ScannerDraft[]>([]);
  const [batchId, setBatchId] = useState("");
  const [reviewRecordType, setReviewRecordType] = useState<ScannerRecordType>("expenses");
  const [saveAttempted, setSaveAttempted] = useState(false);
  const [confirmingSave, setConfirmingSave] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saveOutcome, setSaveOutcome] = useState<"saved" | "already-saved" | null>(null);

  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const draftDiscardPanelRef = useRef<HTMLDivElement | null>(null);
  const removalDialogRef = useRef<HTMLDialogElement | null>(null);
  const removalCancelRef = useRef<HTMLButtonElement | null>(null);
  const removalConfirmedRef = useRef(false);
  const previewUrlRef = useRef("");
  const extractionInFlightRef = useRef(false);

  const activeProfile = profiles.find((profile) => profile.id === profileId) ?? null;
  const profileBuckets = useMemo(
    () => buckets.filter((bucket) => bucket.profileId === profileId),
    [buckets, profileId],
  );
  const activeBucket = profileBuckets.find((bucket) => bucket.id === bucketId) ?? null;
  const expectedCurrency = activeBucket?.currency ?? activeProfile?.currency ?? "PHP";
  const liveAvailable =
    healthStatus === "ready" &&
    !liveQuotaStale &&
    isLiveScannerAvailable(import.meta.env.DEV, health);
  const liveRequestsRemaining =
    health && !liveQuotaStale
      ? Math.max(0, health.liveRequestsLimit - health.liveRequestsUsed)
      : null;
  const hasUnsavedDrafts = Boolean(result && saveOutcome === null && drafts.length > 0);
  const pendingRemovalDraft = pendingRemovalId
    ? drafts.find((draft) => draft.transactionId === pendingRemovalId) ?? null
    : null;

  // Warn on browser refresh / tab close only while a review is unsaved.
  useEffect(() => {
    if (!hasUnsavedDrafts) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [hasUnsavedDrafts]);

  // A pending discard warning is meaningless once nothing is unsaved
  // (e.g. the batch was saved or every draft was removed meanwhile).
  useEffect(() => {
    if (!hasUnsavedDrafts) setPendingDraftDiscard(null);
  }, [hasUnsavedDrafts]);

  // A pending entry-removal confirmation is meaningless once that entry is
  // no longer in the current review (e.g. the scan was replaced or cleared).
  useEffect(() => {
    if (pendingRemovalId && !pendingRemovalDraft) setPendingRemovalId(null);
  }, [pendingRemovalId, pendingRemovalDraft]);

  // Open the removal confirmation as a real modal and start focus on the
  // safe choice. The native dialog keeps the background inert for pointer,
  // keyboard, and assistive technology while it is open.
  useEffect(() => {
    if (!pendingRemovalDraft) return;
    const dialog = removalDialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    removalCancelRef.current?.focus();
  }, [pendingRemovalDraft]);

  // Bring the discard warning into view and move keyboard focus to it,
  // on desktop and mobile, whenever it opens.
  useEffect(() => {
    if (!pendingDraftDiscard) return;
    const panel = draftDiscardPanelRef.current;
    if (!panel) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    panel.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
    panel.focus({ preventScroll: true });
  }, [pendingDraftDiscard]);

  const checkConnection = useCallback(async () => {
    setHealthStatus("checking");
    setHealthError("");
    try {
      const nextHealth = await fetchScannerHealth();
      setHealth(nextHealth);
      setLiveQuotaStale(false);
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

  useEffect(() => {
    if (healthStatus === "ready" && extractionMode === "live" && !liveAvailable) {
      setExtractionMode("mock");
      setLiveTestToken("");
      setConfirmingLiveSend(false);
      setPendingDraftDiscard(null);
    }
  }, [healthStatus, extractionMode, liveAvailable]);

  function onImageSelected(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    requestDraftChange({ kind: "image", file });
  }

  async function prepareSelectedImage(file: File) {
    setConfirmingLiveSend(false);
    setPreparing(true);
    setImageError("");
    setExtractError("");
    try {
      const nextPrepared = await prepareScannerImage(file);
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      const nextPreviewUrl = URL.createObjectURL(nextPrepared.blob);
      // Only discard the previous review once the new image is ready, so a
      // failed preparation keeps the current image and unsaved drafts.
      clearReview();
      setLiveTestToken("");
      setPrepared(nextPrepared);
      setPreviewUrl(nextPreviewUrl);
      setFileName(file.name);
    } catch (error) {
      setImageError(errorMessage(error));
    } finally {
      setPreparing(false);
    }
  }

  function clearReview() {
    setResult(null);
    setDrafts([]);
    setPendingRemovalId(null);
    setBatchId("");
    setSaveAttempted(false);
    setConfirmingSave(false);
    setSaveError("");
    setSaveOutcome(null);
  }

  function clearImage() {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    setPrepared(null);
    setPreviewUrl("");
    setFileName("");
    setImageError("");
    setLiveTestToken("");
    setConfirmingLiveSend(false);
    clearReview();
    setExtractError("");
  }

  function applyDraftChange(action: PendingDraftDiscard) {
    switch (action.kind) {
      case "rescan":
        if (extractionMode === "live") {
          setConfirmingLiveSend(true);
          return;
        }
        void startExtraction("mock");
        return;
      case "profile":
        setProfileId(action.profileId);
        setBucketId("");
        setConfirmingLiveSend(false);
        clearReview();
        return;
      case "bucket":
        setBucketId(action.bucketId);
        setConfirmingLiveSend(false);
        clearReview();
        return;
      case "recordType":
        setRecordType(action.recordType);
        setConfirmingLiveSend(false);
        clearReview();
        return;
      case "image":
        void prepareSelectedImage(action.file);
        return;
      case "clearImage":
        clearImage();
        return;
    }
  }

  function requestDraftChange(action: PendingDraftDiscard) {
    if (extracting || saving) return;
    if (!hasUnsavedDrafts) {
      applyDraftChange(action);
      return;
    }
    setConfirmingLiveSend(false);
    setPendingDraftDiscard(action);
  }

  function confirmDraftDiscard() {
    const action = pendingDraftDiscard;
    if (!action) return;
    setPendingDraftDiscard(null);
    applyDraftChange(action);
  }

  async function refreshLiveQuota() {
    try {
      const nextHealth = await fetchScannerHealth();
      setHealth(nextHealth);
      setLiveQuotaStale(false);
      setHealthStatus("ready");
    } catch {
      setLiveQuotaStale(true);
    }
  }

  function changeExtractionMode(mode: ScannerExtractionMode) {
    setExtractionMode(mode);
    setConfirmingLiveSend(false);
    setPendingDraftDiscard(null);
    if (mode === "mock") setLiveTestToken("");
  }

  function onScanButtonClick() {
    if (extractionInFlightRef.current || extracting || !prepared || !activeProfile) return;
    requestDraftChange({ kind: "rescan" });
  }

  async function startExtraction(mode: ScannerExtractionMode) {
    if (extractionInFlightRef.current || !prepared || !activeProfile) return;
    const requestImage = prepared;
    const requestCurrency = expectedCurrency;
    const requestRecordType = recordType;
    const requestToken = mode === "live" ? liveTestToken : "";
    if (mode === "live" && requestToken.trim().length === 0) {
      setExtractError("Enter the local live-test token before requesting a live scan.");
      return;
    }

    // Set synchronously, before any await, so rapid clicks cannot start
    // a second extraction while React state updates are still pending.
    extractionInFlightRef.current = true;
    setExtracting(true);
    setExtractError("");
    setConfirmingLiveSend(false);
    setPendingDraftDiscard(null);
    try {
      const nextResult = await requestExtraction(
        {
          imageBase64: requestImage.imageBase64,
          mediaType: requestImage.mediaType,
          expectedCurrency: requestCurrency,
          recordType: requestRecordType,
        },
        mode === "live"
          ? { mode, liveTestToken: requestToken }
          : { mode: "mock" },
      );
      if (mode === "live" && typeof nextResult.liveRequestsUsed === "number") {
        setHealth((current) =>
          current ? { ...current, liveRequestsUsed: nextResult.liveRequestsUsed as number } : current,
        );
        setLiveQuotaStale(false);
      }
      if (nextResult.mode !== mode) {
        throw new ScannerApiError(
          "invalid_response",
          `The scanner returned a ${nextResult.mode} result for a ${mode} request. Nothing was added to the review.`,
        );
      }
      const nextBatchId = createScannerBatchId();
      clearReview();
      setBatchId(nextBatchId);
      setReviewRecordType(requestRecordType);
      setResult(nextResult);
      setDrafts(buildScannerDrafts(nextResult, requestRecordType, nextBatchId));
    } catch (error) {
      const message = errorMessage(error);
      setExtractError(
        hasUnsavedDrafts
          ? `${message} Your previous unsaved review is still below.`
          : message,
      );
      if (
        mode === "live" &&
        !(error instanceof ScannerApiError && error.code === "live_token_required")
      ) {
        await refreshLiveQuota();
      }
    } finally {
      if (mode === "live") setLiveTestToken("");
      extractionInFlightRef.current = false;
      setExtracting(false);
    }
  }

  const reviewContext: ScannerReviewContext = {
    batchId,
    profileId,
    profileKind: activeProfile?.kind ?? "personal",
    bucketId: bucketId || null,
    expectedCurrency,
    recordType: reviewRecordType,
  };
  const draftErrors = useMemo<Map<string, string[]>>(
    () => (result ? validateScannerDrafts(drafts, reviewContext) : new Map<string, string[]>()),
    // reviewContext is intentionally rebuilt from its primitive inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [drafts, result, batchId, profileId, activeProfile?.kind, bucketId, expectedCurrency, reviewRecordType],
  );
  const invalidDraftCount = drafts.filter(
    (draft) => (draftErrors.get(draft.transactionId) ?? []).length > 0,
  ).length;
  const draftTotals = useMemo(
    () => scannerDraftTotals(drafts, expectedCurrency),
    [drafts, expectedCurrency],
  );
  const saveLocked = saving || saveOutcome !== null;

  function updateDraft(transactionId: string, patch: Partial<ScannerDraft>) {
    if (saveLocked) return;
    setConfirmingSave(false);
    setSaveError("");
    setDrafts((current) =>
      current.map((draft) =>
        draft.transactionId === transactionId ? applyScannerDraftEdit(draft, patch) : draft,
      ),
    );
  }

  function requestRemoveDraft(transactionId: string) {
    if (saveLocked) return;
    removalConfirmedRef.current = false;
    setPendingRemovalId(transactionId);
  }

  function closeRemovalDialog() {
    const dialog = removalDialogRef.current;
    if (dialog?.open) dialog.close();
  }

  // Single cleanup path for every dialog dismissal (Escape, Cancel,
  // backdrop). The browser closes the dialog natively; this only syncs
  // React state and restores focus.
  function handleRemovalDialogClose(event: SyntheticEvent<HTMLDialogElement>) {
    // Ignore a close event from a dialog element that has already been
    // replaced, so it can never clear a newly opened confirmation.
    if (removalDialogRef.current && event.currentTarget !== removalDialogRef.current) return;
    const transactionId = pendingRemovalId;
    const confirmed = removalConfirmedRef.current;
    removalConfirmedRef.current = false;
    // Clear only the pending removal this dialog belonged to; a newer
    // confirmation opened in the meantime must survive.
    setPendingRemovalId((current) => (current === transactionId ? null : current));
    if (!transactionId || confirmed) return;
    // The dialog has unmounted by now, so return keyboard focus to the
    // trash button that opened it — unless a newer dialog has opened or
    // the entry no longer exists (its button is gone, so this is a no-op).
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (removalDialogRef.current?.open) return;
        document
          .querySelector<HTMLElement>(`[data-scanner-remove="${transactionId}"]`)
          ?.focus();
      });
    });
  }

  function confirmRemoval() {
    const transactionId = pendingRemovalId;
    if (!transactionId) return;
    removalConfirmedRef.current = true;
    closeRemovalDialog();
    setPendingRemovalId(null);
    removeDraft(transactionId);
  }

  function removeDraft(transactionId: string) {
    if (saveLocked) return;
    setConfirmingSave(false);
    setSaveError("");
    const index = drafts.findIndex((draft) => draft.transactionId === transactionId);
    const remaining = drafts.filter((draft) => draft.transactionId !== transactionId);
    setDrafts(remaining);
    // The removed entry's button unmounts, so move keyboard focus to the
    // next remaining entry's remove button (or the previous one, or the
    // results heading when nothing remains) instead of losing it.
    const fallbackId = remaining[index]?.transactionId ?? remaining[index - 1]?.transactionId;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const target = fallbackId
          ? document.querySelector<HTMLElement>(`[data-scanner-remove="${fallbackId}"]`)
          : document.querySelector<HTMLElement>("[data-scanner-results-heading]");
        target?.focus();
      });
    });
  }

  function requestSaveConfirmation() {
    setSaveAttempted(true);
    setSaveError("");
    if (drafts.length === 0) {
      setSaveError("Remove or restore at least one entry before saving. Scan the image again to restore removed entries.");
      return;
    }
    if (invalidDraftCount > 0) {
      setSaveError(
        `Fix ${invalidDraftCount} ${invalidDraftCount === 1 ? "entry" : "entries"} or remove them before saving.`,
      );
      return;
    }
    setConfirmingSave(true);
  }

  async function confirmSave() {
    if (!activeProfile || saving || saveOutcome) return;
    setSaving(true);
    setSaveError("");
    try {
      const transactions = buildScannerTransactions(drafts, reviewContext);
      const outcome = await saveScannerTransactions({
        profileId: activeProfile.id,
        bucketId: bucketId || null,
        expectedCurrency,
        transactions,
      });
      setSaveOutcome(outcome);
      setConfirmingSave(false);
    } catch (error) {
      setConfirmingSave(false);
      setSaveError(
        `${errorMessage(error)} Your reviewed entries are still here — fix the problem and retry. Nothing was saved unless Bucketa confirms it.`,
      );
    } finally {
      setSaving(false);
    }
  }

  const canExtract =
    healthStatus === "ready" &&
    Boolean(prepared && activeProfile) &&
    !extracting &&
    !preparing &&
    (extractionMode === "mock" ||
      (liveAvailable && liveTestToken.trim().length > 0));

  return (
    <section className="page scanner-page">
      <header className="dash-header">
        <div>
          <h1>AI Record Scanner</h1>
          <p className="muted dash-subtitle">
            Photograph handwritten records, review and correct what was read,
            then save the confirmed entries.
          </p>
        </div>
        <span className="currency-badge">
          Next scan: {extractionMode === "live" && liveAvailable ? "Live AI test" : "Mock"}
        </span>
      </header>

      <section className="card scanner-status" aria-labelledby="scanner-status-heading">
        <h2 id="scanner-status-heading" className="inline-form-title">Scanner connection</h2>
        {healthStatus === "checking" && <p role="status">Checking scanner connection…</p>}
        {healthStatus === "ready" && health && (
          <>
            <p className="notice" role="status">
              Backend connected. Mock scanning is the default and uses fictional
              sample records. Live AI is used only when you deliberately select
              and confirm it below.
            </p>
            <p className="muted scanner-status-meta">
              Meta live: {health.liveMeta === "enabled-gated" ? "enabled (gated)" : "disabled"} ·
              Live requests used: {health.liveRequestsUsed} of {health.liveRequestsLimit} ·{" "}
              {liveRequestsRemaining === null
                ? "Remaining live quota unavailable until the connection is refreshed"
                : `Live requests remaining: ${liveRequestsRemaining}`}
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
                disabled={extracting}
                onChange={(event) => requestDraftChange({ kind: "profile", profileId: event.target.value })}
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
                disabled={extracting}
                onChange={(event) => requestDraftChange({ kind: "bucket", bucketId: event.target.value })}
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
                disabled={extracting}
                onChange={(event) => requestDraftChange({ kind: "recordType", recordType: event.target.value as ScannerRecordType })}
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

          {import.meta.env.DEV && (
            <div className="scanner-mode-panel">
              <fieldset className="scanner-mode-fieldset">
                <legend>Extraction mode</legend>
                <div className="scanner-mode-options">
                  <label className="scanner-mode-option">
                    <input
                      type="radio"
                      name="scanner-extraction-mode"
                      value="mock"
                      checked={extractionMode === "mock"}
                      disabled={extracting || preparing}
                      onChange={() => changeExtractionMode("mock")}
                    />
                    <span>
                      <strong>Mock scan (default)</strong>
                      <small>Uses fictional sample records; no image is sent to Meta AI.</small>
                    </span>
                  </label>
                  <label className="scanner-mode-option">
                    <input
                      type="radio"
                      name="scanner-extraction-mode"
                      value="live"
                      checked={extractionMode === "live"}
                      disabled={extracting || preparing || !liveAvailable}
                      onChange={() => changeExtractionMode("live")}
                    />
                    <span>
                      <strong>Live AI test (local development only)</strong>
                      <small>
                        {liveAvailable
                          ? "Sends the selected image through the local backend to Meta AI after confirmation."
                          : "Unavailable unless the local backend reports gated live mode and its quota is verified."}
                      </small>
                    </span>
                  </label>
                </div>
              </fieldset>
              {extractionMode === "live" && liveAvailable && (
                <div className="field scanner-token-field">
                  <label htmlFor="scanner-live-token">Local live-test token</label>
                  <input
                    id="scanner-live-token"
                    className="input"
                    type="password"
                    value={liveTestToken}
                    disabled={extracting}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => {
                      setLiveTestToken(event.target.value);
                      setConfirmingLiveSend(false);
                    }}
                  />
                  <span className="field-hint">
                    Temporary and memory-only. It is cleared after cancellation or each live attempt and is never saved by Bucketa.
                  </span>
                  <span className="field-hint">
                    Live requests remaining: {liveRequestsRemaining ?? "unavailable"}
                  </span>
                </div>
              )}
            </div>
          )}

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
              <button className="btn" type="button" disabled={extracting || preparing} onClick={() => cameraInputRef.current?.click()}>
                Take photo
              </button>
              <button className="btn ghost" type="button" disabled={extracting || preparing} onClick={() => fileInputRef.current?.click()}>
                Upload image
              </button>
              {prepared && (
                <button className="btn ghost" type="button" disabled={extracting || preparing} onClick={() => requestDraftChange({ kind: "clearImage" })}>
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
            <button className="btn" type="button" disabled={!canExtract} onClick={onScanButtonClick}>
              {extracting
                ? "Scanning…"
                : extractionMode === "live"
                  ? "Review live scan request"
                  : "Scan in mock mode"}
            </button>
            {healthStatus !== "ready" && (
              <span className="field-hint">Connect the scanner backend to enable scanning.</span>
            )}
            {!prepared && healthStatus === "ready" && (
              <span className="field-hint">Choose or take a photo to enable scanning.</span>
            )}
            {extractionMode === "live" && prepared && liveTestToken.trim().length === 0 && (
              <span className="field-hint">Enter the temporary live-test token to continue.</span>
            )}
          </div>
          {pendingDraftDiscard && hasUnsavedDrafts && (
            <div
              ref={draftDiscardPanelRef}
              tabIndex={-1}
              className="scanner-confirm-panel"
              role="alertdialog"
              aria-labelledby="scanner-discard-heading"
            >
              <h3 id="scanner-discard-heading">{draftDiscardText(pendingDraftDiscard).title}</h3>
              <p>
                You have {drafts.length} unsaved reviewed {drafts.length === 1 ? "entry" : "entries"}.{" "}
                {draftDiscardText(pendingDraftDiscard).detail}
              </p>
              <div className="row-actions">
                <button className="btn" type="button" onClick={confirmDraftDiscard}>
                  {draftDiscardText(pendingDraftDiscard).confirmLabel}
                </button>
                <button className="btn ghost" type="button" onClick={() => setPendingDraftDiscard(null)}>
                  Keep reviewing
                </button>
              </div>
            </div>
          )}
          {confirmingLiveSend && !pendingDraftDiscard && (
            <div className="scanner-confirm-panel" role="alertdialog" aria-labelledby="scanner-live-confirm-heading">
              <h3 id="scanner-live-confirm-heading">Send this image to Meta AI?</h3>
              <p>
                Send <strong>{fileName || "the selected image"}</strong> for{" "}
                <strong>{activeProfile?.name}</strong> as {recordType} in {expectedCurrency},
                through the local Bucketa backend.
              </p>
              <p className="scanner-warning" role="note">
                This uses one live-request attempt even if extraction fails.
                Live requests remaining before this attempt: {liveRequestsRemaining ?? "unavailable"}.
                Nothing is saved automatically; you must review and confirm every entry.
              </p>
              <div className="row-actions">
                <button className="btn" type="button" disabled={extracting} onClick={() => void startExtraction("live")}>
                  Send once to Meta AI
                </button>
                <button
                  className="btn ghost"
                  type="button"
                  disabled={extracting}
                  onClick={() => { setConfirmingLiveSend(false); setLiveTestToken(""); }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          {extractError && <p className="alert-error" role="alert">{extractError}</p>}
        </section>
      )}

      {extracting && (
        <div className="card" role="status">
          {extractionMode === "live"
            ? "Sending the image to Meta AI…"
            : "Reading the record in mock mode…"}
        </div>
      )}

      {result && !extracting && (
        <section className="card scanner-results" aria-labelledby="scanner-results-heading">
          <div className="panel-head">
            <h2 id="scanner-results-heading" tabIndex={-1} data-scanner-results-heading>Review and save entries</h2>
            <span className="count-badge">
              {drafts.length} remaining · {invalidDraftCount} need fixes
            </span>
          </div>
          <p className="notice" role="status">
            {result.mode === "live" ? "Live AI scan complete" : "Mock scan complete"} for {activeProfile?.name ?? "the selected profile"} in{" "}
            {result.currency}. Nothing is saved until you confirm the final save below.
          </p>
          <p className="scanner-warning" role="note">
            <strong>Before you save:</strong> scanner-confirmed records cannot
            currently be edited or deleted through the existing history pages.
            Check every entry carefully, or remove entries you do not want to keep.
          </p>
          {reviewRecordType === "salaries" && activeProfile?.kind !== "business" && (
            <p className="alert-error" role="alert">
              Salaries can only be saved for a business profile. Choose a business
              profile above, or scan personal salary receipts as Financial records.
            </p>
          )}
          {result.entries.length === 0 ? (
            <div className="empty-state">
              <p>No entries were read from this image.</p>
              <p className="muted">Try a clearer, closer photo with the record fully in frame.</p>
            </div>
          ) : drafts.length === 0 ? (
            <div className="empty-state">
              <p>All extracted entries were removed.</p>
              <p className="muted">Scan the image again if you need to restore them.</p>
            </div>
          ) : (
            <>
              <div className="scanner-table-wrap">
                <table className="scanner-table scanner-edit-table">
                  <thead>
                    <tr>
                      <th scope="col">Description</th>
                      <th scope="col">Type</th>
                      <th scope="col">Amount ({expectedCurrency})</th>
                      <th scope="col">Date</th>
                      <th scope="col">Category</th>
                      <th scope="col">Review</th>
                      <th scope="col">Remove</th>
                    </tr>
                  </thead>
                  <tbody>
                    {drafts.map((draft, index) => {
                      const errors = draftErrors.get(draft.transactionId) ?? [];
                      const warnings = scannerReviewWarnings(draft);
                      const showErrors = saveAttempted && errors.length > 0;
                      return (
                        <tr key={draft.transactionId}>
                          <td data-label="Description">
                            <input
                              className="input scanner-edit-input"
                              value={draft.description}
                              disabled={saveLocked}
                              aria-label="Description"
                              onChange={(event) => updateDraft(draft.transactionId, { description: event.target.value })}
                            />
                          </td>
                          <td data-label="Type">
                            <select
                              className="input scanner-edit-input"
                              value={draft.type}
                              disabled={saveLocked || reviewRecordType === "salaries"}
                              aria-label="Income or expense"
                              onChange={(event) => updateDraft(draft.transactionId, { type: event.target.value as ScannerEntryType })}
                            >
                              <option value="">Choose…</option>
                              <option value="income">Income</option>
                              <option value="expense">Expense</option>
                            </select>
                          </td>
                          <td data-label="Amount">
                            <input
                              className="input scanner-edit-input"
                              value={draft.amountText}
                              disabled={saveLocked}
                              inputMode="decimal"
                              aria-label={`Amount in ${expectedCurrency}`}
                              onChange={(event) => updateDraft(draft.transactionId, { amountText: event.target.value })}
                            />
                            {draft.currencyConflict && draft.currencyDetected && (
                              <span className="field-hint">Image shows {draft.currencyDetected}; saving currency stays {expectedCurrency}.</span>
                            )}
                          </td>
                          <td data-label="Date">
                            <input
                              className="input scanner-edit-input"
                              type="date"
                              value={draft.date}
                              disabled={saveLocked}
                              aria-label="Date"
                              onChange={(event) => updateDraft(draft.transactionId, { date: event.target.value })}
                            />
                            {draft.dateHint && <span className="field-hint">Scan read: {draft.dateHint}</span>}
                          </td>
                          <td data-label="Category">
                            <input
                              className="input scanner-edit-input"
                              value={draft.category}
                              disabled={saveLocked}
                              aria-label="Category"
                              onChange={(event) => updateDraft(draft.transactionId, { category: event.target.value })}
                            />
                          </td>
                          <td data-label="Review">
                            {requiresExplicitConfirmation(draft) ? (
                              <label className="scanner-confirm-check">
                                <input
                                  type="checkbox"
                                  checked={draft.explicitlyConfirmed}
                                  disabled={saveLocked}
                                  onChange={(event) => updateDraft(draft.transactionId, { explicitlyConfirmed: event.target.checked })}
                                />
                                I checked this entry
                              </label>
                            ) : (
                              <span className="scanner-ready">Ready</span>
                            )}
                            {warnings.length > 0 && (
                              <span className="scanner-review-warnings">{warnings.join(" · ")}</span>
                            )}
                            {showErrors && (
                              <ul className="scanner-entry-errors">
                                {errors.map((message) => <li key={message}>{message}</li>)}
                              </ul>
                            )}
                          </td>
                          <td data-label="Remove">
                            <button
                              className="scanner-remove-btn"
                              type="button"
                              disabled={saveLocked}
                              aria-label={`Remove entry ${index + 1}${draft.description.trim() ? `: ${draft.description.trim()}` : ""}`}
                              title="Remove this entry"
                              data-scanner-remove={draft.transactionId}
                              onClick={() => requestRemoveDraft(draft.transactionId)}
                            >
                              <svg
                                viewBox="0 0 24 24"
                                width="17"
                                height="17"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.8"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                aria-hidden="true"
                                focusable="false"
                              >
                                <path d="M4 7h16" />
                                <path d="M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7" />
                                <path d="M6.5 7l.9 12.1a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4L17.5 7" />
                                <path d="M10 11v5.5M14 11v5.5" />
                              </svg>
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <dl className="scanner-totals">
                <div><dt>Income</dt><dd>{formatMoney(draftTotals.incomeMinor, expectedCurrency)}</dd></div>
                <div><dt>Expenses</dt><dd>{formatMoney(draftTotals.expenseMinor, expectedCurrency)}</dd></div>
                <div><dt>Net</dt><dd>{formatMoney(draftTotals.netMinor, expectedCurrency)}</dd></div>
                <div><dt>Counted</dt><dd>{draftTotals.countedEntries} of {drafts.length}</dd></div>
              </dl>
              <p className="field-hint">
                Totals are recalculated by Bucketa from your edited amounts.
                Scanned sales save as income or expense transactions — never as
                POS sales — so inventory is not changed. Salaries save only as
                business expenses and do not create employee records.
              </p>
              {pendingRemovalDraft && (
                <dialog
                  ref={removalDialogRef}
                  className="scanner-remove-dialog"
                  aria-labelledby="scanner-remove-heading"
                  aria-describedby="scanner-remove-message"
                  onClose={handleRemovalDialogClose}
                  onClick={(event) => {
                    if (event.target === event.currentTarget) closeRemovalDialog();
                  }}
                >
                  <h3 id="scanner-remove-heading">Remove scanned entry?</h3>
                  <p id="scanner-remove-message">
                    Are you sure you want to remove{" "}
                    {pendingRemovalDraft.description.trim()
                      ? `‘${pendingRemovalDraft.description.trim()}’`
                      : "this entry"}{" "}
                    from this scan? This entry has not been saved yet.
                  </p>
                  <div className="row-actions">
                    <button
                      ref={removalCancelRef}
                      className="btn ghost"
                      type="button"
                      onClick={closeRemovalDialog}
                    >
                      Cancel
                    </button>
                    <button className="btn danger-solid" type="button" onClick={confirmRemoval}>
                      Remove entry
                    </button>
                  </div>
                </dialog>
              )}
              {saveError && <p className="alert-error" role="alert">{saveError}</p>}
              {saveOutcome ? (
                <div className="notice" role="status">
                  <p>
                    {saveOutcome === "already-saved"
                      ? "This scanner batch was already saved, so nothing was duplicated."
                      : `${drafts.length} scanner ${drafts.length === 1 ? "entry" : "entries"} saved.`}
                  </p>
                  <div className="row-actions">
                    <a className="btn" href={activeProfile?.kind === "business" ? "#/transactions" : "#/personal"}>
                      View saved records
                    </a>
                    <a className="btn ghost" href="#/dashboard">Open Dashboard</a>
                    <button className="btn ghost" type="button" onClick={clearImage}>Scan another record</button>
                  </div>
                </div>
              ) : confirmingSave ? (
                <div className="scanner-confirm-panel">
                  <h3>Confirm final save</h3>
                  <p>
                    Save {drafts.length} {drafts.length === 1 ? "entry" : "entries"} to{" "}
                    {activeProfile?.name}
                    {activeBucket ? `, bucket “${activeBucket.name}”` : ""}, in {expectedCurrency}.
                    This saves the whole batch at once, or nothing at all.
                  </p>
                  <p className="scanner-warning" role="note">
                    Scanner-confirmed records cannot currently be edited or
                    deleted through the existing history pages.
                  </p>
                  <div className="row-actions">
                    <button className="btn" type="button" disabled={saving} onClick={() => void confirmSave()}>
                      {saving ? "Saving…" : "Yes, save all entries"}
                    </button>
                    <button className="btn ghost" type="button" disabled={saving} onClick={() => setConfirmingSave(false)}>
                      Go back and review
                    </button>
                  </div>
                </div>
              ) : (
                <div className="row-actions">
                  <button className="btn" type="button" disabled={saving || drafts.length === 0} onClick={requestSaveConfirmation}>
                    Review final save
                  </button>
                  {saveAttempted && invalidDraftCount > 0 && (
                    <span className="field-hint">Fix {invalidDraftCount} entries or remove them to continue.</span>
                  )}
                </div>
              )}
            </>
          )}
        </section>
      )}
    </section>
  );
}

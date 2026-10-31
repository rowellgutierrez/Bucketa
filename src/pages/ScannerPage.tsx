import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type SyntheticEvent } from "react";
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
  applyScannerCalendarSelection,
  applyScannerDateEdit,
  applyScannerDraftEdit,
  buildScannerDrafts,
  buildScannerTransactions,
  createScannerBatchId,
  formatScannerDateForDisplay,
  formatScannerDateInput,
  mapScannerDateInputSelection,
  requiresExplicitConfirmation,
  resolveScannerDateEdit,
  scannerDraftDateGroups,
  scannerDraftTotals,
  scannerGrandTotalAcknowledgmentSatisfied,
  scannerGrandTotalReconciliation,
  scannerReviewWarnings,
  validateScannerDraftFields,
  validateScannerDrafts,
  type ScannerDateFormat,
  type ScannerDraft,
  type ScannerDraftField,
  type ScannerDraftFieldErrors,
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

const SCANNER_MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "2026-10-30" -> "October 30, 2026", using a fixed month table (no locale parsing). */
function formatScannerDateGroupLabel(isoDate: string): string {
  const [yearText, monthText, dayText] = isoDate.split("-");
  const monthName = SCANNER_MONTH_NAMES[Number(monthText) - 1] ?? "";
  // Keep the year exactly as stored so four-digit years are never truncated.
  return `${monthName} ${Number(dayText)}, ${yearText}`;
}

const SCANNER_DATE_FORMAT_STORAGE_KEY = "bucketa.scannerDateFormat";
const SCANNER_DATE_FORMAT_OPTIONS: readonly ScannerDateFormat[] = [
  "DD/MM/YYYY",
  "MM/DD/YYYY",
  "YYYY-MM-DD",
];

/** Scanner-local display preference only; no financial data is stored. */
function loadScannerDateFormat(): ScannerDateFormat {
  try {
    const stored = window.localStorage.getItem(SCANNER_DATE_FORMAT_STORAGE_KEY);
    return SCANNER_DATE_FORMAT_OPTIONS.includes(stored as ScannerDateFormat)
      ? (stored as ScannerDateFormat)
      : "DD/MM/YYYY";
  } catch {
    return "DD/MM/YYYY";
  }
}

function storeScannerDateFormat(format: ScannerDateFormat) {
  try {
    window.localStorage.setItem(SCANNER_DATE_FORMAT_STORAGE_KEY, format);
  } catch {
    // Storage may be unavailable (private mode, quotas); the in-memory
    // preference still applies for this session.
  }
}

interface ScannerDateEditorProps {
  draft: ScannerDraft;
  entryNumber: number;
  dateFormat: ScannerDateFormat;
  disabled: boolean;
  onCommit: (transactionId: string, enteredText: string) => void;
  onCalendarSelection: (transactionId: string, pickerValue: string) => void;
  onEditingChange: (transactionId: string, dirty: boolean) => void;
  onFieldBlur: (transactionId: string) => void;
  /** Draft-level date error element to link via aria-describedby, if any. */
  fieldErrorId: string | null;
}

/**
 * Buffered scanner date editor with an optional native calendar picker.
 * Keystrokes stay local so the entry never regroups mid-edit; a finished
 * manual edit commits once on Enter or blur under the selected display
 * format (committed dates are always internal ISO YYYY-MM-DD). The
 * calendar button opens a separate selection-only native date input via
 * showPicker() where available: opening or cancelling it changes
 * nothing, and only a complete picker selection (or explicit clear)
 * commits, exactly once. Invalid or incomplete text is preserved
 * verbatim with an inline error, Escape restores the last committed
 * date, and clearing the field returns the entry to Needs Date Review.
 */
function ScannerDateEditor({
  draft,
  entryNumber,
  dateFormat,
  disabled,
  onCommit,
  onCalendarSelection,
  onEditingChange,
  onFieldBlur,
  fieldErrorId,
}: ScannerDateEditorProps) {
  const committedText = formatScannerDateForDisplay(draft.date, dateFormat);
  const [text, setText] = useState(committedText);
  const [editing, setEditing] = useState(false);
  const [showError, setShowError] = useState(
    () => resolveScannerDateEdit(committedText, dateFormat).status === "invalid",
  );
  const [pickerUnavailable, setPickerUnavailable] = useState(false);
  const cancelNextCommitRef = useRef(false);
  const textInputRef = useRef<HTMLInputElement | null>(null);
  const pendingSelectionRef = useRef<{ text: string; start: number; end: number } | null>(null);
  const pickerRef = useRef<HTMLInputElement | null>(null);
  const calendarButtonRef = useRef<HTMLButtonElement | null>(null);
  const errorId = `scanner-date-error-${draft.transactionId}`;
  const hintId = `scanner-date-hint-${draft.transactionId}`;

  // Follow external changes (rescan, regroup, format switch) only while
  // the user is not actively editing this field.
  useEffect(() => {
    if (!editing) {
      pendingSelectionRef.current = null;
      setText(committedText);
      setShowError(resolveScannerDateEdit(committedText, dateFormat).status === "invalid");
    }
  }, [committedText, dateFormat, editing]);

  // Restore the caret mapped through smart formatting before paint, so a
  // reformatted value does not leave the cursor at the end of the input.
  useLayoutEffect(() => {
    const pending = pendingSelectionRef.current;
    if (!pending) return;
    pendingSelectionRef.current = null;
    const input = textInputRef.current;
    if (!input || document.activeElement !== input || input.value !== pending.text || text !== pending.text) {
      return;
    }
    try {
      input.setSelectionRange(pending.start, pending.end);
    } catch {
      // Some mobile browsers restrict selection APIs; leave their caret as-is.
    }
  }, [text]);

  const finishEditing = () => {
    pendingSelectionRef.current = null;
    if (cancelNextCommitRef.current) {
      cancelNextCommitRef.current = false;
      return;
    }
    setEditing(false);
    setShowError(resolveScannerDateEdit(text, dateFormat).status === "invalid");
    onEditingChange(draft.transactionId, false);
    if (text !== committedText) onCommit(draft.transactionId, text);
    onFieldBlur(draft.transactionId);
  };

  const openCalendar = () => {
    const picker = pickerRef.current;
    if (!picker || disabled) return;
    // Seed from the committed ISO date only; never reinterpret typed text.
    picker.value =
      resolveScannerDateEdit(draft.date, "YYYY-MM-DD").status === "valid" ? draft.date : "";
    try {
      if (typeof picker.showPicker === "function") {
        picker.showPicker();
      } else {
        setPickerUnavailable(true);
      }
    } catch {
      setPickerUnavailable(true);
    }
  };

  const handlePickerChange = (value: string) => {
    pendingSelectionRef.current = null;
    if (value && resolveScannerDateEdit(value, "YYYY-MM-DD").status !== "valid") {
      // A native picker should never report this; preserve manual text.
      return;
    }
    setText(value ? formatScannerDateForDisplay(value, dateFormat) : "");
    setShowError(false);
    setPickerUnavailable(false);
    setEditing(false);
    onEditingChange(draft.transactionId, false);
    onCalendarSelection(draft.transactionId, value);
    onFieldBlur(draft.transactionId);
  };

  return (
    <>
      <div className="scanner-date-editor">
        <input
          ref={textInputRef}
          id={`scanner-date-${draft.transactionId}`}
          className="input scanner-edit-input"
          type="text"
          value={text}
          disabled={disabled}
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          placeholder={dateFormat}
          aria-label={`Date for entry ${entryNumber}`}
          aria-invalid={showError || fieldErrorId !== null}
          aria-describedby={
            [hintId, showError ? errorId : null, fieldErrorId]
              .filter(Boolean)
              .join(" ") || undefined
          }
          onFocus={() => {
            cancelNextCommitRef.current = false;
            setEditing(true);
            setShowError(false);
          }}
          onChange={(event) => {
            const input = event.currentTarget;
            const enteredText = input.value;
            const nextText = formatScannerDateInput(enteredText, dateFormat, text);
            pendingSelectionRef.current =
              nextText !== enteredText &&
              input.selectionStart !== null &&
              input.selectionEnd !== null
                ? {
                    text: nextText,
                    ...mapScannerDateInputSelection(
                      enteredText,
                      nextText,
                      input.selectionStart,
                      input.selectionEnd,
                    ),
                  }
                : null;
            setText(nextText);
            setShowError(false);
            setPickerUnavailable(false);
            onEditingChange(draft.transactionId, nextText !== committedText);
          }}
          onBlur={(event) => {
            pendingSelectionRef.current = null;
            // Moving focus to this editor's own calendar button is not a
            // finished edit; the manual text must survive picker use.
            if (
              event.relatedTarget === calendarButtonRef.current ||
              event.relatedTarget === pickerRef.current
            ) {
              return;
            }
            finishEditing();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              finishEditing();
              event.currentTarget.blur();
            } else if (event.key === "Escape") {
              event.preventDefault();
              pendingSelectionRef.current = null;
              cancelNextCommitRef.current = true;
              setText(committedText);
              setShowError(false);
              setEditing(false);
              onEditingChange(draft.transactionId, false);
              event.currentTarget.blur();
            }
          }}
        />
        <button
          ref={calendarButtonRef}
          className="scanner-date-picker-btn"
          type="button"
          disabled={disabled}
          aria-label={`Choose date from calendar for entry ${entryNumber}`}
          title="Choose date from calendar"
          onClick={openCalendar}
        >
          <svg
            viewBox="0 0 24 24"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
          >
            <rect x="3.5" y="5" width="17" height="16" rx="2" />
            <path d="M3.5 9.5h17M8 3v4M16 3v4" />
          </svg>
        </button>
        <input
          ref={pickerRef}
          className="scanner-date-picker-proxy"
          type="date"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => handlePickerChange(event.target.value)}
        />
      </div>
      {/* Visually hidden: the format is already explained once at the
          date-format control above the entries; screen readers still get
          it per entry through aria-describedby. */}
      <span className="sr-only" id={hintId}>Format: {dateFormat}</span>
      {pickerUnavailable && (
        <span className="field-hint">
          Calendar is not available in this browser. Type the date as {dateFormat}.
        </span>
      )}
      {showError && (
        <span className="scanner-date-error" id={errorId}>
          Enter a real date as {dateFormat}, or clear the field.
        </span>
      )}
    </>
  );
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
  const [dirtyDateEditIds, setDirtyDateEditIds] = useState<ReadonlySet<string>>(new Set());
  const [dateFormat, setDateFormat] = useState<ScannerDateFormat>(loadScannerDateFormat);
  const [batchId, setBatchId] = useState("");
  const [reviewRecordType, setReviewRecordType] = useState<ScannerRecordType>("expenses");
  const [saveAttempted, setSaveAttempted] = useState(false);
  // Fields the reviewer has edited and left, keyed `${transactionId}:${field}`.
  // Their validation errors show immediately; untouched fields stay quiet
  // until a save attempt, so a fresh scan never opens covered in errors.
  const [touchedFields, setTouchedFields] = useState<ReadonlySet<string>>(new Set());
  // Which review cards are expanded, keyed by stable transactionId.
  // Collapse only hides the card body (inputs stay mounted), so edited
  // values and partially entered dates are never lost by collapsing.
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set());
  const [confirmingSave, setConfirmingSave] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saveOutcome, setSaveOutcome] = useState<"saved" | "already-saved" | null>(null);
  // Comparison key the reviewer acknowledged a written-total difference
  // for. Keyed to the exact figures compared, so any relevant edit,
  // direction change, or removal automatically invalidates it.
  const [acknowledgedGrandTotalKey, setAcknowledgedGrandTotalKey] = useState<string | null>(null);

  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const draftDiscardPanelRef = useRef<HTMLDivElement | null>(null);
  const liveConfirmPanelRef = useRef<HTMLDivElement | null>(null);
  const liveConfirmTriggerRef = useRef<HTMLElement | null>(null);
  const saveConfirmPanelRef = useRef<HTMLDivElement | null>(null);
  const saveConfirmTriggerRef = useRef<HTMLElement | null>(null);
  const scanButtonRef = useRef<HTMLButtonElement | null>(null);
  const reviewSaveButtonRef = useRef<HTMLButtonElement | null>(null);
  const errorSummaryRef = useRef<HTMLDivElement | null>(null);
  const focusErrorSummaryRef = useRef(false);
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

  // Persist only the scanner date-format preference (no financial data).
  useEffect(() => {
    storeScannerDateFormat(dateFormat);
  }, [dateFormat]);

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

  // Same focus treatment for the live-send confirmation: focus moves into
  // the panel when it opens and returns to the control that opened it
  // (or the scan button, if that control has unmounted) when it closes.
  useEffect(() => {
    if (!confirmingLiveSend) return;
    const panel = liveConfirmPanelRef.current;
    if (!panel) return;
    const trigger = liveConfirmTriggerRef.current;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    panel.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
    panel.focus({ preventScroll: true });
    return () => {
      if (trigger && document.contains(trigger)) trigger.focus();
      else scanButtonRef.current?.focus();
    };
  }, [confirmingLiveSend]);

  // Same for the final-save confirmation; if the "Review final save"
  // button unmounted because the batch saved, focus lands on the results
  // heading above the success message instead of being lost.
  useEffect(() => {
    if (!confirmingSave) return;
    const panel = saveConfirmPanelRef.current;
    if (!panel) return;
    const trigger = saveConfirmTriggerRef.current;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    panel.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
    panel.focus({ preventScroll: true });
    return () => {
      if (trigger && document.contains(trigger)) trigger.focus();
      else if (reviewSaveButtonRef.current) reviewSaveButtonRef.current.focus();
      else
        document
          .querySelector<HTMLElement>("[data-scanner-results-heading]")
          ?.focus();
    };
  }, [confirmingSave]);

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
    setTouchedFields(new Set());
    setExpandedIds(new Set());
    setPendingRemovalId(null);
    setBatchId("");
    setSaveAttempted(false);
    setConfirmingSave(false);
    setSaveError("");
    setSaveOutcome(null);
    setAcknowledgedGrandTotalKey(null);
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
          liveConfirmTriggerRef.current =
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null;
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
      const nextDrafts = buildScannerDrafts(nextResult, requestRecordType, nextBatchId);
      setDrafts(nextDrafts);
      // Entries needing attention start expanded. Valid entries start
      // expanded on wide screens and collapsed on narrow ones, where a
      // fully expanded review becomes excessively long.
      const wideScreen = window.innerWidth > 900;
      setExpandedIds(
        new Set(
          nextDrafts
            .filter((draft) => wideScreen || requiresExplicitConfirmation(draft))
            .map((draft) => draft.transactionId),
        ),
      );
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
  const draftFieldErrors = useMemo<Map<string, ScannerDraftFieldErrors>>(
    () =>
      new Map(
        drafts.map((draft) => [
          draft.transactionId,
          result ? validateScannerDraftFields(draft, reviewContext) : {},
        ]),
      ),
    // reviewContext is intentionally rebuilt from its primitive inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [drafts, result, batchId, profileId, activeProfile?.kind, bucketId, expectedCurrency, reviewRecordType],
  );
  const invalidDrafts = drafts.filter(
    (draft) => (draftErrors.get(draft.transactionId) ?? []).length > 0,
  );

  // After a failed save attempt, move focus to the error summary so
  // keyboard and screen-reader users land on the list of problems.
  useEffect(() => {
    if (!focusErrorSummaryRef.current) return;
    if (!saveAttempted || invalidDraftCount === 0) return;
    focusErrorSummaryRef.current = false;
    errorSummaryRef.current?.focus();
  }, [saveAttempted, invalidDraftCount]);

  function markFieldTouched(transactionId: string, field: ScannerDraftField) {
    setTouchedFields((current) => {
      const key = `${transactionId}:${field}`;
      if (current.has(key)) return current;
      const next = new Set(current);
      next.add(key);
      return next;
    });
  }

  function fieldErrorsVisible(transactionId: string, field: ScannerDraftField): string[] {
    if (!saveAttempted && !touchedFields.has(`${transactionId}:${field}`)) return [];
    return draftFieldErrors.get(transactionId)?.[field] ?? [];
  }

  function focusFirstInvalidField(draft: ScannerDraft) {
    const fields = draftFieldErrors.get(draft.transactionId) ?? {};
    const order: ScannerDraftField[] = [
      "description",
      "type",
      "amount",
      "date",
      "category",
      "confirmation",
      "entry",
    ];
    // Collapsed card bodies are hidden, so expand before focusing.
    expandEntries([draft.transactionId]);
    for (const field of order) {
      if ((fields[field] ?? []).length === 0) continue;
      const targetId =
        field === "confirmation" || field === "entry"
          ? `scanner-confirm-${draft.transactionId}`
          : `scanner-${field}-${draft.transactionId}`;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          document.getElementById(targetId)?.focus();
        });
      });
      return;
    }
  }
  const draftTotals = useMemo(
    () => scannerDraftTotals(drafts, expectedCurrency),
    [drafts, expectedCurrency],
  );
  const draftGroups = useMemo(
    () => scannerDraftDateGroups(drafts, reviewRecordType, expectedCurrency),
    [drafts, reviewRecordType, expectedCurrency],
  );
  const grandTotalReconciliation = useMemo(
    () =>
      scannerGrandTotalReconciliation(
        drafts,
        result?.documentTotalText,
        result?.documentTotalMinor,
        expectedCurrency,
      ),
    [drafts, result, expectedCurrency],
  );
  const grandTotalAcknowledged = scannerGrandTotalAcknowledgmentSatisfied(
    grandTotalReconciliation,
    acknowledgedGrandTotalKey,
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

  const handleDateEditingChange = useCallback((transactionId: string, dirty: boolean) => {
    setDirtyDateEditIds((current) => {
      if (dirty === current.has(transactionId)) return current;
      const next = new Set(current);
      if (dirty) next.add(transactionId);
      else next.delete(transactionId);
      return next;
    });
  }, []);

  // Drop edit locks for entries that no longer exist.
  useEffect(() => {
    setDirtyDateEditIds((current) => {
      if (current.size === 0) return current;
      const ids = new Set(drafts.map((draft) => draft.transactionId));
      const next = new Set([...current].filter((id) => ids.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [drafts]);

  // Drop expansion state for entries that no longer exist.
  useEffect(() => {
    setExpandedIds((current) => {
      if (current.size === 0) return current;
      const ids = new Set(drafts.map((draft) => draft.transactionId));
      const next = new Set([...current].filter((id) => ids.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [drafts]);

  function toggleEntryExpanded(transactionId: string) {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(transactionId)) next.delete(transactionId);
      else next.add(transactionId);
      return next;
    });
  }

  function expandEntries(transactionIds: string[]) {
    setExpandedIds((current) => {
      const next = new Set(current);
      for (const id of transactionIds) next.add(id);
      return next;
    });
  }

  function commitDraftDate(transactionId: string, enteredText: string) {
    if (saveLocked) return;
    setConfirmingSave(false);
    setSaveError("");
    setDrafts((current) =>
      current.map((draft) =>
        draft.transactionId === transactionId
          ? applyScannerDateEdit(draft, enteredText, dateFormat)
          : draft,
      ),
    );
  }

  function commitCalendarDate(transactionId: string, pickerValue: string) {
    if (saveLocked) return;
    setConfirmingSave(false);
    setSaveError("");
    handleDateEditingChange(transactionId, false);
    setDrafts((current) =>
      current.map((draft) =>
        draft.transactionId === transactionId
          ? applyScannerCalendarSelection(draft, pickerValue)
          : draft,
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
    setTouchedFields((current) =>
      new Set([...current].filter((key) => !key.startsWith(`${transactionId}:`))),
    );
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
    if (dirtyDateEditIds.size > 0) {
      setSaveError("Finish editing the date first: press Enter or move to another field so the date can be checked.");
      return;
    }
    if (drafts.length === 0) {
      setSaveError("Remove or restore at least one entry before saving. Scan the image again to restore removed entries.");
      return;
    }
    if (invalidDraftCount > 0) {
      focusErrorSummaryRef.current = true;
      // Automatically expand every affected entry so its errors and
      // mandatory confirmations are visible and actionable.
      expandEntries(invalidDrafts.map((draft) => draft.transactionId));
      setSaveError(
        `Fix ${invalidDraftCount} ${invalidDraftCount === 1 ? "entry" : "entries"} or remove them before saving.`,
      );
      return;
    }
    if (!grandTotalAcknowledged) {
      setSaveError(
        "The written grand total does not match the reviewed entries. Tick “I checked the written-total difference” before saving.",
      );
      return;
    }
    saveConfirmTriggerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setConfirmingSave(true);
  }

  async function confirmSave() {
    if (!activeProfile || saving || saveOutcome) return;
    if (dirtyDateEditIds.size > 0) {
      setConfirmingSave(false);
      setSaveError("Finish editing the date first: press Enter or move to another field so the date can be checked.");
      return;
    }
    // Re-checked at save time so a stale confirmation panel can never
    // bypass a written-total mismatch acknowledgment.
    if (!grandTotalAcknowledged) {
      setConfirmingSave(false);
      setSaveError(
        "The written grand total does not match the reviewed entries. Tick “I checked the written-total difference” before saving.",
      );
      return;
    }
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
            <button ref={scanButtonRef} className="btn" type="button" disabled={!canExtract} onClick={onScanButtonClick}>
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
            <div
              ref={liveConfirmPanelRef}
              tabIndex={-1}
              className="scanner-confirm-panel"
              role="alertdialog"
              aria-labelledby="scanner-live-confirm-heading"
              aria-describedby="scanner-live-confirm-detail scanner-live-confirm-warning"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setConfirmingLiveSend(false);
                  setLiveTestToken("");
                }
              }}
            >
              <h3 id="scanner-live-confirm-heading">Send this image to Meta AI?</h3>
              <p id="scanner-live-confirm-detail">
                Send <strong>{fileName || "the selected image"}</strong> for{" "}
                <strong>{activeProfile?.name}</strong> as {recordType} in {expectedCurrency},
                through the local Bucketa backend.
              </p>
              <p className="scanner-warning" role="note" id="scanner-live-confirm-warning">
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
            <strong>Before you save:</strong> check every entry carefully, or
            remove entries you do not want to keep. After saving, you can
            still correct or delete each record from the history pages.
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
              <div className="scanner-date-format-control">
                <label htmlFor="scanner-date-format">Date format</label>
                <select
                  id="scanner-date-format"
                  className="input"
                  value={dateFormat}
                  disabled={saveLocked || dirtyDateEditIds.size > 0}
                  onChange={(event) => setDateFormat(event.target.value as ScannerDateFormat)}
                >
                  {SCANNER_DATE_FORMAT_OPTIONS.map((format) => (
                    <option key={format} value={format}>{format}</option>
                  ))}
                </select>
                <span className="field-hint">
                  {dirtyDateEditIds.size > 0
                    ? "Finish the current date edit before changing the format."
                    : `Dates are entered and shown as ${dateFormat}; saved dates do not change.`}
                </span>
              </div>
              <div className="scanner-entry-list">
                    {draftGroups.map((group) => {
                      const summaryParts: string[] = [];
                      if (group.summary.salesMinor !== 0) {
                        summaryParts.push(`Sales ${formatMoney(group.summary.salesMinor, expectedCurrency)}`);
                      }
                      if (group.summary.otherIncomeMinor !== 0) {
                        summaryParts.push(`Other income ${formatMoney(group.summary.otherIncomeMinor, expectedCurrency)}`);
                      }
                      if (group.summary.expensesMinor !== 0) {
                        summaryParts.push(`Expenses ${formatMoney(group.summary.expensesMinor, expectedCurrency)}`);
                      }
                      if (group.summary.salaryPaymentsMinor !== 0) {
                        summaryParts.push(`Salary payments ${formatMoney(group.summary.salaryPaymentsMinor, expectedCurrency)}`);
                      }
                      summaryParts.push(`Net ${formatMoney(group.summary.netMinor, expectedCurrency)}`);
                      return (
                        <Fragment key={group.key}>
                          <div className="scanner-date-group-card">
                              <span className="scanner-date-group-title">
                                {group.needsDateReview
                                  ? "Needs Date Review"
                                  : formatScannerDateGroupLabel(group.date ?? group.key)}
                              </span>
                              <span className="scanner-date-group-preview">
                                {group.needsDateReview
                                  ? "Provisional · Review Preview — Not Saved"
                                  : "Review Preview — Not Saved"}
                              </span>
                              <span className="scanner-date-group-summary">
                                {group.summary.entryCount}{" "}
                                {group.summary.entryCount === 1 ? "entry" : "entries"} ·{" "}
                                {summaryParts.join(" · ")}
                                {group.summary.incompleteEntries > 0
                                  ? ` · ${group.summary.incompleteEntries} incomplete — not included in totals`
                                  : ""}
                              </span>
                          </div>
                          {group.drafts.map((draft) => {
                            const index = drafts.indexOf(draft);
                            const entryNumber = index + 1;
                            const warnings = scannerReviewWarnings(draft);
                            const entryErrors = draftErrors.get(draft.transactionId) ?? [];
                            const awaitingConfirmation =
                              requiresExplicitConfirmation(draft) && !draft.explicitlyConfirmed;
                            const statusLabel =
                              entryErrors.length > 0
                                ? "Has errors"
                                : awaitingConfirmation
                                  ? "Needs review"
                                  : "Ready";
                            const statusClass =
                              entryErrors.length > 0
                                ? "scanner-entry-status is-error"
                                : awaitingConfirmation
                                  ? "scanner-entry-status is-review"
                                  : "scanner-entry-status is-ready";
                            const expanded = expandedIds.has(draft.transactionId);
                            const descriptionErrors = fieldErrorsVisible(draft.transactionId, "description");
                            const typeErrors = fieldErrorsVisible(draft.transactionId, "type");
                            const amountErrors = fieldErrorsVisible(draft.transactionId, "amount");
                            const dateErrors = fieldErrorsVisible(draft.transactionId, "date");
                            const reviewErrors = [
                              ...(saveAttempted ? (draftFieldErrors.get(draft.transactionId)?.entry ?? []) : []),
                              ...(saveAttempted ? (draftFieldErrors.get(draft.transactionId)?.confirmation ?? []) : []),
                            ];
                            return (
                              <article key={draft.transactionId} className="scanner-entry-card">
                                <div className="scanner-entry-head">
                                  <button
                                    type="button"
                                    className="scanner-entry-toggle"
                                    aria-expanded={expanded}
                                    aria-controls={`scanner-entry-body-${draft.transactionId}`}
                                    onClick={() => toggleEntryExpanded(draft.transactionId)}
                                  >
                                    <span className="scanner-entry-title">
                                      Entry {entryNumber}: {draft.description.trim() || "Untitled entry"}
                                    </span>
                                    <span className="scanner-entry-meta">
                                      {draft.type
                                        ? draft.type === "income"
                                          ? reviewRecordType === "sales"
                                            ? "Sales (Income)"
                                            : "Income"
                                          : "Expense"
                                        : "No type"}{" "}
                                      · {draft.amountText.trim()
                                        ? `${expectedCurrency} ${draft.amountText.trim()}`
                                        : "No amount"}{" "}
                                      · {draft.date
                                        ? formatScannerDateForDisplay(draft.date, dateFormat)
                                        : "No date"}
                                    </span>
                                    <span className={statusClass}>
                                      {statusLabel}
                                      {entryErrors.length > 0
                                        ? ` · ${entryErrors.length} ${entryErrors.length === 1 ? "error" : "errors"}`
                                        : ""}
                                      {warnings.length > 0
                                        ? ` · ${warnings.length} ${warnings.length === 1 ? "warning" : "warnings"}`
                                        : ""}
                                    </span>
                                    <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
                                  </button>
                                  <button
                                    className="scanner-remove-btn"
                                    type="button"
                                    disabled={saveLocked}
                                    aria-label={`Remove entry ${entryNumber}${draft.description.trim() ? `: ${draft.description.trim()}` : ""}`}
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
                                </div>
                                <div
                                  id={`scanner-entry-body-${draft.transactionId}`}
                                  className="scanner-entry-body"
                                  hidden={!expanded}
                                >
                          <div className="scanner-entry-field">
                            <span className="scanner-field-name" aria-hidden="true">Description</span>
                            <input
                              id={`scanner-description-${draft.transactionId}`}
                              className="input scanner-edit-input"
                              value={draft.description}
                              disabled={saveLocked}
                              aria-label={`Description for entry ${entryNumber}`}
                              aria-invalid={descriptionErrors.length > 0}
                              aria-describedby={descriptionErrors.length > 0 ? `scanner-description-error-${draft.transactionId}` : undefined}
                              onChange={(event) => updateDraft(draft.transactionId, { description: event.target.value })}
                              onBlur={() => markFieldTouched(draft.transactionId, "description")}
                            />
                            {descriptionErrors.length > 0 && (
                              <ul className="scanner-entry-errors" id={`scanner-description-error-${draft.transactionId}`}>
                                {descriptionErrors.map((message) => <li key={message}>{message}</li>)}
                              </ul>
                            )}
                          </div>
                          <div className="scanner-entry-field">
                            <span className="scanner-field-name" aria-hidden="true">Type</span>
                            <select
                              id={`scanner-type-${draft.transactionId}`}
                              className="input scanner-edit-input"
                              value={draft.type}
                              disabled={saveLocked || reviewRecordType === "salaries"}
                              aria-label={`Transaction type for entry ${entryNumber}`}
                              aria-invalid={typeErrors.length > 0}
                              aria-describedby={typeErrors.length > 0 ? `scanner-type-error-${draft.transactionId}` : undefined}
                              onChange={(event) => updateDraft(draft.transactionId, { type: event.target.value as ScannerEntryType })}
                              onBlur={() => markFieldTouched(draft.transactionId, "type")}
                            >
                              <option value="">Choose…</option>
                              <option value="income">{reviewRecordType === "sales" ? "Sales (Income)" : "Income"}</option>
                              <option value="expense">Expense</option>
                            </select>
                            {typeErrors.length > 0 && (
                              <ul className="scanner-entry-errors" id={`scanner-type-error-${draft.transactionId}`}>
                                {typeErrors.map((message) => <li key={message}>{message}</li>)}
                              </ul>
                            )}
                          </div>
                          <div className="scanner-entry-field">
                            <span className="scanner-field-name" aria-hidden="true">Amount ({expectedCurrency})</span>
                            <input
                              id={`scanner-amount-${draft.transactionId}`}
                              className="input scanner-edit-input"
                              value={draft.amountText}
                              disabled={saveLocked}
                              inputMode="decimal"
                              aria-label={`Amount in ${expectedCurrency} for entry ${entryNumber}`}
                              aria-invalid={amountErrors.length > 0}
                              aria-describedby={amountErrors.length > 0 ? `scanner-amount-error-${draft.transactionId}` : undefined}
                              onChange={(event) => updateDraft(draft.transactionId, { amountText: event.target.value })}
                              onBlur={() => markFieldTouched(draft.transactionId, "amount")}
                            />
                            {amountErrors.length > 0 && (
                              <ul className="scanner-entry-errors" id={`scanner-amount-error-${draft.transactionId}`}>
                                {amountErrors.map((message) => <li key={message}>{message}</li>)}
                              </ul>
                            )}
                            {draft.quantityText && draft.unitPriceMinor !== null && (
                              <span className="field-hint">
                                Scan read: {draft.quantityText} × {formatMoney(draft.unitPriceMinor, expectedCurrency)}
                                {draft.expectedAmountMinor !== null
                                  ? ` = ${formatMoney(draft.expectedAmountMinor, expectedCurrency)}`
                                  : ""}
                              </span>
                            )}
                            {draft.currencyConflict && draft.currencyDetected && (
                              <span className="field-hint">Image shows {draft.currencyDetected}; saving currency stays {expectedCurrency}.</span>
                            )}
                          </div>
                          <div className="scanner-entry-field">
                            <span className="scanner-field-name" aria-hidden="true">Date</span>
                            <ScannerDateEditor
                              draft={draft}
                              entryNumber={entryNumber}
                              dateFormat={dateFormat}
                              disabled={saveLocked}
                              onCommit={commitDraftDate}
                              onCalendarSelection={commitCalendarDate}
                              onEditingChange={handleDateEditingChange}
                              onFieldBlur={(transactionId) => markFieldTouched(transactionId, "date")}
                              fieldErrorId={dateErrors.length > 0 ? `scanner-date-field-error-${draft.transactionId}` : null}
                            />
                            {draft.dateHint && <span className="field-hint">Scan read: {draft.dateHint}</span>}
                            {dateErrors.length > 0 && (
                              <ul className="scanner-entry-errors" id={`scanner-date-field-error-${draft.transactionId}`}>
                                {dateErrors.map((message) => <li key={message}>{message}</li>)}
                              </ul>
                            )}
                          </div>
                          <div className="scanner-entry-field">
                            <span className="scanner-field-name" aria-hidden="true">Category</span>
                            <input
                              id={`scanner-category-${draft.transactionId}`}
                              className="input scanner-edit-input"
                              value={draft.category}
                              disabled={saveLocked}
                              aria-label={`Category for entry ${entryNumber}`}
                              onChange={(event) => updateDraft(draft.transactionId, { category: event.target.value })}
                              onBlur={() => markFieldTouched(draft.transactionId, "category")}
                            />
                          </div>
                          <div className="scanner-entry-field scanner-entry-review">
                            <span className="scanner-field-name" aria-hidden="true">Review</span>
                            {requiresExplicitConfirmation(draft) ? (
                              <label className="scanner-confirm-check">
                                <input
                                  id={`scanner-confirm-${draft.transactionId}`}
                                  type="checkbox"
                                  checked={draft.explicitlyConfirmed}
                                  disabled={saveLocked}
                                  aria-label={`I checked entry ${entryNumber}`}
                                  onChange={(event) => updateDraft(draft.transactionId, { explicitlyConfirmed: event.target.checked })}
                                />
                                I checked this entry
                              </label>
                            ) : (
                              <span className="scanner-ready">Ready</span>
                            )}
                            {warnings.map((warning) => (
                              <span key={warning} className="scanner-review-warnings">{warning}</span>
                            ))}
                            {reviewErrors.length > 0 && (
                              <ul className="scanner-entry-errors">
                                {reviewErrors.map((message) => <li key={message}>{message}</li>)}
                              </ul>
                            )}
                          </div>
                                </div>
                              </article>
                            );
                          })}
                        </Fragment>
                      );
                    })}
              </div>
              <dl className="scanner-totals">
                <div><dt>Income</dt><dd>{formatMoney(draftTotals.incomeMinor, expectedCurrency)}</dd></div>
                <div><dt>Expenses</dt><dd>{formatMoney(draftTotals.expenseMinor, expectedCurrency)}</dd></div>
                <div><dt>Net</dt><dd>{formatMoney(draftTotals.netMinor, expectedCurrency)}</dd></div>
                <div><dt>Counted</dt><dd>{draftTotals.countedEntries} of {drafts.length}</dd></div>
              </dl>
              {grandTotalReconciliation.status === "unreadable" ? (
                <p className="field-hint">
                  A written grand total was reported but could not be read clearly enough to compare with the reviewed entries.
                </p>
              ) : grandTotalReconciliation.documentTotalMinor !== null ? (
                <div className="scanner-reconciliation">
                  <h3>Written total check</h3>
                  {grandTotalReconciliation.reviewedEntryTotalMinor !== null && grandTotalReconciliation.differenceMinor !== null ? (
                    <>
                      <dl className="scanner-totals">
                        <div><dt>Written grand total</dt><dd>{formatMoney(grandTotalReconciliation.documentTotalMinor, expectedCurrency)}</dd></div>
                        <div><dt>Reviewed entry total</dt><dd>{formatMoney(grandTotalReconciliation.reviewedEntryTotalMinor, expectedCurrency)}</dd></div>
                        <div><dt>Difference</dt><dd>{formatMoney(Math.abs(grandTotalReconciliation.differenceMinor), expectedCurrency)}</dd></div>
                        {grandTotalReconciliation.quantityComparisonAvailable && grandTotalReconciliation.quantityTotalMinor !== null && grandTotalReconciliation.quantityDifferenceMinor !== null ? (
                          <>
                            <div><dt>Quantity × price total</dt><dd>{formatMoney(grandTotalReconciliation.quantityTotalMinor, expectedCurrency)}</dd></div>
                            <div><dt>Difference</dt><dd>{formatMoney(Math.abs(grandTotalReconciliation.quantityDifferenceMinor), expectedCurrency)}</dd></div>
                          </>
                        ) : null}
                      </dl>
                      {grandTotalReconciliation.quantityComparisonAvailable ? null : (
                        <p className="field-hint">Quantity × price comparison is unavailable because not every entry has a readable quantity and unit price.</p>
                      )}
                      {grandTotalReconciliation.mismatch ? (
                        <>
                          <p className="scanner-warning" role="alert">
                            The written total does not match the reviewed entries. Check for missing items, incorrect amounts, discounts, fees, taxes, or writing errors.
                          </p>
                          <label className="scanner-confirm-check">
                            <input
                              type="checkbox"
                              checked={grandTotalAcknowledged}
                              disabled={saveLocked}
                              onChange={(event) =>
                                setAcknowledgedGrandTotalKey(
                                  event.target.checked
                                    ? grandTotalReconciliation.comparisonKey
                                    : null,
                                )
                              }
                            />
                            I checked the written-total difference.
                          </label>
                        </>
                      ) : (
                        <p className="field-hint">The written grand total matches the reviewed entries.</p>
                      )}
                    </>
                  ) : (
                    <p className="field-hint">
                      The written grand total cannot be compared yet because the reviewed entries do not share one income or expense direction, or an amount still needs attention.
                    </p>
                  )}
                </div>
              ) : null}
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
              {saveAttempted && invalidDraftCount > 0 && (
                <div
                  ref={errorSummaryRef}
                  tabIndex={-1}
                  className="scanner-error-summary"
                  role="alert"
                  aria-labelledby="scanner-error-summary-heading"
                >
                  <h3 id="scanner-error-summary-heading">
                    Fix {invalidDraftCount} {invalidDraftCount === 1 ? "entry" : "entries"} before saving
                  </h3>
                  <ul>
                    {invalidDrafts.map((draft) => (
                      <li key={draft.transactionId}>
                        <strong>Entry {drafts.indexOf(draft) + 1}:</strong>{" "}
                        {(draftErrors.get(draft.transactionId) ?? []).join(" ")}{" "}
                        <button
                          className="btn ghost small"
                          type="button"
                          onClick={() => focusFirstInvalidField(draft)}
                        >
                          Go to entry {drafts.indexOf(draft) + 1}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
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
                <div
                  ref={saveConfirmPanelRef}
                  tabIndex={-1}
                  className="scanner-confirm-panel"
                  role="alertdialog"
                  aria-labelledby="scanner-save-confirm-heading"
                  aria-describedby="scanner-save-confirm-detail scanner-save-confirm-warning"
                  onKeyDown={(event) => {
                    if (event.key === "Escape" && !saving) {
                      event.preventDefault();
                      setConfirmingSave(false);
                    }
                  }}
                >
                  <h3 id="scanner-save-confirm-heading">Confirm final save</h3>
                  <p id="scanner-save-confirm-detail">
                    Save {drafts.length} {drafts.length === 1 ? "entry" : "entries"} to{" "}
                    {activeProfile?.name}
                    {activeBucket ? `, bucket “${activeBucket.name}”` : ""}, in {expectedCurrency}.
                    This saves the whole batch at once, or nothing at all.
                  </p>
                  <p className="scanner-warning" role="note" id="scanner-save-confirm-warning">
                    If you spot a mistake later, each saved record can be
                    corrected or deleted from the history pages.
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
                  <button ref={reviewSaveButtonRef} className="btn" type="button" disabled={saving || drafts.length === 0} onClick={requestSaveConfirmation}>
                    Review final save
                  </button>
                  {grandTotalReconciliation.mismatch && !grandTotalAcknowledged && (
                    <span className="field-hint">Check the written-total difference above to continue.</span>
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

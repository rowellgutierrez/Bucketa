import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { bucketsRepo, profilesRepo, transactionsRepo } from "../data/db";
import type { Bucket, BucketKind, Profile, Transaction } from "../data/types";
import {
  BucketaDataError,
  newId,
  nowIso,
  validateBucket,
  validateProfile,
  validateTransaction,
} from "../data/validation";
import { DEFAULT_CURRENCY, DEFAULT_LOCALE } from "../config";
import {
  FEATURED_CURRENCIES,
  formatMoney,
  isValidCurrency,
  minorUnitsToAmountInput,
  parseAmountToMinorUnits,
} from "../lib/currency";
import {
  bucketGoalProgress,
  bucketSavedMinor,
  savingsMovementError,
  summarizeTransactions,
  type SavingsMovementType,
} from "../lib/finance";
import GettingStarted from "../components/GettingStarted";
import {
  amountOf,
  amountsForEdit,
  bucketCurrencyMismatch,
  emptyRecordAmounts,
  isValidCalendarDate,
  planSaveAmounts,
  plannedEntryTypes,
  withAmount,
  type PlannedEntry,
  type RecordAmounts,
} from "../lib/recordForm";
import Bucky from "../components/Bucky";
import {
  buildTransactionCorrectionPatch,
  isCorrectableTransaction,
  isScannerConfirmedTransaction,
} from "../lib/transactionCorrection";

type Status = "loading" | "ready" | "error";
type EntryType = "income" | "expense";

const KIND_LABELS: Record<BucketKind, string> = {
  savings: "Savings",
  budget: "Budget",
  allocated: "Allocated",
};

const TXN_TYPE_LABELS: Record<Transaction["type"], string> = {
  income: "Income",
  expense: "Expense",
  transfer: "Transfer",
  sale: "Sale",
  "savings-deposit": "Savings deposit",
  "savings-withdrawal": "Savings withdrawal",
};

function errorMessage(error: unknown): string {
  if (error instanceof BucketaDataError || error instanceof Error) return error.message;
  return "Something went wrong. Please try again.";
}
function isCurrency(value: string): boolean {
  return /^[A-Z]{3}$/.test(value) && isValidCurrency(value);
}
function todayInputValue(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
function formatDate(value: string): string {
  const date = new Date(`${value.slice(0, 10)}T00:00:00`);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(DEFAULT_LOCALE, { dateStyle: "medium" }).format(date);
}
function sortTxns(list: Transaction[]): Transaction[] {
  return [...list].sort(
    (a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt),
  );
}

export default function PersonalPage() {
  const [status, setStatus] = useState<Status>("loading");
  const [loadError, setLoadError] = useState("");
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profileId, setProfileId] = useState("");
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [notice, setNotice] = useState("");
  const [pageError, setPageError] = useState("");

  // Personal profile form.
  const [showProfileForm, setShowProfileForm] = useState(false);
  const [profileName, setProfileName] = useState("");
  const [profileCurrency, setProfileCurrency] = useState<string>(DEFAULT_CURRENCY);
  const [profileFormError, setProfileFormError] = useState("");

  // Record form.
  const [showRecordForm, setShowRecordForm] = useState(false);
  const [editingTxnId, setEditingTxnId] = useState("");
  const [type, setType] = useState<EntryType>("expense");
  const [amounts, setAmounts] = useState<RecordAmounts>(emptyRecordAmounts);
  const [currency, setCurrency] = useState<string>(DEFAULT_CURRENCY);
  const [category, setCategory] = useState("");
  const [date, setDate] = useState(todayInputValue);
  const [description, setDescription] = useState("");
  const [bucketId, setBucketId] = useState("");
  const [recordErrors, setRecordErrors] = useState<Record<string, string>>({});
  const [recordError, setRecordError] = useState("");
  const [savingRecord, setSavingRecord] = useState(false);

  // Savings / budget bucket form.
  const [showBucketForm, setShowBucketForm] = useState(false);
  const [editingBucketId, setEditingBucketId] = useState("");
  const [bucketName, setBucketName] = useState("");
  const [bucketKind, setBucketKind] = useState<BucketKind>("savings");
  const [bucketCurrency, setBucketCurrency] = useState<string>(DEFAULT_CURRENCY);
  const [bucketTarget, setBucketTarget] = useState("");
  const [celebrateKey, setCelebrateKey] = useState(0);
  const [bucketFormError, setBucketFormError] = useState("");
  const [savingBucket, setSavingBucket] = useState(false);

  // Savings deposit / withdrawal form for one savings bucket.
  const [movementBucketId, setMovementBucketId] = useState("");
  const [movementType, setMovementType] = useState<SavingsMovementType>("savings-deposit");
  const [movementAmount, setMovementAmount] = useState("");
  const [movementDate, setMovementDate] = useState(todayInputValue);
  const [movementError, setMovementError] = useState("");
  const [savingMovement, setSavingMovement] = useState(false);

  // Category management.
  const [renamingCategory, setRenamingCategory] = useState("");
  const [renameCategoryValue, setRenameCategoryValue] = useState("");
  const [categoryError, setCategoryError] = useState("");
  const [clearCategoryTarget, setClearCategoryTarget] = useState("");

  // Personal history filter and section navigation.
  const [historyFilter, setHistoryFilter] = useState<"all" | "income" | "expense" | "savings">("all");
  const historyRef = useRef<HTMLElement | null>(null);
  const recordFormRef = useRef<HTMLFormElement | null>(null);

  // Delete confirmations.
  const [deleteTxn, setDeleteTxn] = useState<Transaction | null>(null);
  const [deleteBucket, setDeleteBucket] = useState<Bucket | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const deleteTxnPanelRef = useRef<HTMLElement | null>(null);

  // Move focus into the record-delete confirmation when it opens and
  // return it to the invoking control when it closes, mirroring the
  // scanner confirmation pattern. Escape (handled on the panel) only
  // ever cancels, and never while a deletion is in progress. The bucket
  // delete panel intentionally keeps its existing behaviour.
  useEffect(() => {
    if (!deleteTxn) return;
    const panel = deleteTxnPanelRef.current;
    if (!panel) return;
    const trigger =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.focus();
    return () => {
      if (trigger && document.contains(trigger)) trigger.focus();
    };
  }, [deleteTxn]);

  const activeProfile = profiles.find((p) => p.id === profileId);
  const editingTxn = editingTxnId
    ? transactions.find((t) => t.id === editingTxnId) ?? null
    : null;
  const editingScannerRecord =
    editingTxn !== null && isScannerConfirmedTransaction(editingTxn);
  const movementBucket = buckets.find((b) => b.id === movementBucketId);
  const summaries = useMemo(() => summarizeTransactions(transactions), [transactions]);
  const categories = useMemo(() => {
    const map = new Map<string, number>();
    for (const txn of transactions) {
      if (txn.category?.trim()) map.set(txn.category, (map.get(txn.category) ?? 0) + 1);
    }
    return [...map.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [transactions]);

  const incomeExpenseCount = transactions.filter(
    (t) => t.type === "income" || t.type === "expense",
  ).length;
  const filteredTransactions = transactions.filter((t) => {
    if (historyFilter === "all") return true;
    if (historyFilter === "savings") {
      return t.type === "savings-deposit" || t.type === "savings-withdrawal";
    }
    return t.type === historyFilter;
  });

  function scrollToElement(element: HTMLElement | null) {
    if (!element) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    element.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  }

  function viewRecords(filter: typeof historyFilter) {
    setHistoryFilter(filter);
    requestAnimationFrame(() => scrollToElement(historyRef.current));
  }

  function bucketAssigned(bucket: Bucket): Transaction[] {
    return transactions.filter((t) => t.bucketId === bucket.id);
  }
  function bucketCashFlows(bucket: Bucket) {
    return summarizeTransactions(bucketAssigned(bucket));
  }

  async function loadProfileData(forProfileId: string) {
    const [personalBuckets, personalTransactions] = await Promise.all([
      bucketsRepo.listByProfile(forProfileId),
      transactionsRepo.listByProfile(forProfileId),
    ]);
    setBuckets(
      [...personalBuckets].sort(
        (a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name),
      ),
    );
    setTransactions(sortTxns(personalTransactions));
  }

  async function load(preferredProfileId = "") {
    setStatus("loading");
    setLoadError("");
    try {
      const all = await profilesRepo.listAll();
      const personal = all
        .filter((p) => p.kind === "personal")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name));
      setProfiles(personal);
      const selected = personal.find((p) => p.id === preferredProfileId) ?? personal[0];
      if (selected) {
        setProfileId(selected.id);
        await loadProfileData(selected.id);
      } else {
        setProfileId("");
        setBuckets([]);
        setTransactions([]);
        setShowProfileForm(true);
      }
      setStatus("ready");
    } catch (error) {
      setStatus("error");
      setLoadError(errorMessage(error));
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function switchProfile(id: string) {
    if (id === profileId) return;
    setProfileId(id);
    setNotice("");
    setPageError("");
    setShowRecordForm(false);
    setEditingTxnId("");
    setShowBucketForm(false);
    setEditingBucketId("");
    setDeleteTxn(null);
    setDeleteBucket(null);
    try {
      await loadProfileData(id);
    } catch (error) {
      setPageError(errorMessage(error));
      setBuckets([]);
      setTransactions([]);
    }
  }

  async function onCreateProfile(event: FormEvent) {
    event.preventDefault();
    const trimmed = profileName.trim();
    const normalized = profileCurrency.trim().toUpperCase();
    if (!trimmed) {
      setProfileFormError("Your name for this personal profile is required.");
      return;
    }
    if (!isCurrency(normalized)) {
      setProfileFormError("Enter a valid ISO 4217 currency code, e.g. PHP.");
      return;
    }
    const stamp = nowIso();
    const profile: Profile = {
      id: newId(), kind: "personal", name: trimmed, currency: normalized,
      createdAt: stamp, updatedAt: stamp,
    };
    try {
      validateProfile(profile);
      await profilesRepo.create(profile);
      setProfiles((prev) => [...prev, profile]);
      setProfileId(profile.id);
      setBuckets([]);
      setTransactions([]);
      setCurrency(normalized);
      setProfileName("");
      setProfileFormError("");
      setShowProfileForm(false);
      setNotice(`Personal profile “${profile.name}” created. Business records are kept separate.`);
    } catch (error) {
      setProfileFormError(errorMessage(error));
    }
  }

  function resetRecordForm(nextCurrency: string) {
    setEditingTxnId("");
    setType("expense");
    setAmounts(emptyRecordAmounts());
    setCurrency(nextCurrency);
    setCategory("");
    setDate(todayInputValue());
    setDescription("");
    setBucketId("");
    setRecordErrors({});
    setRecordError("");
  }

  function startEditTxn(txn: Transaction) {
    setEditingTxnId(txn.id);
    setType(txn.type as EntryType);
    setCurrency(txn.currency);
    try {
      setAmounts(
        amountsForEdit(
          txn.type as EntryType,
          minorUnitsToAmountInput(txn.amountMinor, txn.currency),
        ),
      );
    } catch {
      setAmounts(emptyRecordAmounts());
    }
    setCategory(txn.category ?? "");
    setDate(txn.date.slice(0, 10));
    setDescription(txn.description);
    setBucketId(txn.bucketId ?? "");
    setRecordErrors({});
    setRecordError("");
    setDeleteTxn(null);
    setShowRecordForm(true);
    // Bring the form to the user; Edit was clicked far below it.
    requestAnimationFrame(() => scrollToElement(recordFormRef.current));
  }

  async function onSaveRecord(event: FormEvent) {
    event.preventDefault();
    if (!activeProfile) return;
    const errors: Record<string, string> = {};
    // A scanned record's currency is locked: corrections always keep the
    // currency the record was saved in, whatever the form state holds.
    const normalized =
      editingScannerRecord && editingTxn
        ? editingTxn.currency
        : currency.trim().toUpperCase();
    const trimmedDescription = description.trim();
    let amountMinor: number | null = null;
    let planned: PlannedEntry[] = [];
    if (!isCurrency(normalized)) {
      errors.currency = "Enter a valid ISO 4217 currency code, e.g. PHP.";
    } else if (editingTxnId) {
      try {
        amountMinor = parseAmountToMinorUnits(amountOf(amounts, type), normalized);
        if (amountMinor <= 0) errors.amount = "Amount must be greater than zero.";
      } catch (error) {
        errors.amount = errorMessage(error);
      }
    } else {
      // Create mode: validate BOTH entered sides before saving anything.
      const plan = planSaveAmounts(amounts, normalized);
      if (!plan.ok) errors.amount = plan.message;
      else planned = plan.entries;
    }
    if (!trimmedDescription) errors.description = "Description is required.";
    if (!isValidCalendarDate(date)) {
      errors.date = "Enter a valid date.";
    }
    const selectedBucket = bucketId ? buckets.find((b) => b.id === bucketId) : undefined;
    if (bucketId && !selectedBucket) {
      errors.bucket = "That savings or budget bucket does not belong to this personal profile.";
    } else if (selectedBucket) {
      const mismatch = bucketCurrencyMismatch(selectedBucket.currency, normalized);
      if (mismatch) errors.bucket = mismatch;
    }
    setRecordErrors(errors);
    if (Object.keys(errors).length > 0) return;
    if (editingTxnId && amountMinor === null) return;
    if (!editingTxnId && planned.length === 0) return;
    if (savingRecord) return;

    setSavingRecord(true);
    try {
      if (editingTxnId) {
        if (!editingTxn || !isCorrectableTransaction(editingTxn)) {
          setRecordError("This record cannot be edited here.");
          return;
        }
        if (amountMinor === null || !Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
          setRecordError("Enter a valid amount greater than zero.");
          return;
        }
        const validAmountMinor = amountMinor;
        // The patch builder preserves provenance: for scanned records it
        // omits currency and bucketId so neither can change here, and it
        // never carries id, profileId, origin, or relatedId.
        const updated = await transactionsRepo.update(
          editingTxnId,
          buildTransactionCorrectionPatch(editingTxn, {
            type,
            amountMinor: validAmountMinor,
            currency: normalized,
            date,
            description: trimmedDescription,
            category: category.trim() || null,
            bucketId: bucketId || null,
          }),
        );
        setTransactions((prev) => sortTxns(prev.map((t) => (t.id === updated.id ? updated : t))));
        setNotice("Personal record updated.");
        setCelebrateKey((k) => k + 1);
      } else {
        // One transaction per entered side, each with its own type/amount.
        const created: Transaction[] = [];
        let failed: { type: EntryType; message: string } | null = null;
        for (const entry of planned) {
          const stamp = nowIso();
          const txn: Transaction = {
            id: newId(), profileId: activeProfile.id, bucketId: bucketId || null,
            type: entry.type, amountMinor: entry.amountMinor, currency: normalized, date,
            description: trimmedDescription, category: category.trim() || null,
            origin: "manual", relatedId: null, createdAt: stamp, updatedAt: stamp,
          };
          try {
            validateTransaction(txn);
            await transactionsRepo.create(txn);
            created.push(txn);
          } catch (error) {
            failed = { type: entry.type, message: errorMessage(error) };
            break;
          }
        }
        if (created.length > 0) {
          setTransactions((prev) => sortTxns([...created, ...prev]));
        }
        if (failed) {
          // Keep only the unsaved sides in the form; never claim both saved.
          const savedTypes = new Set(created.map((t) => t.type));
          setAmounts((prev) => ({
            income: savedTypes.has("income") ? "" : prev.income,
            expense: savedTypes.has("expense") ? "" : prev.expense,
          }));
          setRecordError(
            created.length > 0
              ? `${created.map((t) => (t.type === "income" ? "Income" : "Expense")).join(", ")} saved, but the ${failed.type} entry could not be saved: ${failed.message} It is still entered above — fix it and save again.`
              : `Could not save the ${failed.type} entry: ${failed.message} Nothing was saved.`,
          );
          return;
        }
        setNotice(
          created.length === 2
            ? "2 personal records added (income and expense)."
            : "Personal record added.",
        );
        setCelebrateKey((k) => k + 1);
      }
      resetRecordForm(activeProfile.currency);
      setShowRecordForm(false);
    } catch (error) {
      setRecordError(errorMessage(error));
    } finally {
      setSavingRecord(false);
    }
  }

  function startEditBucket(bucket: Bucket) {
    setEditingBucketId(bucket.id);
    setBucketName(bucket.name);
    setBucketKind(bucket.kind);
    setBucketCurrency(bucket.currency);
    setBucketTarget(
      bucket.targetMinor ? minorUnitsToAmountInput(bucket.targetMinor, bucket.currency) : "",
    );
    setBucketFormError("");
    setDeleteBucket(null);
    setShowBucketForm(true);
  }

  async function onSaveBucket(event: FormEvent) {
    event.preventDefault();
    if (!activeProfile) return;
    const trimmed = bucketName.trim();
    const normalized = bucketCurrency.trim().toUpperCase();
    if (!trimmed) {
      setBucketFormError("Name is required.");
      return;
    }
    if (!isCurrency(normalized)) {
      setBucketFormError("Enter a valid ISO 4217 currency code, e.g. PHP.");
      return;
    }
    let targetMinor: number | null = null;
    if (bucketTarget.trim()) {
      try {
        targetMinor = parseAmountToMinorUnits(bucketTarget, normalized);
        if (targetMinor <= 0) {
          setBucketFormError("Goal amount must be greater than zero, or left blank for no goal.");
          return;
        }
      } catch (error) {
        setBucketFormError(errorMessage(error));
        return;
      }
    }
    const editing = buckets.find((b) => b.id === editingBucketId);
    if (editing && normalized !== editing.currency && bucketAssigned(editing).length > 0) {
      setBucketFormError(
        "Currency cannot change while records are assigned to this bucket. Unassign those records first.",
      );
      return;
    }
    setSavingBucket(true);
    try {
      if (editing) {
        const updated = await bucketsRepo.update(editing.id, {
          name: trimmed, kind: bucketKind, currency: normalized, targetMinor,
        });
        setBuckets((prev) => prev.map((b) => (b.id === updated.id ? updated : b)));
        setNotice(`“${updated.name}” updated.`);
      } else {
        const stamp = nowIso();
        const bucket: Bucket = {
          id: newId(), profileId: activeProfile.id, name: trimmed,
          kind: bucketKind, currency: normalized, targetMinor, createdAt: stamp, updatedAt: stamp,
        };
        validateBucket(bucket);
        await bucketsRepo.create(bucket);
        setBuckets((prev) => [...prev, bucket]);
        setNotice(`“${bucket.name}” created.`);
      }
      setEditingBucketId("");
      setBucketName("");
      setShowBucketForm(false);
    } catch (error) {
      setBucketFormError(errorMessage(error));
    } finally {
      setSavingBucket(false);
    }
  }

  function startMovement(bucket: Bucket, type: SavingsMovementType) {
    setMovementBucketId(bucket.id);
    setMovementType(type);
    setMovementAmount("");
    setMovementDate(todayInputValue());
    setMovementError("");
    setNotice("");
  }

  async function onSaveMovement(event: FormEvent) {
    event.preventDefault();
    if (!activeProfile) return;
    const bucket = buckets.find((b) => b.id === movementBucketId);
    if (!bucket || bucket.kind !== "savings") {
      setMovementError("Choose a savings bucket first.");
      return;
    }
    if (!isValidCalendarDate(movementDate)) {
      setMovementError("Enter a valid date.");
      return;
    }
    let amountMinor: number;
    try {
      amountMinor = parseAmountToMinorUnits(movementAmount, bucket.currency);
    } catch (error) {
      setMovementError(errorMessage(error));
      return;
    }
    const movementProblem = savingsMovementError(transactions, bucket, movementType, amountMinor);
    if (movementProblem) {
      setMovementError(movementProblem);
      return;
    }
    if (savingMovement) return;
    setSavingMovement(true);
    try {
      const stamp = nowIso();
      const txn: Transaction = {
        id: newId(), profileId: activeProfile.id, bucketId: bucket.id,
        type: movementType, amountMinor, currency: bucket.currency, date: movementDate,
        description:
          movementType === "savings-deposit"
            ? `Deposit to ${bucket.name}`
            : `Withdrawal from ${bucket.name}`,
        category: null, origin: "manual", relatedId: null, createdAt: stamp, updatedAt: stamp,
      };
      validateTransaction(txn);
      await transactionsRepo.create(txn);
      setTransactions((prev) => sortTxns([txn, ...prev]));
      setNotice(
        movementType === "savings-deposit"
          ? `Deposited ${formatMoney(amountMinor, bucket.currency)} to “${bucket.name}”.`
          : `Withdrew ${formatMoney(amountMinor, bucket.currency)} from “${bucket.name}”.`,
      );
      if (movementType === "savings-deposit") setCelebrateKey((k) => k + 1);
      setMovementBucketId("");
      setMovementAmount("");
      setMovementError("");
    } catch (error) {
      setMovementError(errorMessage(error));
    } finally {
      setSavingMovement(false);
    }
  }

  async function onRenameCategory(event: FormEvent) {
    event.preventDefault();
    const next = renameCategoryValue.trim();
    if (!next) {
      setCategoryError("Category name is required.");
      return;
    }
    if (next === renamingCategory) {
      setRenamingCategory("");
      return;
    }
    if (categories.some((c) => c.name.toLowerCase() === next.toLowerCase())) {
      setCategoryError("That category already exists. Delete the old one or choose another name.");
      return;
    }
    try {
      const affected = transactions.filter((t) => t.category === renamingCategory);
      for (const txn of affected) {
        await transactionsRepo.update(txn.id, { category: next });
      }
      setTransactions((prev) =>
        prev.map((t) => (t.category === renamingCategory ? { ...t, category: next } : t)),
      );
      setNotice(`Category renamed to “${next}” on ${affected.length} record(s).`);
      setRenamingCategory("");
      setCategoryError("");
    } catch (error) {
      setCategoryError(errorMessage(error));
    }
  }

  async function onClearCategory(name: string) {
    try {
      const affected = transactions.filter((t) => t.category === name);
      for (const txn of affected) {
        await transactionsRepo.update(txn.id, { category: null });
      }
      setTransactions((prev) =>
        prev.map((t) => (t.category === name ? { ...t, category: null } : t)),
      );
      setNotice(`Category “${name}” removed from ${affected.length} record(s). The records were kept.`);
      setClearCategoryTarget("");
    } catch (error) {
      setCategoryError(errorMessage(error));
    }
  }

  async function onDeleteTxn() {
    if (!deleteTxn) return;
    if (!isCorrectableTransaction(deleteTxn)) {
      setDeleteError("This record cannot be deleted here.");
      return;
    }
    if (transactions.some((t) => t.relatedId === deleteTxn.id)) {
      setDeleteError("This record is linked to another record and cannot be safely deleted here.");
      return;
    }
    setDeleting(true);
    try {
      await transactionsRepo.remove(deleteTxn.id);
      setTransactions((prev) => prev.filter((t) => t.id !== deleteTxn.id));
      setNotice("Personal record deleted.");
      setDeleteTxn(null);
    } catch (error) {
      setDeleteError(errorMessage(error));
    } finally {
      setDeleting(false);
    }
  }

  async function onDeleteBucket() {
    if (!deleteBucket) return;
    if (bucketAssigned(deleteBucket).length > 0) {
      setDeleteError("Records are assigned to this bucket. Edit those records to unassign them first.");
      return;
    }
    setDeleting(true);
    try {
      await bucketsRepo.remove(deleteBucket.id);
      setBuckets((prev) => prev.filter((b) => b.id !== deleteBucket.id));
      setNotice(`“${deleteBucket.name}” deleted.`);
      setDeleteBucket(null);
    } catch (error) {
      setDeleteError(errorMessage(error));
    } finally {
      setDeleting(false);
    }
  }

  const bucketSelectName = (id: string | null) =>
    id ? (buckets.find((b) => b.id === id)?.name ?? "Unknown bucket") : null;

  return (
    <section className="page finance-page">
      <header className="dash-header">
        <div>
          <h1>Personal Finance</h1>
          <p className="muted dash-subtitle">
            Record your own income and expenses, organised with savings and
            budgets — always separate from every business.
          </p>
        </div>
        {activeProfile && (
          <button
            className="btn"
            type="button"
            aria-expanded={showRecordForm}
            onClick={() => {
              if (!showRecordForm) resetRecordForm(activeProfile.currency);
              setShowRecordForm((v) => !v);
            }}
          >
            {showRecordForm ? "Close" : "Add income or expense"}
          </button>
        )}
      </header>

      {status === "loading" && <div className="card" role="status">Loading personal finance…</div>}
      {status === "error" && (
        <div className="card">
          <p className="alert-error" role="alert">Could not load personal finance: {loadError}</p>
          <button className="btn" type="button" onClick={() => void load(profileId)}>Retry</button>
        </div>
      )}

      {status === "ready" && (
        <>
          {profiles.length > 0 && activeProfile && (
            <div className="selector-bar">
              <div className="selector-main">
                <label htmlFor="personal-profile">Personal profile</label>
                <select
                  id="personal-profile"
                  className="input selector-select"
                  value={profileId}
                  onChange={(e) => void switchProfile(e.target.value)}
                >
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
                <span className="muted selector-meta">
                  {activeProfile.currency} · {transactions.length}{" "}
                  {transactions.length === 1 ? "record" : "records"}
                </span>
              </div>
              <button
                className="btn ghost small"
                type="button"
                aria-expanded={showProfileForm}
                onClick={() => setShowProfileForm((v) => !v)}
              >
                New personal profile
              </button>
            </div>
          )}

          {showProfileForm && (
            <form className="card inline-form" onSubmit={onCreateProfile} noValidate>
              <h2 className="inline-form-title">
                {profiles.length === 0 ? "Create your personal profile" : "Create a personal profile"}
              </h2>
              <p className="muted">
                Personal records live under this profile only and are never mixed
                with business buckets or transactions. Bucketa starts from the
                records you enter — it does not assume any opening balance.
              </p>
              <div className="form-row">
                <div className="field">
                  <label htmlFor="personal-name">Name</label>
                  <input
                    id="personal-name"
                    className="input"
                    type="text"
                    value={profileName}
                    onChange={(e) => setProfileName(e.target.value)}
                    placeholder="e.g. My money"
                    autoComplete="name"
                  />
                </div>
                <div className="field">
                  <label htmlFor="personal-currency">Currency</label>
                  <input
                    id="personal-currency"
                    className="input"
                    type="text"
                    value={profileCurrency}
                    onChange={(e) =>
                      setProfileCurrency(e.target.value.replace(/[^a-z]/gi, "").toUpperCase())
                    }
                    placeholder="PHP"
                    maxLength={3}
                    list="personal-currencies"
                    autoComplete="off"
                  />
                  <datalist id="personal-currencies">
                    {FEATURED_CURRENCIES.map((code) => (
                      <option key={code} value={code} />
                    ))}
                  </datalist>
                </div>
              </div>
              {profileFormError && <p className="alert-error" role="alert">{profileFormError}</p>}
              <div className="row-actions">
                <button className="btn" type="submit">Create personal profile</button>
                {profiles.length > 0 && (
                  <button className="btn ghost" type="button" onClick={() => setShowProfileForm(false)}>
                    Cancel
                  </button>
                )}
              </div>
            </form>
          )}

          {pageError && <p className="alert-error dash-alert" role="alert">{pageError}</p>}
          {notice && <p className="notice dash-alert" role="status">{notice}</p>}

          {!activeProfile ? (
            <div className="card empty-state">
              <p>No personal profile yet.</p>
              <p className="muted">Create one above to start tracking personal income and expenses.</p>
            </div>
          ) : (
            <>
              {transactions.length === 0 && (
                <GettingStarted
                  title="Start tracking your personal money"
                  intro="Your personal profile is ready. Bucketa summarises only what you record — no opening balance is assumed."
                  steps={[
                    {
                      title: "Add your first income or expense",
                      text: "For example salary coming in, or groceries going out. You can edit or delete it later.",
                      cta: "Add income or expense",
                      onAction: () => {
                        resetRecordForm(activeProfile.currency);
                        setShowRecordForm(true);
                      },
                    },
                    ...(buckets.length === 0
                      ? [
                          {
                            title: "Create a savings or budget bucket (optional)",
                            text: "Buckets organise personal records, e.g. Emergency fund or Monthly budget.",
                            cta: "Create a bucket",
                            onAction: () => {
                              setEditingBucketId("");
                              setBucketName("");
                              setBucketKind("savings" as BucketKind);
                              setBucketCurrency(activeProfile.currency);
                              setBucketFormError("");
                              setShowBucketForm(true);
                            },
                          },
                        ]
                      : []),
                  ]}
                />
              )}

              {summaries.length > 0 ? (
                <section className="txn-summaries" aria-label="Personal net cash flow by currency">
                  {summaries.map((s) => (
                    <div key={s.currency} className="txn-summary">
                      <h2>{s.currency}</h2>
                      <dl>
                        <div><dt>Income</dt><dd className="amount-in">{formatMoney(s.income, s.currency)}</dd></div>
                        <div><dt>Expenses</dt><dd className="amount-out">{formatMoney(s.expense, s.currency)}</dd></div>
                        <div><dt>Net cash flow</dt><dd className={s.net < 0 ? "amount-out" : "amount-in"}>{formatMoney(s.net, s.currency)}</dd></div>
                      </dl>
                    </div>
                  ))}
                  <p className="muted txn-summary-note">
                    Net cash flow is recorded personal income minus recorded
                    personal expenses, per currency. It is not a bank or account
                    balance — Bucketa only knows amounts you record here.
                    These totals are based on {incomeExpenseCount} income and
                    expense {incomeExpenseCount === 1 ? "record" : "records"} of{" "}
                    {transactions.length} total{" "}
                    {transactions.length === 1 ? "record" : "records"}; savings
                    deposits and withdrawals are not counted.
                  </p>
                  <div className="row-actions">
                    <button
                      className="btn ghost small"
                      type="button"
                      onClick={() => viewRecords("all")}
                    >
                      View records
                    </button>
                  </div>
                </section>
              ) : transactions.length > 0 ? (
                <div className="card empty-state">
                  <p>No income or expense records yet.</p>
                  <p className="muted">Other record types are kept in your history but do not count as income or expenses.</p>
                </div>
              ) : null}

              {showRecordForm && (
                <form ref={recordFormRef} className="card inline-form txn-form" onSubmit={onSaveRecord} noValidate>
                  <h2 className="inline-form-title">{editingTxnId ? "Edit record" : "Add record"}</h2>
                  {editingTxnId && (
                    <p className="field-hint" role="status">
                      Editing an existing record. Save changes updates this one
                      record only, and your totals recalculate automatically.
                    </p>
                  )}
                  {editingScannerRecord && (
                    <p className="field-hint" role="status">
                      Scanned record: you can correct its type, amount, date,
                      description, and category. Its currency and savings /
                      budget bucket stay as scanned and cannot be changed here.
                    </p>
                  )}
                  <div className="type-toggle" role="group" aria-label="Record type">
                    {(["income", "expense"] as EntryType[]).map((entryType) => (
                      <button
                        key={entryType}
                        type="button"
                        className={type === entryType ? "type-option on" : "type-option"}
                        aria-pressed={type === entryType}
                        onClick={() => setType(entryType)}
                      >
                        {entryType === "income" ? "Income" : "Expense"}
                      </button>
                    ))}
                  </div>
                  <div className="form-row">
                    <div className="field">
                      <label htmlFor="personal-amount">Amount</label>
                      <input
                        id="personal-amount"
                        className="input"
                        type="text"
                        inputMode="decimal"
                        value={amountOf(amounts, type)}
                        onChange={(e) => setAmounts(withAmount(amounts, type, e.target.value))}
                        aria-invalid={Boolean(recordErrors.amount)}
                        aria-describedby={recordErrors.amount ? "personal-amount-error" : undefined}
                        placeholder="0.00"
                        autoFocus
                      />
                      {recordErrors.amount && (
                        <p className="field-error" id="personal-amount-error">{recordErrors.amount}</p>
                      )}
                    </div>
                    <div className="field">
                      <label htmlFor="personal-txn-currency">Currency</label>
                      <input
                        id="personal-txn-currency"
                        className="input"
                        type="text"
                        value={currency}
                        disabled={editingScannerRecord}
                        onChange={(e) =>
                          setCurrency(e.target.value.replace(/[^a-z]/gi, "").toUpperCase())
                        }
                        aria-invalid={Boolean(recordErrors.currency)}
                        aria-describedby={recordErrors.currency ? "personal-currency-error" : undefined}
                        placeholder="PHP"
                        maxLength={3}
                        list="personal-currencies"
                        autoComplete="off"
                      />
                      {recordErrors.currency && (
                        <p className="field-error" id="personal-currency-error">{recordErrors.currency}</p>
                      )}
                    </div>
                    <div className="field">
                      <label htmlFor="personal-date">Date</label>
                      <input
                        id="personal-date"
                        className="input"
                        type="date"
                        value={date}
                        onChange={(e) => setDate(e.target.value)}
                        aria-invalid={Boolean(recordErrors.date)}
                        aria-describedby={recordErrors.date ? "personal-date-error" : undefined}
                      />
                      {recordErrors.date && (
                        <p className="field-error" id="personal-date-error">{recordErrors.date}</p>
                      )}
                    </div>
                  </div>
                  <div className="field">
                    <label htmlFor="personal-description">Description</label>
                    <input
                      id="personal-description"
                      className="input"
                      type="text"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      aria-invalid={Boolean(recordErrors.description)}
                      aria-describedby={recordErrors.description ? "personal-desc-error" : undefined}
                      placeholder="e.g. Salary, Groceries"
                    />
                    {recordErrors.description && (
                      <p className="field-error" id="personal-desc-error">{recordErrors.description}</p>
                    )}
                  </div>
                  <div className="form-row">
                    <div className="field">
                      <label htmlFor="personal-category">Category (optional)</label>
                      <input
                        id="personal-category"
                        className="input"
                        type="text"
                        value={category}
                        onChange={(e) => setCategory(e.target.value)}
                        placeholder="e.g. Food"
                        list="personal-category-list"
                        autoComplete="off"
                      />
                      <datalist id="personal-category-list">
                        {categories.map((c) => (
                          <option key={c.name} value={c.name} />
                        ))}
                      </datalist>
                    </div>
                    <div className="field">
                      <label htmlFor="personal-bucket">Savings / budget (optional)</label>
                      <select
                        id="personal-bucket"
                        className="input"
                        value={bucketId}
                        disabled={editingScannerRecord}
                        onChange={(e) => setBucketId(e.target.value)}
                        aria-invalid={Boolean(recordErrors.bucket)}
                        aria-describedby={recordErrors.bucket ? "personal-bucket-error" : undefined}
                      >
                        <option value="">None</option>
                        {buckets.map((bucket) => (
                          <option key={bucket.id} value={bucket.id}>
                            {bucket.name} ({KIND_LABELS[bucket.kind]}, {bucket.currency})
                          </option>
                        ))}
                      </select>
                      {recordErrors.bucket && (
                        <p className="field-error" id="personal-bucket-error">{recordErrors.bucket}</p>
                      )}
                    </div>
                  </div>
                  {!editingTxnId && plannedEntryTypes(amounts).length > 0 && (
                    <p className="field-hint" role="status">
                      This Save will create{" "}
                      {plannedEntryTypes(amounts).length === 2
                        ? "2 transactions: one Income and one Expense."
                        : `1 transaction: ${plannedEntryTypes(amounts)[0] === "income" ? "Income" : "Expense"} only.`}
                    </p>
                  )}
                  {recordError && <p className="alert-error" role="alert">{recordError}</p>}
                  <div className="row-actions">
                    <button className="btn" type="submit" disabled={savingRecord}>
                      {savingRecord
                      ? "Saving…"
                      : editingTxnId
                        ? "Save changes"
                        : plannedEntryTypes(amounts).length === 2
                          ? "Save 2 transactions"
                          : "Add record"}
                    </button>
                    <button
                      className="btn ghost"
                      type="button"
                      onClick={() => {
                        resetRecordForm(activeProfile.currency);
                        setShowRecordForm(false);
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              )}

              <section className="panel" aria-labelledby="savings-heading">
                <div className="panel-head">
                  <h2 id="savings-heading">Savings &amp; budgets</h2>
                  <button
                    className="btn ghost small"
                    type="button"
                    aria-expanded={showBucketForm}
                    onClick={() => {
                      setEditingBucketId("");
                      setBucketName("");
                      setBucketKind("savings");
                      setBucketCurrency(activeProfile.currency);
                      setBucketTarget("");
                      setBucketFormError("");
                      setShowBucketForm((v) => !v);
                    }}
                  >
                    {showBucketForm && !editingBucketId ? "Close" : "Add savings / budget"}
                  </button>
                </div>
                {(() => {
                  const goalBucket = buckets.find(
                    (b) => b.kind === "savings" && bucketGoalProgress(transactions, b),
                  );
                  const progress = goalBucket
                    ? bucketGoalProgress(transactions, goalBucket)
                    : null;
                  return (
                    <div className="bucky-row">
                      <Bucky
                        variant="savings"
                        fillPercent={progress ? progress.percent : null}
                        currency={goalBucket?.currency}
                        celebrateKey={celebrateKey}
                      />
                      <div>
                        <strong>Bucky keeps an eye on your goals</strong>
                        {goalBucket && progress ? (
                          <p className="muted bucket-meta">
                            {goalBucket.name}: {formatMoney(progress.savedMinor, goalBucket.currency)}{" "}
                            of {formatMoney(goalBucket.targetMinor ?? 0, goalBucket.currency)} goal
                            ({Math.round(progress.percent)}% full)
                            {progress.percent >= 100
                              ? " — goal reached, well done!"
                              : " from records assigned to this bucket."}
                          </p>
                        ) : (
                          <p className="muted bucket-meta">
                            Set a goal amount on a savings or budget bucket and
                            Bucky&apos;s bucket will fill with coins as you assign
                            records to it. Tap Bucky anytime!
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })()}
                <details className="help-details">
                  <summary>What are savings &amp; budgets?</summary>
                  <p className="muted">
                    Savings — money you are setting aside. Budget — a planned
                    spending area. Allocated — money assigned to a specific
                    purpose. Assign records to a bucket to see its recorded net
                    cash flow (income minus expenses); a bucket is an organiser,
                    not a bank account.
                  </p>
                </details>
                {showBucketForm && (
                  <form className="inline-form bucket-create" onSubmit={onSaveBucket} noValidate>
                    <h3>{editingBucketId ? "Edit savings / budget" : "New savings / budget"}</h3>
                    <div className="form-row">
                      <div className="field">
                        <label htmlFor="personal-bucket-name">Name</label>
                        <input
                          id="personal-bucket-name"
                          className="input"
                          type="text"
                          value={bucketName}
                          onChange={(e) => setBucketName(e.target.value)}
                          placeholder="e.g. Emergency fund, Monthly budget"
                        />
                      </div>
                      <div className="field">
                        <label htmlFor="personal-bucket-kind">Type</label>
                        <select
                          id="personal-bucket-kind"
                          className="input"
                          value={bucketKind}
                          onChange={(e) => setBucketKind(e.target.value as BucketKind)}
                        >
                          <option value="savings">Savings</option>
                          <option value="budget">Budget</option>
                          <option value="allocated">Allocated</option>
                        </select>
                      </div>
                      <div className="field">
                        <label htmlFor="personal-bucket-currency">Currency</label>
                        <input
                          id="personal-bucket-currency"
                          className="input"
                          type="text"
                          value={bucketCurrency}
                          onChange={(e) =>
                            setBucketCurrency(e.target.value.replace(/[^a-z]/gi, "").toUpperCase())
                          }
                          placeholder="PHP"
                          maxLength={3}
                          list="personal-currencies"
                          autoComplete="off"
                        />
                      </div>
                      <div className="field">
                        <label htmlFor="personal-bucket-target">Goal amount (optional)</label>
                        <input
                          id="personal-bucket-target"
                          className="input"
                          type="text"
                          inputMode="decimal"
                          value={bucketTarget}
                          onChange={(e) => setBucketTarget(e.target.value)}
                          placeholder="e.g. 100000"
                          aria-describedby="personal-bucket-target-hint"
                        />
                        <p className="field-hint" id="personal-bucket-target-hint">
                          Bucky&apos;s bucket fills toward this goal from records assigned here.
                        </p>
                      </div>
                    </div>
                    {bucketFormError && <p className="alert-error" role="alert">{bucketFormError}</p>}
                    <div className="row-actions">
                      <button className="btn" type="submit" disabled={savingBucket}>
                        {savingBucket ? "Saving…" : editingBucketId ? "Save changes" : "Create"}
                      </button>
                      <button
                        className="btn ghost"
                        type="button"
                        onClick={() => {
                          setShowBucketForm(false);
                          setEditingBucketId("");
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                )}
                {movementBucket && (
                  <form className="inline-form bucket-create" onSubmit={onSaveMovement} noValidate>
                    <h3>
                      {movementType === "savings-deposit" ? "Deposit to" : "Withdraw from"} “
                      {movementBucket.name}”
                    </h3>
                    <p className="muted bucket-meta">
                      Saved so far:{" "}
                      {formatMoney(bucketSavedMinor(transactions, movementBucket), movementBucket.currency)}
                      {movementBucket.targetMinor
                        ? ` of ${formatMoney(movementBucket.targetMinor, movementBucket.currency)} goal`
                        : ""}
                      . Savings movements are not income or expenses.
                    </p>
                    <div className="form-row">
                      <div className="field">
                        <label htmlFor="savings-movement-amount">Amount ({movementBucket.currency})</label>
                        <input
                          id="savings-movement-amount"
                          className="input"
                          type="text"
                          inputMode="decimal"
                          value={movementAmount}
                          onChange={(e) => setMovementAmount(e.target.value)}
                          placeholder="0.00"
                          autoFocus
                        />
                      </div>
                      <div className="field">
                        <label htmlFor="savings-movement-date">Date</label>
                        <input
                          id="savings-movement-date"
                          className="input"
                          type="date"
                          value={movementDate}
                          onChange={(e) => setMovementDate(e.target.value)}
                        />
                      </div>
                    </div>
                    {movementError && <p className="alert-error" role="alert">{movementError}</p>}
                    <div className="row-actions">
                      <button className="btn" type="submit" disabled={savingMovement}>
                        {savingMovement
                          ? "Saving…"
                          : movementType === "savings-deposit"
                            ? "Save deposit"
                            : "Save withdrawal"}
                      </button>
                      <button
                        className="btn ghost"
                        type="button"
                        onClick={() => {
                          setMovementBucketId("");
                          setMovementError("");
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                )}
                {buckets.length === 0 ? (
                  <p className="muted">
                    No savings or budgets yet. Create one to set money aside, then
                    assign personal records to it.
                  </p>
                ) : (
                  <ul className="bucket-list clean-list">
                    {buckets.map((bucket) => {
                      const assigned = bucketAssigned(bucket);
                      const balances = bucketCashFlows(bucket);
                      const goal = bucketGoalProgress(transactions, bucket);
                      return (
                        <li key={bucket.id} className="bucket-row wrap-row">
                          <div>
                            <strong>{bucket.name}</strong>
                            <p className="muted bucket-meta">
                              {KIND_LABELS[bucket.kind]} · {bucket.currency} · {assigned.length}{" "}
                              {assigned.length === 1 ? "record" : "records"}
                              {balances.length > 0
                                ? ` · ${balances.map((b) => `${b.currency} net cash flow ${formatMoney(b.net, b.currency)}`).join(" · ")}`
                                : " · No assigned records yet"}
                            </p>
                            {bucket.kind === "savings" && goal && bucket.targetMinor ? (
                              <p className="muted bucket-meta">
                                Saved {formatMoney(goal.savedMinor, bucket.currency)} of{" "}
                                {formatMoney(bucket.targetMinor, bucket.currency)} ·{" "}
                                {formatMoney(
                                  Math.max(0, bucket.targetMinor - goal.savedMinor),
                                  bucket.currency,
                                )}{" "}
                                remaining · {Math.round(goal.percent)}% full
                              </p>
                            ) : bucket.kind === "savings" ? (
                              <p className="muted bucket-meta">
                                Saved {formatMoney(bucketSavedMinor(transactions, bucket), bucket.currency)}
                              </p>
                            ) : null}
                          </div>
                          <div className="row-actions">
                            {bucket.kind === "savings" && (
                              <>
                                <button
                                  className="btn ghost small"
                                  type="button"
                                  onClick={() => startMovement(bucket, "savings-deposit")}
                                >
                                  Deposit
                                </button>
                                <button
                                  className="btn ghost small"
                                  type="button"
                                  onClick={() => startMovement(bucket, "savings-withdrawal")}
                                >
                                  Withdraw
                                </button>
                              </>
                            )}
                            <button className="btn ghost small" type="button" onClick={() => startEditBucket(bucket)}>
                              Edit
                            </button>
                            <button
                              className="danger-link"
                              type="button"
                              onClick={() => {
                                setDeleteBucket(bucket);
                                setDeleteError("");
                              }}
                            >
                              Delete…
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {deleteBucket && (
                  <section className="delete-panel" role="alertdialog" aria-labelledby="bucket-delete-heading">
                    <h3 id="bucket-delete-heading">Delete “{deleteBucket.name}”?</h3>
                    <p>
                      {bucketAssigned(deleteBucket).length > 0
                        ? `${bucketAssigned(deleteBucket).length} record(s) are assigned to it, so it cannot be deleted yet. Edit those records to unassign them first.`
                        : "This deletes this savings/budget bucket. No records will be deleted."}
                    </p>
                    {deleteError && <p className="alert-error" role="alert">{deleteError}</p>}
                    <div className="row-actions">
                      <button
                        className="btn danger-solid"
                        type="button"
                        onClick={() => void onDeleteBucket()}
                        disabled={deleting || bucketAssigned(deleteBucket).length > 0}
                      >
                        {deleting ? "Deleting…" : "Delete permanently"}
                      </button>
                      <button className="btn ghost" type="button" onClick={() => setDeleteBucket(null)}>
                        Cancel
                      </button>
                    </div>
                  </section>
                )}
              </section>

              <section className="panel" aria-labelledby="categories-heading">
                <div className="panel-head">
                  <h2 id="categories-heading">Categories</h2>
                  <span className="count-badge">{categories.length}</span>
                </div>
                {categoryError && <p className="alert-error" role="alert">{categoryError}</p>}
                {categories.length === 0 ? (
                  <p className="muted">
                    No categories yet. Type a category when adding a record and it
                    will appear here to rename or remove.
                  </p>
                ) : (
                  <ul className="bucket-list clean-list">
                    {categories.map((entry) => (
                      <li key={entry.name} className="bucket-row wrap-row">
                        <div>
                          <strong>{entry.name}</strong>
                          <p className="muted bucket-meta">
                            Used on {entry.count} {entry.count === 1 ? "record" : "records"}
                          </p>
                        </div>
                        {renamingCategory === entry.name ? (
                          <form className="rename-inline" onSubmit={onRenameCategory}>
                            <input
                              className="input"
                              type="text"
                              value={renameCategoryValue}
                              onChange={(e) => setRenameCategoryValue(e.target.value)}
                              aria-label={`New name for ${entry.name}`}
                              autoFocus
                            />
                            <button className="btn small" type="submit">Save</button>
                            <button
                              className="btn ghost small"
                              type="button"
                              onClick={() => setRenamingCategory("")}
                            >
                              Cancel
                            </button>
                          </form>
                        ) : clearCategoryTarget === entry.name ? (
                          <div className="row-actions">
                            <span className="muted">Remove this category from its records? Records are kept.</span>
                            <button
                              className="btn danger-solid small"
                              type="button"
                              onClick={() => void onClearCategory(entry.name)}
                            >
                              Remove category
                            </button>
                            <button
                              className="btn ghost small"
                              type="button"
                              onClick={() => setClearCategoryTarget("")}
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <div className="row-actions">
                            <button
                              className="btn ghost small"
                              type="button"
                              onClick={() => {
                                setRenamingCategory(entry.name);
                                setRenameCategoryValue(entry.name);
                                setCategoryError("");
                              }}
                            >
                              Rename
                            </button>
                            <button
                              className="danger-link"
                              type="button"
                              onClick={() => setClearCategoryTarget(entry.name)}
                            >
                              Delete…
                            </button>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {deleteTxn && (
                <section
                  ref={deleteTxnPanelRef}
                  tabIndex={-1}
                  className="delete-panel"
                  role="alertdialog"
                  aria-labelledby="personal-delete-heading"
                  onKeyDown={(event) => {
                    if (event.key === "Escape" && !deleting) {
                      event.preventDefault();
                      setDeleteTxn(null);
                      setDeleteError("");
                    }
                  }}
                >
                  <h3 id="personal-delete-heading">Delete this record?</h3>
                  <p>
                    <strong>{deleteTxn.description}</strong> —{" "}
                    {formatMoney(deleteTxn.amountMinor, deleteTxn.currency)} (
                    {deleteTxn.type}, {formatDate(deleteTxn.date)}). This cannot be undone.
                  </p>
                  {deleteError && <p className="alert-error" role="alert">{deleteError}</p>}
                  <div className="row-actions">
                    <button
                      className="btn danger-solid"
                      type="button"
                      onClick={() => void onDeleteTxn()}
                      disabled={deleting}
                    >
                      {deleting ? "Deleting…" : "Delete permanently"}
                    </button>
                    <button className="btn ghost" type="button" onClick={() => setDeleteTxn(null)}>
                      Cancel
                    </button>
                  </div>
                </section>
              )}

              <section ref={historyRef} className="panel txn-history" aria-labelledby="personal-history-heading">
                <div className="panel-head">
                  <h2 id="personal-history-heading">Personal history</h2>
                  <span className="count-badge">
                    {historyFilter === "all"
                      ? `${transactions.length} ${transactions.length === 1 ? "record" : "records"}`
                      : `${filteredTransactions.length} of ${transactions.length} records`}
                  </span>
                </div>
                {transactions.length > 0 && (
                  <div className="type-toggle personal-history-filter" role="group" aria-label="Filter personal history">
                    {(
                      [
                        { id: "all", label: "All" },
                        { id: "income", label: "Income" },
                        { id: "expense", label: "Expenses" },
                        { id: "savings", label: "Savings movements" },
                      ] as const
                    ).map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        className={historyFilter === option.id ? "type-option on" : "type-option"}
                        aria-pressed={historyFilter === option.id}
                        onClick={() => setHistoryFilter(option.id)}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                )}
                {transactions.length === 0 ? (
                  <div className="empty-state dash-empty">
                    <p>No personal records yet.</p>
                    <p className="muted">Add your first income or expense to start this history.</p>
                    <div className="row-actions">
                      <button
                        className="btn ghost small"
                        type="button"
                        onClick={() => {
                          resetRecordForm(activeProfile.currency);
                          setShowRecordForm(true);
                        }}
                      >
                        Add income or expense
                      </button>
                    </div>
                  </div>
                ) : filteredTransactions.length === 0 ? (
                  <div className="empty-state dash-empty">
                    <p>No records match this filter.</p>
                    <p className="muted">Try a different filter to see the rest of your history.</p>
                  </div>
                ) : (
                  <ul className="txn-list">
                    {filteredTransactions.map((txn) => {
                      const editable = isCorrectableTransaction(txn);
                      const assigned = bucketSelectName(txn.bucketId);
                      return (
                        <li key={txn.id} className="txn-row">
                          <div className="txn-main">
                            <strong>{txn.description}</strong>
                            <p className="muted bucket-meta">
                              {formatDate(txn.date)} · {TXN_TYPE_LABELS[txn.type]}
                              {txn.category ? ` · ${txn.category}` : ""}
                              {assigned ? ` · ${assigned}` : ""}
                              {txn.origin === "scanner-confirmed"
                                ? " · Scanned record"
                                : !editable && txn.type !== "savings-deposit" && txn.type !== "savings-withdrawal"
                                  ? ` · ${txn.origin}`
                                  : ""}
                            </p>
                          </div>
                          <span
                            className={
                              txn.type === "expense" || txn.type === "savings-withdrawal"
                                ? "txn-amount amount-out"
                                : "txn-amount amount-in"
                            }
                          >
                            {txn.type === "expense" || txn.type === "savings-withdrawal" ? "−" : "+"}
                            {formatMoney(txn.amountMinor, txn.currency)}
                          </span>
                          {editable ? (
                            <div className="row-actions txn-actions">
                              <button className="btn ghost small" type="button" onClick={() => startEditTxn(txn)}>
                                Edit
                              </button>
                              <button
                                className="danger-link"
                                type="button"
                                onClick={() => {
                                  setDeleteTxn(txn);
                                  setDeleteError("");
                                }}
                              >
                                Delete…
                              </button>
                            </div>
                          ) : (
                            <span className="muted txn-locked">
                              {txn.type === "savings-deposit" || txn.type === "savings-withdrawal"
                                ? "Savings movement"
                                : "Managed elsewhere"}
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            </>
          )}
        </>
      )}
    </section>
  );
}

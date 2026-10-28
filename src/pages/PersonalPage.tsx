import { useEffect, useMemo, useState, type FormEvent } from "react";
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
import { summarizeTransactions } from "../lib/finance";

type Status = "loading" | "ready" | "error";
type EntryType = "income" | "expense";

const KIND_LABELS: Record<BucketKind, string> = {
  savings: "Savings",
  budget: "Budget",
  allocated: "Allocated",
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
  const [amount, setAmount] = useState("");
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
  const [bucketFormError, setBucketFormError] = useState("");
  const [savingBucket, setSavingBucket] = useState(false);

  // Category management.
  const [renamingCategory, setRenamingCategory] = useState("");
  const [renameCategoryValue, setRenameCategoryValue] = useState("");
  const [categoryError, setCategoryError] = useState("");
  const [clearCategoryTarget, setClearCategoryTarget] = useState("");

  // Delete confirmations.
  const [deleteTxn, setDeleteTxn] = useState<Transaction | null>(null);
  const [deleteBucket, setDeleteBucket] = useState<Bucket | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState(false);

  const activeProfile = profiles.find((p) => p.id === profileId);
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

  function bucketAssigned(bucket: Bucket): Transaction[] {
    return transactions.filter((t) => t.bucketId === bucket.id);
  }
  function bucketBalances(bucket: Bucket) {
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
    setAmount("");
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
      setAmount(minorUnitsToAmountInput(txn.amountMinor, txn.currency));
    } catch {
      setAmount("");
    }
    setCategory(txn.category ?? "");
    setDate(txn.date.slice(0, 10));
    setDescription(txn.description);
    setBucketId(txn.bucketId ?? "");
    setRecordErrors({});
    setRecordError("");
    setDeleteTxn(null);
    setShowRecordForm(true);
  }

  async function onSaveRecord(event: FormEvent) {
    event.preventDefault();
    if (!activeProfile) return;
    const errors: Record<string, string> = {};
    const normalized = currency.trim().toUpperCase();
    const trimmedDescription = description.trim();
    let amountMinor: number | null = null;
    if (!isCurrency(normalized)) {
      errors.currency = "Enter a valid ISO 4217 currency code, e.g. PHP.";
    } else {
      try {
        amountMinor = parseAmountToMinorUnits(amount, normalized);
        if (amountMinor <= 0) errors.amount = "Amount must be greater than zero.";
      } catch (error) {
        errors.amount = errorMessage(error);
      }
    }
    if (!trimmedDescription) errors.description = "Description is required.";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(`${date}T00:00:00`).getTime())) {
      errors.date = "Enter a valid date.";
    }
    if (bucketId && !buckets.some((b) => b.id === bucketId)) {
      errors.bucket = "That savings or budget bucket does not belong to this personal profile.";
    }
    setRecordErrors(errors);
    if (Object.keys(errors).length > 0 || amountMinor === null) return;

    setSavingRecord(true);
    try {
      if (editingTxnId) {
        const updated = await transactionsRepo.update(editingTxnId, {
          type, amountMinor, currency: normalized, date,
          description: trimmedDescription, category: category.trim() || null,
          bucketId: bucketId || null,
        });
        setTransactions((prev) => sortTxns(prev.map((t) => (t.id === updated.id ? updated : t))));
        setNotice("Personal record updated.");
      } else {
        const stamp = nowIso();
        const txn: Transaction = {
          id: newId(), profileId: activeProfile.id, bucketId: bucketId || null,
          type, amountMinor, currency: normalized, date,
          description: trimmedDescription, category: category.trim() || null,
          origin: "manual", relatedId: null, createdAt: stamp, updatedAt: stamp,
        };
        validateTransaction(txn);
        await transactionsRepo.create(txn);
        setTransactions((prev) => sortTxns([txn, ...prev]));
        setNotice("Personal record added.");
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
          name: trimmed, kind: bucketKind, currency: normalized,
        });
        setBuckets((prev) => prev.map((b) => (b.id === updated.id ? updated : b)));
        setNotice(`“${updated.name}” updated.`);
      } else {
        const stamp = nowIso();
        const bucket: Bucket = {
          id: newId(), profileId: activeProfile.id, name: trimmed,
          kind: bucketKind, currency: normalized, createdAt: stamp, updatedAt: stamp,
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
            Your personal income, expenses, savings, and budgets — separate from every business.
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
            {showRecordForm ? "Close" : "Add Record"}
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
                with business buckets or transactions.
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
              {summaries.length > 0 ? (
                <section className="txn-summaries" aria-label="Personal balances by currency">
                  {summaries.map((s) => (
                    <div key={s.currency} className="txn-summary">
                      <h2>{s.currency}</h2>
                      <dl>
                        <div><dt>Income</dt><dd className="amount-in">{formatMoney(s.income, s.currency)}</dd></div>
                        <div><dt>Expenses</dt><dd className="amount-out">{formatMoney(s.expense, s.currency)}</dd></div>
                        <div><dt>Balance</dt><dd className={s.net < 0 ? "amount-out" : "amount-in"}>{formatMoney(s.net, s.currency)}</dd></div>
                      </dl>
                    </div>
                  ))}
                  <p className="muted txn-summary-note">
                    Balance is income minus expenses from your personal records
                    only, per currency. No business money is included.
                  </p>
                </section>
              ) : (
                <div className="card empty-state">
                  <p>No personal balance yet.</p>
                  <p className="muted">Add your first personal income or expense and your balance will appear here.</p>
                </div>
              )}

              {showRecordForm && (
                <form className="card inline-form txn-form" onSubmit={onSaveRecord} noValidate>
                  <h2 className="inline-form-title">{editingTxnId ? "Edit record" : "Add record"}</h2>
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
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
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
                        onChange={(e) => {
                          setBucketId(e.target.value);
                          const bucket = buckets.find((b) => b.id === e.target.value);
                          setCurrency(bucket ? bucket.currency : activeProfile.currency);
                        }}
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
                  {recordError && <p className="alert-error" role="alert">{recordError}</p>}
                  <div className="row-actions">
                    <button className="btn" type="submit" disabled={savingRecord}>
                      {savingRecord ? "Saving…" : editingTxnId ? "Save changes" : "Add record"}
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
                      setBucketFormError("");
                      setShowBucketForm((v) => !v);
                    }}
                  >
                    {showBucketForm && !editingBucketId ? "Close" : "Add savings / budget"}
                  </button>
                </div>
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
                {buckets.length === 0 ? (
                  <p className="muted">
                    No savings or budgets yet. Create one to set money aside, then
                    assign personal records to it.
                  </p>
                ) : (
                  <ul className="bucket-list clean-list">
                    {buckets.map((bucket) => {
                      const assigned = bucketAssigned(bucket);
                      const balances = bucketBalances(bucket);
                      return (
                        <li key={bucket.id} className="bucket-row wrap-row">
                          <div>
                            <strong>{bucket.name}</strong>
                            <p className="muted bucket-meta">
                              {KIND_LABELS[bucket.kind]} · {bucket.currency} · {assigned.length}{" "}
                              {assigned.length === 1 ? "record" : "records"}
                              {balances.length > 0
                                ? ` · ${balances.map((b) => `${b.currency} balance ${formatMoney(b.net, b.currency)}`).join(" · ")}`
                                : " · No assigned balance yet"}
                            </p>
                          </div>
                          <div className="row-actions">
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
                <section className="delete-panel" role="alertdialog" aria-labelledby="personal-delete-heading">
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

              <section className="panel txn-history" aria-labelledby="personal-history-heading">
                <div className="panel-head">
                  <h2 id="personal-history-heading">Personal history</h2>
                  <span className="count-badge">
                    {transactions.length} {transactions.length === 1 ? "record" : "records"}
                  </span>
                </div>
                {transactions.length === 0 ? (
                  <div className="empty-state dash-empty">
                    <p>No personal records yet.</p>
                    <p className="muted">Use Add Record to track personal income and expenses.</p>
                  </div>
                ) : (
                  <ul className="txn-list">
                    {transactions.map((txn) => {
                      const editable =
                        txn.origin === "manual" && (txn.type === "income" || txn.type === "expense");
                      const assigned = bucketSelectName(txn.bucketId);
                      return (
                        <li key={txn.id} className="txn-row">
                          <div className="txn-main">
                            <strong>{txn.description}</strong>
                            <p className="muted bucket-meta">
                              {formatDate(txn.date)} · {txn.type}
                              {txn.category ? ` · ${txn.category}` : ""}
                              {assigned ? ` · ${assigned}` : ""}
                              {!editable ? ` · ${txn.origin}` : ""}
                            </p>
                          </div>
                          <span className={txn.type === "expense" ? "txn-amount amount-out" : "txn-amount amount-in"}>
                            {txn.type === "expense" ? "−" : "+"}
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
                            <span className="muted txn-locked">Managed elsewhere</span>
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

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { bucketsRepo, profilesRepo, transactionsRepo } from "../data/db";
import type { Bucket, Profile, Transaction } from "../data/types";
import {
  BucketaDataError,
  newId,
  nowIso,
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

type Status = "loading" | "ready" | "error";
type EntryType = "income" | "expense";

const TYPE_LABELS: Record<Transaction["type"], string> = {
  income: "Income",
  expense: "Expense",
  transfer: "Transfer",
  sale: "Sale",
};

function errorMessage(error: unknown): string {
  if (error instanceof BucketaDataError || error instanceof Error) return error.message;
  return "Something went wrong. Please try again.";
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

function isEditable(txn: Transaction): boolean {
  return txn.origin === "manual" && (txn.type === "income" || txn.type === "expense");
}

interface CurrencySummary {
  currency: string;
  income: number;
  expense: number;
  net: number;
}

export default function TransactionsPage() {
  const [status, setStatus] = useState<Status>("loading");
  const [loadError, setLoadError] = useState("");
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profileId, setProfileId] = useState("");
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState("");
  const [type, setType] = useState<EntryType>("expense");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<string>(DEFAULT_CURRENCY);
  const [category, setCategory] = useState("");
  const [date, setDate] = useState(todayInputValue);
  const [description, setDescription] = useState("");
  const [bucketId, setBucketId] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [notice, setNotice] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<Transaction | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState(false);

  const activeProfile = profiles.find((p) => p.id === profileId);
  const bucketName = (id: string | null) =>
    id ? (buckets.find((b) => b.id === id)?.name ?? "Unknown bucket") : null;

  const summaries = useMemo<CurrencySummary[]>(() => {
    const byCurrency = new Map<string, CurrencySummary>();
    for (const txn of transactions) {
      if (txn.type !== "income" && txn.type !== "expense") continue;
      const entry =
        byCurrency.get(txn.currency) ??
        { currency: txn.currency, income: 0, expense: 0, net: 0 };
      entry[txn.type] += txn.amountMinor;
      entry.net = entry.income - entry.expense;
      byCurrency.set(txn.currency, entry);
    }
    return [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency));
  }, [transactions]);

  const categories = useMemo(
    () =>
      [...new Set(transactions.map((t) => t.category).filter(Boolean) as string[])].sort(),
    [transactions],
  );

  async function loadBusinessData(forProfileId: string) {
    const [businessBuckets, businessTransactions] = await Promise.all([
      bucketsRepo.listByProfile(forProfileId),
      transactionsRepo.listByProfile(forProfileId),
    ]);
    setBuckets([...businessBuckets].sort((a, b) => a.name.localeCompare(b.name)));
    setTransactions(
      [...businessTransactions].sort(
        (a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt),
      ),
    );
  }

  async function load(preferredProfileId = "") {
    setStatus("loading");
    setLoadError("");
    try {
      const all = await profilesRepo.listAll();
      const businesses = all
        .filter((p) => p.kind === "business")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name));
      setProfiles(businesses);
      const selected = businesses.find((p) => p.id === preferredProfileId) ?? businesses[0];
      if (selected) {
        setProfileId(selected.id);
        setCurrency(selected.currency);
        await loadBusinessData(selected.id);
      } else {
        setProfileId("");
        setBuckets([]);
        setTransactions([]);
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

  function resetForm(nextCurrency: string) {
    setEditingId("");
    setType("expense");
    setAmount("");
    setCurrency(nextCurrency);
    setCategory("");
    setDate(todayInputValue());
    setDescription("");
    setBucketId("");
    setFieldErrors({});
    setFormError("");
  }

  async function switchBusiness(id: string) {
    const target = profiles.find((p) => p.id === id);
    if (!target || id === profileId) return;
    setProfileId(id);
    setDeleteTarget(null);
    setNotice("");
    resetForm(target.currency);
    setShowForm(false);
    try {
      await loadBusinessData(id);
    } catch (error) {
      setFormError(errorMessage(error));
      setBuckets([]);
      setTransactions([]);
    }
  }

  function startCreate() {
    if (!activeProfile) return;
    resetForm(activeProfile.currency);
    setNotice("");
    setShowForm(true);
  }

  function startEdit(txn: Transaction) {
    setEditingId(txn.id);
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
    setFieldErrors({});
    setFormError("");
    setNotice("");
    setDeleteTarget(null);
    setShowForm(true);
  }

  function onSelectBucket(id: string) {
    setBucketId(id);
    const bucket = buckets.find((b) => b.id === id);
    // A bucket's transactions default to that bucket's own currency;
    // with no bucket, fall back to the business currency.
    setCurrency(bucket ? bucket.currency : (activeProfile?.currency ?? DEFAULT_CURRENCY));
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError("");
    if (!activeProfile) {
      setFormError("Select a business before adding a transaction.");
      return;
    }

    const errors: Record<string, string> = {};
    const normalizedCurrency = currency.trim().toUpperCase();
    const trimmedDescription = description.trim();
    let amountMinor: number | null = null;

    if (!/^[A-Z]{3}$/.test(normalizedCurrency) || !isValidCurrency(normalizedCurrency)) {
      errors.currency = "Enter a valid ISO 4217 currency code, e.g. PHP.";
    } else {
      try {
        amountMinor = parseAmountToMinorUnits(amount, normalizedCurrency);
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
      errors.bucket = "That bucket does not belong to this business.";
    }
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0 || amountMinor === null) return;

    const editing = transactions.find((t) => t.id === editingId);
    setSubmitting(true);
    try {
      if (editing) {
        if (!isEditable(editing)) {
          throw new BucketaDataError("This record cannot be edited here.");
        }
        const updated = await transactionsRepo.update(editing.id, {
          type,
          amountMinor,
          currency: normalizedCurrency,
          date,
          description: trimmedDescription,
          category: category.trim() || null,
          bucketId: bucketId || null,
        });
        setTransactions((prev) =>
          prev
            .map((t) => (t.id === updated.id ? updated : t))
            .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)),
        );
        setNotice("Transaction updated.");
      } else {
        const stamp = nowIso();
        const txn: Transaction = {
          id: newId(),
          profileId: activeProfile.id,
          bucketId: bucketId || null,
          type,
          amountMinor,
          currency: normalizedCurrency,
          date,
          description: trimmedDescription,
          category: category.trim() || null,
          origin: "manual",
          relatedId: null,
          createdAt: stamp,
          updatedAt: stamp,
        };
        validateTransaction(txn);
        await transactionsRepo.create(txn);
        setTransactions((prev) =>
          [txn, ...prev].sort(
            (a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt),
          ),
        );
        setNotice("Transaction added.");
      }
      resetForm(activeProfile.currency);
      setShowForm(false);
    } catch (error) {
      setFormError(errorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  async function onDelete() {
    if (!deleteTarget) return;
    if (transactions.some((t) => t.relatedId === deleteTarget.id)) {
      setDeleteError(
        "This transaction is linked to another record and cannot be safely deleted here.",
      );
      return;
    }
    setDeleting(true);
    setDeleteError("");
    try {
      await transactionsRepo.remove(deleteTarget.id);
      setTransactions((prev) => prev.filter((t) => t.id !== deleteTarget.id));
      if (editingId === deleteTarget.id) {
        resetForm(activeProfile?.currency ?? DEFAULT_CURRENCY);
        setShowForm(false);
      }
      setNotice("Transaction deleted.");
      setDeleteTarget(null);
    } catch (error) {
      setDeleteError(errorMessage(error));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <section className="page transactions-page">
      <header className="dash-header">
        <div>
          <h1>Transactions</h1>
          <p className="muted dash-subtitle">
            Income and expenses for one business, kept separate by currency.
          </p>
        </div>
        {activeProfile && (
          <button
            className="btn"
            type="button"
            aria-expanded={showForm}
            onClick={() => (showForm ? setShowForm(false) : startCreate())}
          >
            {showForm ? "Close" : "Add Transaction"}
          </button>
        )}
      </header>

      {status === "loading" && (
        <div className="card" role="status">Loading transactions…</div>
      )}

      {status === "error" && (
        <div className="card">
          <p className="alert-error" role="alert">Could not load transactions: {loadError}</p>
          <button className="btn" type="button" onClick={() => void load(profileId)}>Retry</button>
        </div>
      )}

      {status === "ready" && profiles.length === 0 && (
        <div className="card empty-state">
          <p>No businesses yet.</p>
          <p className="muted">
            Transactions belong to a business. Create one first on the{" "}
            <a href="#/buckets">Business Buckets page</a>, then record income and
            expenses here.
          </p>
        </div>
      )}

      {status === "ready" && activeProfile && (
        <>
          <div className="selector-bar">
            <div className="selector-main">
              <label htmlFor="txn-business">Business</label>
              <select
                id="txn-business"
                className="input selector-select"
                value={profileId}
                onChange={(e) => void switchBusiness(e.target.value)}
              >
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
              <span className="muted selector-meta">
                {activeProfile.currency} · {transactions.length}{" "}
                {transactions.length === 1 ? "record" : "records"} · {buckets.length}{" "}
                {buckets.length === 1 ? "bucket" : "buckets"}
              </span>
            </div>
          </div>

          {summaries.length > 0 && (
            <section className="txn-summaries" aria-label="Income and expense summary">
              {summaries.map((summary) => (
                <div key={summary.currency} className="txn-summary">
                  <h2>{summary.currency}</h2>
                  <dl>
                    <div>
                      <dt>Income</dt>
                      <dd className="amount-in">{formatMoney(summary.income, summary.currency)}</dd>
                    </div>
                    <div>
                      <dt>Expenses</dt>
                      <dd className="amount-out">{formatMoney(summary.expense, summary.currency)}</dd>
                    </div>
                    <div>
                      <dt>Net</dt>
                      <dd className={summary.net < 0 ? "amount-out" : "amount-in"}>
                        {formatMoney(summary.net, summary.currency)}
                      </dd>
                    </div>
                  </dl>
                </div>
              ))}
              <p className="muted txn-summary-note">
                Summaries use income and expense records only, per currency.
                Transfers and sales are listed below but are not included here.
              </p>
            </section>
          )}

          {showForm && (
            <form className="card inline-form txn-form" onSubmit={onSubmit} noValidate>
              <h2 className="inline-form-title">
                {editingId ? "Edit transaction" : "Add transaction"}
              </h2>
              <div className="type-toggle" role="group" aria-label="Transaction type">
                {(["income", "expense"] as EntryType[]).map((entryType) => (
                  <button
                    key={entryType}
                    type="button"
                    className={type === entryType ? "type-option on" : "type-option"}
                    aria-pressed={type === entryType}
                    onClick={() => setType(entryType)}
                  >
                    {TYPE_LABELS[entryType]}
                  </button>
                ))}
              </div>

              <div className="form-row">
                <div className="field">
                  <label htmlFor="txn-amount">Amount</label>
                  <input
                    id="txn-amount"
                    className="input"
                    type="text"
                    inputMode="decimal"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    aria-invalid={Boolean(fieldErrors.amount)}
                    aria-describedby={fieldErrors.amount ? "txn-amount-error" : "txn-amount-hint"}
                    placeholder="0.00"
                    autoFocus
                  />
                  {fieldErrors.amount ? (
                    <p className="field-error" id="txn-amount-error">{fieldErrors.amount}</p>
                  ) : (
                    <p className="field-hint" id="txn-amount-hint">
                      Amount in {currency || activeProfile.currency}, e.g. 1200.50.
                    </p>
                  )}
                </div>
                <div className="field">
                  <label htmlFor="txn-currency">Currency</label>
                  <input
                    id="txn-currency"
                    className="input"
                    type="text"
                    value={currency}
                    onChange={(e) =>
                      setCurrency(e.target.value.replace(/[^a-z]/gi, "").toUpperCase())
                    }
                    aria-invalid={Boolean(fieldErrors.currency)}
                    aria-describedby={fieldErrors.currency ? "txn-currency-error" : undefined}
                    placeholder="PHP"
                    maxLength={3}
                    list="txn-currencies"
                    autoComplete="off"
                  />
                  <datalist id="txn-currencies">
                    {FEATURED_CURRENCIES.map((code) => (
                      <option key={code} value={code} />
                    ))}
                  </datalist>
                  {fieldErrors.currency && (
                    <p className="field-error" id="txn-currency-error">{fieldErrors.currency}</p>
                  )}
                </div>
                <div className="field">
                  <label htmlFor="txn-date">Date</label>
                  <input
                    id="txn-date"
                    className="input"
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    aria-invalid={Boolean(fieldErrors.date)}
                    aria-describedby={fieldErrors.date ? "txn-date-error" : undefined}
                  />
                  {fieldErrors.date && (
                    <p className="field-error" id="txn-date-error">{fieldErrors.date}</p>
                  )}
                </div>
              </div>

              <div className="field">
                <label htmlFor="txn-description">Description</label>
                <input
                  id="txn-description"
                  className="input"
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  aria-invalid={Boolean(fieldErrors.description)}
                  aria-describedby={
                    fieldErrors.description ? "txn-description-error" : undefined
                  }
                  placeholder="e.g. Rice delivery payment"
                />
                {fieldErrors.description && (
                  <p className="field-error" id="txn-description-error">
                    {fieldErrors.description}
                  </p>
                )}
              </div>

              <div className="form-row">
                <div className="field">
                  <label htmlFor="txn-category">Category (optional)</label>
                  <input
                    id="txn-category"
                    className="input"
                    type="text"
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    placeholder="e.g. Supplies"
                    list="txn-categories"
                    autoComplete="off"
                  />
                  <datalist id="txn-categories">
                    {categories.map((entry) => (
                      <option key={entry} value={entry} />
                    ))}
                  </datalist>
                </div>
                <div className="field">
                  <label htmlFor="txn-bucket">Bucket (optional)</label>
                  <select
                    id="txn-bucket"
                    className="input"
                    value={bucketId}
                    onChange={(e) => onSelectBucket(e.target.value)}
                    aria-invalid={Boolean(fieldErrors.bucket)}
                    aria-describedby={fieldErrors.bucket ? "txn-bucket-error" : "txn-bucket-hint"}
                  >
                    <option value="">No bucket</option>
                    {buckets.map((bucket) => (
                      <option key={bucket.id} value={bucket.id}>
                        {bucket.name} ({bucket.currency})
                      </option>
                    ))}
                  </select>
                  {fieldErrors.bucket ? (
                    <p className="field-error" id="txn-bucket-error">{fieldErrors.bucket}</p>
                  ) : (
                    <p className="field-hint" id="txn-bucket-hint">
                      {buckets.length === 0
                        ? "This business has no buckets yet."
                        : "Choosing a bucket uses that bucket's currency."}
                    </p>
                  )}
                </div>
              </div>

              {formError && <p className="alert-error" role="alert">{formError}</p>}
              <div className="row-actions">
                <button className="btn" type="submit" disabled={submitting}>
                  {submitting
                    ? "Saving…"
                    : editingId
                      ? "Save changes"
                      : `Add ${TYPE_LABELS[type].toLowerCase()}`}
                </button>
                <button
                  className="btn ghost"
                  type="button"
                  onClick={() => {
                    resetForm(activeProfile.currency);
                    setShowForm(false);
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

          {deleteTarget && (
            <section
              className="delete-panel"
              role="alertdialog"
              aria-labelledby="txn-delete-heading"
              aria-describedby="txn-delete-warning"
            >
              <h3 id="txn-delete-heading">Delete this transaction?</h3>
              <p id="txn-delete-warning">
                <strong>{deleteTarget.description}</strong> —{" "}
                {formatMoney(deleteTarget.amountMinor, deleteTarget.currency)} (
                {TYPE_LABELS[deleteTarget.type]}, {formatDate(deleteTarget.date)}).
                This permanently deletes the record from this browser and cannot
                be undone.
              </p>
              {deleteError && <p className="alert-error" role="alert">{deleteError}</p>}
              <div className="row-actions">
                <button
                  className="btn danger-solid"
                  type="button"
                  onClick={() => void onDelete()}
                  disabled={deleting}
                >
                  {deleting ? "Deleting…" : "Delete permanently"}
                </button>
                <button
                  className="btn ghost"
                  type="button"
                  onClick={() => setDeleteTarget(null)}
                  disabled={deleting}
                >
                  Cancel
                </button>
              </div>
            </section>
          )}

          <section className="panel txn-history" aria-labelledby="txn-history-heading">
            <div className="panel-head">
              <h2 id="txn-history-heading">History for {activeProfile.name}</h2>
              <span className="count-badge">
                {transactions.length} {transactions.length === 1 ? "record" : "records"}
              </span>
            </div>
            {notice && !showForm && <p className="notice" role="status">{notice}</p>}

            {transactions.length === 0 ? (
              <div className="empty-state dash-empty">
                <p>No transactions yet for {activeProfile.name}.</p>
                <p className="muted">
                  Use Add Transaction to record the first income or expense.
                  Records from other businesses are not shown here.
                </p>
              </div>
            ) : (
              <ul className="txn-list">
                {transactions.map((txn) => {
                  const editable = isEditable(txn);
                  const assignedBucket = bucketName(txn.bucketId);
                  return (
                    <li key={txn.id} className="txn-row">
                      <div className="txn-main">
                        <strong>{txn.description}</strong>
                        <p className="muted bucket-meta">
                          {formatDate(txn.date)} · {TYPE_LABELS[txn.type]}
                          {txn.category ? ` · ${txn.category}` : ""}
                          {assignedBucket ? ` · ${assignedBucket}` : ""}
                          {!editable ? ` · ${txn.origin}` : ""}
                        </p>
                      </div>
                      <span
                        className={
                          txn.type === "expense" ? "txn-amount amount-out" : "txn-amount amount-in"
                        }
                      >
                        {txn.type === "expense" ? "−" : "+"}
                        {formatMoney(txn.amountMinor, txn.currency)}
                      </span>
                      {editable ? (
                        <div className="row-actions txn-actions">
                          <button
                            className="btn ghost small"
                            type="button"
                            onClick={() => startEdit(txn)}
                          >
                            Edit
                          </button>
                          <button
                            className="danger-link"
                            type="button"
                            onClick={() => {
                              setDeleteTarget(txn);
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
    </section>
  );
}

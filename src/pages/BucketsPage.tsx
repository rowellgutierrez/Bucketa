import { useEffect, useState, type FormEvent } from "react";
import {
  bucketsRepo,
  deleteBusinessProfile,
  employeesRepo,
  productsRepo,
  profilesRepo,
  salesRepo,
  transactionsRepo,
} from "../data/db";
import type { Bucket, BucketKind, Profile, Transaction } from "../data/types";
import {
  BucketaDataError,
  newId,
  nowIso,
  validateBucket,
  validateProfile,
} from "../data/validation";
import { DEFAULT_CURRENCY, DEFAULT_LOCALE } from "../config";
import {
  FEATURED_CURRENCIES,
  formatMoney,
  isValidCurrency,
  minorUnitsToAmountInput,
  parseAmountToMinorUnits,
} from "../lib/currency";
import { canChangeBucketCurrency } from "../lib/recordForm";
import { bucketGoalProgress } from "../lib/finance";
import BuckyMascot from "../components/BuckyMascot";
import BusinessReport, { type BusinessReportData } from "../components/BusinessReport";


const KIND_LABELS: Record<BucketKind, string> = {
  savings: "Savings",
  budget: "Budget",
  allocated: "Allocated",
};
const KIND_ORDER: BucketKind[] = ["savings", "budget", "allocated"];

type Status = "loading" | "ready" | "error";

function errorMessage(error: unknown): string {
  if (error instanceof BucketaDataError || error instanceof Error) return error.message;
  return "Something went wrong. Please try again.";
}

function isCurrency(value: string): boolean {
  return /^[A-Z]{3}$/.test(value) && isValidCurrency(value);
}

function byCreatedAt<T extends { createdAt: string; name: string }>(a: T, b: T): number {
  return a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name);
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(DEFAULT_LOCALE, { dateStyle: "medium" }).format(new Date(value));
}

export default function BucketsPage() {
  const [status, setStatus] = useState<Status>("loading");
  const [loadError, setLoadError] = useState("");
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profileId, setProfileId] = useState("");
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [bucketCounts, setBucketCounts] = useState<Record<string, number>>({});

  const [newBusinessName, setNewBusinessName] = useState("");
  const [newBusinessCurrency, setNewBusinessCurrency] = useState<string>(DEFAULT_CURRENCY);
  const [profileFieldErrors, setProfileFieldErrors] = useState<Record<string, string>>({});
  const [profileError, setProfileError] = useState("");
  const [profileNotice, setProfileNotice] = useState("");
  const [creatingProfile, setCreatingProfile] = useState(false);
  const [editingId, setEditingId] = useState("");
  const [renameName, setRenameName] = useState("");
  const [renameCurrency, setRenameCurrency] = useState<string>(DEFAULT_CURRENCY);
  const [editingBucketId, setEditingBucketId] = useState("");
  const [goalConfirmed, setGoalConfirmed] = useState(false);
  const [renameError, setRenameError] = useState("");
  const [renaming, setRenaming] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<Profile | null>(null);
  const [deleteConfirmName, setDeleteConfirmName] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState(false);

  const [report, setReport] = useState<BusinessReportData | null>(null);
  const [printPending, setPrintPending] = useState(false);
  const [reportLoadingId, setReportLoadingId] = useState("");
  const [showBucketForm, setShowBucketForm] = useState(false);
  const [showCreateBusiness, setShowCreateBusiness] = useState(false);

  const [name, setName] = useState("");
  const [kind, setKind] = useState<BucketKind>("budget");
  const [currency, setCurrency] = useState<string>(DEFAULT_CURRENCY);
  const [target, setTarget] = useState("");
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [notice, setNotice] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function refreshBucketCounts() {
    const all = await bucketsRepo.listAll();
    const counts: Record<string, number> = {};
    for (const bucket of all) counts[bucket.profileId] = (counts[bucket.profileId] ?? 0) + 1;
    setBucketCounts(counts);
  }

  async function loadBuckets(forProfileId: string) {
    const [list, txns] = await Promise.all([
      bucketsRepo.listByProfile(forProfileId),
      transactionsRepo.listByProfile(forProfileId),
    ]);
    setBuckets([...list].sort(byCreatedAt));
    setTransactions(txns);
  }

  async function load(preferredProfileId = "") {
    setStatus("loading");
    setLoadError("");
    try {
      const all = await profilesRepo.listAll();
      const businesses = all.filter((p) => p.kind === "business").sort(byCreatedAt);
      setProfiles(businesses);
      const selected = businesses.find((p) => p.id === preferredProfileId) ?? businesses[0];
      if (selected) {
        setProfileId(selected.id);
        setCurrency(selected.currency);
        await loadBuckets(selected.id);
      } else {
        setProfileId("");
        setBuckets([]);
      }
      await refreshBucketCounts();
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

  useEffect(() => {
    if (!report || !printPending) return;
    const timer = setTimeout(() => {
      window.print();
      setPrintPending(false);
    }, 50);
    return () => clearTimeout(timer);
  }, [report, printPending]);

  async function switchProfile(id: string) {
    const target = profiles.find((p) => p.id === id);
    if (!target || id === profileId) return;
    setProfileId(id);
    setCurrency(target.currency);
    setEditingId("");
    setShowBucketForm(false);
    setDeleteTarget(null);
    setNotice("");
    setFormError("");
    setProfileNotice("");
    setProfileError("");
    try {
      await loadBuckets(id);
    } catch (error) {
      setFormError(errorMessage(error));
      setBuckets([]);
    }
  }

  async function onCreateProfile(event: FormEvent) {
    event.preventDefault();
    setProfileError("");
    setProfileNotice("");
    const trimmed = newBusinessName.trim();
    const normalized = newBusinessCurrency.trim().toUpperCase();
    const errors: Record<string, string> = {};
    if (!trimmed) errors.businessName = "Business name is required.";
    if (!isCurrency(normalized)) {
      errors.businessCurrency = "Enter a valid ISO 4217 currency code, e.g. PHP.";
    }
    setProfileFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    const stamp = nowIso();
    const profile: Profile = {
      id: newId(), kind: "business", name: trimmed, currency: normalized,
      createdAt: stamp, updatedAt: stamp,
    };
    setCreatingProfile(true);
    try {
      validateProfile(profile);
      await profilesRepo.create(profile);
      setProfiles((prev) => [...prev, profile].sort(byCreatedAt));
      setBucketCounts((prev) => ({ ...prev, [profile.id]: 0 }));
      setNewBusinessName("");
      setProfileFieldErrors({});
      setShowCreateBusiness(false);
      setProfileId(profile.id);
      setCurrency(profile.currency);
      setBuckets([]);
      setNotice("");
      setProfileNotice(`Business “${profile.name}” created and selected.`);
    } catch (error) {
      setProfileError(errorMessage(error));
    } finally {
      setCreatingProfile(false);
    }
  }

  function startEditBucket(bucket: Bucket) {
    setEditingBucketId(bucket.id);
    setName(bucket.name);
    setKind(bucket.kind);
    setCurrency(bucket.currency);
    setTarget(bucket.targetMinor ? minorUnitsToAmountInput(bucket.targetMinor, bucket.currency) : "");
    setGoalConfirmed(false);
    setFieldErrors({});
    setFormError("");
    setDeleteTarget(null);
    setShowBucketForm(true);
  }

  function assignedCount(bucketId: string): number {
    return transactions.filter((t) => t.bucketId === bucketId).length;
  }

  function startRename(profile: Profile) {
    setEditingId(profile.id);
    setRenameName(profile.name);
    setRenameCurrency(profile.currency);
    setRenameError("");
    setProfileError("");
    setProfileNotice("");
  }

  async function onRename(event: FormEvent, profile: Profile) {
    event.preventDefault();
    const trimmed = renameName.trim();
    if (!trimmed) {
      setRenameError("Business name is required.");
      return;
    }
    const normalizedCurrency = renameCurrency.trim().toUpperCase();
    if (!isCurrency(normalizedCurrency)) {
      setRenameError("Enter a valid ISO 4217 currency code, e.g. PHP.");
      return;
    }
    if (trimmed === profile.name && normalizedCurrency === profile.currency) {
      setEditingId("");
      return;
    }
    setRenaming(true);
    try {
      const updated = await profilesRepo.update(profile.id, {
        name: trimmed,
        currency: normalizedCurrency,
      });
      setProfiles((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
      if (updated.id === profileId) setCurrency(updated.currency);
      if (deleteTarget?.id === updated.id) setDeleteTarget(updated);
      setEditingId("");
      setProfileNotice(
        `Business “${updated.name}” saved. Its default currency is now ${updated.currency}; existing buckets and records keep their own currencies — nothing was converted.`,
      );
    } catch (error) {
      setRenameError(errorMessage(error));
    } finally {
      setRenaming(false);
    }
  }

  async function printReport(profile: Profile) {
    setProfileError("");
    setReportLoadingId(profile.id);
    try {
      const [profileBuckets, transactions, products, employees, sales] = await Promise.all([
        bucketsRepo.listByProfile(profile.id),
        transactionsRepo.listByProfile(profile.id),
        productsRepo.listByProfile(profile.id),
        employeesRepo.listByProfile(profile.id),
        salesRepo.listByProfile(profile.id),
      ]);
      setReport({
        profile,
        buckets: [...profileBuckets].sort(byCreatedAt),
        transactions, products, employees, sales,
        generatedAt: nowIso(),
      });
      setPrintPending(true);
    } catch (error) {
      setProfileError(`Could not prepare the report: ${errorMessage(error)}`);
    } finally {
      setReportLoadingId("");
    }
  }

  function askDelete(profile: Profile) {
    setDeleteTarget(profile);
    setDeleteConfirmName("");
    setDeleteError("");
    setEditingId("");
    setProfileError("");
    setProfileNotice("");
  }

  async function onDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError("");
    try {
      const summary = await deleteBusinessProfile(deleteTarget.id);
      const deletedName = deleteTarget.name;
      const wasActive = deleteTarget.id === profileId;
      setDeleteTarget(null);
      setDeleteConfirmName("");
      await load(wasActive ? "" : profileId);
      setProfileNotice(
        `Business “${deletedName}” permanently deleted (${summary.buckets} buckets, ` +
          `${summary.transactions} transactions, ${summary.products} products, ` +
          `${summary.employees} employees, ${summary.sales} sales).`,
      );
    } catch (error) {
      setDeleteError(errorMessage(error));
      void load(profileId);
    } finally {
      setDeleting(false);
    }
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError("");
    setNotice("");
    if (!profileId) {
      setFormError("Create a business above before creating a bucket.");
      return;
    }
    const errors: Record<string, string> = {};
    const trimmedName = name.trim();
    const normalizedCurrency = currency.trim().toUpperCase();
    if (!trimmedName) errors.name = "Bucket name is required.";
    if (!isCurrency(normalizedCurrency)) {
      errors.currency = "Enter a valid ISO 4217 currency code, e.g. PHP.";
    }
    let targetMinor: number | null = null;
    if (target.trim()) {
      try {
        targetMinor = parseAmountToMinorUnits(target, normalizedCurrency);
        if (targetMinor <= 0) errors.target = "Goal must be greater than zero, or blank for no goal.";
      } catch (error) {
        errors.target = errorMessage(error);
      }
    }
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    const stamp = nowIso();
    const editingBucket = buckets.find((b) => b.id === editingBucketId);
    if (editingBucket) {
      const assigned = assignedCount(editingBucket.id);
      const currencyChanged = normalizedCurrency !== editingBucket.currency;
      if (currencyChanged && !canChangeBucketCurrency(assigned)) {
        setFormError(
          `This bucket's currency cannot be changed because ${assigned} ` +
            `${assigned === 1 ? "record is" : "records are"} assigned to it. ` +
            `To correct it: in Transactions, edit each assigned record, set ` +
            `its bucket to None, correct and save its currency, then change ` +
            `this bucket's currency and reassign the records. No record is ` +
            `changed automatically.`,
        );
        return;
      }
      if (currencyChanged && editingBucket.targetMinor && !goalConfirmed) {
        setFormError(
          "Review the goal amount below and confirm it before changing the " +
            "currency. The same goal number will be read in the new currency " +
            "with no conversion.",
        );
        return;
      }
      setSubmitting(true);
      try {
        const updated = await bucketsRepo.update(editingBucket.id, {
          name: trimmedName, kind, currency: normalizedCurrency, targetMinor,
        });
        setBuckets((prev) => prev.map((b) => (b.id === updated.id ? updated : b)));
        setEditingBucketId("");
        setShowBucketForm(false);
        setTarget("");
        setGoalConfirmed(false);
        setNotice(
          currencyChanged
            ? `Bucket “${updated.name}” is now in ${updated.currency}. Existing records were not changed or converted.`
            : `Bucket “${updated.name}” updated.`,
        );
      } catch (error) {
        setFormError(errorMessage(error));
      } finally {
        setSubmitting(false);
      }
      return;
    }

    const bucket: Bucket = {
      id: newId(), profileId, name: trimmedName, kind,
      currency: normalizedCurrency, targetMinor, createdAt: stamp, updatedAt: stamp,
    };
    setSubmitting(true);
    try {
      validateBucket(bucket);
      await bucketsRepo.create(bucket);
      setBuckets((prev) => [...prev, bucket].sort(byCreatedAt));
      setBucketCounts((prev) => ({ ...prev, [profileId]: (prev[profileId] ?? 0) + 1 }));
      setName("");
      setFieldErrors({});
      setShowBucketForm(false);
      setNotice(`Bucket “${bucket.name}” created.`);
      setTarget("");
    } catch (error) {
      setFormError(errorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  const activeProfile = profiles.find((p) => p.id === profileId);
  const deleteConfirmed = deleteTarget !== null && deleteConfirmName === deleteTarget.name;
  const bucketCurrencies = [...new Set(buckets.map((b) => b.currency))].sort();
  const kindSummary = KIND_ORDER
    .map((k) => ({ kind: k, count: buckets.filter((b) => b.kind === k).length }))
    .filter((entry) => entry.count > 0);

  return (
    <section className="page buckets-dashboard">
      <header className="dash-header">
        <div>
          <h1>Business Buckets</h1>
          <p className="muted dash-subtitle">
            Buckets are envelopes inside one business — for example Rent, Supplies, or Tax — so each part of the business money has a job.
          </p>
        </div>
        {activeProfile && (
          <button
            className="btn"
            type="button"
            aria-expanded={showBucketForm}
            onClick={() => setShowBucketForm((v) => !v)}
          >
            {showBucketForm ? "Close" : "Add Bucket"}
          </button>
        )}
      </header>

      {status === "loading" && (
        <div className="card" role="status">Loading your businesses and buckets…</div>
      )}

      {status === "error" && (
        <div className="card">
          <p className="alert-error" role="alert">Could not load businesses: {loadError}</p>
          <button className="btn" type="button" onClick={() => void load(profileId)}>Retry</button>
        </div>
      )}

      {status === "ready" && (
        <>
          {profiles.length > 0 && activeProfile && (
            <div className="selector-bar">
              <div className="selector-main">
                <label htmlFor="business-select">Business</label>
                <select
                  id="business-select"
                  className="input selector-select"
                  value={profileId}
                  onChange={(e) => void switchProfile(e.target.value)}
                >
                  {profiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                    </option>
                  ))}
                </select>
                <span className="muted selector-meta">
                  {activeProfile.currency} · {buckets.length}{" "}
                  {buckets.length === 1 ? "bucket" : "buckets"} · since{" "}
                  {formatDate(activeProfile.createdAt)}
                </span>
              </div>
              <div className="row-actions selector-actions">
                <button
                  className="btn ghost small"
                  type="button"
                  onClick={() => startRename(activeProfile)}
                  aria-expanded={editingId === activeProfile.id}
                >
                  Edit business
                </button>
                <button
                  className="btn ghost small"
                  type="button"
                  onClick={() => void printReport(activeProfile)}
                  disabled={reportLoadingId === activeProfile.id}
                >
                  {reportLoadingId === activeProfile.id ? "Preparing…" : "Print"}
                </button>
                <button
                  className="btn ghost small"
                  type="button"
                  aria-expanded={showCreateBusiness}
                  onClick={() => setShowCreateBusiness((v) => !v)}
                >
                  New business
                </button>
                <button
                  className="danger-link"
                  type="button"
                  onClick={() => askDelete(activeProfile)}
                >
                  Delete…
                </button>
              </div>
            </div>
          )}

          {activeProfile && editingId === activeProfile.id && (
            <form className="card inline-form" onSubmit={(e) => void onRename(e, activeProfile)}>
              <div className="field">
                <label htmlFor={`rename-${activeProfile.id}`}>
                  Edit “{activeProfile.name}”
                </label>
                <input
                  id={`rename-${activeProfile.id}`}
                  className="input"
                  type="text"
                  value={renameName}
                  onChange={(e) => setRenameName(e.target.value)}
                  aria-invalid={Boolean(renameError)}
                  aria-describedby={renameError ? "rename-error" : "rename-hint"}
                  autoComplete="organization"
                  autoFocus
                />
                {renameError ? (
                  <p className="field-error" id="rename-error">{renameError}</p>
                ) : (
                  <>
                  <label htmlFor="rename-currency">Default currency</label>
                <input
                  id="rename-currency"
                  className="input"
                  type="text"
                  value={renameCurrency}
                  onChange={(e) =>
                    setRenameCurrency(e.target.value.replace(/[^a-z]/gi, "").toUpperCase())
                  }
                  placeholder="PHP"
                  maxLength={3}
                  list="featured-currencies"
                  autoComplete="off"
                />
                <p className="field-hint" id="rename-hint">
                    Currency here is only the default for new buckets and records. Existing buckets and records keep their own currency — nothing is converted.
                  </p>
                  </>
                )}
              </div>
              <div className="row-actions">
                <button className="btn small" type="submit" disabled={renaming}>
                  {renaming ? "Saving…" : "Save changes"}
                </button>
                <button
                  className="btn ghost small"
                  type="button"
                  onClick={() => setEditingId("")}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

          {(showCreateBusiness || profiles.length === 0) && (
            <form className="card inline-form" onSubmit={onCreateProfile} noValidate>
              <h2 className="inline-form-title">Create a business</h2>
              <div className="form-row">
                <div className="field">
                  <label htmlFor="profile-name">Business name</label>
                  <input
                    id="profile-name"
                    className="input"
                    type="text"
                    value={newBusinessName}
                    onChange={(e) => setNewBusinessName(e.target.value)}
                    aria-invalid={Boolean(profileFieldErrors.businessName)}
                    aria-describedby={
                      profileFieldErrors.businessName ? "profile-name-error" : undefined
                    }
                    placeholder="e.g. Sari Store"
                    autoComplete="organization"
                  />
                  {profileFieldErrors.businessName && (
                    <p className="field-error" id="profile-name-error">
                      {profileFieldErrors.businessName}
                    </p>
                  )}
                </div>
                <div className="field">
                  <label htmlFor="profile-currency">Currency</label>
                  <input
                    id="profile-currency"
                    className="input"
                    type="text"
                    value={newBusinessCurrency}
                    onChange={(e) =>
                      setNewBusinessCurrency(e.target.value.replace(/[^a-z]/gi, "").toUpperCase())
                    }
                    aria-invalid={Boolean(profileFieldErrors.businessCurrency)}
                    aria-describedby={
                      profileFieldErrors.businessCurrency ? "profile-currency-error" : undefined
                    }
                    placeholder="PHP"
                    maxLength={3}
                    list="featured-currencies"
                    autoComplete="off"
                  />
                  {profileFieldErrors.businessCurrency && (
                    <p className="field-error" id="profile-currency-error">
                      {profileFieldErrors.businessCurrency}
                    </p>
                  )}
                </div>
              </div>
              <datalist id="featured-currencies">
                {FEATURED_CURRENCIES.map((code) => (
                  <option key={code} value={code} />
                ))}
              </datalist>
              <div className="row-actions">
                <button className="btn" type="submit" disabled={creatingProfile}>
                  {creatingProfile ? "Creating…" : "Create business"}
                </button>
                {profiles.length > 0 && (
                  <button
                    className="btn ghost"
                    type="button"
                    onClick={() => setShowCreateBusiness(false)}
                  >
                    Cancel
                  </button>
                )}
              </div>
            </form>
          )}

          {deleteTarget && (
            <section
              className="delete-panel"
              role="alertdialog"
              aria-labelledby="delete-heading"
              aria-describedby="delete-warning"
            >
              <h3 id="delete-heading">Delete “{deleteTarget.name}”?</h3>
              <p id="delete-warning" className="alert-error">
                This permanently deletes this business and all of its buckets,
                transactions, products, employees, and sales stored in this
                browser. This cannot be undone. Records belonging to other
                businesses are not deleted, and deletion is stopped if any
                related record cannot be safely identified.
              </p>
              <p className="muted">
                {bucketCounts[deleteTarget.id] ?? 0}{" "}
                {(bucketCounts[deleteTarget.id] ?? 0) === 1 ? "bucket" : "buckets"} will be
                deleted, along with any other records for this business.
              </p>
              <button
                className="btn ghost"
                type="button"
                onClick={() => void printReport(deleteTarget)}
                disabled={reportLoadingId === deleteTarget.id}
              >
                {reportLoadingId === deleteTarget.id
                  ? "Preparing report…"
                  : "Print report first"}
              </button>
              <div className="field">
                <label htmlFor="delete-confirm">Type the business name exactly to confirm</label>
                <input
                  id="delete-confirm"
                  className="input"
                  type="text"
                  value={deleteConfirmName}
                  onChange={(e) => setDeleteConfirmName(e.target.value)}
                  placeholder={deleteTarget.name}
                  autoComplete="off"
                />
              </div>
              {deleteError && <p className="alert-error" role="alert">{deleteError}</p>}
              <div className="row-actions">
                <button
                  className="btn danger-solid"
                  type="button"
                  onClick={() => void onDelete()}
                  disabled={!deleteConfirmed || deleting}
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

          {profileError && <p className="alert-error dash-alert" role="alert">{profileError}</p>}
          {profileNotice && <p className="notice dash-alert" role="status">{profileNotice}</p>}

          {activeProfile ? (
            <section className="panel buckets-panel" aria-labelledby="buckets-heading">
              <div className="panel-head">
                <h2 id="buckets-heading">Buckets</h2>
                <span className="count-badge">
                  {buckets.length} {buckets.length === 1 ? "bucket" : "buckets"}
                </span>
              </div>

              {buckets.length > 0 && (
                <p className="summary-line">
                  {kindSummary
                    .map((e) => `${e.count} ${KIND_LABELS[e.kind]}`)
                    .join(" · ")}
                  {" · Currencies: "}
                  {bucketCurrencies.join(", ")}
                  <span className="muted"> — kept separate, never combined.</span>
                </p>
              )}
              {notice && !showBucketForm && (
                <p className="notice" role="status">{notice}</p>
              )}
              {formError && !showBucketForm && (
                <p className="alert-error" role="alert">{formError}</p>
              )}

              {showBucketForm && (
                <form className="inline-form bucket-create" onSubmit={onSubmit} noValidate>
                  <h3>{editingBucketId ? "Edit bucket" : `Create a bucket for ${activeProfile.name}`}</h3>
                  <div className="field">
                    <label htmlFor="bucket-name">Bucket name</label>
                    <input
                      id="bucket-name"
                      className="input"
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      aria-invalid={Boolean(fieldErrors.name)}
                      aria-describedby={fieldErrors.name ? "bucket-name-error" : undefined}
                      placeholder="e.g. Rent fund"
                      autoFocus
                    />
                    {fieldErrors.name && (
                      <p className="field-error" id="bucket-name-error">{fieldErrors.name}</p>
                    )}
                  </div>
                  <div className="form-row">
                    <div className="field">
                      <label htmlFor="bucket-kind">Type</label>
                      <p className="field-hint">Savings: set aside · Budget: planned spending · Allocated: a specific purpose</p>
                      <select
                        id="bucket-kind"
                        className="input"
                        value={kind}
                        onChange={(e) => setKind(e.target.value as BucketKind)}
                      >
                        {KIND_ORDER.map((k) => (
                          <option key={k} value={k}>{KIND_LABELS[k]}</option>
                        ))}
                      </select>
                    </div>
                    <div className="field">
                      <label htmlFor="bucket-goal">Goal amount (optional)</label>
                      <input
                        id="bucket-goal"
                        className="input"
                        type="text"
                        inputMode="decimal"
                        value={target}
                        onChange={(e) => setTarget(e.target.value)}
                        placeholder="e.g. 100000"
                        aria-invalid={Boolean(fieldErrors.target)}
                        aria-describedby={fieldErrors.target ? "bucket-goal-error" : "bucket-goal-hint"}
                      />
                      {fieldErrors.target ? (
                        <p className="field-error" id="bucket-goal-error">{fieldErrors.target}</p>
                      ) : (
                        <p className="field-hint" id="bucket-goal-hint">
                          Bucky&apos;s bucket fills toward this goal from records assigned here.
                        </p>
                      )}
                    </div>
                    <div className="field">
                      <label htmlFor="bucket-currency">Currency</label>
                      <input
                        id="bucket-currency"
                        className="input"
                        type="text"
                        value={currency}
                        onChange={(e) =>
                          setCurrency(e.target.value.replace(/[^a-z]/gi, "").toUpperCase())
                        }
                        aria-invalid={Boolean(fieldErrors.currency)}
                        aria-describedby={
                          fieldErrors.currency ? "bucket-currency-error" : "bucket-currency-hint"
                        }
                        placeholder="PHP"
                        maxLength={3}
                        list="featured-currencies"
                        autoComplete="off"
                      />
                      {fieldErrors.currency ? (
                        <p className="field-error" id="bucket-currency-error">
                          {fieldErrors.currency}
                        </p>
                      ) : (
                        <p className="field-hint" id="bucket-currency-hint">
                          Defaults to {activeProfile.name}&apos;s currency (
                          {activeProfile.currency}). Change it only for a bucket
                          kept in another currency.
                        </p>
                      )}
                    </div>
                  </div>
                  {formError && <p className="alert-error" role="alert">{formError}</p>}
                  {editingBucketId &&
                    (() => {
                      const original = buckets.find((b) => b.id === editingBucketId);
                      const assigned = original ? assignedCount(original.id) : 0;
                      return assigned > 0 ? (
                        <p className="field-hint">
                          Currency is locked while {assigned}{" "}
                          {assigned === 1 ? "record is" : "records are"} assigned to this
                          bucket. Unassign a record in Transactions (set its bucket to
                          None) to correct its currency, then reassign it.
                        </p>
                      ) : null;
                    })()}
                  {editingBucketId &&
                    (() => {
                      const original = buckets.find((b) => b.id === editingBucketId);
                      if (!original?.targetMinor || currency.trim().toUpperCase() === original.currency) return null;
                      return (
                        <label className="field-hint">
                          <input
                            type="checkbox"
                            checked={goalConfirmed}
                            onChange={(e) => setGoalConfirmed(e.target.checked)}
                          />{" "}
                          I reviewed the goal amount ({target || "blank"}). It will be read in{" "}
                          {currency.trim().toUpperCase() || "the new currency"} with no conversion.
                        </label>
                      );
                    })()}
                  {notice && <p className="notice" role="status">{notice}</p>}
                  <div className="row-actions">
                    <button className="btn" type="submit" disabled={submitting}>
                      {submitting ? "Saving…" : editingBucketId ? "Save changes" : "Create bucket"}
                    </button>
                    <button
                      className="btn ghost"
                      type="button"
                      onClick={() => {
                        setShowBucketForm(false);
                        setEditingBucketId("");
                        setGoalConfirmed(false);
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              )}

              {(() => {
                const goalBucket = buckets.find((b) => bucketGoalProgress(transactions, b));
                const progress = goalBucket ? bucketGoalProgress(transactions, goalBucket) : null;
                return (
                  <div className="bucky-row">
                    {/* Normal 3D Bucky: Savings mode with internal coins is
                        reserved for Personal Finance savings goals only. */}
                    <BuckyMascot size="row" label="Bucky watching this business's goals" />
                    <div>
                      <strong>Bucky keeps an eye on {activeProfile.name}&apos;s goals</strong>
                      {goalBucket && progress ? (
                        <p className="muted bucket-meta">
                          {goalBucket.name}: {formatMoney(progress.savedMinor, goalBucket.currency)} of{" "}
                          {formatMoney(goalBucket.targetMinor ?? 0, goalBucket.currency)} goal ({Math.round(progress.percent)}% full)
                          {progress.percent >= 100 ? " — goal reached, well done!" : " from records assigned to this bucket."}
                        </p>
                      ) : (
                        <p className="muted bucket-meta">
                          Set a goal amount when creating a bucket and Bucky&apos;s bucket will fill with coins as business records are assigned to it.
                        </p>
                      )}
                    </div>
                  </div>
                );
              })()}
              <details className="help-details">
                <summary>What do the bucket types mean?</summary>
                <p className="muted">
                  Savings — money set aside. Budget — a planned spending area.
                  Allocated — money assigned to a specific purpose. Any bucket
                  total is recorded net cash flow, not a bank or account balance.
                </p>
              </details>

              {buckets.length === 0 ? (
                <div className="empty-state dash-empty">
                  <p>No buckets yet for {activeProfile.name}.</p>
                  <p className="muted">
                    Buckets organise records you assign to them — they do not
                    hold money by themselves, so no amount is shown until
                    records are assigned.
                  </p>
                  <p className="muted">
                    Use the Add Bucket button above to create the first one, then record business transactions and assign them to it.
                    
                  </p>
                </div>
              ) : (
                <ul className="bucket-list clean-list">
                  {buckets.map((bucket) => (
                    <li key={bucket.id} className="bucket-row">
                      <div>
                        <strong>{bucket.name}</strong>
                        <p className="muted bucket-meta">
                          {KIND_LABELS[bucket.kind]} · Created {formatDate(bucket.createdAt)}
                          {bucket.targetMinor
                            ? ` · Goal ${formatMoney(bucket.targetMinor, bucket.currency)} (${Math.round(bucketGoalProgress(transactions, bucket)?.percent ?? 0)}% full)`
                            : ""}
                        </p>
                      </div>
                      <span className="currency-badge">{bucket.currency}</span>
                      <button className="btn ghost small" type="button" onClick={() => startEditBucket(bucket)}>
                        Edit
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : (
            profiles.length === 0 && (
              <div className="card empty-state">
                <p>No businesses yet.</p>
                <p className="muted">
                  Use the “Create a business” form above (step 1). After that, add buckets for it here (step 2), then record its income and expenses in Transactions and assign them to a bucket. Each business, its buckets, and its currency stay separate.
                </p>
              </div>
            )
          )}

        </>
      )}

      {report && <BusinessReport data={report} />}
    </section>
  );
}

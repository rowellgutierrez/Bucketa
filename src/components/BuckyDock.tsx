import { useCallback, useEffect, useRef, useState } from "react";
import { bucketsRepo, employeesRepo, productsRepo, profilesRepo, salesRepo, transactionsRepo } from "../data/db";
import type { Bucket, Employee, Product, Profile, Sale, Transaction } from "../data/types";
import BuckyMascot from "./BuckyMascot";
import BuckyPanel from "./BuckyPanel";
import ScannerPage from "../pages/ScannerPage";
import { onRecordsChanged } from "../lib/dataChange";
import Icon from "./ui/Icon";

type Status = "idle" | "loading" | "ready" | "error";

/**
 * App-wide Bucky access: a compact mascot launcher + drawer available on
 * every page except the dashboard (which already hosts the full panel).
 * Records are loaded fresh from IndexedDB each time the drawer opens, so
 * answers always reflect what is saved right now. Bucky can prepare
 * bookkeeping entries inside, but saves only after the user reviews a
 * preview and confirms; a confirmed save refreshes this data silently so
 * the panel keeps its saved-result message. An unsaved preview blocks
 * closing (Escape, backdrop, or the close button) until the user confirms
 * or cancels it, so a prepared record is never silently discarded.
 */
export default function BuckyDock() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [sales, setSales] = useState<Sale[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [hasPendingAction, setHasPendingAction] = useState(false);
  const [showPendingHint, setShowPendingHint] = useState(false);
  // Embedded scanner (Checkpoint B): the same ScannerPage workflow runs
  // inside this dialog. Its unsaved-review state vetoes closing exactly
  // like an unsaved Bucky preview does.
  const [scanMode, setScanMode] = useState(false);
  const [scannerDirty, setScannerDirty] = useState(false);
  const handleScannerDirty = useCallback((dirty: boolean) => setScannerDirty(dirty), []);
  const dialog = useRef<HTMLDialogElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const reducedMotion = useRef(
    typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  ).current;

  const load = useCallback(async (silent = false) => {
    if (!silent) setStatus("loading");
    try {
      const [p, b, t, pr, s, e] = await Promise.all([
        profilesRepo.listAll(),
        bucketsRepo.listAll(),
        transactionsRepo.listAll(),
        productsRepo.listAll(),
        salesRepo.listAll(),
        employeesRepo.listAll(),
      ]);
      setProfiles(p);
      setBuckets(b);
      setTransactions(t);
      setProducts(pr);
      setSales(s);
      setEmployees(e);
      setStatus("ready");
    } catch {
      if (!silent) setStatus("error");
    }
  }, []);

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (open && !el.open) {
      void load();
      el.showModal();
    }
    if (!open && el.open) {
      el.close();
      launcher.current?.focus();
    }
  }, [open, load]);

  // Confirmed saves anywhere (including the embedded scanner) refresh the
  // panel's data silently so answers stay current without a reopen.
  useEffect(() => onRecordsChanged(() => { void load(true); }), [load]);

  // The protection hint lasts only while a preview is actually pending.
  useEffect(() => {
    if (!hasPendingAction && !scannerDirty) setShowPendingHint(false);
  }, [hasPendingAction, scannerDirty]);

  const hasUnsavedWork = hasPendingAction || (scanMode && scannerDirty);

  /** Returns true when closing (and therefore navigation) is allowed. */
  function requestClose(): boolean {
    if (hasUnsavedWork) {
      setShowPendingHint(true);
      return false;
    }
    setOpen(false);
    return true;
  }

  /** Scan opens in place — unless an unsaved preview would be discarded. */
  function requestScan(): void {
    if (hasPendingAction) {
      setShowPendingHint(true);
      return;
    }
    setScanMode(true);
  }

  /** Back to the conversation; an unsaved scan review blocks leaving. */
  function exitScanMode(): void {
    if (scannerDirty) {
      setShowPendingHint(true);
      return;
    }
    setScanMode(false);
  }

  return (
    <>
      {!open && (
        <button
          ref={launcher}
          className="bucky-dock-launcher bucky-dock-launcher--mascot"
          type="button"
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
          aria-label="Open Bucky, your financial assistant"
        >
          <BuckyMascot animation={reducedMotion ? undefined : "Breathing"} label="" />
          <span>Bucky</span>
        </button>
      )}
      <dialog
        ref={dialog}
        className={scanMode ? "bucky-dock-dialog bucky-dock-dialog--scan" : "bucky-dock-dialog"}
        aria-labelledby="bucky-dock-heading"
        onCancel={(e) => {
          // Escape must never silently discard an unsaved preview.
          e.preventDefault();
          requestClose();
        }}
        onClose={() => {
          setOpen(false);
          setScanMode(false);
          setScannerDirty(false);
        }}
      >
        <div className="bucky-dock-head">
          {/* The panel inside carries the full "Bucky Financial
              Intelligence" heading; the dialog keeps a short label so the
              branding is not duplicated on narrow screens. */}
          <h2 id="bucky-dock-heading">{scanMode ? "Scan a record" : "Bucky"}</h2>
          <div className="row-actions">
            {scanMode && (
              <button className="btn ghost" type="button" onClick={exitScanMode}>
                Back to Bucky
              </button>
            )}
            <button className="btn ghost" type="button" onClick={requestClose} aria-label="Close Bucky">
              <Icon name="close" />
            </button>
          </div>
        </div>
        {showPendingHint && hasUnsavedWork && (
          <p className="alert-error" role="alert">
            {scanMode && scannerDirty
              ? "You have an unsaved scan review. Save it, or discard it with the scanner's own controls, before closing — closing now would discard it."
              : "You have an unsaved preview. Confirm or cancel it before closing Bucky — closing now would discard it."}
          </p>
        )}
        {scanMode ? (
          <ScannerPage embedded onDirtyChange={handleScannerDirty} onExit={() => setOpen(false)} />
        ) : status === "loading" || status === "idle" ? (
          <p role="status">Loading your saved records…</p>
        ) : status === "error" ? (
          <div>
            <p className="alert-error" role="alert">Bucky couldn't load your records. Nothing was changed.</p>
            <button className="btn" type="button" onClick={() => void load()}>Retry</button>
          </div>
        ) : (
          <BuckyPanel
            profiles={profiles}
            buckets={buckets}
            transactions={transactions}
            products={products}
            sales={sales}
            employees={employees}
            onRecordsChanged={() => void load(true)}
            onPendingActionChange={setHasPendingAction}
            onNavigateAway={requestClose}
            onScanRequest={requestScan}
          />
        )}
      </dialog>
    </>
  );
}

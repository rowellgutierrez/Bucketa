import {getBuckyPageProfile,subscribeBuckyPageProfile} from '../lib/buckyProfileContext';
import {getBuckyPresentation,subscribeBuckyPresentation,setBuckyOpen,setBuckyInline,recordBuckyEvent} from "../lib/buckyPresentation";
import BuckyStatusMascot from "./BuckyStatusMascot";
import {formatMoney} from "../lib/currency";
import { BUCKY_OPEN_EVENT, type BuckyConversationRequest } from "../lib/buckyConversation";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { bucketsRepo, employeesRepo, productsRepo, profilesRepo, salesRepo, transactionsRepo } from "../data/db";
import type { Bucket, Employee, Product, Profile, Sale, Transaction } from "../data/types";
import BuckyPanel from "./BuckyPanel";
import ScannerPage from "../pages/ScannerPage";
import { onRecordsChanged } from "../lib/dataChange";
import Icon from "./ui/Icon";

import {createPortal} from 'react-dom';

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
export default function BuckyDock({hideLauncher = false}: {hideLauncher?: boolean}) {
  const pageProfile=useSyncExternalStore(subscribeBuckyPageProfile,getBuckyPageProfile,getBuckyPageProfile);
  const presentation = useSyncExternalStore(subscribeBuckyPresentation,getBuckyPresentation,getBuckyPresentation);
  const [request, setRequest] = useState<BuckyConversationRequest | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [requestReady, setRequestReady] = useState(false);
  const [open, setOpen] = useState(false);
  const [inline, setInline] = useState(false);
  const [panelContainer] = useState(() => {const el=document.createElement('div');el.className='bucky-shared-panel bucky-conversation-host';return el;});
  const dockHost = useRef<HTMLDivElement>(null);
  const [navigationKey, setNavigationKey] = useState(() => window.location.hash);
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
  const pendingHintRef = useRef<HTMLParagraphElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
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
      setRequestReady(true);
      setLoaded(true);
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (open && !el.open) {
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;

      el.showModal();
    }
    if (!open && el.open) {
      el.close();
      if (returnFocus.current?.isConnected) returnFocus.current.focus();
      else launcher.current?.focus();
    }
  }, [open, load, loaded]);

  useEffect(() => {
    const navigate = () => setNavigationKey(window.location.hash);
    window.addEventListener('hashchange', navigate);
    return () => window.removeEventListener('hashchange', navigate);
  }, []);

  useEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    const body = document.body;
    const previous = {root: root.style.overflow, body: body.style.overflow};
    root.style.overflow = 'hidden'; body.style.overflow = 'hidden';
    const viewport = window.visualViewport;
    const update = () => {
      const el = dialog.current; if (!el) return;
      el.style.setProperty('--bucky-viewport-height', (viewport?.height ?? window.innerHeight) + 'px');
      el.style.setProperty('--bucky-viewport-width', (viewport?.width ?? window.innerWidth) + 'px');
      el.style.setProperty('--bucky-viewport-top', (viewport?.offsetTop ?? 0) + 'px');
      el.style.setProperty('--bucky-viewport-left', (viewport?.offsetLeft ?? 0) + 'px');
    };
    update(); window.addEventListener('resize', update);
    viewport?.addEventListener('resize', update); viewport?.addEventListener('scroll', update);
    return () => {
      root.style.overflow = previous.root; body.style.overflow = previous.body;
      window.removeEventListener('resize', update);
      viewport?.removeEventListener('resize', update); viewport?.removeEventListener('scroll', update);
    };
  }, [open]);

  useEffect(() => {setBuckyOpen(open);},[open]);

  useEffect(() => {setBuckyInline(inline);return () => setBuckyInline(false);},[inline]);
  useLayoutEffect(() => {
    const target=inline ? document.getElementById('home-bucky-voice-host') : dockHost.current;
    if(target && panelContainer.parentElement!==target)target.appendChild(panelContainer);
  },[inline,loaded,navigationKey,panelContainer]);
  useEffect(() => {
    if(inline && !hideLauncher){setInline(false);if(hasPendingAction)setOpen(true);}
  },[navigationKey,inline,hideLauncher,hasPendingAction]);

  // Confirmed saves anywhere (including the embedded scanner) refresh the
  // panel's data silently so answers stay current without a reopen.
  useEffect(() => onRecordsChanged(detail => {
    void load(true);
    if(detail.kind==='pos-sale-completed' && detail.recordId && detail.profileId){
      void Promise.all([salesRepo.getById(detail.recordId),profilesRepo.getById(detail.profileId)]).then(([sale,owner])=>{
        if(!sale||!owner||sale.profileId!==owner.id||owner.kind!=='business'||sale.currency!==owner.currency)return;
        recordBuckyEvent({id:'pos:'+sale.id,status:'saved',title:'POS checkout completed',detail:formatMoney(sale.totalMinor,sale.currency)+' · '+(sale.receiptNumber??sale.id),profileId:owner.id,profileName:owner.name,currency:sale.currency,recordId:sale.id});
      }).catch(()=>{});
    }
  }), [load]);

  // The protection hint lasts only while a preview is actually pending.
  useEffect(() => {
    if (!hasPendingAction && !scannerDirty) setShowPendingHint(false);
  }, [hasPendingAction, scannerDirty, load, loaded]);

  // A blocked close (Escape/backdrop/X) must be seen immediately: the hint
  // sits at the dialog top, so scroll it into view and focus it.
  useEffect(() => {
    if (!showPendingHint) return;
    const el = pendingHintRef.current;
    if (!el) return;
    el.focus({ preventScroll: true });
  }, [showPendingHint]);

  const hasUnsavedWork = hasPendingAction || (scanMode && scannerDirty);
  useEffect(() => {
    const receive = (event: Event) => {
      if (hasPendingAction || scannerDirty) { setShowPendingHint(true); if(!inline)setOpen(true); return; }
      const detail=(event as CustomEvent<BuckyConversationRequest>).detail;
      const homeVoice=detail?.mode==='voice' && hideLauncher;
      setInline(homeVoice);setOpen(!homeVoice);
      setRequestReady(false);
      void load(loaded);
      setScanMode(false); setRequest((event as CustomEvent<BuckyConversationRequest>).detail);
    };
    window.addEventListener(BUCKY_OPEN_EVENT, receive);
    return () => window.removeEventListener(BUCKY_OPEN_EVENT, receive);
  }, [hasPendingAction, scannerDirty, inline, hideLauncher, load, loaded]);

  /** Returns true when closing (and therefore navigation) is allowed. */
  function requestClose(): boolean {
    if (hasUnsavedWork) {
      setShowPendingHint(true);
      return false;
    }
    setOpen(false);setInline(false);
    return true;
  }

  /** Scan opens in place — unless an unsaved preview would be discarded. */
  function requestScan(): void {
    if (hasPendingAction) {
      setShowPendingHint(true);
      return;
    }
    setInline(false);setOpen(true);setScanMode(true);
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
      {!open && !hideLauncher && (
        <button
          ref={launcher}
          className="bucky-dock-launcher bucky-dock-launcher--mascot"
          type="button"
          onClick={() => { setRequestReady(false); void load(loaded); setOpen(true); }}
          aria-haspopup="dialog"
          aria-label="Open Bucky, your financial assistant"
        >
          <BuckyStatusMascot label="Bucky" />

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

          <div className="bucky-dock-identity">{open && !scanMode && <div className="bucky-dock-avatar"><BuckyStatusMascot /></div>}<div><h2 id="bucky-dock-heading">{scanMode ? "Scan a record" : "Bucky Financial Intelligence"}</h2>{!scanMode && presentation.label && !['idle','error','warning'].includes(presentation.phase) && <p className={'bucky-live-state bucky-live-state--'+presentation.phase} role="status">{presentation.label}</p>}</div></div>
          <div className="row-actions">
            {scanMode && (
              <button className="btn ghost" type="button" onClick={exitScanMode}>
                Back to Bucky
              </button>
            )}
            <button className="btn ghost" type="button" onClick={requestClose} aria-label="Minimize Bucky">−</button>
            <button className="btn ghost" type="button" onClick={requestClose} aria-label="Close Bucky">
              <Icon name="close" />
            </button>
          </div>
        </div>
        {showPendingHint && hasUnsavedWork && (
          <p ref={pendingHintRef} tabIndex={-1} className="alert-error bucky-dock-pending-hint" role="alert">
            {scanMode && scannerDirty
              ? "Save or discard the scan review before closing."
              : "Confirm or cancel the pending preview before closing."}
          </p>
        )}
        {scanMode && <ScannerPage embedded onDirtyChange={handleScannerDirty} onExit={() => { setScanMode(false); setOpen(false); }} />}
        {!loaded && status !== "error" && <p role="status">Loading your saved records…</p>}
        {status === "error" && <div><p className="alert-error" role="alert">Bucky couldn't load your records. Nothing was changed.</p><button className="btn" type="button" onClick={() => void load()}>Retry</button></div>}
        <div ref={dockHost} className="bucky-conversation-host" hidden={scanMode || status === "error"}/>
      </dialog>
      {createPortal(<>
        {inline && showPendingHint && hasUnsavedWork && <p role="alert" className="alert-error">Confirm or cancel the pending preview before closing.</p>}
        {inline && !loaded && status!=='error' && <p role="status">Loading your saved records…</p>}
        {inline && status==='error' && <div><p role="alert" className="alert-error">Bucky couldn't load your records. Nothing was changed.</p><button type="button" className="btn" onClick={()=>void load()}>Retry</button></div>}
        {loaded && <BuckyPanel preferredProfileId={pageProfile||undefined} profiles={profiles} buckets={buckets} transactions={transactions} products={products} sales={sales} employees={employees}
          navigationKey={navigationKey} conversationRequest={requestReady ? request : null} active={(open || inline) && !scanMode && status !== "error"} compact inlineVoice={inline}
          onRecordsChanged={() => void load(true)} onPendingActionChange={setHasPendingAction}
          onNavigateAway={requestClose} onScanRequest={requestScan}/>}
      </>,panelContainer)}
    </>
  );
}

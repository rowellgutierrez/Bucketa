import {recordBuckyEvent,setBuckyPhase,getBuckyPresentation,subscribeBuckyPresentation,ACTION_STATUS_LABELS,type BuckyPhase} from "../lib/buckyPresentation";
import {getBuckyDraft,setBuckyDraft,subscribeBuckyDraft,scopedBuckyHistory,createBuckySubmissionGate} from "../lib/buckyConversation";
import type { BuckyConversationRequest } from "../lib/buckyConversation";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Bucket, Employee, Product, Profile, Sale, Transaction } from "../data/types.ts";
import { bucketsRepo, incrementProductStock, createTransactionConfirmed, employeesRepo, productsRepo } from "../data/db.ts";
import { findSkuConflict, newId, nowIso, validateBucket, validateEmployee, validateProduct, validateTransaction } from "../data/validation.ts";
import { formatMoney } from "../lib/currency.ts";
import { notifyRecordsChanged } from "../lib/dataChange.ts";
import { bucketGoalProgress } from "../lib/finance.ts";
import {
  buckyActionTitle,
  buildActionFromModelProposal,
  buildBuckyProduct,
  buildBuckyTransaction,
  interpretBuckyAction,
  interpretBuckyProductCommand,
  isFinancialAnalysisQuestion,
  type ProposedBuckyAction,
  type ProposedBuckyProduct,
} from "../lib/buckyActions.ts";
import {
  analyzeBuckyFinances,
  answerBuckyQuestion,
  buildBuckyModelSummary,
  isRecordQuestion,
  buildBuckyConversationSummary,
  answerBuckyConversation,
  type BuckyAnswer,
  type BuckyProposal,
} from "../lib/buckyAgent.ts";
import {
  BuckyApiError,
  requestBuckyAdvice,
  requestBuckyInterpret,
} from "../lib/buckyApi.ts";
import {
  appActionTitle,
  buildBucketRecord,
  buildEmployeeRecord,
  interpretAppAction,
  resolveBuckyRecordProfile,
  isGeneralBuckyConversation,
  queuePosCartHandoff,
  POS_CART_HANDOFF_KEY,
  type AppActionProposal,
} from "../lib/buckyAppActions.ts";
import {
  appendFinalTranscript,
  canRestartRecognition,
  detectUnsupportedAction,
  isEchoOfSpeech,
  getSpeechRecognitionCtor,
  isSpeechRecognitionSupported,
  isSpeechSynthesisSupported,
  prepareSpeechText,
  buckyUtteranceTuning,
  pickPreferredVoice,
  shouldAutoProcessTranscript,
  SILENCE_TIMEOUT_MS,
  hasSilenceElapsed,
  queueAfterSpeech,
  createContinuousVoiceSession,
  speechRecognitionErrorMessage,
  transcriptsFromEvent,
  UNSUPPORTED_ACTION_ANSWER,
  voiceTransition,
  type BuckyVoicePhase,
  type SpeechRecognitionLike,
} from "../lib/buckyVoice.ts";
import {
  buckyAdviceMode,
  createAdviceSubmissionGuard,
  getLiveAvailability,
  refreshLiveAvailability,
  subscribeLiveAvailability,
} from "../lib/buckyLiveSettings.ts";
import {
  loadVoiceSettings,
  onVoiceSettingsChanged,
  saveVoiceSettings,
  type VoiceSettings,
} from "../lib/buckyVoiceSettings.ts";
import BuckyMascot from "./BuckyMascot";
import Icon from "./ui/Icon";

interface Props {
  navigationKey?: string;
  conversationRequest?: BuckyConversationRequest | null;
  active?: boolean;
  compact?: boolean;
  inlineVoice?: boolean;
  profiles: Profile[];
  buckets: Bucket[];
  transactions: Transaction[];
  products: Product[];
  sales: Sale[];
  /** Employee records used only to resolve salary-payment names. */
  employees?: Employee[];
  /** Profile the surrounding dashboard view is focused on, when known. */
  preferredProfileId?: string;
  /** Called after a confirmed Bucky save so hosts can refresh their data. */
  onRecordsChanged?: () => void;
  /** Lets hosts protect an unsaved preview (e.g. block dialog dismissal). */
  onPendingActionChange?: (pending: boolean) => void;
  /**
   * Called before in-panel navigation (e.g. to Settings). Return false to
   * veto navigation — hosts do this while an unsaved preview is pending,
   * so the preview is never silently abandoned.
   */
  onNavigateAway?: () => boolean;
  /**
   * Hosts that can scan in place (the floating Bucky dialog) supply this
   * so Scan opens the embedded scanner instead of navigating to the
   * standalone scanner page. Without it, Scan keeps navigating.
   */
  onScanRequest?: () => void;
}

function todayLocal(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Heuristic: text that reads like a record the user tried to create. */
function looksLikeActionAttempt(text: string): boolean {
  return /\d/.test(text) &&
    /\b(record|add|log|pay|paid|deposit|contribute|spent|bought|received|earned|salary|bonus|advance|save|put)\b/i.test(text);
}

/** Navigation is the only thing a Bucky proposal can ever do. */
function goToProposal(proposal: BuckyProposal) {
  if (proposal.action.type === "scan") {
    window.location.hash = "/scanner";
    return;
  }
  window.location.hash = `/${proposal.action.route.replace(/^\//, "")}`;
}

function goToRoute(route: string) {
  window.location.hash = `/${route.replace(/^\//, "")}`;
}

/**
 * Bucky Agent panel: deterministic financial intelligence calculated in
 * code from the selected profile's saved records. The optional advisor is
 * the only model path and it only explains aggregated totals; it never
 * proposes or executes writes. Bookkeeping actions are interpreted
 * deterministically (buckyActions), shown as a structured preview, and
 * saved only after explicit user confirmation through the app's
 * commit-confirmed data function.
 */
export default function BuckyPanel({ profiles, buckets, transactions, products, sales, employees = [], preferredProfileId, onRecordsChanged, onPendingActionChange, onNavigateAway, onScanRequest, conversationRequest, active = true, compact = false, inlineVoice = false, navigationKey }: Props) {
  const activeRef=useRef(active);activeRef.current=active;
  const presentation = useSyncExternalStore(subscribeBuckyPresentation,getBuckyPresentation,getBuckyPresentation);
  const [interactionPhase,setInteractionPhase] = useState<BuckyPhase>("idle");
  const [speechPending,setSpeechPending] = useState(false);
  const [micPending,setMicPending] = useState(false);
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const question = useSyncExternalStore(subscribeBuckyDraft,getBuckyDraft,getBuckyDraft);
  const setQuestion = setBuckyDraft;
  const [, setLastQuestion] = useState("");
  const [answer, setAnswer] = useState<BuckyAnswer | null>(null);
  // Single conversation thread: user + Bucky messages in order. Action
  // previews stay as live cards below the thread (Confirm/Cancel intact).
  const [thread, setThread] = useState<{ id: number; role: "user" | "bucky"; text: string; profileId?: string; profileName?: string; facts: { label: string; value: string }[]; proposalIds: string[] }[]>([]);
  const msgIdRef = useRef(0);
  const messageOwnerRef=useRef<Profile|null>(null);
  const submissionGate=useRef(createBuckySubmissionGate()).current;
  const [voiceHistoryExpanded,setVoiceHistoryExpanded]=useState(false);
  const [voiceSessionStart,setVoiceSessionStart]=useState(0);
  const voiceMessages=inlineVoice?thread.filter(msg=>msg.id>voiceSessionStart):thread;
  const conversationScroll = useRef<HTMLDivElement>(null);
  const followLatest=useRef(true);
  function pushMsg(role: "user" | "bucky", text: string, facts: { label: string; value: string }[] = [], proposalIds: string[] = []) {
    const id = ++msgIdRef.current;
    setThread((prev) => [...prev.slice(-39), { id, role, text, facts, proposalIds, profileId: messageOwnerRef.current?.id, profileName: messageOwnerRef.current?.name }]);
  }
  // Every new Bucky answer joins the thread exactly once (object identity
  // guards StrictMode double-effects and re-renders).
  const lastAnswerRef = useRef<BuckyAnswer | null>(null);
  useEffect(() => {
    if (answer && answer !== lastAnswerRef.current) {
      lastAnswerRef.current = answer;
      pushMsg("bucky", answer.answer, answer.facts, answer.proposalIds);
    }
  }, [answer]);
  // Live Meta AI availability is discovered from the backend health
  // check. When configured on the server, Bucky uses the real Meta
  // model by default; no user token is ever requested here.
  const liveAvailability = useSyncExternalStore(subscribeLiveAvailability, getLiveAvailability, getLiveAvailability);
  useEffect(() => { void refreshLiveAvailability(); }, []);
  const adviceGuardRef = useRef(createAdviceSubmissionGuard());
  // Voice (Phase 1): browser speech only. Never auto-starts; speech only
  // follows a voice question or an explicit Listen tap.
  const [voicePhase, setVoicePhase] = useState<BuckyVoicePhase>("idle");
  const [voiceError, setVoiceError] = useState("");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [voiceSettings, setVoiceSettings] = useState<VoiceSettings>(() => loadVoiceSettings());
  const voiceSettingsRef = useRef(voiceSettings);
  const voiceResponsesOn = voiceSettings.responsesOn;

  // Voice preferences are managed in Settings; pick up changes live
  // (same-tab event and cross-tab storage event) with no page reload.
  useEffect(
    () =>
      onVoiceSettingsChanged((next) => {
        voiceSettingsRef.current = next;
        setVoiceSettings(next);
      }),
    [],
  );
  // Phase D: a request the built-in interpreter couldn't turn into a
  // record may be offered for explicit, gated AI interpretation.
  const [aiInterpretText, setAiInterpretText] = useState("");
  const [interpretBusy, setInterpretBusy] = useState(false);
  const [interpretNote, setInterpretNote] = useState("");
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const recognitionCancelledRef = useRef(false);
  // Continuous-recognition bookkeeping (Phase B3): an intentional Done
  // tap (stopRequested) settles the transcript for automatic sending; an
  // unexpected end may restart a bounded number of times; an error or
  // Cancel never restarts and never auto-executes a partial transcript.
  const recognitionStopRequestedRef = useRef(false);
  const recognitionErrorRef = useRef("");
  const recognitionRestartsRef = useRef(0);
  const [pendingTranscript, setPendingTranscript] = useState("");
  const finalTranscriptRef = useRef("");
  // Trailing-silence auto-finish: every recognition result (interim or
  // final) stamps lastResultAtRef and (re)arms the timer; ~3s without a
  // result stops listening and settles the transcript. Done stays available.
  const silenceTimerRef = useRef<number | null>(null);
  const lastResultAtRef = useRef(0);
  // One-shot mascot reaction clip (existing GLB clips only), shown for a
  // couple of seconds after a confirmed save / a failed save, then the
  // animation prop clears and Bucky returns to Idle.

  const utteranceIdRef = useRef(0);
  const continuousVoice=useRef(createContinuousVoiceSession((callback,delay)=>window.setTimeout(callback,delay),id=>window.clearTimeout(id))).current;
  const canResumeVoiceRef=useRef<()=>boolean>(()=>false);
  const voiceResponsesOnRef = useRef(true);
  voiceResponsesOnRef.current = voiceResponsesOn;
  // Bookkeeping actions: one pending preview at a time. A proposal is
  // never saved without an explicit Confirm tap, by voice or by text.
  const [pendingAction, setPendingAction] = useState<ProposedBuckyAction | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  // Add Product: a separate proposal kind (a product is not a
  // transaction). Same rule — structured preview, explicit confirmation,
  // then creation through validateProduct + productsRepo.create.
  const [pendingProduct, setPendingProduct] = useState<ProposedBuckyProduct | null>(null);
  const [productBusy, setProductBusy] = useState(false);
  const [productError, setProductError] = useState("");
  // App-wide actions (employee/stock/bucket/POS cart): same rule — preview,
  // explicit confirmation, then execution via validated repositories.
  const [pendingAppAction, setPendingAppAction] = useState<AppActionProposal | null>(null);
  const [appBusy, setAppBusy] = useState(false);
  const [appError, setAppError] = useState("");
  const executedAppIdsRef = useRef<Set<string>>(new Set());
  const [serverBusy, setServerBusy] = useState(false);
  const [serverNote, setServerNote] = useState("");
  // Last text Bucky spoke, used to reject its own voice as a new turn.
  const lastSpokenRef = useRef("");
  const [locallyCreatedProducts, setLocallyCreatedProducts] = useState<Product[]>([]);
  const executedProductIdsRef = useRef<Set<string>>(new Set());
  const [savedResult, setSavedResult] = useState<{ message: string; facts: { label: string; value: string }[] } | null>(null);
  const lastSavedRef = useRef<typeof savedResult>(null);
  useEffect(() => {
    if (savedResult && savedResult !== lastSavedRef.current) {
      lastSavedRef.current = savedResult;
      pushMsg("bucky", `Saved. ${savedResult.message}`, savedResult.facts);
    }
  }, [savedResult]);
  const [locallySaved, setLocallySaved] = useState<Transaction[]>([]);
  const hasPendingPreview = Boolean(pendingAction || pendingProduct || pendingAppAction);
  const pendingViaVoiceRef = useRef(false);
  const executedActionIdsRef = useRef<Set<string>>(new Set());
  const recognitionSupported = useMemo(
    () => typeof window !== "undefined" && isSpeechRecognitionSupported(window),
    [],
  );
  const ttsSupported = useMemo(
    () => typeof window !== "undefined" && isSpeechSynthesisSupported(window),
    [],
  );

  const appliedPageProfile=useRef('');
  // Page context is applied once per selection change; pending previews remain pinned.
  useEffect(() => {
    if (appliedPageProfile.current!==preferredProfileId && !hasPendingPreview && !actionBusy && !productBusy && !appBusy && !interpretBusy && !serverBusy && preferredProfileId && profiles.some((p) => p.id === preferredProfileId)) {
      setInteractionPhase("idle");
      appliedPageProfile.current=preferredProfileId;
      setSelectedProfileId(preferredProfileId);
    }
  }, [preferredProfileId, profiles, hasPendingPreview, actionBusy, productBusy, appBusy, interpretBusy, serverBusy]);

  const profile =
    profiles.find((p) => p.id === selectedProfileId) ??
    profiles.find((p) => p.kind === "personal") ??
    profiles[0];

  useEffect(() => {
    if(!active)return;
    const phase:BuckyPhase=voicePhase==='listening'?'listening':voicePhase==='speaking'?'speaking':actionBusy||productBusy||appBusy||interpretBusy||voicePhase==='processing'||speechPending||micPending||serverBusy?'processing':interactionPhase==='error'?'error':hasPendingPreview?'review':interactionPhase;
    const labels:Record<BuckyPhase,string>={idle:'',listening:'Listening',speaking:'Speaking',processing:micPending?'Starting microphone':speechPending?'Preparing spoken response':'Working',review:'Awaiting confirmation',success:'Saved',error:'',cancelled:'Cancelled',warning:''};
    setBuckyPhase(phase,labels[phase],profile?.id);
  },[active,voicePhase,actionBusy,productBusy,appBusy,interpretBusy,speechPending,micPending,hasPendingPreview,interactionPhase,serverBusy,profile?.id]);

  useEffect(() => {
    const action=pendingAction??pendingProduct??pendingAppAction;if(!action)return;
    recordBuckyEvent({id:action.id,status:'awaiting',title:pendingAction?buckyActionTitle(pendingAction):pendingAppAction?appActionTitle(pendingAppAction):'Add product',detail:pendingAction?.description??(pendingAppAction?appActionTitle(pendingAppAction):pendingProduct?.name??''),profileId:action.profileId,profileName:action.profileName,currency:action.currency});
  },[pendingAction,pendingProduct,pendingAppAction]);

  // Records saved through Bucky in this session, merged over the host's
  // snapshot so updated calculations are visible immediately. Hosts also
  // refresh their own data via onRecordsChanged; IDs dedupe the overlap.
  const effectiveTransactions = useMemo(() => {
    const hostIds = new Set(transactions.map((t) => t.id));
    return [...locallySaved.filter((t) => !hostIds.has(t.id)), ...transactions];
  }, [transactions, locallySaved]);

  // Products created through Bucky this session, merged over the host's
  // snapshot so duplicate warnings see them immediately.
  const effectiveProducts = useMemo(() => {
    const hostIds = new Set(products.map((p) => p.id));
    return [...locallyCreatedProducts.filter((p) => !hostIds.has(p.id)), ...products];
  }, [products, locallyCreatedProducts]);

  const result = useMemo(() => {
    if (!profile) return null;
    try {
      return {
        analysis: analyzeBuckyFinances({ profile, buckets, transactions: effectiveTransactions, products, sales, employees }),
        error: "",
      };
    } catch {
      return { analysis: null, error: "Bucky could not analyse these records. Your records themselves were not changed." };
    }
  }, [profile, buckets, effectiveTransactions, products, sales, employees]);

  const analysis = result?.analysis ?? null;

  function updateVoiceSettings(patch: Partial<VoiceSettings>) {
    setVoiceSettings((prev) => {
      const next = { ...prev, ...patch };
      voiceSettingsRef.current = next;
      saveVoiceSettings(next);
      return next;
    });
  }

  // Bucky's one stable voice: resolved once, refreshed on voiceschanged
  // (browser voice lists load asynchronously). Built-in voices only.
  const buckyVoiceRef = useRef<SpeechSynthesisVoice | null>(null);
  useEffect(() => {
    if (!ttsSupported) return;
    const update = () => {
      try {
        const voices = window.speechSynthesis.getVoices();
        const preferred = pickPreferredVoice(voices);
        buckyVoiceRef.current = preferred
          ? (voices.find((v) => v.name === preferred.name && v.lang === preferred.lang) ?? null)
          : null;
      } catch { /* best-effort; fallback is the browser default voice */ }
    };
    update();
    window.speechSynthesis.addEventListener?.("voiceschanged", update);
    return () => window.speechSynthesis.removeEventListener?.("voiceschanged", update);
  }, [ttsSupported]);

  const listenAfterGreetingRef=useRef<()=>void>(()=>{});
  listenAfterGreetingRef.current=()=>startListening();
  canResumeVoiceRef.current=()=>active&&inlineVoice&&!hasPendingPreview&&!actionBusy&&!productBusy&&!appBusy&&!interpretBusy&&!speechPending&&!micPending&&!recognitionRef.current&&voicePhase!=='review'&&!window.speechSynthesis?.speaking;
  function resumeVoice(){continuousVoice.resume(()=>canResumeVoiceRef.current(),()=>listenAfterGreetingRef.current());}
  function speakText(text: string, afterEnd?:()=>void) {
    // No speech available: never strand an active voice conversation —
    // re-arm listening instead of silently ending the turn cycle.
    if (!ttsSupported || !text.trim()) { resumeVoice(); return; }
    // Echo prevention: never listen while Bucky speaks. Stop any live
    // recognition first so Bucky's own voice can't become a new turn.
    if (recognitionRef.current) { try { recognitionRef.current.abort(); } catch { /* already ended */ } recognitionRef.current = null; }
    lastSpokenRef.current = text;
    // Never overlap: a new utterance always replaces any current speech.
    const id = ++utteranceIdRef.current;
    window.speechSynthesis.cancel();
    setVoicePhase(p=>p==="speaking"?voiceTransition(p,"stop"):p);
    setSpeechPending(true);
    const utterance = new SpeechSynthesisUtterance(text);
    let started=false;
    utterance.lang = "en-US";
    if (buckyVoiceRef.current) utterance.voice = buckyVoiceRef.current;
    const settings = voiceSettingsRef.current;
    const tuning = buckyUtteranceTuning(settings);
    utterance.volume = settings.volume;
    utterance.rate = tuning.rate;
    utterance.pitch = tuning.pitch;
    utterance.onstart = () => {
      if (utteranceIdRef.current !== id) return;
      if(!started && afterEnd){started=true;pushMsg("bucky",text);}
      setSpeechPending(false);
      setVoicePhase((p) => voiceTransition(p, "speak"));
    };
    utterance.onend = () => {
      if (utteranceIdRef.current === id) setSpeechPending(false);
      if (utteranceIdRef.current === id) {setVoicePhase((p) => voiceTransition(p, "end"));if(afterEnd)queueAfterSpeech(()=>utteranceIdRef.current===id,afterEnd,(callback,delay)=>window.setTimeout(callback,delay));else resumeVoice();}
    };
    const playbackFailed=()=>{
      if(utteranceIdRef.current!==id)return;
      continuousVoice.stop();utteranceIdRef.current++;setSpeechPending(false);setInteractionPhase('error');setVoicePhase('error');
      setVoiceError(afterEnd?'The spoken greeting failed. No microphone was started. Try again or type your question.':'Spoken playback was unavailable. Your answer is still on screen.');
    };
    utterance.onerror=playbackFailed;
    try {window.speechSynthesis.speak(utterance);} catch {playbackFailed();}
  }

  function stopSpeaking() {
    setSpeechPending(false);
    utteranceIdRef.current += 1;
    if (ttsSupported) window.speechSynthesis.cancel();
    setVoicePhase((p) => (p === "speaking" ? voiceTransition(p, "stop") : p));
  }

  // Hosts (e.g. the app-wide dock) protect unsaved previews from dismissal.
  useEffect(() => {
    onPendingActionChange?.(hasPendingPreview);
  }, [hasPendingPreview, onPendingActionChange]);

  async function ask(text: string, viaVoice = false, handoff = false) {
    const q = text.trim();
    if (!q) return;
    if (adviceGuardRef.current.isPending()) {
      setActionError("Bucky is still answering — wait for that answer before sending another request.");
      return;
    }
    if(micPending){setVoiceError("Cancel microphone startup before sending a typed request.");return;}
    if (hasPendingPreview || actionBusy || productBusy || appBusy || interpretBusy) {
      setActionError("Confirm or cancel the current preview before sending another request.");
      return;
    }
    // Echo guard: Bucky's own spoken words never become a new request.
    if (viaVoice && isEchoOfSpeech(q, lastSpokenRef.current)) { resumeVoice(); return; }
    const accepted=submissionGate.accept(q,!viaVoice&&!handoff);if(!accepted)return;
    try {
    setInteractionPhase("idle");
    setActionError("");setProductError("");setServerNote("");
    setLastQuestion(q);

    setAiInterpretText("");
    setInterpretNote("");
    // Read-only financial analysis questions skip every write interpreter
    // and go straight to Q&A below (deterministic, or live Meta AI when
    // enabled). Explicit creation commands are never classified this way.
    const analysisQuestion = isFinancialAnalysisQuestion(q);
    const acrossBusinesses=/\b(?:compare|across|all|both)\b[^.!?]*\bbusinesses\b/i.test(q);
    const recordQuestion=(acrossBusinesses||detectUnsupportedAction(q)||isRecordQuestion(q)||/^(?:(?:hi|hey)\s+)?(?:bucky[,!\s]+)?(?:please\s+)?(?:add|create|record|log|pay|deposit|contribute|restock|increase)\b/i.test(q))&&!isGeneralBuckyConversation(q);

    if(!recordQuestion){
      const voiceRequestEpoch=utteranceIdRef.current;
      messageOwnerRef.current=null;pushMsg('user',q);const fallback=answerBuckyConversation();
      if(buckyAdviceMode(liveAvailability)==='live'){
        if(!adviceGuardRef.current.tryStart())return;setServerBusy(true);setServerNote('');
        try{const response=await requestBuckyAdvice(q,buildBuckyConversationSummary(),{mode:'live',history:scopedBuckyHistory(thread,'')});setAnswer({answer:response.answer,facts:[],proposalIds:[],insufficientData:false});setServerNote(response.source==='meta-live'?'':'Live Meta AI was unavailable. This is a deterministic help response; no live answer was used.');if(viaVoice&&voiceResponsesOnRef.current&&activeRef.current&&utteranceIdRef.current===voiceRequestEpoch)speakText(prepareSpeechText(response.answer));else if(viaVoice){setVoicePhase(p=>voiceTransition(p,'reset'));resumeVoice();}}
        catch(error){setAnswer(fallback);setServerNote('Live Meta AI was unavailable. This is a deterministic help response; no live answer was used.');if(viaVoice&&voiceResponsesOnRef.current&&activeRef.current&&utteranceIdRef.current===voiceRequestEpoch)speakText(prepareSpeechText(fallback.answer));else if(viaVoice){setVoicePhase(p=>voiceTransition(p,'reset'));resumeVoice();}}
        finally{adviceGuardRef.current.finish();setServerBusy(false);}
      }else{setAnswer(fallback);setServerNote('Deterministic help response. Live Meta AI is not configured on the server; no paid request was made.');if(viaVoice&&voiceResponsesOnRef.current&&activeRef.current&&utteranceIdRef.current===voiceRequestEpoch)speakText(prepareSpeechText(fallback.answer));else if(viaVoice){setVoicePhase(p=>voiceTransition(p,'reset'));resumeVoice();}}
      return;
    }
    // App-wide routing: an explicitly named profile is used for THIS
    // request only. The target profile is resolved before any preview, and
    // ambiguous or unknown names clarify instead of guessing.
    if(acrossBusinesses){messageOwnerRef.current=null;pushMsg('user',q);const note={answer:'I can provide accurate financial answers for one profile at a time. Cross-business comparisons are not supported yet; name a business and I can report its recorded figures separately.',facts:[],proposalIds:[],insufficientData:true};setAnswer(note);if(viaVoice&&voiceResponsesOnRef.current)speakText(prepareSpeechText(note.answer));else if(viaVoice){setVoicePhase(p=>voiceTransition(p,'reset'));resumeVoice();}return;}
    const named = resolveBuckyRecordProfile(q, profiles,{pageProfileId:preferredProfileId??conversationRequest?.profileId,products:effectiveProducts,employees,buckets});
    if (named.status === "ambiguous" || named.status === "named-missing") {
      messageOwnerRef.current=null;pushMsg("user",q);
      const businesses = profiles.filter((p) => p.kind === "business").map((p) => p.name).join(", ");
      const note: BuckyAnswer = { answer: named.status === "ambiguous" ? `More than one profile matches that name (${named.profiles.map((p) => p.name).join(", ")}). Please use the full, exact profile name — nothing was changed.` : `I couldn't find a business named "${named.name}".${businesses ? ` Your businesses: ${businesses}.` : ""} Nothing was changed.`, facts: [], proposalIds: [], insufficientData: true };
      setAnswer(note);
      if (viaVoice && voiceResponsesOnRef.current) speakText(prepareSpeechText(note.answer));
      else if (viaVoice) { setVoicePhase((p) => voiceTransition(p, "reset")); resumeVoice(); }
      return;
    }
    if(named.status==='none'){
      messageOwnerRef.current=null;pushMsg('user',q);const note={answer:profiles.length?'Which business or personal profile should I use? Please name it so I can give an accurate answer or prepare the right preview.':'Create a business or personal profile before requesting recorded financial information or changes.',facts:[],proposalIds:[],insufficientData:true};setAnswer(note);if(viaVoice&&voiceResponsesOnRef.current)speakText(prepareSpeechText(note.answer));else if(viaVoice){setVoicePhase(p=>voiceTransition(p,'reset'));resumeVoice();}return;
    }
    const routedProfile = named.profile;
    setSelectedProfileId(routedProfile.id);
    messageOwnerRef.current=routedProfile;pushMsg("user",q);
    let routedAnalysis = analysis;
    if (!routedAnalysis || routedProfile.id !== profile?.id) {
      try { routedAnalysis = analyzeBuckyFinances({ profile: routedProfile, buckets, transactions: effectiveTransactions, products: effectiveProducts, sales, employees }); }
      catch { setAnswer({ answer: `I couldn't read records for "${routedProfile.name}". Nothing was changed.`, facts: [], proposalIds: [], insufficientData: true }); return; }
    }

    // Add Product first when the command explicitly asks for it: one
    // deterministic business operation with its own preview. It must run
    // before the transaction interpreter, which would otherwise ask
    // "income or expense?" about the price.
    const productInterpretation = analysisQuestion ? { status: "not-action" as const } : interpretBuckyProductCommand(q, {
      profile: routedProfile,
      products: effectiveProducts,
      createId: () => `bucky:${newId()}`,
    });
    if (productInterpretation.status === "proposal") {
      pendingViaVoiceRef.current = viaVoice;
      setPendingProduct(productInterpretation.product);
      setPendingAction(null);
      setSavedResult(null);
      setProductError("");
      setActionError("");
      setAnswer({
        answer: "Here's the product I understood. Review the preview below — nothing is created until you tap Confirm.",
        facts: [],
        proposalIds: [],
        insufficientData: false,
      });
      if (viaVoice && voiceResponsesOnRef.current) {
        speakText("I've prepared a product preview. Please check the details on screen, then tap Confirm. Nothing is created yet.");
      } else if (viaVoice) {
        setVoicePhase((p) => voiceTransition(p, "reset"));
      }
      return;
    }
    if (productInterpretation.status === "clarification") {
      setPendingProduct(null);
      setAnswer({
        answer: productInterpretation.question,
        facts: [],
        proposalIds: [],
        insufficientData: true,
      });
      if (viaVoice && voiceResponsesOnRef.current) speakText(prepareSpeechText(productInterpretation.question));
      else if (viaVoice) {setVoicePhase((p) => voiceTransition(p, "reset"));resumeVoice();}
      return;
    }

    // App-wide actions (employee / stock / bucket / POS cart): preview
    // first, execution only after Confirm via validated repositories.
    const appInterpretation = analysisQuestion ? { status: "not-action" as const } : interpretAppAction(q, {
      profile: routedProfile, products: effectiveProducts, employees, buckets,
      today: todayLocal(), createId: () => `bucky:${newId()}`,
    });
    if (appInterpretation.status === "proposal") {
      pendingViaVoiceRef.current = viaVoice;
      setPendingAppAction(appInterpretation.action);
      setPendingAction(null); setPendingProduct(null);
      setSavedResult(null); setAppError("");
      setAnswer({ answer: "Here's what I understood. Review the preview below — nothing changes until you tap Confirm.", facts: [], proposalIds: [], insufficientData: false });
      if (viaVoice && voiceResponsesOnRef.current) speakText("I've prepared a preview. Please check the details on screen, then tap Confirm. Nothing has changed yet.");
      else if (viaVoice) setVoicePhase((p) => voiceTransition(p, "reset"));
      return;
    }
    if (appInterpretation.status === "clarification") {
      setAnswer({ answer: appInterpretation.question, facts: [], proposalIds: [], insufficientData: true });
      if (viaVoice && voiceResponsesOnRef.current) speakText(prepareSpeechText(appInterpretation.question));
      else if (viaVoice) { setVoicePhase((p) => voiceTransition(p, "reset")); resumeVoice(); }
      return;
    }

    // Bookkeeping actions first: one deterministic pipeline shared by
    // typed and spoken requests. A proposal is only a preview — saving
    // always needs the explicit Confirm button below.
    const interpretation = analysisQuestion ? { status: "not-action" as const } : interpretBuckyAction(q, {
      profile: routedProfile,
      buckets,
      employees,
      transactions: effectiveTransactions,
      today: todayLocal(),
      createId: () => `bucky:${newId()}`,
    });
    if (interpretation.status === "proposal") {
      pendingViaVoiceRef.current = viaVoice;
      setPendingAction(interpretation.action);
      setPendingProduct(null);
      setSavedResult(null);
      setActionError("");
      const previewNote: BuckyAnswer = {
        answer: "Here's what I understood. Review the preview below — nothing is saved until you tap Confirm save.",
        facts: [],
        proposalIds: [],
        insufficientData: false,
      };
      setAnswer(previewNote);
      if (viaVoice && voiceResponsesOnRef.current) {
        speakText("I've prepared a preview. Please check the details on screen, then tap Confirm save. Nothing is saved yet.");
      } else if (viaVoice) {
        setVoicePhase((p) => voiceTransition(p, "reset"));
      }
      return;
    }
    if (interpretation.status === "clarification") {
      setPendingAction(null);
      const clarification: BuckyAnswer = {
        answer: interpretation.question,
        facts: [],
        proposalIds: [],
        insufficientData: true,
      };
      setAnswer(clarification);
      if (viaVoice && voiceResponsesOnRef.current) speakText(prepareSpeechText(clarification.answer));
      else if (viaVoice) setVoicePhase((p) => voiceTransition(p, "reset"));
      return;
    }
    if (!analysisQuestion && (interpretation.status === "unsupported" || detectUnsupportedAction(q))) {
      // Honest decline for writes Bucky cannot do (deletes, edits,
      // withdrawals, transfers, creating goals/employees, …).
      const unsupported: BuckyAnswer = {
        answer: UNSUPPORTED_ACTION_ANSWER,
        facts: [],
        proposalIds: [],
        insufficientData: false,
      };
      setAnswer(unsupported);
      setInteractionPhase("error");
      recordBuckyEvent({id:"request:"+profile.id+":"+msgIdRef.current,status:"unsupported",title:"Unsupported request",detail:unsupported.answer,profileId:profile.id,profileName:profile.name});
      if (viaVoice && voiceResponsesOnRef.current) speakText(prepareSpeechText(unsupported.answer));
      else {setVoicePhase((p) => voiceTransition(p, "reset"));if(viaVoice)resumeVoice();}
      return;
    }
    const next = answerBuckyQuestion(q, routedAnalysis);
    // Financial Q&A: when live Meta AI is configured on the server, ask
    // the real model by default with the grounded aggregated summary.
    // A labelled deterministic fallback is used only when live is not
    // configured or the live response fails validation — never
    // presented as a successful Meta AI response.
    let displayAnswer: BuckyAnswer = next;
    if (buckyAdviceMode(liveAvailability) === "live" && adviceGuardRef.current.tryStart()) {
      setServerBusy(true);
      try {
        const response = await requestBuckyAdvice(q, buildBuckyModelSummary(routedAnalysis, q), { mode: "live", history: scopedBuckyHistory(thread, "") });
        if (response.source === "meta-live") {
          // Genuine live answer: no status/provenance line is shown.
          displayAnswer = { answer: response.answer, facts: response.evidence, proposalIds: [], insufficientData: false };
        } else {
          setServerNote("Live Meta AI was unavailable, so Bucky used a deterministic fallback calculated from your records. No model answer was trusted.");
        }
      } catch {
        setServerNote("Live Meta AI was unavailable, so Bucky used a deterministic fallback calculated from your records. No model answer was trusted.");
      } finally {
        adviceGuardRef.current.finish();
        setServerBusy(false);
      }
    } else if (buckyAdviceMode(liveAvailability) !== "live") {
      setServerNote(recordQuestion
        ? "Exact financial answer calculated from the target profile's records. Unsupported date ranges are not inferred; no live request was made."
        : "Answered deterministically from your recorded data. Live Meta AI is not configured on the server, so no paid request was made.");
    }
    setAnswer(displayAnswer);
    if(next.insufficientData){setInteractionPhase("error");recordBuckyEvent({id:"question:"+profile.id+":"+msgIdRef.current,status:"unsupported",title:q.length>70?q.slice(0,67)+"…":q,detail:"No changes were made. See Bucky’s response above.",profileId:profile.id,profileName:profile.name});}
    // The built-in interpreter couldn't make a record of this, but it
    // reads like one: offer explicit AI interpretation (Phase D). The
    // deterministic answer above stands either way.
    if (looksLikeActionAttempt(q)) setAiInterpretText(q);
    if (viaVoice && voiceResponsesOnRef.current) {
      speakText(prepareSpeechText(displayAnswer.answer, displayAnswer.facts));
    } else if (viaVoice) {
      setVoicePhase((p) => voiceTransition(p, "reset"));resumeVoice();
    }
    } finally {accepted.finish();}
  }

  function cancelPendingAction() {
    if(pendingAction) recordBuckyEvent({id:pendingAction.id,status:"cancelled",title:buckyActionTitle(pendingAction),detail:pendingAction.description+" · "+formatMoney(pendingAction.amountMinor,pendingAction.currency)+" · Nothing was saved.",profileId:pendingAction.profileId,profileName:pendingAction.profileName,currency:pendingAction.currency});
    setInteractionPhase("cancelled");
    setPendingAction(null);
    setActionError("");
    setAnswer({
      answer: "Cancelled — nothing was saved.",
      facts: [],
      proposalIds: [],
      insufficientData: false,
    });
  }

  /**
   * Phase D: explicitly user-triggered AI interpretation of a request the
   * built-in interpreter couldn't parse. Costs one gated live request.
   * The model's structured proposal is cross-checked locally against the
   * user's own words and real records; only a fully checked proposal
   * becomes the standard preview. Nothing is auto-confirmed, ever.
   */
  async function tryAiInterpret() {
    const targetProfile=messageOwnerRef.current??profile;
    if (!aiInterpretText || !targetProfile || interpretBusy) return;
    setInterpretBusy(true);
    setInterpretNote("");
    try {
      const res = await requestBuckyInterpret(
        aiInterpretText,
        {
          profileName: targetProfile.name,
          profileKind: targetProfile.kind,
          currency: targetProfile.currency,
          bucketNames: buckets
            .filter((b) => b.profileId === targetProfile.id && b.kind === "savings")
            .map((b) => b.name),
          employeeNames: employees
            .filter((e) => e.profileId === targetProfile.id)
            .map((e) => e.name),
        },

      );
      if (!res.proposal) {
        setInterpretNote("The AI couldn't turn that into a record either. Try rewording it or use the normal record form. Nothing was saved.");
        return;
      }
      const checked = buildActionFromModelProposal(aiInterpretText, res.proposal, {
        profile:targetProfile,
        buckets,
        employees,
        transactions: effectiveTransactions,
        today: todayLocal(),
        createId: () => `bucky:${newId()}`,
      });
      if (checked.status === "proposal") {
        pendingViaVoiceRef.current = false;
        setPendingAction(checked.action);
        setSavedResult(null);
        setActionError("");
        setAiInterpretText("");
        setAnswer({
          answer: "The AI suggested this interpretation, and Bucky checked it against your words and your records. Review the preview below — nothing is saved until you tap Confirm save.",
          facts: [],
          proposalIds: [],
          insufficientData: false,
        });
      } else if (checked.status === "clarification") {
        setAiInterpretText("");
        setAnswer({
          answer: checked.question,
          facts: [],
          proposalIds: [],
          insufficientData: true,
        });
      } else {
        setInterpretNote("That request isn't something Bucky can record. Nothing was saved.");
      }
    } catch (error) {
      setInterpretNote(
        error instanceof BuckyApiError
          ? error.message
          : "AI interpretation couldn't be completed. The built-in interpreter still works — nothing was saved.",
      );
    } finally {
      setInterpretBusy(false);
    }
  }

  async function confirmPendingAction() {
    if (!pendingAction || actionBusy || !profile) return;
    if (executedActionIdsRef.current.has(pendingAction.id)) {
      setActionError("This action was already saved. It won't be saved again.");
      return;
    }
    recordBuckyEvent({id:pendingAction.id,status:"saving",title:"Saving financial record",detail:pendingAction.description,profileId:pendingAction.profileId,profileName:pendingAction.profileName,currency:pendingAction.currency});
    setActionBusy(true);
    setActionError("");
    try {
      messageOwnerRef.current=profiles.find(owner=>owner.id===pendingAction.profileId)??null;
      const txn = buildBuckyTransaction(pendingAction, nowIso());
      validateTransaction(txn);
      // Commit-confirmed save: resolves only when IndexedDB commits, and
      // the stable preview ID makes a repeated save reject instead of
      // duplicating the record.
      await createTransactionConfirmed(txn);
      executedActionIdsRef.current.add(pendingAction.id);
      recordBuckyEvent({id:pendingAction.id,status:"saved",title:"Financial record saved",detail:pendingAction.description+" · "+formatMoney(txn.amountMinor,txn.currency),profileId:txn.profileId,profileName:pendingAction.profileName,currency:txn.currency,recordId:txn.id});
      setLocallySaved((prev) => (prev.some((t) => t.id === txn.id) ? prev : [txn, ...prev]));

      // Updated calculations, recomputed deterministically from records
      // including the one just saved.
      const merged = [txn, ...effectiveTransactions.filter((t) => t.id !== txn.id)];
      const facts: { label: string; value: string }[] = [];
      let message = `${pendingAction.description} — ${formatMoney(pendingAction.amountMinor, pendingAction.currency)} on ${pendingAction.date}.`;
      if (pendingAction.kind === "savings-contribution") {
        const bucket = buckets.find((b) => b.id === pendingAction.bucketId);
        const progress = bucket ? bucketGoalProgress(merged, bucket) : null;
        if (bucket && progress) {
          const before=bucketGoalProgress(effectiveTransactions,bucket)?.percent??0;
          if(before<100&&progress.percent>=100)recordBuckyEvent({id:pendingAction.id,status:"saved",title:"Savings goal achieved",detail:bucket.name+" · "+formatMoney(progress.savedMinor,bucket.currency),profileId:txn.profileId,profileName:pendingAction.profileName,currency:txn.currency,recordId:txn.id});
          facts.push(
            { label: "Saved so far", value: formatMoney(progress.savedMinor, bucket.currency) },
            { label: "Goal", value: formatMoney(bucket.targetMinor ?? 0, bucket.currency) },
            { label: "Progress", value: `${progress.actualPercent.toFixed(0)}%` },
            ...(progress.overTargetMinor > 0
              ? [{ label: "Above target", value: formatMoney(progress.overTargetMinor, bucket.currency) }]
              : []),
          );
          message = `Added ${formatMoney(pendingAction.amountMinor, pendingAction.currency)} to “${bucket.name}”.`;
        }
      } else {
        const updated = analyzeBuckyFinances({
          profile:profiles.find(owner=>owner.id===txn.profileId)??profile, buckets, transactions: merged, products, sales, employees,
        });
        const currency = updated.currencies.find((c) => c.currency === pendingAction.currency);
        if (currency) {
          facts.push(
            { label: "Income", value: formatMoney(currency.incomeMinor, currency.currency) },
            { label: "Expenses", value: formatMoney(currency.expenseMinor, currency.currency) },
            { label: "Net cash flow (not profit)", value: formatMoney(currency.netCashFlowMinor, currency.currency) },
          );
          if (pendingAction.kind === "salary-payment" && currency.salaryPaymentCount > 0) {
            facts.push({ label: "Salary expenses recorded", value: formatMoney(currency.salaryExpenseMinor, currency.currency) });
          }
        }
      }
      const wasVoice = pendingViaVoiceRef.current;
      setSavedResult({ message, facts });
      setPendingAction(null);
      // Only a successfully committed save notifies mounted views (and the
      // host callback). Cancelled previews, clarifications, and failed
      // saves reach neither — they changed nothing.
      notifyRecordsChanged({
        profileId: txn.profileId,
        transactionId: txn.id,
        kind: pendingAction.kind,
      });
      reactMascot("Emotion_Happy");
      onRecordsChanged?.();
      if (wasVoice && voiceResponsesOnRef.current) {
        speakText(prepareSpeechText(message, facts));
      }
    } catch (error) {
      const committed=executedActionIdsRef.current.has(pendingAction.id);
      const message=committed?"The record was saved, but the view could not refresh. Check Transactions before retrying.":error instanceof Error?error.message+' Nothing was saved.':'The record could not be saved. Nothing was saved.';
      if(!committed)recordBuckyEvent({id:pendingAction.id,status:'failed',title:'Financial action failed',detail:message,profileId:pendingAction.profileId,profileName:pendingAction.profileName,currency:pendingAction.currency});
      setInteractionPhase(committed?'success':'error');setActionError(message);
    } finally {
      setActionBusy(false);
    }
  }

  function cancelPendingProduct() {
    if(pendingProduct) recordBuckyEvent({id:pendingProduct.id,status:"cancelled",title:"Add product",detail:pendingProduct.name+" · Nothing was created.",profileId:pendingProduct.profileId,profileName:pendingProduct.profileName,currency:pendingProduct.currency});
    setInteractionPhase("cancelled");
    setPendingProduct(null);
    setProductError("");
    setAnswer({
      answer: "Cancelled — no product was created.",
      facts: [],
      proposalIds: [],
      insufficientData: false,
    });
  }

  /**
   * Creates the previewed product through the exact Products & Inventory
   * path: SKU-conflict check, validateProduct, productsRepo.create. The
   * proposal's stable ID becomes the product ID, and confirmed IDs are
   * remembered, so a repeated confirmation can never duplicate it.
   */
  async function confirmPendingProduct() {
    if (!pendingProduct || productBusy || !profile) return;
    if (executedProductIdsRef.current.has(pendingProduct.id)) {
      setProductError("This product was already created. It won't be created again.");
      return;
    }
    recordBuckyEvent({id:pendingProduct.id,status:"saving",title:"Creating product",detail:pendingProduct.name,profileId:pendingProduct.profileId,profileName:pendingProduct.profileName,currency:pendingProduct.currency});
    setProductBusy(true);
    setProductError("");
    try {
      const product = buildBuckyProduct(pendingProduct, nowIso());
      const conflict = findSkuConflict(effectiveProducts, product.profileId, product.sku);
      if (conflict) {
        setInteractionPhase("error");
        recordBuckyEvent({id:pendingProduct.id,status:"failed",title:"Product not created",detail:"This SKU is already assigned in this business.",profileId:pendingProduct.profileId,profileName:pendingProduct.profileName,currency:pendingProduct.currency});
        setProductError(`SKU “${product.sku}” is already used by “${conflict.name}” in this business. Nothing was created.`);
        return;
      }
      validateProduct(product);
      await productsRepo.create(product);
      executedProductIdsRef.current.add(pendingProduct.id);
      recordBuckyEvent({id:pendingProduct.id,status:"saved",title:"Product created",detail:product.name,profileId:product.profileId,profileName:pendingProduct.profileName,currency:product.currency,recordId:product.id});
      setLocallyCreatedProducts((prev) =>
        prev.some((p) => p.id === product.id) ? prev : [product, ...prev],
      );
      const wasVoice = pendingViaVoiceRef.current;
      setSavedResult({
        message: `“${product.name}” added to ${pendingProduct.profileName} products. It is now available in Products & Inventory and POS.`,
        facts: [
          { label: "Selling price", value: formatMoney(product.priceMinor, product.currency) },
          { label: "Opening stock", value: String(product.stock) },
          { label: "Status", value: "Active" },
        ],
      });
      setPendingProduct(null);
      // Only a successfully committed creation notifies mounted views.
      notifyRecordsChanged({ profileId: product.profileId, kind: "product-created" });
      onRecordsChanged?.();
      reactMascot("Emotion_Happy");
      if (wasVoice && voiceResponsesOnRef.current) {
        speakText(`Created ${product.name} at ${formatMoney(product.priceMinor, product.currency)}.`);
      }
    } catch (error) {
      const committed=executedProductIdsRef.current.has(pendingProduct.id);
      const message=committed?"The product was created, but the view could not refresh. Check Inventory before retrying.":error instanceof Error?error.message+' Nothing was created.':'The product could not be created. Nothing was created.';
      if(!committed)recordBuckyEvent({id:pendingProduct.id,status:'failed',title:'Product creation failed',detail:message,profileId:pendingProduct.profileId,profileName:pendingProduct.profileName,currency:pendingProduct.currency});
      setInteractionPhase(committed?'success':'error');setProductError(message);
    } finally {
      setProductBusy(false);
    }
  }

  function cancelPendingAppAction() {
    if (pendingAppAction) recordBuckyEvent({ id: pendingAppAction.id, status: "cancelled", title: appActionTitle(pendingAppAction), detail: "Nothing was changed.", profileId: pendingAppAction.profileId, profileName: pendingAppAction.profileName, currency: pendingAppAction.currency });
    setInteractionPhase("cancelled");
    setPendingAppAction(null);
    setAppError("");
    setAnswer({ answer: "Cancelled — nothing was changed.", facts: [], proposalIds: [], insufficientData: false });
  }

  /** Executes a confirmed app action through the existing validated
   * repositories and reports the actual persisted result. No confirmation
   * means this function never runs, so no write can happen. */
  async function confirmPendingAppAction() {
    if (!pendingAppAction || appBusy || !profile) return;
    if (executedAppIdsRef.current.has(pendingAppAction.id)) { setAppError("This action was already completed. It won't run again."); return; }
    const action = pendingAppAction;
    messageOwnerRef.current=profiles.find(owner=>owner.id===action.profileId)??null;
    recordBuckyEvent({ id: action.id, status: "saving", title: appActionTitle(action), detail: appActionTitle(action), profileId: action.profileId, profileName: action.profileName, currency: action.currency });
    setAppBusy(true);
    setAppError("");
    try {
      let message = "";
      let facts: { label: string; value: string }[] = [];
      if (action.kind === "create-employee") {
        const record = buildEmployeeRecord(action, nowIso());
        validateEmployee(record);
        await employeesRepo.create(record);
        message = `Employee "${record.name}" added to ${action.profileName}.`;
        facts = [{ label: "Employee", value: record.name }, { label: "Role", value: record.role ?? "Not set" }, { label: "Status", value: "Active" }];
      } else if (action.kind === "adjust-stock") {
        const current=await incrementProductStock({id:action.productId,profileId:action.profileId,currency:action.currency,delta:action.delta,actionId:action.id});
        message=`"${current.name}" stock increased by ${action.delta} to ${current.stock}.`;
        facts=[{label:'Product',value:current.name},{label:'New stock',value:String(current.stock)}];
      } else if (action.kind === "create-bucket") {
        const record = buildBucketRecord(action, nowIso());
        validateBucket(record);
        await bucketsRepo.create(record);
        message = `Savings bucket "${record.name}" created for ${action.profileName}.`;
        facts = [{ label: "Bucket", value: record.name }, ...(record.targetMinor ? [{ label: "Goal", value: formatMoney(record.targetMinor, record.currency) }] : [])];
      } else {
        // POS cart: queue a single-use handoff; POS consumes it and the
        // cashier still reviews quantities before atomic checkout.
        queuePosCartHandoff(window.sessionStorage, { profileId: action.profileId, items: [{ productId: action.productId, quantity: action.quantity }], createdAt: Date.now() });
        message = `${action.quantity} × "${action.productName}" queued for the POS cart in ${action.profileName}. Open POS to review and check out.`;
        facts = [{ label: "Product", value: action.productName }, { label: "Quantity", value: String(action.quantity) }];
        void POS_CART_HANDOFF_KEY;
      }
      executedAppIdsRef.current.add(action.id);
      recordBuckyEvent({ id: action.id, status: "saved", title: appActionTitle(action), detail: message, profileId: action.profileId, profileName: action.profileName, currency: action.currency, recordId: action.id });
      setSavedResult({ message, facts });
      setPendingAppAction(null);
      notifyRecordsChanged({ profileId: action.profileId, kind: action.kind });
      onRecordsChanged?.();
      reactMascot("Emotion_Happy");
      if (action.kind === "pos-cart-add") window.location.hash = "/pos";
      if (pendingViaVoiceRef.current && voiceResponsesOnRef.current) speakText(prepareSpeechText(message, facts));
    } catch (error) {
      const committed = executedAppIdsRef.current.has(action.id);
      const message = committed ? "Done, but the view could not refresh. Check the relevant page before retrying." : error instanceof Error ? `${error.message} Nothing was changed.` : "The action could not be completed. Nothing was changed.";
      if (!committed) recordBuckyEvent({ id: action.id, status: "failed", title: appActionTitle(action), detail: message, profileId: action.profileId, profileName: action.profileName, currency: action.currency });
      setInteractionPhase(committed ? "success" : "error");
      setAppError(message);
    } finally {
      setAppBusy(false);
    }
  }

  function clearSilenceTimer() {
    if (silenceTimerRef.current !== null) {
      window.clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  }

  function scheduleSilenceTimer() {
    clearSilenceTimer();
    if (typeof window === "undefined") return;
    silenceTimerRef.current = window.setTimeout(() => {
      silenceTimerRef.current = null;
      // A result may have landed just as the timer fired; only finish
      // when the full silence window has genuinely elapsed.
      if (!hasSilenceElapsed(lastResultAtRef.current, Date.now())) {
        scheduleSilenceTimer();
        return;
      }
      finishListening();
    }, SILENCE_TIMEOUT_MS);
  }

  /** Existing clips react to actual results; the controller handles one-shot completion. */
  function reactMascot(clip: string) {setInteractionPhase(clip==='Emotion_Happy'?'success':'error');}

  /**
   * Natural voice flow: a cleanly finished transcript is interpreted
   * automatically — no extra Run tap. The transcript stays visible
   * ("Heard: …") so a mis-hearing can be corrected or retried, and
   * interpretation still only ever *proposes*: every write needs the
   * structured preview and an explicit Confirm.
   */
  function processTranscriptAutomatically(heard: string) {
    setPendingTranscript(heard);
    // The composer is never filled with the voice transcript: it would
    // leave stale text behind after the message is sent. Only clear a
    // composer copy that exactly matches what was just submitted (e.g.
    // left over from a reviewed transcript); an unrelated typed draft
    // the user is still writing is preserved untouched.
    if (getBuckyDraft().trim() === heard.trim()) setQuestion("");
    setInterimTranscript("");
    setVoicePhase((p) => voiceTransition(p, "heard"));
    ask(heard, true);
  }

  /**
   * Settle a finished session. A valid final transcript is sent once,
   * automatically — there is no transcript review/Run step. After a
   * genuine recognition failure the transcript may be incomplete, so it
   * is discarded rather than executed: the recognition error already
   * shown explains what happened and the user can simply speak again.
   * A user-cancelled session settles silently. Interpretation still
   * only ever *proposes* writes: every record change needs the
   * structured preview and an explicit Confirm.
   */
  function settleTranscript(heard: string) {
    if (recognitionCancelledRef.current) {
      setPendingTranscript("");
      setInterimTranscript("");
      return;
    }
    if (
      shouldAutoProcessTranscript({
        heard,
        errorCode: recognitionErrorRef.current,
        cancelled: false,
      })
    ) {
      processTranscriptAutomatically(heard);
      return;
    }
    // Genuinely failed recognition: never run the uncertain transcript,
    // never park it in a review step, and leave no stale composer text.
    if (getBuckyDraft().trim() === heard.trim()) setQuestion("");
    setPendingTranscript("");
    setInterimTranscript("");
    setVoicePhase("idle");
    if (!recognitionErrorRef.current) {
      setVoiceError("I didn't catch that clearly. Tap the microphone and say it again.");
    }
  }

  function startHomeVoice(){
    if(hasPendingPreview||actionBusy||productBusy||appBusy||interpretBusy)return;
    messageOwnerRef.current=null;continuousVoice.start();followLatest.current=true;cancelListening();stopSpeaking();setVoiceError('');setPendingTranscript('');setInterimTranscript('');setVoiceHistoryExpanded(true);setVoiceSessionStart(thread.at(-1)?.id??0);
    if(!recognitionSupported){continuousVoice.stop();setInteractionPhase('error');setVoicePhase('unsupported');setVoiceError("Voice input isn't supported in this browser. You can still type your question.");return;}
    // One-click reliability: start the microphone synchronously in this
    // activation instead of after a spoken greeting (the greeting delay
    // lost the browser's user-activation and caused first-click failure).
    // The greeting is shown as text; Bucky still speaks answers.
    pushMsg("bucky", "Hi! How can I help you?");
    startListening();
  }
  function stopHomeVoice(){continuousVoice.stop();cancelListening();stopSpeaking();setVoicePhase('idle');}
  function startListening() {
    if(micPending){cancelListening();return;}
    if (hasPendingPreview || actionBusy || productBusy || appBusy || interpretBusy) {
      setVoiceError("Confirm or cancel the current preview before starting another request.");
      return;
    }
    if (voicePhase === "listening") {
      finishListening();
      return;
    }
    if(recognitionRef.current)return;
    setVoiceError("");
    setInterimTranscript("");
    setPendingTranscript("");
    if (!recognitionSupported) {
      setInteractionPhase("error");
      setVoicePhase("unsupported");
      setVoiceError("Voice input isn't supported in this browser. Typing works as usual.");
      return;
    }
    stopSpeaking();
    const Ctor = getSpeechRecognitionCtor(window);
    if (!Ctor) {
      setInteractionPhase("error");
      setVoicePhase("unsupported");
      setVoiceError("Voice input isn't supported in this browser. Typing works as usual.");
      return;
    }
    recognitionCancelledRef.current = false;
    recognitionStopRequestedRef.current = false;
    recognitionErrorRef.current = "";
    recognitionRestartsRef.current = 0;
    finalTranscriptRef.current = "";
    clearSilenceTimer();
    lastResultAtRef.current = 0;
    const recognition = new Ctor();
    recognition.lang = voiceSettingsRef.current.language ?? "en-US";
    recognition.interimResults = true;
    // Continuous mode keeps listening through natural pauses so longer
    // commands are not cut off at the first sentence break. The browser
    // may still end the session on its own; onend below handles that.
    recognition.continuous = true;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => {
      if(recognitionCancelledRef.current || recognitionRef.current !== recognition)return;
      setMicPending(false);setVoicePhase(p=>voiceTransition(p,"start"));
    };
    recognition.onresult = (event) => {
      if (recognitionCancelledRef.current || recognitionRef.current !== recognition) return;
      const { finalText, interimText } = transcriptsFromEvent(event);
      // Any sign of speech — final or interim — restarts the trailing
      // silence window, so a natural pause (or a completed utterance)
      // ends listening and settles the transcript after ~3 quiet seconds.
      if (finalText || interimText) {
        lastResultAtRef.current = Date.now();
        scheduleSilenceTimer();
      }
      if (finalText) {
        // Drop Bucky's own voice leaking back in; never a new turn.
        if (isEchoOfSpeech(finalText, lastSpokenRef.current)) return;
        continuousVoice.heard();
        finalTranscriptRef.current = appendFinalTranscript(finalTranscriptRef.current, finalText);
        // A live result proves the session is healthy; refill the
        // bounded restart budget so long commands can span restarts.
        recognitionRestartsRef.current = 0;
      }
      const heardSoFar = finalTranscriptRef.current;
      setInterimTranscript(interimText ? `${heardSoFar} ${interimText}`.trim() : heardSoFar);
    };
    recognition.onerror = (event) => {
      if (recognitionCancelledRef.current || recognitionRef.current !== recognition) return;
      clearSilenceTimer();
      // Record the failure; onend (which always follows) decides the
      // final state. A partial transcript after a genuine error is
      // discarded, never executed automatically.
      setMicPending(false);setInteractionPhase("error");
      recognitionErrorRef.current = event.error;
      // A benign settle error ("no-speech" / "aborted") after speech was
      // already captured is not a failure: it must neither kill the
      // continuous voice session nor lose the finished transcript —
      // onend settles and auto-processes it.
      const benignWithSpeech = (event.error === "no-speech" || event.error === "aborted") && finalTranscriptRef.current.trim().length > 0;
      if(event.error!=="no-speech"&&event.error!=="aborted")continuousVoice.stop();
      if (benignWithSpeech) return;
      const mapped = speechRecognitionErrorMessage(event.error);
      setVoicePhase(mapped.phase);
      setVoiceError(mapped.message);
    };
    recognition.onend = () => {
      if (recognitionRef.current !== recognition) return;
      setMicPending(false);
      if (recognitionCancelledRef.current) {
        clearSilenceTimer();
        recognitionRef.current = null;
        return;
      }
      const heard = finalTranscriptRef.current.trim();
      setVoicePhase("idle");
      if (!recognitionErrorRef.current && !recognitionStopRequestedRef.current) {
        // Unexpected end (browser time limit / long silence) with no
        // explicit user stop: restart a bounded number of times so a
        // long command can continue. canRestartRecognition also blocks
        // restarts after errors and denials, preventing loops.
        if (
          canRestartRecognition({
            cancelled: false,
            stopRequested: false,
            errorCode: "",
            restarts: recognitionRestartsRef.current,
          })
        ) {
          recognitionRestartsRef.current += 1;
          try {
            setMicPending(true);setVoicePhase("idle");
            recognition.start();
            return;
          } catch {
            // Restart refused (session already active/ended); fall
            // through and settle with whatever was heard.
          }
        }
      }
      // Settling (no restart): the silence timer's job is done.
      clearSilenceTimer();
      recognitionRef.current = null;
      finalTranscriptRef.current = "";
      if (heard) {
        settleTranscript(heard);
      } else if (inlineVoice && continuousVoice.isActive() && (!recognitionErrorRef.current || recognitionErrorRef.current==='no-speech')) {
        setInterimTranscript('');setVoicePhase('idle');setVoiceError('');
        if(!continuousVoice.silentEnd(()=>canResumeVoiceRef.current(),()=>listenAfterGreetingRef.current())){setInteractionPhase('error');setVoicePhase('error');setVoiceError('No speech was detected after several attempts. Choose Retry to restart voice.');}
      } else if (!recognitionErrorRef.current) {
        setInterimTranscript("");
        setVoicePhase((p) => (p === "listening" || p === "review" ? voiceTransition(p, "end") : p));
      } else {
        setInterimTranscript("");
      }
    };
    recognitionRef.current = recognition;
    setInteractionPhase("idle");
    setVoicePhase("idle");
    setMicPending(true);
    try {
      recognition.start();
    } catch {
      // A stale session can throw InvalidStateError on the first click;
      // abort it and retry once synchronously before giving up.
      try { recognition.abort(); } catch { /* ignore */ }
      try {
        recognition.start();
      } catch {
        continuousVoice.stop();recognitionRef.current=null;
        setVoicePhase("error");
        setMicPending(false);setInteractionPhase("error");
        setVoiceError("Speech recognition couldn't start. Tap the microphone again, or type your question instead.");
      }
    }
  }

  /**
   * Intentional completion: stop() (not abort()) so the browser flushes
   * any queued final results before onend settles them.
   */
  function finishListening() {
    clearSilenceTimer();
    recognitionStopRequestedRef.current = true;
    try {
      recognitionRef.current?.stop();
    } catch {
      // Recognition already ended; onend will not fire again, so settle
      // here with whatever was accumulated.
      const heard = finalTranscriptRef.current.trim();
      finalTranscriptRef.current = "";
      recognitionRef.current = null;
      if (heard) settleTranscript(heard);
      else setVoicePhase((p) => (p === "listening" ? voiceTransition(p, "stop") : p));
    }
  }

  /** Cancel listening outright: discard the transcript, never review it. */
  function cancelListening() {
    setMicPending(false);
    clearSilenceTimer();
    recognitionCancelledRef.current = true;
    recognitionStopRequestedRef.current = false;
    finalTranscriptRef.current = "";
    try {
      recognitionRef.current?.abort();
    } catch {
      // Recognition already ended; nothing to stop.
    }
    recognitionRef.current = null;
    setInterimTranscript("");
    setPendingTranscript("");
    setVoicePhase((p) => (p === "listening" || p === "processing" ? voiceTransition(p, "stop") : p));
  }

  /** Put an auto-processed transcript back in the input to fix a mis-hearing. */
  function correctTranscript() {
    stopSpeaking();
    setQuestion(pendingTranscript);
    setPendingTranscript("");
    setVoiceError("");
    setVoicePhase((p) => voiceTransition(p, "reset"));
    document.getElementById("bucky-question")?.focus({preventScroll:true});
  }

  /** Throw the transcript away and listen again from scratch. */
  function retryListening() {
    if (hasPendingPreview) { setVoiceError("Confirm or cancel the preview before retrying."); return; }
    if (question === pendingTranscript) setQuestion("");
    setPendingTranscript("");
    setVoiceError("");
    startListening();
  }

  useEffect(() => {
    if (!active) return;
    const region = conversationScroll.current; if (!region) return;
    const newest = () => { if(followLatest.current)region.scrollTop = region.scrollHeight; };
    const frame = requestAnimationFrame(newest);
    const observer = new ResizeObserver(newest); observer.observe(region);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [active, thread.length, hasPendingPreview]);

  useEffect(() => {
    if (pendingTranscript && question.trim() === pendingTranscript.trim()) setQuestion("");
    continuousVoice.stop();cancelListening(); stopSpeaking(); setPendingTranscript(''); setInterimTranscript(''); setVoiceError(''); setVoicePhase('idle');
  }, [navigationKey]);

  const wasBlockedForVoice=useRef(false);
  useEffect(()=>{
    const blocked=hasPendingPreview||voicePhase==='review';
    if(wasBlockedForVoice.current&&!blocked&&continuousVoice.isActive())resumeVoice();
    wasBlockedForVoice.current=blocked;
  },[hasPendingPreview,voicePhase]);
  const consumedRequest = useRef('');
  useEffect(() => {
    if (!active) { continuousVoice.stop();cancelListening(); stopSpeaking(); setPendingTranscript(""); setInterimTranscript(""); setVoiceError(""); setVoicePhase("idle"); }
  }, [active]);
  useEffect(() => {
    if (!active || !conversationRequest || consumedRequest.current === conversationRequest.id) return;
    if (hasPendingPreview) return;
    if (conversationRequest.profileId && profile?.id !== conversationRequest.profileId) {
      if (profiles.some(p => p.id === conversationRequest.profileId)) { setInteractionPhase("idle"); setSelectedProfileId(conversationRequest.profileId); return; }
      consumedRequest.current = conversationRequest.id;
      setActionError("The selected profile is no longer available. Choose a profile before asking again.");
      return;
    }
    consumedRequest.current = conversationRequest.id;
    if(conversationRequest.mode==='voice'){startHomeVoice();return;}
    if (conversationRequest.question) { ask(conversationRequest.question,false,true); }
  }, [active, conversationRequest, analysis, profile, hasPendingPreview, profiles]);

  // Leaving the panel always silences Bucky: no orphan mic or speech.
  useEffect(
    () => () => {
      continuousVoice.stop();clearSilenceTimer();

      recognitionCancelledRef.current = true;
      try {
        recognitionRef.current?.abort();
      } catch {
        // Already stopped.
      }
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
    },
    [],
  );

  return (
    <section className={inlineVoice?"panel bucky-panel bucky-panel--home-voice":"panel bucky-panel"} aria-label={inlineVoice?"Bucky voice interaction":"Bucky conversation"}>
      {!compact && <div className="bucky-chat-head">
        <BuckyMascot talking={voicePhase === "speaking"} animation={voicePhase === "listening" ? "Listening" : voicePhase === "processing" ? "Thinking" : interactionPhase === "success" ? "Emotion_Happy" : interactionPhase === "error" ? "Emotion_Concerned" : undefined} label="Bucky, your financial intelligence companion" />
        <div>
          <h2 id="bucky-panel-heading">Bucky Financial Intelligence</h2>
        </div>
      </div>}
      <div className="bucky-interactions">
      <>
          {inlineVoice && <div className="bucky-home-voice-toolbar"><span className={voiceError?'bucky-voice-dot is-error':speechPending||voicePhase==='speaking'||voicePhase==='processing'||interactionPhase==='processing'||serverBusy?'bucky-voice-dot is-busy':voicePhase==='listening'&&!micPending&&recognitionRef.current?'bucky-voice-dot':'bucky-voice-dot is-idle'} role="status"><span className="sr-only">{voiceError?'Voice unavailable':speechPending?'Preparing greeting':voicePhase==='speaking'?'Speaking':micPending?'Starting microphone':voicePhase==='listening'?'Listening':voicePhase==='processing'||interactionPhase==='processing'||serverBusy?'Processing':voicePhase==='review'?'Review transcript':pendingAction||pendingProduct?'Confirmation required':'Ready'}</span></span><div className="bucky-home-voice-actions"><button className="btn ghost small" type="button" onClick={stopHomeVoice}>Stop</button><button className="btn ghost small" type="button" aria-expanded={voiceHistoryExpanded} onClick={()=>setVoiceHistoryExpanded(value=>!value)}>Details</button><button className="btn ghost small" type="button" onClick={()=>{if(!onNavigateAway || onNavigateAway())stopHomeVoice();}}>Close</button></div></div>}
          <div className="bucky-scroll-region" ref={conversationScroll} onScroll={event=>{const el=event.currentTarget;followLatest.current=el.scrollHeight-el.scrollTop-el.clientHeight<40;}} tabIndex={inlineVoice?0:undefined} role={inlineVoice?'region':undefined} aria-label={inlineVoice?'Voice conversation':undefined}>
          {inlineVoice && voiceError && <div><p className="alert-error" role="alert">{voiceError}</p><button className="btn ghost small" type="button" disabled={!recognitionSupported} onClick={ttsSupported?startHomeVoice:startListening}>{ttsSupported?'Retry':'Listen without greeting'}</button></div>}
          {messageOwnerRef.current && analysis && (!inlineVoice || voiceHistoryExpanded) && (!analysis.hasAnyData ? (
            <div className="empty-state">
              <p>No records to analyse for {analysis.profileName} yet.</p>
              <p className="muted">
                Add your first record to see insights here.
              </p>
            </div>
          ) : (
            <details className="bucky-insight-details"><summary>Profile overview <span className="count-badge">{analysis.insights.length}</span></summary><ul className="bucky-insights">
              {analysis.insights.map((insight) => {
                const proposal = insight.proposalId
                  ? analysis?.proposals.find((p) => p.id === insight.proposalId)
                  : undefined;
                return (
                  <li key={insight.id} className={`bucky-insight bucky-${insight.severity}`}>
                    <strong>{insight.title}</strong>
                    <p>{insight.detail}</p>
                    {insight.evidence.length > 0 && (
                      <dl className="bucky-evidence">
                        {insight.evidence.map((e) => (
                          <div key={`${e.label}-${e.value}`}>
                            <dt>{e.label}</dt>
                            <dd>{e.value}</dd>
                          </div>
                        ))}
                      </dl>
                    )}
                    {proposal && (
                      <button className="btn ghost small" type="button" onClick={() => { if (proposal.action.type === "scan" && onScanRequest) { onScanRequest(); return; } if (onNavigateAway && !onNavigateAway()) return; goToProposal(proposal); }}>
                        {proposal.action.label}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
            <p className="muted"><strong>How this is calculated</strong></p>
            <ul>
              {analysis.limitations.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul></details>
          ))}



          {voiceMessages.length > 0 && (
            <div className="bucky-thread" aria-live="polite" aria-label="Conversation with Bucky">
              {voiceMessages.map((msg) => (
                <div key={msg.id} className={msg.role === "user" ? "bucky-msg bucky-msg--user" : "bucky-msg bucky-msg--bucky"}>
                  <p>{msg.profileName ? msg.text.replace("All-time recorded totals for "+msg.profileName+".", "All-time totals.") : msg.text}</p>
                  {(!inlineVoice||voiceHistoryExpanded)&&msg.facts.length > 0 && (
                    <dl className="bucky-evidence">
                      {msg.facts.map((f) => (
                        <div key={`${f.label}-${f.value}`}><dt>{f.label}</dt><dd>{f.value}</dd></div>
                      ))}
                    </dl>
                  )}
                  {(!inlineVoice||voiceHistoryExpanded)&&msg.proposalIds.map((id) => {
                    const proposal = analysis?.proposals.find((p) => p.id === id);
                    return proposal && (!msg.profileId || msg.profileId === profile?.id) ? (
                      <button key={id} className="btn ghost small" type="button" onClick={() => { if (proposal.action.type === "scan" && onScanRequest) { onScanRequest(); return; } if (onNavigateAway && !onNavigateAway()) return; goToProposal(proposal); }}>
                        {proposal.action.label}
                      </button>
                    ) : null;
                  })}
                  {(!inlineVoice||voiceHistoryExpanded)&&msg.role === "bucky" && ttsSupported && msg.id === thread[thread.length - 1]?.id && (
                    <div className="row-actions">
                      <button disabled={micPending || voicePhase === "listening" || voicePhase === "processing"} className="btn ghost small" type="button" onClick={() => speakText(prepareSpeechText(msg.text, msg.facts))}>
                        <Icon name="speaker" />Listen
                      </button>
                      {(voicePhase === "speaking" || speechPending) && (
                        <button className="btn ghost small" type="button" onClick={stopSpeaking}>
                          <Icon name="stop" />Stop
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {aiInterpretText && !pendingAction && (
            <div className="bucky-interpret-note">
              <p className="muted">
                The built-in interpreter couldn't turn “{aiInterpretText}” into a record, and nothing was saved.
              </p>
              <div className="row-actions">
                <button className="btn ghost small" type="button" onClick={() => void tryAiInterpret()} disabled={interpretBusy}>
                  {interpretBusy ? "Interpreting…" : "Try AI interpretation"}
                </button>
                <span className="muted">Uses live Meta AI when configured on the server. The suggestion is still checked and previewed before anything is saved.</span>
              </div>
              {interpretNote && <p className="muted" role="status">{interpretNote}</p>}
            </div>
          )}

          {messageOwnerRef.current && (!inlineVoice || voiceHistoryExpanded) && presentation.events.some(event=>event.profileId===profile?.id && event.status!=='awaiting' && event.status!=='saving') && <details className="bucky-action-journal" open><summary>Recent actions</summary><ol>{presentation.events.filter(event=>event.profileId===profile?.id && event.status!=='awaiting' && event.status!=='saving').slice(-3).map(event=><li key={event.id}><span className={'bucky-event-status bucky-event-status--'+event.status}>{ACTION_STATUS_LABELS[event.status]}</span><strong>{event.title}</strong><p>{event.detail}</p></li>)}</ol></details>}
          {pendingAction && (
            <div className="bucky-action-preview" role="region" aria-label="Review this action before saving">
              <p className="bucky-action-state" role="status">{actionBusy?"Saving…":"Awaiting your confirmation"}</p>
              <h3>{buckyActionTitle(pendingAction)}</h3>
              <p className="muted">Check every detail. Nothing is saved until you confirm — spoken requests follow this same rule.</p>
              <dl className="bucky-evidence">
                <div><dt>Profile</dt><dd>{pendingAction.profileName}</dd></div>
                <div><dt>Amount</dt><dd>{formatMoney(pendingAction.amountMinor, pendingAction.currency)}</dd></div>
                <div><dt>Date</dt><dd>{pendingAction.date}</dd></div>
                <div><dt>Description</dt><dd>{pendingAction.description}</dd></div>
                {pendingAction.category && (
                  <div><dt>Category</dt><dd>{pendingAction.category}</dd></div>
                )}
                {pendingAction.bucketName && (
                  <div><dt>Savings goal</dt><dd>{pendingAction.bucketName}</dd></div>
                )}
                {pendingAction.employeeName && (
                  <div><dt>Employee</dt><dd>{pendingAction.employeeName}{pendingAction.employeeMatched ? " (matched record)" : " (no matching record)"}</dd></div>
                )}
              </dl>
              {pendingAction.warnings.length > 0 && (
                <ul className="bucky-action-warnings">
                  {pendingAction.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              )}
              {actionError && <p className="alert-error" role="alert">{actionError}</p>}
              <div className="row-actions">
                <button className="btn" type="button" onClick={() => void confirmPendingAction()} disabled={actionBusy}>
                  {actionBusy ? "Saving…" : "Confirm save"}
                </button>
                <button className="btn ghost" type="button" onClick={cancelPendingAction} disabled={actionBusy}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {pendingProduct && (
            <div className="bucky-action-preview" role="region" aria-label="Review this product before creating it">
              <h3>Add product</h3>
              <p className="muted">Check every detail. Nothing is created until you confirm.</p>
              <dl className="bucky-evidence">
                <div><dt>Business</dt><dd>{pendingProduct.profileName}</dd></div>
                <div><dt>Product name</dt><dd>{pendingProduct.name}</dd></div>
                <div><dt>Selling price</dt><dd>{formatMoney(pendingProduct.priceMinor, pendingProduct.currency)}</dd></div>
                <div><dt>Currency</dt><dd>{pendingProduct.currency}</dd></div>
                <div><dt>SKU</dt><dd>None</dd></div>
                <div><dt>Category</dt><dd>None</dd></div>
                <div><dt>Cost</dt><dd>Not tracked</dd></div>
                <div><dt>Opening stock</dt><dd>{pendingProduct.stock}</dd></div>
                <div><dt>Status</dt><dd>Active</dd></div>
              </dl>
              {pendingProduct.warnings.length > 0 && (
                <ul className="bucky-action-warnings">
                  {pendingProduct.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              )}
              {productError && <p className="alert-error" role="alert">{productError}</p>}
              <div className="row-actions">
                <button className="btn" type="button" onClick={() => void confirmPendingProduct()} disabled={productBusy}>
                  {productBusy ? "Creating…" : "Confirm — create product"}
                </button>
                <button className="btn ghost" type="button" onClick={cancelPendingProduct} disabled={productBusy}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {pendingAppAction && (
            <div className="bucky-action-preview" role="region" aria-label="Review this action before confirming">
              <p className="bucky-action-state" role="status">{appBusy ? "Working…" : "Awaiting your confirmation"}</p>
              <h3>{appActionTitle(pendingAppAction)}</h3>
              <p className="muted">Check every detail. Nothing changes until you confirm.</p>
              <dl className="bucky-evidence">
                <div><dt>Profile</dt><dd>{pendingAppAction.profileName}</dd></div>
                {pendingAppAction.kind === "create-employee" && <><div><dt>Employee</dt><dd>{pendingAppAction.name}</dd></div><div><dt>Role</dt><dd>{pendingAppAction.role ?? "Not set"}</dd></div>{pendingAppAction.salaryRateMinor !== undefined && <div><dt>Salary</dt><dd>{formatMoney(pendingAppAction.salaryRateMinor, pendingAppAction.currency)} / {pendingAppAction.salaryFrequency ?? "monthly"}</dd></div>}</>}
                {pendingAppAction.kind === "adjust-stock" && <><div><dt>Product</dt><dd>{pendingAppAction.productName}</dd></div><div><dt>Stock</dt><dd>{pendingAppAction.currentStock} → {pendingAppAction.newStock} (+{pendingAppAction.delta})</dd></div></>}
                {pendingAppAction.kind === "create-bucket" && <><div><dt>Bucket</dt><dd>{pendingAppAction.name}</dd></div><div><dt>Type</dt><dd>Savings</dd></div>{pendingAppAction.targetMinor ? <div><dt>Goal</dt><dd>{formatMoney(pendingAppAction.targetMinor, pendingAppAction.currency)}</dd></div> : null}</>}
                {pendingAppAction.kind === "pos-cart-add" && <><div><dt>Product</dt><dd>{pendingAppAction.productName}</dd></div><div><dt>Quantity</dt><dd>{pendingAppAction.quantity}</dd></div><div><dt>Unit price</dt><dd>{formatMoney(pendingAppAction.unitPriceMinor, pendingAppAction.currency)}</dd></div></>}
              </dl>
              {pendingAppAction.warnings.length > 0 && (
                <ul className="bucky-action-warnings">
                  {pendingAppAction.warnings.map((w) => (<li key={w}>{w}</li>))}
                </ul>
              )}
              {appError && <p className="alert-error" role="alert">{appError}</p>}
              <div className="row-actions">
                <button className="btn" type="button" onClick={() => void confirmPendingAppAction()} disabled={appBusy}>
                  {appBusy ? "Working…" : "Confirm"}
                </button>
                <button className="btn ghost" type="button" onClick={cancelPendingAppAction} disabled={appBusy}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {serverNote && (
            <div className="bucky-server-row">
              <span className="muted" role="status">{serverNote}</span>
            </div>
          )}



            {interimTranscript && voicePhase === "listening" && (
              <p className="bucky-voice-interim" role="status">{inlineVoice?"YOU: ":"Heard: "}{interimTranscript}…</p>
            )}
            {(!inlineVoice||voiceHistoryExpanded)&&pendingTranscript && voicePhase !== "listening" && (
              <div className="bucky-voice-heard">
                <p role="status"><strong>Heard:</strong> “{pendingTranscript}”</p>
                <div className="row-actions">
                  <button className="btn ghost small" type="button" disabled={pendingAction !== null || pendingProduct !== null} onClick={correctTranscript}>
                    Correct
                  </button>
                  <button className="btn ghost small" type="button" disabled={pendingAction !== null || pendingProduct !== null} onClick={retryListening}>
                    Retry
                  </button>
                  <button className="btn ghost small" type="button" onClick={() => { if (question === pendingTranscript) setQuestion(""); stopSpeaking(); setPendingTranscript(""); setVoiceError(""); setVoicePhase("idle"); }}>
                    Dismiss
                  </button>
                </div>
              </div>
            )}
            {!inlineVoice && voiceError && <p className="alert-error" role="alert">{voiceError}</p>}
            {!recognitionSupported && (
              <p className="muted bucky-voice-note">Voice input isn't supported in this browser — typing works as usual.</p>
            )}

          </div>
          <form
            hidden={inlineVoice}
            className="bucky-ask"
            onSubmit={(e) => {
              e.preventDefault();
              ask(question);
            }}
          >
            <label htmlFor="bucky-question">Ask Bucky</label>
            <div className="bucky-ask-row">
              <input
                id="bucky-question"
                className="input"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="Ask Bucky anything..."
                autoComplete="off"
              />
              <button className="btn" type="submit" disabled={!question.trim() || serverBusy || micPending || pendingAction !== null || pendingProduct !== null || actionBusy || productBusy || interpretBusy || voicePhase === "listening" || voicePhase === "processing"}>Send</button>
              <button
                className={voicePhase === "listening" ? "btn bucky-mic-btn is-listening" : "btn ghost bucky-mic-btn"}
                type="button"
                disabled={!recognitionSupported || actionBusy || productBusy || interpretBusy || pendingAction !== null || pendingProduct !== null}
                onClick={startListening}
                aria-pressed={voicePhase === "listening"}
                aria-label={micPending ? "Cancel microphone startup" : voicePhase === "listening" ? "Done listening" : "Speak to Bucky"}
                title={recognitionSupported ? (voicePhase === "listening" ? "Done — Bucky will take it from there; nothing is saved without your confirmation" : "Speak instead of typing") : "Voice input isn't supported in this browser"}
              >
                <Icon name="mic" /><span className="sr-only">{voicePhase === "listening" ? "Done" : "Speak"}</span>
              </button>
              <button aria-label="Scan record" title="Scan record" disabled={voicePhase === "listening" || voicePhase === "processing"} className="btn ghost" type="button" onClick={() => (onScanRequest ? onScanRequest() : goToRoute("scanner"))}>
                <Icon name="scanner" /><span className="sr-only">Scan record</span>
              </button>
            </div>
            <div className="bucky-voice-controls">
              <div className="bucky-language"><label htmlFor="bucky-speech-language">Speech language</label>
                <select id="bucky-speech-language" className="input" value={voiceSettings.language ?? 'en-US'} disabled={micPending || voicePhase === 'listening' || voicePhase === 'processing' || voicePhase === 'speaking'} onChange={event => updateVoiceSettings({language: event.target.value as 'en-US' | 'fil-PH'})}>
                  <option value="en-US">English</option><option value="fil-PH">Filipino / Tagalog</option>
                </select>
              </div>
              <button
                className="btn ghost small"
                type="button"
                onClick={() => {
                  if (voiceResponsesOn) stopSpeaking();
                  updateVoiceSettings({ responsesOn: !voiceResponsesOn });
                }}
                aria-pressed={voiceResponsesOn}
                aria-label={voiceResponsesOn ? "Turn voice responses off" : "Turn voice responses on"}
                title={ttsSupported ? "Spoken answers after voice questions" : "Speech isn't supported in this browser"}
              >
                <Icon name={voiceResponsesOn ? "speaker" : "speakerMute"} /><span className="sr-only">{voiceResponsesOn ? "Voice on" : "Voice off"}</span>
              </button>
              {(voicePhase === "listening" || micPending) && (
                <button className="btn ghost small" type="button" onClick={cancelListening}>
                  <Icon name="close" />Cancel
                </button>
              )}
              {voicePhase === "speaking" && (
                <button className="btn ghost small" type="button" onClick={stopSpeaking}>
                  <Icon name="stop" />Stop speaking
                </button>
              )}
              {voicePhase === "listening" && (
                <span className="bucky-voice-status" role="status">Listening… speak now — after a short pause I'll take it from there, or tap Done.</span>
              )}
              {voicePhase === "processing" && (
                <span className="bucky-voice-status" role="status">Processing what you said…</span>
              )}
              <a
                className="btn ghost small"
                href="#/settings"
                title="Voice settings"
                onClick={(event) => {
                  // Inside the floating dialog the host must close first;
                  // it vetoes navigation while a preview is unsaved.
                  if (onNavigateAway && !onNavigateAway()) event.preventDefault();
                }}
              >
                <Icon name="settings" /><span className="sr-only">Voice settings</span>
              </a>
            </div>

          </form>
      </>
      </div>
    </section>
  );
}

import {recordBuckyEvent,setBuckyPhase,getBuckyPresentation,subscribeBuckyPresentation,ACTION_STATUS_LABELS,type BuckyPhase} from "../lib/buckyPresentation";
import {getBuckyDraft,setBuckyDraft,subscribeBuckyDraft} from "../lib/buckyConversation";
import type { BuckyConversationRequest } from "../lib/buckyConversation";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Bucket, Employee, Product, Profile, Sale, Transaction } from "../data/types.ts";
import { createTransactionConfirmed, productsRepo } from "../data/db.ts";
import { findSkuConflict, newId, nowIso, validateProduct, validateTransaction } from "../data/validation.ts";
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
  type ProposedBuckyAction,
  type ProposedBuckyProduct,
} from "../lib/buckyActions.ts";
import {
  analyzeBuckyFinances,
  answerBuckyQuestion,
  type BuckyAnswer,
  type BuckyProposal,
} from "../lib/buckyAgent.ts";
import {
  BuckyApiError,
  requestBuckyInterpret,
} from "../lib/buckyApi.ts";
import {
  appendFinalTranscript,
  canRestartRecognition,
  detectUnsupportedAction,
  getSpeechRecognitionCtor,
  isSpeechRecognitionSupported,
  isSpeechSynthesisSupported,
  prepareSpeechText,
  buckyUtteranceTuning,
  pickPreferredVoice,
  shouldAutoProcessTranscript,
  SILENCE_TIMEOUT_MS,
  hasSilenceElapsed,
  speechRecognitionErrorMessage,
  transcriptsFromEvent,
  UNSUPPORTED_ACTION_ANSWER,
  voiceTransition,
  type BuckyVoicePhase,
  type SpeechRecognitionLike,
} from "../lib/buckyVoice.ts";
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
export default function BuckyPanel({ profiles, buckets, transactions, products, sales, employees = [], preferredProfileId, onRecordsChanged, onPendingActionChange, onNavigateAway, onScanRequest, conversationRequest, active = true, compact = false, navigationKey }: Props) {
  const presentation = useSyncExternalStore(subscribeBuckyPresentation,getBuckyPresentation,getBuckyPresentation);
  const [interactionPhase,setInteractionPhase] = useState<BuckyPhase>("idle");
  const [speechPending,setSpeechPending] = useState(false);
  const [micPending,setMicPending] = useState(false);
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const question = useSyncExternalStore(subscribeBuckyDraft,getBuckyDraft,getBuckyDraft);
  const setQuestion = setBuckyDraft;
  const [lastQuestion, setLastQuestion] = useState("");
  const [answer, setAnswer] = useState<BuckyAnswer | null>(null);
  // Single conversation thread: user + Bucky messages in order. Action
  // previews stay as live cards below the thread (Confirm/Cancel intact).
  const [thread, setThread] = useState<{ id: number; role: "user" | "bucky"; text: string; profileId?: string; profileName?: string; facts: { label: string; value: string }[]; proposalIds: string[] }[]>([]);
  const msgIdRef = useRef(0);
  const conversationScroll = useRef<HTMLDivElement>(null);
  function pushMsg(role: "user" | "bucky", text: string, facts: { label: string; value: string }[] = [], proposalIds: string[] = []) {
    const id = ++msgIdRef.current;
    setThread((prev) => [...prev.slice(-39), { id, role, text, facts, proposalIds, profileId: profile?.id, profileName: profile?.name }]);
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
  // Runtime only: never persisted, logged, or pre-filled.
  const [liveToken, setLiveToken] = useState("");
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
  // tap (stopRequested) ends into the review step; an unexpected end may
  // restart a bounded number of times; an error or Cancel never restarts
  // and never auto-executes a partial transcript.
  const recognitionStopRequestedRef = useRef(false);
  const recognitionErrorRef = useRef("");
  const recognitionRestartsRef = useRef(0);
  const [pendingTranscript, setPendingTranscript] = useState("");
  const finalTranscriptRef = useRef("");
  // Trailing-silence auto-finish: every recognition result (interim or
  // final) stamps lastResultAtRef and (re)arms the timer; ~3s without a
  // result stops listening into the review step. Done stays available.
  const silenceTimerRef = useRef<number | null>(null);
  const lastResultAtRef = useRef(0);
  // One-shot mascot reaction clip (existing GLB clips only), shown for a
  // couple of seconds after a confirmed save / a failed save, then the
  // animation prop clears and Bucky returns to Idle.

  const utteranceIdRef = useRef(0);
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

  // Follow the dashboard's focused profile until the user picks another.
  useEffect(() => {
    if (preferredProfileId && profiles.some((p) => p.id === preferredProfileId)) {
      setInteractionPhase("idle");
      setSelectedProfileId(preferredProfileId);
    }
  }, [preferredProfileId, profiles]);

  const profile =
    profiles.find((p) => p.id === selectedProfileId) ??
    profiles.find((p) => p.kind === "personal") ??
    profiles[0];

  useEffect(() => {
    if(!active)return;
    const phase:BuckyPhase=voicePhase==='listening'?'listening':voicePhase==='speaking'?'speaking':actionBusy||productBusy||interpretBusy||voicePhase==='processing'||speechPending||micPending?'processing':interactionPhase==='error'?'error':pendingAction||pendingProduct?'review':interactionPhase;
    const labels:Record<BuckyPhase,string>={idle:'',listening:'Listening',speaking:'Speaking',processing:micPending?'Starting microphone':speechPending?'Preparing spoken response':'Working',review:'Awaiting confirmation',success:'Saved',error:'',cancelled:'Cancelled',warning:''};
    setBuckyPhase(phase,labels[phase],profile?.id);
  },[active,voicePhase,actionBusy,productBusy,interpretBusy,speechPending,micPending,pendingAction,pendingProduct,interactionPhase,profile?.id]);

  useEffect(() => {
    const action=pendingAction??pendingProduct;if(!action)return;
    recordBuckyEvent({id:action.id,status:'awaiting',title:pendingAction?buckyActionTitle(pendingAction):'Add product',detail:pendingAction?.description??pendingProduct?.name??'',profileId:action.profileId,profileName:action.profileName,currency:action.currency});
  },[pendingAction,pendingProduct]);

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

  function speakText(text: string) {
    if (!ttsSupported || !text.trim() || recognitionRef.current !== null) return;
    // Never overlap: a new utterance always replaces any current speech.
    const id = ++utteranceIdRef.current;
    window.speechSynthesis.cancel();
    setVoicePhase(p=>p==="speaking"?voiceTransition(p,"stop"):p);
    setSpeechPending(true);
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "en-US";
    if (buckyVoiceRef.current) utterance.voice = buckyVoiceRef.current;
    const settings = voiceSettingsRef.current;
    const tuning = buckyUtteranceTuning(settings);
    utterance.volume = settings.volume;
    utterance.rate = tuning.rate;
    utterance.pitch = tuning.pitch;
    utterance.onstart = () => {
      if (utteranceIdRef.current !== id) return;
      setSpeechPending(false);
      setVoicePhase((p) => voiceTransition(p, "speak"));
    };
    utterance.onend = () => {
      if (utteranceIdRef.current === id) setSpeechPending(false);
      if (utteranceIdRef.current === id) setVoicePhase((p) => voiceTransition(p, "end"));
    };
    utterance.onerror = () => {
      if (utteranceIdRef.current === id) {setSpeechPending(false);setInteractionPhase("error");setVoiceError("Spoken playback was unavailable. Your answer is still on screen.");}
      if (utteranceIdRef.current === id) setVoicePhase((p) => voiceTransition(p, "end"));
    };
    try {window.speechSynthesis.speak(utterance);} catch {setSpeechPending(false);setVoiceError("Spoken playback was unavailable. Your answer is still on screen.");}
  }

  function stopSpeaking() {
    setSpeechPending(false);
    utteranceIdRef.current += 1;
    if (ttsSupported) window.speechSynthesis.cancel();
    setVoicePhase((p) => (p === "speaking" ? voiceTransition(p, "stop") : p));
  }

  // Hosts (e.g. the app-wide dock) protect unsaved previews from dismissal.
  useEffect(() => {
    onPendingActionChange?.(pendingAction !== null || pendingProduct !== null);
  }, [pendingAction, pendingProduct, onPendingActionChange]);

  function ask(text: string, viaVoice = false) {
    const q = text.trim();
    if (!q || !analysis || !profile) return;
    if(micPending){setVoiceError("Cancel microphone startup before sending a typed request.");return;}
    if (pendingAction || pendingProduct || actionBusy || productBusy || interpretBusy) {
      setActionError("Confirm or cancel the current preview before sending another request.");
      return;
    }
    // The input is cleared once a request is successfully processed into
    // a preview or an answer; it is preserved verbatim whenever Bucky asks
    // a clarification or declines, so the user can edit and resend it.
    setInteractionPhase("idle");
    setActionError("");setProductError("");
    setLastQuestion(q);
    pushMsg("user", q);
    setAiInterpretText("");
    setInterpretNote("");

    // Add Product first when the command explicitly asks for it: one
    // deterministic business operation with its own preview. It must run
    // before the transaction interpreter, which would otherwise ask
    // "income or expense?" about the price.
    const productInterpretation = interpretBuckyProductCommand(q, {
      profile,
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
      setQuestion("");
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
      else if (viaVoice) setVoicePhase((p) => voiceTransition(p, "reset"));
      return;
    }

    // Bookkeeping actions first: one deterministic pipeline shared by
    // typed and spoken requests. A proposal is only a preview — saving
    // always needs the explicit Confirm button below.
    const interpretation = interpretBuckyAction(q, {
      profile,
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
      setQuestion("");
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
    if (interpretation.status === "unsupported" || detectUnsupportedAction(q)) {
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
      else setVoicePhase((p) => voiceTransition(p, "reset"));
      return;
    }
    const next = answerBuckyQuestion(q, analysis);
    setAnswer(next);
    if(next.insufficientData){setInteractionPhase("error");recordBuckyEvent({id:"question:"+profile.id+":"+msgIdRef.current,status:"unsupported",title:q.length>70?q.slice(0,67)+"…":q,detail:"No changes were made. See Bucky’s response above.",profileId:profile.id,profileName:profile.name});}
    setQuestion("");
    // The built-in interpreter couldn't make a record of this, but it
    // reads like one: offer explicit AI interpretation (Phase D). The
    // deterministic answer above stands either way.
    if (looksLikeActionAttempt(q)) setAiInterpretText(q);
    if (viaVoice && voiceResponsesOnRef.current) {
      speakText(prepareSpeechText(next.answer, next.facts));
    } else if (viaVoice) {
      setVoicePhase((p) => voiceTransition(p, "reset"));
    }
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
    if (!aiInterpretText || !profile || interpretBusy) return;
    setInterpretBusy(true);
    setInterpretNote("");
    try {
      const res = await requestBuckyInterpret(
        aiInterpretText,
        {
          profileName: profile.name,
          profileKind: profile.kind,
          currency: profile.currency,
          bucketNames: buckets
            .filter((b) => b.profileId === profile.id && b.kind === "savings")
            .map((b) => b.name),
          employeeNames: employees
            .filter((e) => e.profileId === profile.id)
            .map((e) => e.name),
        },
        { liveTestToken: liveToken },
      );
      if (!res.proposal) {
        setInterpretNote("The AI couldn't turn that into a record either. Try rewording it or use the normal record form. Nothing was saved.");
        return;
      }
      const checked = buildActionFromModelProposal(aiInterpretText, res.proposal, {
        profile,
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
          profile, buckets, transactions: merged, products, sales, employees,
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
          { label: "Opening stock", value: "0" },
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
    setQuestion(heard);
    setInterimTranscript("");
    setVoicePhase((p) => voiceTransition(p, "heard"));
    ask(heard, true);
  }

  /**
   * Review step, kept only for partial transcripts after a recognition
   * error: they may be incomplete, so they are never auto-processed.
   * The text lands in the command input to read/edit, and only an
   * explicit Run this transcript processes it.
   */
  function offerTranscriptForReview(heard: string) {
    setPendingTranscript(heard);
    setQuestion(heard);
    setInterimTranscript("");
    // Direct set (not a transition): after a recognition error the phase
    // may be "error"/"denied", and a partial transcript must still land
    // in review — never in processing.
    setVoicePhase("review");
  }

  /** Settle a finished session: auto-process only a clean transcript. */
  function settleTranscript(heard: string) {
    if (
      shouldAutoProcessTranscript({
        heard,
        errorCode: recognitionErrorRef.current,
        cancelled: recognitionCancelledRef.current,
      })
    ) {
      processTranscriptAutomatically(heard);
    } else {
      offerTranscriptForReview(heard);
    }
  }

  function startListening() {
    if(micPending){cancelListening();return;}
    if (pendingAction || pendingProduct || actionBusy || productBusy || interpretBusy) {
      setVoiceError("Confirm or cancel the current preview before starting another request.");
      return;
    }
    if (voicePhase === "listening") {
      finishListening();
      return;
    }
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
      // ends listening into review after ~3 quiet seconds.
      if (finalText || interimText) {
        lastResultAtRef.current = Date.now();
        scheduleSilenceTimer();
      }
      if (finalText) {
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
      // final state. A partial transcript is offered for review, never
      // executed automatically.
      setMicPending(false);setInteractionPhase("error");
      recognitionErrorRef.current = event.error;
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
            // through to the review step with whatever was heard.
          }
        }
      }
      // Settling (no restart): the silence timer's job is done.
      clearSilenceTimer();
      recognitionRef.current = null;
      finalTranscriptRef.current = "";
      if (heard) {
        settleTranscript(heard);
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
      setVoicePhase("error");
      setMicPending(false);setInteractionPhase("error");
      setVoiceError("Speech recognition couldn't start. Type your question instead.");
    }
  }

  /**
   * Intentional completion: stop() (not abort()) so the browser flushes
   * any queued final results before onend moves them into review.
   */
  function finishListening() {
    clearSilenceTimer();
    recognitionStopRequestedRef.current = true;
    try {
      recognitionRef.current?.stop();
    } catch {
      // Recognition already ended; onend will not fire again, so settle
      // into review/idle here with whatever was accumulated.
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

  /** Explicitly run the reviewed transcript through the normal pipeline. */
  function useReviewedTranscript() {
    const text = question.trim();
    if (!text) return;
    setPendingTranscript("");
    setVoicePhase((p) => voiceTransition(p, "heard"));
    ask(text, true);
  }

  function discardReviewedTranscript() {
    setPendingTranscript("");
    setQuestion("");
    setVoiceError("");
    setVoicePhase((p) => voiceTransition(p, "reset"));
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
    if (pendingAction || pendingProduct) { setVoiceError("Confirm or cancel the preview before retrying."); return; }
    if (question === pendingTranscript) setQuestion("");
    setPendingTranscript("");
    setVoiceError("");
    startListening();
  }

  useEffect(() => {
    if (!active) return;
    const region = conversationScroll.current; if (!region) return;
    const newest = () => { region.scrollTop = region.scrollHeight; };
    const frame = requestAnimationFrame(newest);
    const observer = new ResizeObserver(newest); observer.observe(region);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [active, thread.length, pendingAction, pendingProduct]);

  useEffect(() => {
    if (pendingTranscript && question.trim() === pendingTranscript.trim()) setQuestion("");
    cancelListening(); stopSpeaking(); setPendingTranscript(''); setInterimTranscript(''); setVoiceError(''); setVoicePhase('idle');
  }, [navigationKey]);

  const consumedRequest = useRef('');
  useEffect(() => {
    if (!active) { cancelListening(); stopSpeaking(); setPendingTranscript(""); setInterimTranscript(""); setVoiceError(""); setVoicePhase("idle"); }
  }, [active]);
  useEffect(() => {
    if (!active || !conversationRequest || consumedRequest.current === conversationRequest.id || !analysis) return;
    if (pendingAction || pendingProduct) return;
    if (conversationRequest.profileId && profile?.id !== conversationRequest.profileId) {
      if (profiles.some(p => p.id === conversationRequest.profileId)) { setInteractionPhase("idle"); setSelectedProfileId(conversationRequest.profileId); return; }
      consumedRequest.current = conversationRequest.id;
      setActionError("The selected profile is no longer available. Choose a profile before asking again.");
      return;
    }
    consumedRequest.current = conversationRequest.id;
    if (conversationRequest.question) { setQuestion(conversationRequest.question); ask(conversationRequest.question); }
  }, [active, conversationRequest, analysis, profile, pendingAction, pendingProduct, profiles]);

  // Leaving the panel always silences Bucky: no orphan mic or speech.
  useEffect(
    () => () => {
      clearSilenceTimer();

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
    <section className="panel bucky-panel" aria-label="Bucky conversation">
      {!compact && <div className="bucky-chat-head">
        <BuckyMascot talking={voicePhase === "speaking"} animation={voicePhase === "listening" ? "Listening" : voicePhase === "processing" ? "Thinking" : interactionPhase === "success" ? "Emotion_Happy" : interactionPhase === "error" ? "Emotion_Concerned" : undefined} label="Bucky, your financial intelligence companion" />
        <div>
          <h2 id="bucky-panel-heading">Bucky Financial Intelligence</h2>
        </div>
      </div>}
      <div className="bucky-interactions">
      {profiles.length === 0 ? (
        <div className="empty-state">
          <p className="muted">Create a profile to unlock insights from your saved records.</p>
          <div className="row-actions">
            <a className="btn ghost small" href="#/personal">Set up a profile</a>
          </div>
        </div>
      ) : result?.error ? (
        <p className="alert-error" role="alert">{result.error}</p>
      ) : analysis ? (
        <>
          <div className="bucky-scroll-region" ref={conversationScroll}>
          {profiles.length > 1 && (
            <div className="selector-main bucky-profile-row">
              <label htmlFor="bucky-profile">Analysing</label>
              <select
                id="bucky-profile"
                className="input selector-select"
                disabled={micPending || pendingAction !== null || pendingProduct !== null || actionBusy || productBusy || voicePhase === "listening" || voicePhase === "processing"}
                value={profile?.id ?? ""}
                onChange={(e) => {
                  setInteractionPhase("idle");
                  setSelectedProfileId(e.target.value);
                  setAnswer(null);
                  lastAnswerRef.current = null;

                  setPendingAction(null);
                  setPendingProduct(null);
                  setProductError("");
                  setSavedResult(null);
                  setActionError("");
                }}
              >
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.kind === "business" ? "Business" : "Personal"})
                  </option>
                ))}
              </select>
            </div>
          )}



          {!analysis.hasAnyData ? (
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
                  ? analysis.proposals.find((p) => p.id === insight.proposalId)
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
          )}



          {thread.length > 0 && (
            <div className="bucky-thread" aria-live="polite" aria-label="Conversation with Bucky">
              {thread.map((msg) => (
                <div key={msg.id} className={msg.role === "user" ? "bucky-msg bucky-msg--user" : "bucky-msg bucky-msg--bucky"}>
                  {msg.profileName && <small className="bucky-message-context">{msg.profileName}</small>}
                  <p>{msg.profileName ? msg.text.replace("All-time recorded totals for "+msg.profileName+".", "All-time totals.") : msg.text}</p>
                  {msg.facts.length > 0 && (
                    <dl className="bucky-evidence">
                      {msg.facts.map((f) => (
                        <div key={`${f.label}-${f.value}`}><dt>{f.label}</dt><dd>{f.value}</dd></div>
                      ))}
                    </dl>
                  )}
                  {msg.proposalIds.map((id) => {
                    const proposal = analysis.proposals.find((p) => p.id === id);
                    return proposal && (!msg.profileId || msg.profileId === profile?.id) ? (
                      <button key={id} className="btn ghost small" type="button" onClick={() => { if (proposal.action.type === "scan" && onScanRequest) { onScanRequest(); return; } if (onNavigateAway && !onNavigateAway()) return; goToProposal(proposal); }}>
                        {proposal.action.label}
                      </button>
                    ) : null;
                  })}
                  {msg.role === "bucky" && ttsSupported && msg.id === thread[thread.length - 1]?.id && (
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
              <div className="field">
                <label htmlFor="bucky-live-token">Live test token (not saved)</label>
                <input id="bucky-live-token" className="input" type="password" value={liveToken} onChange={(e) => setLiveToken(e.target.value)} autoComplete="off" placeholder="Token from the local server operator" />
              </div>
              <div className="row-actions">
                <button className="btn ghost small" type="button" onClick={() => void tryAiInterpret()} disabled={interpretBusy || !liveToken.trim()}>
                  {interpretBusy ? "Interpreting…" : "Try AI interpretation (uses 1 live request)"}
                </button>
                {!liveToken.trim() && <span className="muted">Add a token to try AI interpretation. The suggestion is still checked and previewed before anything is saved.</span>}
              </div>
              {interpretNote && <p className="muted" role="status">{interpretNote}</p>}
            </div>
          )}

          {presentation.events.some(event=>event.profileId===profile?.id && event.status!=='awaiting' && event.status!=='saving') && <details className="bucky-action-journal" open><summary>Recent actions</summary><ol>{presentation.events.filter(event=>event.profileId===profile?.id && event.status!=='awaiting' && event.status!=='saving').slice(-3).map(event=><li key={event.id}><span className={'bucky-event-status bucky-event-status--'+event.status}>{ACTION_STATUS_LABELS[event.status]}</span><strong>{event.title}</strong><p>{event.detail}</p></li>)}</ol></details>}
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
                <div><dt>Opening stock</dt><dd>0</dd></div>
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



            {interimTranscript && voicePhase === "listening" && (
              <p className="bucky-voice-interim" role="status">Heard: {interimTranscript}…</p>
            )}
            {pendingTranscript && voicePhase === "review" && (
              <div className="bucky-voice-review">
                <p role="status"><strong>Bucky heard:</strong> “{pendingTranscript}”</p>
                <p className="muted">Speech stopped early, so this wasn't run automatically. Edit it in the command box above if anything is wrong — nothing runs until you press Run.</p>
                <div className="row-actions">
                  <button className="btn small" type="button" onClick={useReviewedTranscript} disabled={!question.trim()}>
                    Run this transcript
                  </button>
                  <button className="btn ghost small" type="button" onClick={discardReviewedTranscript}>
                    Discard
                  </button>
                </div>
              </div>
            )}
            {pendingTranscript && voicePhase !== "review" && voicePhase !== "listening" && (
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
            {voiceError && <p className="alert-error" role="alert">{voiceError}</p>}
            {!recognitionSupported && (
              <p className="muted bucky-voice-note">Voice input isn't supported in this browser — typing works as usual.</p>
            )}

          </div>
          <form
            className="bucky-ask"
            onSubmit={(e) => {
              e.preventDefault();
              ask(question);
            }}
          >
            <label htmlFor="bucky-question">Ask Bucky about {analysis.profileName}</label>
            <div className="bucky-ask-row">
              <input
                id="bucky-question"
                className="input"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="Ask about your finances…"
                autoComplete="off"
              />
              <button className="btn" type="submit" disabled={!question.trim() || micPending || pendingAction !== null || pendingProduct !== null || actionBusy || productBusy || interpretBusy || voicePhase === "listening" || voicePhase === "processing"}>Send</button>
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
              {voicePhase === "review" && (
                <span className="bucky-voice-status" role="status">Speech stopped early — check the text below before running it.</span>
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
      ) : null}
      </div>
    </section>
  );
}

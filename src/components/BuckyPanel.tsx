import { useEffect, useMemo, useRef, useState } from "react";
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
  buildBuckyModelSummary,
  type BuckyAnswer,
  type BuckyProposal,
} from "../lib/buckyAgent.ts";
import {
  BuckyApiError,
  requestBuckyAdvice,
  requestBuckyInterpret,
  type BuckyAdviceResponse,
} from "../lib/buckyApi.ts";
import {
  appendFinalTranscript,
  canRestartRecognition,
  detectUnsupportedAction,
  getSpeechRecognitionCtor,
  isSpeechRecognitionSupported,
  isSpeechSynthesisSupported,
  prepareSpeechText,
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

const QUESTIONS = [
  "Give me a cash flow overview",
  "Record ₱500 expense for groceries",
  "Add ₱1,000 to my iPhone savings goal",
]; // Fewer, representative suggestions; full help lives in Settings/insights.

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
export default function BuckyPanel({ profiles, buckets, transactions, products, sales, employees = [], preferredProfileId, onRecordsChanged, onPendingActionChange, onNavigateAway, onScanRequest }: Props) {
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [question, setQuestion] = useState("");
  const [lastQuestion, setLastQuestion] = useState("");
  const [answer, setAnswer] = useState<BuckyAnswer | null>(null);
  const [advisor, setAdvisor] = useState<BuckyAdviceResponse | null>(null);
  const [advisorBusy, setAdvisorBusy] = useState(false);
  const [advisorError, setAdvisorError] = useState("");
  const [useLiveMeta, setUseLiveMeta] = useState(false);
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
  const [mascotReaction, setMascotReaction] = useState<string | null>(null);
  const mascotReactionTimerRef = useRef<number | null>(null);
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
      setSelectedProfileId(preferredProfileId);
    }
  }, [preferredProfileId, profiles]);

  const profile =
    profiles.find((p) => p.id === selectedProfileId) ??
    profiles.find((p) => p.kind === "personal") ??
    profiles[0];

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

  function speakText(text: string) {
    if (!ttsSupported || !text.trim()) return;
    // Never overlap: a new utterance always replaces any current speech.
    window.speechSynthesis.cancel();
    const id = ++utteranceIdRef.current;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "en-US";
    // Use the most natural already-installed voice instead of the OS
    // default (often the most robotic). Built-in voices only — no
    // external speech service. When the voice list is still loading or
    // has no English voice, leave unset for the browser default.
    try {
      const preferred = pickPreferredVoice(window.speechSynthesis.getVoices());
      if (preferred) {
        const match = window.speechSynthesis
          .getVoices()
          .find((v) => v.name === preferred.name && v.lang === preferred.lang);
        if (match) utterance.voice = match;
      }
    } catch {
      // Voice enumeration is best-effort; speech still works without it.
    }
    const settings = voiceSettingsRef.current;
    utterance.volume = settings.volume;
    utterance.rate = settings.rate;
    utterance.pitch = settings.pitch;
    utterance.onend = () => {
      if (utteranceIdRef.current === id) setVoicePhase((p) => voiceTransition(p, "end"));
    };
    utterance.onerror = () => {
      if (utteranceIdRef.current === id) setVoicePhase((p) => voiceTransition(p, "end"));
    };
    setVoicePhase((p) => voiceTransition(p, "speak"));
    window.speechSynthesis.speak(utterance);
  }

  function stopSpeaking() {
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
    // The input is cleared once a request is successfully processed into
    // a preview or an answer; it is preserved verbatim whenever Bucky asks
    // a clarification or declines, so the user can edit and resend it.
    setLastQuestion(q);
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
      if (viaVoice && voiceResponsesOnRef.current) speakText(prepareSpeechText(unsupported.answer));
      else setVoicePhase((p) => voiceTransition(p, "reset"));
      return;
    }
    const next = answerBuckyQuestion(q, analysis);
    setAnswer(next);
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
        setInterpretNote("The AI couldn't turn that into a record either. Try rewording it, or use a “Try a command” example. Nothing was saved.");
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
      reactMascot("Emotion_Concerned");
      setActionError(
        error instanceof Error
          ? `${error.message} Nothing was saved.`
          : "The record could not be saved. Nothing was saved.",
      );
    } finally {
      setActionBusy(false);
    }
  }

  function cancelPendingProduct() {
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
    setProductBusy(true);
    setProductError("");
    try {
      const product = buildBuckyProduct(pendingProduct, nowIso());
      const conflict = findSkuConflict(effectiveProducts, product.profileId, product.sku);
      if (conflict) {
        setProductError(`SKU “${product.sku}” is already used by “${conflict.name}” in this business. Nothing was created.`);
        return;
      }
      validateProduct(product);
      await productsRepo.create(product);
      executedProductIdsRef.current.add(pendingProduct.id);
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
      reactMascot("Emotion_Concerned");
      setProductError(
        error instanceof Error
          ? `${error.message} Nothing was created.`
          : "The product could not be created. Nothing was created.",
      );
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

  /** Show an existing GLB reaction clip briefly, then back to Idle. */
  function reactMascot(clip: string) {
    setMascotReaction(clip);
    if (mascotReactionTimerRef.current !== null) window.clearTimeout(mascotReactionTimerRef.current);
    mascotReactionTimerRef.current = window.setTimeout(() => {
      mascotReactionTimerRef.current = null;
      setMascotReaction(null);
    }, 2200);
  }

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
    if (voicePhase === "listening") {
      finishListening();
      return;
    }
    setVoiceError("");
    setInterimTranscript("");
    setPendingTranscript("");
    if (!recognitionSupported) {
      setVoicePhase("unsupported");
      setVoiceError("Voice input isn't supported in this browser. Typing works as usual.");
      return;
    }
    stopSpeaking();
    const Ctor = getSpeechRecognitionCtor(window);
    if (!Ctor) {
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
    recognition.lang = "en-US";
    recognition.interimResults = true;
    // Continuous mode keeps listening through natural pauses so longer
    // commands are not cut off at the first sentence break. The browser
    // may still end the session on its own; onend below handles that.
    recognition.continuous = true;
    recognition.maxAlternatives = 1;
    recognition.onresult = (event) => {
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
      clearSilenceTimer();
      // Record the failure; onend (which always follows) decides the
      // final state. A partial transcript is offered for review, never
      // executed automatically.
      recognitionErrorRef.current = event.error;
      const mapped = speechRecognitionErrorMessage(event.error);
      setVoicePhase(mapped.phase);
      setVoiceError(mapped.message);
    };
    recognition.onend = () => {
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
    setVoicePhase((p) => voiceTransition(p, "start"));
    try {
      recognition.start();
    } catch {
      setVoicePhase("error");
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
    setQuestion(pendingTranscript);
    setVoicePhase((p) => voiceTransition(p, "reset"));
    document.getElementById("bucky-question")?.focus();
  }

  /** Throw the transcript away and listen again from scratch. */
  function retryListening() {
    setPendingTranscript("");
    setVoiceError("");
    startListening();
  }

  // Leaving the panel always silences Bucky: no orphan mic or speech.
  useEffect(
    () => () => {
      clearSilenceTimer();
      if (mascotReactionTimerRef.current !== null) window.clearTimeout(mascotReactionTimerRef.current);
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

  async function askAdvisor() {
    // The command input clears after each run, so AI Insights works from
    // the last command the user ran (or whatever is currently typed).
    const q = (question.trim() || lastQuestion).trim();
    if (!q || !analysis || advisorBusy) return;
    setAdvisorBusy(true);
    setAdvisorError("");
    setAdvisor(null);
    try {
      // Only aggregated totals/counts leave the browser — never raw records.
      const summary = buildBuckyModelSummary(analysis);
      const res = await requestBuckyAdvice(q, summary, {
        mode: useLiveMeta ? "live" : "fallback",
        liveTestToken: useLiveMeta ? liveToken : undefined,
      });
      setAdvisor(res);
    } catch (error) {
      setAdvisorError(
        error instanceof BuckyApiError
          ? error.message
          : "The AI Insights request could not be completed. Your calculated answer above still applies.",
      );
    } finally {
      setAdvisorBusy(false);
    }
  }

  return (
    <section className="panel bucky-panel" aria-labelledby="bucky-panel-heading">
      <div className="bucky-panel-head">
        <div>
          <h2 id="bucky-panel-heading">Bucky Financial Intelligence</h2>
          <p className="muted">
            Insights from your saved records
          </p>
        </div>
      </div>

      <div className="bucky-hero"><BuckyMascot talking={voicePhase === "speaking" || advisorBusy} animation={voicePhase === "listening" ? "Listening" : voicePhase === "processing" || advisorBusy ? "Thinking" : mascotReaction ?? undefined} label="Bucky, your financial intelligence companion" /></div>
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
          {profiles.length > 1 && (
            <div className="selector-main bucky-profile-row">
              <label htmlFor="bucky-profile">Analysing</label>
              <select
                id="bucky-profile"
                className="input selector-select"
                value={profile?.id ?? ""}
                onChange={(e) => {
                  setSelectedProfileId(e.target.value);
                  setAnswer(null);
                  setAdvisor(null);
                  setAdvisorError("");
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
                placeholder="Ask, or say: Record ₱500 expense for groceries…"
                autoComplete="off"
              />
              <button className="btn" type="submit" disabled={!question.trim()}>Send</button>
              <button
                className={voicePhase === "listening" ? "btn bucky-mic-btn is-listening" : "btn ghost bucky-mic-btn"}
                type="button"
                onClick={startListening}
                aria-pressed={voicePhase === "listening"}
                aria-label={voicePhase === "listening" ? "Done listening" : "Speak to Bucky"}
                title={recognitionSupported ? (voicePhase === "listening" ? "Done — Bucky will take it from there; nothing is saved without your confirmation" : "Speak instead of typing") : "Voice input isn't supported in this browser"}
              >
                <Icon name="mic" />{voicePhase === "listening" ? "Done" : "Speak"}
              </button>
              <button className="btn ghost" type="button" onClick={() => (onScanRequest ? onScanRequest() : goToRoute("scanner"))}>
                <Icon name="scanner" />Scan record
              </button>
            </div>
            <div className="bucky-voice-controls">
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
                <Icon name={voiceResponsesOn ? "speaker" : "speakerMute"} />{voiceResponsesOn ? "Voice on" : "Voice off"}
              </button>
              {voicePhase === "listening" && (
                <>
                  <button className="btn ghost small" type="button" onClick={finishListening}>
                    <Icon name="stop" />Done
                  </button>
                  <button className="btn ghost small" type="button" onClick={cancelListening}>
                    <Icon name="close" />Cancel
                  </button>
                </>
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
                onClick={(event) => {
                  // Inside the floating dialog the host must close first;
                  // it vetoes navigation while a preview is unsaved.
                  if (onNavigateAway && !onNavigateAway()) event.preventDefault();
                }}
              >
                Voice settings
              </a>
            </div>
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
                  <button className="btn ghost small" type="button" onClick={correctTranscript}>
                    Correct
                  </button>
                  <button className="btn ghost small" type="button" onClick={retryListening}>
                    Retry
                  </button>
                  <button className="btn ghost small" type="button" onClick={() => setPendingTranscript("")}>
                    Dismiss
                  </button>
                </div>
              </div>
            )}
            {voiceError && <p className="alert-error" role="alert">{voiceError}</p>}
            {!recognitionSupported && (
              <p className="muted bucky-voice-note">Voice input isn't supported in this browser — typing works as usual.</p>
            )}
            {!answer && !pendingAction && !pendingProduct && (
              <>
                <p className="bucky-suggestions-label">Try a command</p>
                <div className="bucky-chips" role="group" aria-label="Suggested commands">
                  {QUESTIONS.map((q) => (
                    <button key={q} className="btn ghost small" type="button" onClick={() => ask(q)}>
                      {q}
                    </button>
                  ))}
                </div>
              </>
            )}
          </form>

          {!analysis.hasAnyData ? (
            <div className="empty-state">
              <p>No records to analyse for {analysis.profileName} yet.</p>
              <p className="muted">
                Add your first record to see insights here.
              </p>
            </div>
          ) : (
            <details className="bucky-insight-details"><summary>Insights <span className="count-badge">{analysis.insights.length}</span></summary><ul className="bucky-insights">
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
                      <button className="btn ghost small" type="button" onClick={() => goToProposal(proposal)}>
                        {proposal.action.label}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul></details>
          )}



          {answer && (
            <div className="bucky-answer" role="status">
              <p>{answer.answer}</p>
              {ttsSupported && (
                <div className="row-actions">
                  <button className="btn ghost small" type="button" onClick={() => speakText(prepareSpeechText(answer.answer, answer.facts))}>
                    <Icon name="speaker" />Listen
                  </button>
                  {voicePhase === "speaking" && (
                    <button className="btn ghost small" type="button" onClick={stopSpeaking}>
                      <Icon name="stop" />Stop
                    </button>
                  )}
                </div>
              )}
              {answer.facts.length > 0 && (
                <dl className="bucky-evidence">
                  {answer.facts.map((f) => (
                    <div key={`${f.label}-${f.value}`}>
                      <dt>{f.label}</dt>
                      <dd>{f.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {answer.proposalIds.map((id) => {
                const proposal = analysis.proposals.find((p) => p.id === id);
                return proposal ? (
                  <button key={id} className="btn ghost small" type="button" onClick={() => goToProposal(proposal)}>
                    {proposal.action.label}
                  </button>
                ) : null;
              })}
            </div>
          )}

          {aiInterpretText && !pendingAction && (
            <div className="bucky-interpret-note">
              <p className="muted">
                The built-in interpreter couldn't turn “{aiInterpretText}” into a record, and nothing was saved.
              </p>
              {useLiveMeta ? (
                <div className="row-actions">
                  <button
                    className="btn ghost small"
                    type="button"
                    onClick={() => void tryAiInterpret()}
                    disabled={interpretBusy || !liveToken.trim()}
                  >
                    {interpretBusy ? "Interpreting…" : "Try AI interpretation (uses 1 live request)"}
                  </button>
                  {!liveToken.trim() && (
                    <span className="muted">Add your live test token under Ask AI first.</span>
                  )}
                </div>
              ) : (
                <p className="muted">
                  If you enable live AI under “Ask AI” below, Bucky can try interpreting it — the
                  suggestion is still checked against your words and records, then previewed for your
                  confirmation before anything is saved.
                </p>
              )}
              {interpretNote && <p className="muted" role="status">{interpretNote}</p>}
            </div>
          )}

          {pendingAction && (
            <div className="bucky-action-preview" role="region" aria-label="Review this action before saving">
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

          {savedResult && !pendingAction && !pendingProduct && (
            <div className="bucky-answer bucky-action-saved" role="status">
              <p><strong>Saved.</strong> {savedResult.message}</p>
              {savedResult.facts.length > 0 && (
                <dl className="bucky-evidence">
                  {savedResult.facts.map((f) => (
                    <div key={`${f.label}-${f.value}`}>
                      <dt>{f.label}</dt>
                      <dd>{f.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
              <p className="muted">Updated figures are calculated from your saved records. Net cash flow is not profit.</p>
            </div>
          )}

          <details className="bucky-advisor">
            <summary>Ask AI <span className="count-badge">Optional</span></summary>
            <div className="bucky-advisor-body">
            <p className="muted">
              Uses only aggregated totals for {analysis.profileName}, never individual records. A live AI answer requires an enabled service and a runtime token. Otherwise, insights are calculated locally and clearly labelled.
            </p>
            <label className="bucky-live-toggle">
              <input
                type="checkbox"
                checked={useLiveMeta}
                onChange={(e) => setUseLiveMeta(e.target.checked)}
              />
              Request a live AI answer
            </label>
            {useLiveMeta && (
              <div className="field">
                <label htmlFor="bucky-live-token">Live test token (not saved)</label>
                <input
                  id="bucky-live-token"
                  className="input"
                  type="password"
                  value={liveToken}
                  onChange={(e) => setLiveToken(e.target.value)}
                  autoComplete="off"
                  placeholder="Token from the local server operator"
                />
              </div>
            )}
            {lastQuestion && !question.trim() && (
              <p className="muted">Last command: “{lastQuestion}”</p>
            )}
            <div className="row-actions">
              <button
                className="btn"
                type="button"
                onClick={() => void askAdvisor()}
                disabled={advisorBusy || !(question.trim() || lastQuestion) || (useLiveMeta && !liveToken.trim())}
              >
                {advisorBusy ? "Thinking…" : "Ask AI"}
              </button>
            </div>
            {advisorBusy && <p className="muted" role="status">Working on it…</p>}
            {advisorError && <p className="alert-error" role="alert">{advisorError}</p>}
            {advisor && (
              <div className="bucky-answer" role="status">
                <p>
                  <span className="currency-badge">
                    {advisor.source === "meta-live"
                      ? "AI Insights · Live AI"
                      : "Calculated locally"}
                  </span>
                </p>
                <p>{advisor.answer}</p>
                {ttsSupported && (
                  <div className="row-actions">
                    <button className="btn ghost small" type="button" onClick={() => speakText(prepareSpeechText(advisor.answer, advisor.evidence))}>
                      <Icon name="speaker" />Listen
                    </button>
                    {voicePhase === "speaking" && (
                      <button className="btn ghost small" type="button" onClick={stopSpeaking}>
                        <Icon name="stop" />Stop
                      </button>
                    )}
                  </div>
                )}
                {advisor.diagnostic && (
                  <p className="muted">
                    Service status: {advisor.diagnostic.category}
                    {advisor.diagnostic.subReason ? ` / ${advisor.diagnostic.subReason}` : ""}
                    {advisor.diagnostic.upstreamStatus ? ` (HTTP ${advisor.diagnostic.upstreamStatus})` : ""}
                  </p>
                )}
                {advisor.model && (
                  <p className="muted">Diagnostics — model: {advisor.model}</p>
                )}
                <p className="muted">{advisor.explanation}</p>
                {advisor.evidence.length > 0 && (
                  <dl className="bucky-evidence">
                    {advisor.evidence.map((f) => (
                      <div key={`${f.label}-${f.value}`}>
                        <dt>{f.label}</dt>
                        <dd>{f.value}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                {advisor.suggestedActions.length > 0 && (
                  <div className="row-actions">
                    {advisor.suggestedActions.map((a) => (
                      <button key={a.id} className="btn ghost small" type="button" onClick={() => goToRoute(a.route)}>
                        {a.label}
                      </button>
                    ))}
                  </div>
                )}
                {advisor.limitations.length > 0 && (
                  <ul className="bucky-advisor-limitations">
                    {advisor.limitations.map((l) => (
                      <li key={l}>{l}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            </div>
          </details>

          <details className="bucky-limitations">
            <summary>How this is calculated</summary>
            <ul>
              {analysis.limitations.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </details>
        </>
      ) : null}
      </div>
    </section>
  );
}

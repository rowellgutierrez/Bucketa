import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { assertBarcode, normalizeBarcode } from "../data/validation.ts";
import { shouldAcceptPosScan, shouldAcceptScan } from "../lib/barcode.ts";
import Icon from "./ui/Icon";

interface DetectedBarcode { rawValue: string; format: string }
interface BarcodeDetectorLike { detect: (source: HTMLVideoElement) => Promise<DetectedBarcode[]> }
type BarcodeDetectorCtor = new (options?: { formats?: string[] }) => BarcodeDetectorLike;

function getDetectorCtor(): BarcodeDetectorCtor | null {
  if (typeof window === "undefined") return null;
  const ctor = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  return typeof ctor === "function" ? ctor : null;
}

type Phase = "starting" | "live" | "manual-only" | "error";

/**
 * Smart Scan barcode camera (P0). Opens only when the parent mounts it
 * from an explicit tap. Uses the browser's native BarcodeDetector where
 * available (no library, no paid service); everywhere else the manual
 * entry below is the supported path. Every track stops on close/unmount,
 * and camera detection stays latched after a result until Scan again
 * is explicitly selected. This component never writes
 * data — the parent decides what a code means.
 */
export default function BarcodeScanner({
  onDetected,
  onClose,
  hint = "Point the camera at a barcode, or type the code below.",
  continuous = false,
}: {
  onDetected: (code: string) => void;
  onClose: () => void;
  hint?: string;
  /** POS mode: keep scanning, auto-accept with cooldown dedupe, no latch. */
  continuous?: boolean;
}) {
  const [phase, setPhase] = useState<Phase>("starting");
  const [message, setMessage] = useState("");
  const [acceptedCode, setAcceptedCode] = useState("");
  const [manualCode, setManualCode] = useState("");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const detectorRef = useRef<BarcodeDetectorLike | null>(null);
  const lastScanRef = useRef<{ code: string; at: number } | null>(null);
  const generationRef = useRef(0);
  const detectingRef = useRef(false);
  const mountedRef = useRef(true);
  const onDetectedRef = useRef(onDetected);
  onDetectedRef.current = onDetected;

  const stopStream = useCallback(() => {
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) track.stop();
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const start = useCallback(async () => {
    const generation = ++generationRef.current;
    stopStream();
    setMessage("");
    const Ctor = getDetectorCtor();
    if (!Ctor) {
      setPhase("manual-only");
      setMessage("Camera barcode detection isn't supported in this browser. Type or paste the code below instead.");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setPhase("error");
      setMessage(
        !window.isSecureContext
          ? "The camera needs a secure connection (HTTPS or localhost). Type the code below instead."
          : "This browser doesn't support an in-app camera. Type the code below instead.",
      );
      return;
    }
    setPhase("starting");
    try {
      try {
        detectorRef.current = new Ctor({ formats: ["code_128", "ean_13", "ean_8", "upc_a"] });
      } catch {
        detectorRef.current = new Ctor();
      }
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      } catch (firstError) {
        const name = firstError instanceof DOMException ? firstError.name : "";
        if (name !== "NotFoundError" && name !== "OverconstrainedError") throw firstError;
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }
      if (!mountedRef.current || generation !== generationRef.current) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }
      if (mountedRef.current && generation === generationRef.current) setPhase("live");
    } catch (error) {
      if (!mountedRef.current || generation !== generationRef.current) return;
      stopStream();
      setPhase("error");
      const name = error instanceof DOMException ? error.name : "";
      setMessage(
        name === "NotAllowedError" || name === "SecurityError"
          ? "Camera permission was denied. Allow camera access, or type the code below."
          : name === "NotFoundError" || name === "OverconstrainedError"
            ? "No usable camera was found. Type the code below instead."
            : "The camera couldn't be started. Type the code below instead.",
      );
    }
  }, [stopStream]);

  useEffect(() => {
    mountedRef.current = true;
    void start();
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      stopStream();
    };
  }, [start, stopStream]);

  useEffect(() => {
    if (phase !== "live") return;
    const timer = window.setInterval(() => {
      const video = videoRef.current;
      const detector = detectorRef.current;
      if (!video || !detector || video.readyState < 2 || detectingRef.current || (!continuous && lastScanRef.current)) return;
      const generation = generationRef.current;
      detectingRef.current = true;
      void detector
        .detect(video)
        .then((codes) => {
          if (!mountedRef.current || generation !== generationRef.current) return;
          const code = normalizeBarcode(codes[0]?.rawValue);
          if (!code) return;
          try { assertBarcode(code); } catch { setMessage("Invalid barcode checksum or format. Use a valid code."); return; }
          const now = Date.now();
          const accepted = continuous ? shouldAcceptPosScan(lastScanRef.current, code, now) : shouldAcceptScan(lastScanRef.current, code, now);
          if (!accepted) return;
          lastScanRef.current = { code, at: now };
          setAcceptedCode(code);
          onDetectedRef.current(code);
          if (continuous) window.setTimeout(() => { if (mountedRef.current) setAcceptedCode(""); }, 1500);
        })
        .catch(() => undefined)
        .finally(() => { detectingRef.current = false; });
    }, 250);
    return () => window.clearInterval(timer);
  }, [phase, continuous]);

  function submitManual(event: FormEvent) {
    event.preventDefault();
    const code = normalizeBarcode(manualCode);
    if (!code) return;
    try { assertBarcode(code); } catch (error) { setMessage(error instanceof Error ? error.message : "Invalid barcode."); return; }
    lastScanRef.current = { code, at: Date.now() };
    setAcceptedCode(code);
    onDetectedRef.current(code);
    setManualCode("");
  }

  function close() {
    generationRef.current += 1;
    stopStream();
    onClose();
  }

  return (
    <section className="barcode-scanner" aria-label="Barcode scanner">
      {(phase === "starting" || phase === "live") && (
        <video ref={videoRef} className="barcode-scanner-preview" autoPlay playsInline muted aria-label="Live camera preview" />
      )}
      {phase === "starting" && <p role="status">Starting camera… allow camera access if your browser asks.</p>}
      {message && <p className={phase === "error" ? "alert-error" : "field-hint"} role={phase === "error" ? "alert" : "status"}>{message}</p>}
      {!message && <p className="field-hint">{hint}</p>}
      {acceptedCode && (continuous
        ? <div className="barcode-scan-status" role="status"><p>Scanned {acceptedCode} — keep scanning, or close when done.</p></div>
        : <div className="barcode-scan-status" role="status"><p>Detected {acceptedCode}. Tap Scan again before the next camera scan.</p><button className="btn" type="button" onClick={() => {lastScanRef.current = null; setAcceptedCode(''); setMessage('');}}>Scan again</button></div>)}
      <form className="barcode-manual" onSubmit={submitManual}>
        <div className="field">
          <label htmlFor="barcode-manual-input">Barcode</label>
          <input
            id="barcode-manual-input"
            className="input"
            value={manualCode}
            onChange={(e) => setManualCode(e.target.value)}
            placeholder="e.g. BKT-AAAA2345 or 4800123456789"
            autoComplete="off"
            autoCapitalize="characters"
          />
        </div>
        <button className="btn" type="submit" disabled={!manualCode.trim()}>Use code</button>
      </form>
      <div className="row-actions">
        {phase === "error" && (
          <button className="btn ghost" type="button" onClick={() => void start()}>
            <Icon name="scanner" />Try camera again
          </button>
        )}
        <button className="btn ghost" type="button" onClick={close}>Close scanner</button>
      </div>
    </section>
  );
}

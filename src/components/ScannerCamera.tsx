import { useCallback, useEffect, useRef, useState } from "react";
import Icon from "./ui/Icon";

type CameraPhase = "starting" | "live" | "captured" | "error";

/**
 * In-app camera for the Bucky Record Scanner (Phase B4).
 *
 * Opens only from an explicit user tap (the parent mounts this component
 * from the "Take photo" button). Requests video only — audio is never
 * requested. The captured frame becomes a plain JPEG File that the
 * parent feeds through the exact same preparation/validation pipeline
 * as an uploaded image; this component never uploads or saves anything.
 * Every media track is stopped on capture, cancel, retake, close, and
 * unmount, so the camera is never left running in the background.
 */
export default function ScannerCamera({
  onUsePhoto,
  onClose,
}: {
  /** Hand the captured photo to the scanner's existing image pipeline. */
  onUsePhoto: (file: File) => void;
  /** Close the camera UI (tracks are stopped before this is called). */
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<CameraPhase>("starting");
  const [errorMessage, setErrorMessage] = useState("");
  const [capturedUrl, setCapturedUrl] = useState("");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const capturedBlobRef = useRef<Blob | null>(null);
  const capturedUrlRef = useRef("");
  const mountedRef = useRef(true);

  const stopStream = useCallback(() => {
    const stream = streamRef.current;
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const discardCapture = useCallback(() => {
    capturedBlobRef.current = null;
    if (capturedUrlRef.current) URL.revokeObjectURL(capturedUrlRef.current);
    capturedUrlRef.current = "";
    setCapturedUrl("");
  }, []);

  const startStream = useCallback(async () => {
    setErrorMessage("");
    setPhase("starting");
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== "function"
    ) {
      setPhase("error");
      setErrorMessage(
        typeof window !== "undefined" && !window.isSecureContext
          ? "The in-app camera needs a secure connection (HTTPS or localhost) in this browser. Upload an image instead."
          : "This browser doesn't support an in-app camera. Upload an image instead.",
      );
      return;
    }
    let stream: MediaStream;
    try {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });
      } catch (firstError) {
        const firstName = firstError instanceof DOMException ? firstError.name : "";
        // No rear/environment camera (or no device at all, e.g. an
        // emulator): fall back once to any available camera, such as a
        // desktop webcam. Permission and busy errors are NOT retried —
        // they are mapped to their own messages below.
        if (firstName !== "NotFoundError" && firstName !== "OverconstrainedError") throw firstError;
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }
      if (!mountedRef.current) {
        // The component went away while permission was pending; never
        // leave a live camera behind.
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {
          // Autoplay of a muted, user-initiated preview is normally
          // allowed; if the browser still refuses, the frozen first
          // frame area simply stays dark and Cancel remains available.
        });
      }
      if (mountedRef.current) setPhase("live");
    } catch (error) {
      if (!mountedRef.current) return;
      setPhase("error");
      const name = error instanceof DOMException ? error.name : "";
      switch (name) {
        case "NotAllowedError":
        case "SecurityError":
          setErrorMessage(
            "Camera permission was denied. Allow camera access in your browser settings, or upload an image instead.",
          );
          break;
        case "NotFoundError":
        case "OverconstrainedError":
          setErrorMessage("No usable camera was found on this device. (Browser device emulation doesn't provide a real camera.) Upload an image instead.");
          break;
        case "NotReadableError":
        case "AbortError":
          setErrorMessage("The camera is unavailable or in use by another app. Close it and try again, or upload an image.");
          break;
        default:
          setErrorMessage("The camera couldn't be started. Upload an image instead.");
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void startStream();
    return () => {
      mountedRef.current = false;
      stopStream();
      discardCapture();
    };
  }, [startStream, stopStream, discardCapture]);

  function capture() {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) {
      setPhase("error");
      setErrorMessage("The camera isn't ready yet. Wait a moment and try again, or upload an image.");
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) {
      setPhase("error");
      setErrorMessage("This browser couldn't capture a photo. Upload an image instead.");
      return;
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => {
        if (!mountedRef.current) return;
        if (!blob) {
          setPhase("error");
          setErrorMessage("The photo couldn't be captured. Try again, or upload an image.");
          return;
        }
        capturedBlobRef.current = blob;
        const url = URL.createObjectURL(blob);
        capturedUrlRef.current = url;
        setCapturedUrl(url);
        // The frame is frozen in the captured image; the live camera is
        // no longer needed and its tracks stop immediately.
        stopStream();
        setPhase("captured");
      },
      "image/jpeg",
      0.92,
    );
  }

  function retake() {
    discardCapture();
    void startStream();
  }

  function usePhoto() {
    const blob = capturedBlobRef.current;
    if (!blob) return;
    const file = new File([blob], "camera-capture.jpg", {
      type: "image/jpeg",
      lastModified: Date.now(),
    });
    discardCapture();
    stopStream();
    onUsePhoto(file);
  }

  function close() {
    stopStream();
    discardCapture();
    onClose();
  }

  return (
    <section className="scanner-camera" aria-label="Camera">
      {phase === "captured" && capturedUrl ? (
        <img className="scanner-camera-preview" src={capturedUrl} alt="Captured photo of the record" />
      ) : (
        <video
          ref={videoRef}
          className="scanner-camera-preview"
          autoPlay
          playsInline
          muted
          aria-label="Live camera preview"
        />
      )}
      {phase === "starting" && <p role="status">Starting camera… allow camera access if your browser asks.</p>}
      {phase === "error" && (
        <p className="alert-error" role="alert">{errorMessage}</p>
      )}
      <div className="row-actions">
        {phase === "live" && (
          <button className="btn" type="button" onClick={capture}>
            <Icon name="scanner" />Capture
          </button>
        )}
        {phase === "captured" && (
          <>
            <button className="btn" type="button" onClick={usePhoto}>
              Use photo
            </button>
            <button className="btn ghost" type="button" onClick={retake}>
              Retake
            </button>
          </>
        )}
        {phase === "error" && (
          <button className="btn" type="button" onClick={() => void startStream()}>
            Try camera again
          </button>
        )}
        <button className="btn ghost" type="button" onClick={close}>
          Cancel
        </button>
      </div>
      {phase === "error" && (
        <p className="field-hint">You can still use Upload image below — nothing was captured or saved.</p>
      )}
    </section>
  );
}

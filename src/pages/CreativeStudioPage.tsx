import { useEffect, useRef, useState } from "react";
import PageHeader from "../components/ui/PageHeader";
import ScannerCamera from "../components/ScannerCamera";
import Card from "../components/ui/Card";
import { productsRepo, profilesRepo } from "../data/db";
import type { Product, Profile } from "../data/types";
import {
  buildCreativeEditPayload,
  fetchCreativeStatus,
  MAX_STUDIO_PROMPT_CHARS,
  nextEditSource,
  requestCreativeEdit,
  validateStudioImage,
  type CreativeStatus,
  type StudioTurn,
} from "../lib/creativeStudio";

let turnSeq = 0;
const nextTurnId = () => `turn-${Date.now()}-${(turnSeq += 1)}`;

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("read"));
    reader.readAsDataURL(file);
  });
}

/**
 * Bucky Creative Studio — conversational AI image editor.
 * Upload Image (file picker) and Take Photo (real in-app camera via
 * getUserMedia) are separate workflows. Describe the change, generate,
 * then keep refining the latest result. Real generation happens only
 * through POST /api/creative/edit when live Meta AI is configured on
 * the server; no token is entered here, and no local filter, mock, or
 * placeholder is ever shown as an AI result. The original is preserved.
 */
export default function CreativeStudioPage() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [profileId, setProfileId] = useState("");
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [creativeStatus, setCreativeStatus] = useState<CreativeStatus | null>(null);

  const [originalDataUrl, setOriginalDataUrl] = useState("");
  const [originalName, setOriginalName] = useState("");
  const [turns, setTurns] = useState<StudioTurn[]>([]);
  const [prompt, setPrompt] = useState("");
  const [generating, setGenerating] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [saveProductId, setSaveProductId] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);

  const ownProducts = products.filter((p) => p.profileId === profileId && p.status !== "archived");
  const latestResult = [...turns].reverse().find((t) => t.status === "done" && t.resultDataUrl)?.resultDataUrl ?? "";
  const currentImage = nextEditSource(turns, originalDataUrl);

  async function load() {
    try {
      const [allProfiles, allProducts] = await Promise.all([profilesRepo.listAll(), productsRepo.listAll()]);
      const businesses = allProfiles.filter((p) => p.kind === "business");
      setProfiles(businesses);
      setProducts(allProducts);
      setProfileId((prev) => prev || businesses[0]?.id || "");
      setStatus("ready");
    } catch { setStatus("error"); }
  }
  useEffect(() => { void load(); }, []);
  useEffect(() => { void fetchCreativeStatus().then(setCreativeStatus); }, []);

  async function onPhotoFile(file: File | undefined) {
    if (!file) return;
    const problem = validateStudioImage(file);
    if (problem) { setError(problem); return; }
    try {
      const dataUrl = await readAsDataUrl(file);
      setOriginalDataUrl(dataUrl);
      setOriginalName(file.name || "Captured photo");
      setTurns([]);
      setPrompt("");
      setError("");
      setNotice("Photo loaded and preserved as your original. Describe an edit below — each follow-up refines the latest Bucky image result.");
    } catch { setError("That photo could not be read. Try another image."); }
  }

  async function onGenerate() {
    if (generating) return; // One image per user-initiated generation; never auto-retried.
    const instruction = prompt.trim();
    const payload = currentImage
      ? buildCreativeEditPayload(currentImage, instruction, turns)
      : instruction && instruction.length <= MAX_STUDIO_PROMPT_CHARS
        ? { operation: "generate" as const, prompt: instruction }
        : null;
    if (!payload) { setError(`Enter an image prompt (1–${MAX_STUDIO_PROMPT_CHARS} characters).`); return; }
    setGenerating(true);
    setError("");
    try {
      const { dataUrl, verifiedModel } = await requestCreativeEdit(payload);
      setTurns((prev) => [...prev, { id: nextTurnId(), prompt: payload.prompt, resultDataUrl: dataUrl, verifiedModel, status: "done" }]);
      setPrompt("");
      setNotice("Image ready. Ask for another change to refine this result, download it, or save it to a product.");
    } catch (e) {
      const message = e instanceof Error ? e.message : "The edit could not be completed. No image was generated.";
      setTurns((prev) => [...prev, { id: nextTurnId(), prompt: payload.prompt, resultDataUrl: null, status: "unavailable", message }]);
      setError(message);
    } finally { setGenerating(false); }
  }

  function downloadLatest() {
    if (!latestResult) return;
    const link = document.createElement("a");
    link.download = "bucketa-ai-edit.png";
    link.href = latestResult;
    link.click();
  }

  async function saveToProduct() {
    const product = ownProducts.find((p) => p.id === saveProductId);
    if (!product) { setError("Choose the product to save this Bucky image to."); return; }
    if (!latestResult) { setError("Generate a Bucky edit first, then save that result."); return; }
    try {
      await productsRepo.update(product.id, { photoDataUrl: latestResult });
      setError("");
      setNotice(`Bucky image saved to "${product.name}". Your original uploaded photo was not changed.`);
      void load();
    } catch (e) { setError(e instanceof Error ? e.message : "The image could not be saved to the product."); }
  }

  function startOver() {
    setOriginalDataUrl("");
    setOriginalName("");
    setTurns([]);
    setPrompt("");
    setError("");
    setNotice("");
    if (fileRef.current) fileRef.current.value = "";
  }

  return (
    <section className="page creative-studio-page">
      <PageHeader className="workspace-page-header" eyebrow="BUSINESS TOOLS" title="Bucky Creative Studio" description="Create an image from a description or upload a photo to edit." />
      {status === "loading" && <Card className="loading-state" role="status">Loading studio…</Card>}
      {status === "error" && <Card className="feedback-error"><p className="alert-error" role="alert">Studio could not load your products.</p><button className="btn" type="button" onClick={() => void load()}>Retry</button></Card>}
      {status === "ready" && (
        <>
          {creativeStatus && !creativeStatus.available && (
            <p className="alert-error studio-status" role="status">{creativeStatus.reason}</p>
          )}
          {notice && <p className="notice dash-alert" role="status">{notice}</p>}
          {error && <p className="alert-error" role="alert">{error}</p>}

          <Card className="studio-card" aria-labelledby="studio-editor-heading">
            <h2 id="studio-editor-heading">Bucky image editor</h2>
            <div className="row-actions">
              <button className="btn" type="button" onClick={() => fileRef.current?.click()}>Upload Image</button>
              <input ref={fileRef} id="studio-photo-input" className="sr-only" type="file" accept="image/jpeg,image/png,image/webp,image/gif" aria-label="Upload image" onChange={(e) => { void onPhotoFile(e.target.files?.[0]); e.target.value = ""; }} />
              <button className="btn ghost" type="button" onClick={() => { setError(""); setCameraOpen(true); }}>Take Photo</button>
              {(originalDataUrl || turns.length > 0) && <button className="btn ghost" type="button" onClick={startOver}>Start over</button>}
            </div>
            {cameraOpen && (
              <ScannerCamera
                onUsePhoto={(file) => { setCameraOpen(false); void onPhotoFile(file); }}
                onClose={() => setCameraOpen(false)}
              />
            )}

                {(originalDataUrl || latestResult) && <div className="studio-before-after">
                  {originalDataUrl && <figure><img src={originalDataUrl} alt="Your original uploaded" /><figcaption>Original{originalName ? ` — ${originalName}` : ""} (always preserved)</figcaption></figure>}
                  <figure>{latestResult ? <img src={latestResult} alt="Latest Bucky-generated image" /> : <div className="studio-placeholder muted">Your Bucky-generated image will appear here.</div>}<figcaption>{latestResult ? "Latest Bucky image result — follow-ups refine this image" : "Bucky image result"}</figcaption></figure>
                </div>}

                {turns.length > 0 && (
                  <div className="studio-conversation" aria-label="Edit conversation" aria-live="polite">
                    {turns.map((turn, index) => (
                      <article key={turn.id} className="studio-turn">
                        <p className="studio-turn-prompt"><strong>You:</strong> {turn.prompt}</p>
                        {turn.status === "done" && turn.resultDataUrl
                          ? <figure><img src={turn.resultDataUrl} alt={`Bucky image result for edit ${index + 1}`} /><figcaption>Bucky image result {index + 1}{turn.verifiedModel && (
                              <span className="bucky-model-label">{turn.verifiedModel === "muse-image-1.0" ? "Meta Muse Image 1.0" : turn.verifiedModel}</span>
                            )}</figcaption></figure>
                          : <p className="muted">{turn.message ?? "No image was generated for this request."}</p>}
                      </article>
                    ))}
                  </div>
                )}

                <p className="field-hint">Model for live generation: Meta Muse Image 1.0. One Generate tap sends exactly one request; there are no automatic retries. If live AI is not configured, Generate reports that and no image is created.</p>
                <div className="field studio-prompt">
                  <label htmlFor="studio-prompt-input">{turns.some((t) => t.status === "done") ? "Describe the next change (refines the latest result)" : currentImage ? "Describe what you want to change" : "Describe the image you want to create"}</label>
                  <textarea id="studio-prompt-input" className="input" rows={3} maxLength={MAX_STUDIO_PROMPT_CHARS} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={currentImage ? "e.g. Improve the lighting and simplify the background." : "e.g. A product photo of a coffee bag on a warm, neutral background."} />
                </div>
                <div className="row-actions">
                  <button className="btn" type="button" disabled={generating || !prompt.trim()} onClick={() => void onGenerate()}>{generating ? "Generating…" : "Generate"}</button>
                  <button className="btn ghost" type="button" disabled={!latestResult} onClick={downloadLatest}>Download Image</button>
                </div>

                {profiles.length > 0 && (
                  <div className="studio-save-product">
                    <div className="selector-main"><label htmlFor="studio-business">Business (for Save to Product)</label><select id="studio-business" className="input selector-select" value={profileId} onChange={(e) => { setProfileId(e.target.value); setSaveProductId(""); }}>{profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
                    <div className="selector-main"><label htmlFor="studio-save-product">Save to Product (optional)</label><select id="studio-save-product" className="input selector-select" value={saveProductId} onChange={(e) => setSaveProductId(e.target.value)}><option value="">Choose product…</option>{ownProducts.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select><button className="btn ghost" type="button" disabled={!latestResult || !saveProductId} onClick={() => void saveToProduct()}>Save to Product</button></div>
                  </div>
                )}
          </Card>
        </>
      )}
    </section>
  );
}

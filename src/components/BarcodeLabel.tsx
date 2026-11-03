import { useEffect, useRef, useState } from "react";
import JsBarcode from "jsbarcode";
import { formatMoney } from "../lib/currency";
import { LABEL_SIZES } from "../lib/creativeStudio";
import type { Product } from "../data/types";

/** JsBarcode format for a stored value; internal and nonnumeric values use Code 128. */
function formatFor(barcode: string): string {
  if (/^\d{13}$/.test(barcode)) return "EAN13";
  if (/^\d{12}$/.test(barcode)) return "UPC";
  if (/^\d{8}$/.test(barcode)) return "EAN8";
  return "CODE128";
}

function LabelFace({ product, showPrice, widthMm }: { product: Product; showPrice: boolean; widthMm: number }) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [error, setError] = useState("");
  const barcode = (product.barcode ?? "").trim();
  useEffect(() => {
    if (!svgRef.current || !barcode) return;
    setError("");
    try {
      JsBarcode(svgRef.current, barcode, { format: formatFor(barcode), displayValue: true, fontSize: 13, height: 52, margin: 10, width: 2 });
    } catch { setError("This barcode could not be rendered. Correct it before printing."); }
  }, [barcode]);
  if (!barcode) return null;
  return (
    <div className="barcode-label-face" style={{ width: `${widthMm}mm` }} aria-label={`Barcode label for ${product.name}`}>
      <div className="barcode-label-top">
        {showPrice ? <span className="barcode-label-price">{formatMoney(product.priceMinor, product.currency)}</span> : <span />}
        <span className="barcode-label-spacer" />
      </div>
      <p className="barcode-label-name">{product.name}</p>
      <svg ref={svgRef} className="barcode-label-svg" role="img" aria-label={`Barcode ${barcode}`} />
      <p className="barcode-label-code">{barcode}</p>
      {barcode.startsWith("BKT-") && <p className="barcode-label-note">Internal store code — not a GS1 barcode.</p>}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

/**
 * Printable barcode labels (Phase D). Merchant chooses dimensions,
 * optional price, and copies; batch mode prints every listed product.
 * Barcodes render as SVG with quiet zones (JsBarcode margin) so printed
 * labels stay scannable. Manufacturer barcodes are reused as stored;
 * internal BKT- values render as Code 128.
 */
export default function BarcodeLabel({ product, batchProducts, onClose }: { product: Product; batchProducts?: Product[]; onClose: () => void }) {
  const [sizeId, setSizeId] = useState("label-m");
  const [showPrice, setShowPrice] = useState(true);
  const [copies, setCopies] = useState(1);
  const size = LABEL_SIZES.find((s) => s.id === sizeId) ?? LABEL_SIZES[1];
  const items = (batchProducts?.length ? batchProducts : [product]).filter((p) => (p.barcode ?? "").trim());
  const safeCopies = Math.max(1, Math.min(50, Math.floor(copies) || 1));
  if (!items.length) return null;
  return (
    <section className="barcode-label-card print-report" aria-label={`Barcode labels for ${items.length === 1 ? items[0].name : `${items.length} products`}`}>
      <div className="barcode-label-controls no-print">
        <div className="field"><label htmlFor="label-size">Label size</label><select id="label-size" className="input" value={sizeId} onChange={(e) => setSizeId(e.target.value)}>{LABEL_SIZES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></div>
        <div className="field"><label htmlFor="label-copies">Copies each</label><input id="label-copies" className="input" type="number" min={1} max={50} value={copies} onChange={(e) => setCopies(Number(e.target.value))} /></div>
        <label className="barcode-label-check"><input type="checkbox" checked={showPrice} onChange={(e) => setShowPrice(e.target.checked)} /> Show price</label>
      </div>
      <p className="field-hint no-print">Print preview — {items.length} product{items.length === 1 ? "" : "s"} × {safeCopies} cop{safeCopies === 1 ? "y" : "ies"}. Check the preview before printing.</p>
      <div className="barcode-label-sheet">
        {items.flatMap((item) => Array.from({ length: safeCopies }, (_, i) => <LabelFace key={`${item.id}-${i}`} product={item} showPrice={showPrice} widthMm={size.width} />))}
      </div>
      <div className="row-actions no-print">
        <button className="btn" type="button" onClick={() => window.print()}>Print labels</button>
        <button className="btn ghost" type="button" onClick={onClose}>Close</button>
      </div>
    </section>
  );
}

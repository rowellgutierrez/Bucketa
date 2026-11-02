import { useEffect, useRef, useState } from "react";
import JsBarcode from "jsbarcode";
import { formatMoney } from "../lib/currency";
import type { Product } from "../data/types";

/** JsBarcode format for a stored value; internal and nonnumeric values use Code 128. */
function formatFor(barcode: string): string {
  if (/^\d{13}$/.test(barcode)) return "EAN13";
  if (/^\d{12}$/.test(barcode)) return "UPC";
  if (/^\d{8}$/.test(barcode)) return "EAN8";
  return "CODE128";
}

/**
 * Printable internal barcode label (P0). Rendered with the verified
 * JsBarcode encoder as SVG so it stays genuinely scannable in print.
 * Internal BKT- values are labelled as store codes, never GS1 barcodes.
 * Print uses the app's print isolation: only this label is visible.
 */
export default function BarcodeLabel({ product, onClose }: { product: Product; onClose: () => void }) {
  const [error, setError] = useState("");
  const svgRef = useRef<SVGSVGElement | null>(null);
  const barcode = (product.barcode ?? "").trim();

  useEffect(() => {
    if (!svgRef.current || !barcode) return;
    const render = (format: string) =>
      JsBarcode(svgRef.current, barcode, {
        format, displayValue: true, fontSize: 14, height: 60, margin: 20,
      });
    setError("");
    try { render(formatFor(barcode)); }
    catch { setError("This barcode could not be rendered. Correct it before printing."); }
  }, [barcode]);

  if (!barcode) return null;
  return (
    <section className="barcode-label-card print-report" data-wide={barcode.length > 16} aria-label={`Barcode label for ${product.name}`}>
      <p className="barcode-label-name">{product.name}</p>
      <svg ref={svgRef} className="barcode-label-svg" role="img" aria-label={`Barcode ${barcode}`} />
      {error && <p role="alert">{error}</p>}
      <p className="barcode-label-price">{formatMoney(product.priceMinor, product.currency)}</p>
      <p className="field-hint">
        {barcode.startsWith("BKT-") ? "Internal store code — not a GS1 barcode. " : ""}Code: {barcode}
      </p>
      <div className="row-actions">
        <button className="btn" type="button" disabled={!!error} onClick={() => window.print()}>Print label</button>
        <button className="btn ghost" type="button" onClick={onClose}>Close</button>
      </div>
    </section>
  );
}

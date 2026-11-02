const assert: {
  equal(actual: unknown, expected: unknown): void;
  throws(body: () => unknown, expected: RegExp): void;
  ok(value: unknown): asserts value;
} = (await import("node:" + "assert/strict")).default;
const test: (name: string, body: () => void) => void = (await import("node:" + "test")).default;
import type { Product } from "../data/types.ts";
import { findBarcodeConflict, validateProduct } from "../data/validation.ts";
import { addToCart, buildSaleItems } from "./pos.ts";
import {
  findProductByBarcode,
  generateInternalBarcode,
  isInternalBarcode,
  shouldAcceptScan,
} from "./barcode.ts";

const stamp = "2026-11-02T00:00:00.000Z";
function product(over: Partial<Product> = {}): Product {
  return {
    id: "p1", profileId: "biz1", name: "Rice 1kg", sku: null, barcode: "BKT-AAAA2345",
    category: null, priceMinor: 15000, costMinor: null, currency: "PHP", stock: 5,
    status: "active", createdAt: stamp, updatedAt: stamp, ...over,
  };
}

test("generated barcodes are internal, valid, and unique within the business", () => {
  const existing = [product()];
  const suffixes = ["AAAA2345", "BBBB3456"];
  let i = 0;
  const code = generateInternalBarcode(existing, "biz1", () => suffixes[i++]);
  assert.equal(code, "BKT-BBBB3456");
  assert.equal(isInternalBarcode(code), true);
  validateProduct(product({ barcode: code }));
});

test("barcode conflicts are scoped to one business and honour excludeId", () => {
  const products = [product(), product({ id: "p2", profileId: "biz2", name: "Other shop rice" })];
  assert.equal(findBarcodeConflict(products, "biz1", " bkt-aaaa2345 ")?.id, "p1");
  assert.equal(findBarcodeConflict(products, "biz1", "BKT-AAAA2345", "p1"), null);
  assert.equal(findBarcodeConflict(products, "biz1", ""), null);
  assert.equal(findBarcodeConflict(products, "biz1", null), null);
});

test("invalid barcodes are rejected; legacy products without one still validate", () => {
  assert.throws(() => validateProduct(product({ barcode: "ab" })), /barcode/);
  assert.throws(() => validateProduct(product({ barcode: "BKT AAAA" })), /barcode/);
  const legacy = product();
  delete legacy.barcode;
  validateProduct(legacy);
});

test("lookup resolves only the active business's active product", () => {
  const mine = product();
  const foreign = product({ id: "p2", profileId: "biz2" });
  const archived = product({ id: "p3", barcode: "BKT-CCCC4567", status: "archived" });
  assert.equal(findProductByBarcode([foreign, mine], "biz1", "bkt-aaaa2345")?.id, "p1");
  assert.equal(findProductByBarcode([foreign], "biz1", "BKT-AAAA2345"), null);
  assert.equal(findProductByBarcode([archived], "biz1", "BKT-CCCC4567"), null);
  assert.equal(findProductByBarcode([mine], "biz1", "  "), null);
});

test("camera detections require an explicit reset, regardless of elapsed time or code", () => {
  const last = { code: "BKT-AAAA2345", at: 1000 };
  assert.equal(shouldAcceptScan(last, "BKT-AAAA2345", 2000), false);
  assert.equal(shouldAcceptScan(last, "BKT-AAAA2345", 2500), false);
  assert.equal(shouldAcceptScan(last, "BKT-AAAA2345", 99999999), false);
  assert.equal(shouldAcceptScan(last, "BKT-BBBB3456", 1100), false);
  assert.equal(shouldAcceptScan(null, "BKT-AAAA2345", 0), true);
  assert.equal(shouldAcceptScan(null, "  ", 0), false);
});

test("scan-to-cart adds the saved price and never exceeds stock", () => {
  const found = findProductByBarcode([product()], "biz1", "BKT-AAAA2345");
  assert.ok(found);
  let cart = addToCart([], found);
  for (let n = 0; n < 9; n += 1) cart = addToCart(cart, found);
  const items = buildSaleItems(cart, [found]);
  assert.equal(items.length, 1);
  assert.equal(items[0].quantity, 5);
  assert.equal(items[0].unitPriceMinor, 15000);
  assert.equal(items[0].lineTotalMinor, 75000);
});

 test("commercial barcodes require supported lengths and valid checksums", () => {
 for (const barcode of ["4006381333931", "036000291452", "96385074"]) validateProduct(product({barcode}));
 for (const barcode of ["4006381333932", "036000291453", "96385075", "123456789"]) assert.throws(() => validateProduct(product({barcode})), /barcode/i);
 });

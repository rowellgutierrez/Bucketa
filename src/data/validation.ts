import type {
  Bucket,
  Employee,
  Product,
  Profile,
  Sale,
  Transaction,
} from "./types.ts";
function isValidCurrencyCode(code: string): boolean {
  try {
    new Intl.NumberFormat("en", { style: "currency", currency: code });
    return true;
  } catch {
    return false;
  }
}

export class BucketaDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BucketaDataError";
  }
}

export function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

function fail(message: string): never {
  throw new BucketaDataError(message);
}

export function assertName(value: unknown, field = "name"): string {
  if (typeof value !== "string" || !value.trim()) fail(`${field} is required.`);
  return value.trim();
}

export function assertCurrency(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Z]{3}$/.test(value) || !isValidCurrencyCode(value)) {
    fail("currency must be a valid ISO 4217 code.");
  }
  return value;
}

export function assertMinorUnits(value: unknown, field: string, { positive = false } = {}): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    fail(`${field} must be an integer in minor units.`);
  }
  if (positive && value <= 0) fail(`${field} must be greater than zero.`);
  if (!positive && value < 0) fail(`${field} cannot be negative.`);
  return value;
}

export function assertStock(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    fail("stock must be a non-negative integer.");
  }
  return value;
}

export function validateProfile(r: Profile): Profile {
  assertName(r.name);
  if (r.kind !== "personal" && r.kind !== "business") fail("profile kind is invalid.");
  assertCurrency(r.currency);
  return r;
}

export function validateBucket(r: Bucket): Bucket {
  assertName(r.name);
  if (!r.profileId) fail("bucket profileId is required.");
  if (!["savings", "budget", "allocated"].includes(r.kind)) fail("bucket kind is invalid.");
  assertCurrency(r.currency);
  if (r.targetMinor !== undefined && r.targetMinor !== null) {
    assertMinorUnits(r.targetMinor, "targetMinor", { positive: true });
  }
  return r;
}

export function validateTransaction(r: Transaction): Transaction {
  if (!r.profileId) fail("transaction profileId is required.");
  if (
    !["income", "expense", "transfer", "sale", "savings-deposit", "savings-withdrawal"].includes(
      r.type,
    )
  ) {
    fail("transaction type is invalid.");
  }
  assertMinorUnits(r.amountMinor, "amountMinor", { positive: true });
  assertCurrency(r.currency);
  if (typeof r.date !== "string" || !r.date) fail("transaction date is required.");
  assertName(r.description, "description");
  return r;
}

export function validateProduct(r: Product): Product {
  assertName(r.name);
  if (r.sku !== null && r.sku !== undefined) assertName(r.sku, "sku");
  if (r.category !== null && r.category !== undefined) assertName(r.category, "category");
  if (!r.profileId) fail("product profileId is required.");
  assertMinorUnits(r.priceMinor, "priceMinor");
  if (r.costMinor !== null && r.costMinor !== undefined) {
    assertMinorUnits(r.costMinor, "costMinor");
  }
  assertCurrency(r.currency);
  assertStock(r.stock);
  if (r.status !== undefined && r.status !== "active" && r.status !== "archived") {
    fail("product status is invalid.");
  }
  return r;
}

/** Normalised SKU for comparison: trimmed and case-insensitive. */
export function normalizeSku(sku: string | null | undefined): string {
  return (sku ?? "").trim().toUpperCase();
}

/**
 * Finds a product in the same business that already uses this SKU, or
 * null. Products without an SKU never conflict, so any number of them
 * may share a business. `excludeId` ignores the product being edited.
 */
export function findSkuConflict(
  products: Product[],
  profileId: string,
  sku: string | null | undefined,
  excludeId = "",
): Product | null {
  const wanted = normalizeSku(sku);
  if (!wanted) return null;
  return (
    products.find(
      (p) => p.id !== excludeId && p.profileId === profileId && normalizeSku(p.sku) === wanted,
    ) ?? null
  );
}

export function validateEmployee(r: Employee): Employee {
  assertName(r.name);
  if (!r.profileId) fail("employee profileId is required.");
  if (r.status !== "active" && r.status !== "inactive") fail("employee status is invalid.");
  return r;
}

/** Recomputes line and sale totals in integer minor units; rejects mismatches. */
export function validateSale(r: Sale): Sale {
  if (!r.profileId) fail("sale profileId is required.");
  assertCurrency(r.currency);
  if (!Array.isArray(r.items) || r.items.length === 0) fail("sale needs at least one item.");
  let total = 0;
  const seenProductIds = new Set<string>();
  for (const item of r.items) {
    if (seenProductIds.has(item.productId)) {
      fail("sale items must not contain the same product twice.");
    }
    seenProductIds.add(item.productId);
    assertName(item.name, "item name");
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      fail("item quantity must be a positive integer.");
    }
    assertMinorUnits(item.unitPriceMinor, "unitPriceMinor");
    const expected = item.unitPriceMinor * item.quantity;
    if (item.lineTotalMinor !== expected) fail("lineTotalMinor does not match price x quantity.");
    total += expected;
  }
  if (r.totalMinor !== total) fail("sale totalMinor does not match its line items.");
  if (r.paymentMethod !== undefined && r.paymentMethod !== "cash") {
    fail("sale paymentMethod is invalid.");
  }
  if (r.amountReceivedMinor !== undefined && r.amountReceivedMinor !== null) {
    assertMinorUnits(r.amountReceivedMinor, "amountReceivedMinor");
    if (r.amountReceivedMinor < r.totalMinor) {
      fail("amount received is less than the sale total.");
    }
  }
  if (r.changeMinor !== undefined && r.changeMinor !== null) {
    assertMinorUnits(r.changeMinor, "changeMinor");
    if (
      r.amountReceivedMinor === undefined ||
      r.amountReceivedMinor === null ||
      r.changeMinor !== r.amountReceivedMinor - r.totalMinor
    ) {
      fail("changeMinor does not match amount received minus total.");
    }
  }
  return r;
}

export interface BusinessRecordSets {
  buckets: Bucket[];
  transactions: Transaction[];
  products: Product[];
  employees: Employee[];
  sales: Sale[];
  allTransactions: Transaction[];
  allSales: Sale[];
}

/**
 * Returns reasons a business must NOT be deleted, or [] when every record
 * that references this business's data is itself owned by the business.
 * Deletion is refused whenever ownership of a related record cannot be
 * proven from its profileId / bucketId / relatedId / productId links.
 */
export function findUnsafeBusinessReferences(
  profileId: string,
  sets: BusinessRecordSets,
): string[] {
  const reasons: string[] = [];
  const owned = (label: string, records: { profileId: string }[]) => {
    if (records.some((r) => r.profileId !== profileId)) {
      reasons.push(`a ${label} record does not belong to this business`);
    }
  };
  owned("bucket", sets.buckets);
  owned("transaction", sets.transactions);
  owned("product", sets.products);
  owned("employee", sets.employees);
  owned("sale", sets.sales);

  const bucketIds = new Set(sets.buckets.map((b) => b.id));
  const transactionIds = new Set(sets.transactions.map((t) => t.id));
  const productIds = new Set(sets.products.map((p) => p.id));

  for (const txn of sets.allTransactions) {
    if (txn.profileId === profileId) continue;
    if (txn.bucketId && bucketIds.has(txn.bucketId)) {
      reasons.push("another business's transaction references this business's bucket");
    }
    if (txn.relatedId && transactionIds.has(txn.relatedId)) {
      reasons.push("another business's transaction is linked to this business's transaction");
    }
  }
  for (const sale of sets.allSales) {
    if (sale.profileId === profileId) continue;
    if (sale.items.some((item) => productIds.has(item.productId))) {
      reasons.push("another business's sale includes this business's product");
    }
  }
  return [...new Set(reasons)];
}

export function computeSaleTotal(items: Sale["items"]): number {
  return items.reduce((sum, item) => sum + item.unitPriceMinor * item.quantity, 0);
}

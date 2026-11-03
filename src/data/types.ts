import type { CurrencyCode, MinorUnits } from "../lib/currency";

export type { CurrencyCode, MinorUnits };

export type ProfileKind = "personal" | "business";
export type BucketKind = "savings" | "budget" | "allocated";
export type TransactionType =
  | "income"
  | "expense"
  | "transfer"
  | "sale"
  | "savings-deposit"
  | "savings-withdrawal";
export type TransactionOrigin = "manual" | "pos" | "scanner-confirmed";

export interface Profile {
  id: string;
  kind: ProfileKind;
  name: string;
  /** Each profile operates in one currency. Never mix currencies in totals. */
  currency: CurrencyCode;
  createdAt: string;
  updatedAt: string;
}

export interface Bucket {
  id: string;
  profileId: string;
  name: string;
  kind: BucketKind;
  currency: CurrencyCode;
  /** Optional savings goal in minor units of `currency`. Absent/null = no goal. */
  targetMinor?: MinorUnits | null;
  createdAt: string;
  updatedAt: string;
}

export interface Transaction {
  id: string;
  profileId: string;
  bucketId: string | null;
  type: TransactionType;
  /** Positive integer in minor units. Direction is carried by `type`. */
  amountMinor: MinorUnits;
  currency: CurrencyCode;
  /** ISO date (YYYY-MM-DD) or datetime string. */
  date: string;
  description: string;
  category: string | null;
  origin: TransactionOrigin;
  /** Set only for transfer pairs and POS/scanner links in future milestones. */
  relatedId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Product {
  id: string;
  /** Owning business profile. */
  profileId: string;
  name: string;
  /** Optional stock-keeping code; unique within the business when present. */
  sku: string | null;
  /**
   * Optional scannable barcode (EAN/UPC/Code 128 value, or an internal
   * Bucketa-generated Code 128 value). Unique within the business when
   * present, enforced like SKU. Absent on records saved before Smart
   * Scan, so no migration is needed. Internal generated values are for
   * store use only, not GS1 registration.
   */
  barcode?: string | null;
  /** Optional product description; AI drafts stay editable (P1). */
  description?: string | null;
  /** Optional visually-supported colour label (P1 draft field). */
  color?: string | null;
  /** Optional grouping label, e.g. "Drinks". */
  category: string | null;
  /** Optional Creative Studio photo (data URL) approved by the merchant.
   * Absent on older records, so no migration is needed. The original
   * uploaded photo is never stored by Bucketa. */
  photoDataUrl?: string | null;
  priceMinor: MinorUnits;
  /** Optional purchase cost; null means cost is not tracked. */
  costMinor: MinorUnits | null;
  currency: CurrencyCode;
  stock: number;
  /**
   * Archived products stay stored (past sales keep referencing them) and
   * can be restored. Absent means active, so older records need no
   * migration.
   */
  status?: "active" | "archived";
  createdAt: string;
  updatedAt: string;
}

export type SalaryFrequency = "hourly" | "daily" | "weekly" | "biweekly" | "monthly" | "custom";

export interface Employee {
  id: string;
  /** Owning business profile. */
  profileId: string;
  name: string;
  /** Position / job title. */
  role: string | null;
  /** "inactive" is the archived state: history is preserved and the
   * employee can be restored at any time. */
  status: "active" | "inactive";
  /** Optional employment details. All optional so records saved before
   * these fields existed need no migration (IndexedDB is schemaless). */
  startDate?: string | null;
  contact?: string | null;
  /** Agreed salary rate in minor units of `currency`. A rate is an
   * agreement, never money already paid — payments are transactions. */
  salaryRateMinor?: MinorUnits | null;
  salaryFrequency?: SalaryFrequency | null;
  currency?: CurrencyCode | null;
  createdAt: string;
  updatedAt: string;
}

export interface SaleLineItem {
  productId: string;
  name: string;
  sku: string | null;
  unitPriceMinor: MinorUnits;
  quantity: number;
  lineTotalMinor: MinorUnits;
}

export interface Sale {
  id: string;
  profileId: string;
  items: SaleLineItem[];
  /** Sum of line totals, computed in code at validation time. */
  totalMinor: MinorUnits;
  currency: CurrencyCode;
  /** Cash payment details for POS sales; absent on older records. */
  paymentMethod?: "cash";
  amountReceivedMinor?: MinorUnits | null;
  changeMinor?: MinorUnits | null;
  /** Human-readable receipt number stored at checkout time. */
  receiptNumber?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AppSettings {
  id: "app";
  defaultCurrency: CurrencyCode;
  locale: string;
  updatedAt: string;
}

export type StoreName =
  | "profiles"
  | "buckets"
  | "transactions"
  | "products"
  | "employees"
  | "sales"
  | "settings";

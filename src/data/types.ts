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
  /** Optional grouping label, e.g. "Drinks". */
  category: string | null;
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

export interface Employee {
  id: string;
  /** Owning business profile. */
  profileId: string;
  name: string;
  role: string | null;
  status: "active" | "inactive";
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

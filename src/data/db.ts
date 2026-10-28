import type {
  AppSettings,
  Bucket,
  Employee,
  Product,
  Profile,
  Sale,
  StoreName,
  Transaction,
} from "./types.ts";
import {
  BucketaDataError,
  findUnsafeBusinessReferences,
  nowIso,
  validateBucket,
  validateEmployee,
  validateProduct,
  validateProfile,
  validateSale,
  validateTransaction,
} from "./validation.ts";

/**
 * Bucketa local database (native IndexedDB, no dependencies).
 * All data stays in the browser. Records are separated by profileId and
 * money is integer minor units. This module never creates financial
 * records on its own — callers must pass fully confirmed records.
 */
export const DB_NAME = "bucketa";
export const DB_VERSION = 1;

export class DbUnavailableError extends Error {
  constructor(message = "IndexedDB is not available in this browser.") {
    super(message);
    this.name = "DbUnavailableError";
  }
}

const STORE_INDEXES: Record<StoreName, { name: string; keyPath: string | string[]; unique?: boolean }[]> = {
  profiles: [{ name: "kind", keyPath: "kind" }],
  buckets: [
    { name: "profileId", keyPath: "profileId" },
    { name: "profileId_currency", keyPath: ["profileId", "currency"] },
  ],
  transactions: [
    { name: "profileId", keyPath: "profileId" },
    { name: "profileId_date", keyPath: ["profileId", "date"] },
    { name: "bucketId", keyPath: "bucketId" },
  ],
  products: [
    { name: "profileId", keyPath: "profileId" },
    { name: "profileId_sku", keyPath: ["profileId", "sku"], unique: true },
  ],
  employees: [{ name: "profileId", keyPath: "profileId" }],
  sales: [
    { name: "profileId", keyPath: "profileId" },
    { name: "profileId_createdAt", keyPath: ["profileId", "createdAt"] },
  ],
  settings: [],
};

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new DbUnavailableError());
  }
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      (Object.keys(STORE_INDEXES) as StoreName[]).forEach((storeName) => {
        if (!db.objectStoreNames.contains(storeName)) {
          const store = db.createObjectStore(storeName, { keyPath: "id" });
          for (const idx of STORE_INDEXES[storeName]) {
            store.createIndex(idx.name, idx.keyPath, { unique: Boolean(idx.unique) });
          }
        }
      });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(new DbUnavailableError("Failed to open the local database."));
    request.onblocked = () =>
      reject(new DbUnavailableError("The local database is blocked by another tab."));
  });
  // Allow a later retry after a failed open.
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

/** Safe initialization: resolves true when the database is usable. */
export async function initDb(): Promise<boolean> {
  try {
    await openDb();
    return true;
  } catch {
    return false;
  }
}

function tx<T>(
  storeName: StoreName,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(storeName, mode);
        const request = run(transaction.objectStore(storeName));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () =>
          reject(new BucketaDataError(`Database operation failed (${storeName}).`));
        transaction.onerror = () =>
          reject(new BucketaDataError(`Database transaction failed (${storeName}).`));
      }),
  );
}

interface Repository<T extends { id: string; createdAt: string; updatedAt: string }> {
  create(record: T): Promise<T>;
  getById(id: string): Promise<T | undefined>;
  listAll(): Promise<T[]>;
  listByProfile(profileId: string): Promise<T[]>;
  update(id: string, patch: Partial<T>): Promise<T>;
  remove(id: string): Promise<void>;
}

function createRepository<T extends { id: string; createdAt: string; updatedAt: string }>(
  storeName: StoreName,
  validate: (record: T) => T,
  { byProfile = true } = {},
): Repository<T> {
  return {
    async create(record) {
      validate(record);
      await tx(storeName, "readwrite", (s) => s.add(record));
      return record;
    },
    getById(id) {
      return tx(storeName, "readonly", (s) => s.get(id)) as Promise<T | undefined>;
    },
    listAll() {
      return tx(storeName, "readonly", (s) => s.getAll()) as Promise<T[]>;
    },
    listByProfile(profileId) {
      if (!byProfile) return this.listAll();
      return openDb().then(
        (db) =>
          new Promise<T[]>((resolve, reject) => {
            const request = db
              .transaction(storeName, "readonly")
              .objectStore(storeName)
              .index("profileId")
              .getAll(profileId);
            request.onsuccess = () => resolve(request.result as T[]);
            request.onerror = () =>
              reject(new BucketaDataError(`Database operation failed (${storeName}).`));
          }),
      );
    },
    async update(id, patch) {
      const existing = await this.getById(id);
      if (!existing) throw new BucketaDataError(`Record not found (${storeName}/${id}).`);
      const next: T = {
        ...existing,
        ...patch,
        id: existing.id,
        createdAt: existing.createdAt,
        updatedAt: nowIso(),
      };
      // profileId is immutable so records can never move between profiles.
      if ("profileId" in existing && "profileId" in next) {
        (next as { profileId: unknown }).profileId = (existing as { profileId: unknown }).profileId;
      }
      validate(next);
      await tx(storeName, "readwrite", (s) => s.put(next));
      return next;
    },
    async remove(id) {
      await tx(storeName, "readwrite", (s) => s.delete(id));
    },
  };
}

export const profilesRepo = createRepository<Profile>("profiles", validateProfile, { byProfile: false });
export const bucketsRepo = createRepository<Bucket>("buckets", validateBucket);
export const transactionsRepo = createRepository<Transaction>("transactions", validateTransaction);
export const productsRepo = createRepository<Product>("products", validateProduct);
export const employeesRepo = createRepository<Employee>("employees", validateEmployee);
export const salesRepo = createRepository<Sale>("sales", validateSale);

export interface BusinessDeletionSummary {
  buckets: number;
  transactions: number;
  products: number;
  employees: number;
  sales: number;
}

/**
 * Deletes one business profile and only the records owned by it.
 * All related records are identified first; if any record belonging to
 * another business references this business's buckets, transactions, or
 * products (or an owned set contains a foreign record), nothing is
 * deleted and a BucketaDataError is thrown.
 */
export async function deleteBusinessProfile(
  profileId: string,
): Promise<BusinessDeletionSummary> {
  const profile = await profilesRepo.getById(profileId);
  if (!profile) throw new BucketaDataError("Business not found.");
  if (profile.kind !== "business") {
    throw new BucketaDataError("Only business profiles can be deleted here.");
  }
  const [buckets, transactions, products, employees, sales, allTransactions, allSales] =
    await Promise.all([
      bucketsRepo.listByProfile(profileId),
      transactionsRepo.listByProfile(profileId),
      productsRepo.listByProfile(profileId),
      employeesRepo.listByProfile(profileId),
      salesRepo.listByProfile(profileId),
      transactionsRepo.listAll(),
      salesRepo.listAll(),
    ]);
  const unsafe = findUnsafeBusinessReferences(profileId, {
    buckets, transactions, products, employees, sales, allTransactions, allSales,
  });
  if (unsafe.length > 0) {
    throw new BucketaDataError(
      `This business was not deleted because related records cannot be safely identified: ${unsafe.join("; ")}.`,
    );
  }
  // Children first, then buckets, then the profile itself.
  for (const sale of sales) await salesRepo.remove(sale.id);
  for (const txn of transactions) await transactionsRepo.remove(txn.id);
  for (const product of products) await productsRepo.remove(product.id);
  for (const employee of employees) await employeesRepo.remove(employee.id);
  for (const bucket of buckets) await bucketsRepo.remove(bucket.id);
  await profilesRepo.remove(profileId);
  return {
    buckets: buckets.length,
    transactions: transactions.length,
    products: products.length,
    employees: employees.length,
    sales: sales.length,
  };
}

export const settingsRepo = {
  async get(): Promise<AppSettings | undefined> {
    return tx("settings", "readonly", (s) => s.get("app")) as Promise<AppSettings | undefined>;
  },
  async save(settings: Omit<AppSettings, "id" | "updatedAt">): Promise<AppSettings> {
    if (!settings.defaultCurrency) throw new BucketaDataError("defaultCurrency is required.");
    const record: AppSettings = { ...settings, id: "app", updatedAt: nowIso() };
    await tx("settings", "readwrite", (s) => s.put(record));
    return record;
  },
};

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

/**
 * Completes a POS sale atomically: in ONE read-write IndexedDB
 * transaction over the sales and products stores, it checks the sale
 * has not already been recorded, re-reads every product to revalidate
 * business ownership, active status, currency, snapshot price, and
 * available stock, deducts the sold quantities, and only then adds the
 * sale. Any failure aborts the transaction, so a sale can never be
 * recorded without its stock deduction, stock can never be deducted
 * twice for one sale, and overselling is impossible even with stale
 * carts or concurrent tabs (IndexedDB serialises these transactions).
 *
 * Resolves "completed" for a new sale, or "already-completed" when a
 * sale with the same ID already exists (a retried checkout), in which
 * case nothing is deducted again. Creates no financial transaction
 * records: the sale itself is the revenue record for reporting.
 */
export function completeSale(sale: Sale): Promise<"completed" | "already-completed"> {
  validateSale(sale);
  return openDb().then(
    (db) =>
      new Promise<"completed" | "already-completed">((resolve, reject) => {
        const transaction = db.transaction(["sales", "products"], "readwrite");
        const salesStore = transaction.objectStore("sales");
        const productsStore = transaction.objectStore("products");
        let alreadyCompleted = false;
        let settled = false;

        const fail = (message: string) => {
          if (settled) return;
          settled = true;
          try {
            transaction.abort();
          } catch {
            // Transaction already finished; the reject below still applies.
          }
          reject(new BucketaDataError(message));
        };
        transaction.oncomplete = () => {
          if (settled) return;
          settled = true;
          resolve(alreadyCompleted ? "already-completed" : "completed");
        };
        transaction.onerror = () => {
          if (settled) return;
          settled = true;
          reject(new BucketaDataError("Sale could not be completed. Nothing was saved."));
        };
        transaction.onabort = () => {
          if (settled) return;
          settled = true;
          reject(new BucketaDataError("Sale was cancelled. Nothing was saved."));
        };

        const existingRequest = salesStore.get(sale.id);
        existingRequest.onerror = () => fail("Could not check for a duplicate sale.");
        existingRequest.onsuccess = () => {
          if (settled) return;
          if (existingRequest.result) {
            // Same checkout retried: recognise it, deduct nothing again.
            alreadyCompleted = true;
            return;
          }
          let pendingReads = sale.items.length;
          if (pendingReads === 0) {
            fail("Sale needs at least one item.");
            return;
          }
          for (const item of sale.items) {
            const getRequest = productsStore.get(item.productId);
            getRequest.onerror = () => fail(`Could not load “${item.name}”.`);
            getRequest.onsuccess = () => {
              if (settled) return;
              const product = getRequest.result as Product | undefined;
              if (!product) {
                fail(`“${item.name}” no longer exists. Remove it from the cart.`);
                return;
              }
              if (product.profileId !== sale.profileId) {
                fail(`“${item.name}” does not belong to this business.`);
                return;
              }
              if (product.status === "archived") {
                fail(`“${item.name}” is archived and can no longer be sold.`);
                return;
              }
              if (product.currency !== sale.currency) {
                fail(`“${item.name}” is priced in ${product.currency}, not ${sale.currency}.`);
                return;
              }
              if (product.priceMinor !== item.unitPriceMinor) {
                fail(`The price of “${item.name}” has changed. Review the cart and try again.`);
                return;
              }
              if (product.stock < item.quantity) {
                fail(
                  `Only ${product.stock} of “${item.name}” left in stock, but the cart has ${item.quantity}.`,
                );
                return;
              }
              const putRequest = productsStore.put({
                ...product,
                stock: product.stock - item.quantity,
                updatedAt: nowIso(),
              });
              putRequest.onerror = () => fail(`Could not update stock for “${item.name}”.`);
              pendingReads -= 1;
              if (pendingReads === 0 && !alreadyCompleted) {
                const addRequest = salesStore.add(sale);
                addRequest.onerror = () =>
                  fail("This sale was already recorded. Nothing was deducted again.");
              }
            };
          }
        };
      }),
  );
}

export type ScannerSaveOutcome = "saved" | "already-saved";

function scannerTransactionFingerprint(record: Transaction): string {
  return JSON.stringify({
    id: record.id,
    profileId: record.profileId,
    bucketId: record.bucketId,
    type: record.type,
    amountMinor: record.amountMinor,
    currency: record.currency,
    date: record.date,
    description: record.description,
    category: record.category,
    origin: record.origin,
    relatedId: record.relatedId,
  });
}

/**
 * Saves one reviewed scanner batch atomically. Unlike repository create()
 * calls in a loop, this uses ONE read-write IndexedDB transaction over
 * profiles, buckets, and transactions. It revalidates profile and bucket
 * ownership/currency from live database state, detects an already-saved
 * or conflicting batch, and only then adds every transaction. Any failure
 * aborts the transaction, so a scanner batch can never be partly saved.
 *
 * Resolves "already-saved" only when every planned deterministic record
 * already exists with identical financial content. A subset, or the same
 * ID with different content, is a conflict and saves nothing.
 */
export function saveScannerTransactions(args: {
  profileId: string;
  bucketId: string | null;
  expectedCurrency: string;
  transactions: Transaction[];
}): Promise<ScannerSaveOutcome> {
  const { profileId, bucketId, expectedCurrency, transactions } = args;
  if (transactions.length === 0) {
    return Promise.reject(new BucketaDataError("There are no scanner entries to save."));
  }
  const relatedId = transactions[0].relatedId;
  if (!relatedId?.startsWith("scanner-batch:")) {
    return Promise.reject(new BucketaDataError("Scanner batch information is missing."));
  }
  const seenIds = new Set<string>();
  try {
    for (const transaction of transactions) {
      validateTransaction(transaction);
      if (transaction.profileId !== profileId) {
        throw new BucketaDataError("A scanner entry belongs to a different profile.");
      }
      if (transaction.bucketId !== bucketId) {
        throw new BucketaDataError("A scanner entry has a different bucket from the reviewed batch.");
      }
      if (transaction.currency !== expectedCurrency) {
        throw new BucketaDataError("A scanner entry has a different currency from the reviewed batch.");
      }
      if (transaction.origin !== "scanner-confirmed") {
        throw new BucketaDataError("A scanner entry has the wrong origin.");
      }
      if (transaction.relatedId !== relatedId) {
        throw new BucketaDataError("Scanner entries do not belong to the same batch.");
      }
      if (!transaction.id.startsWith("scanner:")) {
        throw new BucketaDataError("A scanner entry has an invalid identifier.");
      }
      if (seenIds.has(transaction.id)) {
        throw new BucketaDataError("Scanner entries contain a duplicate identifier.");
      }
      seenIds.add(transaction.id);
      if (transaction.type !== "income" && transaction.type !== "expense") {
        throw new BucketaDataError("Scanner entries can only be saved as income or expenses.");
      }
    }
  } catch (error) {
    return Promise.reject(error);
  }

  return openDb().then(
    (db) =>
      new Promise<ScannerSaveOutcome>((resolve, reject) => {
        const transaction = db.transaction(
          ["profiles", "buckets", "transactions"],
          "readwrite",
        );
        const profilesStore = transaction.objectStore("profiles");
        const bucketsStore = transaction.objectStore("buckets");
        const transactionsStore = transaction.objectStore("transactions");
        let settled = false;
        let outcome: ScannerSaveOutcome = "saved";
        let profile: Profile | undefined;
        let bucket: Bucket | undefined;
        let existingTransactions: Transaction[] = [];
        let pendingReads = bucketId ? 3 : 2;

        const fail = (message: string) => {
          if (settled) return;
          settled = true;
          try {
            transaction.abort();
          } catch {
            // The reject below still reports the failed save.
          }
          reject(new BucketaDataError(message));
        };

        transaction.oncomplete = () => {
          if (settled) return;
          settled = true;
          resolve(outcome);
        };
        transaction.onerror = () => {
          if (settled) return;
          settled = true;
          reject(new BucketaDataError("Scanner entries could not be saved. Nothing was saved."));
        };
        transaction.onabort = () => {
          if (settled) return;
          settled = true;
          reject(new BucketaDataError("Scanner save was cancelled. Nothing was saved."));
        };

        const finishReads = () => {
          if (settled || pendingReads !== 0) return;
          if (!profile) {
            fail("The selected profile no longer exists. Nothing was saved.");
            return;
          }
          if (bucketId) {
            if (!bucket) {
              fail("The selected bucket no longer exists. Nothing was saved.");
              return;
            }
            if (bucket.profileId !== profileId) {
              fail("The selected bucket does not belong to this profile. Nothing was saved.");
              return;
            }
            if (bucket.currency !== expectedCurrency) {
              fail("The selected bucket uses a different currency. Nothing was saved.");
              return;
            }
          }

          const existingById = new Map(
            existingTransactions.map((record) => [record.id, record]),
          );
          const batchRecords = existingTransactions.filter(
            (record) => record.relatedId === relatedId,
          );
          const plannedExisting = transactions.filter((record) =>
            existingById.has(record.id),
          );

          if (plannedExisting.length === transactions.length) {
            const identical = transactions.every((planned) => {
              const existing = existingById.get(planned.id);
              return (
                existing &&
                scannerTransactionFingerprint(existing) ===
                  scannerTransactionFingerprint(planned)
              );
            });
            if (!identical) {
              fail(
                "This scanner batch was already recorded with different details. Nothing was saved again.",
              );
              return;
            }
            outcome = "already-saved";
            return;
          }
          if (plannedExisting.length > 0 || batchRecords.length > 0) {
            fail(
              "Part of this scanner batch was already recorded with different details. Nothing was saved again.",
            );
            return;
          }

          try {
            for (const record of transactions) validateTransaction(record);
          } catch {
            fail("A scanner entry is invalid. Nothing was saved.");
            return;
          }
          for (const record of transactions) {
            const addRequest = transactionsStore.add(record);
            addRequest.onerror = () =>
              fail("Scanner entries could not be saved. Nothing was saved.");
          }
        };

        const readDone = () => {
          pendingReads -= 1;
          finishReads();
        };

        const profileRequest = profilesStore.get(profileId);
        profileRequest.onsuccess = () => {
          profile = profileRequest.result as Profile | undefined;
          readDone();
        };
        profileRequest.onerror = () => fail("Could not verify the selected profile.");

        if (bucketId) {
          const bucketRequest = bucketsStore.get(bucketId);
          bucketRequest.onsuccess = () => {
            bucket = bucketRequest.result as Bucket | undefined;
            readDone();
          };
          bucketRequest.onerror = () => fail("Could not verify the selected bucket.");
        }

        const existingRequest = transactionsStore
          .index("profileId")
          .getAll(profileId);
        existingRequest.onsuccess = () => {
          existingTransactions = existingRequest.result as Transaction[];
          readDone();
        };
        existingRequest.onerror = () =>
          fail("Could not check for an existing scanner batch.");
      }),
  );
}

/**
 * Creates one transaction and resolves only when the IndexedDB
 * transaction has COMMITTED (transaction.oncomplete), unlike the generic
 * repository create() which resolves on request success. Use this when a
 * caller must know the record is durably saved before reacting to it —
 * e.g. firing a confirmed savings deposit/withdrawal mascot event.
 * Rejects on transaction error or abort, when nothing was committed.
 */
export function createTransactionConfirmed(record: Transaction): Promise<Transaction> {
  validateTransaction(record);
  return openDb().then(
    (db) =>
      new Promise<Transaction>((resolve, reject) => {
        const transaction = db.transaction("transactions", "readwrite");
        transaction.oncomplete = () => resolve(record);
        transaction.onerror = () =>
          reject(new BucketaDataError("The record could not be saved. Nothing was saved."));
        transaction.onabort = () =>
          reject(new BucketaDataError("The record save was cancelled. Nothing was saved."));
        transaction.objectStore("transactions").add(record);
      }),
  );
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

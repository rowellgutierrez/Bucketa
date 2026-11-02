/**
 * Scoped in-app notification for successfully persisted financial records.
 *
 * After Bucky (or another cross-page writer) commits a record, mounted
 * views need to re-read IndexedDB — otherwise they keep showing the totals
 * they loaded on mount until a full browser reload. This is a tiny
 * synchronous listener registry: it performs no reads, writes, or polling
 * itself, and it is only ever invoked *after* a commit-confirmed save has
 * resolved. Cancelled previews and failed saves must never notify.
 */

export interface RecordsChangedDetail {
  /** Profile whose records changed, when known. */
  profileId?: string;
  /** The persisted transaction ID, when a single record was saved. */
  transactionId?: string;
  /** Action kind that produced the record, when applicable. */
  kind?: string;
}

type RecordsChangedListener = (detail: RecordsChangedDetail) => void;

const listeners = new Set<RecordsChangedListener>();

/**
 * Notifies mounted views that persisted records changed. Called only after
 * a successful commit-confirmed save — never for previews, cancellations,
 * clarifications, or failed writes.
 */
export function notifyRecordsChanged(detail: RecordsChangedDetail = {}): void {
  // Copy so a listener unsubscribing (or subscribing) mid-dispatch is safe.
  for (const listener of [...listeners]) listener(detail);
}

/** Subscribes to confirmed record changes. Returns an unsubscribe function. */
export function onRecordsChanged(listener: RecordsChangedListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

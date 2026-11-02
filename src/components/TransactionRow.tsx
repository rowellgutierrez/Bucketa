import type { ReactNode } from "react";
import type { Transaction } from "../data/types";
import { transactionDisplay } from "../lib/transactionDisplay";
import Icon from "./ui/Icon";

/**
 * Shared compact transaction row (Phase B1).
 *
 * Presentation only: `transactionDisplay` remains the single source of
 * truth for accounting labels, context, and amount signs. The full
 * accounting context stays available to assistive technology (amount
 * aria-label) and as the type pill's tooltip, but is no longer repeated
 * as a visible third line — the type label, date, and category already
 * convey it. Edit/Delete or locked-state affordances are passed in as
 * children by pages that manage records; read-only pages omit them.
 */
export default function TransactionRow({
  txn,
  dateLabel,
  amountLabel,
  meta,
  children,
}: {
  txn: Transaction;
  /** Concise, already-formatted date text. */
  dateLabel: string;
  /** Already-formatted amount text (currency included). */
  amountLabel: string;
  /** Extra concise meta items rendered after the type label (category, bucket, profile…). */
  meta?: ReactNode;
  /** Optional trailing actions / locked note (management pages only). */
  children?: ReactNode;
}) {
  const display = transactionDisplay(txn.type);
  return (
    <li className="txn-row" data-kind={txn.type}>
      <span className="record-icon"><Icon name={display.icon} /></span>
      <div className="txn-main">
        <strong>{txn.description}</strong>
        <p className="muted bucket-meta txn-meta">
          <span className="txn-type" title={display.context}>{display.label}</span>
          <span>{dateLabel}</span>
          {meta}
        </p>
      </div>
      <div className="txn-value">
        <span
          className={`txn-amount ${display.amountClass}`}
          aria-label={`${display.context}: ${display.sign}${amountLabel}`}
        >
          {display.sign}{amountLabel}
        </span>
      </div>
      {children}
    </li>
  );
}

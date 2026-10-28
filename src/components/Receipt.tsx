import type { Profile, Sale } from "../data/types";
import { formatMoney } from "../lib/currency";
import { DEFAULT_LOCALE } from "../config";

function formatReceiptDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(DEFAULT_LOCALE, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

/**
 * Printable receipt for one completed sale. Rendered with the shared
 * print-report styles: hidden on screen, the only visible content when
 * printing, constrained to thermal-paper width by the receipt CSS.
 * All amounts come from the sale's stored snapshots, so reprints stay
 * correct even after products are edited or archived.
 */
export default function Receipt({ business, sale }: { business: Profile; sale: Sale }) {
  return (
    <article className="print-report receipt" aria-label={`Receipt ${sale.receiptNumber ?? sale.id}`}>
      <header>
        <h1>{business.name}</h1>
        <p>Receipt {sale.receiptNumber ?? sale.id}</p>
        <p>{formatReceiptDate(sale.createdAt)}</p>
      </header>
      <table>
        <thead>
          <tr><th>Item</th><th>Qty</th><th>Price</th><th>Amount</th></tr>
        </thead>
        <tbody>
          {sale.items.map((item) => (
            <tr key={item.productId}>
              <td>{item.name}</td>
              <td>{item.quantity}</td>
              <td>{formatMoney(item.unitPriceMinor, sale.currency)}</td>
              <td>{formatMoney(item.lineTotalMinor, sale.currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="report-details">
        <div><dt>Total</dt><dd>{formatMoney(sale.totalMinor, sale.currency)}</dd></div>
        {sale.amountReceivedMinor !== undefined && sale.amountReceivedMinor !== null && (
          <div><dt>Cash received</dt><dd>{formatMoney(sale.amountReceivedMinor, sale.currency)}</dd></div>
        )}
        {sale.changeMinor !== undefined && sale.changeMinor !== null && (
          <div><dt>Change</dt><dd>{formatMoney(sale.changeMinor, sale.currency)}</dd></div>
        )}
      </dl>
      <footer>
        <p>Thank you! — Bucketa</p>
      </footer>
    </article>
  );
}

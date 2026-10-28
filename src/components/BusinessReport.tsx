import type { Bucket, Employee, Product, Profile, Sale, Transaction } from "../data/types";
import { DEFAULT_LOCALE } from "../config";
import { formatMoney, type MinorUnits } from "../lib/currency";

export interface BusinessReportData {
  profile: Profile;
  buckets: Bucket[];
  transactions: Transaction[];
  products: Product[];
  employees: Employee[];
  sales: Sale[];
  generatedAt: string;
}

const KIND_LABELS: Record<Bucket["kind"], string> = {
  savings: "Savings",
  budget: "Budget",
  allocated: "Allocated",
};

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(DEFAULT_LOCALE, { dateStyle: "medium" }).format(date);
}

function totalsByCurrency<T extends { currency: string }>(
  records: T[],
  amount: (record: T) => MinorUnits,
): { currency: string; total: MinorUnits }[] {
  const totals = new Map<string, MinorUnits>();
  for (const record of records) {
    totals.set(record.currency, (totals.get(record.currency) ?? 0) + amount(record));
  }
  return [...totals.entries()]
    .map(([currency, total]) => ({ currency, total }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

function transactionTotals(
  transactions: Transaction[],
): { currency: string; type: Transaction["type"]; total: MinorUnits }[] {
  const totals = new Map<string, MinorUnits>();
  for (const txn of transactions) {
    const key = `${txn.currency}|${txn.type}`;
    totals.set(key, (totals.get(key) ?? 0) + txn.amountMinor);
  }
  return [...totals.entries()]
    .map(([key, total]) => {
      const [currency, type] = key.split("|") as [string, Transaction["type"]];
      return { currency, type, total };
    })
    .sort((a, b) => a.currency.localeCompare(b.currency) || a.type.localeCompare(b.type));
}

export default function BusinessReport({ data }: { data: BusinessReportData }) {
  const { profile, buckets, transactions, products, employees, sales } = data;
  const hasRecords =
    transactions.length + products.length + employees.length + sales.length > 0;
  const txnTotals = transactionTotals(transactions);
  const saleTotals = totalsByCurrency(sales, (s) => s.totalMinor);
  const bucketName = (id: string | null) =>
    id ? (buckets.find((b) => b.id === id)?.name ?? "Unknown bucket") : "—";

  return (
    <article className="print-report" aria-label={`Report for ${profile.name}`}>
      <header>
        <h1>Bucketa Business Report</h1>
        <h2>{profile.name}</h2>
        <dl className="report-details">
          <div><dt>Business currency</dt><dd>{profile.currency}</dd></div>
          <div><dt>Created</dt><dd>{formatDate(profile.createdAt)}</dd></div>
          <div><dt>Last updated</dt><dd>{formatDate(profile.updatedAt)}</dd></div>
          <div><dt>Report generated</dt><dd>{formatDate(data.generatedAt)}</dd></div>
          <div><dt>Buckets</dt><dd>{buckets.length}</dd></div>
        </dl>
      </header>

      <section>
        <h3>Buckets</h3>
        {buckets.length === 0 ? (
          <p>No buckets for this business.</p>
        ) : (
          <table>
            <thead><tr><th>Name</th><th>Type</th><th>Currency</th><th>Created</th></tr></thead>
            <tbody>
              {buckets.map((bucket) => (
                <tr key={bucket.id}>
                  <td>{bucket.name}</td>
                  <td>{KIND_LABELS[bucket.kind]}</td>
                  <td>{bucket.currency}</td>
                  <td>{formatDate(bucket.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h3>Financial Records</h3>
        {!hasRecords && <p>No financial records found for this business.</p>}

        {transactions.length > 0 && (
          <>
            <h4>Transactions ({transactions.length})</h4>
            <table>
              <thead><tr><th>Date</th><th>Description</th><th>Type</th><th>Bucket</th><th>Amount</th></tr></thead>
              <tbody>
                {[...transactions].sort((a, b) => a.date.localeCompare(b.date)).map((txn) => (
                  <tr key={txn.id}>
                    <td>{formatDate(txn.date)}</td>
                    <td>{txn.description}</td>
                    <td>{txn.type}</td>
                    <td>{bucketName(txn.bucketId)}</td>
                    <td>{formatMoney(txn.amountMinor, txn.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <h5>Transaction totals by currency and type</h5>
            <ul>
              {txnTotals.map((t) => (
                <li key={`${t.currency}-${t.type}`}>
                  {t.currency} · {t.type}: {formatMoney(t.total, t.currency)}
                </li>
              ))}
            </ul>
          </>
        )}

        {sales.length > 0 && (
          <>
            <h4>Sales ({sales.length})</h4>
            <table>
              <thead><tr><th>Date</th><th>Items</th><th>Total</th></tr></thead>
              <tbody>
                {[...sales].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((sale) => (
                  <tr key={sale.id}>
                    <td>{formatDate(sale.createdAt)}</td>
                    <td>{sale.items.reduce((n, item) => n + item.quantity, 0)}</td>
                    <td>{formatMoney(sale.totalMinor, sale.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <h5>Sales totals by currency</h5>
            <ul>
              {saleTotals.map((t) => (
                <li key={t.currency}>{t.currency}: {formatMoney(t.total, t.currency)}</li>
              ))}
            </ul>
          </>
        )}

        {products.length > 0 && (
          <>
            <h4>Products ({products.length})</h4>
            <table>
              <thead><tr><th>Name</th><th>SKU</th><th>Price</th><th>Cost</th><th>Stock</th></tr></thead>
              <tbody>
                {products.map((product) => (
                  <tr key={product.id}>
                    <td>{product.name}</td>
                    <td>{product.sku}</td>
                    <td>{formatMoney(product.priceMinor, product.currency)}</td>
                    <td>{formatMoney(product.costMinor, product.currency)}</td>
                    <td>{product.stock}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        {employees.length > 0 && (
          <>
            <h4>Employees ({employees.length})</h4>
            <table>
              <thead><tr><th>Name</th><th>Role</th><th>Status</th></tr></thead>
              <tbody>
                {employees.map((employee) => (
                  <tr key={employee.id}>
                    <td>{employee.name}</td>
                    <td>{employee.role ?? "—"}</td>
                    <td>{employee.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>

      <footer>
        <p>
          Totals are shown only from stored records and are always separated
          by currency. Amounts in different currencies are never combined.
          Use Print / Save as PDF in your browser to save this report.
        </p>
      </footer>
    </article>
  );
}

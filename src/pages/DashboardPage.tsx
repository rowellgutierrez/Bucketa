import { useEffect, useMemo, useState } from "react";
import { bucketsRepo, productsRepo, profilesRepo, salesRepo, transactionsRepo } from "../data/db";
import type { Bucket, Product, Profile, Sale, Transaction } from "../data/types";
import BuckyPanel from "../components/BuckyPanel";
import GettingStarted, { type StartStep } from "../components/GettingStarted";
import { DEFAULT_LOCALE } from "../config";
import { formatMoney } from "../lib/currency";
import {
  expenseByCategory,
  filterByDateRange,
  monthlyIncomeExpense,
  summarizeTransactions,
} from "../lib/finance";
import BuckyMascot from "../components/BuckyMascot";

type Status = "loading" | "ready" | "error";
type View = "personal" | "business" | "all";
type RangePreset = "all" | "month" | "lastMonth" | "days30" | "custom";

const PIE_COLORS = ["#014184", "#2563EB", "#0E9F6E", "#38BDF8", "#D97706", "#486581", "#7FB3E8", "#5BC8AF"];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

function formatDate(value: string): string {
  const date = new Date(`${value.slice(0, 10)}T00:00:00`);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(DEFAULT_LOCALE, { dateStyle: "medium" }).format(date);
}

function monthLabel(month: string): string {
  const date = new Date(`${month}-01T00:00:00`);
  return Number.isNaN(date.getTime())
    ? month
    : new Intl.DateTimeFormat(DEFAULT_LOCALE, { month: "short", year: "numeric" }).format(date);
}

function dayString(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function rangeFor(preset: RangePreset, customFrom: string, customTo: string): { from: string; to: string } {
  const now = new Date();
  if (preset === "month") return { from: dayString(new Date(now.getFullYear(), now.getMonth(), 1)), to: "" };
  if (preset === "lastMonth") {
    return {
      from: dayString(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
      to: dayString(new Date(now.getFullYear(), now.getMonth(), 0)),
    };
  }
  if (preset === "days30") {
    const from = new Date(now);
    from.setDate(from.getDate() - 29);
    return { from: dayString(from), to: "" };
  }
  if (preset === "custom") return { from: customFrom, to: customTo };
  return { from: "", to: "" };
}

function pieSlices(data: { category: string; total: number }[]) {
  const total = data.reduce((sum, d) => sum + d.total, 0);
  let angle = -90;
  return data.map((d, i) => {
    const sweep = total > 0 ? (d.total / total) * 360 : 0;
    const start = angle;
    angle += sweep;
    const large = sweep > 180 ? 1 : 0;
    const p = (deg: number) => {
      const rad = (deg * Math.PI) / 180;
      return `${50 + 50 * Math.cos(rad)},${50 + 50 * Math.sin(rad)}`;
    };
    const path =
      sweep >= 359.999
        ? "M50,50 m-50,0 a50,50 0 1,0 100,0 a50,50 0 1,0 -100,0"
        : `M50,50 L${p(start)} A50,50 0 ${large} 1 ${p(angle)} Z`;
    return { ...d, path, color: PIE_COLORS[i % PIE_COLORS.length], pct: total > 0 ? (d.total / total) * 100 : 0 };
  });
}

export default function DashboardPage() {
  const [status, setStatus] = useState<Status>("loading");
  const [loadError, setLoadError] = useState("");
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [sales, setSales] = useState<Sale[]>([]);
  const [view, setView] = useState<View>("all");
  const [businessId, setBusinessId] = useState("");
  const [preset, setPreset] = useState<RangePreset>("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [chartCurrency, setChartCurrency] = useState("");

  async function load() {
    setStatus("loading");
    setLoadError("");
    try {
      const [allProfiles, allBuckets, allTransactions, allProducts, allSales] = await Promise.all([
        profilesRepo.listAll(),
        bucketsRepo.listAll(),
        transactionsRepo.listAll(),
        productsRepo.listAll(),
        salesRepo.listAll(),
      ]);
      setProfiles(allProfiles);
      setBuckets(allBuckets);
      setTransactions(allTransactions);
      setProducts(allProducts);
      setSales(allSales);
      const firstBusiness = allProfiles.find((p) => p.kind === "business");
      if (firstBusiness) setBusinessId((prev) => prev || firstBusiness.id);
      setStatus("ready");
    } catch (error) {
      setStatus("error");
      setLoadError(errorMessage(error));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const personalProfiles = profiles.filter((p) => p.kind === "personal");
  const businessProfiles = profiles.filter((p) => p.kind === "business");

  const scopedProfileIds = useMemo(() => {
    if (view === "personal") return new Set(personalProfiles.map((p) => p.id));
    if (view === "business") return new Set(businessId ? [businessId] : []);
    return new Set(profiles.map((p) => p.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, businessId, profiles]);

  const range = rangeFor(preset, customFrom, customTo);
  const scoped = useMemo(
    () =>
      filterByDateRange(
        transactions.filter((t) => scopedProfileIds.has(t.profileId)),
        range.from,
        range.to,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [transactions, scopedProfileIds, range.from, range.to],
  );

  const summaries = useMemo(() => summarizeTransactions(scoped), [scoped]);
  const activeCurrency =
    summaries.some((s) => s.currency === chartCurrency)
      ? chartCurrency
      : (summaries[0]?.currency ?? "");
  const monthly = useMemo(
    () => (activeCurrency ? monthlyIncomeExpense(scoped, activeCurrency) : []),
    [scoped, activeCurrency],
  );
  const categories = useMemo(
    () => (activeCurrency ? expenseByCategory(scoped, activeCurrency) : []),
    [scoped, activeCurrency],
  );
  const slices = useMemo(() => pieSlices(categories), [categories]);
  const maxMonthly = Math.max(1, ...monthly.flatMap((m) => [m.income, m.expense]));
  const recent = useMemo(
    () =>
      [...scoped]
        .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))
        .slice(0, 8),
    [scoped],
  );

  const profileName = (id: string) => profiles.find((p) => p.id === id)?.name ?? "Unknown";
  const bucketName = (id: string | null) =>
    id ? (buckets.find((b) => b.id === id)?.name ?? "Unknown bucket") : null;
  const hasAnyTransactions = transactions.length > 0;

  // Contextual next steps: only what is actually missing, never recreating
  // profiles, buckets, or records that already exist.
  const personalIds = new Set(personalProfiles.map((p) => p.id));
  const businessIds = new Set(businessProfiles.map((p) => p.id));
  const hasPersonalTxn = transactions.some((t) => personalIds.has(t.profileId));
  const hasBusinessTxn = transactions.some((t) => businessIds.has(t.profileId));
  const businessWithoutBuckets = businessProfiles.find(
    (p) => !buckets.some((b) => b.profileId === p.id),
  );
  const startSteps: StartStep[] = [];
  if (personalProfiles.length === 0) {
    startSteps.push({
      title: "Set up your personal money",
      text: "Create a personal profile, then record your own income and expenses — kept separate from any business.",
      cta: "Set up Personal Finance",
      href: "#/personal",
    });
  } else if (!hasPersonalTxn) {
    startSteps.push({
      title: "Add your first personal record",
      text: "Your personal profile is ready. Record personal income or an expense to start your cash-flow summary.",
      cta: "Add a personal record",
      href: "#/personal",
    });
  }
  if (businessProfiles.length === 0) {
    startSteps.push({
      title: "Create a business (optional)",
      text: "If you run a business, create it here, then organise its money into buckets such as Rent or Supplies.",
      cta: "Create a business",
      href: "#/buckets",
    });
  } else if (businessWithoutBuckets) {
    startSteps.push({
      title: `Add buckets for ${businessWithoutBuckets.name}`,
      text: "This business has no buckets yet. Buckets are envelopes that give business money a job, e.g. Rent or Tax.",
      cta: "Add buckets",
      href: "#/buckets",
    });
  } else if (!hasBusinessTxn) {
    startSteps.push({
      title: "Record business income or expenses",
      text: "Your business and buckets are ready. Record business transactions and assign them to a bucket.",
      cta: "Record a business transaction",
      href: "#/transactions",
    });
  }

  return (
    <section className="page finance-page">
      <header className="dash-header greeting-header">
        {/* Normal 3D Bucky greeting. Deliberately no celebration here:
            an already-completed goal must not replay on mount/reload. */}
        <BuckyMascot animation="Greeting" label="Bucky greeting you" />
        <div>
          <h1>{personalProfiles[0] ? `Hello, ${personalProfiles[0].name}!` : "Hello!"}</h1>
          <p className="muted dash-subtitle">
            Bucketa tracks the income and expenses you record — personal and
            business separately, and each currency separately.
          </p>
        </div>
      </header>

      {status === "loading" && <div className="card" role="status">Loading dashboard…</div>}
      {status === "error" && (
        <div className="card">
          <p className="alert-error" role="alert">Could not load dashboard: {loadError}</p>
          <button className="btn" type="button" onClick={() => void load()}>Retry</button>
        </div>
      )}

      {status === "ready" && (
        <>
          {!hasAnyTransactions ? (
            <GettingStarted
              title="Welcome to Bucketa"
              intro="Start with whichever applies to you. You can do these in any order, and this guidance updates as you add profiles, buckets, and records."
              steps={startSteps}
            />
          ) : (
            startSteps.length > 0 && (
              <GettingStarted
                collapsed
                title="Getting started — next steps"
                intro="Only steps you have not done yet are listed."
                steps={startSteps}
              />
            )
          )}

          <BuckyPanel
            profiles={profiles}
            buckets={buckets}
            transactions={transactions}
            products={products}
            sales={sales}
            preferredProfileId={
              view === "business"
                ? businessId
                : view === "personal"
                  ? personalProfiles[0]?.id
                  : (personalProfiles[0]?.id ?? businessProfiles[0]?.id)
            }
          />

          {hasAnyTransactions && (
          <div className="selector-bar dash-controls">
            <div className="selector-main">
              <span className="type-toggle" role="group" aria-label="Dashboard view">
                {(["personal", "business", "all"] as View[]).map((v) => (
                  <button
                    key={v}
                    type="button"
                    className={view === v ? "type-option on" : "type-option"}
                    aria-pressed={view === v}
                    onClick={() => setView(v)}
                  >
                    {v === "all" ? "All" : v === "personal" ? "Personal" : "Business"}
                  </button>
                ))}
              </span>
              {view === "business" &&
                (businessProfiles.length > 0 ? (
                  <>
                    <label htmlFor="dash-business">Business</label>
                    <select
                      id="dash-business"
                      className="input selector-select"
                      value={businessId}
                      onChange={(e) => setBusinessId(e.target.value)}
                    >
                      {businessProfiles.map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                  </>
                ) : (
                  <span className="muted">No businesses yet</span>
                ))}
            </div>
            <div className="selector-main">
              <label htmlFor="dash-range">Dates</label>
              <select
                id="dash-range"
                className="input selector-select"
                value={preset}
                onChange={(e) => setPreset(e.target.value as RangePreset)}
              >
                <option value="all">All time</option>
                <option value="month">This month</option>
                <option value="lastMonth">Last month</option>
                <option value="days30">Last 30 days</option>
                <option value="custom">Custom range</option>
              </select>
              {preset === "custom" && (
                <>
                  <input
                    className="input date-input"
                    type="date"
                    aria-label="From date"
                    value={customFrom}
                    onChange={(e) => setCustomFrom(e.target.value)}
                  />
                  <input
                    className="input date-input"
                    type="date"
                    aria-label="To date"
                    value={customTo}
                    onChange={(e) => setCustomTo(e.target.value)}
                  />
                </>
              )}
            </div>
          </div>
          )}

          {!hasAnyTransactions ? null : scoped.length === 0 ? (
            <div className="card empty-state">
              <p>No records in this view for the selected dates.</p>
              <p className="muted">
                Records in other views or dates are not mixed in. Showing
                everything usually finds them.
              </p>
              <div className="row-actions">
                <button
                  className="btn ghost small"
                  type="button"
                  onClick={() => {
                    setView("all");
                    setPreset("all");
                  }}
                >
                  Show all records
                </button>
              </div>
            </div>
          ) : (
            <>
              {summaries.length > 0 ? (
                <section className="txn-summaries" aria-label="Summaries by currency">
                  {summaries.map((s) => (
                    <div key={s.currency} className="txn-summary">
                      <h2>{s.currency}</h2>
                      <dl>
                        <div><dt>Income</dt><dd className="amount-in">{formatMoney(s.income, s.currency)}</dd></div>
                        <div><dt>Expenses</dt><dd className="amount-out">{formatMoney(s.expense, s.currency)}</dd></div>
                        <div><dt>Net cash flow</dt><dd className={s.net < 0 ? "amount-out" : "amount-in"}>{formatMoney(s.net, s.currency)}</dd></div>
                      </dl>
                    </div>
                  ))}
                  <p className="muted txn-summary-note">
                    Net cash flow is recorded income minus recorded expenses for
                    the selected records. It is not a bank or account balance —
                    Bucketa only knows amounts you record here, including any
                    opening amount you choose to record as income.
                  </p>
                </section>
              ) : (
                <div className="card empty-state">
                  <p>No income or expense records in this selection.</p>
                  <p className="muted">Transfers and sales are listed under Recent but are not included in income/expense summaries.</p>
                </div>
              )}

              {summaries.length > 0 && (
                <>
                  <div className="selector-main chart-currency-row">
                    <span className="muted">Charts currency</span>
                    <span className="type-toggle" role="group" aria-label="Chart currency">
                      {summaries.map((s) => (
                        <button
                          key={s.currency}
                          type="button"
                          className={activeCurrency === s.currency ? "type-option on" : "type-option"}
                          aria-pressed={activeCurrency === s.currency}
                          onClick={() => setChartCurrency(s.currency)}
                        >
                          {s.currency}
                        </button>
                      ))}
                    </span>
                  </div>

                  <div className="chart-grid">
                    <section className="panel chart-panel" aria-labelledby="monthly-heading">
                      <h2 id="monthly-heading">Income vs expenses by month</h2>
                      {monthly.length === 0 ? (
                        <p className="muted">No income or expenses in {activeCurrency} for the selected dates.</p>
                      ) : (
                        <>
                          <div className="bar-chart" role="img" aria-label={`Monthly income and expenses in ${activeCurrency}`}>
                            {monthly.map((m) => (
                              <div key={m.month} className="bar-group">
                                <div className="bars">
                                  <div className="bar bar-in" style={{ height: `${Math.max(2, (m.income / maxMonthly) * 100)}%` }} title={`Income ${formatMoney(m.income, activeCurrency)}`} />
                                  <div className="bar bar-out" style={{ height: `${Math.max(2, (m.expense / maxMonthly) * 100)}%` }} title={`Expenses ${formatMoney(m.expense, activeCurrency)}`} />
                                </div>
                                <span className="bar-label">{monthLabel(m.month)}</span>
                              </div>
                            ))}
                          </div>
                          <p className="chart-legend muted">
                            <span className="legend-swatch swatch-in" /> Income
                            <span className="legend-swatch swatch-out" /> Expenses
                          </p>
                          <ul className="chart-values">
                            {monthly.map((m) => (
                              <li key={m.month}>
                                {monthLabel(m.month)}: {formatMoney(m.income, activeCurrency)} in ·{" "}
                                {formatMoney(m.expense, activeCurrency)} out
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                    </section>

                    <section className="panel chart-panel" aria-labelledby="category-heading">
                      <h2 id="category-heading">Expenses by category</h2>
                      {categories.length === 0 ? (
                        <p className="muted">
                          No expenses in {activeCurrency} for the selected dates, so
                          there is nothing to chart. Add an expense and it will
                          appear here by category.
                        </p>
                      ) : (
                        <div className="pie-wrap">
                          <svg className="pie" viewBox="0 0 100 100" role="img" aria-label={`Expense categories in ${activeCurrency}`}>
                            {slices.map((s) => (
                              <path key={s.category} d={s.path} fill={s.color}>
                                <title>{`${s.category}: ${formatMoney(s.total, activeCurrency)} (${s.pct.toFixed(1)}%)`}</title>
                              </path>
                            ))}
                          </svg>
                          <ul className="pie-legend">
                            {slices.map((s) => (
                              <li key={s.category}>
                                <span className="legend-swatch" style={{ background: s.color }} />
                                {s.category} — {formatMoney(s.total, activeCurrency)} ({s.pct.toFixed(1)}%)
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </section>
                  </div>
                </>
              )}

              <section className="panel txn-history" aria-labelledby="recent-heading">
                <div className="panel-head">
                  <h2 id="recent-heading">Recent transactions</h2>
                  <span className="count-badge">{recent.length} shown</span>
                </div>
                <ul className="txn-list">
                  {recent.map((txn) => (
                    <li key={txn.id} className="txn-row">
                      <div className="txn-main">
                        <strong>{txn.description}</strong>
                        <p className="muted bucket-meta">
                          {formatDate(txn.date)} · {profileName(txn.profileId)}
                          {txn.category ? ` · ${txn.category}` : ""}
                          {bucketName(txn.bucketId) ? ` · ${bucketName(txn.bucketId)}` : ""}
                        </p>
                      </div>
                      <span className={txn.type === "expense" ? "txn-amount amount-out" : "txn-amount amount-in"}>
                        {txn.type === "expense" ? "−" : "+"}{formatMoney(txn.amountMinor, txn.currency)}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            </>
          )}
        </>
      )}
    </section>
  );
}

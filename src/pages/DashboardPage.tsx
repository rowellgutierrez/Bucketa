import { useEffect, useMemo, useState } from "react";
import { bucketsRepo, employeesRepo, productsRepo, profilesRepo, salesRepo, transactionsRepo } from "../data/db";
import type { Bucket, Employee, Product, Profile, Sale, Transaction } from "../data/types";
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
import Card, { MetricCard } from "../components/ui/Card";
import PageHeader from "../components/ui/PageHeader";
import Icon from "../components/ui/Icon";
import { historyHref } from "../lib/historyScope";
import { onRecordsChanged } from "../lib/dataChange";
import TransactionRow from "../components/TransactionRow";

type Status = "loading" | "ready" | "error";
type View = "personal" | "business" | "all";
type RangePreset = "all" | "month" | "lastMonth" | "days30" | "custom";


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

export default function DashboardPage() {
  const [status, setStatus] = useState<Status>("loading");
  const [loadError, setLoadError] = useState("");
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [sales, setSales] = useState<Sale[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
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
      const [allProfiles, allBuckets, allTransactions, allProducts, allSales, allEmployees] = await Promise.all([
        profilesRepo.listAll(),
        bucketsRepo.listAll(),
        transactionsRepo.listAll(),
        productsRepo.listAll(),
        salesRepo.listAll(),
        employeesRepo.listAll(),
      ]);
      setProfiles(allProfiles);
      setBuckets(allBuckets);
      setTransactions(allTransactions);
      setProducts(allProducts);
      setSales(allSales);
      setEmployees(allEmployees);
      const firstBusiness = allProfiles.find((p) => p.kind === "business");
      if (firstBusiness) setBusinessId((prev) => prev || firstBusiness.id);
      setStatus("ready");
    } catch (error) {
      setStatus("error");
      setLoadError(errorMessage(error));
    }
  }

  /** Silent reload after a confirmed Bucky save: refreshes every figure
   * without flashing the page-level loading state. */
  async function refreshRecords() {
    try {
      const [allProfiles, allBuckets, allTransactions, allProducts, allSales, allEmployees] = await Promise.all([
        profilesRepo.listAll(),
        bucketsRepo.listAll(),
        transactionsRepo.listAll(),
        productsRepo.listAll(),
        salesRepo.listAll(),
        employeesRepo.listAll(),
      ]);
      setProfiles(allProfiles);
      setBuckets(allBuckets);
      setTransactions(allTransactions);
      setProducts(allProducts);
      setSales(allSales);
      setEmployees(allEmployees);
    } catch {
      // The saved record is already committed; Bucky's own updated
      // figures remain visible even if this refresh fails.
    }
  }

  useEffect(() => {
    void load();
  }, []);

  // Confirmed Bucky saves refresh every Home figure silently (no
  // page-level loading flash, view and date filters preserved).
  useEffect(() => onRecordsChanged(() => void refreshRecords()), []);

  const personalProfiles = profiles.filter((p) => p.kind === "personal");
  const businessProfiles = profiles.filter((p) => p.kind === "business");

  const scopedProfileIds = useMemo(() => {
    if (view === "personal") return new Set(personalProfiles.map((p) => p.id));
    if (view === "business") return new Set(businessId ? [businessId] : []);
    return new Set(profiles.map((p) => p.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, businessId, profiles]);

  const range = rangeFor(preset, customFrom, customTo);
  const fullHistoryHref = historyHref({ scope: view, profileId: businessId, from: range.from, to: range.to });
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
  const slices = useMemo(() => {
    const total = categories.reduce((sum, item) => sum + item.total, 0);
    return categories.map((item) => ({ ...item, pct: total > 0 ? item.total / total * 100 : 0 }));
  }, [categories]);
  const maxMonthly = Math.max(1, ...monthly.flatMap((m) => [m.income, m.expense]));
  const recent = useMemo(
    () =>
      [...scoped]
        .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))
        .slice(0, 3),
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
    <section className="page finance-page premium-dashboard home-page">
      <PageHeader className="home-header"
        title={personalProfiles[0] ? `Hello, ${personalProfiles[0].name}.` : "Welcome to Bucketa"}
        description="Smart Buckets — Everything in one bucket."
      />
      {status === "loading" && <Card className="loading-state" role="status">Loading Home…</Card>}
      {status === "error" && <Card className="feedback-error"><p className="alert-error" role="alert">Could not load Home: {loadError}</p><button className="btn" type="button" onClick={() => void load()}>Retry</button></Card>}
      {status === "ready" && <>
          <div className="selector-bar dash-controls">
            <div className="selector-main">
              <span className="type-toggle" role="group" aria-label="Home view">
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
      {hasAnyTransactions && scoped.length > 0 && <>
        {summaries.map((s) => <section key={s.currency} className="dashboard-metrics" aria-label={`Summary in ${s.currency}`}>
          <MetricCard icon="income" label="Income" value={formatMoney(s.income, s.currency)} detail="Selected dates" />
          <MetricCard icon="expenses" label="Expenses" value={formatMoney(s.expense, s.currency)} detail="Selected dates" />
          <MetricCard icon="personal" label="Net cash flow" value={formatMoney(s.net, s.currency)} detail="Income − expenses · not profit" />
          <MetricCard icon="transactions" label="Records" value={scoped.filter((t) => t.currency === s.currency).length} detail={s.currency} />
        </section>)}
        {summaries.length > 0 && <p className="muted dashboard-accounting-note">Net cash flow reflects recorded income minus expenses. It is not a bank balance or profit. Currencies are never combined.</p>}
      </>}

      <div className={hasAnyTransactions ? "dashboard-workspace home-layout" : "dashboard-workspace home-layout dashboard-workspace--empty"}>
        <div className="dashboard-aside">
          <BuckyPanel
            profiles={profiles}
            buckets={buckets}
            transactions={transactions}
            products={products}
            sales={sales}
            employees={employees}
            preferredProfileId={
              view === "business"
                ? businessId
                : view === "personal"
                  ? personalProfiles[0]?.id
                  : (personalProfiles[0]?.id ?? businessProfiles[0]?.id)
            }
          />
        </div>
        <div className="dashboard-main">
          {!hasAnyTransactions && <GettingStarted collapsed title="Build your financial picture" intro="Start with your personal money or a business. Your summaries will appear as you save real records." steps={startSteps} />}
          {hasAnyTransactions && scoped.length === 0 && <Card className="empty-state"><h2>No records in this view</h2><p className="muted">Try another profile or date range. Other records are kept separate.</p><button className="btn ghost" type="button" onClick={() => { setView("all"); setPreset("all"); }}>Show all records</button></Card>}
          {scoped.length > 0 && summaries.length === 0 && <Card className="overview-note"><h2>No income or expenses in this selection</h2><p className="muted">Savings movements, transfers, and sales appear in activity, separate from income and expense summaries.</p></Card>}
          <section className="home-explore" aria-labelledby="explore-heading">
            <h2 id="explore-heading">Explore Bucketa</h2>
            <div className="home-shortcuts">
              <a href="#/products"><span className="metric-icon"><Icon name="products" /></span><span>Products &amp; Inventory</span><Icon name="chevron" /></a>
              <a href="#/pos"><span className="metric-icon"><Icon name="pos" /></span><span>POS / Sales</span><Icon name="chevron" /></a>
              <a href="#/employees"><span className="metric-icon"><Icon name="employees" /></span><span>Employees</span><Icon name="chevron" /></a>
              <a href="#/scanner"><span className="metric-icon"><Icon name="scanner" /></span><span>Bucky Record Scanner</span><Icon name="chevron" /></a>
            </div>
          </section>
          {summaries.length > 0 && <>
            <div className="selector-main chart-currency-row"><span className="muted">Charts currency</span><span className="type-toggle" role="group" aria-label="Chart currency">{summaries.map((s) => <button key={s.currency} type="button" className={activeCurrency === s.currency ? "type-option on" : "type-option"} aria-pressed={activeCurrency === s.currency} onClick={() => setChartCurrency(s.currency)}>{s.currency}</button>)}</span></div>
            <Card className="dashboard-monthly" aria-labelledby="monthly-heading">
              <div className="panel-head"><h2 id="monthly-heading">Income vs Expenses</h2><span className="count-badge">{activeCurrency}</span></div>
              <p className="chart-legend muted"><span className="legend-swatch swatch-in" /> Income <span className="legend-swatch swatch-out" /> Expenses</p>
              {monthly.length === 0 ? <p className="muted">No income or expenses for the selected dates.</p> : <>
                <div className="chart-scroll" tabIndex={0} role="region" aria-label="Scrollable monthly chart"><div className="bar-chart" role="img" aria-label={`Monthly income and expenses in ${activeCurrency}; exact values below`}>
                  {monthly.map((m) => <div key={m.month} className="bar-group"><div className="bars"><div className="bar bar-in" style={{ height: `${Math.max(0, (m.income / maxMonthly) * 100)}%` }} title={`Income ${formatMoney(m.income, activeCurrency)}`} /><div className="bar bar-out" style={{ height: `${Math.max(0, (m.expense / maxMonthly) * 100)}%` }} title={`Expenses ${formatMoney(m.expense, activeCurrency)}`} /></div><span className="bar-label">{monthLabel(m.month)}</span></div>)}
                </div></div>
                <details className="chart-data"><summary>View exact monthly values</summary><ul className="chart-values">{monthly.map((m) => <li key={m.month}>{monthLabel(m.month)}: {formatMoney(m.income, activeCurrency)} income · {formatMoney(m.expense, activeCurrency)} expenses</li>)}</ul></details>
              </>}
            </Card>
            <Card className="dashboard-breakdown" aria-labelledby="category-heading"><div className="panel-head"><h2 id="category-heading">Expense Breakdown</h2><span className="count-badge">{activeCurrency}</span></div>
              {categories.length === 0 ? <p className="muted">No expenses in this currency for the selected dates.</p> : <ul className="expense-breakdown">{slices.map((s, i) => <li key={s.category}><div><strong>{s.category}</strong><span>{s.pct.toFixed(1)}%</span></div><div className="expense-track" aria-hidden="true"><span style={{ width: `${s.pct}%`, background: i % 2 ? "var(--bk-chart-secondary)" : "var(--bk-blue-600)" }} /></div><p>{formatMoney(s.total, activeCurrency)}</p></li>)}</ul>}
            </Card>
          </>}

        </div>
          {scoped.length > 0 && (
            <Card className="txn-history" aria-labelledby="recent-heading">
              <div className="panel-head">
                <div><p className="section-eyebrow">ACTIVITY</p><h2 id="recent-heading">Recent transactions</h2></div>
                <a className="btn ghost home-history-link" href={fullHistoryHref} aria-label="Open full transaction history for this selection"><Icon name="chevron" /></a>
              </div>
              <ul className="txn-list">
                {recent.map((txn) => (
                  <TransactionRow
                    key={txn.id}
                    txn={txn}
                    dateLabel={formatDate(txn.date)}
                    amountLabel={formatMoney(txn.amountMinor, txn.currency)}
                    meta={<>
                      <span>{profileName(txn.profileId)}</span>
                      {txn.category && <span>{txn.category}</span>}
                      {bucketName(txn.bucketId) && <span>{bucketName(txn.bucketId)}</span>}
                    </>}
                  />
                ))}
              </ul>
              <a className="dashboard-link home-see-more" href={fullHistoryHref}>See more <Icon name="chevron" /></a>
            </Card>
          )}
      </div>
      </>}
    </section>
  );
}

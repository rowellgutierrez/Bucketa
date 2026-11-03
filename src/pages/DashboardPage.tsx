import { useEffect, useMemo, useState } from "react";
import { bucketsRepo, employeesRepo, productsRepo, profilesRepo, salesRepo, transactionsRepo } from "../data/db";
import type { Bucket, Employee, Product, Profile, Sale, Transaction } from "../data/types";
import HomeBucky from "../components/HomeBucky";
import GettingStarted, { type StartStep } from "../components/GettingStarted";
import { DEFAULT_LOCALE } from "../config";
import { formatMoney, toMajorUnits } from "../lib/currency";
import {
  expenseByCategory,
  filterByDateRange,
  monthlyIncomeExpense,
  summarizeTransactions,
} from "../lib/finance";
import Card, { MetricCard } from "../components/ui/Card";
import PageHeader from "../components/ui/PageHeader";
import Icon from "../components/ui/Icon";
import { buildActivity, selectHistory, historyHref } from "../lib/historyScope";
import { onRecordsChanged } from "../lib/dataChange";
import TransactionRow from "../components/TransactionRow";
import { loadOwnerProfile, onOwnerProfileChanged, type OwnerProfile } from "../lib/ownerProfile";

type Status = "loading" | "ready" | "error";
type View = "personal" | "business" | "all";
type RangePreset = "all" | "month" | "lastMonth" | "days30" | "custom";

/** Rendering only: inputs are the existing scoped monthly/category totals. */
function MonthlyChart({months,currency}:{months:ReturnType<typeof monthlyIncomeExpense>;currency:string}) {
  const maximum=Math.max(1,...months.flatMap(m=>[m.income,m.expense]));
  const magnitude=Math.max(1,10**Math.floor(Math.log10(maximum/4)));
  const step=Math.ceil(([1,2,2.5,5,10].find(n=>n*magnitude>=maximum/4)??10)*magnitude);
  const tickCount=Math.max(1,Math.ceil(maximum*1.1/step));
  const ceiling=step*tickCount;
  const labelWidth=Math.max(...months.flatMap(m=>[formatMoney(m.income,currency).length,formatMoney(m.expense,currency).length]))*7;
  const left=Math.max(108,formatMoney(ceiling,currency).length*7+16),right=24;
  const width=Math.max(520,months.length*Math.max(180,labelWidth*2+36)+left+right), height=200;
  const top=28,bottom=38,plotHeight=height-top-bottom;
  const groupWidth=(width-left-right)/months.length;
  const barWidth=Math.min(64,groupWidth*.3),gap=Math.max(18,labelWidth-barWidth+12);
  return <><div className="finance-chart-scroll" tabIndex={0} role="region" aria-label="Monthly income and expenses chart; scroll for more months">
    <svg className="finance-bar-chart" viewBox={`0 0 ${width} ${height}`} style={{minWidth:months.length>2||labelWidth>90?width:460}} role="img" aria-labelledby="monthly-chart-title monthly-chart-desc">
      <title id="monthly-chart-title">Monthly income and expenses in {currency}</title>
      <desc id="monthly-chart-desc">Two bars per month using the selected profile and dates. Exact amounts are also listed below.</desc>
      {Array.from({length:tickCount+1},(_,tick)=>{const y=height-bottom-tick*plotHeight/tickCount;return <g key={tick}><line className="finance-gridline" x1={left} x2={width-right} y1={y} y2={y}/><text className="finance-axis-label" x={left-12} y={y+4} textAnchor="end">{formatMoney(step*tick,currency)}</text></g>;})}
      <line className="finance-axis" x1={left} x2={left} y1={top} y2={height-bottom}/>
      <line className="finance-axis" x1={left} x2={width-right} y1={height-bottom} y2={height-bottom}/>
      {months.map((month,index)=>{const center=left+groupWidth*(index+.5);return <g key={month.month}>
        {([{kind:'income',value:month.income,x:center-gap/2-barWidth},{kind:'expense',value:month.expense,x:center+gap/2}]).map(bar=>{const h=bar.value/ceiling*plotHeight,y=height-bottom-h;return <g key={bar.kind}><rect className={`finance-bar finance-bar--${bar.kind}`} x={bar.x} y={y} width={barWidth} height={h} rx={5}><title>{monthLabel(month.month)} · {bar.kind}: {formatMoney(bar.value,currency)}</title></rect><text className="finance-bar-value" x={bar.x+barWidth/2} y={y-9} textAnchor="middle">{formatMoney(bar.value,currency)}</text></g>;})}
        <text className="finance-month-label" x={center} y={height-16} textAnchor="middle">{monthLabel(month.month)}</text>
      </g>;})}
    </svg>
  </div><div className="finance-mobile-months">{months.map(month=><section className="finance-mobile-month" key={month.month} aria-label={monthLabel(month.month)}>
    <h3>{monthLabel(month.month)}</h3>
    <svg viewBox="0 0 280 180" role="img" aria-label={`Income ${formatMoney(month.income,currency)}, expenses ${formatMoney(month.expense,currency)}`}>
      {[0,.5,1].map(tick=><g key={tick}><line className="finance-gridline" x1={65} x2={270} y1={145-tick*125} y2={145-tick*125}/><text className="finance-axis-label" textAnchor="end" x={58} y={149-tick*125}>{new Intl.NumberFormat(DEFAULT_LOCALE,{notation:'compact',maximumFractionDigits:1}).format(toMajorUnits(Math.round(ceiling*tick),currency))}</text></g>)}
      <line className="finance-axis" x1={65} x2={270} y1={145} y2={145}/>
      <rect className="finance-bar--income" x={95} y={145-month.income/ceiling*125} width={55} height={month.income/ceiling*125} rx={5}/>
      <rect className="finance-bar--expense" x={185} y={145-month.expense/ceiling*125} width={55} height={month.expense/ceiling*125} rx={5}/>
      <text className="finance-month-label" x={122} y={170} textAnchor="middle">Income</text><text className="finance-month-label" x={212} y={170} textAnchor="middle">Expenses</text>
    </svg><dl><div><dt>Income</dt><dd>{formatMoney(month.income,currency)}</dd></div><div><dt>Expenses</dt><dd>{formatMoney(month.expense,currency)}</dd></div></dl>
  </section>)}</div></>;
}

function ExpenseDonut({categories,currency}:{categories:ReturnType<typeof expenseByCategory>;currency:string}) {
  const total=categories.reduce((sum,category)=>sum+category.total,0);
  if(total<=0)return <p className="muted">No recorded expenses in this currency for the selected dates.</p>;
  let offset=0;
  return <div className="finance-donut-layout"><div className="finance-donut">
    <svg viewBox="0 0 240 240" role="img" aria-labelledby="expense-donut-title"><title id="expense-donut-title">Expense breakdown in {currency}; category values and percentages follow</title>
      <circle cx={120} cy={120} r={94} className="finance-donut-track" fill="none" strokeWidth={35}/>
      {categories.map((category,index)=>{if(category.total<=0)return null;const percent=category.total/total*100,start=offset;offset+=percent;return <circle key={category.category} cx={120} cy={120} r={94} fill="none" stroke={`var(--bk-chart-${index%8})`} strokeWidth={35} pathLength={100} strokeDasharray={`${percent} ${100-percent}`} strokeDashoffset={-start} transform="rotate(-90 120 120)"><title>{category.category}: {formatMoney(category.total,currency)} ({percent.toFixed(1)}%)</title></circle>;})}
    </svg><div className="finance-donut-total"><strong>{formatMoney(total,currency)}</strong><span>Total recorded<br/>expenses</span></div>
    </div><ul className="finance-category-legend">{categories.map((category,index)=><li key={category.category}><span className="finance-category-swatch" style={{background:`var(--bk-chart-${index%8})`}} aria-hidden="true"/><span>{category.category}</span><strong>{formatMoney(category.total,currency)}</strong><span>{(category.total/total*100).toFixed(1)}%</span></li>)}</ul></div>;
}


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

function metricValue(value:string|number){const text=String(value);return <span className="home-metric-value" tabIndex={0} title={text} aria-label={text} style={{fontSize:'clamp(14px, calc(100cqi / '+Math.max(text.length,7)+' * 1.5), 26px)'}}>{text}</span>;}

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
  const [owner, setOwner] = useState<OwnerProfile>(() => loadOwnerProfile());
  useEffect(() => onOwnerProfileChanged(setOwner), []);
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
  const activity = useMemo(() => buildActivity(transactions, sales, profiles), [transactions, sales, profiles]);
  const scopedActivity = useMemo(() => selectHistory(activity, profiles, {scope:view,profileId:businessId,from:range.from,to:range.to}).records, [activity,profiles,view,businessId,range.from,range.to]);
  const recent = useMemo(
    () =>
      [...scopedActivity]
        .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))
        .slice(0, 3),
    [scopedActivity],
  );

  const profileName = (id: string) => profiles.find((p) => p.id === id)?.name ?? "Unknown";
  const bucketName = (id: string | null) =>
    id ? (buckets.find((b) => b.id === id)?.name ?? "Unknown bucket") : null;
  const hasAnyTransactions = activity.length > 0;

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
        title={owner.showGreeting && owner.firstName ? `Hello, ${owner.firstName}!` : personalProfiles[0] ? `Hello, ${personalProfiles[0].name.replace(/\p{L}/u, letter => letter.toLocaleUpperCase())}!` : "Welcome to Bucketa"}
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
                    <Icon name={v === "all" ? "buckets" : v === "personal" ? "personal" : "products"}/>
                    {v === "all" ? "All" : v === "personal" ? "Personal" : "Business"}
                  </button>
                ))}
              </span>
              {view === "business" &&
                (businessProfiles.length > 0 ? (
                  <select
                    id="dash-business"
                    aria-label="Business"
                    className="input selector-select"
                    value={businessId}
                    onChange={(e) => setBusinessId(e.target.value)}
                  >
                    {businessProfiles.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                ) : (
                  <span className="muted">No businesses yet</span>
                ))}
              <label className="sr-only" htmlFor="dash-range">Dates</label>
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
          <MetricCard icon="income" label="Income" value={metricValue(formatMoney(s.income, s.currency))} detail={s.currency} />
          <MetricCard icon="expenses" label="Expenses" value={metricValue(formatMoney(s.expense, s.currency))} detail={s.currency} />
          <MetricCard icon="personal" label="Net cash flow" value={metricValue(formatMoney(s.net, s.currency))} detail="Income − expenses · not profit" />
          <MetricCard icon="transactions" label="Records" value={metricValue(scoped.filter((t) => t.currency === s.currency).length)} detail={s.currency} />
        </section>)}
        {summaries.length > 0 && <p className="muted dashboard-accounting-note">Net cash flow reflects recorded income minus expenses. It is not a bank balance or profit. Currencies are never combined. POS sales appear in activity, separate from these transaction summaries.</p>}
      </>}

      <div className={hasAnyTransactions ? "dashboard-workspace home-layout" : "dashboard-workspace home-layout dashboard-workspace--empty"}>
        <div className="dashboard-aside">
          <HomeBucky
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
          {hasAnyTransactions && scopedActivity.length === 0 && <Card className="empty-state"><h2>No records in this view</h2><p className="muted">Try another profile or date range. Other records are kept separate.</p><button className="btn ghost" type="button" onClick={() => { setView("all"); setPreset("all"); }}>Show all records</button></Card>}
          {scopedActivity.length > 0 && summaries.length === 0 && <Card className="overview-note"><h2>No income or expenses in this selection</h2><p className="muted">Savings movements, transfers, and sales appear in activity, separate from income and expense summaries.</p></Card>}
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
                <MonthlyChart months={monthly} currency={activeCurrency}/>
                <details className="chart-data"><summary>View exact monthly values</summary><ul className="chart-values">{monthly.map((m) => <li key={m.month}>{monthLabel(m.month)}: {formatMoney(m.income, activeCurrency)} income · {formatMoney(m.expense, activeCurrency)} expenses</li>)}</ul></details>
              </>}
            </Card>
            <Card className="dashboard-breakdown" aria-labelledby="category-heading"><div className="panel-head"><h2 id="category-heading">Expense Breakdown</h2><span className="count-badge">{activeCurrency}</span></div>
              <ExpenseDonut categories={categories} currency={activeCurrency}/>
            </Card>
          </>}

        </div>
          {scopedActivity.length > 0 && (
            <Card className="txn-history" aria-labelledby="recent-heading">
              <div className="panel-head">
                <div><p className="section-eyebrow">ACTIVITY</p><h2 id="recent-heading">Recent activity</h2></div>
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
                      {txn.origin === "pos" && <span>Completed sale · read-only</span>}
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

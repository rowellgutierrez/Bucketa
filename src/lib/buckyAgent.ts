import type { Bucket, Employee, Product, Profile, Sale, Transaction } from "../data/types.ts";
import { bucketGoalProgress, expenseByCategory, monthlyIncomeExpense, summarizeTransactions } from "./finance.ts";
import { compensationTypeOf, paymentEmployeeName, type CompensationType } from "./employees.ts";
import { formatMoney } from "./currency.ts";

function money(minor: number, currency: string): string {
  try {
    return formatMoney(minor as never, currency);
  } catch {
    return `${currency} ${minor}`;
  }
}

/**
 * Bucky Financial Intelligence Engine (deterministic, no AI).
 *
 * Every figure here is computed in code from real Bucketa records, in
 * integer minor units, per currency. POS sales are reported as POS
 * revenue separately from transaction income so revenue is never
 * double-counted, and recorded cash flow is never labelled profit:
 * product cost of goods sold is not snapshotted on sale lines, so true
 * profit cannot be derived from stored data (see limitations).
 */

export type BuckySeverity = "info" | "attention" | "positive";

export interface BuckyEvidence {
  label: string;
  value: string;
}

export type BuckyAction =
  | { type: "navigate"; route: string; label: string }
  | { type: "scan"; recordType: "expenses" | "sales" | "salaries" | "financial records"; label: string };

export interface BuckyProposal {
  id: string;
  title: string;
  rationale: string;
  /** Bucky proposes; the user decides. Actions never mutate data. */
  action: BuckyAction;
}

export interface BuckyInsight {
  id: string;
  kind: "cash-flow" | "categories" | "month-change" | "duplicates" | "savings" | "inventory" | "pos" | "data-quality" | "salary";
  severity: BuckySeverity;
  title: string;
  detail: string;
  currency: string | null;
  evidence: BuckyEvidence[];
  proposalId: string | null;
}

export interface CurrencyIntelligence {
  currency: string;
  incomeMinor: number;
  expenseMinor: number;
  /** Recorded income minus recorded expenses. NOT profit and NOT a bank balance. */
  netCashFlowMinor: number;
  transactionCount: number;
  posRevenueMinor: number;
  posSaleCount: number;
  topExpenseCategories: { category: string; totalMinor: number }[];
  currentMonthExpenseMinor: number;
  previousMonthExpenseMinor: number;
  /** Expenses categorised as Salaries only. Bucky reports recorded salary
   * payments; it does not run payroll. */
  salaryExpenseMinor: number;
  salaryPaymentCount: number;
  /** Signed percent change vs previous month, or null when not comparable. */
  monthExpenseChangePct: number | null;
}

export interface BuckyAnalysis {
  profileId: string;
  profileName: string;
  profileKind: Profile["kind"];
  generatedAt: string;
  currencies: CurrencyIntelligence[];
  insights: BuckyInsight[];
  proposals: BuckyProposal[];
  duplicateGroups: { description: string; date: string; amountMinor: number; currency: string; count: number }[];
  lowStock: { productId: string; name: string; stock: number }[];
  /** Recorded salary/bonus/advance payments (expenses linked to an
   * employee by relatedId or by the name in the payment description).
   * Internal analysis data only — never sent to a model. */
  ambiguousEmployeeNames?: string[];
  compensationPayments: { employeeName: string; currency: string; amountMinor: number; date: string; type: CompensationType }[];
  limitations: string[];
  hasAnyData: boolean;
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, (m - 1) + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function analyzeBuckyFinances(input: {
  profile: Profile;
  buckets: Bucket[];
  transactions: Transaction[];
  products: Product[];
  sales: Sale[];
  employees?: Employee[];
  now?: Date;
}): BuckyAnalysis {
  const { profile } = input;
  const now = input.now ?? new Date();
  const generatedAt = now.toISOString();
  // Hard profile isolation: even if a caller passes mixed data, only this
  // profile's records are ever analysed.
  const transactions = input.transactions.filter((t) => t.profileId === profile.id);
  const employees = (input.employees ?? []).filter((e) => e.profileId === profile.id);
  const employeeById = new Map(employees.map((e) => [e.id, e]));
  const compensationPayments = transactions
    .filter((t) => compensationTypeOf(t) !== null)
    .map((t) => ({
      employeeName:
        paymentEmployeeName(t.description) ??
        (t.relatedId ? employeeById.get(t.relatedId)?.name ?? "Unnamed employee" : "Unnamed employee"),
      currency: t.currency,
      amountMinor: t.amountMinor,
      date: t.date.slice(0, 10),
      type: compensationTypeOf(t) ?? "salary",
    }));
  const products = input.products.filter((p) => p.profileId === profile.id);
  const sales = input.sales.filter((s) => s.profileId === profile.id);
  const buckets = input.buckets.filter((b) => b.profileId === profile.id);

  const limitations: string[] = [
    "Net cash flow is recorded income minus recorded expenses. It is not profit and not a bank balance.",
    "POS revenue is reported separately from transaction income so it is never double-counted.",
  ];
  if (sales.length > 0) {
    limitations.push(
      "True product profit cannot be calculated: sale lines snapshot selling prices, not purchase costs, so cost of goods sold is unknown.",
    );
  }

  const insights: BuckyInsight[] = [];
  const proposals: BuckyProposal[] = [];
  const addProposal = (p: BuckyProposal) => {
    if (!proposals.some((x) => x.id === p.id)) proposals.push(p);
    return p.id;
  };

  const summaries = summarizeTransactions(transactions);
  const currenciesSeen = new Set<string>([
    ...summaries.map((s) => s.currency),
    ...sales.map((s) => s.currency),
  ]);
  if (currenciesSeen.size === 0) currenciesSeen.add(profile.currency);

  // UTC consistently, matching shiftMonth: local-time month derivation
  // would disagree with the shifted previous month near month boundaries
  // depending on the device timezone.
  const currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const previousMonth = shiftMonth(currentMonth, -1);

  const currencies: CurrencyIntelligence[] = [...currenciesSeen].sort().map((currency) => {
    const summary = summaries.find((s) => s.currency === currency);
    const monthly = monthlyIncomeExpense(transactions, currency);
    const cur = monthly.find((m) => m.month === currentMonth);
    const prev = monthly.find((m) => m.month === previousMonth);
    const curExp = cur?.expense ?? 0;
    const prevExp = prev?.expense ?? 0;
    const changePct = prevExp > 0 ? ((curExp - prevExp) / prevExp) * 100 : null;
    const currencySales = sales.filter((s) => s.currency === currency);
    const salaryTxns = transactions.filter(
      (t) => t.currency === currency && t.type === "expense" && (t.category ?? "").trim().toLowerCase() === "salaries",
    );
    return {
      currency,
      incomeMinor: summary?.income ?? 0,
      expenseMinor: summary?.expense ?? 0,
      netCashFlowMinor: summary?.net ?? 0,
      transactionCount: transactions.filter((t) => t.currency === currency && (t.type === "income" || t.type === "expense")).length,
      posRevenueMinor: currencySales.reduce((sum, s) => sum + s.totalMinor, 0),
      posSaleCount: currencySales.length,
      topExpenseCategories: expenseByCategory(transactions, currency).slice(0, 3).map((c) => ({ category: c.category, totalMinor: c.total })),
      currentMonthExpenseMinor: curExp,
      previousMonthExpenseMinor: prevExp,
      salaryExpenseMinor: salaryTxns.reduce((sum, t) => sum + t.amountMinor, 0),
      salaryPaymentCount: salaryTxns.length,
      monthExpenseChangePct: changePct,
    };
  });

  if (currencies.some((c) => c.salaryPaymentCount > 0)) {
    limitations.push(
      "Salary figures come only from saved expenses categorised as Salaries. Bucky records and reports salary payments; it does not run payroll, compute deductions, or create payslips.",
    );
  }

  for (const c of currencies) {
    if (c.transactionCount > 0) {
      insights.push({
        id: `cash-flow-${c.currency}`,
        kind: "cash-flow",
        severity: c.netCashFlowMinor < 0 ? "attention" : "info",
        title: `${c.currency} cash flow`,
        detail: c.netCashFlowMinor < 0
          ? "Recorded expenses exceed recorded income in this currency."
          : "Recorded income covers recorded expenses in this currency.",
        currency: c.currency,
        evidence: [
          { label: "Income", value: money(c.incomeMinor, c.currency) },
          { label: "Expenses", value: money(c.expenseMinor, c.currency) },
          { label: "Net cash flow (not profit)", value: money(c.netCashFlowMinor, c.currency) },
        ],
        proposalId: addProposal({
          id: `open-records-${c.currency}`,
          title: `Review ${c.currency} records`,
          rationale: "Open the transaction history filtered to this profile to inspect the records behind these totals.",
          action: { type: "navigate", route: profile.kind === "business" ? "/transactions" : "/personal", label: "Open records" },
        }),
      });
    }
    if (c.monthExpenseChangePct !== null && c.monthExpenseChangePct >= 25 && c.currentMonthExpenseMinor > 0) {
      const top = c.topExpenseCategories[0];
      insights.push({
        id: `month-change-${c.currency}`,
        kind: "month-change",
        severity: "attention",
        title: `${c.currency} expenses rose ${c.monthExpenseChangePct.toFixed(0)}% this month`,
        detail: top
          ? `Compared with last month. The largest recorded expense category is ${top.category}; check it first before assuming a single cause.`
          : "Compared with last month.",
        currency: c.currency,
        evidence: [
          { label: "Last month expenses", value: money(c.previousMonthExpenseMinor, c.currency) },
          { label: "This month expenses", value: money(c.currentMonthExpenseMinor, c.currency) },
          ...(top ? [{ label: "Largest category", value: `${top.category}: ${money(top.totalMinor, c.currency)}` }] : []),
        ],
        proposalId: addProposal({
          id: `review-expenses-${c.currency}`,
          title: `Inspect ${c.currency} expenses`,
          rationale: "Review this month's expense records and categories before making changes.",
          action: { type: "navigate", route: profile.kind === "business" ? "/transactions" : "/personal", label: "Inspect expenses" },
        }),
      });
    }
    const uncategorised = transactions.filter((t) => t.profileId === profile.id && t.currency === c.currency && t.type === "expense" && !t.category?.trim());
    if (uncategorised.length >= 3) {
      insights.push({
        id: `uncategorised-${c.currency}`,
        kind: "data-quality",
        severity: "info",
        title: `${uncategorised.length} ${c.currency} expenses have no category`,
        detail: "Categorising them makes category analysis trustworthy.",
        currency: c.currency,
        evidence: [{ label: "Uncategorised expenses", value: String(uncategorised.length) }],
        proposalId: addProposal({
          id: `categorise-${c.currency}`,
          title: `Categorise ${c.currency} expenses`,
          rationale: "Open the records and add categories. Bucky suggests reviewing them; only you save changes.",
          action: { type: "navigate", route: profile.kind === "business" ? "/transactions" : "/personal", label: "Review categories" },
        }),
      });
    }
    if (c.salaryPaymentCount > 0) {
      // Per-person totals come from the recorded descriptions Bucky and
      // the manual/scanner flows write ("Salary payment — <name>").
      const byPerson = new Map<string, number>();
      for (const t of transactions) {
        if (t.currency !== c.currency || t.type !== "expense" || (t.category ?? "").trim().toLowerCase() !== "salaries") continue;
        const name = paymentEmployeeName(t.description);
        if (name) byPerson.set(name, (byPerson.get(name) ?? 0) + t.amountMinor);
      }
      insights.push({
        id: `salary-${c.currency}`,
        kind: "salary",
        severity: "info",
        title: `${c.currency} salary payments recorded as expenses`,
        detail: "Totals from saved expenses categorised as Salaries. This is recorded salary spending, not a payroll calculation.",
        currency: c.currency,
        evidence: [
          { label: "Salary payments", value: String(c.salaryPaymentCount) },
          { label: "Total salary expenses", value: money(c.salaryExpenseMinor, c.currency) },
          ...[...byPerson.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 4)
            .map(([name, total]) => ({ label: name, value: money(total, c.currency) })),
        ],
        proposalId: addProposal({
          id: `review-salaries-${c.currency}`,
          title: `Review ${c.currency} salary expenses`,
          rationale: "Open the records to inspect each recorded salary payment.",
          action: { type: "navigate", route: profile.kind === "business" ? "/transactions" : "/personal", label: "Review salaries" },
        }),
      });
    }
    if (c.posSaleCount > 0) {
      insights.push({
        id: `pos-${c.currency}`,
        kind: "pos",
        severity: "info",
        title: `${c.currency} POS revenue (separate from transaction income)`,
        detail: "Counted from completed POS sales only, so it is not double-counted with recorded transaction income.",
        currency: c.currency,
        evidence: [
          { label: "POS sales", value: String(c.posSaleCount) },
          { label: "POS revenue", value: money(c.posRevenueMinor, c.currency) },
        ],
        proposalId: addProposal({
          id: `open-pos-${c.currency}`,
          title: "Open Sales / POS",
          rationale: "Review completed sales and receipts.",
          action: { type: "navigate", route: "/pos", label: "Open POS" },
        }),
      });
    }
  }

  // Possible duplicates: income/expense only, exact deterministic key.
  const dupMap = new Map<string, BuckyAnalysis["duplicateGroups"][number]>();
  for (const t of transactions) {
    if (t.type !== "income" && t.type !== "expense") continue;
    const key = [t.description.trim().toLowerCase().replace(/\s+/g, " "), t.type, t.amountMinor, t.currency, t.date.slice(0, 10)].join("|");
    const existing = dupMap.get(key);
    if (existing) existing.count += 1;
    else dupMap.set(key, { description: t.description, date: t.date.slice(0, 10), amountMinor: t.amountMinor, currency: t.currency, count: 1 });
  }
  const duplicateGroups = [...dupMap.values()].filter((g) => g.count > 1);
  if (duplicateGroups.length > 0) {
    insights.push({
      id: "duplicates",
      kind: "duplicates",
      severity: "attention",
      title: `${duplicateGroups.length} possible duplicate ${duplicateGroups.length === 1 ? "group" : "groups"}`,
      detail: "Same description, type, amount, currency, and date. These may be legitimate repeat purchases — Bucky flags them, you decide.",
      currency: null,
      evidence: duplicateGroups.slice(0, 4).map((g) => ({ label: `${g.description} (${g.date})`, value: `×${g.count} · ${money(g.amountMinor, g.currency)}` })),
      proposalId: addProposal({
        id: "review-duplicates",
        title: "Review possible duplicates",
        rationale: "Open the records and check each flagged group. Bucky never deletes records.",
        action: { type: "navigate", route: profile.kind === "business" ? "/transactions" : "/personal", label: "Review duplicates" },
      }),
    });
  }

  for (const bucket of buckets) {
    const progress = bucketGoalProgress(transactions, bucket);
    if (!progress) continue;
    insights.push({
      id: `savings-${bucket.id}`,
      kind: "savings",
      severity: progress.percent >= 100 ? "positive" : "info",
      title: `${bucket.name}: ${progress.actualPercent.toFixed(0)}% of goal`,
      detail: progress.overTargetMinor > 0
        ? `Goal exceeded based on records assigned to this bucket — ${money(progress.overTargetMinor, bucket.currency)} above the target.`
        : progress.percent >= 100
          ? "Goal reached based on records assigned to this bucket."
          : "Progress from records assigned to this bucket, in its own currency only.",
      currency: bucket.currency,
      evidence: [
        { label: "Saved", value: money(progress.savedMinor, bucket.currency) },
        { label: "Goal", value: money(bucket.targetMinor ?? 0, bucket.currency) },
        ...(progress.overTargetMinor > 0
          ? [{ label: "Above target", value: money(progress.overTargetMinor, bucket.currency) }]
          : []),
      ],
      proposalId: null,
    });
  }

  const lowStock = products
    .filter((p) => p.status !== "archived" && p.stock <= 3)
    .sort((a, b) => a.stock - b.stock || a.name.localeCompare(b.name))
    .map((p) => ({ productId: p.id, name: p.name, stock: p.stock }));
  if (lowStock.length > 0) {
    insights.push({
      id: "low-stock",
      kind: "inventory",
      severity: lowStock.some((p) => p.stock === 0) ? "attention" : "info",
      title: `${lowStock.length} product${lowStock.length === 1 ? " is" : "s are"} low on stock`,
      detail: "Active products with 3 or fewer units left.",
      currency: null,
      evidence: lowStock.slice(0, 5).map((p) => ({ label: p.name, value: `${p.stock} left` })),
      proposalId: addProposal({
        id: "open-inventory",
        title: "Open Products and Inventory",
        rationale: "Check stock levels and decide whether to restock. Bucky does not order stock.",
        action: { type: "navigate", route: "/products", label: "Open inventory" },
      }),
    });
  }

  if (transactions.length === 0 && sales.length === 0) {
    limitations.push("No financial records exist for this profile yet, so no patterns can be identified.");
    insights.push({
      id: "empty",
      kind: "data-quality",
      severity: "info",
      title: "No records to analyse yet",
      detail: "Add a record manually or scan a handwritten record. Bucky only analyses real saved records and never invents data.",
      currency: profile.currency,
      evidence: [],
      proposalId: addProposal({
        id: "scan-first",
        title: "Scan a financial record",
        rationale: "Open the AI Record Scanner. Extracted entries still require your review and explicit save confirmation.",
        action: { type: "scan", recordType: "financial records", label: "Open scanner" },
      }),
    });
  }

  return {
    profileId: profile.id,
    profileName: profile.name,
    profileKind: profile.kind,
    generatedAt,
    currencies,
    insights,
    proposals,
    duplicateGroups,
    lowStock,
    compensationPayments,
    ambiguousEmployeeNames: [...new Set(employees.map(e => e.name.trim().toLowerCase()))].filter(name => employees.filter(e => e.name.trim().toLowerCase() === name).length > 1),
    limitations,
    hasAnyData: transactions.length > 0 || sales.length > 0 || products.length > 0,
  };
}

export interface BuckyAnswer {
  answer: string;
  facts: BuckyEvidence[];
  proposalIds: string[];
  /** True when the honest answer is that the data cannot support a finding. */
  insufficientData: boolean;
}

/** Deterministic question answering over a completed analysis. No model call. */
export function answerBuckyQuestion(question: string, analysis: BuckyAnalysis): BuckyAnswer {
  const original = question.toLowerCase().trim();
  const q = original.replace(/\b(nagastos|ginastos|gastos)\b/g, 'expenses').replace(/\bbenta\b/g, 'POS revenue').replace(/\b(ipon|naipon)\b/g, 'savings').replace(/\b(imbentaryo|produkto)\b/g, 'inventory').toLowerCase();
  const pick = (kind: BuckyInsight["kind"]) => analysis.insights.find((i) => i.kind === kind);
  const insufficient = (msg: string): BuckyAnswer => ({ answer: msg, facts: [], proposalIds: [], insufficientData: true });

  if (!analysis.hasAnyData) {
    return insufficient(`I don't have any saved records for ${analysis.profileName} yet, so I can't identify patterns. Add or scan a record first, then ask me again.`);
  }
  if (/salary rate|configured rate|agreed rate|tax|deduction|amount owed|payroll calculation/.test(q)) return insufficient('I can report recorded employee payments, not payroll calculations or amounts owed. Review configured rates and payment history in Employees.');
  if (/\b(profit|net income|tubo|kita|kinita)\b/.test(q)) return insufficient('I can report recorded income, expenses, cash flow, and POS revenue. These records do not establish profit or a bank balance.');
  if (/\b(best|top|most|highest)\b.*\b(products?|sold|sales?)\b|\bproducts?\b.*\b(best|sold most)\b/.test(q)) return insufficient('I can report completed POS revenue and low stock, but I cannot reliably rank product performance yet.');
  if (/inventory.*(?:value|valuation)|(?:value|valuation).*inventory/.test(q)) return insufficient('I can report low stock, but inventory valuation is not supported by this answer path.');
  const totalIncome = /\b(income|earned|earnings)\b/.test(q);
  const totalExpense = /\b(expenses?|spent|spending)\b/.test(q) && !/why|increase|decrease|trend|category|categories|biggest|largest/.test(q);
  const totalSales = /\b(sales?|pos|revenue|sell|sold)\b/.test(q);
  const dateQualified = /\b(today|yesterday|this (?:week|month|year)|last (?:week|month|year)|january|february|march|april|june|july|august|september|october|november|december|20\d{2}|ngayon|kahapon|buwan|linggo|taon)\b/.test(q) || /\b(?:in|for|during)\s+may\b|\b(?:last|past)\s+\d+\s+(?:days|weeks|months|years)\b/.test(q);
  if ((totalIncome || totalExpense || totalSales || /cash flow/.test(q)) && dateQualified && !/salary|salaries|payroll|bonus|advance|employee|why|trend|increas/.test(q)) {
    return insufficient('I cannot reliably apply that date range to this question yet. Use the date filters in Transactions or Sales / POS, or ask for an all-time total.');
  }
  if ((totalIncome || totalExpense || totalSales) && !/salary|salaries|payroll|bonus|advance|employee|saving|goal|bucket|duplicate|twice|double|stock|inventory|product|why|trend|increase|decrease|category|categories|largest|biggest/.test(q)) {
    if (totalSales && !analysis.currencies.some(c => c.posSaleCount > 0)) return insufficient('No completed POS sales are recorded for this profile yet.');
    const metrics: {label:string; key:'incomeMinor'|'expenseMinor'|'posRevenueMinor'}[] = [];
    if (totalIncome) metrics.push({label:'Recorded income',key:'incomeMinor'});
    if (totalExpense) metrics.push({label:'Recorded expenses',key:'expenseMinor'});
    if (totalSales) metrics.push({label:'POS revenue',key:'posRevenueMinor'});
    const facts = analysis.currencies.flatMap(c => metrics.map(metric => ({label:metric.label+(analysis.currencies.length>1?' ('+c.currency+')':''),value:money(c[metric.key],c.currency)})));
    if (!facts.length) return insufficient('No matching financial records are saved for this profile yet.');
    return {answer:'All-time recorded totals for '+analysis.profileName+'. POS revenue is separate from recorded income. Savings movements are not income or expenses.',facts,proposalIds:[],insufficientData:false};
  }
  if (/duplicate|twice|double/.test(q)) {
    const i = pick("duplicates");
    if (!i) return { answer: "I checked for records with the same description, type, amount, currency, and date and found no possible duplicate groups.", facts: [], proposalIds: [], insufficientData: false };
    return { answer: `${i.title}. ${i.detail}`, facts: i.evidence, proposalIds: i.proposalId ? [i.proposalId] : [], insufficientData: false };
  }
  if (/stock|inventory|restock|product/.test(q)) {
    const i = pick("inventory");
    if (!i) return { answer: "No active products are at 3 or fewer units, based on current recorded stock.", facts: [], proposalIds: [], insufficientData: false };
    return { answer: `${i.title}. ${i.detail}`, facts: i.evidence, proposalIds: i.proposalId ? [i.proposalId] : [], insufficientData: false };
  }
  if (
    /salary|salaries|wage|payroll|bonus|advance/.test(q)
    || /\b(employee|employees)\b/.test(q)
    || /\b(?:did i pay|have i paid)\b/.test(q)
    || (/\b(pay|paid|paying)\b/.test(q)
      && analysis.compensationPayments.some((p) => q.includes(p.employeeName.toLowerCase())))
  ) {
    const payments = analysis.compensationPayments;
    if (payments.length === 0) return insufficient("No salary, bonus, or advance payments are recorded for this profile yet, so I can't report them.");
    const moneyOf = (amount: number, currency: string) => money(amount, currency);
    const totalsBy = (list: typeof payments) => {
      const byCurrency = new Map<string, number>();
      for (const p of list) byCurrency.set(p.currency, (byCurrency.get(p.currency) ?? 0) + p.amountMinor);
      return [...byCurrency.entries()].map(([currency, total]) => ({ label: currency, value: moneyOf(total, currency) }));
    };
    // One named person: "How much did I pay Roger (this month)?"
    const names = [...new Set(payments.map((p) => p.employeeName))];
    if (/today|yesterday|this week|last week|last month|last year/.test(q)) return insufficient("That payment date range is not supported here. Use Employees payment history to review the dates.");
    const namedPerson = names.find((n) => q.includes(n.toLowerCase()));
    if (!namedPerson && /\b(?:did i pay|have i paid)\s+(?!in\b|for\b|on\b|this\b|salary\b|salaries\b|employees\b)([\w'-]+)\b/.test(q)) return insufficient("I could not match that employee name to recorded payments in this profile.");
    if (!namedPerson && /this month/.test(q)) return insufficient("Ask for one employee by name this month, or a named month of salary expenses.");
    if (namedPerson && analysis.ambiguousEmployeeNames?.includes(namedPerson.trim().toLowerCase())) return insufficient("More than one employee has that name. Open Employees and choose the specific employee payment history.");
    if (namedPerson) {
      const paymentType = /bonus/.test(q) ? "bonus" : /advance/.test(q) ? "advance" : /salary|salaries/.test(q) ? "salary" : null;
      const mine = payments.filter((p) => p.employeeName === namedPerson && (!paymentType || p.type === paymentType));
      const thisMonth = /this month/.test(q);
      const scoped = thisMonth
        ? mine.filter((p) => p.date.slice(0, 7) === analysis.generatedAt.slice(0, 7))
        : mine;
      if (scoped.length === 0) {
        return insufficient(`No matching recorded payments to ${namedPerson}${thisMonth ? " this month" : ""}.`);
      }
      return {
        answer: `You paid ${namedPerson} ${totalsBy(scoped).map((f) => f.value).join(" and ")} across ${scoped.length} recorded payment${scoped.length === 1 ? "" : "s"}${thisMonth ? " this month" : ""}. These are recorded salary/bonus/advance expenses, not a payroll calculation.`,
        facts: totalsBy(scoped),
        proposalIds: [],
        insufficientData: false,
      };
    }
    // One named month: "Show my salary expenses for November."
    const monthNames = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
    const monthIndex = monthNames.findIndex((m) => q.includes(m));
    if (monthIndex >= 0) {
      const yearMatch = /\b(20\d{2})\b/.exec(q);
      const salaryOnly = payments.filter(
        (p) => p.type === "salary"
          && Number(p.date.slice(5, 7)) === monthIndex + 1
          && (!yearMatch || p.date.startsWith(yearMatch[1])),
      );
      if (salaryOnly.length === 0) {
        return insufficient(`No salary expenses are recorded for ${monthNames[monthIndex][0].toUpperCase()}${monthNames[monthIndex].slice(1)}${yearMatch ? ` ${yearMatch[1]}` : ""} yet.`);
      }
      const latest = [...salaryOnly].sort((a, b) => b.date.localeCompare(a.date))[0];
      return {
        answer: `Recorded salary expenses for ${latest.date.slice(0, 7)} total ${totalsBy(salaryOnly).map((f) => f.value).join(" and ")} across ${salaryOnly.length} payment${salaryOnly.length === 1 ? "" : "s"}. Bonuses and advances are not included in this salary-only total.`,
        facts: totalsBy(salaryOnly),
        proposalIds: [],
        insufficientData: false,
      };
    }
    // Highest recorded payments.
    if (/highest|most|top/.test(q)) {
      if (analysis.ambiguousEmployeeNames?.length) return insufficient("Some employee names are repeated. Compare their individual records in Employees payment history instead.");
      if (new Set(payments.map(p => p.currency)).size > 1) return insufficient("These payments use different currencies, so I cannot rank them together without an exchange-rate policy.");
      const byPerson = new Map<string, { currency: string; total: number; count: number }>();
      for (const p of payments) {
        const key = `${p.employeeName}|${p.currency}`;
        const entry = byPerson.get(key) ?? { currency: p.currency, total: 0, count: 0 };
        entry.total += p.amountMinor;
        entry.count += 1;
        byPerson.set(key, entry);
      }
      const ranked = [...byPerson.entries()]
        .map(([key, v]) => ({ name: key.split("|")[0], ...v }))
        .sort((a, b) => b.total - a.total);
      const top = ranked[0];
      return {
        answer: `${top.name} received the highest recorded payments: ${moneyOf(top.total, top.currency)} across ${top.count} payment${top.count === 1 ? "" : "s"}.`,
        facts: ranked.slice(0, 4).map((r) => ({ label: r.name, value: moneyOf(r.total, r.currency) })),
        proposalIds: [],
        insufficientData: false,
      };
    }
    const salaryInsights = analysis.insights.filter((i) => i.kind === "salary");
    if (salaryInsights.length === 0) return insufficient("No expenses categorised as Salaries are recorded for this profile yet, so I can't report salary payments.");
    return {
      answer: salaryInsights.map((i) => `${i.title}. ${i.detail}`).join(" "),
      facts: salaryInsights.flatMap((i) => i.evidence),
      proposalIds: salaryInsights.map((i) => i.proposalId).filter((x): x is string => Boolean(x)),
      insufficientData: false,
    };
  }
  if (/expense|spending|cost|increase|why/.test(q)) {
    const i = pick("month-change") ?? pick("categories") ?? analysis.insights.find((x) => x.kind === "cash-flow");
    if (!i) return insufficient("There isn't enough dated expense history to explain spending changes yet.");
    if (i.kind === "month-change") {
      return { answer: `${i.title}. ${i.detail} These figures are computed from your recorded expenses; a rise can reflect more records saved this month, not only higher prices.`, facts: i.evidence, proposalIds: i.proposalId ? [i.proposalId] : [], insufficientData: false };
    }
    return { answer: `${i.title}. ${i.detail}`, facts: i.evidence, proposalIds: i.proposalId ? [i.proposalId] : [], insufficientData: false };
  }
  if (/sale|pos|revenue|sell/.test(q)) {
    const i = pick("pos");
    if (!i) return insufficient("No completed POS sales are recorded for this profile yet, so I can't report POS revenue.");
    return { answer: `${i.title}. ${i.detail}`, facts: i.evidence, proposalIds: i.proposalId ? [i.proposalId] : [], insufficientData: false };
  }
  if (/saving|saved|goal|bucket/.test(q)) {
    const savingsInsights = analysis.insights.filter((i) => i.kind === "savings");
    if (savingsInsights.length === 0) return insufficient("No bucket with a savings goal has progress to report for this profile yet.");
    // Named-goal questions ("How is my iPhone goal doing?") resolve to that
    // goal; insight titles start with the bucket name.
    const named = savingsInsights.find((i) =>
      original.includes(i.title.split(":")[0].trim().toLowerCase()),
    );
    if (named) return { answer: `${named.title}. ${named.detail}`, facts: named.evidence, proposalIds: [], insufficientData: false };
    const explicitGoal = /\b(?:my|the)\s+(.+?)\s+(?:savings?\s+goal|goal|bucket)\b/.exec(q)?.[1];
    const filipinoTarget = /\b(?:para sa|sa)\s+([^?.!]+)/.exec(original)?.[1]?.trim();
    if (filipinoTarget) return insufficient("I could not match that savings goal in this profile. Ask using its exact name.");
    if (explicitGoal && !/^(savings?|financial|personal|business)$/.test(explicitGoal)) return insufficient('I could not match that savings goal in this profile. Ask using its exact name.');
    if (savingsInsights.length === 1) {
      const i = savingsInsights[0];
      return { answer: `${i.title}. ${i.detail}`, facts: i.evidence, proposalIds: [], insufficientData: false };
    }
    return {
      answer: `You have ${savingsInsights.length} savings goals: ${savingsInsights.map((i) => i.title).join("; ")}. Ask about one by name for its details.`,
      facts: savingsInsights.flatMap((i) => i.evidence),
      proposalIds: [],
      insufficientData: false,
    };
  }
  if (/cash\s*flow|financial summary|overview|how am i doing|how is my business doing|net cash/.test(q)) {
    const cash = analysis.insights.filter((i) => i.kind === "cash-flow");
    if (cash.length === 0) return insufficient("There are no income or expense records to summarise yet.");
    return {
      answer: cash.map((i) => `${i.title}: ${i.detail}`).join(" "),
      facts: cash.flatMap((i) => i.evidence),
      proposalIds: cash.map((i) => i.proposalId).filter((x): x is string => Boolean(x)),
      insufficientData: false,
    };
  }
  return {
    answer: "I can explain expenses, cash flow, possible duplicates, savings goals, POS revenue, and low stock for this profile. Try: “Why are my expenses increasing?”",
    facts: [],
    proposalIds: [],
    insufficientData: true,
  };
}

/** Aggregated summary safe to send to a model: totals and counts only, no raw records. */
export function buildBuckyModelSummary(analysis: BuckyAnalysis) {
  return {
    profileName: analysis.profileName,
    profileKind: analysis.profileKind,
    currencies: analysis.currencies.map((c) => ({
      currency: c.currency,
      incomeMinor: c.incomeMinor,
      expenseMinor: c.expenseMinor,
      netCashFlowMinor: c.netCashFlowMinor,
      transactionCount: c.transactionCount,
      posRevenueMinor: c.posRevenueMinor,
      posSaleCount: c.posSaleCount,
      topExpenseCategories: c.topExpenseCategories,
      monthExpenseChangePct: c.monthExpenseChangePct,
    })),
    insightKinds: analysis.insights.map((i) => i.kind),
    duplicateGroupCount: analysis.duplicateGroups.length,
    lowStockCount: analysis.lowStock.length,
    limitations: analysis.limitations,
  };
}

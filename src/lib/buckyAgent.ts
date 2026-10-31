import type { Bucket, Employee, Product, Profile, Sale, Transaction } from "../data/types.ts";
import { bucketGoalProgress, expenseByCategory, monthlyIncomeExpense, summarizeTransactions } from "./finance.ts";
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
  kind: "cash-flow" | "categories" | "month-change" | "duplicates" | "savings" | "inventory" | "pos" | "data-quality";
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
      monthExpenseChangePct: changePct,
    };
  });

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
      title: `${bucket.name}: ${progress.percent.toFixed(0)}% of goal`,
      detail: progress.percent >= 100 ? "Goal reached based on records assigned to this bucket." : "Progress from records assigned to this bucket, in its own currency only.",
      currency: bucket.currency,
      evidence: [
        { label: "Saved", value: money(progress.savedMinor, bucket.currency) },
        { label: "Goal", value: money(bucket.targetMinor ?? 0, bucket.currency) },
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
  const q = question.toLowerCase();
  const pick = (kind: BuckyInsight["kind"]) => analysis.insights.find((i) => i.kind === kind);
  const insufficient = (msg: string): BuckyAnswer => ({ answer: msg, facts: [], proposalIds: [], insufficientData: true });

  if (!analysis.hasAnyData) {
    return insufficient(`I don't have any saved records for ${analysis.profileName} yet, so I can't identify patterns. Add or scan a record first, then ask me again.`);
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
  if (/saving|goal|bucket/.test(q)) {
    const i = pick("savings");
    if (!i) return insufficient("No bucket with a savings goal has progress to report for this profile yet.");
    return { answer: `${i.title}. ${i.detail}`, facts: i.evidence, proposalIds: [], insufficientData: false };
  }
  if (/cash|summary|how|overview|doing/.test(q)) {
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
    facts: analysis.insights.slice(0, 3).flatMap((i) => i.evidence),
    proposalIds: [],
    insufficientData: false,
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

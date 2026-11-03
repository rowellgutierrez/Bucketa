import type { Bucket, Employee, Product, Profile, Sale, Transaction } from "../data/types.ts";
import { parseAmountToMinorUnits } from "./currency.ts";

/**
 * Bucky app-wide action registry (Phase C). Every entry only *proposes*;
 * BuckyPanel shows a preview and, after explicit confirmation, executes
 * through the existing validated repositories. No arbitrary code, no OS
 * or network access, no writes without confirmation. Stable proposal IDs
 * make a repeated confirmation a no-op (duplicate protection).
 */

export type AppActionKind = "create-employee" | "adjust-stock" | "create-bucket" | "pos-cart-add";

export interface AppActionContext {
  profile: Profile;
  products: Product[];
  employees: Employee[];
  buckets: Bucket[];
  today: string;
  createId: () => string;
}

interface BaseProposal { id: string; profileId: string; profileName: string; currency: string; warnings: string[] }
export interface ProposedEmployee extends BaseProposal { kind: "create-employee"; name: string; role: string | null; salaryRateMinor?: number; salaryFrequency?: Employee["salaryFrequency"] }
export interface ProposedStock extends BaseProposal { kind: "adjust-stock"; productId: string; productName: string; delta: number; currentStock: number; newStock: number }
export interface ProposedBucketCreate extends BaseProposal { kind: "create-bucket"; name: string; targetMinor: number | null }
export interface ProposedPosCart extends BaseProposal { kind: "pos-cart-add"; productId: string; productName: string; quantity: number; unitPriceMinor: number }

export type AppActionProposal = ProposedEmployee | ProposedStock | ProposedBucketCreate | ProposedPosCart;
export type AppActionInterpretation =
  | { status: "proposal"; action: AppActionProposal }
  | { status: "clarification"; question: string }
  | { status: "not-action" };

export const APP_ACTION_REGISTRY: { kind: AppActionKind; title: string; risk: "write"; requiresConfirmation: true }[] = [
  { kind: "create-employee", title: "Add employee", risk: "write", requiresConfirmation: true },
  { kind: "adjust-stock", title: "Adjust stock", risk: "write", requiresConfirmation: true },
  { kind: "create-bucket", title: "Create savings bucket", risk: "write", requiresConfirmation: true },
  { kind: "pos-cart-add", title: "Add to POS cart", risk: "write", requiresConfirmation: true },
];

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

function cleanName(raw: string): string {
  return raw.replace(/[.!?]+$/g, "").replace(/\s+/g, " ").replace(/^(the|a|an|my)\s+/i, "").trim();
}
function titleCase(v: string): string { return v ? v.charAt(0).toUpperCase() + v.slice(1) : v; }

function matchProduct(text: string, products: Product[], profileId: string): Product | null {
  const lower = text.toLowerCase();
  const own = products.filter((p) => p.profileId === profileId && p.status !== "archived");
  const exact = own.filter((p) => lower.includes(p.name.trim().toLowerCase()));
  if (exact.length) return [...exact].sort((a, b) => b.name.length - a.name.length)[0];
  // Singular/plural tolerance: "burgers" -> "Burger".
  for (const p of own) {
    const base = p.name.trim().toLowerCase();
    if (lower.includes(base + "s") || lower.includes(base.replace(/s$/, ""))) return p;
    const tokens = base.split(/\s+/).filter((t) => t.length >= 3);
    if (tokens.length && tokens.every((t) => lower.includes(t) || lower.includes(t + "s"))) return p;
  }
  return null;
}

function parseQuantity(text: string): number {
  const digit = /\b(\d{1,4})\b/.exec(text);
  if (digit) { const n = Number(digit[1]); if (Number.isInteger(n) && n > 0) return n; }
  for (const [word, n] of Object.entries(NUMBER_WORDS)) if (new RegExp(`\\b${word}\\b`, "i").test(text)) return n;
  return 1;
}

/** Resolve a profile explicitly named in text. Longest exact name wins;
 * a tie between different profiles is ambiguous; a captured "<name>
 * business" that matches nothing is reported, never guessed. */
export type ProfileResolution =
  | { status: "matched"; profile: Profile }
  | { status: "ambiguous"; profiles: Profile[] }
  | { status: "named-missing"; name: string }
  | { status: "none" };
export function resolveNamedProfile(text: string, profiles: Profile[]): ProfileResolution {
  const lower = ` ${text.toLowerCase().replace(/\s+/g, " ")} `;
  const hits = profiles.filter((p) => p.name.trim() && lower.includes(p.name.trim().toLowerCase()));
  if (hits.length) {
    const longest = Math.max(...hits.map((p) => p.name.trim().length));
    const top = hits.filter((p) => p.name.trim().length === longest);
    const distinct = [...new Map(top.map((p) => [p.id, p])).values()];
    return distinct.length === 1 ? { status: "matched", profile: distinct[0] } : { status: "ambiguous", profiles: distinct };
  }
  const mentioned = /(?:under|for|in|to)\s+(?:my\s+|the\s+)?([a-z0-9][a-z0-9 '&-]{1,40}?)\s+business\b/i.exec(text)
    ?? /\b(?:my|the)\s+([a-z0-9][a-z0-9 '&-]{1,40}?)\s+business\b/i.exec(text)
    ?? /\bbusiness\s+(?:called|named)\s+([a-z0-9][a-z0-9 '&-]{1,40})/i.exec(text);
  if (mentioned) {
    const name = mentioned[1].trim().replace(/\s+/g, " ");
    if (name && !/^(this|that|my|the|a|an)$/i.test(name)) return { status: "named-missing", name };
  }
  return { status: "none" };
}

/** "Add employee Roger" / "Add employee named Maria Santos as Cashier". Business only. */
export function interpretEmployeeCommand(text: string, ctx: AppActionContext): AppActionInterpretation {
  const raw = text.trim();
  if (!/\b(add|create)\b[^.?!]*\bemployee\b/i.test(raw) && !/\bemployee\s+(named|called)\b/i.test(raw) && !/\badd\b[^.?!]*\bemployee\s+record\b/i.test(raw)) return { status: "not-action" };
  if (ctx.profile.kind !== "business") return { status: "clarification", question: `Employees belong to a business profile, and "${ctx.profile.name}" is a personal profile. Name the business (for example "under my Bibingka business") or switch Bucky to it — nothing was created.` };
  // Optional salary: "monthly salary is PHP 15,000" / "salary PHP 15,000 a month".
  let salaryRateMinor: number | undefined;
  let salaryFrequency: Employee["salaryFrequency"] | undefined;
  const salaryMatch = /\b(hourly|daily|weekly|biweekly|monthly)?\s*salary\s*(?:is|:|of)?\s*(PHP|USD|EUR|GBP|JPY|AUD|CAD|SGD)?\s*[₱$€£]?\s*(\d[\d,]*(?:\.\d{1,2})?)/i.exec(raw)
    ?? /\bsalary\s*(?:is|:)?\s*[₱$€£]?\s*(\d[\d,]*(?:\.\d{1,2})?)\s*(?:a|per)\s+(hour|day|week|month)/i.exec(raw);
  if (salaryMatch) {
    const code = (salaryMatch[2] ?? "").toUpperCase();
    if (code && code !== ctx.profile.currency.toUpperCase()) return { status: "clarification", question: `That salary is in ${code}, but "${ctx.profile.name}" uses ${ctx.profile.currency}. Bucky never converts currencies — restate the salary in ${ctx.profile.currency} or name the matching business. Nothing was created.` };
    try { salaryRateMinor = parseAmountToMinorUnits(salaryMatch[salaryMatch.length - 1].replace(/,/g, ""), ctx.profile.currency); } catch { salaryRateMinor = undefined; }
    const freqWord = (salaryMatch[1] ?? salaryMatch[salaryMatch.length - 1] ?? "").toLowerCase();
    salaryFrequency = /month/.test(freqWord) || /\bmonthly\b/i.test(raw) ? "monthly" : /week/.test(freqWord) ? "weekly" : /day/.test(freqWord) ? "daily" : /hour/.test(freqWord) ? "hourly" : salaryRateMinor !== undefined ? "monthly" : undefined;
    if (salaryRateMinor !== undefined && !salaryFrequency) salaryFrequency = "monthly";
  }
  const withoutSalary = salaryMatch ? raw.replace(salaryMatch[0], " ") : raw;
  const withoutBusiness = withoutSalary.replace(/\b(?:under|for|in|to)\s+(?:my\s+|the\s+)?[^,.]+?\s+business\b/i, " ");
  const roleMatch = /\bas\s+(?:a\s+|an\s+)?(.+?)\s*$/i.exec(withoutBusiness);
  const role = roleMatch && !/salary/i.test(roleMatch[1]) ? titleCase(cleanName(roleMatch[1])) : null;
  let name = "";
  const nameIs = /\bname\s+is\s+([^,.]+?)(?:,|\band\b|\bwith\b|$)/i.exec(withoutBusiness)
    ?? /\b(?:named|called)\s+([^,.]+?)(?:,|\band\b|\bas\b|\bwith\b|$)/i.exec(withoutBusiness);
  if (nameIs) name = titleCase(cleanName(nameIs[1]));
  if (!name) {
    let rest = withoutBusiness.replace(/\b(add|create)\b/i, " ").replace(/\bemployee\b/i, " ").replace(/\brecord\b/i, " ").replace(/\b(named|called)\b/i, " ").replace(/\bplease\b/gi, " ").replace(/\b(?:his|her|their)\s+name\s+is\b/i, " ");
    if (roleMatch) rest = rest.replace(roleMatch[0], " ");
    name = titleCase(cleanName(rest.replace(/\bas\s+.+$/i, " ").replace(/^[^A-Za-z]+/, "")));
  }
  if (!name || name.length < 2 || /^(under|for|my|the)$/i.test(name)) return { status: "clarification", question: "What's the employee's name? For example: \"Add employee Michael Anzures under my Bibingka business, monthly salary PHP 15,000\". Nothing was created." };
  const warnings: string[] = [];
  if (ctx.employees.some((e) => e.profileId === ctx.profile.id && e.name.trim().toLowerCase() === name.toLowerCase() && e.status === "active")) warnings.push(`An active employee named "${name}" already exists in this business. Confirming will add another record with that name.`);
  return { status: "proposal", action: { kind: "create-employee", id: ctx.createId(), profileId: ctx.profile.id, profileName: ctx.profile.name, currency: ctx.profile.currency, name, role, ...(salaryRateMinor !== undefined ? { salaryRateMinor, salaryFrequency: salaryFrequency ?? "monthly" } : {}), warnings } };
}

/** "Increase Hakdog stock by 10" / "Add 10 stock to Hakdog" / "Restock Hakdog by 5". */
export function interpretStockCommand(text: string, ctx: AppActionContext): AppActionInterpretation {
  const raw = text.trim();
  const lower = raw.toLowerCase();
  if (!/\bstock\b/.test(lower) && !/\brestock\b/.test(lower)) return { status: "not-action" };
  if (!/\b(increase|add|restock|raise|add more)\b/.test(lower)) return { status: "not-action" };
  if (ctx.profile.kind !== "business") return { status: "clarification", question: `Stock belongs to a business profile, and "${ctx.profile.name}" is a personal profile. Switch Bucky to your business profile — nothing was changed.` };
  const product = matchProduct(raw, ctx.products, ctx.profile.id);
  if (!product) return { status: "clarification", question: "Which product should I restock? Name a product in this business — nothing was changed." };
  // Quantity: prefer the number nearest "by"/"stock", else any integer that is not a price.
  const byMatch = /\bby\s+(\d{1,6})\b/i.exec(raw) ?? /\b(\d{1,6})\s+(?:units?|pcs|pieces|stock)\b/i.exec(raw) ?? /\badd\s+(\d{1,6})\b/i.exec(raw);
  const delta = byMatch ? Number(byMatch[1]) : NaN;
  if (!Number.isInteger(delta) || delta <= 0) return { status: "clarification", question: `By how many units should I increase "${product.name}" stock? For example: "Increase ${product.name} stock by 10". Nothing was changed.` };
  return { status: "proposal", action: { kind: "adjust-stock", id: ctx.createId(), profileId: ctx.profile.id, profileName: ctx.profile.name, currency: ctx.profile.currency, productId: product.id, productName: product.name, delta, currentStock: product.stock, newStock: product.stock + delta, warnings: [] } };
}

/** "Create a savings bucket for my motorcycle" / "Create a bucket called iPhone with goal 50000". */
export function interpretBucketCommand(text: string, ctx: AppActionContext): AppActionInterpretation {
  const raw = text.trim();
  if (!/\b(create|add|new)\b[^.?!]*\b(bucket|savings)\b/i.test(raw) && !/\bbucket\s+(called|named|for)\b/i.test(raw)) return { status: "not-action" };
  // Contributions to an existing goal are handled by buckyActions; only creation lands here.
  if (/\b(add|put|deposit)\s+[₱$\d]/i.test(raw) && !/\b(create|new)\b/i.test(raw)) return { status: "not-action" };
  let rest = raw
    .replace(/\b(create|add|new)\b/i, " ")
    .replace(/\b(a|an)\s+/gi, " ")
    .replace(/\bsavings\s+bucket\b/gi, " ").replace(/\bbucket\b/gi, " ").replace(/\bsavings\b/gi, " ")
    .replace(/\b(called|named)\b/gi, " ").replace(/\bfor\s+my\b/gi, " for ").replace(/\bplease\b/gi, " ");
  let targetMinor: number | null = null;
  const goalMatch = /\b(?:goal|target)\s+(?:of\s+)?([₱$€£]?\s*\d[\d,]*(?:\.\d+)?)/i.exec(rest);
  if (goalMatch) {
    try { targetMinor = parseAmountToMinorUnits(goalMatch[1].replace(/[₱$€£\s]/g, ""), ctx.profile.currency); } catch { targetMinor = null; }
    rest = rest.replace(goalMatch[0], " ");
  }
  const forMatch = /\bfor\s+(.+)$/i.exec(rest);
  const name = titleCase(cleanName(forMatch ? forMatch[1] : rest));
  if (!name || name.length < 2) return { status: "clarification", question: "What should the new savings bucket be called? For example: \"Create a savings bucket for my motorcycle\". Nothing was created." };
  const warnings: string[] = [];
  if (ctx.buckets.some((b) => b.profileId === ctx.profile.id && b.name.trim().toLowerCase() === name.toLowerCase())) warnings.push(`A bucket named "${name}" already exists for this profile. Confirming will create another one.`);
  return { status: "proposal", action: { kind: "create-bucket", id: ctx.createId(), profileId: ctx.profile.id, profileName: ctx.profile.name, currency: ctx.profile.currency, name, targetMinor, warnings } };
}

/** "Add two burgers to the POS cart" / "Add 2 Hakdog to cart". Hands off to POS; never checks out. */
export function interpretPosCartCommand(text: string, ctx: AppActionContext): AppActionInterpretation {
  const raw = text.trim();
  if (!/\bcart\b/i.test(raw) || !/\b(add|put)\b/i.test(raw)) return { status: "not-action" };
  if (ctx.profile.kind !== "business") return { status: "clarification", question: `The POS cart belongs to a business profile, and "${ctx.profile.name}" is a personal profile. Switch Bucky to your business profile — nothing was added.` };
  const product = matchProduct(raw, ctx.products, ctx.profile.id);
  if (!product) return { status: "clarification", question: "Which product should I add to the POS cart? Name a product in this business — nothing was added." };
  if (product.stock <= 0) return { status: "clarification", question: `"${product.name}" is out of stock, so I can't add it to the cart. Restock it first — nothing was added.` };
  const quantity = Math.min(parseQuantity(raw), product.stock);
  const warnings = quantity >= product.stock ? [`Only ${product.stock} in stock; the cart quantity is capped at available stock and checkout re-checks it.`] : [];
  return { status: "proposal", action: { kind: "pos-cart-add", id: ctx.createId(), profileId: ctx.profile.id, profileName: ctx.profile.name, currency: ctx.profile.currency, productId: product.id, productName: product.name, quantity, unitPriceMinor: product.priceMinor, warnings } };
}

/** First matching app action wins; order avoids hijacking record commands. */
export function interpretAppAction(text: string, ctx: AppActionContext): AppActionInterpretation {
  for (const interpret of [interpretPosCartCommand, interpretStockCommand, interpretEmployeeCommand, interpretBucketCommand]) {
    const result = interpret(text, ctx);
    if (result.status !== "not-action") return result;
  }
  return { status: "not-action" };
}

export function buildEmployeeRecord(action: ProposedEmployee, timestamp: string): Employee {
  return { id: action.id, profileId: action.profileId, name: action.name, role: action.role, status: "active", ...(action.salaryRateMinor !== undefined ? { salaryRateMinor: action.salaryRateMinor, salaryFrequency: action.salaryFrequency ?? "monthly", currency: action.currency as Employee["currency"] } : {}), createdAt: timestamp, updatedAt: timestamp };
}

export function buildBucketRecord(action: ProposedBucketCreate, timestamp: string): Bucket {
  return { id: action.id, profileId: action.profileId, name: action.name, kind: "savings", currency: action.currency as Bucket["currency"], targetMinor: action.targetMinor, createdAt: timestamp, updatedAt: timestamp };
}

export function appActionTitle(action: AppActionProposal): string {
  switch (action.kind) {
    case "create-employee": return "Add employee";
    case "adjust-stock": return "Increase stock";
    case "create-bucket": return "Create savings bucket";
    case "pos-cart-add": return "Add to POS cart";
  }
}

/* --- Read-only answers (safe, no confirmation needed) --- */

export interface BestSeller { productId: string; name: string; quantity: number; revenueMinor: number; currency: string }

export function bestSellingProducts(sales: Sale[], profileId: string, limit = 5): BestSeller[] {
  const byProduct = new Map<string, BestSeller>();
  for (const sale of sales) {
    if (sale.profileId !== profileId) continue;
    for (const item of sale.items) {
      const key = `${item.productId}|${sale.currency}`;
      const entry = byProduct.get(key) ?? { productId: item.productId, name: item.name, quantity: 0, revenueMinor: 0, currency: sale.currency };
      entry.quantity += item.quantity;
      entry.revenueMinor += item.lineTotalMinor;
      byProduct.set(key, entry);
    }
  }
  return [...byProduct.values()].sort((a, b) => b.quantity - a.quantity || b.revenueMinor - a.revenueMinor).slice(0, limit);
}

export interface EarnedToday { date: string; incomeMinor: number; posRevenueMinor: number; currency: string }

export function earnedOnDate(transactions: Transaction[], sales: Sale[], profileId: string, date: string): EarnedToday[] {
  const currencies = new Set<string>();
  const income = new Map<string, number>();
  const pos = new Map<string, number>();
  for (const t of transactions) {
    if (t.profileId !== profileId || t.type !== "income" || t.date.slice(0, 10) !== date) continue;
    currencies.add(t.currency);
    income.set(t.currency, (income.get(t.currency) ?? 0) + t.amountMinor);
  }
  for (const s of sales) {
    if (s.profileId !== profileId || s.createdAt.slice(0, 10) !== date) continue;
    currencies.add(s.currency);
    pos.set(s.currency, (pos.get(s.currency) ?? 0) + s.totalMinor);
  }
  return [...currencies].sort().map((currency) => ({ date, currency, incomeMinor: income.get(currency) ?? 0, posRevenueMinor: pos.get(currency) ?? 0 }));
}

/** Bounded POS cart handoff: Bucky queues items, POS consumes them once. */
export const POS_CART_HANDOFF_KEY = "bucketa.posCartHandoff";
export interface PosCartHandoff { profileId: string; items: { productId: string; quantity: number }[]; createdAt: number }

export function queuePosCartHandoff(storage: Pick<Storage, "setItem">, handoff: PosCartHandoff): void {
  storage.setItem(POS_CART_HANDOFF_KEY, JSON.stringify(handoff));
}

export function consumePosCartHandoff(storage: Pick<Storage, "getItem" | "removeItem">, profileId: string, now = Date.now()): PosCartHandoff | null {
  try {
    const raw = storage.getItem(POS_CART_HANDOFF_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PosCartHandoff;
    storage.removeItem(POS_CART_HANDOFF_KEY);
    if (parsed.profileId !== profileId || !Array.isArray(parsed.items) || now - parsed.createdAt > 10 * 60 * 1000) return null;
    return parsed;
  } catch { return null; }
}

import type { Product, Sale, SaleLineItem } from "../data/types";
import type { MinorUnits } from "./currency";

/** One cart entry: a product and how many the customer is buying. */
export interface CartLine {
  productId: string;
  quantity: number;
}

export type Cart = CartLine[];

/** Adds one unit, starting a new line when needed. Never exceeds stock. */
export function addToCart(cart: Cart, product: Product): Cart {
  const existing = cart.find((line) => line.productId === product.id);
  if (!existing) {
    return product.stock > 0 ? [...cart, { productId: product.id, quantity: 1 }] : cart;
  }
  return cart.map((line) =>
    line.productId === product.id
      ? { ...line, quantity: Math.min(line.quantity + 1, product.stock) }
      : line,
  );
}

/** Changes one line's quantity, clamped to 1..stock. Use removeFromCart to drop a line. */
export function setCartQuantity(cart: Cart, product: Product, quantity: number): Cart {
  if (!Number.isInteger(quantity) || quantity < 1) return cart;
  return cart.map((line) =>
    line.productId === product.id
      ? { ...line, quantity: Math.min(quantity, product.stock) }
      : line,
  );
}

export function removeFromCart(cart: Cart, productId: string): Cart {
  return cart.filter((line) => line.productId !== productId);
}

export function cartQuantity(cart: Cart, productId: string): number {
  return cart.find((line) => line.productId === productId)?.quantity ?? 0;
}

/**
 * Builds sale line snapshots from the cart using each product's current
 * name, SKU, and price. Later product edits can never rewrite a sale
 * built from these snapshots. Assumes quantities were capped at stock
 * while in the cart; checkout revalidates stock inside its transaction.
 */
export function buildSaleItems(cart: Cart, products: Product[]): SaleLineItem[] {
  const items: SaleLineItem[] = [];
  for (const line of cart) {
    const product = products.find((p) => p.id === line.productId);
    if (!product || line.quantity < 1) continue;
    items.push({
      productId: product.id,
      name: product.name,
      sku: product.sku,
      unitPriceMinor: product.priceMinor,
      quantity: line.quantity,
      lineTotalMinor: product.priceMinor * line.quantity,
    });
  }
  return items;
}

/** Sale total in integer minor units. No discounts or taxes in this MVP. */
export function cartTotalMinor(items: SaleLineItem[]): MinorUnits {
  return items.reduce((sum, item) => sum + item.lineTotalMinor, 0);
}

/** Change due for a cash payment, or null when received does not cover the total. */
export function changeDueMinor(totalMinor: MinorUnits, receivedMinor: MinorUnits): MinorUnits | null {
  if (!Number.isSafeInteger(receivedMinor) || receivedMinor < totalMinor) return null;
  return receivedMinor - totalMinor;
}

/**
 * Unique stored receipt number for a sale, e.g. "20261030-K3J9QX2A".
 * Derived from the sale date and its unique ID, so retries of the same
 * checkout keep the same number.
 */
export function receiptNumberFor(saleId: string, createdAt: string): string {
  const date = createdAt.slice(0, 10).replace(/-/g, "");
  const suffix = saleId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).toUpperCase();
  return `${date}-${suffix || "SALE"}`;
}

/** Assembles a complete cash Sale record ready for atomic checkout. */
export function buildSale(args: {
  id: string;
  profileId: string;
  currency: string;
  items: SaleLineItem[];
  amountReceivedMinor: MinorUnits;
  createdAt: string;
}): Omit<Sale, "updatedAt"> {
  const totalMinor = cartTotalMinor(args.items);
  const changeMinor = changeDueMinor(totalMinor, args.amountReceivedMinor);
  if (changeMinor === null) {
    throw new Error("Amount received is less than the sale total.");
  }
  return {
    id: args.id,
    profileId: args.profileId,
    items: args.items,
    totalMinor,
    currency: args.currency,
    paymentMethod: "cash",
    amountReceivedMinor: args.amountReceivedMinor,
    changeMinor,
    receiptNumber: receiptNumberFor(args.id, args.createdAt),
    createdAt: args.createdAt,
  };
}

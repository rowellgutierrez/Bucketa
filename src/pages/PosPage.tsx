import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { completeSale, productsRepo, profilesRepo, salesRepo } from "../data/db";
import type { Product, Profile, Sale } from "../data/types";
import { BucketaDataError, newId, nowIso } from "../data/validation";
import { DEFAULT_LOCALE } from "../config";
import { formatMoney, parseAmountToMinorUnits } from "../lib/currency";
import {
  addToCart,
  buildSale,
  buildSaleItems,
  cartQuantity,
  cartTotalMinor,
  changeDueMinor,
  removeFromCart,
  setCartQuantity,
  type Cart,
} from "../lib/pos";
import Receipt from "../components/Receipt";

type Status = "loading" | "ready" | "error";

function errorMessage(error: unknown): string {
  if (error instanceof BucketaDataError || error instanceof Error) return error.message;
  return "Something went wrong. Please try again.";
}

function formatSaleDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(DEFAULT_LOCALE, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export default function PosPage() {
  const [status, setStatus] = useState<Status>("loading");
  const [loadError, setLoadError] = useState("");
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profileId, setProfileId] = useState("");
  const [products, setProducts] = useState<Product[]>([]);
  const [sales, setSales] = useState<Sale[]>([]);
  const [cart, setCart] = useState<Cart>([]);
  const [search, setSearch] = useState("");
  const [received, setReceived] = useState("");
  const [showSummary, setShowSummary] = useState(false);
  const [checkoutError, setCheckoutError] = useState("");
  const [notice, setNotice] = useState("");
  const [completing, setCompleting] = useState(false);
  const completingRef = useRef(false);
  // One stable sale ID per checkout, reused across retries so a retried
  // submission can never create a second sale or deduct stock twice.
  const pendingSaleIdRef = useRef("");
  const [lastSale, setLastSale] = useState<Sale | null>(null);
  const [selectedSaleId, setSelectedSaleId] = useState("");
  const [receiptSale, setReceiptSale] = useState<Sale | null>(null);
  const [printPending, setPrintPending] = useState(false);

  const activeProfile = profiles.find((p) => p.id === profileId);
  const activeProducts = useMemo(
    () => products.filter((p) => p.status !== "archived"),
    [products],
  );
  const visibleProducts = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return activeProducts;
    return activeProducts.filter(
      (p) =>
        p.name.toLowerCase().includes(query) ||
        (p.sku ?? "").toLowerCase().includes(query) ||
        (p.category ?? "").toLowerCase().includes(query),
    );
  }, [activeProducts, search]);
  const cartItems = useMemo(() => buildSaleItems(cart, products), [cart, products]);
  const totalMinor = cartTotalMinor(cartItems);
  const selectedSale = sales.find((s) => s.id === selectedSaleId) ?? null;
  const receiptBusiness =
    profiles.find((p) => p.id === receiptSale?.profileId) ?? activeProfile;

  useEffect(() => {
    if (!receiptSale || !printPending) return;
    const timer = setTimeout(() => {
      window.print();
      setPrintPending(false);
    }, 50);
    return () => clearTimeout(timer);
  }, [receiptSale, printPending]);

  async function loadBusinessData(forProfileId: string) {
    const [list, saleList] = await Promise.all([
      productsRepo.listByProfile(forProfileId),
      salesRepo.listByProfile(forProfileId),
    ]);
    setProducts(
      [...list].sort(
        (a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name),
      ),
    );
    setSales([...saleList].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }

  async function load(preferredProfileId = "") {
    setStatus("loading");
    setLoadError("");
    try {
      const all = await profilesRepo.listAll();
      const businesses = all
        .filter((p) => p.kind === "business")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name));
      setProfiles(businesses);
      const selected = businesses.find((p) => p.id === preferredProfileId) ?? businesses[0];
      if (selected) {
        setProfileId(selected.id);
        await loadBusinessData(selected.id);
      } else {
        setProfileId("");
        setProducts([]);
        setSales([]);
      }
      setStatus("ready");
    } catch (error) {
      setStatus("error");
      setLoadError(errorMessage(error));
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function switchBusiness(id: string) {
    if (id === profileId) return;
    setProfileId(id);
    setCart([]);
    setReceived("");
    setShowSummary(false);
    setCheckoutError("");
    setNotice("");
    setLastSale(null);
    setSelectedSaleId("");
    pendingSaleIdRef.current = "";
    try {
      await loadBusinessData(id);
    } catch (error) {
      setCheckoutError(errorMessage(error));
      setProducts([]);
      setSales([]);
    }
  }

  function printSale(sale: Sale) {
    setReceiptSale(sale);
    setPrintPending(true);
  }

  async function onConfirmSale(event: FormEvent) {
    event.preventDefault();
    if (!activeProfile || completingRef.current) return;
    if (cartItems.length === 0) {
      setCheckoutError("Add at least one product before checking out.");
      return;
    }
    let receivedMinor: number;
    try {
      receivedMinor = parseAmountToMinorUnits(received, activeProfile.currency);
    } catch (error) {
      setCheckoutError(errorMessage(error));
      return;
    }
    if (changeDueMinor(totalMinor, receivedMinor) === null) {
      setCheckoutError("Amount received is less than the total.");
      return;
    }
    if (!pendingSaleIdRef.current) pendingSaleIdRef.current = newId();
    const sale: Sale = {
      ...buildSale({
        id: pendingSaleIdRef.current,
        profileId: activeProfile.id,
        currency: activeProfile.currency,
        items: cartItems,
        amountReceivedMinor: receivedMinor,
        createdAt: nowIso(),
      }),
      updatedAt: nowIso(),
    };
    completingRef.current = true;
    setCompleting(true);
    setCheckoutError("");
    try {
      // One atomic transaction: sale recorded + stock deducted, or neither.
      await completeSale(sale);
      const recorded = (await salesRepo.getById(sale.id)) ?? sale;
      await loadBusinessData(activeProfile.id);
      setLastSale(recorded);
      setSelectedSaleId(recorded.id);
      setCart([]);
      setReceived("");
      setShowSummary(false);
      pendingSaleIdRef.current = "";
      setNotice(`Sale ${recorded.receiptNumber ?? recorded.id} completed.`);
    } catch (error) {
      // Cart and pending sale ID stay intact so the user can fix and
      // retry the same checkout without risking a duplicate.
      setCheckoutError(errorMessage(error));
      // If a price changed since the cart was built, refresh this
      // business's product data so the cart rebuilds with current
      // prices. The sale is not retried automatically: the cashier
      // reviews the updated total and confirms again deliberately.
      if (
        error instanceof Error &&
        error.message.includes("price") &&
        error.message.includes("changed")
      ) {
        try {
          await loadBusinessData(activeProfile.id);
          setNotice("Product prices were refreshed. Review the updated total, then confirm again.");
        } catch {
          // Keep the original checkout error; the refresh is best-effort.
        }
      }
    } finally {
      completingRef.current = false;
      setCompleting(false);
    }
  }

  return (
    <section className="page finance-page">
      <header className="dash-header">
        <div>
          <h1>Sales / POS</h1>
          <p className="muted dash-subtitle">
            Tap products to build a sale. Stock updates automatically when a sale is completed.
          </p>
        </div>
      </header>

      {status === "loading" && <div className="card" role="status">Loading point of sale…</div>}
      {status === "error" && (
        <div className="card">
          <p className="alert-error" role="alert">Could not load POS: {loadError}</p>
          <button className="btn" type="button" onClick={() => void load(profileId)}>Retry</button>
        </div>
      )}

      {status === "ready" && (
        <>
          {profiles.length === 0 ? (
            <div className="card empty-state">
              <p>No business yet.</p>
              <p className="muted">
                Sales belong to a business. Create one first under{" "}
                <a href="#/buckets">Business Buckets</a>, add products, then come back here.
              </p>
            </div>
          ) : (
            activeProfile && (
              <>
                <div className="selector-bar">
                  <div className="selector-main">
                    <label htmlFor="pos-business">Business</label>
                    <select
                      id="pos-business"
                      className="input selector-select"
                      value={profileId}
                      onChange={(e) => void switchBusiness(e.target.value)}
                    >
                      {profiles.map((profile) => (
                        <option key={profile.id} value={profile.id}>
                          {profile.name}
                        </option>
                      ))}
                    </select>
                    <span className="muted selector-meta">
                      {activeProfile.currency} · {activeProducts.length} active{" "}
                      {activeProducts.length === 1 ? "product" : "products"}
                    </span>
                  </div>
                  <div className="selector-main">
                    <label htmlFor="pos-search">Search products</label>
                    <input
                      id="pos-search"
                      className="input"
                      type="search"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Name, SKU, or category"
                    />
                  </div>
                </div>

                {notice && <p className="notice dash-alert" role="status">{notice}</p>}

                {lastSale && (
                  <section className="panel" aria-labelledby="pos-last-sale-heading">
                    <h2 id="pos-last-sale-heading">Sale completed</h2>
                    <p>
                      Receipt {lastSale.receiptNumber ?? lastSale.id} ·{" "}
                      {formatMoney(lastSale.totalMinor, lastSale.currency)}
                      {lastSale.changeMinor !== undefined && lastSale.changeMinor !== null
                        ? ` · Change ${formatMoney(lastSale.changeMinor, lastSale.currency)}`
                        : ""}
                    </p>
                    <div className="row-actions">
                      <button className="btn" type="button" onClick={() => printSale(lastSale)}>
                        Print receipt
                      </button>
                      <button className="btn ghost" type="button" onClick={() => setLastSale(null)}>
                        Close
                      </button>
                    </div>
                  </section>
                )}

                <div className="pos-layout">
                  <section className="panel" aria-labelledby="pos-products-heading">
                    <h2 id="pos-products-heading">Products</h2>
                    {activeProducts.length === 0 ? (
                      <p className="muted">
                        No active products for {activeProfile.name} yet. Add them under{" "}
                        <a href="#/products">Products and Inventory</a>.
                      </p>
                    ) : visibleProducts.length === 0 ? (
                      <p className="muted">No products match your search.</p>
                    ) : (
                      <div className="pos-grid">
                        {visibleProducts.map((product) => (
                          <button
                            key={product.id}
                            type="button"
                            className="pos-card"
                            disabled={product.stock === 0}
                            onClick={() => setCart((prev) => addToCart(prev, product))}
                          >
                            <strong>{product.name}</strong>
                            <span>{formatMoney(product.priceMinor, product.currency)}</span>
                            <span className={product.stock === 0 ? "amount-out" : "muted"}>
                              {product.stock === 0 ? "Out of stock" : `${product.stock} available`}
                            </span>
                            {cartQuantity(cart, product.id) > 0 && (
                              <span className="count-badge">{cartQuantity(cart, product.id)} in cart</span>
                            )}
                          </button>
                        ))}
                      </div>
                    )}
                  </section>

                  <section className="panel pos-cart" aria-labelledby="pos-cart-heading">
                    <div className="panel-head">
                      <h2 id="pos-cart-heading">Cart</h2>
                      {cart.length > 0 && (
                        <button
                          className="danger-link"
                          type="button"
                          onClick={() => {
                            setCart([]);
                            setShowSummary(false);
                          }}
                        >
                          Clear cart
                        </button>
                      )}
                    </div>
                    {cartItems.length === 0 ? (
                      <p className="muted">Tap a product to start a sale.</p>
                    ) : (
                      <>
                        <ul className="clean-list">
                          {cartItems.map((item) => {
                            const product = products.find((p) => p.id === item.productId);
                            if (!product) return null;
                            return (
                              <li key={item.productId} className="cart-row">
                                <div>
                                  <strong>{item.name}</strong>
                                  <p className="muted bucket-meta">
                                    {formatMoney(item.unitPriceMinor, activeProfile.currency)}
                                  </p>
                                </div>
                                <div className="row-actions">
                                  <button
                                    className="btn ghost small"
                                    type="button"
                                    aria-label={`Remove one ${item.name}`}
                                    onClick={() =>
                                      setCart((prev) =>
                                        item.quantity <= 1
                                          ? removeFromCart(prev, item.productId)
                                          : setCartQuantity(prev, product, item.quantity - 1),
                                      )
                                    }
                                  >
                                    −
                                  </button>
                                  <span>{item.quantity}</span>
                                  <button
                                    className="btn ghost small"
                                    type="button"
                                    aria-label={`Add one ${item.name}`}
                                    onClick={() => setCart((prev) => addToCart(prev, product))}
                                  >
                                    +
                                  </button>
                                  <button
                                    className="danger-link"
                                    type="button"
                                    onClick={() => setCart((prev) => removeFromCart(prev, item.productId))}
                                  >
                                    Remove
                                  </button>
                                </div>
                                <span>{formatMoney(item.lineTotalMinor, activeProfile.currency)}</span>
                              </li>
                            );
                          })}
                        </ul>
                        <dl className="pos-totals">
                          <div><dt>Subtotal</dt><dd>{formatMoney(totalMinor, activeProfile.currency)}</dd></div>
                          <div><dt>Total</dt><dd>{formatMoney(totalMinor, activeProfile.currency)}</dd></div>
                        </dl>
                        {!showSummary ? (
                          <button className="btn" type="button" onClick={() => setShowSummary(true)}>
                            Review and checkout
                          </button>
                        ) : (
                          <form onSubmit={onConfirmSale} noValidate>
                            <h3>Order summary</h3>
                            <p className="muted">
                              {cartItems.reduce((n, item) => n + item.quantity, 0)} items · Total{" "}
                              {formatMoney(totalMinor, activeProfile.currency)} · Cash
                            </p>
                            <div className="field">
                              <label htmlFor="pos-received">Cash received ({activeProfile.currency})</label>
                              <input
                                id="pos-received"
                                className="input"
                                type="text"
                                inputMode="decimal"
                                value={received}
                                onChange={(e) => setReceived(e.target.value)}
                                placeholder="0.00"
                                autoFocus
                              />
                            </div>
                            {received.trim() && (
                              <p className="muted">
                                {(() => {
                                  try {
                                    const change = changeDueMinor(
                                      totalMinor,
                                      parseAmountToMinorUnits(received, activeProfile.currency),
                                    );
                                    return change === null
                                      ? "Not enough to cover the total."
                                      : `Change due: ${formatMoney(change, activeProfile.currency)}`;
                                  } catch {
                                    return "Enter the cash amount received.";
                                  }
                                })()}
                              </p>
                            )}
                            {checkoutError && <p className="alert-error" role="alert">{checkoutError}</p>}
                            <div className="row-actions">
                              <button className="btn" type="submit" disabled={completing}>
                                {completing ? "Completing…" : "Confirm sale"}
                              </button>
                              <button
                                className="btn ghost"
                                type="button"
                                onClick={() => setShowSummary(false)}
                              >
                                Back to cart
                              </button>
                            </div>
                          </form>
                        )}
                      </>
                    )}
                    {checkoutError && !showSummary && (
                      <p className="alert-error" role="alert">{checkoutError}</p>
                    )}
                  </section>
                </div>

                <section className="panel" aria-labelledby="pos-history-heading">
                  <div className="panel-head">
                    <h2 id="pos-history-heading">Sales history</h2>
                    <span className="count-badge">
                      {sales.length} {sales.length === 1 ? "sale" : "sales"}
                    </span>
                  </div>
                  {sales.length === 0 ? (
                    <p className="muted">No sales yet for {activeProfile.name}.</p>
                  ) : (
                    <ul className="clean-list">
                      {sales.map((sale) => (
                        <li key={sale.id} className="cart-row">
                          <div>
                            <strong>{sale.receiptNumber ?? sale.id}</strong>
                            <p className="muted bucket-meta">
                              {formatSaleDate(sale.createdAt)} ·{" "}
                              {sale.items.reduce((n, item) => n + item.quantity, 0)} items
                            </p>
                            {selectedSale?.id === sale.id && (
                              <ul className="clean-list">
                                {sale.items.map((item) => (
                                  <li key={item.productId}>
                                    {item.name} × {item.quantity} —{" "}
                                    {formatMoney(item.lineTotalMinor, sale.currency)}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                          <span>{formatMoney(sale.totalMinor, sale.currency)}</span>
                          <div className="row-actions">
                            <button
                              className="btn ghost small"
                              type="button"
                              onClick={() =>
                                setSelectedSaleId(selectedSale?.id === sale.id ? "" : sale.id)
                              }
                            >
                              {selectedSale?.id === sale.id ? "Hide details" : "View details"}
                            </button>
                            <button
                              className="btn ghost small"
                              type="button"
                              onClick={() => printSale(sale)}
                            >
                              Reprint
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </>
            ))}
          </>
        )}
      {receiptSale && receiptBusiness && (
        <Receipt business={receiptBusiness} sale={receiptSale} />
      )}
    </section>
  );
}

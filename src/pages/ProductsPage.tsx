import { useEffect, useMemo, useState, type FormEvent } from "react";
import { productsRepo, profilesRepo } from "../data/db";
import type { Product, Profile } from "../data/types";
import {
  BucketaDataError,
  findSkuConflict,
  newId,
  nowIso,
  validateProduct,
} from "../data/validation";
import {
  formatMoney,
  minorUnitsToAmountInput,
  parseAmountToMinorUnits,
} from "../lib/currency";

type Status = "loading" | "ready" | "error";

function errorMessage(error: unknown): string {
  if (error instanceof BucketaDataError || error instanceof Error) return error.message;
  return "Something went wrong. Please try again.";
}

function isArchived(product: Product): boolean {
  return product.status === "archived";
}

export default function ProductsPage() {
  const [status, setStatus] = useState<Status>("loading");
  const [loadError, setLoadError] = useState("");
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profileId, setProfileId] = useState("");
  const [products, setProducts] = useState<Product[]>([]);
  const [notice, setNotice] = useState("");
  const [pageError, setPageError] = useState("");

  // Add / edit product form. Stock is deliberately not part of editing a
  // product's details; it changes only through the stock form below.
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState("");
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [cost, setCost] = useState("");
  const [openingStock, setOpeningStock] = useState("0");
  const [sku, setSku] = useState("");
  const [category, setCategory] = useState("");
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);

  // Stock update form for one product.
  const [stockProductId, setStockProductId] = useState("");
  const [stockValue, setStockValue] = useState("");
  const [stockError, setStockError] = useState("");
  const [savingStock, setSavingStock] = useState(false);

  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);

  const activeProfile = profiles.find((p) => p.id === profileId);
  const categories = useMemo(
    () =>
      [...new Set(products.map((p) => p.category).filter(Boolean) as string[])].sort(),
    [products],
  );
  const visibleProducts = useMemo(() => {
    const query = search.trim().toLowerCase();
    return products.filter((p) => {
      if (!showArchived && isArchived(p)) return false;
      if (!query) return true;
      return (
        p.name.toLowerCase().includes(query) ||
        (p.sku ?? "").toLowerCase().includes(query) ||
        (p.category ?? "").toLowerCase().includes(query)
      );
    });
  }, [products, search, showArchived]);
  const stockProduct = products.find((p) => p.id === stockProductId);
  const activeCount = products.filter((p) => !isArchived(p)).length;

  async function loadProducts(forProfileId: string) {
    const list = await productsRepo.listByProfile(forProfileId);
    setProducts(
      [...list].sort(
        (a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name),
      ),
    );
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
        await loadProducts(selected.id);
      } else {
        setProfileId("");
        setProducts([]);
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
    setNotice("");
    setPageError("");
    setShowForm(false);
    setEditingId("");
    setStockProductId("");
    try {
      await loadProducts(id);
    } catch (error) {
      setPageError(errorMessage(error));
      setProducts([]);
    }
  }

  function resetForm() {
    setEditingId("");
    setName("");
    setPrice("");
    setCost("");
    setOpeningStock("0");
    setSku("");
    setCategory("");
    setFormError("");
  }

  function startCreate() {
    resetForm();
    setNotice("");
    setStockProductId("");
    setShowForm(true);
  }

  function startEdit(product: Product) {
    setEditingId(product.id);
    setName(product.name);
    try {
      setPrice(minorUnitsToAmountInput(product.priceMinor, product.currency));
      setCost(
        product.costMinor === null
          ? ""
          : minorUnitsToAmountInput(product.costMinor, product.currency),
      );
    } catch {
      setPrice("");
      setCost("");
    }
    setSku(product.sku ?? "");
    setCategory(product.category ?? "");
    setFormError("");
    setNotice("");
    setStockProductId("");
    setShowForm(true);
  }

  function parseStockInput(value: string): number | null {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }

  async function onSaveProduct(event: FormEvent) {
    event.preventDefault();
    if (!activeProfile) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      setFormError("Product name is required.");
      return;
    }
    let priceMinor: number;
    try {
      priceMinor = parseAmountToMinorUnits(price, activeProfile.currency);
      if (priceMinor <= 0) {
        setFormError("Selling price must be greater than zero.");
        return;
      }
    } catch (error) {
      setFormError(errorMessage(error));
      return;
    }
    let costMinor: number | null = null;
    if (cost.trim()) {
      try {
        costMinor = parseAmountToMinorUnits(cost, activeProfile.currency);
      } catch (error) {
        setFormError(errorMessage(error));
        return;
      }
    }
    const trimmedSku = sku.trim() || null;
    const conflict = findSkuConflict(products, activeProfile.id, trimmedSku, editingId);
    if (conflict) {
      setFormError(
        `SKU “${trimmedSku}” is already used by “${conflict.name}” in this business. Leave SKU blank or use a different one.`,
      );
      return;
    }
    const editing = products.find((p) => p.id === editingId);
    let stock = 0;
    if (!editing) {
      const parsedStock = parseStockInput(openingStock);
      if (parsedStock === null) {
        setFormError("Opening stock must be a whole number, zero or more.");
        return;
      }
      stock = parsedStock;
    }
    if (saving) return;
    setSaving(true);
    try {
      if (editing) {
        // Stock is intentionally not in this patch: editing a product's
        // details can never change how many are on hand.
        const updated = await productsRepo.update(editing.id, {
          name: trimmedName,
          sku: trimmedSku,
          category: category.trim() || null,
          priceMinor,
          costMinor,
        });
        setProducts((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
        setNotice(`“${updated.name}” updated.`);
      } else {
        const stamp = nowIso();
        const product: Product = {
          id: newId(), profileId: activeProfile.id, name: trimmedName,
          sku: trimmedSku, category: category.trim() || null,
          priceMinor, costMinor, currency: activeProfile.currency,
          stock, status: "active", createdAt: stamp, updatedAt: stamp,
        };
        validateProduct(product);
        await productsRepo.create(product);
        setProducts((prev) => [...prev, product]);
        setNotice(`“${product.name}” added.`);
      }
      resetForm();
      setShowForm(false);
    } catch (error) {
      setFormError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function onSaveStock(event: FormEvent) {
    event.preventDefault();
    if (!stockProduct) return;
    const parsed = parseStockInput(stockValue);
    if (parsed === null) {
      setStockError("Stock must be a whole number, zero or more.");
      return;
    }
    if (savingStock) return;
    setSavingStock(true);
    try {
      const updated = await productsRepo.update(stockProduct.id, { stock: parsed });
      setProducts((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
      setNotice(`Stock for “${updated.name}” set to ${updated.stock}.`);
      setStockProductId("");
      setStockError("");
    } catch (error) {
      setStockError(errorMessage(error));
    } finally {
      setSavingStock(false);
    }
  }

  async function onToggleArchive(product: Product) {
    try {
      const updated = await productsRepo.update(product.id, {
        status: isArchived(product) ? "active" : "archived",
      });
      setProducts((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
      setNotice(
        isArchived(product)
          ? `“${updated.name}” restored.`
          : `“${updated.name}” archived. It stays saved and can be restored anytime.`,
      );
    } catch (error) {
      setPageError(errorMessage(error));
    }
  }

  return (
    <section className="page finance-page">
      <header className="dash-header">
        <div>
          <h1>Products and Inventory</h1>
          <p className="muted dash-subtitle">
            What each business sells, its prices, and how many are on hand.
          </p>
        </div>
        {activeProfile && (
          <button className="btn" type="button" onClick={startCreate}>
            Add product
          </button>
        )}
      </header>

      {status === "loading" && <div className="card" role="status">Loading products…</div>}
      {status === "error" && (
        <div className="card">
          <p className="alert-error" role="alert">Could not load products: {loadError}</p>
          <button className="btn" type="button" onClick={() => void load(profileId)}>Retry</button>
        </div>
      )}

      {status === "ready" && (
        <>
          {profiles.length === 0 ? (
            <div className="card empty-state">
              <p>No business yet.</p>
              <p className="muted">
                Products belong to a business. Create one first under{" "}
                <a href="#/buckets">Business Buckets</a>, then come back here.
              </p>
            </div>
          ) : (
            activeProfile && (
              <>
                <div className="selector-bar">
                  <div className="selector-main">
                    <label htmlFor="product-business">Business</label>
                    <select
                      id="product-business"
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
                      {activeProfile.currency} · {activeCount}{" "}
                      active {activeCount === 1 ? "product" : "products"}
                    </span>
                  </div>
                  <div className="selector-main">
                    <label htmlFor="product-search">Search</label>
                    <input
                      id="product-search"
                      className="input"
                      type="search"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Name, SKU, or category"
                    />
                  </div>
                </div>

                {notice && <p className="notice dash-alert" role="status">{notice}</p>}
                {pageError && <p className="alert-error dash-alert" role="alert">{pageError}</p>}

                {showForm && (
                  <form className="card inline-form" onSubmit={onSaveProduct} noValidate>
                    <h2 className="inline-form-title">
                      {editingId ? "Edit product" : "Add product"}
                    </h2>
                    {editingId && (
                      <p className="field-hint" role="status">
                        Editing details only. Stock does not change here; use
                        Update stock on the product when the count changes.
                      </p>
                    )}
                    <div className="form-row">
                      <div className="field">
                        <label htmlFor="product-name">Product name</label>
                        <input
                          id="product-name"
                          className="input"
                          type="text"
                          value={name}
                          onChange={(e) => setName(e.target.value)}
                          placeholder="e.g. Rice 1kg"
                          autoFocus
                        />
                      </div>
                      <div className="field">
                        <label htmlFor="product-category">Category (optional)</label>
                        <input
                          id="product-category"
                          className="input"
                          type="text"
                          value={category}
                          onChange={(e) => setCategory(e.target.value)}
                          placeholder="e.g. Drinks"
                          list="product-categories"
                          autoComplete="off"
                        />
                        <datalist id="product-categories">
                          {categories.map((entry) => (
                            <option key={entry} value={entry} />
                          ))}
                        </datalist>
                      </div>
                      <div className="field">
                        <label htmlFor="product-sku">SKU (optional)</label>
                        <input
                          id="product-sku"
                          className="input"
                          type="text"
                          value={sku}
                          onChange={(e) => setSku(e.target.value)}
                          placeholder="e.g. RICE-1"
                          autoComplete="off"
                        />
                      </div>
                    </div>
                    <div className="form-row">
                      <div className="field">
                        <label htmlFor="product-price">Selling price ({activeProfile.currency})</label>
                        <input
                          id="product-price"
                          className="input"
                          type="text"
                          inputMode="decimal"
                          value={price}
                          onChange={(e) => setPrice(e.target.value)}
                          placeholder="0.00"
                        />
                      </div>
                      <div className="field">
                        <label htmlFor="product-cost">Cost (optional)</label>
                        <input
                          id="product-cost"
                          className="input"
                          type="text"
                          inputMode="decimal"
                          value={cost}
                          onChange={(e) => setCost(e.target.value)}
                          placeholder="Leave blank if not tracked"
                        />
                      </div>
                      {!editingId && (
                        <div className="field">
                          <label htmlFor="product-opening-stock">Opening stock</label>
                          <input
                            id="product-opening-stock"
                            className="input"
                            type="text"
                            inputMode="numeric"
                            value={openingStock}
                            onChange={(e) => setOpeningStock(e.target.value)}
                            placeholder="0"
                          />
                        </div>
                      )}
                    </div>
                    {formError && <p className="alert-error" role="alert">{formError}</p>}
                    <div className="row-actions">
                      <button className="btn" type="submit" disabled={saving}>
                        {saving ? "Saving…" : editingId ? "Save changes" : "Add product"}
                      </button>
                      <button
                        className="btn ghost"
                        type="button"
                        onClick={() => {
                          resetForm();
                          setShowForm(false);
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                )}

                {stockProduct && (
                  <form className="card inline-form" onSubmit={onSaveStock} noValidate>
                    <h2 className="inline-form-title">Update stock — {stockProduct.name}</h2>
                    <p className="muted">
                      Currently {stockProduct.stock} on hand. Enter the new
                      counted amount; it replaces the old count.
                    </p>
                    <div className="form-row">
                      <div className="field">
                        <label htmlFor="product-stock">Stock on hand</label>
                        <input
                          id="product-stock"
                          className="input"
                          type="text"
                          inputMode="numeric"
                          value={stockValue}
                          onChange={(e) => setStockValue(e.target.value)}
                          placeholder="0"
                          autoFocus
                        />
                      </div>
                    </div>
                    {stockError && <p className="alert-error" role="alert">{stockError}</p>}
                    <div className="row-actions">
                      <button className="btn" type="submit" disabled={savingStock}>
                        {savingStock ? "Saving…" : "Save stock"}
                      </button>
                      <button
                        className="btn ghost"
                        type="button"
                        onClick={() => {
                          setStockProductId("");
                          setStockError("");
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                )}

                <section className="panel" aria-labelledby="product-list-heading">
                  <div className="panel-head">
                    <h2 id="product-list-heading">
                      {activeProfile.name} products
                    </h2>
                    <span className="count-badge">
                      {visibleProducts.length} of {products.length}{" "}
                      {products.length === 1 ? "product" : "products"}
                    </span>
                  </div>
                  <label className="muted">
                    <input
                      type="checkbox"
                      checked={showArchived}
                      onChange={(e) => setShowArchived(e.target.checked)}
                    />{" "}
                    Show archived
                  </label>
                  {products.length === 0 ? (
                    <p className="muted">
                      No products yet for {activeProfile.name}. Add the first
                      one with the Add product button above.
                    </p>
                  ) : visibleProducts.length === 0 ? (
                    <p className="muted">No products match. Try a different search.</p>
                  ) : (
                    <ul className="bucket-list clean-list">
                      {visibleProducts.map((product) => (
                        <li
                          key={product.id}
                          className={isArchived(product) ? "bucket-row wrap-row product-archived" : "bucket-row wrap-row"}
                        >
                          <div>
                            <strong>{product.name}</strong>
                            <p className="muted bucket-meta">
                              {product.category ? `${product.category} · ` : ""}
                              {product.sku ? `SKU ${product.sku} · ` : ""}
                              {formatMoney(product.priceMinor, product.currency)}
                              {product.costMinor !== null
                                ? ` · cost ${formatMoney(product.costMinor, product.currency)}`
                                : ""}
                              {isArchived(product) ? " · Archived" : ""}
                            </p>
                          </div>
                          <span className={product.stock === 0 ? "amount-out" : ""}>
                            {product.stock === 0 ? "Out of stock" : `${product.stock} in stock`}
                          </span>
                          <div className="row-actions">
                            {!isArchived(product) && (
                              <>
                                <button
                                  className="btn ghost small"
                                  type="button"
                                  onClick={() => startEdit(product)}
                                >
                                  Edit
                                </button>
                                <button
                                  className="btn ghost small"
                                  type="button"
                                  onClick={() => {
                                    setStockProductId(product.id);
                                    setStockValue(String(product.stock));
                                    setStockError("");
                                    setShowForm(false);
                                  }}
                                >
                                  Update stock
                                </button>
                              </>
                            )}
                            <button
                              className="danger-link"
                              type="button"
                              onClick={() => void onToggleArchive(product)}
                            >
                              {isArchived(product) ? "Restore" : "Archive"}
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
      </section>
  );
}

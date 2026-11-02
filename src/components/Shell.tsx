import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import logoUrl from "../../assets/bucketa-logo-primary.png";
import Icon, { type IconName } from "./ui/Icon";
import BuckyDock from "./BuckyDock";

export type Route = { id: string; label: string; shortLabel: string; group: string; planned?: boolean };
type Props = { routes: Route[]; active: string; onNavigate: (id: string) => void; dark: boolean; onToggleTheme: () => void; children: ReactNode };
const BOTTOM_IDS = ["dashboard", "personal", "buckets"];
const icons: Record<string, IconName> = { dashboard: "dashboard", personal: "personal", buckets: "buckets", transactions: "transactions", scanner: "scanner", products: "products", pos: "pos", employees: "employees", settings: "settings" };
const labels: Record<string, string> = { buckets: "Buckets", scanner: "Bucky Record Scanner", products: "Products & Inventory", pos: "POS / Sales", employees: "Employees" };
const isPlanned = (route: Route) => route.planned && route.id !== "scanner";

export default function Shell({ routes, active, onNavigate, dark, onToggleTheme, children }: Props) {
  const [moreOpen, setMoreOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const homeScrollPending = useRef(false);
  const activeRoute = routes.find((r) => r.id === active) ?? routes[0];
  const bottomRoutes = routes.filter((r) => BOTTOM_IDS.includes(r.id));
  const moreRoutes = routes.filter((r) => r.id !== "dashboard");
  useEffect(() => { setMoreOpen(false); }, [active]);
  useEffect(() => {
    if (moreOpen && !dialog.current?.open) dialog.current?.showModal();
    if (!moreOpen && dialog.current?.open) { dialog.current.close(); moreButton.current?.focus(); }
  }, [moreOpen]);
  function go(id: string) { onNavigate(id); setMoreOpen(false); }
  function goHomeFromMobileLogo() {
    if (active === "dashboard") {
      window.scrollTo(0, 0);
      return;
    }
    homeScrollPending.current = true;
    go("dashboard");
  }
  useLayoutEffect(() => {
    if (active === "dashboard" && homeScrollPending.current) {
      homeScrollPending.current = false;
      window.scrollTo(0, 0);
    }
  }, [active]);
  return (
    <div className="shell premium-shell">
      <a className="skip-link" href="#main-content" onClick={(event) => { event.preventDefault(); document.getElementById("main-content")?.focus(); }}>Skip to content</a>
      <aside className="sidebar">
        <button className="brand" type="button" onClick={() => go("dashboard")} aria-label="Bucketa — go to Home"><img src={logoUrl} alt="" /><span className="brand-copy"><span>Bucketa</span><small>Smart Buckets</small></span></button>
        <nav className="workspace-navigation" aria-label="Primary">{[...new Set(routes.map((r) => r.group))].map((group) => <div key={group} className="nav-group-block"><p className="nav-group">{group}</p>{routes.filter((r) => r.group === group).map((r) => <button key={r.id} type="button" className={r.id === active ? "navlink on" : "navlink"} aria-current={r.id === active ? "page" : undefined} onClick={() => go(r.id)}><Icon name={icons[r.id] ?? "dashboard"} /><span>{labels[r.id] ?? r.label}</span>{isPlanned(r) && <span className="planned-tag">Planned</span>}</button>)}</div>)}</nav>
        <div className="sidebar-footer"><Icon name="buckets" /><div><strong>Your workspace</strong><small>Personal & business finance</small></div></div>
      </aside>
      <div className="main-col">
        <header className="topbar"><div className="topbar-title"><button className="mobile-home-logo" type="button" onClick={goHomeFromMobileLogo} aria-label="Bucketa — Home and back to top"><img src={logoUrl} alt="" /></button><span className="header-icon"><Icon name={icons[active] ?? "dashboard"} /></span><div><span className="topbar-kicker">Workspace</span><strong>{labels[active] ?? activeRoute.label}</strong></div></div><button className="btn ghost small theme-toggle" type="button" onClick={onToggleTheme} aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}><Icon name={dark ? "sun" : "moon"} /><span>{dark ? "Light mode" : "Dark mode"}</span></button></header>
        <main id="main-content" className="content" tabIndex={-1}>{children}</main>
      </div>
      <dialog ref={dialog} className="more-sheet" aria-labelledby="more-heading" onCancel={() => setMoreOpen(false)} onClose={() => setMoreOpen(false)}><div className="sheet-heading"><h2 id="more-heading">Your workspace</h2><button className="btn ghost" type="button" onClick={() => setMoreOpen(false)} aria-label="Close navigation"><Icon name="close" /></button></div><nav aria-label="More pages">{moreRoutes.map((r) => <button key={r.id} type="button" className={r.id === active ? "sheet-link on" : "sheet-link"} aria-current={r.id === active ? "page" : undefined} onClick={() => go(r.id)}><Icon name={icons[r.id] ?? "dashboard"} /><span>{labels[r.id] ?? r.label}</span>{isPlanned(r) && <span className="planned-tag">Planned</span>}</button>)}</nav></dialog>
      <BuckyDock hideLauncher={active === "dashboard"} />
      <nav className="bottombar" aria-label="Mobile">{bottomRoutes.map((r) => <button key={r.id} type="button" className={r.id === active ? "tab on" : "tab"} aria-current={r.id === active ? "page" : undefined} onClick={() => go(r.id)}><Icon name={icons[r.id] ?? "dashboard"} />{r.shortLabel}</button>)}<button ref={moreButton} type="button" className={!BOTTOM_IDS.includes(active) ? "tab on" : "tab"} aria-expanded={moreOpen} aria-haspopup="dialog" onClick={() => setMoreOpen(true)}><Icon name="more" />More</button></nav>
    </div>
  );
}

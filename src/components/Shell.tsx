import { useState, type ReactNode } from "react";
import logoUrl from "../../assets/bucketa-logo-primary.png";

export type Route = {
  id: string;
  label: string;
  shortLabel: string;
};

type Props = {
  routes: Route[];
  active: string;
  onNavigate: (id: string) => void;
  dark: boolean;
  onToggleTheme: () => void;
  children: ReactNode;
};

const BOTTOM_IDS = ["dashboard", "buckets", "pos"];

export default function Shell({ routes, active, onNavigate, dark, onToggleTheme, children }: Props) {
  const [moreOpen, setMoreOpen] = useState(false);
  const activeRoute = routes.find((r) => r.id === active) ?? routes[0];
  const bottomRoutes = routes.filter((r) => BOTTOM_IDS.includes(r.id));
  const moreRoutes = routes.filter((r) => !BOTTOM_IDS.includes(r.id));

  function go(id: string) {
    onNavigate(id);
    setMoreOpen(false);
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <img src={logoUrl} alt="Bucketa" />
          <span>Bucketa</span>
        </div>
        <nav aria-label="Primary">
          {routes.map((r) => (
            <button
              key={r.id}
              type="button"
              className={r.id === active ? "navlink on" : "navlink"}
              onClick={() => go(r.id)}
            >
              {r.label}
            </button>
          ))}
        </nav>
        <button className="btn ghost small theme-btn" type="button" onClick={onToggleTheme}>
          {dark ? "Light mode" : "Dark mode"}
        </button>
      </aside>

      <div className="main-col">
        <header className="topbar">
          <img src={logoUrl} alt="Bucketa" />
          <strong>{activeRoute.label}</strong>
          <button className="btn ghost small" type="button" onClick={onToggleTheme}>
            {dark ? "Light mode" : "Dark mode"}
          </button>
        </header>
        <main className="content">{children}</main>
      </div>

      {moreOpen && (
        <div className="more-sheet" role="dialog" aria-label="More pages">
          {moreRoutes.map((r) => (
            <button
              key={r.id}
              type="button"
              className={r.id === active ? "sheet-link on" : "sheet-link"}
              onClick={() => go(r.id)}
            >
              {r.label}
            </button>
          ))}
          <button type="button" className="sheet-link" onClick={() => setMoreOpen(false)}>
            Close
          </button>
        </div>
      )}

      <nav className="bottombar" aria-label="Mobile">
        {bottomRoutes.map((r) => (
          <button
            key={r.id}
            type="button"
            className={r.id === active ? "tab on" : "tab"}
            onClick={() => go(r.id)}
          >
            {r.shortLabel}
          </button>
        ))}
        <button
          type="button"
          className="tab"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen((v) => !v)}
        >
          More
        </button>
      </nav>
    </div>
  );
}

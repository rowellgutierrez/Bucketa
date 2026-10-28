import { useEffect, useState } from "react";
import Shell, { type Route } from "./components/Shell";
import DashboardPage from "./pages/DashboardPage";
import PersonalPage from "./pages/PersonalPage";
import BucketsPage from "./pages/BucketsPage";
import TransactionsPage from "./pages/TransactionsPage";
import ProductsPage from "./pages/ProductsPage";
import PosPage from "./pages/PosPage";
import EmployeesPage from "./pages/EmployeesPage";
import ScannerPage from "./pages/ScannerPage";
import SettingsPage from "./pages/SettingsPage";

const ROUTES: Route[] = [
  { id: "dashboard", label: "Dashboard", shortLabel: "Home" },
  { id: "personal", label: "Personal Finance", shortLabel: "Personal" },
  { id: "buckets", label: "Business Buckets", shortLabel: "Buckets" },
  { id: "transactions", label: "Transactions", shortLabel: "Records" },
  { id: "products", label: "Products and Inventory", shortLabel: "Products" },
  { id: "pos", label: "Sales / POS", shortLabel: "POS" },
  { id: "employees", label: "Employees and Salaries", shortLabel: "Staff" },
  { id: "scanner", label: "AI Record Scanner", shortLabel: "Scanner" },
  { id: "settings", label: "Settings", shortLabel: "Settings" },
];

function routeFromHash(): string {
  const id = window.location.hash.replace(/^#\/?/, "");
  return ROUTES.some((r) => r.id === id) ? id : "dashboard";
}

export default function App() {
  const [active, setActive] = useState<string>(() => routeFromHash());
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const onHash = () => setActive(routeFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "";
  }, [dark]);

  function navigate(id: string) {
    window.location.hash = `/${id}`;
    setActive(id);
  }

  return (
    <Shell
      routes={ROUTES}
      active={active}
      onNavigate={navigate}
      dark={dark}
      onToggleTheme={() => setDark((v) => !v)}
    >
      {active === "dashboard" && <DashboardPage />}
      {active === "personal" && <PersonalPage />}
      {active === "buckets" && <BucketsPage />}
      {active === "transactions" && <TransactionsPage />}
      {active === "products" && <ProductsPage />}
      {active === "pos" && <PosPage />}
      {active === "employees" && <EmployeesPage />}
      {active === "scanner" && <ScannerPage />}
      {active === "settings" && <SettingsPage />}
    </Shell>
  );
}

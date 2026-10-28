import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../css/tokens.css";
import "./styles/app.css";
import App from "./App";
import faviconUrl from "../assets/bucketa-favicon.png";

const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
if (icon) {
  icon.href = faviconUrl;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";
import "./index.css";

// Build marker so we can tell if a stale bundle is being served.
console.log("%c[cc-map] bundle loaded — build C36iVuCl", "color: #fbbf24; font-weight: bold");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

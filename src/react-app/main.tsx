import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import "./index.css";
import "./compact-phone.css";
import "./live-dashboard.css";
import "./daily-mvp.css";
import "./decision-actions.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element is missing");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);

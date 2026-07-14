import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
// Inter 700 (latin only — it sets one word), self-hosted: the wordmark face shared
// with the docs and the landing page.
import "@fontsource/inter/latin-700.css";
import "./styles.css";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

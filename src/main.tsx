import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AppDialogProvider } from "./components/AppDialog";
import "./styles.css";

function migrateLegacyStorage() {
  try {
    const keys = Array.from(
      { length: window.localStorage.length },
      (_, index) => window.localStorage.key(index),
    ).filter((key): key is string => Boolean(key));
    for (const key of keys) {
      if (!key.startsWith("deskproject:") && !key.startsWith("deskproject."))
        continue;
      const next = `foldory${key.slice("deskproject".length)}`;
      if (window.localStorage.getItem(next) === null) {
        const value = window.localStorage.getItem(key);
        if (value !== null) window.localStorage.setItem(next, value);
      }
    }
  } catch {
    // Storage can be disabled by policy. The app still works without migration.
  }
}

migrateLegacyStorage();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppDialogProvider>
      <App />
    </AppDialogProvider>
  </React.StrictMode>,
);

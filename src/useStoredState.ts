import { useEffect, useState } from "react";

/** Best-effort persistence for layout preferences, never application records. */
export function useStoredBoolean(key: string, fallback = false) {
  const [value, setValue] = useState(() => {
    try {
      const saved = localStorage.getItem(key);
      return saved === null ? fallback : saved === "true";
    } catch {
      return fallback;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, String(value));
    } catch {
      /* Layout preferences are optional. */
    }
  }, [key, value]);
  return [value, setValue] as const;
}

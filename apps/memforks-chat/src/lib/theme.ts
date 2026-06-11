"use client";

import { useCallback, useEffect, useState } from "react";

const KEY = "memforks-chat:theme";

export type Theme = "light" | "dark";

function applyTheme(theme: Theme) {
  if (theme === "dark") {
    document.documentElement.classList.add("dark");
  } else {
    document.documentElement.classList.remove("dark");
  }
}

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>("light");

  // Initialise from localStorage, falling back to system preference.
  useEffect(() => {
    const stored = localStorage.getItem(KEY) as Theme | null;
    const resolved: Theme =
      stored ?? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    setTheme(resolved);
    applyTheme(resolved);
  }, []);

  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === "light" ? "dark" : "light";
      localStorage.setItem(KEY, next);
      applyTheme(next);
      return next;
    });
  }, []);

  return [theme, toggle];
}

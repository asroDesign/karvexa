"use client";

import React, { createContext, useContext, useEffect, useState } from "react";

export type ThemePreference = "system" | "light" | "dark";

interface ThemeContextValue {
  theme: ThemePreference;
  resolvedTheme: "light" | "dark";
  setTheme: (next: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: "system",
  resolvedTheme: "light",
  setTheme: () => {},
});

const STORAGE_KEY = "bos_theme_preference";

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<ThemePreference>("light");
  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY) as ThemePreference | null;
    if (saved === "light" || saved === "dark" || saved === "system") {
      setThemeState(saved);
    }
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const effective: "light" | "dark" =
        theme === "system" ? (media.matches ? "dark" : "light") : theme;
      setResolvedTheme(effective);
      document.documentElement.classList.toggle("dark", effective === "dark");
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  const setTheme = (next: ThemePreference) => {
    setThemeState(next);
    window.localStorage.setItem(STORAGE_KEY, next);
  };

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}

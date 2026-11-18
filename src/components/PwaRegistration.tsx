"use client";

import { useEffect } from "react";

export function PwaRegistration() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((error: unknown) => {
      console.warn("PWA service worker registration failed", error);
    });
  }, []);
  return null;
}

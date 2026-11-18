"use client";

import React, { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import {
  Building2,
  CheckCircle2,
  LogOut,
  Moon,
  Shield,
  Sun,
  AlertCircle,
} from "lucide-react";
import { apiFetch, SessionMeResponse } from "@/lib/format";
import { LoginView } from "./LoginView";
import { PlatformAdminPortal } from "./PlatformAdminPortal";
import { OrgWorkspace } from "./OrgWorkspace";
import { useTheme } from "./ThemeProvider";

export function BusinessOsShell() {
  const { resolvedTheme, setTheme } = useTheme();
  const [session, setSession] = useState<SessionMeResponse | null>(null);
  const [booting, setBooting] = useState(true);
  const [realm, setRealm] = useState<"PLATFORM" | "ORGANIZATION">("ORGANIZATION");
  const [toast, setToast] = useState<{ msg: string; type: "success" | "error" } | null>(null);

  const showToast = useCallback((msg: string, type: "success" | "error" = "success") => {
    setToast({ msg, type });
    setTimeout(() => {
      setToast((prev) => (prev?.msg === msg ? null : prev));
    }, 5000);
  }, []);

  const loadSession = useCallback(async () => {
    try {
      const me = await apiFetch<SessionMeResponse>("/api/v1/auth/me");
      setSession(me);
      setRealm((prev) => {
        if (!me.user.is_platform_admin) return "ORGANIZATION";
        if (!me.active_organization) return "PLATFORM";
        return prev;
      });
    } catch {
      setSession(null);
    } finally {
      setBooting(false);
    }
  }, []);

  useEffect(() => {
    loadSession();
  }, [loadSession]);

  async function handleLogout() {
    try {
      await apiFetch("/api/v1/auth/logout", { method: "POST" });
    } finally {
      setSession(null);
    }
  }

  async function switchOrg(orgId: string) {
    try {
      await apiFetch("/api/v1/auth/me", {
        method: "PATCH",
        body: JSON.stringify({ organization_id: orgId }),
      });
      await loadSession();
      showToast("سازمان فعال تغییر کرد و داده‌ها با ایزوله‌سازی کامل بارگذاری شد.");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "خطا در تغییر سازمان", "error");
    }
  }

  if (booting) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 text-sm text-slate-600">
        در حال بارگذاری Karvexa...
      </div>
    );
  }

  if (!session) {
    return <LoginView onSuccess={loadSession} />;
  }

  const effectiveRealm =
    realm === "PLATFORM" && session.user.is_platform_admin ? "PLATFORM" : "ORGANIZATION";

  return (
    <div className="min-h-screen flex flex-col">
      {/* Top Glass Navigation Header */}
      <header className="sticky top-0 z-30 glass-nav">
        <div className="max-w-[1440px] mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <Image src="/icons/karvexa-192.png" width={40} height={40} alt="Karvexa" className="h-9 w-9 rounded-xl object-cover shrink-0 shadow-sm" />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-bold text-sm">Karvexa</span>
                <span className="hidden sm:inline text-[10px] font-mono px-2 py-0.5 rounded-full bg-violet-500/15 text-violet-700 dark:text-violet-300">
                  Glass UI v1.1
                </span>
              </div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                {session.user.full_name}
              </div>
            </div>
          </div>

          {/* Realm Switcher + Theme Toggle + Org Switcher */}
          <div className="flex items-center gap-2 sm:gap-3">
            {session.user.is_platform_admin && (
              <div className="inline-flex rounded-xl glass-secondary p-1 text-xs">
                <button
                  type="button"
                  onClick={() => setRealm("PLATFORM")}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium transition-colors cursor-pointer ${
                    effectiveRealm === "PLATFORM"
                      ? "bg-violet-600 text-white shadow-xs"
                      : "text-slate-600 dark:text-slate-300"
                  }`}
                >
                  <Shield className="h-3.5 w-3.5" />
                  <span>پنل پلتفرم</span>
                </button>
                <button
                  type="button"
                  onClick={() => setRealm("ORGANIZATION")}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium transition-colors cursor-pointer ${
                    effectiveRealm === "ORGANIZATION"
                      ? "bg-emerald-600 text-white shadow-xs"
                      : "text-slate-600 dark:text-slate-300"
                  }`}
                >
                  <Building2 className="h-3.5 w-3.5" />
                  <span>پنل سازمانی</span>
                </button>
              </div>
            )}

            {effectiveRealm === "ORGANIZATION" && session.organizations.length > 0 && (
              <select
                value={session.active_organization?.organization_id ?? ""}
                onChange={(e) => switchOrg(e.target.value)}
                className="glass-input px-3 py-1.5 text-xs font-medium max-w-[190px]"
              >
                {session.organizations.map((org) => (
                  <option key={org.organization_id} value={org.organization_id}>
                    {org.name}
                  </option>
                ))}
              </select>
            )}

            <button
              type="button"
              onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
              title={resolvedTheme === "dark" ? "تغییر به تم روشن شیشه‌ای" : "تغییر به تم تاریک شیشه‌ای"}
              className="h-9 w-9 rounded-xl glass-input flex items-center justify-center cursor-pointer hover:border-violet-400"
            >
              {resolvedTheme === "dark" ? (
                <Sun className="h-4 w-4 text-amber-400" />
              ) : (
                <Moon className="h-4 w-4 text-violet-600" />
              )}
            </button>

            <a
              href="/"
              className="hidden md:inline-flex items-center gap-1.5 rounded-xl glass-input hover:border-violet-400 px-3 py-1.5 text-xs font-medium transition-colors"
            >
              <span>وب‌سایت اصلی</span>
            </a>

            <button
              type="button"
              onClick={handleLogout}
              title="خروج از حساب"
              className="inline-flex items-center gap-1.5 rounded-xl glass-input hover:border-rose-400 hover:text-rose-600 px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer"
            >
              <LogOut className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">خروج</span>
            </button>
          </div>
        </div>
      </header>

      {/* Toast Notification */}
      {toast && (
        <div className="fixed bottom-5 left-5 z-50 max-w-md">
          <div
            className={`rounded-2xl shadow-lg border px-4 py-3 text-xs font-medium flex items-center gap-2.5 ${
              toast.type === "error"
                ? "bg-rose-950 text-rose-50 border-rose-800"
                : "bg-slate-900 text-white border-slate-700"
            }`}
          >
            {toast.type === "error" ? (
              <AlertCircle className="h-4 w-4 text-rose-400 shrink-0" />
            ) : (
              <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
            )}
            <span>{toast.msg}</span>
          </div>
        </div>
      )}

      {/* Main Container */}
      <main className="flex-1 max-w-[1440px] w-full mx-auto px-4 sm:px-6 py-6">
        {effectiveRealm === "PLATFORM" ? (
          <PlatformAdminPortal onToast={showToast} />
        ) : (
          <OrgWorkspace
            session={session}
            onRefreshSession={loadSession}
            onToast={showToast}
          />
        )}
      </main>
    </div>
  );
}

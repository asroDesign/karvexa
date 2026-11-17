"use client";

import React, { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Layers, LogIn, Menu, Moon, Sun, X } from "lucide-react";
import { useTheme } from "./ThemeProvider";

const NAV_LINKS = [
  { href: "/", label: "صفحه اصلی" },
  { href: "/services", label: "خدمات و ماژول‌ها" },
  { href: "/pricing", label: "تعرفه‌ها" },
  { href: "/academy", label: "آموزش‌ها (آکادمی)" },
  { href: "/about", label: "درباره ما" },
  { href: "/contact", label: "تماس با ما" },
];

export function SiteHeader() {
  const pathname = usePathname();
  const { resolvedTheme, setTheme } = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <header className="sticky top-0 z-40 glass-nav">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
        <Link href="/" className="flex items-center gap-2.5 shrink-0">
          <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-violet-600 to-indigo-600 text-white flex items-center justify-center shadow-sm">
            <Layers className="h-5 w-5" />
          </div>
          <div>
            <div className="font-extrabold text-sm tracking-tight">Business OS</div>
            <div className="text-[10px] text-slate-500 dark:text-slate-400">
              سیستم جامع حسابداری و انبارداری SaaS
            </div>
          </div>
        </Link>

        <nav className="hidden lg:flex items-center gap-1">
          {NAV_LINKS.map((item) => {
            const active =
              item.href === "/" ? pathname === "/" : pathname?.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`px-3.5 py-2 rounded-xl text-xs font-medium transition-colors ${
                  active
                    ? "bg-violet-600/15 text-violet-700 dark:text-violet-300 font-bold"
                    : "text-slate-600 dark:text-slate-300 hover:bg-white/60 dark:hover:bg-slate-800/60"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
            title={resolvedTheme === "dark" ? "تم روشن شیشه‌ای" : "تم تاریک شیشه‌ای"}
            className="h-9 w-9 rounded-xl glass-input flex items-center justify-center cursor-pointer hover:border-violet-400"
          >
            {resolvedTheme === "dark" ? (
              <Sun className="h-4 w-4 text-amber-400" />
            ) : (
              <Moon className="h-4 w-4 text-violet-600" />
            )}
          </button>

          <Link
            href="/app"
            className="inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-l from-violet-600 to-indigo-600 hover:from-violet-700 hover:to-indigo-700 text-white px-4 py-2 text-xs font-semibold shadow-sm transition-all"
          >
            <LogIn className="h-3.5 w-3.5" />
            <span>ورود / پنل کاربری</span>
          </Link>

          <button
            type="button"
            onClick={() => setMobileOpen(!mobileOpen)}
            className="lg:hidden h-9 w-9 rounded-xl glass-input flex items-center justify-center cursor-pointer"
          >
            {mobileOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {mobileOpen && (
        <div className="lg:hidden border-t border-slate-200/50 dark:border-slate-700/50 px-4 py-3 space-y-1">
          {NAV_LINKS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setMobileOpen(false)}
              className="block px-3 py-2 rounded-xl text-xs font-medium hover:bg-violet-500/10"
            >
              {item.label}
            </Link>
          ))}
        </div>
      )}
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="mt-20 border-t border-slate-200/60 dark:border-slate-800/80 glass-secondary rounded-none">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-12 grid grid-cols-1 md:grid-cols-4 gap-8 text-xs">
        <div className="md:col-span-2 space-y-3">
          <div className="flex items-center gap-2.5">
            <div className="h-8 w-8 rounded-xl bg-gradient-to-br from-violet-600 to-indigo-600 text-white flex items-center justify-center">
              <Layers className="h-4 w-4" />
            </div>
            <span className="font-extrabold text-sm">Business OS</span>
          </div>
          <p className="text-slate-500 dark:text-slate-400 leading-relaxed max-w-md">
            پلتفرم ابری (SaaS) و آفلاین اندروید مدیریت کسب‌وکار، حسابداری دوبل استاندارد، انبارداری اتمیک، خزانه و چک، مالی شخصی مالک و گزارش‌گیری دقیق مالی با معماری چندمستاجری PostgreSQL RLS.
          </p>
        </div>

        <div className="space-y-2">
          <div className="font-bold text-slate-900 dark:text-white mb-2">دسترسی سریع</div>
          {NAV_LINKS.map((l) => (
            <div key={l.href}>
              <Link href={l.href} className="text-slate-500 hover:text-violet-600 dark:hover:text-violet-400">
                {l.label}
              </Link>
            </div>
          ))}
        </div>

        <div className="space-y-2">
          <div className="font-bold text-slate-900 dark:text-white mb-2">پشتیبانی و پلتفرم</div>
          <div className="text-slate-500">تلفن پشتیبانی: ۰۲۱-۸۸۷۷۶۶۵۵</div>
          <div className="text-slate-500 font-mono" dir="ltr">
            support@businessos.ir
          </div>
          <div className="pt-2">
            <Link
              href="/app"
              className="inline-flex items-center gap-1.5 text-violet-600 dark:text-violet-400 font-semibold"
            >
              <span>ورود به پنل مدیریت و سازمان ←</span>
            </Link>
          </div>
        </div>
      </div>
      <div className="border-t border-slate-200/50 dark:border-slate-800/70 py-4 text-center text-[11px] text-slate-500">
        © ۱۴۰۵ Business OS — سامانه یکپارچه حسابداری، انبارداری و مدیریت کسب‌وکار. تمامی حقوق محفوظ است.
      </div>
    </footer>
  );
}

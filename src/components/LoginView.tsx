"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertCircle,
  ArrowLeftRight,
  ArrowRight,
  BarChart3,
  BookOpen,
  Boxes,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CreditCard,
  KeyRound,
  Layers,
  Lock,
  ShieldCheck,
  ShoppingBag,
  Smartphone,
  Sparkles,
  Wallet,
} from "lucide-react";
import { apiFetch } from "@/lib/format";

interface LoginViewProps {
  onSuccess: () => Promise<void>;
}

interface PresentationSlide {
  id: number;
  badge: string;
  title: string;
  description: string;
  highlights: string[];
  accentGradient: string;
  badgeTone: string;
  icon: React.ComponentType<{ className?: string }>;
}

const PRESENTATION_SLIDES: PresentationSlide[] = [
  {
    id: 0,
    badge: "داشبورد مالی Glassmorphism",
    title: "رصد لحظه‌ای درآمد، فروش و هزینه با نمودارهای روزانه",
    description:
      "نمای یکپارچه نقدینگی، سود خالص واقعی از دفتر کل، مطالبات مشتریان و ۳ نمودار روزانه درآمد، فروش قطعی و هزینه‌های عملیاتی همراه با Drill-Down روی هر تاریخ.",
    highlights: ["تفکیک درآمد از تسویه بدهی", "Drill-Down اسناد هر روز", "تم روشن و تاریک شیشه‌ای"],
    accentGradient: "from-violet-600 via-indigo-600 to-sky-600",
    badgeTone: "bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-400/30",
    icon: BarChart3,
  },
  {
    id: 1,
    badge: "موتور حرفه‌ای حسابداری دوبل",
    title: "کدینگ ۴ سطحی، سند افتتاحیه و بستن سال مالی",
    description:
      "هر فاکتور و تراکنش به‌صورت اتمیک سند دوبل متوازن تولید می‌کند. چک‌لیست پیش از بستن سال، سند اختتامیه به سود انباشته، انتقال حساب‌های دائمی و خروجی رسمی Excel (.xlsx).",
    highlights: ["محاسبات دقیق Decimal بدون Float", "سند معکوس بدون حذف تاریخچه", "خروجی اکسل دفتر روزنامه"],
    accentGradient: "from-emerald-600 via-teal-600 to-cyan-600",
    badgeTone: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-400/30",
    icon: BookOpen,
  },
  {
    id: 2,
    badge: "فروش سریع، پرداخت ترکیبی و چک",
    title: "پرداخت هم‌زمان نقد + کارت‌خوان + نسیه روی یک فاکتور",
    description:
      "فاکتور فروش را در چند ثانیه ثبت کنید، مبلغ را بین صندوق، دستگاه POS و مانده مشتری تقسیم کنید، امتیاز وفاداری بدهید و نسخه PDF فارسی چاپ یا ارسال نمایید.",
    highlights: ["چند روش پرداخت هم‌زمان", "چرخه کامل چک صیادی و نمودار ماهانه", "تبدیل پیش‌فاکتور به فاکتور"],
    accentGradient: "from-sky-600 via-indigo-600 to-violet-600",
    badgeTone: "bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-400/30",
    icon: ShoppingBag,
  },
  {
    id: 3,
    badge: "انبار اتمیک و همگام‌سازی آفلاین اندروید",
    title: "کاردکس Stock Ledger، تنوع کالا و Sync بدون خطا",
    description:
      "بدون اینترنت در اپلیکیشن اندروید کار کنید و با اتصال شبکه تغییرات را با Outbox/Inbox و Idempotency همگام کنید. پشتیبانی از رنگ و سایز، امانی و پیشنهاد خرید هوشمند.",
    highlights: ["جلوگیری از موجودی منفی چنددستگاهی", "پیشنهاد خرید با لحاظ PO در راه", "تفکیک مالکیت کالای امانی"],
    accentGradient: "from-teal-600 via-emerald-600 to-sky-600",
    badgeTone: "bg-teal-500/15 text-teal-700 dark:text-teal-300 border-teal-400/30",
    icon: Boxes,
  },
  {
    id: 4,
    badge: "مالی شخصی مالک و امنیت چندمستاجری",
    title: "جداسازی برداشت شخصی مالک از سود شرکت + RBAC دقیق",
    description:
      "برداشت‌های شخصی و اقساط مالک بدون کاهش کاذب سود کسب‌وکار ثبت می‌شوند. دعوت همکاران با محدودیت شعبه و انبار، پیامک OTP رسمی (SMS.ir/کاوه‌نگار) و ایزوله‌سازی PostgreSQL RLS.",
    highlights: ["حریم خصوصی کامل مالی شخصی", "دعوت یک‌بارمصرف و ابطال فوری نشست", "امنیت چندمستاجری RLS"],
    accentGradient: "from-rose-600 via-violet-600 to-indigo-600",
    badgeTone: "bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-400/30",
    icon: Wallet,
  },
];

function SlideVisualStage({ slideIndex, isActive }: { slideIndex: number; isActive: boolean }) {
  // Slide 1: Animated Glass Financial Dashboard + Daily Bars
  if (slideIndex === 0) {
    const bars = [42, 68, 54, 86, 62, 95, 78, 88];
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-2.5 text-right">
          <div className="rounded-xl bg-white/15 backdrop-blur border border-white/20 p-3">
            <div className="text-[10px] text-white/75">درآمد شناسایی‌شده</div>
            <div className="text-sm font-extrabold text-white mt-1 tabular-nums">۳۴۲٬۰۰۰٬۰۰۰</div>
            <div className="text-[10px] text-emerald-300 mt-0.5">+۱۸.۴٪ رشد روزانه</div>
          </div>
          <div className="rounded-xl bg-white/15 backdrop-blur border border-white/20 p-3">
            <div className="text-[10px] text-white/75">موجودی نقد و بانک</div>
            <div className="text-sm font-extrabold text-white mt-1 tabular-nums">۲٬۲۰۰٬۰۰۰٬۰۰۰</div>
            <div className="text-[10px] text-sky-200 mt-0.5">تراز ۱۰۰٪ دقیق ✓</div>
          </div>
          <div className="rounded-xl bg-white/15 backdrop-blur border border-white/20 p-3">
            <div className="text-[10px] text-white/75">ارزش موجودی انبار</div>
            <div className="text-sm font-extrabold text-white mt-1 tabular-nums">۲٬۶۵۸٬۰۰۰٬۰۰۰</div>
            <div className="text-[10px] text-amber-200 mt-0.5">کاردکس لحظه‌ای</div>
          </div>
        </div>
        <div className="rounded-xl bg-slate-950/35 border border-white/15 p-3.5">
          <div className="flex items-center justify-between text-[10px] text-white/80 mb-2.5">
            <span>نمودار فروش و درآمد روزانه (کلیک جهت Drill-Down)</span>
            <span className="font-mono text-emerald-300">LIVE LEDGER</span>
          </div>
          <div className="h-24 flex items-end gap-2 px-1" dir="ltr">
            {bars.map((h, i) => (
              <div key={i} className="flex-1 flex flex-col items-center gap-1 h-full justify-end">
                <div
                  style={{
                    height: isActive ? `${h}%` : "18%",
                    transition: `height 650ms cubic-bezier(0.22, 1, 0.36, 1) ${i * 45}ms`,
                  }}
                  className="w-full rounded-t-md bg-gradient-to-t from-violet-400/80 via-sky-300/90 to-emerald-300"
                />
                <span className="text-[9px] font-mono text-white/60">0{i + 1}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Slide 2: Double-Entry Accounting & Fiscal Year Closing
  if (slideIndex === 1) {
    return (
      <div className="space-y-2.5">
        <div className="rounded-xl bg-slate-950/35 border border-white/15 p-3.5 space-y-2">
          <div className="flex items-center justify-between text-[11px] text-white">
            <span className="font-bold">سند اختتامیه و تراز آزمایشی سال ۱۴۰۴</span>
            <span className="px-2 py-0.5 rounded-full bg-emerald-400/20 text-emerald-200 font-mono text-[10px]">
              SUM(DR) == SUM(CR)
            </span>
          </div>
          {[
            { code: "4101", name: "بستن درآمد فروش کالا", dr: "۳۴۲٬۰۰۰٬۰۰۰", cr: "۰" },
            { code: "5101", name: "بستن بهای تمام‌شده و هزینه‌ها", dr: "۰", cr: "۲۲۴٬۰۰۰٬۰۰۰" },
            { code: "3301", name: "انتقال سود خالص به سود انباشته", dr: "۰", cr: "۱۱۸٬۰۰۰٬۰۰۰" },
          ].map((row) => (
            <div
              key={row.code}
              className="flex items-center justify-between rounded-lg bg-white/10 px-3 py-2 text-[11px] text-white tabular-nums"
            >
              <span className="truncate">
                <span className="font-mono text-emerald-300 ml-1.5">{row.code}</span>
                {row.name}
              </span>
              <span className="font-mono text-[10px] text-white/85 shrink-0">
                {row.dr !== "۰" ? `بد: ${row.dr}` : `بس: ${row.cr}`}
              </span>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between rounded-xl bg-white/15 border border-white/20 px-3.5 py-2 text-[11px] text-white">
          <span>چک‌لیست پیش از بستن سال مالی</span>
          <span className="inline-flex items-center gap-1 text-emerald-200 font-semibold">
            <CheckCircle2 className="h-3.5 w-3.5" />
            تایید و آماده خروجی Excel (.xlsx)
          </span>
        </div>
      </div>
    );
  }

  // Slide 3: Mixed Payment Sales Invoice & Cheque Lifecycle
  if (slideIndex === 2) {
    return (
      <div className="space-y-2.5">
        <div className="rounded-xl bg-slate-950/35 border border-white/15 p-3.5 space-y-2.5 text-white">
          <div className="flex items-center justify-between text-xs">
            <span className="font-bold">فاکتور فروش #SI-1404-208</span>
            <span className="font-mono font-bold tabular-nums">۶٬۰۰۰٬۰۰۰ ریال</span>
          </div>
          <div className="space-y-1.5 text-[11px]">
            <div className="flex items-center justify-between">
              <span>پرداخت نقدی (صندوق)</span>
              <span className="font-mono text-emerald-300">۱٬۰۰۰٬۰۰۰ ریال</span>
            </div>
            <div className="h-1.5 rounded-full bg-white/15 overflow-hidden">
              <div
                style={{ width: isActive ? "17%" : "0%", transition: "width 700ms ease" }}
                className="h-full bg-emerald-400 rounded-full"
              />
            </div>
            <div className="flex items-center justify-between pt-1">
              <span>کارت‌خوان فروشگاهی (POS)</span>
              <span className="font-mono text-sky-300">۳٬۰۰۰٬۰۰۰ ریال</span>
            </div>
            <div className="h-1.5 rounded-full bg-white/15 overflow-hidden">
              <div
                style={{ width: isActive ? "50%" : "0%", transition: "width 750ms ease 80ms" }}
                className="h-full bg-sky-400 rounded-full"
              />
            </div>
            <div className="flex items-center justify-between pt-1">
              <span>مانده نسیه / چک صیادی</span>
              <span className="font-mono text-amber-300">۲٬۰۰۰٬۰۰۰ ریال</span>
            </div>
            <div className="h-1.5 rounded-full bg-white/15 overflow-hidden">
              <div
                style={{ width: isActive ? "33%" : "0%", transition: "width 800ms ease 140ms" }}
                className="h-full bg-amber-400 rounded-full"
              />
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 text-[11px] text-white">
          <div className="rounded-xl bg-white/15 border border-white/20 px-3 py-2 flex items-center gap-2">
            <CreditCard className="h-4 w-4 text-emerald-300 shrink-0" />
            <span>کسر خودکار انبار + سند دوبل</span>
          </div>
          <div className="rounded-xl bg-white/15 border border-white/20 px-3 py-2 flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-amber-300 shrink-0" />
            <span>امتیاز باشگاه مشتریان + PDF</span>
          </div>
        </div>
      </div>
    );
  }

  // Slide 4: Atomic Warehouse Transfer & Offline Android Sync
  if (slideIndex === 3) {
    return (
      <div className="space-y-3">
        <div className="rounded-xl bg-slate-950/35 border border-white/15 p-4 text-white">
          <div className="flex items-center justify-between gap-3">
            <div className="bos-float flex-1 rounded-xl bg-white/15 border border-white/25 p-3 text-center">
              <Smartphone className="h-5 w-5 mx-auto text-emerald-300 mb-1" />
              <div className="text-[11px] font-bold">Android Room Outbox</div>
              <div className="text-[10px] text-white/70 mt-0.5">ثبت آفلاین + Client UUID</div>
            </div>
            <div className="flex flex-col items-center gap-1 shrink-0">
              <ArrowLeftRight className="h-5 w-5 text-sky-300" />
              <span className="text-[9px] font-mono text-emerald-200">Idempotent</span>
            </div>
            <div className="bos-float flex-1 rounded-xl bg-white/15 border border-white/25 p-3 text-center">
              <Boxes className="h-5 w-5 mx-auto text-sky-300 mb-1" />
              <div className="text-[11px] font-bold">PostgreSQL Stock Ledger</div>
              <div className="text-[10px] text-white/70 mt-0.5">قفل اتمیک + Opaque Cursor</div>
            </div>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2 text-[10px] text-white text-center">
          <div className="rounded-xl bg-white/15 border border-white/20 p-2.5">
            <div className="font-bold">۱۴ موجودیت Sync</div>
            <div className="text-white/75 mt-0.5">Push / Pull / Tombstone</div>
          </div>
          <div className="rounded-xl bg-white/15 border border-white/20 p-2.5">
            <div className="font-bold">تنوع کالا و امانی</div>
            <div className="text-white/75 mt-0.5">کاردکس مستقل</div>
          </div>
          <div className="rounded-xl bg-white/15 border border-white/20 p-2.5">
            <div className="font-bold">خرید هوشمند PO</div>
            <div className="text-white/75 mt-0.5">نقطه سفارش خودکار</div>
          </div>
        </div>
      </div>
    );
  }

  // Slide 5: Owner Personal Finance & Multi-Tenant Security
  return (
    <div className="space-y-2.5">
      <div className="grid grid-cols-2 gap-2.5 text-white text-xs">
        <div className="rounded-xl bg-slate-950/35 border border-white/15 p-3.5 space-y-1.5">
          <div className="text-[10px] text-emerald-300 font-semibold">دفتر مالی کسب‌وکار</div>
          <div className="font-bold">سود خالص بدون تحریف</div>
          <div className="text-[11px] text-white/80 tabular-nums">
            برداشت ۵٬۰۰۰٬۰۰۰ ← حساب جاری مالک (۳۲۰۱)
          </div>
          <div className="text-[10px] text-emerald-200">هزینه عملیاتی شرکت: ۰ ریال ✓</div>
        </div>
        <div className="rounded-xl bg-slate-950/35 border border-white/15 p-3.5 space-y-1.5">
          <div className="text-[10px] text-amber-300 font-semibold">دفتر مالی شخصی مالک</div>
          <div className="font-bold">حریم خصوصی ۱۰۰٪ مجزا</div>
          <div className="text-[11px] text-white/80 tabular-nums">
            ۳M مخارج خانه + ۲M قسط وام
          </div>
          <div className="text-[10px] text-rose-200">دسترسی پرسنل فروش: مسدود (403)</div>
        </div>
      </div>
      <div className="rounded-xl bg-white/15 border border-white/20 px-4 py-2.5 flex flex-wrap items-center justify-between gap-2 text-[11px] text-white">
        <span className="inline-flex items-center gap-1.5 font-semibold">
          <ShieldCheck className="h-4 w-4 text-emerald-300" />
          <span>۸۷ جدول محافظت‌شده با PostgreSQL RLS + پیامک OTP رسمی</span>
        </span>
        <span className="font-mono text-[10px] text-white/80">SMS.ir • Kavenegar</span>
      </div>
    </div>
  );
}

export function LoginView({ onSuccess }: LoginViewProps) {
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeSlide, setActiveSlide] = useState(0);

  // Automatic 2-second slide advancement across all 5 presentation slides
  useEffect(() => {
    const timer = window.setInterval(() => {
      setActiveSlide((prev) => (prev + 1) % PRESENTATION_SLIDES.length);
    }, 2000);
    return () => window.clearInterval(timer);
  }, []);

  async function doLogin(targetId: string, targetPassword: string) {
    setLoading(true);
    setError(null);
    try {
      const isEmail = targetId.includes("@");
      await apiFetch("/api/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({
          ...(isEmail ? { email: targetId } : { mobile: targetId }),
          password: targetPassword,
        }),
      });
      await onSuccess();
    } catch (e) {
      setError(e instanceof Error ? e.message : "خطا در ورود به سیستم");
    } finally {
      setLoading(false);
    }
  }

  const slide = PRESENTATION_SLIDES[activeSlide];
  const SlideIcon = slide.icon;

  return (
    <div className="min-h-screen flex flex-col justify-center py-8 px-4 sm:px-6 lg:px-8">
      <div className="mx-auto w-full max-w-6xl space-y-4">
        <div className="flex items-center justify-between text-xs">
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 glass-secondary px-3.5 py-1.5 font-semibold hover:border-violet-400 transition-colors"
          >
            <ArrowRight className="h-3.5 w-3.5" />
            <span>بازگشت به وب‌سایت Business OS</span>
          </Link>
          <span className="text-[11px] font-mono glass-secondary px-3 py-1 text-slate-500">
            API /api/v1 • Glass UI
          </span>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
          {/* Right Column (RTL first): Secure Auth Form */}
          <div className="lg:col-span-5 glass-primary p-8 flex flex-col justify-between">
            <div>
              <div className="flex items-center gap-3 mb-6">
                <div className="h-11 w-11 rounded-xl bg-gradient-to-br from-violet-600 to-indigo-600 text-white flex items-center justify-center shadow-sm">
                  <Layers className="h-6 w-6" />
                </div>
                <div>
                  <h1 className="text-xl font-extrabold tracking-tight">Business OS</h1>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    سامانه حسابداری، انبارداری و مدیریت چندمستاجری
                  </p>
                </div>
              </div>

              <div className="mb-6">
                <h2 className="text-lg font-bold">ورود امن به پنل مدیریت و سازمان</h2>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
                  با شماره موبایل یا ایمیل سازمانی خود وارد شوید. احراز هویت با چرخش Refresh Token و جداسازی چندمستاجری محافظت می‌شود.
                </p>
              </div>

              {error && (
                <div className="mb-4 rounded-xl border border-rose-200 dark:border-rose-800 bg-rose-500/10 px-3.5 py-2.5 text-xs text-rose-700 dark:text-rose-300 flex items-center gap-2">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  doLogin(identifier.trim(), password);
                }}
                className="space-y-4"
              >
                <div>
                  <label className="block text-xs font-medium mb-1.5">
                    شماره موبایل یا ایمیل
                  </label>
                  <input
                    type="text"
                    dir="ltr"
                    placeholder="0912... یا user@company.ir"
                    value={identifier}
                    onChange={(e) => setIdentifier(e.target.value)}
                    required
                    className="w-full glass-input px-3.5 py-2.5 text-sm text-left"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1.5">رمز عبور</label>
                  <input
                    type="password"
                    dir="ltr"
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    className="w-full glass-input px-3.5 py-2.5 text-sm text-left"
                  />
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full rounded-xl bg-gradient-to-l from-violet-600 to-indigo-600 hover:from-violet-700 hover:to-indigo-700 disabled:opacity-50 text-white py-2.5 px-4 text-sm font-bold shadow-sm transition-all flex items-center justify-center gap-2 cursor-pointer"
                >
                  <KeyRound className="h-4 w-4" />
                  <span>{loading ? "در حال احراز هویت..." : "ورود به سامانه"}</span>
                </button>
              </form>
            </div>

            <div className="mt-8 pt-5 border-t border-slate-200/60 dark:border-slate-700/60 grid grid-cols-3 gap-2 text-center">
              <div className="glass-secondary p-2.5">
                <ShieldCheck className="h-4 w-4 mx-auto text-violet-600 dark:text-violet-400 mb-1" />
                <div className="text-[11px] font-medium">PostgreSQL RLS</div>
              </div>
              <div className="glass-secondary p-2.5">
                <Lock className="h-4 w-4 mx-auto text-emerald-600 dark:text-emerald-400 mb-1" />
                <div className="text-[11px] font-medium">حسابداری دوبل</div>
              </div>
              <div className="glass-secondary p-2.5">
                <Smartphone className="h-4 w-4 mx-auto text-sky-600 dark:text-sky-400 mb-1" />
                <div className="text-[11px] font-medium">Sync آفلاین</div>
              </div>
            </div>
          </div>

          {/* Left Column: 5-Slide Smooth Cross-Fade Presentation Showcase */}
          <div className="lg:col-span-7 glass-primary p-6 sm:p-8 flex flex-col justify-between overflow-hidden relative">
            {/* Top Slide Meta & Controls */}
            <div className="flex items-center justify-between gap-3 mb-4">
              <div className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-bold transition-colors duration-500 ${slide.badgeTone}`}>
                <SlideIcon className="h-3.5 w-3.5" />
                <span>{slide.badge}</span>
              </div>

              <div className="flex items-center gap-2">
                <span className="text-[11px] font-mono text-slate-500 tabular-nums">
                  {activeSlide + 1} / {PRESENTATION_SLIDES.length}
                </span>
                <button
                  type="button"
                  aria-label="اسلاید قبلی"
                  onClick={() =>
                    setActiveSlide(
                      (prev) => (prev - 1 + PRESENTATION_SLIDES.length) % PRESENTATION_SLIDES.length
                    )
                  }
                  className="h-7 w-7 rounded-lg glass-input flex items-center justify-center cursor-pointer hover:border-violet-400"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  aria-label="اسلاید بعدی"
                  onClick={() =>
                    setActiveSlide((prev) => (prev + 1) % PRESENTATION_SLIDES.length)
                  }
                  className="h-7 w-7 rounded-lg glass-input flex items-center justify-center cursor-pointer hover:border-violet-400"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
              </div>
            </div>

            {/* Smooth Layered Cross-Fade Stage (all 5 slides pre-mounted, zero flicker) */}
            <div className="grid flex-1">
              {PRESENTATION_SLIDES.map((s, idx) => {
                const isCurrent = idx === activeSlide;
                return (
                  <div
                    key={s.id}
                    aria-hidden={!isCurrent}
                    className={`col-start-1 row-start-1 bos-slide-layer flex flex-col justify-between ${
                      isCurrent
                        ? "opacity-100 translate-y-0 scale-100 pointer-events-auto z-10"
                        : "opacity-0 translate-y-2 scale-[0.985] pointer-events-none z-0"
                    }`}
                  >
                    <div
                      className={`rounded-2xl bg-gradient-to-br ${s.accentGradient} p-4 sm:p-5 shadow-md min-h-[250px] flex flex-col justify-center`}
                    >
                      <SlideVisualStage slideIndex={idx} isActive={isCurrent} />
                    </div>

                    <div className="mt-5 space-y-3">
                      <h3 className="text-lg font-extrabold leading-snug">{s.title}</h3>
                      <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                        {s.description}
                      </p>
                      <div className="flex flex-wrap gap-2 pt-1">
                        {s.highlights.map((item) => (
                          <span
                            key={item}
                            className="inline-flex items-center gap-1 rounded-lg glass-secondary px-2.5 py-1 text-[11px] font-medium"
                          >
                            <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0" />
                            <span>{item}</span>
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Minimal Smooth Slide Indicators */}
            <div className="mt-6 pt-4 border-t border-slate-200/60 dark:border-slate-700/60 flex items-center justify-center">
              <div className="flex items-center gap-2">
                {PRESENTATION_SLIDES.map((s, idx) => (
                  <button
                    key={s.id}
                    type="button"
                    aria-label={`اسلاید ${idx + 1}: ${s.badge}`}
                    onClick={() => setActiveSlide(idx)}
                    className={`h-2 rounded-full transition-all duration-500 cursor-pointer ${
                      idx === activeSlide
                        ? "w-8 bg-violet-600"
                        : "w-2 bg-slate-300 dark:bg-slate-600 hover:bg-violet-400"
                    }`}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

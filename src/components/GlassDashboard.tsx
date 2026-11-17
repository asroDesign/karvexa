"use client";

import React, { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowUpLeft,
  BarChart3,
  BookOpen,
  Boxes,
  Calendar,
  CreditCard,
  Landmark,
  Package,
  RefreshCw,
  Settings,
  ShoppingBag,
  TrendingDown,
  TrendingUp,
  UserPlus,
  Wallet,
  X,
  Zap,
} from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { apiFetch, formatDateFa, formatIrr } from "@/lib/format";

interface GlassDashboardProps {
  orgId: string | null;
  onNavigate: (tab: string) => void;
  onToast: (msg: string, type?: "success" | "error") => void;
}

type DateRangeKey = "today" | "7d" | "30d" | "month" | "prev_month" | "custom";

export function GlassDashboard({ orgId, onNavigate, onToast }: GlassDashboardProps) {
  const [loading, setLoading] = useState(false);
  const [overview, setOverview] = useState<Record<string, unknown> | null>(null);
  const [range, setRange] = useState<DateRangeKey>("30d");
  const [customFrom, setCustomFrom] = useState("2025-07-01");
  const [customTo, setCustomTo] = useState(new Date().toISOString().slice(0, 10));

  const [revMetric, setRevMetric] = useState<"recognized_revenue" | "cash_received">("recognized_revenue");
  const [includePersonalExp, setIncludePersonalExp] = useState(false);

  const [revChart, setRevChart] = useState<Record<string, unknown> | null>(null);
  const [salesChart, setSalesChart] = useState<Record<string, unknown> | null>(null);
  const [expChart, setExpChart] = useState<Record<string, unknown> | null>(null);

  // Drill-down modal state
  const [drilldown, setDrilldown] = useState<{
    metric: "revenue" | "sales" | "expenses";
    date: string;
    records: Array<Record<string, unknown>>;
  } | null>(null);

  const buildQuery = useCallback(() => {
    if (range === "custom") {
      return `range=custom&from=${encodeURIComponent(customFrom)}&to=${encodeURIComponent(customTo)}`;
    }
    return `range=${range}`;
  }, [range, customFrom, customTo]);

  const loadAll = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    try {
      const qs = buildQuery();
      const [ov, rev, sal, exp] = await Promise.all([
        apiFetch<Record<string, unknown>>("/api/v1/dashboard/overview", { organizationId: orgId }),
        apiFetch<Record<string, unknown>>(
          `/api/v1/dashboard/charts/revenue?${qs}&metric=${revMetric}`,
          { organizationId: orgId }
        ),
        apiFetch<Record<string, unknown>>(`/api/v1/dashboard/charts/sales?${qs}`, {
          organizationId: orgId,
        }),
        apiFetch<Record<string, unknown>>(
          `/api/v1/dashboard/charts/expenses?${qs}&include_personal=${includePersonalExp}`,
          { organizationId: orgId }
        ),
      ]);
      setOverview(ov);
      setRevChart(rev);
      setSalesChart(sal);
      setExpChart(exp);
    } catch (e) {
      onToast(e instanceof Error ? e.message : "خطا در بارگذاری داشبورد مالی", "error");
    } finally {
      setLoading(false);
    }
  }, [orgId, buildQuery, revMetric, includePersonalExp, onToast]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  async function openDrilldown(metric: "revenue" | "sales" | "expenses", date: string) {
    if (!orgId || !date) return;
    try {
      const res = await apiFetch<{
        metric: "revenue" | "sales" | "expenses";
        date: string;
        records: Array<Record<string, unknown>>;
      }>(`/api/v1/dashboard/charts/drilldown?metric=${metric}&date=${encodeURIComponent(date)}`, {
        organizationId: orgId,
      });
      setDrilldown(res);
    } catch (err) {
      onToast(err instanceof Error ? err.message : "خطا در دریافت جزئیات روز", "error");
    }
  }

  const summary = (overview?.summary ?? {}) as Record<string, string | boolean | null>;
  const perms = (overview?.permissions ?? {}) as Record<string, boolean>;
  const alerts = (overview?.alerts as Array<{ code: string; severity: string; title: string; count: number }>) ?? [];

  const revSeries = ((revChart?.series as Array<Record<string, unknown>>) ?? []).map((r) => ({
    date: String(r.date),
    label: String(r.date).slice(5),
    value: Number(r.value || 0),
    recognized: Number(r.recognized_revenue || 0),
    cash: Number(r.cash_received || 0),
  }));

  const salesSeries = ((salesChart?.series as Array<Record<string, unknown>>) ?? []).map((r) => ({
    date: String(r.date),
    label: String(r.date).slice(5),
    netSales: Number(r.net_sales || 0),
    invoicesCount: Number(r.invoices_count || 0),
  }));

  const expSeries = ((expChart?.series as Array<Record<string, unknown>>) ?? []).map((r) => ({
    date: String(r.date),
    label: String(r.date).slice(5),
    business: Number(r.business_expenses || 0),
    personal: Number(r.personal_expenses || 0),
  }));

  const kpiCards = [
    {
      label: "درآمد کل شناسایی‌شده (دفتر کل)",
      value: `${formatIrr(summary.total_revenue as string)} ریال`,
      sub: `امروز: ${formatIrr(summary.today_revenue as string)} ریال`,
      icon: TrendingUp,
      accent: "from-violet-500/20 to-indigo-500/10 text-violet-700 dark:text-violet-300",
      target: "accounting",
    },
    {
      label: "سود خالص کسب‌وکار",
      value:
        summary.net_profit === null || summary.net_profit === undefined
          ? "محدود به مجوز"
          : `${formatIrr(summary.net_profit as string)} ریال`,
      sub:
        summary.gross_profit === null || summary.gross_profit === undefined
          ? "نیازمند reports.profit.view"
          : `سود ناخالص: ${formatIrr(summary.gross_profit as string)}`,
      icon: BarChart3,
      accent: "from-emerald-500/20 to-teal-500/10 text-emerald-700 dark:text-emerald-300",
      target: "accounting",
    },
    {
      label: "موجودی نقد و بانک",
      value: `${formatIrr(Number(summary.cash_balance || 0) + Number(summary.bank_balance || 0))} ریال`,
      sub: `صندوق: ${formatIrr(summary.cash_balance as string)} | بانک: ${formatIrr(summary.bank_balance as string)}`,
      icon: Landmark,
      accent: "from-sky-500/20 to-cyan-500/10 text-sky-700 dark:text-sky-300",
      target: "treasury",
    },
    {
      label: "ارزش موجودی انبار (Ledger)",
      value: `${formatIrr(summary.inventory_value as string)} ریال`,
      sub: summary.is_trial_balanced ? "تراز آزمایشی ۱۰۰٪ دقیق ✓" : "نیازمند بررسی تراز",
      icon: Boxes,
      accent: "from-teal-500/20 to-emerald-500/10 text-teal-700 dark:text-teal-300",
      target: "inventory",
    },
    {
      label: "مطالبات مشتریان (دریافتنی)",
      value: `${formatIrr(summary.customer_receivables as string)} ریال`,
      sub: `بدهی تأمین‌کنندگان: ${formatIrr(summary.supplier_payables as string)}`,
      icon: CreditCard,
      accent: "from-amber-500/20 to-orange-500/10 text-amber-700 dark:text-amber-300",
      target: "contacts",
    },
    {
      label: "برداشت مالک (مجزا از هزینه)",
      value:
        summary.owner_withdrawals === null || summary.owner_withdrawals === undefined
          ? "محرمانه (مالک)"
          : `${formatIrr(summary.owner_withdrawals as string)} ریال`,
      sub: "بدون اثر بر سود عملیاتی",
      icon: Wallet,
      accent: "from-rose-500/20 to-pink-500/10 text-rose-700 dark:text-rose-300",
      target: "personal_finance",
    },
  ];

  const quickActions = [
    { label: "فروش سریع + POS", tab: "mixed_sales", icon: ShoppingBag, color: "text-emerald-600 dark:text-emerald-400" },
    { label: "هزینه و درآمد سریع", tab: "quick_entry", icon: Zap, color: "text-amber-600 dark:text-amber-400" },
    { label: "مالی شخصی مالک", tab: "personal_finance", icon: Wallet, color: "text-violet-600 dark:text-violet-400" },
    { label: "کدینگ و سال مالی", tab: "fiscal_lifecycle", icon: BookOpen, color: "text-indigo-600 dark:text-indigo-400" },
    { label: "تنوع و خرید هوشمند", tab: "variants_replenish", icon: Package, color: "text-teal-600 dark:text-teal-400" },
    { label: "دعوت و دسترسی کاربران", tab: "settings_access", icon: UserPlus, color: "text-sky-600 dark:text-sky-400" },
    { label: "داشبورد و نمودار چک", tab: "cheque_analytics", icon: Landmark, color: "text-rose-600 dark:text-rose-400" },
    { label: "تنظیمات و تم شیشه‌ای", tab: "settings_access", icon: Settings, color: "text-slate-600 dark:text-slate-300" },
  ];

  return (
    <div className="space-y-6">
      {/* 1. Glass Hero Header */}
      <div className="glass-primary p-5 sm:p-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="inline-flex items-center gap-2 text-[11px] font-semibold px-2.5 py-1 rounded-full bg-violet-500/10 text-violet-700 dark:text-violet-300 border border-violet-500/20">
            <span>داده‌های قطعی و زنده دفتر کل</span>
            <span>•</span>
            <span>{formatDateFa(new Date())}</span>
          </div>
          <h2 className="text-xl font-bold mt-2 tracking-tight">
            نمای یکپارچه مالی و عملیاتی کسب‌وکار
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            تمام ارقام از اسناد قطعی حسابداری و Stock Ledger محاسبه شده‌اند (کلیک روی نمودارها برای Drill-Down روزانه)
          </p>
        </div>
        <button
          type="button"
          onClick={loadAll}
          className="glass-input inline-flex items-center gap-2 px-4 py-2 text-xs font-medium cursor-pointer hover:border-violet-400"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          <span>بروزرسانی زنده</span>
        </button>
      </div>

      {/* 2. Operational Alerts */}
      {alerts.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {alerts.map((al) => (
            <div
              key={al.code}
              className={`glass-secondary px-4 py-3 flex items-center justify-between gap-3 text-xs border-r-4 ${
                al.severity === "critical"
                  ? "border-r-rose-500"
                  : al.severity === "warn"
                    ? "border-r-amber-500"
                    : "border-r-sky-500"
              }`}
            >
              <div className="flex items-center gap-2.5">
                <AlertTriangle
                  className={`h-4 w-4 shrink-0 ${
                    al.severity === "critical"
                      ? "text-rose-500"
                      : al.severity === "warn"
                        ? "text-amber-500"
                        : "text-sky-500"
                  }`}
                />
                <span className="font-medium">{al.title}</span>
              </div>
              <span className="font-bold tabular-nums px-2 py-0.5 rounded-full bg-slate-900/10 dark:bg-white/10">
                {al.count}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* 3. Main Financial Summary Glass Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
        {kpiCards.map((card) => {
          const Icon = card.icon;
          return (
            <button
              key={card.label}
              type="button"
              onClick={() => onNavigate(card.target)}
              className="glass-primary p-5 text-right group hover:-translate-y-0.5 cursor-pointer"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                  {card.label}
                </span>
                <div className={`h-9 w-9 rounded-xl bg-gradient-to-br ${card.accent} flex items-center justify-center`}>
                  <Icon className="h-4 w-4" />
                </div>
              </div>
              <div className="text-xl font-bold mt-3 tabular-nums tracking-tight">
                {card.value}
              </div>
              <div className="mt-2.5 flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400">
                <span className="truncate">{card.sub}</span>
                <ArrowUpLeft className="h-3.5 w-3.5 opacity-0 group-hover:opacity-100 transition-opacity text-violet-500 shrink-0" />
              </div>
            </button>
          );
        })}
      </div>

      {/* 4. Quick Actions Glass Strip */}
      <div className="glass-secondary p-4">
        <div className="text-xs font-bold mb-3 px-1">دسترسی سریع عملیات روزانه</div>
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2.5">
          {quickActions.map((qa) => {
            const Icon = qa.icon;
            return (
              <button
                key={qa.label}
                type="button"
                onClick={() => onNavigate(qa.tab)}
                className="glass-primary p-3 flex flex-col items-center justify-center gap-2 text-center hover:border-violet-400/60 cursor-pointer"
              >
                <Icon className={`h-5 w-5 ${qa.color}`} />
                <span className="text-[11px] font-medium leading-tight">{qa.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 5. MANDATORY LOWER SECTION: 3 DAILY FINANCIAL CHARTS (§5) */}
      <div className="space-y-4 pt-2">
        <div className="glass-primary px-5 py-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-bold flex items-center gap-2">
              <Calendar className="h-4 w-4 text-violet-500" />
              <span>نمودارهای روزانه درآمد، فروش و هزینه کسب‌وکار</span>
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              روی هر روز در نمودار کلیک کنید تا اسناد و فاکتورهای قطعی همان روز (Drill-Down) نمایش داده شوند
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {(
              [
                { k: "today", l: "امروز" },
                { k: "7d", l: "۷ روز اخیر" },
                { k: "30d", l: "۳۰ روز اخیر" },
                { k: "month", l: "ماه جاری" },
                { k: "prev_month", l: "ماه قبل" },
                { k: "custom", l: "بازه دلخواه" },
              ] as Array<{ k: DateRangeKey; l: string }>
            ).map((opt) => (
              <button
                key={opt.k}
                type="button"
                onClick={() => setRange(opt.k)}
                className={`px-3 py-1.5 rounded-xl font-medium transition-colors cursor-pointer ${
                  range === opt.k
                    ? "bg-violet-600 text-white shadow-sm"
                    : "glass-input hover:border-violet-400"
                }`}
              >
                {opt.l}
              </button>
            ))}
            {range === "custom" && (
              <div className="flex items-center gap-1.5" dir="ltr">
                <input
                  type="date"
                  value={customFrom}
                  onChange={(e) => setCustomFrom(e.target.value)}
                  className="glass-input px-2 py-1 text-xs font-mono"
                />
                <span>–</span>
                <input
                  type="date"
                  value={customTo}
                  onChange={(e) => setCustomTo(e.target.value)}
                  className="glass-input px-2 py-1 text-xs font-mono"
                />
              </div>
            )}
          </div>
        </div>

        {/* Chart 1: Daily Recognized Revenue Chart (§5.2) */}
        <div className="glass-primary p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h4 className="text-sm font-bold flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-violet-500" />
                <span>۱. نمودار درآمد روزانه (Daily Revenue Chart)</span>
              </h4>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                مبنای پیش‌فرض: درآمد شناسایی‌شده در دفتر کل (تسویه بدهی فاکتورهای قبلی به اشتباه به عنوان درآمد جدید حساب نمی‌شود)
              </p>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <button
                type="button"
                onClick={() => setRevMetric("recognized_revenue")}
                className={`px-3 py-1 rounded-xl cursor-pointer ${
                  revMetric === "recognized_revenue"
                    ? "bg-violet-600 text-white"
                    : "glass-input"
                }`}
              >
                درآمد شناسایی‌شده ({formatIrr((revChart?.totals as Record<string, string>)?.recognized_revenue)})
              </button>
              <button
                type="button"
                onClick={() => setRevMetric("cash_received")}
                className={`px-3 py-1 rounded-xl cursor-pointer ${
                  revMetric === "cash_received"
                    ? "bg-emerald-600 text-white"
                    : "glass-input"
                }`}
              >
                وجوه دریافتی ({formatIrr((revChart?.totals as Record<string, string>)?.cash_received)})
              </button>
            </div>
          </div>

          <div className="h-64 w-full" dir="ltr">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={revSeries}
                onClick={(state) => {
                  const payload = (state as { activePayload?: Array<{ payload: { date: string } }> })?.activePayload?.[0]?.payload;
                  if (payload?.date) openDrilldown("revenue", payload.date);
                }}
              >
                <defs>
                  <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#863bff" stopOpacity={0.45} />
                    <stop offset="95%" stopColor="#863bff" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.22)" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Area
                  type="monotone"
                  dataKey="value"
                  name={revMetric === "recognized_revenue" ? "درآمد شناسایی‌شده (ریال)" : "وجوه دریافتی (ریال)"}
                  stroke="#863bff"
                  strokeWidth={2.5}
                  fill="url(#revGrad)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Chart 2 & Chart 3 side-by-side on large screens */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
          {/* Chart 2: Daily Sales Chart (§5.3) */}
          <div className="glass-primary p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h4 className="text-sm font-bold flex items-center gap-2">
                  <ShoppingBag className="h-4 w-4 text-emerald-500" />
                  <span>۲. نمودار فروش روزانه (Daily Sales Chart)</span>
                </h4>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 tabular-nums">
                  فروش خالص قطعی: <strong>{formatIrr((salesChart?.totals as Record<string, string>)?.net_sales)}</strong> ریال •{" "}
                  {String((salesChart?.totals as Record<string, number>)?.invoices_count ?? 0)} فاکتور تاییدشده
                </p>
              </div>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
                CONFIRMED ONLY
              </span>
            </div>
            <div className="h-64 w-full" dir="ltr">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={salesSeries}
                  onClick={(state) => {
                    const payload = (state as { activePayload?: Array<{ payload: { date: string } }> })?.activePayload?.[0]?.payload;
                    if (payload?.date) openDrilldown("sales", payload.date);
                  }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.22)" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Bar
                    dataKey="netSales"
                    name="فروش خالص روزانه (ریال)"
                    fill="#10b981"
                    radius={[6, 6, 0, 0]}
                    cursor="pointer"
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Chart 3: Daily Business Expense Chart (§5.4) */}
          <div className="glass-primary p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h4 className="text-sm font-bold flex items-center gap-2">
                  <TrendingDown className="h-4 w-4 text-rose-500" />
                  <span>۳. نمودار هزینه روزانه کسب‌وکار (Daily Expense Chart)</span>
                </h4>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 tabular-nums">
                  جمع هزینه‌های عملیاتی: <strong>{formatIrr((expChart?.totals as Record<string, string>)?.business_expenses)}</strong> ریال (مخارج شخصی مجزا است)
                </p>
              </div>
              {perms.can_view_personal_finance && (
                <label className="inline-flex items-center gap-1.5 text-[11px] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={includePersonalExp}
                    onChange={(e) => setIncludePersonalExp(e.target.checked)}
                  />
                  <span>نمایش سری مجزای هزینه شخصی</span>
                </label>
              )}
            </div>
            <div className="h-64 w-full" dir="ltr">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={expSeries}
                  onClick={(state) => {
                    const payload = (state as { activePayload?: Array<{ payload: { date: string } }> })?.activePayload?.[0]?.payload;
                    if (payload?.date) openDrilldown("expenses", payload.date);
                  }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.22)" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Bar
                    dataKey="business"
                    name="هزینه عملیاتی شرکت (ریال)"
                    fill="#f43f5e"
                    radius={[6, 6, 0, 0]}
                    cursor="pointer"
                  />
                  {includePersonalExp && (
                    <Bar
                      dataKey="personal"
                      name="هزینه شخصی مالک (مجزا)"
                      fill="#f59e0b"
                      radius={[6, 6, 0, 0]}
                    />
                  )}
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      </div>

      {/* 6. Interactive Chart Drill-Down Glass Modal (§5.6) */}
      {drilldown && (
        <div className="fixed inset-0 z-50 bg-slate-950/50 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="glass-modal w-full max-w-2xl p-6 space-y-4 max-h-[80vh] overflow-y-auto">
            <div className="flex items-center justify-between gap-2 border-b border-slate-200/60 dark:border-slate-700/60 pb-3">
              <div>
                <h4 className="text-sm font-bold">
                  جزئیات روزانه ({drilldown.metric === "sales" ? "فروش قطعی" : drilldown.metric === "revenue" ? "درآمد شناسایی‌شده" : "هزینه‌های عملیاتی"}) —{" "}
                  <span className="font-mono">{drilldown.date}</span>
                </h4>
                <p className="text-[11px] text-slate-500">
                  {drilldown.records.length} رکورد قطعی در این تاریخ
                </p>
              </div>
              <button
                type="button"
                onClick={() => setDrilldown(null)}
                className="h-8 w-8 rounded-xl glass-input flex items-center justify-center cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {drilldown.records.length === 0 ? (
              <div className="text-center py-8 text-xs text-slate-500">
                در تاریخ {drilldown.date} هیچ سند قطعی برای این شاخص ثبت نشده است.
              </div>
            ) : (
              <div className="space-y-2 text-xs">
                {drilldown.records.map((rec, i) => (
                  <div
                    key={i}
                    className="glass-secondary px-4 py-3 flex items-center justify-between gap-3"
                  >
                    <div>
                      <div className="font-bold">
                        {String(rec.document_number)} {rec.customer_name ? `— ${String(rec.customer_name)}` : ""}
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        {String(rec.account || rec.description || rec.payment_status || "")}
                      </div>
                    </div>
                    <div className="font-bold tabular-nums text-left">
                      {formatIrr(rec.amount as string)} ریال
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

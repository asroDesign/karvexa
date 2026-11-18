"use client";

import React, { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowRightLeft,
  BookOpen,
  CalendarRange,
  CheckCircle2,
  ClipboardCheck,
  FolderTree,
  Lock,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Unlock,
  XCircle,
} from "lucide-react";
import { apiFetch, formatIrr } from "@/lib/format";
import { JalaliDatePicker } from "@/components/JalaliDatePicker";

interface FiscalLifecyclePanelProps {
  orgId: string | null;
  onToast: (msg: string, type?: "success" | "error") => void;
}

export function FiscalLifecyclePanel({ orgId, onToast }: FiscalLifecyclePanelProps) {
  const [loading, setLoading] = useState(false);
  const [section, setSection] = useState<"coa" | "opening" | "fiscal_years" | "comparison">("coa");

  // COA state
  const [groups, setGroups] = useState<Array<Record<string, unknown>>>([]);
  const [accountsList, setAccountsList] = useState<Array<Record<string, unknown>>>([]);
  const [closures, setClosures] = useState<Array<Record<string, unknown>>>([]);
  const [newAcc, setNewAcc] = useState({
    group_id: "",
    account_level: 3,
    code: "",
    name: "",
    account_type: "ASSET",
    normal_balance: "DEBIT",
    is_postable: true,
  });

  // Account Closure modal/panel state
  const [closurePreview, setClosurePreview] = useState<Record<string, unknown> | null>(null);
  const [closureDestId, setClosureDestId] = useState("");
  const [closureReason, setClosureReason] = useState("انتقال مانده و بستن حساب غیرفعال");

  // Opening Balances state
  const [fiscalYearsList, setFiscalYearsList] = useState<Array<Record<string, unknown>>>([]);
  const [openingFyId, setOpeningFyId] = useState("");
  const [openingLines, setOpeningLines] = useState([
    { account_id: "", debit: "", credit: "", description: "مانده اول دوره" },
    { account_id: "", debit: "", credit: "", description: "سرمایه افتتاحیه" },
  ]);

  // Fiscal Year Lifecycle state
  const [selectedFyId, setSelectedFyId] = useState("");
  const [checklist, setChecklist] = useState<Record<string, unknown> | null>(null);
  const [closingPreview, setClosingPreview] = useState<Record<string, unknown> | null>(null);
  const [newFyForm, setNewFyForm] = useState({
    name: "",
    start_date: "",
    end_date: "",
    calendar_system: "PERSIAN",
  });
  const [reopenReason, setReopenReason] = useState("");
  const [comparisonRows, setComparisonRows] = useState<Array<Record<string, unknown>>>([]);

  const loadData = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    try {
      const [coaRes, fyRes, compRes] = await Promise.all([
        apiFetch<{
          groups: Array<Record<string, unknown>>;
          accounts: Array<Record<string, unknown>>;
          closures: Array<Record<string, unknown>>;
        }>("/api/v1/fiscal/accounts", { organizationId: orgId }),
        apiFetch<Array<Record<string, unknown>>>("/api/v1/fiscal/years", { organizationId: orgId }),
        apiFetch<Array<Record<string, unknown>>>("/api/v1/fiscal/comparison", { organizationId: orgId }),
      ]);
      setGroups(coaRes.groups);
      setAccountsList(coaRes.accounts);
      setClosures(coaRes.closures);
      setFiscalYearsList(fyRes);
      setComparisonRows(compRes);

      if (coaRes.groups.length > 0 && !newAcc.group_id) {
        setNewAcc((p) => ({ ...p, group_id: String(coaRes.groups[0].id) }));
      }
      if (fyRes.length > 0 && !openingFyId) {
        setOpeningFyId(String(fyRes[0].id));
        setSelectedFyId(String(fyRes[0].id));
      }
      if (coaRes.accounts.length >= 2 && !openingLines[0].account_id) {
        const capAcc = coaRes.accounts.find((a) => a.system_role === "CAPITAL") ?? coaRes.accounts[1];
        setOpeningLines([
          { account_id: String(coaRes.accounts[0].id), debit: "", credit: "", description: "مانده اول دوره" },
          { account_id: String(capAcc.id), debit: "", credit: "", description: "سرمایه اول دوره" },
        ]);
      }
    } catch (e) {
      onToast(e instanceof Error ? e.message : "خطا در بارگذاری کدینگ و سال‌های مالی", "error");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, onToast]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  async function handleCreateAccount(e: React.FormEvent) {
    e.preventDefault();
    try {
      await apiFetch("/api/v1/fiscal/accounts", {
        method: "POST",
        organizationId: orgId,
        body: JSON.stringify({
          ...newAcc,
          account_level: Number(newAcc.account_level),
        }),
      });
      onToast("حساب جدید در کدینگ حسابداری ایجاد شد.");
      setNewAcc({ ...newAcc, code: "", name: "" });
      loadData();
    } catch (err) {
      onToast(err instanceof Error ? err.message : "خطا در ایجاد حساب", "error");
    }
  }

  async function inspectAccountClosure(accId: string) {
    try {
      const prev = await apiFetch<Record<string, unknown>>(
        `/api/v1/fiscal/accounts/${accId}/closure-preview`,
        { organizationId: orgId }
      );
      setClosurePreview(prev);
      const fallbackDest = accountsList.find((a) => String(a.id) !== accId && a.is_active);
      if (fallbackDest) setClosureDestId(String(fallbackDest.id));
    } catch (err) {
      onToast(err instanceof Error ? err.message : "خطا در بررسی پیش‌نیاز بستن حساب", "error");
    }
  }

  async function executeAccountClosure() {
    if (!closurePreview) return;
    const acc = closurePreview.account as Record<string, unknown>;
    const needsTransfer = Boolean(closurePreview.requires_balance_resolution);
    try {
      await apiFetch(`/api/v1/fiscal/accounts/${String(acc.id)}/close`, {
        method: "POST",
        organizationId: orgId,
        body: JSON.stringify({
          action_type: needsTransfer ? "TRANSFER" : "CLOSE_ONLY",
          destination_account_id: needsTransfer ? closureDestId : null,
          reason: closureReason,
        }),
      });
      onToast(
        needsTransfer
          ? "مانده حساب با سند رسمی به حساب مقصد منتقل و حساب با حفظ تاریخچه بسته شد."
          : "حساب با موفقیت بسته (CLOSED) شد و تاریخچه آن در گزارش‌ها محفوظ است."
      );
      setClosurePreview(null);
      loadData();
    } catch (err) {
      onToast(err instanceof Error ? err.message : "خطا در بستن حساب", "error");
    }
  }

  async function submitOpeningBalances(e: React.FormEvent) {
    e.preventDefault();
    try {
      await apiFetch("/api/v1/fiscal/opening-balances", {
        method: "POST",
        organizationId: orgId,
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          fiscal_year_id: openingFyId,
          effective_date: new Date().toISOString().slice(0, 10),
          lines: openingLines,
        }),
      });
      onToast("سند افتتاحیه رسمی با تراز کامل در دفتر کل ثبت و به سال مالی متصل شد.");
      loadData();
    } catch (err) {
      onToast(err instanceof Error ? err.message : "خطا در ثبت سند افتتاحیه", "error");
    }
  }

  async function handleCreateFiscalYear(e: React.FormEvent) {
    e.preventDefault();
    try {
      await apiFetch("/api/v1/fiscal/years", {
        method: "POST",
        organizationId: orgId,
        body: JSON.stringify(newFyForm),
      });
      onToast("سال مالی جدید به همراه ۴ دوره فصلی ایجاد شد.");
      loadData();
    } catch (err) {
      onToast(err instanceof Error ? err.message : "خطا در ایجاد سال مالی", "error");
    }
  }

  async function runChecklistAndPreview(fyId: string) {
    setSelectedFyId(fyId);
    try {
      const [chk, prev] = await Promise.all([
        apiFetch<Record<string, unknown>>(`/api/v1/fiscal/years/${fyId}/closing-checklist`, {
          organizationId: orgId,
        }),
        apiFetch<Record<string, unknown>>(`/api/v1/fiscal/years/${fyId}/closing-preview`, {
          organizationId: orgId,
        }),
      ]);
      setChecklist(chk);
      setClosingPreview(prev);
      onToast("چک‌لیست پیش از بستن و پیش‌نمایش سند اختتامیه محاسبه شد.");
    } catch (err) {
      onToast(err instanceof Error ? err.message : "خطا در محاسبه پیش‌نمایش اختتامیه", "error");
    }
  }

  async function confirmCloseFiscalYear(fyId: string) {
    try {
      await apiFetch(`/api/v1/fiscal/years/${fyId}/close`, {
        method: "POST",
        organizationId: orgId,
        headers: { "Idempotency-Key": `close-fy-${fyId}-${Date.now()}` },
        body: JSON.stringify({ acknowledge_warnings: true }),
      });
      onToast("سند اختتامیه قطعی شد، سود و زیان به سود انباشته منتقل گردید و سال مالی قفل (CLOSED) شد!");
      setChecklist(null);
      setClosingPreview(null);
      loadData();
    } catch (err) {
      onToast(err instanceof Error ? err.message : "خطا در بستن سال مالی", "error");
    }
  }

  async function handlePrepareNextYear(prevFyId: string) {
    try {
      await apiFetch(`/api/v1/fiscal/years/${prevFyId}/prepare-next`, {
        method: "POST",
        organizationId: orgId,
        body: JSON.stringify({
          name: newFyForm.name,
          start_date: newFyForm.start_date,
          end_date: newFyForm.end_date,
        }),
      });
      onToast("سال مالی جدید ایجاد و سند افتتاحیه صرفاً از حساب‌های دائمی (دارایی/بدهی/سرمایه) صادر شد!");
      loadData();
    } catch (err) {
      onToast(err instanceof Error ? err.message : "خطا در افتتاح سال مالی بعد", "error");
    }
  }

  async function handleReopenYear(fyId: string) {
    try {
      await apiFetch(`/api/v1/fiscal/years/${fyId}/reopen`, {
        method: "POST",
        organizationId: orgId,
        body: JSON.stringify({ reason: reopenReason || "ثبت سند اصلاحی پایان سال با مجوز مدیریت" }),
      });
      onToast("سال مالی با صدور سند معکوس رسمی (بدون حذف سند اختتامیه) بازگشایی و در لاگ امنیتی ثبت شد.");
      setReopenReason("");
      loadData();
    } catch (err) {
      onToast(err instanceof Error ? err.message : "خطا در بازگشایی سال مالی", "error");
    }
  }

  const openDebSum = openingLines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
  const openCredSum = openingLines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
  const openBalanced = openDebSum > 0 && Math.abs(openDebSum - openCredSum) < 0.01;

  return (
    <div className="space-y-5">
      {/* Sub-navigation tabs */}
      <div className="glass-primary p-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2 text-xs">
          {[
            { id: "coa", label: "۱. کدینگ حساب‌ها و بستن حساب", icon: FolderTree },
            { id: "opening", label: "۲. ثبت مانده اول دوره و سند افتتاحیه", icon: BookOpen },
            { id: "fiscal_years", label: "۳. چرخه سال مالی (اختتامیه، انتقال مانده، بازگشایی)", icon: CalendarRange },
            { id: "comparison", label: "۴. مقایسه چندساله مالی", icon: ClipboardCheck },
          ].map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setSection(t.id as typeof section)}
                className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl font-medium cursor-pointer transition-colors ${
                  section === t.id
                    ? "bg-violet-600 text-white shadow-xs"
                    : "glass-input hover:border-violet-400"
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                <span>{t.label}</span>
              </button>
            );
          })}
        </div>
        <button type="button" onClick={loadData} className="glass-input px-3 py-1.5 text-xs inline-flex items-center gap-1 cursor-pointer">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          <span>بروزرسانی</span>
        </button>
      </div>

      {/* SECTION 1: CHART OF ACCOUNTS & CONTROLLED CLOSURE */}
      {section === "coa" && (
        <div className="space-y-5">
          <form onSubmit={handleCreateAccount} className="glass-primary p-5 space-y-3 text-xs">
            <h3 className="text-sm font-bold flex items-center gap-2">
              <Plus className="h-4 w-4 text-violet-500" />
              <span>ایجاد حساب جدید در ساختار سلسله‌مراتبی کدینگ</span>
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-6 gap-2.5">
              <select
                value={newAcc.group_id}
                onChange={(e) => {
                  const g = groups.find((x) => String(x.id) === e.target.value);
                  const nature = String(g?.nature || "ASSET");
                  setNewAcc({
                    ...newAcc,
                    group_id: e.target.value,
                    account_type: nature,
                    normal_balance: nature === "ASSET" || nature === "EXPENSE" ? "DEBIT" : "CREDIT",
                  });
                }}
                className="glass-input px-3 py-2"
              >
                {groups.map((g) => (
                  <option key={String(g.id)} value={String(g.id)}>
                    {String(g.code)} — {String(g.name)}
                  </option>
                ))}
              </select>
              <select
                value={newAcc.account_level}
                onChange={(e) => setNewAcc({ ...newAcc, account_level: Number(e.target.value) })}
                className="glass-input px-3 py-2"
              >
                <option value={2}>سطح ۲: حساب کل</option>
                <option value={3}>سطح ۳: حساب معین</option>
                <option value={4}>سطح ۴: حساب تفصیلی</option>
              </select>
              <input
                required
                dir="ltr"
                placeholder="کد حساب (مثلاً 1109)"
                value={newAcc.code}
                onChange={(e) => setNewAcc({ ...newAcc, code: e.target.value })}
                className="glass-input px-3 py-2 font-mono text-left"
              />
              <input
                required
                placeholder="عنوان حساب (مثلاً تنخواه‌گردان شعبه)"
                value={newAcc.name}
                onChange={(e) => setNewAcc({ ...newAcc, name: e.target.value })}
                className="md:col-span-2 glass-input px-3 py-2"
              />
              <button type="submit" className="rounded-xl bg-violet-600 hover:bg-violet-700 text-white py-2 font-semibold cursor-pointer">
                ثبت حساب جدید
              </button>
            </div>
          </form>

          {/* Controlled Account Closure Preview Panel */}
          {closurePreview && (
            <div className="glass-modal p-5 space-y-3 text-xs border-2 border-amber-400/50">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-bold text-amber-700 dark:text-amber-300 flex items-center gap-2">
                  <ArrowRightLeft className="h-4 w-4" />
                  <span>پیش‌نمایش بستن کنترل‌شده حساب: {String((closurePreview.account as Record<string, unknown>).name)}</span>
                </h4>
                <button type="button" onClick={() => setClosurePreview(null)} className="text-slate-400 cursor-pointer">بستن</button>
              </div>
              <div className="grid grid-cols-3 gap-3 tabular-nums">
                <div className="glass-secondary p-3">مانده فعلی: <strong>{formatIrr(closurePreview.net_balance as string)} ریال</strong></div>
                <div className="glass-secondary p-3">تعداد آرتیکل قطعی: <strong>{String(closurePreview.posted_lines_count)}</strong></div>
                <div className="glass-secondary p-3">
                  وضعیت: <strong>{closurePreview.requires_balance_resolution ? "نیازمند انتقال مانده پیش از بستن" : "آماده بستن مستقیم"}</strong>
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
                {Boolean(closurePreview.requires_balance_resolution) && (
                  <select
                    value={closureDestId}
                    onChange={(e) => setClosureDestId(e.target.value)}
                    className="glass-input px-3 py-2"
                  >
                    {accountsList
                      .filter((a) => a.is_active && String(a.id) !== String((closurePreview.account as Record<string, unknown>).id))
                      .map((a) => (
                        <option key={String(a.id)} value={String(a.id)}>
                          انتقال مانده به: {String(a.code)} — {String(a.name)}
                        </option>
                      ))}
                  </select>
                )}
                <input
                  value={closureReason}
                  onChange={(e) => setClosureReason(e.target.value)}
                  placeholder="دلیل رسمی بستن حساب"
                  className="glass-input px-3 py-2"
                />
                <button
                  type="button"
                  onClick={executeAccountClosure}
                  className="rounded-xl bg-amber-600 hover:bg-amber-700 text-white py-2 font-semibold cursor-pointer"
                >
                  {closurePreview.requires_balance_resolution
                    ? "انتقال مانده با سند رسمی و بستن حساب"
                    : "بستن حساب (حفظ کامل تاریخچه)"}
                </button>
              </div>
            </div>
          )}

          <div className="glass-data p-5 overflow-x-auto">
            <h3 className="text-sm font-bold mb-3">
              درخت کدینگ حساب‌ها ({accountsList.length} حساب • {closures.length} سابقه بستن حساب)
            </h3>
            <table className="w-full text-xs text-right">
              <thead className="border-b border-slate-200 dark:border-slate-700 text-slate-500">
                <tr>
                  <th className="px-3 py-2">کد / سطح</th>
                  <th className="px-3 py-2">عنوان حساب</th>
                  <th className="px-3 py-2">نوع / ماهیت</th>
                  <th className="px-3 py-2">مانده زنده (ریال)</th>
                  <th className="px-3 py-2">وضعیت</th>
                  <th className="px-3 py-2">عملیات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200/50 dark:divide-slate-700/40 tabular-nums">
                {accountsList.map((a) => (
                  <tr key={String(a.id)}>
                    <td className="px-3 py-2 font-mono">
                      <span className="font-bold">{String(a.code)}</span>{" "}
                      <span className="text-[10px] text-slate-400">L{String(a.account_level || 3)}</span>
                    </td>
                    <td className="px-3 py-2 font-semibold">
                      {String(a.name)}
                      {Boolean(a.system_role) && (
                        <span className="mr-1.5 text-[10px] font-mono px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-700 dark:text-violet-300">
                          {String(a.system_role)}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px]">
                      {String(a.account_type)} ({String(a.normal_balance)})
                    </td>
                    <td className="px-3 py-2 font-bold">{formatIrr(a.net_balance as string)}</td>
                    <td className="px-3 py-2">
                      <span
                        className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                          a.is_active && a.account_status !== "CLOSED"
                            ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                            : "bg-rose-500/15 text-rose-700 dark:text-rose-300"
                        }`}
                      >
                        {String(a.account_status || (a.is_active ? "ACTIVE" : "CLOSED"))}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      {Boolean(a.is_active) && !Boolean(a.system_role) && (
                        <button
                          type="button"
                          onClick={() => inspectAccountClosure(String(a.id))}
                          className="rounded-lg border border-amber-300 text-amber-700 dark:text-amber-300 px-2.5 py-1 text-[11px] cursor-pointer"
                        >
                          بررسی و بستن حساب
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* SECTION 2: OPENING BALANCES WORKFLOW */}
      {section === "opening" && (
        <form onSubmit={submitOpeningBalances} className="glass-primary p-5 space-y-4 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-bold">ثبت مانده اول دوره و صدور سند افتتاحیه رسمی (Opening Journal)</h3>
              <p className="text-slate-500 mt-0.5">
                مانده افتتاحیه هرگز مستقیماً روی ستون حساب نوشته نمی‌شود؛ صرفاً از طریق سند افتتاحیه متوازن ثبت می‌گردد
              </p>
            </div>
            <select
              value={openingFyId}
              onChange={(e) => setOpeningFyId(e.target.value)}
              className="glass-input px-3 py-2"
            >
              {fiscalYearsList.map((fy) => (
                <option key={String(fy.id)} value={String(fy.id)}>
                  {String(fy.name)} [{String(fy.status)}]
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            {openingLines.map((l, idx) => (
              <div key={idx} className="grid grid-cols-1 md:grid-cols-12 gap-2">
                <select
                  required
                  value={l.account_id}
                  onChange={(e) => {
                    const next = [...openingLines];
                    next[idx] = { ...next[idx], account_id: e.target.value };
                    setOpeningLines(next);
                  }}
                  className="md:col-span-5 glass-input px-3 py-2"
                >
                  {accountsList
                    .filter((a) => a.is_active)
                    .map((a) => (
                      <option key={String(a.id)} value={String(a.id)}>
                        {String(a.code)} — {String(a.name)}
                      </option>
                    ))}
                </select>
                <input
                  dir="ltr"
                  value={l.debit}
                  onChange={(e) => {
                    const next = [...openingLines];
                    next[idx] = { ...next[idx], debit: e.target.value };
                    setOpeningLines(next);
                  }}
                  placeholder="بدهکار"
                  className="md:col-span-3 glass-input px-3 py-2 font-mono text-left"
                />
                <input
                  dir="ltr"
                  value={l.credit}
                  onChange={(e) => {
                    const next = [...openingLines];
                    next[idx] = { ...next[idx], credit: e.target.value };
                    setOpeningLines(next);
                  }}
                  placeholder="بستانکار"
                  className="md:col-span-3 glass-input px-3 py-2 font-mono text-left"
                />
                <button
                  type="button"
                  onClick={() => {
                    if (openingLines.length <= 2) return;
                    setOpeningLines(openingLines.filter((_, i) => i !== idx));
                  }}
                  className="md:col-span-1 glass-input text-rose-500 cursor-pointer"
                >
                  حذف
                </button>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-200/60 dark:border-slate-700/60">
            <div className="flex items-center gap-4 tabular-nums">
              <span>جمع بدهکار: <strong>{formatIrr(openDebSum)}</strong></span>
              <span>جمع بستانکار: <strong>{formatIrr(openCredSum)}</strong></span>
              <span className={`px-2.5 py-0.5 rounded-full font-semibold ${openBalanced ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : "bg-rose-500/15 text-rose-700"}`}>
                {openBalanced ? "سند افتتاحیه تراز است ✓" : "نامتوازن"}
              </span>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() =>
                  setOpeningLines([
                    ...openingLines,
                    { account_id: String(accountsList[0]?.id ?? ""), debit: "0.00", credit: "0.00", description: "مانده اول دوره" },
                  ])
                }
                className="glass-input px-3 py-2 cursor-pointer"
              >
                + افزودن ردیف
              </button>
              <button type="submit" className="rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white px-5 py-2 font-semibold cursor-pointer">
                ثبت سند افتتاحیه رسمی
              </button>
            </div>
          </div>
        </form>
      )}

      {/* SECTION 3: FISCAL YEAR LIFECYCLE */}
      {section === "fiscal_years" && (
        <div className="space-y-5">
          {/* Create Fiscal Year */}
          <form onSubmit={handleCreateFiscalYear} className="glass-primary p-5 grid grid-cols-1 md:grid-cols-5 gap-2.5 text-xs">
            <input
              required
              placeholder="نام سال مالی (مثلاً سال مالی ۱۴۰۵)"
              value={newFyForm.name}
              onChange={(e) => setNewFyForm({ ...newFyForm, name: e.target.value })}
              className="glass-input px-3 py-2"
            />
            <JalaliDatePicker
              value={newFyForm.start_date}
              onChange={(value) => setNewFyForm({ ...newFyForm, start_date: value })}
              format="iso"
              placeholder="شروع سال مالی"
            />
            <JalaliDatePicker
              value={newFyForm.end_date}
              onChange={(value) => setNewFyForm({ ...newFyForm, end_date: value })}
              format="iso"
              placeholder="پایان سال مالی"
            />
            <select
              value={newFyForm.calendar_system}
              onChange={(e) => setNewFyForm({ ...newFyForm, calendar_system: e.target.value })}
              className="glass-input px-3 py-2"
            >
              <option value="PERSIAN">تقویم شمسی (PERSIAN)</option>
              <option value="GREGORIAN">تقویم میلادی (GREGORIAN)</option>
            </select>
            <button type="submit" className="rounded-xl bg-violet-600 text-white py-2 font-semibold cursor-pointer">
              ایجاد سال مالی جدید
            </button>
          </form>

          {/* List of Fiscal Years */}
          <div className="space-y-3">
            {fiscalYearsList.map((fy) => (
              <div key={String(fy.id)} className="glass-primary p-5 space-y-3 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-bold flex items-center gap-2">
                      {fy.status === "CLOSED" ? (
                        <Lock className="h-4 w-4 text-rose-500" />
                      ) : (
                        <Unlock className="h-4 w-4 text-emerald-500" />
                      )}
                      <span>{String(fy.name)}</span>
                      <span
                        className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                          fy.status === "CLOSED"
                            ? "bg-rose-500/15 text-rose-700 dark:text-rose-300"
                            : fy.status === "REOPENED"
                              ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                              : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                        }`}
                      >
                        {String(fy.status)}
                      </span>
                    </div>
                    <div className="text-slate-500 font-mono text-[11px] mt-1">
                      {String(fy.start_date)} تا {String(fy.end_date)} • تقویم: {String(fy.calendar_system || "PERSIAN")}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {fy.status !== "CLOSED" && (
                      <button
                        type="button"
                        onClick={() => runChecklistAndPreview(String(fy.id))}
                        className="rounded-xl bg-indigo-600 text-white px-3.5 py-1.5 font-medium cursor-pointer"
                      >
                        چک‌لیست و پیش‌نمایش سند اختتامیه
                      </button>
                    )}
                    {fy.status === "CLOSED" && !Boolean(fy.next_fiscal_year_id) && (
                      <button
                        type="button"
                        onClick={() => handlePrepareNextYear(String(fy.id))}
                        className="rounded-xl bg-emerald-600 text-white px-3.5 py-1.5 font-medium cursor-pointer"
                      >
                        افتتاح سال مالی بعد + انتقال مانده دائمی
                      </button>
                    )}
                    {fy.status === "CLOSED" && (
                      <div className="flex items-center gap-1.5">
                        <input
                          placeholder="دلیل رسمی بازگشایی..."
                          value={reopenReason}
                          onChange={(e) => setReopenReason(e.target.value)}
                          className="glass-input px-2.5 py-1 text-[11px]"
                        />
                        <button
                          type="button"
                          onClick={() => handleReopenYear(String(fy.id))}
                          className="inline-flex items-center gap-1 rounded-xl border border-amber-400 bg-amber-500/15 text-amber-800 dark:text-amber-300 px-3 py-1.5 font-medium cursor-pointer"
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                          <span>بازگشایی مجاز</span>
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Pre-Closing Checklist & Closing Journal Preview */}
          {checklist && closingPreview && (
            <div className="glass-modal p-6 space-y-5 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200/60 dark:border-slate-700/60 pb-3">
                <h4 className="text-sm font-bold flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-violet-500" />
                  <span>چک‌لیست پیش از بستن و پیش‌نمایش سند اختتامیه ({String((closingPreview.fiscal_year as Record<string, unknown>).name)})</span>
                </h4>
                <button
                  type="button"
                  disabled={!checklist.can_close}
                  onClick={() => confirmCloseFiscalYear(selectedFyId)}
                  className="rounded-xl bg-rose-600 hover:bg-rose-700 disabled:opacity-40 text-white px-4 py-2 font-semibold cursor-pointer"
                >
                  تایید، صدور سند اختتامیه و بستن قطعی سال مالی
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                {((checklist.items as Array<Record<string, unknown>>) ?? []).map((it) => (
                  <div key={String(it.code)} className="glass-secondary p-3 flex items-start justify-between gap-2">
                    <div>
                      <div className="font-bold">{String(it.title)}</div>
                      <div className="text-[11px] text-slate-500 mt-0.5">{String(it.details)}</div>
                    </div>
                    <span className="shrink-0">
                      {it.status === "PASSED" ? (
                        <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                      ) : it.status === "FAILED" ? (
                        <XCircle className="h-4 w-4 text-rose-500" />
                      ) : (
                        <AlertTriangle className="h-4 w-4 text-amber-500" />
                      )}
                    </span>
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-3 gap-3 tabular-nums">
                <div className="glass-secondary p-3">جمع درآمدها: <strong>{formatIrr(closingPreview.total_revenue as string)}</strong></div>
                <div className="glass-secondary p-3">جمع هزینه‌ها و بهای تمام‌شده: <strong>{formatIrr(closingPreview.total_expense as string)}</strong></div>
                <div className="glass-secondary p-3">
                  سود/زیان انتقالی به سود انباشته: <strong className="text-emerald-600">{formatIrr(closingPreview.net_profit_or_loss as string)} ریال</strong>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-xs text-right">
                  <thead className="border-b border-slate-200 dark:border-slate-700 text-slate-500">
                    <tr>
                      <th className="px-2 py-2">کد / حساب</th>
                      <th className="px-2 py-2">شرح آرتیکل اختتامیه</th>
                      <th className="px-2 py-2">بدهکار</th>
                      <th className="px-2 py-2">بستانکار</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200/40 tabular-nums">
                    {((closingPreview.closing_lines as Array<Record<string, unknown>>) ?? []).map((l, idx) => (
                      <tr key={idx}>
                        <td className="px-2 py-2 font-medium">{String(l.account_code)} — {String(l.account_name)}</td>
                        <td className="px-2 py-2 text-slate-500">{String(l.description)}</td>
                        <td className="px-2 py-2 font-mono">{formatIrr(l.debit as string)}</td>
                        <td className="px-2 py-2 font-mono">{formatIrr(l.credit as string)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* SECTION 4: MULTI-YEAR FISCAL COMPARISON (§10.1) */}
      {section === "comparison" && (
        <div className="glass-data p-5 overflow-x-auto">
          <h3 className="text-sm font-bold mb-3">گزارش مقایسه چندساله مالی (Fiscal Year Comparison)</h3>
          <table className="w-full text-xs text-right">
            <thead className="border-b border-slate-200 dark:border-slate-700 text-slate-500">
              <tr>
                <th className="px-3 py-2">سال مالی</th>
                <th className="px-3 py-2">وضعیت</th>
                <th className="px-3 py-2">درآمد</th>
                <th className="px-3 py-2">هزینه</th>
                <th className="px-3 py-2">سود خالص</th>
                <th className="px-3 py-2">جمع دارایی‌ها</th>
                <th className="px-3 py-2">بدهی‌ها / سرمایه</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200/50 dark:divide-slate-700/40 tabular-nums">
              {comparisonRows.map((r) => (
                <tr key={String(r.fiscal_year_id)}>
                  <td className="px-3 py-2.5 font-bold">{String(r.name)}</td>
                  <td className="px-3 py-2.5 font-mono text-[11px]">{String(r.status)}</td>
                  <td className="px-3 py-2.5">{formatIrr(r.revenue as string)}</td>
                  <td className="px-3 py-2.5">{formatIrr(r.expenses as string)}</td>
                  <td className="px-3 py-2.5 font-bold text-emerald-600">{formatIrr(r.net_profit as string)}</td>
                  <td className="px-3 py-2.5">{formatIrr(r.assets as string)}</td>
                  <td className="px-3 py-2.5">
                    {formatIrr(r.liabilities as string)} / {formatIrr(r.equity as string)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

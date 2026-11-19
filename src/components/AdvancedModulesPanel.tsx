"use client";

import React, { useCallback, useEffect, useState } from "react";
import {
  Award,
  BarChart3,
  Briefcase,
  CalendarClock,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  FileText,
  Layers,
  Plus,
  Printer,
  RefreshCw,
  Repeat,
  Sparkles,
  UserPlus,
  Wallet,
  Zap,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { apiFetch, formatIrr, formatQty } from "@/lib/format";
import { JalaliDatePicker, JalaliMonthPicker } from "@/components/JalaliDatePicker";
import { ProductPickerModal } from "@/components/ProductPickerModal";
import { SalesInvoiceComposer } from "@/components/SalesInvoiceComposer";
import { currentJalaliDate } from "@/lib/jalali";

export type AdvancedSubTab =
  | "personal_finance"
  | "quick_entry"
  | "mixed_sales"
  | "variants_replenish"
  | "crm_employees"
  | "cheque_analytics";

interface AdvancedModulesPanelProps {
  orgId: string | null;
  activeTab: AdvancedSubTab;
  onToast: (msg: string, type?: "success" | "error") => void;
}

export function AdvancedModulesPanel({
  orgId,
  activeTab,
  onToast,
}: AdvancedModulesPanelProps) {
  const [loading, setLoading] = useState(false);

  // Personal Finance state
  const [pfDash, setPfDash] = useState<Record<string, unknown> | null>(null);
  const [bizAccounts, setBizAccounts] = useState<Array<Record<string, unknown>>>([]);
  const [wdForm, setWdForm] = useState({
    business_financial_account_id: "",
    amount: "",
    notes: "",
  });
  const [pfTxForm, setPfTxForm] = useState({
    tx_type: "PERSONAL_EXPENSE",
    payment_source: "PERSONAL_CASH",
    title: "",
    amount: "",
    category_id: "",
    linked_withdrawal_id: "",
  });
  const [recForm, setRecForm] = useState({
    title: "",
    amount: "",
    frequency: "MONTHLY",
    start_date: new Date().toISOString().slice(0, 10),
    payment_source: "BUSINESS_BANK",
  });

  // Quick Expense & Income state
  const [quickKind, setQuickKind] = useState<"EXPENSE" | "INCOME">("EXPENSE");
  const [accCats, setAccCats] = useState<Array<Record<string, unknown>>>([]);
  const [quickTxs, setQuickTxs] = useState<Array<Record<string, unknown>>>([]);
  const [quickForm, setQuickForm] = useState({
    category_id: "",
    financial_account_id: "",
    title: "",
    amount: "",
    tax_amount: "0.00",
    payment_method: "CASH",
    tx_date_jalali: currentJalaliDate(),
  });

  // Mixed Sales & Quotations state
  const [contactsList, setContactsList] = useState<Array<Record<string, unknown>>>([]);
  const [warehousesList, setWarehousesList] = useState<Array<Record<string, unknown>>>([]);
  const [productsList, setProductsList] = useState<Array<Record<string, unknown>>>([]);
  const [salesList, setSalesList] = useState<Array<Record<string, unknown>>>([]);
  const [quotationsList, setQuotationsList] = useState<Array<Record<string, unknown>>>([]);
  // Variants & Smart Replenishment state
  const [variantsData, setVariantsData] = useState<Record<string, unknown> | null>(null);
  const [suggestions, setSuggestions] = useState<Array<Record<string, unknown>>>([]);
  const [varForm, setVarForm] = useState({
    product_id: "",
    sku: "",
    variant_name: "",
    purchase_price: "",
    sale_price: "",
    opening_qty: "",
  });

  // CRM & Employees state
  const [crmProfiles, setCrmProfiles] = useState<Array<Record<string, unknown>>>([]);
  const [employeesList, setEmployeesList] = useState<Array<Record<string, unknown>>>([]);
  const [empForm, setEmpForm] = useState({
    employee_code: "",
    full_name: "",
    mobile: "",
    email: "",
    role_code: "SALESPERSON",
    branch_name: "شعبه مرکزی",
  });

  // Cheque Dashboard & Analytics state
  const [chequeDash, setChequeDash] = useState<Record<string, unknown> | null>(null);
  const [chequeChart, setChequeChart] = useState<Array<Record<string, unknown>>>([]);
  const [chartMonth, setChartMonth] = useState(() => currentJalaliDate().slice(0, 7).replace("/", "-"));

  const loadData = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    try {
      if (activeTab === "personal_finance") {
        const [dash, finAccs] = await Promise.all([
          apiFetch<Record<string, unknown>>("/api/v1/personal-finance/dashboard", { organizationId: orgId }),
          apiFetch<Array<Record<string, unknown>>>("/api/v1/treasury/accounts", { organizationId: orgId }),
        ]);
        setPfDash(dash);
        setBizAccounts(finAccs);
        const cats = (dash.categories as Array<Record<string, unknown>>) ?? [];
        if (finAccs.length > 0 && !wdForm.business_financial_account_id) {
          setWdForm((p) => ({ ...p, business_financial_account_id: String(finAccs[0].id) }));
        }
        if (cats.length > 0 && !pfTxForm.category_id) {
          setPfTxForm((p) => ({ ...p, category_id: String(cats[0].id) }));
        }
      } else if (activeTab === "quick_entry") {
        const [cats, txs, fas] = await Promise.all([
          apiFetch<Array<Record<string, unknown>>>("/api/v1/accounting-categories", { organizationId: orgId }),
          apiFetch<Array<Record<string, unknown>>>("/api/v1/quick-transactions", { organizationId: orgId }),
          apiFetch<Array<Record<string, unknown>>>("/api/v1/treasury/accounts", { organizationId: orgId }),
        ]);
        setAccCats(cats);
        setQuickTxs(txs);
        setBizAccounts(fas);
        const matchingCat = cats.find((c) => c.kind === quickKind);
        if (matchingCat && !quickForm.category_id) {
          setQuickForm((p) => ({ ...p, category_id: String(matchingCat.id) }));
        }
        if (fas.length > 0 && !quickForm.financial_account_id) {
          setQuickForm((p) => ({ ...p, financial_account_id: String(fas[0].id) }));
        }
      } else if (activeTab === "mixed_sales") {
        const [cList, wList, pList, sList, qList, fas] = await Promise.all([
          apiFetch<Array<Record<string, unknown>>>("/api/v1/contacts?per_page=100", { organizationId: orgId }),
          apiFetch<Array<Record<string, unknown>>>("/api/v1/warehouses?per_page=50", { organizationId: orgId }),
          apiFetch<Array<Record<string, unknown>>>("/api/v1/products?per_page=100", { organizationId: orgId }),
          apiFetch<Array<Record<string, unknown>>>("/api/v1/sales?per_page=30", { organizationId: orgId }),
          apiFetch<Array<Record<string, unknown>>>("/api/v1/quotations", { organizationId: orgId }),
          apiFetch<Array<Record<string, unknown>>>("/api/v1/treasury/accounts", { organizationId: orgId }),
        ]);
        setContactsList(cList);
        setWarehousesList(wList);
        setProductsList(pList);
        setSalesList(sList);
        setQuotationsList(qList);
        setBizAccounts(fas);
      } else if (activeTab === "variants_replenish") {
        const [vRes, sRes, pList, wList, cList] = await Promise.all([
          apiFetch<Record<string, unknown>>("/api/v1/variants", { organizationId: orgId }),
          apiFetch<Array<Record<string, unknown>>>("/api/v1/replenishment/suggestions", { organizationId: orgId }),
          apiFetch<Array<Record<string, unknown>>>("/api/v1/products?per_page=100", { organizationId: orgId }),
          apiFetch<Array<Record<string, unknown>>>("/api/v1/warehouses?per_page=50", { organizationId: orgId }),
          apiFetch<Array<Record<string, unknown>>>("/api/v1/contacts?per_page=50", { organizationId: orgId }),
        ]);
        setVariantsData(vRes);
        setSuggestions(sRes);
        setProductsList(pList);
        setWarehousesList(wList);
        setContactsList(cList);
        if (pList.length > 0 && !varForm.product_id) {
          setVarForm((p) => ({ ...p, product_id: String(pList[0].id) }));
        }
      } else if (activeTab === "crm_employees") {
        const [crmRes, empRes] = await Promise.all([
          apiFetch<Array<Record<string, unknown>>>("/api/v1/crm/customers", { organizationId: orgId }),
          apiFetch<Array<Record<string, unknown>>>("/api/v1/employees", { organizationId: orgId }).catch(() => []),
        ]);
        setCrmProfiles(crmRes);
        setEmployeesList(empRes);
      } else if (activeTab === "cheque_analytics") {
        const [cd, ca] = await Promise.all([
          apiFetch<Record<string, unknown>>("/api/v1/cheques/dashboard", { organizationId: orgId }),
          apiFetch<{ daily_series: Array<Record<string, unknown>> }>(
            `/api/v1/cheques/analytics?month_jalali=${encodeURIComponent(chartMonth.replace("-", "/"))}`,
            { organizationId: orgId }
          ),
        ]);
        setChequeDash(cd);
        setChequeChart(
          (ca.daily_series ?? []).map((d) => ({
            day: String(d.day),
            received: Number(d.received_amount || 0),
            issued: Number(d.issued_amount || 0),
          }))
        );
      }
    } catch (e) {
      onToast(e instanceof Error ? e.message : "خطا در بارگذاری ماژول پیشرفته", "error");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, activeTab, chartMonth, onToast]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Actions
  async function handleOwnerWithdrawal(e: React.FormEvent) {
    e.preventDefault();
    try {
      await apiFetch("/api/v1/personal-finance/withdrawals", {
        method: "POST",
        organizationId: orgId,
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify(wdForm),
      });
      onToast("برداشت مالک ثبت شد: سند دوبل (بدهکار برداشت مالک / بستانکار صندوق-بانک) بدون تاثیر بر سود کسب‌وکار ثبت گردید.");
      loadData();
    } catch (err) {
      onToast(err instanceof Error ? err.message : "خطا در ثبت برداشت مالک", "error");
    }
  }

  async function handlePersonalTx(e: React.FormEvent) {
    e.preventDefault();
    try {
      await apiFetch("/api/v1/personal-finance/transactions", {
        method: "POST",
        organizationId: orgId,
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          ...pfTxForm,
          category_id: pfTxForm.category_id || null,
          linked_withdrawal_id: pfTxForm.linked_withdrawal_id || null,
        }),
      });
      onToast("تراکنش در دفتر مالی شخصی ثبت شد (جدا از هزینه‌های عملیاتی شرکت).");
      loadData();
    } catch (err) {
      onToast(err instanceof Error ? err.message : "خطا در ثبت تراکنش شخصی", "error");
    }
  }

  async function handleCreateRecurring(e: React.FormEvent) {
    e.preventDefault();
    try {
      await apiFetch("/api/v1/personal-finance/recurring", {
        method: "POST",
        organizationId: orgId,
        body: JSON.stringify(recForm),
      });
      onToast("تعهد تکرارشونده ثبت شد (بدون ثبت خودکار هزینه تا زمان تایید پرداخت).");
      loadData();
    } catch (err) {
      onToast(err instanceof Error ? err.message : "خطا در ثبت تعهد تکرارشونده", "error");
    }
  }

  async function handlePayRecurring(id: string) {
    try {
      await apiFetch(`/api/v1/personal-finance/recurring/${id}/pay`, {
        method: "POST",
        organizationId: orgId,
        headers: { "Idempotency-Key": `pay-rec-${id}-${new Date().toISOString().slice(0, 10)}` },
        body: JSON.stringify({
          business_financial_account_id: bizAccounts[0]?.id ?? null,
        }),
      });
      onToast("پرداخت تعهد تکرارشونده با کلید یکتا (Idempotent) و ثبت حسابداری انجام شد.");
      loadData();
    } catch (err) {
      onToast(err instanceof Error ? err.message : "خطا در پرداخت تعهد", "error");
    }
  }

  async function handleQuickEntry(e: React.FormEvent) {
    e.preventDefault();
    try {
      await apiFetch("/api/v1/quick-transactions", {
        method: "POST",
        organizationId: orgId,
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          kind: quickKind,
          ...quickForm,
        }),
      });
      onToast("تراکنش سریع ثبت و سند حسابداری دوبل آن از طریق نگاشت خودکار دسته‌بندی صادر شد.");
      loadData();
    } catch (err) {
      onToast(err instanceof Error ? err.message : "خطا در ثبت سریع", "error");
    }
  }

  async function handleConvertQuotation(id: string) {
    try {
      await apiFetch(`/api/v1/quotations/${id}/convert`, {
        method: "POST",
        organizationId: orgId,
      });
      onToast("پیش‌فاکتور با موفقیت به پیش‌نویس فاکتور فروش تبدیل شد.");
      loadData();
    } catch (err) {
      onToast(err instanceof Error ? err.message : "خطا در تبدیل پیش‌فاکتور", "error");
    }
  }

  async function handleCreateVariantWithOpeningStock(e: React.FormEvent) {
    e.preventDefault();
    try {
      const created = await apiFetch<{ id: string }>("/api/v1/variants", {
        method: "POST",
        organizationId: orgId,
        body: JSON.stringify({
          product_id: varForm.product_id,
          sku: varForm.sku || `VAR-${Date.now().toString().slice(-5)}`,
          variant_name: varForm.variant_name,
          attributes: { label: varForm.variant_name },
          purchase_price: varForm.purchase_price,
          sale_price: varForm.sale_price,
        }),
      });
      if (Number(varForm.opening_qty) > 0 && warehousesList[0]) {
        await apiFetch("/api/v1/opening-stock", {
          method: "POST",
          organizationId: orgId,
          body: JSON.stringify({
            warehouse_id: String(warehousesList[0].id),
            product_id: varForm.product_id,
            variant_id: created.id,
            quantity: varForm.opening_qty,
            unit_cost: varForm.purchase_price,
          }),
        });
      }
      onToast("تنوع کالا ایجاد و موجودی اول دوره مستقل آن در Stock Ledger و سند افتتاحیه ثبت شد.");
      setVarForm({ ...varForm, sku: "" });
      loadData();
    } catch (err) {
      onToast(err instanceof Error ? err.message : "خطا در ایجاد تنوع", "error");
    }
  }

  async function handleConvertSuggestionToPo(suggId: string) {
    try {
      const supplier = contactsList.find((c) => c.type === "SUPPLIER") ?? contactsList[0];
      await apiFetch(`/api/v1/replenishment/suggestions/${suggId}/convert-po`, {
        method: "POST",
        organizationId: orgId,
        body: JSON.stringify({ supplier_id: supplier ? String(supplier.id) : null }),
      });
      onToast("پیشنهاد خرید هوشمند به سفارش خرید رسمی (PO) تبدیل شد.");
      loadData();
    } catch (err) {
      onToast(err instanceof Error ? err.message : "خطا در تبدیل پیشنهاد", "error");
    }
  }

  async function handleCreateEmployee(e: React.FormEvent) {
    e.preventDefault();
    try {
      await apiFetch("/api/v1/employees", {
        method: "POST",
        organizationId: orgId,
        body: JSON.stringify(empForm),
      });
      onToast("پرسنل جدید با نقش RBAC تفکیک‌شده (بدون دسترسی به سود و مالی شخصی در نقش فروشنده) ایجاد شد.");
      setEmpForm({ employee_code: "", full_name: "", mobile: "", email: "", role_code: "SALESPERSON", branch_name: "شعبه مرکزی" });
      loadData();
    } catch (err) {
      onToast(err instanceof Error ? err.message : "خطا در ایجاد پرسنل", "error");
    }
  }

  async function handleRedeemPoints(contactId: string) {
    try {
      await apiFetch("/api/v1/crm/loyalty/transactions", {
        method: "POST",
        organizationId: orgId,
        body: JSON.stringify({
          contact_id: contactId,
          tx_type: "EARN",
          points: 50,
          description: "پاداش وفاداری و معرفی مشتری جدید",
        }),
      });
      onToast("۵۰ امتیاز وفاداری در دفتر تغییرناپذیر باشگاه مشتریان ثبت شد.");
      loadData();
    } catch (err) {
      onToast(err instanceof Error ? err.message : "خطا در ثبت امتیاز", "error");
    }
  }

  async function downloadJournalBookXlsx() {
    if (!orgId) return;
    try {
      const res = await fetch("/api/v1/accounting/journal-book/export", {
        headers: { "X-Organization-Id": orgId, "X-Client-Version": "1.0.0" },
        credentials: "include",
      });
      if (!res.ok) throw new Error("خطا در تولید فایل اکسل دفتر روزنامه");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `business-os-journal-book-${new Date().toISOString().slice(0, 10)}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
      onToast("فایل اکسل رسمی دفتر روزنامه (.xlsx) مطابق با ارقام تراز دفتر کل دانلود شد.");
    } catch (err) {
      onToast(err instanceof Error ? err.message : "خطا در دانلود اکسل", "error");
    }
  }

  // ==========================================================================
  // RENDER
  // ==========================================================================

  return (
    <div className="space-y-5">
      {/* 1. PERSONAL FINANCE & OWNER WITHDRAWALS */}
      {activeTab === "personal_finance" && (
        <div className="space-y-5">
          {pfDash && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
              {(() => {
                const k = (pfDash.kpis as Record<string, string | number>) ?? {};
                return [
                  { label: "کل برداشت مالک از کسب‌وکار", val: `${formatIrr(k.total_owner_withdrawals)} ریال`, tone: "text-indigo-700 bg-indigo-50" },
                  { label: "مخارج شخصی ثبت‌شده", val: `${formatIrr(k.total_personal_expenses)} ریال`, tone: "text-rose-700 bg-rose-50" },
                  { label: "موجودی نقدی و بانکی شخصی", val: `${formatIrr(Number(k.personal_cash_balance || 0) + Number(k.personal_bank_balance || 0))} ریال`, tone: "text-emerald-700 bg-emerald-50" },
                  { label: "تعهدات پیش‌رو / معوق", val: `${k.upcoming_payments_count ?? 0} پیش‌رو / ${k.overdue_payments_count ?? 0} معوق`, tone: "text-amber-700 bg-amber-50" },
                ].map((c) => (
                  <div key={c.label} className="bg-white rounded-2xl border border-slate-200 p-4">
                    <div className="text-slate-500">{c.label}</div>
                    <div className="text-base font-bold text-slate-900 mt-2 tabular-nums">{c.val}</div>
                    <span className={`inline-block mt-2 px-2 py-0.5 rounded-full text-[10px] font-medium ${c.tone}`}>
                      جدا از سود و زیان شرکت
                    </span>
                  </div>
                ));
              })()}
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            {/* Owner Withdrawal Form */}
            <form onSubmit={handleOwnerWithdrawal} className="bg-white rounded-2xl border border-slate-200 p-5 space-y-3 text-xs">
              <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                <Wallet className="h-4 w-4 text-indigo-600" />
                <span>ثبت برداشت مالک از کسب‌وکار (DR Drawings / CR Cash)</span>
              </h3>
              <p className="text-slate-500">
                موجودی صندوق/بانک کسب‌وکار کاهش و حساب برداشت مالک (3201) افزایش می‌یابد؛ بدون ایجاد هزینه عملیاتی!
              </p>
              <select
                value={wdForm.business_financial_account_id}
                onChange={(e) => setWdForm({ ...wdForm, business_financial_account_id: e.target.value })}
                className="w-full rounded-xl border border-slate-200 px-3 py-2"
              >
                {bizAccounts.map((a) => (
                  <option key={String(a.id)} value={String(a.id)}>
                    {String(a.name)} — مانده: {formatIrr(a.balance as string)}
                  </option>
                ))}
              </select>
              <div className="grid grid-cols-2 gap-2">
                <input
                  dir="ltr"
                  value={wdForm.amount}
                  onChange={(e) => setWdForm({ ...wdForm, amount: e.target.value })}
                  placeholder="مبلغ برداشت"
                  className="rounded-xl border border-slate-200 px-3 py-2 font-mono text-left"
                />
                <input
                  value={wdForm.notes}
                  onChange={(e) => setWdForm({ ...wdForm, notes: e.target.value })}
                  placeholder="توضیحات"
                  className="rounded-xl border border-slate-200 px-3 py-2"
                />
              </div>
              <button type="submit" className="w-full rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white py-2 font-medium cursor-pointer">
                ثبت برداشت مالک و صدور سند دوبل
              </button>
            </form>

            {/* Personal Expense linked to Withdrawal */}
            <form onSubmit={handlePersonalTx} className="bg-white rounded-2xl border border-slate-200 p-5 space-y-3 text-xs">
              <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                <FileText className="h-4 w-4 text-emerald-600" />
                <span>ثبت هزینه یا درآمد شخصی (دفتر مالی شخصی)</span>
              </h3>
              <div className="grid grid-cols-2 gap-2">
                <input
                  required
                  value={pfTxForm.title}
                  onChange={(e) => setPfTxForm({ ...pfTxForm, title: e.target.value })}
                  placeholder="عنوان هزینه شخصی"
                  className="rounded-xl border border-slate-200 px-3 py-2"
                />
                <input
                  dir="ltr"
                  required
                  value={pfTxForm.amount}
                  onChange={(e) => setPfTxForm({ ...pfTxForm, amount: e.target.value })}
                  placeholder="مبلغ (ریال)"
                  className="rounded-xl border border-slate-200 px-3 py-2 font-mono text-left"
                />
                <select
                  value={pfTxForm.category_id}
                  onChange={(e) => setPfTxForm({ ...pfTxForm, category_id: e.target.value })}
                  className="rounded-xl border border-slate-200 px-3 py-2"
                >
                  <option value="">دسته‌بندی شخصی...</option>
                  {((pfDash?.categories as Array<Record<string, unknown>>) ?? []).map((c) => (
                    <option key={String(c.id)} value={String(c.id)}>{String(c.name_fa)}</option>
                  ))}
                </select>
                <select
                  value={pfTxForm.linked_withdrawal_id}
                  onChange={(e) => setPfTxForm({ ...pfTxForm, linked_withdrawal_id: e.target.value })}
                  className="rounded-xl border border-slate-200 px-3 py-2"
                >
                  <option value="">متصل به برداشت مالک (اختیاری)</option>
                  {((pfDash?.withdrawals as Array<Record<string, unknown>>) ?? []).map((w) => (
                    <option key={String(w.id)} value={String(w.id)}>
                      برداشت {formatIrr(w.amount as string)} ({String(w.withdrawal_date)})
                    </option>
                  ))}
                </select>
              </div>
              <button type="submit" className="w-full rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white py-2 font-medium cursor-pointer">
                ثبت در دفتر شخصی
              </button>
            </form>
          </div>

          {/* Recurring Personal Obligations */}
          <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-4 text-xs">
            <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
              <Repeat className="h-4 w-4 text-amber-600" />
              <span>هزینه‌ها و تعهدات تکرارشونده (Recurring Obligations — بدون ثبت تکراری)</span>
            </h3>
            <form onSubmit={handleCreateRecurring} className="grid grid-cols-1 md:grid-cols-5 gap-2">
              <input
                required
                value={recForm.title}
                onChange={(e) => setRecForm({ ...recForm, title: e.target.value })}
                placeholder="عنوان تعهد (مثلاً اجاره ماهانه)"
                className="rounded-xl border border-slate-200 px-3 py-2"
              />
              <input
                dir="ltr"
                required
                value={recForm.amount}
                onChange={(e) => setRecForm({ ...recForm, amount: e.target.value })}
                className="rounded-xl border border-slate-200 px-3 py-2 font-mono text-left"
              />
              <select
                value={recForm.frequency}
                onChange={(e) => setRecForm({ ...recForm, frequency: e.target.value })}
                className="rounded-xl border border-slate-200 px-3 py-2"
              >
                <option value="MONTHLY">ماهانه (MONTHLY)</option>
                <option value="WEEKLY">هفتگی (WEEKLY)</option>
                <option value="QUARTERLY">فصلی (QUARTERLY)</option>
                <option value="ANNUALLY">سالانه (ANNUALLY)</option>
              </select>
              <JalaliDatePicker value={recForm.start_date} onChange={(value) => setRecForm({ ...recForm, start_date: value })} format="iso" placeholder="تاریخ شروع شمسی" />
              <button type="submit" className="rounded-xl bg-amber-600 text-white py-2 font-medium cursor-pointer">
                تعریف تعهد تکرارشونده
              </button>
            </form>
            <div className="space-y-2">
              {((pfDash?.recurring_obligations as Array<Record<string, unknown>>) ?? []).map((r) => (
                <div key={String(r.id)} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-slate-50 border border-slate-100 px-4 py-2.5">
                  <div>
                    <span className="font-bold text-slate-900">{String(r.title)}</span>
                    <span className="text-slate-500 mr-2 tabular-nums">
                      {formatIrr(r.amount as string)} ریال • سررسید بعدی: {String(r.next_due_date)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-800">
                      {String(r.computed_status)}
                    </span>
                    <button
                      type="button"
                      onClick={() => handlePayRecurring(String(r.id))}
                      className="rounded-lg bg-emerald-600 text-white px-3 py-1 text-[11px] cursor-pointer"
                    >
                      ثبت پرداخت تعهد
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 2. QUICK EXPENSE & INCOME WITH AUTOMATIC ACCOUNT MAPPING */}
      {activeTab === "quick_entry" && (
        <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-3">
          <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div className="inline-flex rounded-xl bg-slate-100 p-1 text-xs">
                <button
                  type="button"
                  onClick={() => {
                    setQuickKind("EXPENSE");
                    const m = accCats.find((c) => c.kind === "EXPENSE");
                    if (m) setQuickForm((p) => ({ ...p, category_id: String(m.id) }));
                  }}
                  className={`px-4 py-1.5 rounded-lg font-medium cursor-pointer ${quickKind === "EXPENSE" ? "bg-rose-600 text-white" : "text-slate-600"}`}
                >
                  ثبت سریع هزینه (Expense)
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setQuickKind("INCOME");
                    const m = accCats.find((c) => c.kind === "INCOME");
                    if (m) setQuickForm((p) => ({ ...p, category_id: String(m.id) }));
                  }}
                  className={`px-4 py-1.5 rounded-lg font-medium cursor-pointer ${quickKind === "INCOME" ? "bg-emerald-600 text-white" : "text-slate-600"}`}
                >
                  ثبت سریع درآمد (Income)
                </button>
              </div>
              <span className="text-xs text-slate-500 flex items-center gap-1">
                <Zap className="h-3.5 w-3.5 text-amber-500" />
                نگاشت خودکار به کدینگ حسابداری دوبل
              </span>
            </div>

            <form onSubmit={handleQuickEntry} className="grid grid-cols-1 gap-3 text-xs">
              <select
                required
                value={quickForm.category_id}
                onChange={(e) => setQuickForm({ ...quickForm, category_id: e.target.value })}
                className="rounded-xl border border-slate-200 px-3 py-2"
              >
                <option value="">انتخاب دسته‌بندی...</option>
                {accCats
                  .filter((c) => c.kind === quickKind)
                  .map((c) => {
                    const m = c.mapping as Record<string, string> | null;
                    return (
                      <option key={String(c.id)} value={String(c.id)}>
                        {String(c.name_fa)} {m ? `(${m.debit_account_name} / ${m.credit_account_name})` : ""}
                      </option>
                    );
                  })}
              </select>
              <select
                required
                value={quickForm.financial_account_id}
                onChange={(e) => setQuickForm({ ...quickForm, financial_account_id: e.target.value })}
                className="rounded-xl border border-slate-200 px-3 py-2"
              >
                {bizAccounts.map((a) => (
                  <option key={String(a.id)} value={String(a.id)}>{String(a.name)}</option>
                ))}
              </select>
              <input
                required
                value={quickForm.title}
                onChange={(e) => setQuickForm({ ...quickForm, title: e.target.value })}
                placeholder="شرح هزینه یا درآمد"
                className="rounded-xl border border-slate-200 px-3 py-2"
              />
              <input
                dir="ltr"
                required
                value={quickForm.amount}
                onChange={(e) => setQuickForm({ ...quickForm, amount: e.target.value })}
                className="rounded-xl border border-slate-200 px-3 py-2 font-mono text-left"
              />
              <label className="text-[11px]">تاریخ تراکنش شمسی<JalaliDatePicker className="mt-1" value={quickForm.tx_date_jalali} onChange={(value) => setQuickForm({ ...quickForm, tx_date_jalali: value })}/></label>
              <button
                type="submit"
                className={`rounded-xl text-white py-2 font-medium cursor-pointer ${quickKind === "EXPENSE" ? "bg-rose-600" : "bg-emerald-700"}`}
              >
                ثبت و صدور خودکار سند
              </button>
            </form>
          </div>

          {(["EXPENSE", "INCOME"] as const).map((kind) => {
            const entries = quickTxs.filter((item) => String(item.kind).toUpperCase() === kind);
            const income = kind === "INCOME";
            return <section key={kind} className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="mb-3 flex items-center justify-between gap-2"><h3 className="text-sm font-bold text-slate-900">تراکنش‌های سریع {income ? "درآمد" : "هزینه"}</h3><span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${income ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}>{entries.length} مورد</span></div>
              <div className="max-h-[480px] space-y-2 overflow-y-auto">
                {entries.map((item) => <article key={String(item.id)} className="rounded-xl border border-slate-100 p-3 text-xs">
                  <div className="flex items-start justify-between gap-2"><strong className="leading-5">{String(item.title)}</strong><b className={`shrink-0 tabular-nums ${income ? "text-emerald-700" : "text-rose-700"}`}>{formatIrr(item.amount as string)} ریال</b></div>
                  <div className="mt-2 flex flex-wrap justify-between gap-x-3 gap-y-1 text-[10px] text-slate-500"><span>{String(item.category_name)} • {String(item.account_name)}</span><span>{String(item.tx_date)}</span></div>
                  <div className="mt-2 text-[10px] font-semibold text-slate-600">{String(item.status)}</div>
                </article>)}
                {!entries.length && <p className="rounded-xl border border-dashed border-slate-200 p-4 text-center text-xs text-slate-500">تراکنش ثبت‌شده‌ای وجود ندارد.</p>}
              </div>
            </section>;
          })}
        </div>
      )}

      {/* 3. FAST MIXED-PAYMENT SALES INVOICE + QUOTATIONS + PDF */}
      {activeTab === "mixed_sales" && (
        <div className="space-y-5">
          <SalesInvoiceComposer orgId={orgId} onToast={onToast} onRefresh={() => { void loadData(); }} title="صدور سریع فاکتور فروش با پرداخت ترکیبی (نقد + کارت‌خوان POS + نسیه)" />

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-2.5 text-xs">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-slate-900">فاکتورهای فروش و چاپ PDF</h3>
                <button
                  type="button"
                  onClick={downloadJournalBookXlsx}
                  className="inline-flex items-center gap-1 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 px-2.5 py-1 text-[11px] font-medium cursor-pointer"
                >
                  <FileSpreadsheet className="h-3.5 w-3.5" />
                  <span>اکسل دفتر روزنامه (.xlsx)</span>
                </button>
              </div>
              {salesList.slice(0, 8).map((s) => (
                <div key={String(s.id)} className="rounded-xl border border-slate-200 p-3 flex items-center justify-between gap-2">
                  <div>
                    <div className="font-bold text-slate-900">{String(s.document_number)} — {String(s.customer_name)}</div>
                    <div className="text-slate-500 mt-0.5 tabular-nums">
                      کل: {formatIrr(s.grand_total as string)} | پرداختی: {formatIrr(s.paid_amount as string)} | مانده: {formatIrr(s.remaining_amount as string)}
                    </div>
                  </div>
                  <a
                    href={`/api/v1/documents/pdf?type=sales_invoice&id=${String(s.id)}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] hover:bg-slate-50"
                  >
                    <Printer className="h-3.5 w-3.5" />
                    <span>چاپ PDF</span>
                  </a>
                </div>
              ))}
            </div>

            <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-2.5 text-xs">
              <h3 className="text-sm font-bold text-slate-900">پیش‌فاکتورها (Quotations)</h3>
              {quotationsList.length === 0 && <div className="text-slate-400">هنوز پیش‌فاکتوری ثبت نشده است.</div>}
              {quotationsList.map((q) => (
                <div key={String(q.id)} className="rounded-xl border border-slate-200 p-3 flex items-center justify-between gap-2">
                  <div>
                    <div className="font-bold">{String(q.quotation_number)} — {String(q.customer_name)}</div>
                    <div className="text-slate-500 tabular-nums">{formatIrr(q.grand_total as string)} ریال • اعتبار تا {String(q.valid_until)}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <a
                      href={`/api/v1/documents/pdf?type=quotation&id=${String(q.id)}`}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-lg border border-slate-200 px-2 py-1 text-[11px]"
                    >
                      PDF
                    </a>
                    {q.status !== "CONVERTED" && (
                      <button
                        type="button"
                        onClick={() => handleConvertQuotation(String(q.id))}
                        className="rounded-lg bg-indigo-600 text-white px-2.5 py-1 text-[11px] cursor-pointer"
                      >
                        تبدیل به فاکتور
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 4. PRODUCT VARIANTS & SMART PURCHASE REPLENISHMENT */}
      {activeTab === "variants_replenish" && (
        <div className="space-y-5">
          <form onSubmit={handleCreateVariantWithOpeningStock} className="bg-white rounded-2xl border border-slate-200 p-5 space-y-3 text-xs">
            <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
              <Layers className="h-4 w-4 text-teal-600" />
              <span>تعریف تنوع کالا (سایز/رنگ/مدل) + ثبت موجودی اول دوره مستقل در Stock Ledger</span>
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-5 gap-2.5">
              <ProductPickerModal products={productsList} value={varForm.product_id} organizationId={orgId} onToast={onToast} onProductCreated={(product) => setProductsList((current) => [product, ...current.filter((item) => String(item.id) !== String(product.id))])} onChange={(productId) => setVarForm({ ...varForm, product_id: productId })} />
              <input
                value={varForm.variant_name}
                onChange={(e) => setVarForm({ ...varForm, variant_name: e.target.value })}
                placeholder="عنوان تنوع (مثلاً سایز L / مشکی)"
                className="rounded-xl border border-slate-200 px-3 py-2"
              />
              <input
                dir="ltr"
                value={varForm.sale_price}
                onChange={(e) => setVarForm({ ...varForm, sale_price: e.target.value })}
                placeholder="قیمت فروش"
                className="rounded-xl border border-slate-200 px-3 py-2 font-mono text-left"
              />
              <input
                dir="ltr"
                value={varForm.opening_qty}
                onChange={(e) => setVarForm({ ...varForm, opening_qty: e.target.value })}
                placeholder="موجودی اولیه"
                className="rounded-xl border border-slate-200 px-3 py-2 font-mono text-left"
              />
              <button type="submit" className="rounded-xl bg-teal-700 text-white py-2 font-medium cursor-pointer">
                ثبت تنوع + سند اول دوره
              </button>
            </div>
          </form>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-2.5 text-xs">
              <h3 className="text-sm font-bold text-slate-900">
                تنوع‌های کالا (مجموع Projection: {formatQty(variantsData?.parent_stock_projection as string)})
              </h3>
              {(((variantsData?.variants as Array<Record<string, unknown>>) ?? [])).map((v) => (
                <div key={String(v.id)} className="rounded-xl border border-slate-200 p-3 flex items-center justify-between">
                  <div>
                    <div className="font-bold text-slate-900">{String(v.variant_name)}</div>
                    <div className="font-mono text-[11px] text-slate-400">{String(v.sku)} • فروش: {formatIrr(v.sale_price as string)}</div>
                  </div>
                  <span className="font-bold text-teal-700 tabular-nums">موجودی: {formatQty(v.on_hand_qty as string)}</span>
                </div>
              ))}
            </div>

            <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-2.5 text-xs">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-amber-500" />
                  <span>پیشنهادهای خرید هوشمند (با لحاظ سفارش‌های در راه PO)</span>
                </h3>
                <button type="button" onClick={loadData} className="text-indigo-600 cursor-pointer">
                  <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
                </button>
              </div>
              {suggestions.length === 0 && (
                <div className="text-slate-400">در حال حاضر کالایی با ریسک اتمام موجودی شناسایی نشده است.</div>
              )}
              {suggestions.map((s) => (
                <div key={String(s.id)} className="rounded-xl border border-amber-200 bg-amber-50/40 p-3.5 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-slate-900">{String(s.product_name)} ({String(s.warehouse_name)})</span>
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-rose-100 text-rose-700">
                      ریسک: {String(s.stockout_risk)} • {String(s.status)}
                    </span>
                  </div>
                  <p className="text-slate-700 leading-relaxed">{String(s.reason_fa)}</p>
                  {s.status === "PENDING" && (
                    <button
                      type="button"
                      onClick={() => handleConvertSuggestionToPo(String(s.id))}
                      className="rounded-lg bg-indigo-600 text-white px-3 py-1.5 text-[11px] font-medium cursor-pointer"
                    >
                      تایید و تبدیل به سفارش خرید (PO) — مقدار: {formatQty(s.recommended_qty as string)}
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 5. CRM LOYALTY & EMPLOYEES / RBAC */}
      {activeTab === "crm_employees" && (
        <div className="space-y-5">
          <div className="bg-white rounded-2xl border border-slate-200 p-5 overflow-x-auto">
            <h3 className="text-sm font-bold text-slate-900 mb-3 flex items-center gap-2">
              <Award className="h-4 w-4 text-amber-500" />
              <span>پروفایل مشتریان، سگمنت‌بندی و دفتر امتیاز وفاداری (Immutable Loyalty Ledger)</span>
            </h3>
            <table className="w-full text-xs text-right">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="px-3 py-2">مشتری</th>
                  <th className="px-3 py-2">سطح / امتیاز</th>
                  <th className="px-3 py-2">سگمنت‌ها</th>
                  <th className="px-3 py-2">کل خرید / مطالبات</th>
                  <th className="px-3 py-2">عملیات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 tabular-nums">
                {crmProfiles.map((c) => (
                  <tr key={String(c.contact_id)}>
                    <td className="px-3 py-2.5 font-semibold">{String(c.display_name)}</td>
                    <td className="px-3 py-2.5">
                      <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-900 font-semibold text-[10px]">
                        {String(c.loyalty_tier)} • {String(c.loyalty_points)} امتیاز
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      {((c.segments as string[]) ?? []).map((sg) => (
                        <span key={sg} className="inline-block ml-1 px-2 py-0.5 rounded bg-slate-100 text-[10px] font-mono">{sg}</span>
                      ))}
                    </td>
                    <td className="px-3 py-2.5">
                      خرید: {formatIrr(c.total_purchases as string)} | بدهی: <strong>{formatIrr(c.outstanding_receivable as string)}</strong>
                    </td>
                    <td className="px-3 py-2.5">
                      <button
                        type="button"
                        onClick={() => handleRedeemPoints(String(c.contact_id))}
                        className="rounded-lg border border-amber-300 bg-amber-50 text-amber-900 px-2.5 py-1 text-[11px] cursor-pointer"
                      >
                        +۵۰ امتیاز پاداش
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-4">
            <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
              <Briefcase className="h-4 w-4 text-indigo-600" />
              <span>مدیریت پرسنل و کنترل دسترسی RBAC</span>
            </h3>
            <form onSubmit={handleCreateEmployee} className="grid grid-cols-1 md:grid-cols-6 gap-2 text-xs">
              <input required placeholder="کد پرسنلی" value={empForm.employee_code} onChange={(e) => setEmpForm({ ...empForm, employee_code: e.target.value })} className="rounded-xl border border-slate-200 px-3 py-2" />
              <input required placeholder="نام پرسنل" value={empForm.full_name} onChange={(e) => setEmpForm({ ...empForm, full_name: e.target.value })} className="rounded-xl border border-slate-200 px-3 py-2" />
              <input required dir="ltr" placeholder="0912..." value={empForm.mobile} onChange={(e) => setEmpForm({ ...empForm, mobile: e.target.value })} className="rounded-xl border border-slate-200 px-3 py-2 font-mono text-left" />
              <input required dir="ltr" type="email" placeholder="emp@org.ir" value={empForm.email} onChange={(e) => setEmpForm({ ...empForm, email: e.target.value })} className="rounded-xl border border-slate-200 px-3 py-2 font-mono text-left" />
              <select value={empForm.role_code} onChange={(e) => setEmpForm({ ...empForm, role_code: e.target.value })} className="rounded-xl border border-slate-200 px-3 py-2">
                <option value="SALESPERSON">فروشنده (بدون دسترسی سود/مالی شخصی)</option>
                <option value="WAREHOUSE_MGR">مدیر انبار</option>
                <option value="ACCOUNTANT">حسابدار ارشد</option>
              </select>
              <button type="submit" className="inline-flex items-center justify-center gap-1 rounded-xl bg-indigo-600 text-white py-2 font-medium cursor-pointer">
                <UserPlus className="h-3.5 w-3.5" />
                <span>ثبت پرسنل</span>
              </button>
            </form>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
              {employeesList.map((e) => (
                <div key={String(e.id)} className="rounded-xl border border-slate-200 p-3">
                  <div className="font-bold text-slate-900">{String(e.full_name)} ({String(e.employee_code)})</div>
                  <div className="text-slate-500 mt-1">{String(e.role_name || "—")} • {String(e.branch_name || "")}</div>
                  <div className="text-[11px] font-mono text-slate-400 mt-1">{String(e.email || "")}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 6. ADVANCED CHEQUE DASHBOARD & DAILY BAR CHART */}
      {activeTab === "cheque_analytics" && (
        <div className="space-y-5">
          {chequeDash && (
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-xs">
              {(() => {
                const s = (chequeDash.summary as Record<string, string | number>) ?? {};
                return [
                  { label: "کل چک‌های دریافتنی", val: `${formatIrr(s.total_receivables)} ریال`, tone: "text-emerald-700" },
                  { label: "کل چک‌های پرداختنی", val: `${formatIrr(s.total_payables)} ریال`, tone: "text-rose-700" },
                  { label: "در جریان وصول", val: `${s.in_collection_count ?? 0} فقره`, tone: "text-indigo-700" },
                  { label: "سررسید این هفته", val: `${s.due_this_week_count ?? 0} فقره`, tone: "text-amber-700" },
                  { label: "چک‌های برگشتی", val: `${s.returned_count ?? 0} فقره`, tone: "text-rose-800" },
                ].map((c) => (
                  <div key={c.label} className="bg-white rounded-2xl border border-slate-200 p-4">
                    <div className="text-slate-500">{c.label}</div>
                    <div className={`text-base font-bold mt-2 tabular-nums ${c.tone}`}>{c.val}</div>
                  </div>
                ));
              })()}
            </div>
          )}

          <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                <BarChart3 className="h-4 w-4 text-indigo-600" />
                <span>نمودار میله‌ای روزانه چک‌های دریافتنی و پرداختنی ماه</span>
              </h3>
              <div className="flex items-center gap-2 text-xs">
                <CalendarClock className="h-4 w-4 text-slate-400" />
                <JalaliMonthPicker value={chartMonth} onChange={setChartMonth} />
              </div>
            </div>
            <div className="h-72 w-full" dir="ltr">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chequeChart}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="day" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="received" name="چک‌های دریافتنی (ریال)" fill="#059669" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="issued" name="چک‌های پرداختنی (ریال)" fill="#e11d48" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="flex justify-end">
            <button
              type="button"
              onClick={downloadJournalBookXlsx}
              className="inline-flex items-center gap-2 rounded-xl bg-slate-900 text-white px-4 py-2 text-xs font-medium cursor-pointer"
            >
              <Download className="h-4 w-4" />
              <span>خروجی اکسل دفتر روزنامه (.xlsx)</span>
            </button>
          </div>
        </div>
      )}

      {/* Keep unused icon imports cleanly referenced if needed */}
      <span className="hidden"><Plus /><CheckCircle2 /></span>
    </div>
  );
}

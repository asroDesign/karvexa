"use client";

import React, { useCallback, useEffect, useState } from "react";
import {
  BookOpen,
  Boxes,
  CheckCircle2,
  ClipboardCheck,
  CreditCard,
  Download,
  FileSpreadsheet,
  Landmark,
  LayoutDashboard,
  Package,
  Plus,
  RefreshCw,
  RotateCcw,
  ShoppingBag,
  Smartphone,
  Users,
  AlertTriangle,
  Lock,
  ScanBarcode,
  LifeBuoy,
} from "lucide-react";
import {
  apiFetch,
  formatDateFa,
  formatDateTimeFa,
  formatIrr,
  formatQty,
  SessionMeResponse,
} from "@/lib/format";
import { currentJalaliDate } from "@/lib/jalali";
import { JalaliDatePicker } from "@/components/JalaliDatePicker";
import { QuickAddProductModal } from "@/components/QuickAddProductModal";
import { SalesInvoiceComposer } from "@/components/SalesInvoiceComposer";
import { AdvancedModulesPanel, AdvancedSubTab } from "./AdvancedModulesPanel";
import { GlassDashboard } from "./GlassDashboard";
import { UserAccessSettings } from "./UserAccessSettings";
import { FiscalLifecyclePanel } from "./FiscalLifecyclePanel";
import { BusinessSupportTickets } from "./BusinessSupportTickets";
import { AccountingParityPanel, CommerceParityPanel, InventoryParityPanel, TreasuryParityPanel } from "./BusinessParityPanels";
import { SupplierAccountsPanel } from "./SupplierAccountsPanel";
import { Award, BarChart3, CalendarRange, Settings, Sparkles, Wallet, Zap } from "lucide-react";

type OrgTab =
  | "dashboard"
  | "mixed_sales"
  | "quick_entry"
  | "personal_finance"
  | "fiscal_lifecycle"
  | "accounting"
  | "inventory"
  | "supplier_accounts"
  | "variants_replenish"
  | "catalog"
  | "contacts"
  | "crm_employees"
  | "commerce"
  | "treasury"
  | "cheque_analytics"
  | "settings_access"
  | "subscription"
  | "sync"
  | "support";

interface OrgWorkspaceProps {
  session: SessionMeResponse;
  onRefreshSession: () => Promise<void>;
  onToast: (msg: string, type?: "success" | "error") => void;
}

const ADVANCED_TABS: Set<OrgTab> = new Set([
  "personal_finance",
  "quick_entry",
  "mixed_sales",
  "variants_replenish",
  "crm_employees",
  "cheque_analytics",
]);

const ORG_TABS: Array<{ id: OrgTab; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: "dashboard", label: "داشبورد و نمودارهای روزانه", icon: LayoutDashboard },
  { id: "mixed_sales", label: "فروش سریع، پرداخت ترکیبی و PDF", icon: ShoppingBag },
  { id: "quick_entry", label: "ثبت سریع هزینه و درآمد", icon: Zap },
  { id: "personal_finance", label: "مالی شخصی و برداشت مالک", icon: Wallet },
  { id: "fiscal_lifecycle", label: "کدینگ، افتتاحیه و سال مالی", icon: CalendarRange },
  { id: "accounting", label: "دفتر روزنامه، تراز و اکسل", icon: BookOpen },
  { id: "inventory", label: "انبار، انتقال و انبارگردانی", icon: Boxes },
  { id: "supplier_accounts", label: "حساب تأمین‌کنندگان", icon: Users },
  { id: "variants_replenish", label: "تنوع کالا و خرید هوشمند", icon: Sparkles },
  { id: "catalog", label: "کاتالوگ کالا و بارکد", icon: Package },
  { id: "contacts", label: "اشخاص و طرف‌حساب‌ها", icon: Users },
  { id: "crm_employees", label: "باشگاه مشتریان و پرسنل", icon: Award },
  { id: "commerce", label: "فاکتورهای فروش و خرید", icon: ShoppingBag },
  { id: "treasury", label: "خزانه، چک و امانی", icon: Landmark },
  { id: "cheque_analytics", label: "داشبورد و نمودار چک‌ها", icon: BarChart3 },
  { id: "settings_access", label: "تنظیمات، تم و دسترسی کاربران", icon: Settings },
  { id: "subscription", label: "اشتراک کافه‌بازار و خروجی", icon: CreditCard },
  { id: "sync", label: "همگام‌سازی آفلاین اندروید", icon: Smartphone },
  { id: "support", label: "پشتیبانی و تیکت‌ها", icon: LifeBuoy },
];

export function OrgWorkspace({ session, onRefreshSession, onToast }: OrgWorkspaceProps) {
  const orgId = session.active_organization?.organization_id ?? null;
  const [tab, setTab] = useState<OrgTab>("dashboard");
  const [supportRefresh, setSupportRefresh] = useState(0);
  const [loading, setLoading] = useState(false);

  // Dashboard
  const [dash, setDash] = useState<Record<string, unknown> | null>(null);

  // Accounting
  const [accountsList, setAccountsList] = useState<Array<Record<string, unknown>>>([]);
  const [periods, setPeriods] = useState<Array<Record<string, unknown>>>([]);
  const [journals, setJournals] = useState<Array<Record<string, unknown>>>([]);
  const [trialBalance, setTrialBalance] = useState<Record<string, unknown> | null>(null);
  const [profitLoss, setProfitLoss] = useState<Record<string, unknown> | null>(null);
  const [showJournalForm, setShowJournalForm] = useState(false);
  const [jForm, setJForm] = useState({
    document_date_jalali: currentJalaliDate(),
    description: "",
    confirm_immediately: true,
    accounting_period_id: "",
    lines: [
      { account_id: "", debit: "", credit: "", description: "" },
      { account_id: "", debit: "", credit: "", description: "" },
    ],
  });

  // Inventory
  const [warehousesList, setWarehousesList] = useState<Array<Record<string, unknown>>>([]);
  const [stockData, setStockData] = useState<Record<string, unknown> | null>(null);
  const [movements, setMovements] = useState<Array<Record<string, unknown>>>([]);
  const [transfers, setTransfers] = useState<Array<Record<string, unknown>>>([]);
  const [counts, setCounts] = useState<Array<Record<string, unknown>>>([]);
  const [productsList, setProductsList] = useState<Array<Record<string, unknown>>>([]);
  // Catalog
  const [catalogMeta, setCatalogMeta] = useState<{
    categories: Array<Record<string, unknown>>;
    brands: Array<Record<string, unknown>>;
    units: Array<Record<string, unknown>>;
  }>({ categories: [], brands: [], units: [] });
  const [barcodeInput, setBarcodeInput] = useState("");
  const [barcodeResult, setBarcodeResult] = useState<Record<string, unknown> | null>(null);
  const [prodForm, setProdForm] = useState({
    code: "",
    name: "",
    description: "",
    item_type: "PRODUCT",
    category_id: "",
    brand_id: "",
    base_unit_id: "",
    purchase_price: "0.00",
    sale_price: "0.00",
    tax_rate: "10.00",
    minimum_stock: "5.0000",
    maximum_stock: "100.0000",
    track_inventory: true,
    allow_negative_stock: false,
    is_active: true,
    barcode: "",
  });
  const [showProductCreateModal, setShowProductCreateModal] = useState(false);
  const [showQuickProductModal, setShowQuickProductModal] = useState(false);

  // Contacts
  const [contactsList, setContactsList] = useState<Array<Record<string, unknown>>>([]);
  const [contactForm, setContactForm] = useState({
    code: "",
    display_name: "",
    type: "CUSTOMER",
    mobile: "",
    credit_limit: "0.00",
  });

  // Commerce (Sales & Purchasing)
  const [salesList, setSalesList] = useState<Array<Record<string, unknown>>>([]);
  const [purchasesList, setPurchasesList] = useState<Array<Record<string, unknown>>>([]);
  // Treasury, Cheques, Consignments
  const [treasuryAccounts, setTreasuryAccounts] = useState<Array<Record<string, unknown>>>([]);
  const [treasuryTxs, setTreasuryTxs] = useState<Array<Record<string, unknown>>>([]);
  const [chequesList, setChequesList] = useState<Array<Record<string, unknown>>>([]);
  const [consignmentsList, setConsignmentsList] = useState<Array<Record<string, unknown>>>([]);
  const [consignmentSales, setConsignmentSales] = useState<Record<string, string>>({});
  const [txForm, setTxForm] = useState({
    kind: "receipts" as "receipts" | "payments",
    account_id: "",
    amount: "",
    payment_method: "BANK_TRANSFER",
    description: "",
    transaction_date_jalali: currentJalaliDate(),
  });

  // Subscription
  const [subCurrent, setSubCurrent] = useState<Record<string, unknown> | null>(null);
  const [subPlans, setSubPlans] = useState<Array<Record<string, unknown>>>([]);
  const [cbzForm, setCbzForm] = useState({
    sku: "",
    purchase_token: "",
  });

  // Sync
  const [syncData, setSyncData] = useState<Record<string, unknown> | null>(null);
  const [syncStatus, setSyncStatus] = useState<Record<string, unknown> | null>(null);
  const [pullOutput, setPullOutput] = useState<Record<string, unknown> | null>(null);

  const loadTab = useCallback(
    async (activeTab: OrgTab) => {
      if (!orgId) return;
      setLoading(true);
      try {
        if (activeTab === "dashboard") {
          setDash(await apiFetch<Record<string, unknown>>("/api/v1/reports/dashboard", { organizationId: orgId }));
        } else if (activeTab === "accounting") {
          const [accRes, fyRes, jRes, tbRes, plRes] = await Promise.all([
            apiFetch<{ accounts: Array<Record<string, unknown>> }>("/api/v1/accounting/accounts", { organizationId: orgId }),
            apiFetch<{ periods: Array<Record<string, unknown>> }>("/api/v1/accounting/fiscal-years", { organizationId: orgId }),
            apiFetch<Array<Record<string, unknown>>>("/api/v1/accounting/journal-entries?per_page=50", { organizationId: orgId }),
            apiFetch<Record<string, unknown>>("/api/v1/accounting/trial-balance", { organizationId: orgId }),
            apiFetch<Record<string, unknown>>("/api/v1/accounting/profit-loss", { organizationId: orgId }),
          ]);
          setAccountsList(accRes.accounts);
          setPeriods(fyRes.periods);
          setJournals(jRes);
          setTrialBalance(tbRes);
          setProfitLoss(plRes);
          if (accRes.accounts.length >= 2 && !jForm.lines[0].account_id) {
            setJForm((prev) => ({
              ...prev,
              lines: [
                { ...prev.lines[0], account_id: String(accRes.accounts[accRes.accounts.length - 1].id) },
                { ...prev.lines[1], account_id: String(accRes.accounts[1].id) },
              ],
            }));
          }
        } else if (activeTab === "inventory") {
          const [whs, stk, movs, trs, cnts, prods] = await Promise.all([
            apiFetch<Array<Record<string, unknown>>>("/api/v1/warehouses?per_page=50", { organizationId: orgId }),
            apiFetch<Record<string, unknown>>("/api/v1/inventory/stock", { organizationId: orgId }),
            apiFetch<Array<Record<string, unknown>>>("/api/v1/inventory/movements?per_page=50", { organizationId: orgId }),
            apiFetch<Array<Record<string, unknown>>>("/api/v1/inventory/transfers?per_page=30", { organizationId: orgId }),
            apiFetch<Array<Record<string, unknown>>>("/api/v1/inventory/counts?per_page=30", { organizationId: orgId }),
            apiFetch<Array<Record<string, unknown>>>("/api/v1/products?per_page=100", { organizationId: orgId }),
          ]);
          setWarehousesList(whs);
          setStockData(stk);
          setMovements(movs);
          setTransfers(trs);
          setCounts(cnts);
          setProductsList(prods);
        } else if (activeTab === "catalog") {
          const [prods, cats, brds, unts] = await Promise.all([
            apiFetch<Array<Record<string, unknown>>>("/api/v1/products?per_page=100", { organizationId: orgId }),
            apiFetch<Array<Record<string, unknown>>>("/api/v1/categories", { organizationId: orgId }),
            apiFetch<Array<Record<string, unknown>>>("/api/v1/brands", { organizationId: orgId }),
            apiFetch<Array<Record<string, unknown>>>("/api/v1/units", { organizationId: orgId }),
          ]);
          setProductsList(prods);
          setCatalogMeta({ categories: cats, brands: brds, units: unts });
          if (unts.length > 0 && !prodForm.base_unit_id) {
            setProdForm((p) => ({ ...p, base_unit_id: String(unts[0].id) }));
          }
        } else if (activeTab === "contacts") {
          setContactsList(
            await apiFetch<Array<Record<string, unknown>>>("/api/v1/contacts?per_page=100", { organizationId: orgId })
          );
        } else if (activeTab === "commerce") {
          const [sList, pList, cList, wList, prList] = await Promise.all([
            apiFetch<Array<Record<string, unknown>>>("/api/v1/sales?per_page=50", { organizationId: orgId }),
            apiFetch<Array<Record<string, unknown>>>("/api/v1/purchases?per_page=50", { organizationId: orgId }),
            apiFetch<Array<Record<string, unknown>>>("/api/v1/contacts?per_page=100", { organizationId: orgId }),
            apiFetch<Array<Record<string, unknown>>>("/api/v1/warehouses?per_page=50", { organizationId: orgId }),
            apiFetch<Array<Record<string, unknown>>>("/api/v1/products?per_page=100", { organizationId: orgId }),
          ]);
          setSalesList(sList);
          setPurchasesList(pList);
          setContactsList(cList);
          setWarehousesList(wList);
          setProductsList(prList);

        } else if (activeTab === "treasury") {
          const [accs, txs, chqs, cons] = await Promise.all([
            apiFetch<Array<Record<string, unknown>>>("/api/v1/treasury/accounts", { organizationId: orgId }),
            apiFetch<Array<Record<string, unknown>>>("/api/v1/treasury/transactions?per_page=50", { organizationId: orgId }),
            apiFetch<Array<Record<string, unknown>>>("/api/v1/cheques?per_page=50", { organizationId: orgId }),
            apiFetch<Array<Record<string, unknown>>>("/api/v1/consignments?per_page=50", { organizationId: orgId }),
          ]);
          setTreasuryAccounts(accs);
          setTreasuryTxs(txs);
          setChequesList(chqs);
          setConsignmentsList(cons);
          if (accs.length > 0 && !txForm.account_id) {
            setTxForm((p) => ({ ...p, account_id: String(accs[0].id) }));
          }
        } else if (activeTab === "subscription") {
          const [cur, plns] = await Promise.all([
            apiFetch<Record<string, unknown>>("/api/v1/subscription/current", { organizationId: orgId }),
            apiFetch<Array<Record<string, unknown>>>("/api/v1/subscription/plans", { organizationId: orgId }),
          ]);
          setSubCurrent(cur);
          setSubPlans(plns);
          setCbzForm((current) => ({ ...current, sku: current.sku || String(plns[0]?.cafebazaar_sku ?? "") }));
        } else if (activeTab === "sync") {
          const [sRes, stRes, cList, wList, pList] = await Promise.all([
            apiFetch<Record<string, unknown>>("/api/v1/sync/conflicts", { organizationId: orgId }),
            apiFetch<Record<string, unknown>>("/api/v1/sync/status", { organizationId: orgId }),
            apiFetch<Array<Record<string, unknown>>>("/api/v1/contacts?per_page=50", { organizationId: orgId }),
            apiFetch<Array<Record<string, unknown>>>("/api/v1/warehouses?per_page=50", { organizationId: orgId }),
            apiFetch<Array<Record<string, unknown>>>("/api/v1/products?per_page=50", { organizationId: orgId }),
          ]);
          setSyncData(sRes);
          setSyncStatus(stRes);
          setContactsList(cList);
          setWarehousesList(wList);
          setProductsList(pList);
        }
      } catch (e) {
        onToast(e instanceof Error ? e.message : "خطا در دریافت داده‌های سازمان", "error");
      } finally {
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [orgId, onToast]
  );

  useEffect(() => {
    loadTab(tab);
  }, [tab, orgId, loadTab]);

  // ============================================================================
  // Handlers
  // ============================================================================

  async function submitJournal(e: React.FormEvent) {
    e.preventDefault();
    try {
      await apiFetch("/api/v1/accounting/journal-entries", {
        method: "POST",
        organizationId: orgId,
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          client_document_id: crypto.randomUUID(),
          document_date_jalali: jForm.document_date_jalali,
          description: jForm.description,
          confirm_immediately: jForm.confirm_immediately,
          ...(jForm.accounting_period_id ? { accounting_period_id: jForm.accounting_period_id } : {}),
          lines: jForm.lines,
        }),
      });
      onToast(
        jForm.confirm_immediately
          ? "سند حسابداری دوبل با تراز کامل قطعی و در دفتر کل ثبت شد."
          : "پیش‌نویس سند حسابداری ذخیره شد."
      );
      setShowJournalForm(false);
      setJForm({ ...jForm, description: "" });
      loadTab("accounting");
    } catch (err) {
      onToast(err instanceof Error ? err.message : "خطا در ثبت سند حسابداری", "error");
    }
  }

  async function confirmJournal(id: string) {
    try {
      await apiFetch(`/api/v1/accounting/journal-entries/${id}/confirm`, {
        method: "POST",
        organizationId: orgId,
      });
      onToast("سند پیش‌نویس قطعی (CONFIRMED) شد و از این پس تغییرناپذیر است.");
      loadTab("accounting");
    } catch (err) {
      onToast(err instanceof Error ? err.message : "خطا در قطعی‌سازی", "error");
    }
  }

  async function reverseJournal(id: string) {
    try {
      await apiFetch(`/api/v1/accounting/journal-entries/${id}/reverse`, {
        method: "POST",
        organizationId: orgId,
        body: JSON.stringify({ reason: "اصلاح حسابداری از طریق سند معکوس رسمی" }),
      });
      onToast("سند معکوس رسمی ایجاد و اثر مالی سند قبلی بدون حذف فیزیکی خنثی شد.");
      loadTab("accounting");
    } catch (err) {
      onToast(err instanceof Error ? err.message : "خطا در صدور سند معکوس", "error");
    }
  }

  async function togglePeriod(id: string, currentStatus: string) {
    try {
      const nextStatus = currentStatus === "OPEN" ? "CLOSED" : "OPEN";
      await apiFetch(`/api/v1/accounting/periods/${id}`, {
        method: "PATCH",
        organizationId: orgId,
        body: JSON.stringify({ status: nextStatus }),
      });
      onToast(`دوره مالی به وضعیت ${nextStatus === "CLOSED" ? "بسته (CLOSED)" : "باز (OPEN)"} تغییر یافت.`);
      loadTab("accounting");
    } catch (err) {
      onToast(err instanceof Error ? err.message : "خطا در تغییر وضعیت دوره", "error");
    }
  }

  async function lookupBarcode() {
    try {
      const res = await apiFetch<Record<string, unknown>>(
        `/api/v1/products/barcode/${encodeURIComponent(barcodeInput.trim())}`,
        { organizationId: orgId }
      );
      setBarcodeResult(res);
      onToast(`کالا با بارکد ${barcodeInput} یافت شد.`);
    } catch (err) {
      setBarcodeResult(null);
      onToast(err instanceof Error ? err.message : "بارکد یافت نشد", "error");
    }
  }

  async function createProduct(e: React.FormEvent) {
    e.preventDefault();
    try {
      await apiFetch("/api/v1/products", {
        method: "POST",
        organizationId: orgId,
        body: JSON.stringify({
          ...prodForm,
          code: prodForm.code.trim() || undefined,
          category_id: prodForm.category_id || null,
          brand_id: prodForm.brand_id || null,
          track_inventory: prodForm.item_type === "SERVICE" ? false : prodForm.track_inventory,
        }),
      });
      onToast("کالای جدید در کاتالوگ ثبت شد.");
      setProdForm((current) => ({ ...current, code: "", name: "", description: "", barcode: "", category_id: "", brand_id: "", purchase_price: "0.00", sale_price: "0.00", tax_rate: "10.00", minimum_stock: "5.0000", maximum_stock: "100.0000", track_inventory: true, allow_negative_stock: false, is_active: true }));
      setShowProductCreateModal(false);
      loadTab("catalog");
    } catch (err) {
      onToast(err instanceof Error ? err.message : "خطا در ثبت کالا", "error");
    }
  }

  async function createContact(e: React.FormEvent) {
    e.preventDefault();
    try {
      await apiFetch("/api/v1/contacts", {
        method: "POST",
        organizationId: orgId,
        body: JSON.stringify(contactForm),
      });
      onToast("طرف‌حساب جدید با موفقیت ثبت شد.");
      setContactForm({ code: "", display_name: "", type: "CUSTOMER", mobile: "", credit_limit: "0.00" });
      loadTab("contacts");
    } catch (err) {
      onToast(err instanceof Error ? err.message : "خطا در ثبت طرف‌حساب", "error");
    }
  }

  async function confirmInvoice(type: "sales" | "purchases", id: string) {
    try {
      await apiFetch(`/api/v1/${type}/${id}/confirm`, {
        method: "POST",
        organizationId: orgId,
      });
      onToast(
        type === "sales"
          ? "فاکتور فروش تایید شد + حواله خروج انبار + سند حسابداری فروش و بهای تمام‌شده به‌صورت اتمیک ثبت گردید."
          : "فاکتور خرید تایید شد + رسید ورود انبار + سند حسابداری خرید به‌صورت اتمیک ثبت گردید."
      );
      loadTab("commerce");
    } catch (err) {
      onToast(err instanceof Error ? err.message : "خطا در تایید فاکتور", "error");
    }
  }

  async function recordTreasuryTx(e: React.FormEvent) {
    e.preventDefault();
    try {
      await apiFetch(`/api/v1/treasury/${txForm.kind}`, {
        method: "POST",
        organizationId: orgId,
        body: JSON.stringify({
          account_id: txForm.account_id,
          amount: txForm.amount,
          payment_method: txForm.payment_method,
          transaction_date_jalali: txForm.transaction_date_jalali,
          description: txForm.description,
        }),
      });
      onToast("تراکنش خزانه‌داری ثبت و موجودی حساب به‌روزرسانی شد.");
      loadTab("treasury");
    } catch (err) {
      onToast(err instanceof Error ? err.message : "خطا در ثبت خزانه", "error");
    }
  }

  async function transitionCheque(chequeId: string, action: "deposit" | "cash" | "bounce") {
    try {
      await apiFetch(`/api/v1/cheques/${chequeId}/${action}`, {
        method: "POST",
        organizationId: orgId,
        body: JSON.stringify({ note: `ثبت رویداد ${action} از پنل سازمانی` }),
      });
      onToast(`رویداد چک (${action.toUpperCase()}) با موفقیت در تاریخچه چک ثبت شد.`);
      loadTab("treasury");
    } catch (err) {
      onToast(err instanceof Error ? err.message : "خطا در تغییر وضعیت چک", "error");
    }
  }

  async function settleConsignment(docId: string, grossSales: string) {
    if (!grossSales.trim() || !Number.isFinite(Number(grossSales)) || Number(grossSales) <= 0) {
      onToast("مبلغ فروش واقعی و مثبت را برای تسویه وارد کنید.", "error");
      return;
    }
    try {
      await apiFetch(`/api/v1/consignments/${docId}/settlements`, {
        method: "POST",
        organizationId: orgId,
        body: JSON.stringify({ gross_sales: grossSales }),
      });
      onToast("تسویه با مبلغ فروش واردشده در سرور ثبت شد.");
      setConsignmentSales((current) => ({ ...current, [docId]: "" }));
      loadTab("treasury");
    } catch (err) {
      onToast(err instanceof Error ? err.message : "خطا در تسویه امانی", "error");
    }
  }

  async function verifyCafeBazaar(e: React.FormEvent) {
    e.preventDefault();
    try {
      await apiFetch("/api/v1/subscription/market/verify", {
        method: "POST",
        organizationId: orgId,
        headers: { "Idempotency-Key": `cbz-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
        body: JSON.stringify({
          package_name: "ir.businessos.app",
          sku: cbzForm.sku,
          purchase_token: cbzForm.purchase_token,
        }),
      });
      onToast("رسید کافه‌بازار در سرور تایید و اشتراک + Entitlementهای سازمان فعال شد!");
      await onRefreshSession();
      loadTab("subscription");
    } catch (err) {
      onToast(err instanceof Error ? err.message : "تایید رسید ناموفق بود", "error");
    }
  }

  async function exportAllData() {
    try {
      const data = await apiFetch<Record<string, unknown>>("/api/v1/export", { organizationId: orgId });
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `business-os-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      onToast("خروجی کامل داده‌های سازمان (JSON) بدون محدودیت اشتراک دریافت شد.");
    } catch (err) {
      onToast(err instanceof Error ? err.message : "خطا در دریافت خروجی", "error");
    }
  }

  async function simulateOfflinePullAndAck() {
    const devList = (syncData?.devices as Array<Record<string, unknown>>) ?? [];
    const dev = devList[0];
    if (!dev) return;
    try {
      const delta = await apiFetch<Record<string, unknown>>(
        `/api/v1/sync/pull?device_id=${String(dev.id)}&limit=30`,
        { organizationId: orgId }
      );
      setPullOutput(delta);
      if (delta.next_cursor) {
        await apiFetch("/api/v1/sync/acknowledge", {
          method: "POST",
          organizationId: orgId,
          body: JSON.stringify({ device_id: String(dev.id), cursor: String(delta.next_cursor) }),
        });
      }
      onToast(`Pull با Opaque Cursor و Acknowledge موفق (${((delta.changes as unknown[]) ?? []).length} تغییر دریافت شد).`);
      loadTab("sync");
    } catch (err) {
      onToast(err instanceof Error ? err.message : "خطا در Sync Pull", "error");
    }
  }

  async function triggerProtectedResetCheckpoint() {
    const devList = (syncData?.devices as Array<Record<string, unknown>>) ?? [];
    const dev = devList[0];
    if (!dev) return;
    try {
      await apiFetch("/api/v1/sync/reset-checkpoint", {
        method: "POST",
        organizationId: orgId,
        body: JSON.stringify({ device_id: String(dev.id), reason: "بازنشانی ایمن Cursor بدون حذف داده‌های محلی" }),
      });
      onToast("Checkpoint دستگاه با حفظ کامل داده‌های محلی بازنشانی و در Audit Log ثبت شد.");
      loadTab("sync");
    } catch (err) {
      onToast(err instanceof Error ? err.message : "خطا در بازنشانی Cursor", "error");
    }
  }

  async function resolveOrgConflict(
    id: string,
    resolution: "USE_SERVER" | "USE_LOCAL" | "MERGE" | "RECREATE_AS_NEW"
  ) {
    try {
      await apiFetch(`/api/v1/sync/conflicts/${id}/resolve`, {
        method: "POST",
        organizationId: orgId,
        body: JSON.stringify({ resolution }),
      });
      onToast(`تعارض با استراتژی ${resolution} برطرف و در Change Log منتشر شد.`);
      loadTab("sync");
    } catch (err) {
      onToast(err instanceof Error ? err.message : "خطا در رفع تعارض", "error");
    }
  }

  const showToastAlias = (fn: (m: string, t?: "success" | "error") => void) => fn;
  const kpis = (dash?.kpis ?? {}) as Record<string, string | number | boolean>;
  const isExpired = session.subscription?.status === "EXPIRED";

  const formDebitSum = jForm.lines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
  const formCreditSum = jForm.lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
  const formBalanced = formDebitSum > 0 && Math.abs(formDebitSum - formCreditSum) < 0.001;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
      <aside className="lg:col-span-3 xl:col-span-2 bg-white rounded-2xl border border-slate-200 p-3 shadow-xs lg:sticky lg:top-20">
        <div className="px-3 py-2 mb-2 rounded-xl bg-emerald-50 border border-emerald-100">
          <div className="text-[11px] font-bold text-emerald-800 truncate">
            {session.active_organization?.name}
          </div>
          <div className="text-[10px] text-emerald-700 mt-0.5">
            پلن: {session.subscription?.plan_name_fa ?? "رایگان"} •{" "}
            {isExpired ? "منقضی (فقط مشاهده و خروجی)" : "فعال"}
          </div>
        </div>
        <nav className="space-y-1">
          {ORG_TABS.map((item) => {
            const Icon = item.icon;
            const active = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-medium transition-colors cursor-pointer ${
                  active
                    ? "bg-emerald-700 text-white shadow-xs"
                    : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </nav>
      </aside>

      <section className="lg:col-span-9 xl:col-span-10 space-y-5 min-w-0">
        {isExpired && (
          <div className="rounded-2xl border border-amber-300 bg-amber-50 px-5 py-3.5 flex flex-wrap items-center justify-between gap-3 text-xs text-amber-900">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0" />
              <span>
                <strong>اشتراک این سازمان منقضی شده است:</strong> هیچ‌یک از داده‌های شما حذف نمی‌شود و دسترسی کامل به مشاهده و خروجی داده (Export) دارید؛ برای ثبت عملیات جدید از تب اشتراک تمدید کنید.
              </span>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={exportAllData}
                className="rounded-xl bg-white border border-amber-300 px-3 py-1.5 font-medium hover:bg-amber-100 cursor-pointer"
              >
                خروجی کامل داده‌ها
              </button>
              <button
                type="button"
                onClick={() => setTab("subscription")}
                className="rounded-xl bg-amber-600 text-white px-3 py-1.5 font-medium cursor-pointer"
              >
                تمدید با کافه‌بازار
              </button>
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 bg-white rounded-2xl border border-slate-200 px-5 py-4">
          <div>
            <h2 className="text-base font-bold text-slate-900">
              {ORG_TABS.find((t) => t.id === tab)?.label}
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              فضای کاری ایزوله‌شده سازمان • مصرف مستقیم قرارداد استاندارد /api/v1
            </p>
          </div>
          <button
            type="button"
            onClick={() => tab === "support" ? setSupportRefresh((value) => value + 1) : loadTab(tab)}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 px-3 py-1.5 text-xs font-medium text-slate-700 cursor-pointer"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            <span>بروزرسانی</span>
          </button>
        </div>

        {/* MASTER PROMPT 06 — GLASSMORPHISM DASHBOARD WITH 3 DAILY CHARTS */}
        {tab === "dashboard" && (
          <GlassDashboard
            orgId={orgId}
            onNavigate={(next) => setTab(next as OrgTab)}
            onToast={onToast}
          />
        )}

        {/* MASTER PROMPT 06 — SETTINGS: THEME + USERS & ACCESS MANAGEMENT */}
        {tab === "support" && (
          <BusinessSupportTickets organizationId={orgId} refreshKey={supportRefresh} onToast={onToast} />
        )}

        {tab === "settings_access" && (
          <UserAccessSettings orgId={orgId} onToast={onToast} />
        )}

        {/* MASTER PROMPT 06 — CHART OF ACCOUNTS, OPENING BALANCES & FISCAL YEAR LIFECYCLE */}
        {tab === "fiscal_lifecycle" && (
          <FiscalLifecyclePanel orgId={orgId} onToast={onToast} />
        )}

        {/* ADVANCED MASTER PROMPT 05 MODULES */}
        {ADVANCED_TABS.has(tab) && (
          <AdvancedModulesPanel
            orgId={orgId}
            activeTab={tab as AdvancedSubTab}
            onToast={showToastAlias(onToast)}
          />
        )}

        {/* LEGACY COMPACT DASHBOARD SNAPSHOT (superseded by GlassDashboard) */}
        {false && tab === "dashboard" && (
          <div className="space-y-5">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              {[
                { label: "درآمد فروش (دفتر کل)", val: `${formatIrr(kpis.total_revenue as string)} ریال`, sub: `سود خالص: ${formatIrr(kpis.net_profit as string)} ریال`, tone: "text-emerald-700 bg-emerald-50" },
                { label: "ارزش موجودی انبار (Ledger)", val: `${formatIrr(kpis.inventory_valuation as string)} ریال`, sub: `${kpis.products_count ?? 0} قلم کالا`, tone: "text-teal-700 bg-teal-50" },
                { label: "موجودی نقد و بانک", val: `${formatIrr(kpis.cash_and_bank_total as string)} ریال`, sub: `${kpis.contacts_count ?? 0} طرف‌حساب فعال`, tone: "text-indigo-700 bg-indigo-50" },
                { label: "سلامت تراز و Sync", val: kpis.is_trial_balanced ? "تراز ۱۰۰٪ دقیق" : "نیاز به بررسی", sub: `${kpis.devices_count ?? 0} دستگاه • ${kpis.open_conflicts_count ?? 0} تعارض`, tone: "text-slate-700 bg-slate-100" },
              ].map((c) => (
                <div key={c.label} className="bg-white rounded-2xl border border-slate-200 p-4">
                  <div className="text-xs text-slate-500">{c.label}</div>
                  <div className="text-lg font-bold text-slate-900 mt-2 tabular-nums">{c.val}</div>
                  <div className={`inline-block mt-2 text-[11px] font-medium px-2 py-0.5 rounded-full ${c.tone}`}>
                    {c.sub}
                  </div>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              <div className="bg-white rounded-2xl border border-slate-200 p-5">
                <h3 className="text-sm font-bold text-slate-900 mb-3">آخرین اسناد حسابداری</h3>
                <div className="space-y-2">
                  {((dash?.recent_journals as Array<Record<string, unknown>>) ?? []).map((j) => (
                    <div key={String(j.id)} className="flex items-center justify-between rounded-xl bg-slate-50 border border-slate-100 px-3.5 py-2.5 text-xs">
                      <div>
                        <div className="font-semibold text-slate-800">
                          سند #{String(j.entry_number)} — {String(j.description)}
                        </div>
                        <div className="text-[11px] text-slate-400">{String(j.entry_date)}</div>
                      </div>
                      <div className="text-left">
                        <div className="font-semibold tabular-nums">{formatIrr(j.total_debit as string)} ریال</div>
                        <span className="text-[10px] font-mono text-emerald-700">{String(j.status)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-white rounded-2xl border border-slate-200 p-5">
                <h3 className="text-sm font-bold text-slate-900 mb-3">چک‌های پیش‌رو و خزانه</h3>
                <div className="space-y-2">
                  {((dash?.pending_cheques as Array<Record<string, unknown>>) ?? []).map((ch) => (
                    <div key={String(ch.id)} className="flex items-center justify-between rounded-xl bg-slate-50 border border-slate-100 px-3.5 py-2.5 text-xs">
                      <div>
                        <div className="font-semibold text-slate-800">
                          {String(ch.bank_name)} — صیاد {String(ch.sayad_id)}
                        </div>
                        <div className="text-[11px] text-slate-400">سررسید: {String(ch.due_date)}</div>
                      </div>
                      <div className="text-left">
                        <div className="font-semibold tabular-nums">{formatIrr(ch.amount as string)} ریال</div>
                        <span className="text-[10px] font-mono text-indigo-700">{String(ch.status)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* 2. ACCOUNTING */}
        {tab === "accounting" && (
          <div className="space-y-5">
            {/* Periods bar */}
            <div className="bg-white rounded-2xl border border-slate-200 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                <h3 className="text-xs font-bold text-slate-800">کنترل دوره‌های مالی (بستن/بازگشایی دوره)</h3>
                <button
                  type="button"
                  onClick={() => setShowJournalForm(!showJournalForm)}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white px-3.5 py-1.5 text-xs font-medium cursor-pointer"
                >
                  <Plus className="h-4 w-4" />
                  <span>ثبت سند حسابداری دوبل جدید</span>
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {periods.map((p) => (
                  <div
                    key={String(p.id)}
                    className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-xs ${
                      p.status === "CLOSED"
                        ? "bg-rose-50/70 border-rose-200 text-rose-800"
                        : "bg-emerald-50/70 border-emerald-200 text-emerald-800"
                    }`}
                  >
                    {p.status === "CLOSED" && <Lock className="h-3.5 w-3.5" />}
                    <span className="font-medium">{String(p.name)}</span>
                    <button
                      type="button"
                      onClick={() => togglePeriod(String(p.id), String(p.status))}
                      className="text-[10px] underline cursor-pointer"
                    >
                      {p.status === "CLOSED" ? "بازگشایی" : "بستن دوره"}
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {showJournalForm && (
              <form onSubmit={submitJournal} className="bg-white rounded-2xl border border-emerald-200 p-5 space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">تاریخ سند شمسی (YYYY/MM/DD)</label>
                    <JalaliDatePicker
                      value={jForm.document_date_jalali}
                      onChange={(value) => setJForm({ ...jForm, document_date_jalali: value })}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">دوره مالی (تست دوره بسته!)</label>
                    <select
                      value={jForm.accounting_period_id}
                      onChange={(e) => setJForm({ ...jForm, accounting_period_id: e.target.value })}
                      className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs"
                    >
                      <option value="">انتخاب خودکار دوره باز</option>
                      {periods.map((p) => (
                        <option key={String(p.id)} value={String(p.id)}>
                          {String(p.name)} [{String(p.status)}]
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">شرح سند *</label>
                    <input
                      required
                      placeholder="مثلاً: ثبت هزینه اجاره و نگهداری انبار"
                      value={jForm.description}
                      onChange={(e) => setJForm({ ...jForm, description: e.target.value })}
                      className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="text-xs font-semibold text-slate-700">آرتیکل‌های سند (مبالغ به صورت Decimal String)</div>
                  {jForm.lines.map((line, idx) => (
                    <div key={idx} className="grid grid-cols-1 md:grid-cols-12 gap-2">
                      <select
                        required
                        value={line.account_id}
                        onChange={(e) => {
                          const next = [...jForm.lines];
                          next[idx] = { ...next[idx], account_id: e.target.value };
                          setJForm({ ...jForm, lines: next });
                        }}
                        className="md:col-span-5 rounded-xl border border-slate-200 px-3 py-2 text-xs"
                      >
                        <option value="">انتخاب حساب معین...</option>
                        {accountsList.map((a) => (
                          <option key={String(a.id)} value={String(a.id)}>
                            {String(a.code)} — {String(a.name)}
                          </option>
                        ))}
                      </select>
                      <input
                        dir="ltr"
                        placeholder="بدهکار"
                        value={line.debit}
                        onChange={(e) => {
                          const next = [...jForm.lines];
                          next[idx] = { ...next[idx], debit: e.target.value };
                          setJForm({ ...jForm, lines: next });
                        }}
                        className="md:col-span-3 rounded-xl border border-slate-200 px-3 py-2 text-xs text-left font-mono"
                      />
                      <input
                        dir="ltr"
                        placeholder="بستانکار"
                        value={line.credit}
                        onChange={(e) => {
                          const next = [...jForm.lines];
                          next[idx] = { ...next[idx], credit: e.target.value };
                          setJForm({ ...jForm, lines: next });
                        }}
                        className="md:col-span-3 rounded-xl border border-slate-200 px-3 py-2 text-xs text-left font-mono"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          if (jForm.lines.length <= 2) return;
                          setJForm({ ...jForm, lines: jForm.lines.filter((_, i) => i !== idx) });
                        }}
                        className="md:col-span-1 rounded-xl border border-slate-200 text-xs text-slate-500 hover:bg-rose-50 hover:text-rose-600 cursor-pointer"
                      >
                        حذف
                      </button>
                    </div>
                  ))}
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-100 text-xs">
                  <div className="flex items-center gap-4">
                    <span className="tabular-nums">جمع بدهکار: <strong>{formatIrr(formDebitSum)}</strong></span>
                    <span className="tabular-nums">جمع بستانکار: <strong>{formatIrr(formCreditSum)}</strong></span>
                    <span
                      className={`px-2.5 py-0.5 rounded-full font-semibold ${
                        formBalanced ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-700"
                      }`}
                    >
                      {formBalanced ? "سند تراز است ✓" : "سند تراز نیست (سرور رد می‌کند)"}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <label className="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={jForm.confirm_immediately}
                        onChange={(e) => setJForm({ ...jForm, confirm_immediately: e.target.checked })}
                      />
                      <span>قطعی‌سازی مستقیم (CONFIRMED)</span>
                    </label>
                    <button type="submit" className="rounded-xl bg-emerald-700 text-white px-5 py-2 font-medium cursor-pointer">
                      ثبت سند
                    </button>
                  </div>
                </div>
              </form>
            )}

            {/* Journal Entries Table */}
            <div className="bg-white rounded-2xl border border-slate-200 overflow-x-auto">
              <div className="px-5 py-3.5 border-b border-slate-100 flex flex-wrap items-center justify-between gap-2">
                <span className="font-bold text-xs text-slate-800">
                  دفتر روزنامه و اسناد حسابداری (سند قطعی تغییرناپذیر است؛ اصلاح فقط با سند معکوس)
                </span>
                <button
                  type="button"
                  onClick={async () => {
                    if (!orgId) return;
                    const res = await fetch("/api/v1/accounting/journal-book/export", {
                      headers: { "X-Organization-Id": orgId, "X-Client-Version": "1.0.0" },
                      credentials: "include",
                    });
                    if (!res.ok) {
                      onToast("خطا در دریافت خروجی اکسل دفتر روزنامه", "error");
                      return;
                    }
                    const blob = await res.blob();
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `journal-book-${new Date().toISOString().slice(0, 10)}.xlsx`;
                    a.click();
                    URL.revokeObjectURL(url);
                    onToast("فایل اکسل دفتر روزنامه (.xlsx) دانلود شد.");
                  }}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 px-3 py-1.5 text-[11px] font-medium cursor-pointer hover:bg-emerald-100"
                >
                  <FileSpreadsheet className="h-3.5 w-3.5" />
                  <span>خروجی اکسل دفتر روزنامه (.xlsx)</span>
                </button>
              </div>
              <table className="w-full text-xs text-right">
                <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                  <tr>
                    <th className="px-4 py-3">شماره / تاریخ</th>
                    <th className="px-4 py-3">شرح و آرتیکل‌ها</th>
                    <th className="px-4 py-3">بدهکار / بستانکار</th>
                    <th className="px-4 py-3">وضعیت تجاری</th>
                    <th className="px-4 py-3">عملیات</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {journals.map((j) => (
                    <tr key={String(j.id)} className="align-top">
                      <td className="px-4 py-3 whitespace-nowrap">
                        <div className="font-bold text-slate-900">سند #{String(j.document_number)}</div>
                        <div className="text-[11px] font-mono text-slate-400">{String(j.document_date)}</div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-medium text-slate-900 mb-1.5">{String(j.description)}</div>
                        <div className="space-y-1">
                          {((j.lines as Array<Record<string, unknown>>) ?? []).map((l) => (
                            <div key={String(l.id)} className="flex items-center justify-between text-[11px] bg-slate-50 px-2.5 py-1 rounded-lg">
                              <span>{String(l.account_code)} — {String(l.account_name)}</span>
                              <span className="font-mono tabular-nums text-slate-600">
                                {Number(l.debit) > 0 ? `بد: ${formatIrr(l.debit as string)}` : `بس: ${formatIrr(l.credit as string)}`}
                              </span>
                            </div>
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-3 font-mono tabular-nums whitespace-nowrap">
                        <div>بد: {formatIrr(j.total_debit as string)}</div>
                        <div className="text-slate-500">بس: {formatIrr(j.total_credit as string)}</div>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                            j.status === "CONFIRMED"
                              ? "bg-emerald-100 text-emerald-800"
                              : j.status === "REVERSED"
                                ? "bg-slate-200 text-slate-700"
                                : "bg-amber-100 text-amber-800"
                          }`}
                        >
                          {String(j.status)}
                        </span>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {j.status === "DRAFT" && (
                          <button
                            type="button"
                            onClick={() => confirmJournal(String(j.id))}
                            className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 text-white px-2.5 py-1 text-[11px] cursor-pointer"
                          >
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            <span>قطعی‌سازی</span>
                          </button>
                        )}
                        {j.status === "CONFIRMED" && (
                          <button
                            type="button"
                            onClick={() => reverseJournal(String(j.id))}
                            className="inline-flex items-center gap-1 rounded-lg border border-amber-300 bg-amber-50 text-amber-900 px-2.5 py-1 text-[11px] cursor-pointer"
                          >
                            <RotateCcw className="h-3.5 w-3.5" />
                            <span>سند معکوس</span>
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Trial Balance & Profit/Loss Reconstructed from Ledger */}
            {trialBalance && (
              <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-3 overflow-x-auto">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                    <FileSpreadsheet className="h-4 w-4 text-emerald-600" />
                    <span>تراز آزمایشی بازسازی‌شده مستقیم از دفتر کل (Trial Balance)</span>
                  </h3>
                  <div className="flex items-center gap-3 text-xs">
                    <span className="px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-800 font-semibold">
                      {trialBalance.is_balanced ? "تراز کل برقرار است ✓" : "نامتوازن!"}
                    </span>
                    {profitLoss && (
                      <span className="px-2.5 py-1 rounded-full bg-indigo-50 text-indigo-800 font-semibold tabular-nums">
                        سود خالص: {formatIrr((profitLoss.net_profit ?? profitLoss.netProfit) as string)} ریال
                      </span>
                    )}
                  </div>
                </div>
                <table className="w-full text-xs text-right">
                  <thead className="bg-slate-50 border-b border-slate-200">
                    <tr>
                      <th className="px-3 py-2.5">کد حساب</th>
                      <th className="px-3 py-2.5">عنوان حساب</th>
                      <th className="px-3 py-2.5">ماهیت</th>
                      <th className="px-3 py-2.5">گردش بدهکار</th>
                      <th className="px-3 py-2.5">گردش بستانکار</th>
                      <th className="px-3 py-2.5">مانده نهایی</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 tabular-nums">
                    {((trialBalance.rows as Array<Record<string, unknown>>) ?? []).map((r) => (
                      <tr key={String(r.account_id ?? r.accountId)}>
                        <td className="px-3 py-2 font-mono">{String(r.code)}</td>
                        <td className="px-3 py-2 font-medium">{String(r.name)}</td>
                        <td className="px-3 py-2 text-[11px] font-mono text-slate-500">{String(r.account_type ?? r.accountType)}</td>
                        <td className="px-3 py-2">{formatIrr((r.total_debit ?? r.totalDebit) as string)}</td>
                        <td className="px-3 py-2">{formatIrr((r.total_credit ?? r.totalCredit) as string)}</td>
                        <td className="px-3 py-2 font-semibold">{formatIrr((r.net_balance ?? r.netBalance) as string)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <AccountingParityPanel orgId={orgId} onToast={onToast} />
          </div>
        )}

        {/* 3. INVENTORY */}
        {tab === "inventory" && (
          <div className="space-y-5">
            <InventoryParityPanel orgId={orgId} onToast={onToast} />
          </div>
        )}

        {tab === "supplier_accounts" && <SupplierAccountsPanel orgId={orgId} onToast={onToast} />}

        {/* 4. CATALOG */}
        {tab === "catalog" && (
          <div className="space-y-5">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              {/* Barcode Scanner Lookup */}
              <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-3">
                <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                  <ScanBarcode className="h-4 w-4 text-indigo-600" />
                  <span>جستجوی سریع بارکد (/api/v1/products/barcode/...)</span>
                </h3>
                <div className="flex gap-2">
                  <input
                    dir="ltr"
                    value={barcodeInput}
                    onChange={(e) => setBarcodeInput(e.target.value)}
                    className="flex-1 rounded-xl border border-slate-200 px-3 py-2 text-xs font-mono text-left"
                  />
                  <button
                    type="button"
                    onClick={lookupBarcode}
                    className="rounded-xl bg-slate-900 text-white px-4 py-2 text-xs font-medium cursor-pointer"
                  >
                    استعلام بارکد
                  </button>
                </div>
                {barcodeResult && (
                  <div className="rounded-xl bg-emerald-50 border border-emerald-200 p-3 text-xs text-emerald-900">
                    <div className="font-bold">{String(barcodeResult.name)}</div>
                    <div className="mt-1 font-mono text-[11px]">
                      کد: {String(barcodeResult.code)} | فروش: {formatIrr(barcodeResult.default_sale_price as string)} ریال
                    </div>
                  </div>
                )}
              </div>

              {/* Create Product */}
              <div className="flex flex-col justify-between rounded-2xl border border-slate-200 bg-white p-5">
                <div><h3 className="text-sm font-bold text-slate-900">افزودن کالا یا خدمت</h3><p className="mt-2 text-xs leading-6 text-slate-500">فرم کامل کاتالوگ شامل نوع، واحد، دسته‌بندی، قیمت‌ها و کنترل موجودی را باز کنید.</p></div>
                <div className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-2"><button type="button" onClick={() => setShowQuickProductModal(true)} className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-700 px-4 py-2.5 text-xs font-medium text-white"><Plus className="h-4 w-4"/>افزودن سریع مطابق اپلیکیشن</button><button type="button" onClick={() => setShowProductCreateModal(true)} className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 px-4 py-2.5 text-xs font-medium text-slate-700"><Plus className="h-4 w-4"/>فرم کامل کالا / خدمت</button></div>
              </div>
              {showProductCreateModal && <div className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-950/45 p-3" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowProductCreateModal(false); }}>
                <form onSubmit={createProduct} className="max-h-[92vh] w-full max-w-2xl space-y-3 overflow-y-auto rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl">
                  <div className="flex items-start justify-between gap-3"><div><h3 className="text-sm font-bold text-slate-900">افزودن کالا یا خدمت</h3><p className="mt-1 text-[11px] text-slate-500">مشخصات فرم کاتالوگ اپلیکیشن</p></div><button type="button" onClick={() => setShowProductCreateModal(false)} className="rounded-lg px-2 py-1 text-xs text-slate-500 hover:bg-slate-100">بستن</button></div>
                  <div className="grid grid-cols-1 gap-2.5 text-xs sm:grid-cols-2">
                    <label>نوع کالا / خدمت<select className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2" value={prodForm.item_type} onChange={(e) => setProdForm({ ...prodForm, item_type: e.target.value, track_inventory: e.target.value === "SERVICE" ? false : prodForm.track_inventory })}><option value="PRODUCT">کالا</option><option value="SERVICE">خدمت</option><option value="RAW_MATERIAL">مواد اولیه</option><option value="FINISHED_PRODUCT">محصول نهایی</option></select></label>
                    <label>نام کالا / خدمت *<input required minLength={2} maxLength={180} value={prodForm.name} onChange={(e) => setProdForm({ ...prodForm, name: e.target.value })} className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2" /></label>
                    <label>کد SKU<input minLength={2} maxLength={64} value={prodForm.code} onChange={(e) => setProdForm({ ...prodForm, code: e.target.value })} placeholder="اختیاری؛ در صورت خالی بودن خودکار ساخته می‌شود" className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2" /></label>
                    <label>بارکد<input dir="ltr" value={prodForm.barcode} onChange={(e) => setProdForm({ ...prodForm, barcode: e.target.value })} className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-left" /></label>
                    <label>دسته‌بندی<select className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2" value={prodForm.category_id} onChange={(e) => setProdForm({ ...prodForm, category_id: e.target.value })}><option value="">بدون دسته‌بندی</option>{catalogMeta.categories.map((item) => <option key={String(item.id)} value={String(item.id)}>{String(item.name)}</option>)}</select></label>
                    <label>برند<select className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2" value={prodForm.brand_id} onChange={(e) => setProdForm({ ...prodForm, brand_id: e.target.value })}><option value="">بدون برند</option>{catalogMeta.brands.map((item) => <option key={String(item.id)} value={String(item.id)}>{String(item.name)}</option>)}</select></label>
                    <label>واحد اصلی *<select required className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2" value={prodForm.base_unit_id} onChange={(e) => setProdForm({ ...prodForm, base_unit_id: e.target.value })}><option value="">انتخاب واحد</option>{catalogMeta.units.map((item) => <option key={String(item.id)} value={String(item.id)}>{String(item.name)}</option>)}</select></label>
                    <label>نرخ مالیات (%)<input dir="ltr" inputMode="decimal" value={prodForm.tax_rate} onChange={(e) => setProdForm({ ...prodForm, tax_rate: e.target.value })} className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-left" /></label>
                    <label>قیمت خرید (ریال)<input dir="ltr" inputMode="decimal" value={prodForm.purchase_price} onChange={(e) => setProdForm({ ...prodForm, purchase_price: e.target.value })} className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-left" /></label>
                    <label>قیمت فروش (ریال)<input dir="ltr" inputMode="decimal" value={prodForm.sale_price} onChange={(e) => setProdForm({ ...prodForm, sale_price: e.target.value })} className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-left" /></label>
                    {prodForm.item_type !== "SERVICE" && <><label>حداقل موجودی<input dir="ltr" inputMode="decimal" value={prodForm.minimum_stock} onChange={(e) => setProdForm({ ...prodForm, minimum_stock: e.target.value })} className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-left" /></label><label>حداکثر موجودی<input dir="ltr" inputMode="decimal" value={prodForm.maximum_stock} onChange={(e) => setProdForm({ ...prodForm, maximum_stock: e.target.value })} className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-left" /></label></>}
                    <label className="col-span-full">توضیحات<textarea rows={3} value={prodForm.description} onChange={(e) => setProdForm({ ...prodForm, description: e.target.value })} className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2" /></label>
                  </div>
                  {prodForm.item_type !== "SERVICE" && <div className="grid gap-2 rounded-xl bg-slate-50 p-3 text-xs sm:grid-cols-2"><label className="flex items-center gap-2"><input type="checkbox" checked={prodForm.track_inventory} onChange={(e) => setProdForm({ ...prodForm, track_inventory: e.target.checked })}/>کنترل موجودی انبار</label><label className="flex items-center gap-2"><input type="checkbox" checked={prodForm.allow_negative_stock} onChange={(e) => setProdForm({ ...prodForm, allow_negative_stock: e.target.checked })}/>اجازه موجودی منفی در فروش آفلاین</label></div>}
                  <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={prodForm.is_active} onChange={(e) => setProdForm({ ...prodForm, is_active: e.target.checked })}/>فعال</label>
                  <button type="submit" disabled={!prodForm.base_unit_id} className="w-full rounded-xl bg-emerald-700 py-2.5 text-xs font-medium text-white disabled:opacity-50">ثبت در کاتالوگ</button>
                </form>
              </div>}
            </div>

            {showQuickProductModal && <QuickAddProductModal organizationId={orgId} onClose={() => setShowQuickProductModal(false)} onToast={onToast} onCreated={(product) => {
              setProductsList((current) => [product, ...current.filter((item) => String(item.id) !== String(product.id))]);
              void loadTab("catalog");
            }} />}
            <div className="bg-white rounded-2xl border border-slate-200 overflow-x-auto">
              <table className="w-full text-xs text-right">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th className="px-4 py-3">کد / بارکد</th>
                    <th className="px-4 py-3">نام کالا</th>
                    <th className="px-4 py-3">دسته / برند</th>
                    <th className="px-4 py-3">قیمت خرید / فروش (ریال)</th>
                    <th className="px-4 py-3">موجودی کل (Ledger)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 tabular-nums">
                  {productsList.map((p) => (
                    <tr key={String(p.id)}>
                      <td className="px-4 py-3 font-mono text-[11px]">
                        <div className="font-semibold text-slate-900">{String(p.code)}</div>
                        <div className="text-slate-400">{String(p.barcode || "—")}</div>
                      </td>
                      <td className="px-4 py-3 font-medium text-slate-900">{String(p.name)}</td>
                      <td className="px-4 py-3 text-slate-500">
                        {String(p.category_name || "—")} / {String(p.brand_name || "—")}
                      </td>
                      <td className="px-4 py-3">
                        <div>فروش: <strong>{formatIrr(p.sale_price as string)}</strong></div>
                        <div className="text-[11px] text-slate-400">خرید: {formatIrr(p.purchase_price as string)}</div>
                      </td>
                      <td className="px-4 py-3 font-bold text-teal-700">
                        {formatQty(p.total_on_hand_qty as string)} {String(p.unit_name)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* 5. CONTACTS */}
        {tab === "contacts" && (
          <div className="space-y-5">
            <form onSubmit={createContact} className="bg-white rounded-2xl border border-slate-200 p-5 grid grid-cols-1 md:grid-cols-5 gap-3 text-xs">
              <input
                required
                placeholder="کد شخص (مثلاً C-1099)"
                value={contactForm.code}
                onChange={(e) => setContactForm({ ...contactForm, code: e.target.value })}
                className="rounded-xl border border-slate-200 px-3 py-2"
              />
              <input
                required
                placeholder="نام نمایشی طرف‌حساب"
                value={contactForm.display_name}
                onChange={(e) => setContactForm({ ...contactForm, display_name: e.target.value })}
                className="rounded-xl border border-slate-200 px-3 py-2"
              />
              <select
                value={contactForm.type}
                onChange={(e) => setContactForm({ ...contactForm, type: e.target.value })}
                className="rounded-xl border border-slate-200 px-3 py-2"
              >
                <option value="CUSTOMER">مشتری (CUSTOMER)</option>
                <option value="SUPPLIER">تأمین‌کننده (SUPPLIER)</option>
                <option value="BOTH">هر دو (BOTH)</option>
                <option value="EMPLOYEE">پرسنل (EMPLOYEE)</option>
              </select>
              <input
                dir="ltr"
                placeholder="0912..."
                value={contactForm.mobile}
                onChange={(e) => setContactForm({ ...contactForm, mobile: e.target.value })}
                className="rounded-xl border border-slate-200 px-3 py-2 font-mono text-left"
              />
              <button type="submit" className="rounded-xl bg-emerald-700 text-white py-2 font-medium cursor-pointer">
                ثبت طرف‌حساب
              </button>
            </form>

            <div className="bg-white rounded-2xl border border-slate-200 overflow-x-auto">
              <table className="w-full text-xs text-right">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th className="px-4 py-3">کد</th>
                    <th className="px-4 py-3">نام طرف‌حساب</th>
                    <th className="px-4 py-3">نوع / گروه</th>
                    <th className="px-4 py-3">موبایل</th>
                    <th className="px-4 py-3">مانده جاری (ریال)</th>
                    <th className="px-4 py-3">نسخه Sync</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 tabular-nums">
                  {contactsList.map((c) => (
                    <tr key={String(c.id)}>
                      <td className="px-4 py-3 font-mono">{String(c.code)}</td>
                      <td className="px-4 py-3 font-semibold text-slate-900">{String(c.display_name)}</td>
                      <td className="px-4 py-3 text-[11px]">
                        {String(c.type)} {c.group_name ? `• ${String(c.group_name)}` : ""}
                      </td>
                      <td className="px-4 py-3 font-mono">{String(c.mobile || "—")}</td>
                      <td className="px-4 py-3 font-bold">{formatIrr(c.running_balance as string)}</td>
                      <td className="px-4 py-3 font-mono text-slate-400">v{String(c.version)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* 6. COMMERCE (SALES & PURCHASING) */}
        {tab === "commerce" && (
          <div className="space-y-5">
            <SalesInvoiceComposer orgId={orgId} onToast={onToast} onRefresh={() => loadTab("commerce")} />
            <CommerceParityPanel orgId={orgId} contacts={contactsList} products={productsList} warehouses={warehousesList} sales={salesList} purchases={purchasesList} onToast={onToast} onRefresh={() => loadTab("commerce")} />

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              <div className="bg-white rounded-2xl border border-slate-200 p-5">
                <h3 className="text-sm font-bold text-slate-900 mb-3">فاکتورهای فروش (/api/v1/sales)</h3>
                <div className="space-y-2.5 text-xs">
                  {salesList.map((inv) => (
                    <div key={String(inv.id)} className="rounded-xl border border-slate-200 p-3.5 flex items-center justify-between gap-2">
                      <div>
                        <div className="font-bold text-slate-900">
                          {String(inv.document_number)} — {String(inv.customer_name)}
                        </div>
                        <div className="text-slate-500 mt-0.5 tabular-nums">
                          {formatIrr(inv.grand_total as string)} ریال • {String(inv.warehouse_name)}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${inv.status === "CONFIRMED" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`}>
                          {String(inv.status)}
                        </span>
                        {inv.status === "DRAFT" && (
                          <button
                            type="button"
                            onClick={() => confirmInvoice("sales", String(inv.id))}
                            className="rounded-lg bg-emerald-600 text-white px-2.5 py-1 text-[11px] cursor-pointer"
                          >
                            تایید اتمیک
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-white rounded-2xl border border-slate-200 p-5">
                <h3 className="text-sm font-bold text-slate-900 mb-3">فاکتورهای خرید (/api/v1/purchases)</h3>
                <div className="space-y-2.5 text-xs">
                  {purchasesList.map((inv) => (
                    <div key={String(inv.id)} className="rounded-xl border border-slate-200 p-3.5 flex items-center justify-between gap-2">
                      <div>
                        <div className="font-bold text-slate-900">
                          {String(inv.document_number)} — {String(inv.supplier_name)}
                        </div>
                        <div className="text-slate-500 mt-0.5 tabular-nums">
                          {formatIrr(inv.grand_total as string)} ریال • {String(inv.warehouse_name)}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${inv.status === "CONFIRMED" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`}>
                          {String(inv.status)}
                        </span>
                        {inv.status === "DRAFT" && (
                          <button
                            type="button"
                            onClick={() => confirmInvoice("purchases", String(inv.id))}
                            className="rounded-lg bg-indigo-600 text-white px-2.5 py-1 text-[11px] cursor-pointer"
                          >
                            تایید و ورود انبار
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

          </div>
        )}

        {/* 7. TREASURY, CHEQUES & CONSIGNMENTS */}
        {tab === "treasury" && (
          <div className="space-y-5">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {treasuryAccounts.map((fa) => (
                <div key={String(fa.id)} className="bg-white rounded-2xl border border-slate-200 p-4 flex items-center justify-between">
                  <div>
                    <div className="font-bold text-sm text-slate-900">{String(fa.name)}</div>
                    <div className="text-xs text-slate-400 font-mono mt-0.5">{String(fa.account_type)} • {String(fa.iban || "صندوق نقدی")}</div>
                  </div>
                  <div className="text-lg font-bold text-emerald-700 tabular-nums">
                    {formatIrr(fa.balance as string)} <span className="text-xs font-normal text-slate-500">ریال</span>
                  </div>
                </div>
              ))}
            </div>

            <form onSubmit={recordTreasuryTx} className="bg-white rounded-2xl border border-slate-200 p-5 grid grid-cols-1 md:grid-cols-6 gap-3 text-xs">
              <select
                value={txForm.kind}
                onChange={(e) => setTxForm({ ...txForm, kind: e.target.value as "receipts" | "payments" })}
                className="rounded-xl border border-slate-200 px-3 py-2"
              >
                <option value="receipts">دریافت وجه (RECEIPT)</option>
                <option value="payments">پرداخت وجه (PAYMENT)</option>
              </select>
              <select
                value={txForm.account_id}
                onChange={(e) => setTxForm({ ...txForm, account_id: e.target.value })}
                className="rounded-xl border border-slate-200 px-3 py-2"
              >
                {treasuryAccounts.map((a) => (
                  <option key={String(a.id)} value={String(a.id)}>{String(a.name)}</option>
                ))}
              </select>
              <input
                dir="ltr"
                value={txForm.amount}
                onChange={(e) => setTxForm({ ...txForm, amount: e.target.value })}
                className="rounded-xl border border-slate-200 px-3 py-2 font-mono text-left"
              />
              <input
                value={txForm.description}
                onChange={(e) => setTxForm({ ...txForm, description: e.target.value })}
                className="rounded-xl border border-slate-200 px-3 py-2"
              />
              <label className="text-[11px]">تاریخ تراکنش شمسی<JalaliDatePicker className="mt-1" value={txForm.transaction_date_jalali} onChange={(value) => setTxForm({ ...txForm, transaction_date_jalali: value })}/></label>
              <button type="submit" className="rounded-xl bg-emerald-700 text-white py-2 font-medium cursor-pointer">
                ثبت تراکنش خزانه ({treasuryTxs.length})
              </button>
            </form>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-3">
                <h3 className="text-sm font-bold text-slate-900">مدیریت چک‌ها و رویدادها (/api/v1/cheques)</h3>
                {chequesList.map((ch) => (
                  <div key={String(ch.id)} className="rounded-xl border border-slate-200 p-3.5 text-xs space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="font-bold">{String(ch.bank_name)} — {String(ch.cheque_number)}</span>
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-indigo-50 text-indigo-700">
                        {String(ch.status)}
                      </span>
                    </div>
                    <div className="text-slate-600 tabular-nums">
                      مبلغ: <strong>{formatIrr(ch.amount as string)}</strong> ریال • سررسید: {String(ch.due_date)}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <button type="button" onClick={() => transitionCheque(String(ch.id), "deposit")} className="rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] hover:bg-slate-50 cursor-pointer">واگذاری به بانک</button>
                      <button type="button" onClick={() => transitionCheque(String(ch.id), "cash")} className="rounded-lg bg-emerald-600 text-white px-2.5 py-1 text-[11px] cursor-pointer">پاس شد (CASHED)</button>
                      <button type="button" onClick={() => transitionCheque(String(ch.id), "bounce")} className="rounded-lg bg-rose-600 text-white px-2.5 py-1 text-[11px] cursor-pointer">برگشت خورد (BOUNCED)</button>
                    </div>
                  </div>
                ))}
              </div>

              <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-3">
                <h3 className="text-sm font-bold text-slate-900">کالاهای امانی و تسویه (/api/v1/consignments)</h3>
                {consignmentsList.map((cd) => (
                  <div key={String(cd.id)} className="rounded-xl border border-slate-200 p-3.5 text-xs space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="font-bold">{String(cd.document_number)} — {String(cd.contact_name)}</span>
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-teal-50 text-teal-800">{String(cd.status)}</span>
                    </div>
                    <div className="text-slate-600 tabular-nums">
                      ارزش کل: {formatIrr(cd.total_value as string)} ریال • نرخ کارمزد: {String(cd.commission_rate)}٪
                    </div>
                    {cd.status !== "SETTLED" && (
                      <div className="flex flex-wrap items-end gap-2">
                        <label className="text-[11px]">فروش واقعیِ تحقق‌یافته
                          <input className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-left" dir="ltr" inputMode="decimal" value={consignmentSales[String(cd.id)] ?? ""} onChange={(event) => setConsignmentSales((current) => ({ ...current, [String(cd.id)]: event.target.value }))} />
                        </label>
                        <button type="button" onClick={() => void settleConsignment(String(cd.id), consignmentSales[String(cd.id)] ?? "")} className="rounded-lg bg-teal-700 text-white px-3 py-2 text-[11px] cursor-pointer">ثبت تسویه واقعی</button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
            <TreasuryParityPanel orgId={orgId} onToast={onToast} />
          </div>
        )}

        {/* 8. SUBSCRIPTION & CAFEBAZAAR */}
        {tab === "subscription" && (
          <div className="space-y-5">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-3 text-xs">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-bold text-slate-900">وضعیت اشتراک و Entitlement سمت سرور</h3>
                  <span className={`px-2.5 py-0.5 rounded-full font-semibold ${isExpired ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-800"}`}>
                    {String(subCurrent?.status ?? "—")} ({String(subCurrent?.plan_code ?? "")})
                  </span>
                </div>
                <div className="text-slate-500">
                  انقضا: {formatDateFa((subCurrent?.subscription as Record<string, unknown>)?.expires_at as string)}
                </div>
                <div className="grid grid-cols-2 gap-2 pt-2">
                  {Object.entries((subCurrent?.entitlements as Record<string, { enabled: boolean; limit_value: number | null }>) ?? {}).map(
                    ([code, ent]) => (
                      <div key={code} className="rounded-xl bg-slate-50 border border-slate-100 px-3 py-2 flex items-center justify-between">
                        <span className="font-mono text-[11px]">{code}</span>
                        <span className={ent.enabled ? "text-emerald-700 font-bold" : "text-slate-400"}>
                          {ent.enabled ? (ent.limit_value ? `تا ${ent.limit_value}` : "فعال") : "قفل"}
                        </span>
                      </div>
                    )
                  )}
                </div>
                <button
                  type="button"
                  onClick={exportAllData}
                  className="w-full mt-2 inline-flex items-center justify-center gap-2 rounded-xl border border-slate-300 bg-slate-50 hover:bg-slate-100 py-2 font-medium text-slate-800 cursor-pointer"
                >
                  <Download className="h-4 w-4" />
                  <span>خروجی کامل داده‌های سازمان (همیشه آزاد حتی پس از انقضا)</span>
                </button>
              </div>

              <form onSubmit={verifyCafeBazaar} className="bg-white rounded-2xl border border-slate-200 p-5 space-y-3 text-xs">
                <h3 className="text-sm font-bold text-slate-900">اعتبارسنجی رسمی رسید کافه‌بازار (/api/v1/subscription/market/verify)</h3>
                <p className="text-slate-500 leading-relaxed">
                  توکن خرید صادرشده از رسید رسمی کافه‌بازار را وارد کنید؛ توکن ساختگی یا تکراری پذیرفته نمی‌شود.
                </p>
                <div>
                  <label className="block text-slate-700 mb-1">شناسه محصول (SKU)</label>
                  <select
                    value={cbzForm.sku}
                    onChange={(e) => setCbzForm({ ...cbzForm, sku: e.target.value })}
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 font-mono"
                  >
                    {subPlans.map((p) => (
                      <option key={String(p.id)} value={String(p.cafebazaar_sku)}>
                        {String(p.name_fa)} — {String(p.cafebazaar_sku)}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-slate-700 mb-1">Purchase Token کافه‌بازار</label>
                  <input
                    dir="ltr"
                    required
                    value={cbzForm.purchase_token}
                    onChange={(e) => setCbzForm({ ...cbzForm, purchase_token: e.target.value })}
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 font-mono text-left"
                  />
                </div>
                <button type="submit" className="w-full rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white py-2 font-medium cursor-pointer">
                  تایید رسید در سرور و فعال‌سازی اشتراک
                </button>
              </form>
            </div>
          </div>
        )}

        {/* 9. OFFLINE ANDROID BIDIRECTIONAL SYNC ENGINE (MASTER PROMPT 04) */}
        {tab === "sync" && (
          <div className="space-y-5">
            {syncStatus && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                <div className="bg-white rounded-2xl border border-slate-200 p-4">
                  <div className="text-slate-500">ترتیب Change Log سرور</div>
                  <div className="text-lg font-bold font-mono mt-1">#{String(syncStatus.server_head_seq)}</div>
                  <div className="text-[10px] font-mono text-slate-400 truncate mt-1" dir="ltr">
                    {String(syncStatus.server_head_cursor || "")}
                  </div>
                </div>
                <div className="bg-white rounded-2xl border border-slate-200 p-4">
                  <div className="text-slate-500">تعارض‌های باز</div>
                  <div className="text-lg font-bold text-amber-700 mt-1">{String(syncStatus.open_conflicts_count)}</div>
                  <div className="text-[11px] text-slate-400 mt-1">بررسی دامنه‌محور بدون LWW</div>
                </div>
                <div className="bg-white rounded-2xl border border-slate-200 p-4">
                  <div className="text-slate-500">تازگی داده (UTC)</div>
                  <div className="text-xs font-semibold text-emerald-700 mt-2">
                    {formatDateTimeFa(syncStatus.server_time_utc as string)}
                  </div>
                  <div className="text-[11px] text-slate-400 mt-1">وضعیت Sync مستقل از تجاری</div>
                </div>
                <div className="bg-white rounded-2xl border border-slate-200 p-4 flex flex-col justify-between">
                  <div className="text-slate-500">بازیابی Cursor</div>
                  <button
                    type="button"
                    onClick={triggerProtectedResetCheckpoint}
                    className="mt-2 rounded-xl border border-slate-300 bg-slate-50 hover:bg-slate-100 px-3 py-1.5 text-[11px] font-medium cursor-pointer"
                  >
                    Reset Checkpoint (ایمن)
                  </button>
                </div>
              </div>
            )}

            <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-3">
              <div>
                <h3 className="text-sm font-bold text-slate-900">همگام‌سازی واقعی دستگاه‌ها</h3>
                <p className="text-xs text-slate-500 mt-0.5">رویدادها و تعارض‌های ثبت‌شدهٔ دستگاه‌های متصل در ادامه نمایش داده می‌شوند.</p>
              </div>
              <button type="button" onClick={simulateOfflinePullAndAck} className="rounded-xl bg-slate-900 text-white px-3.5 py-2 text-xs font-medium cursor-pointer">دریافت تغییرهای سرور و تأیید Cursor</button>
            </div>

            {pullOutput && (
              <div className="bg-slate-950 text-slate-100 rounded-2xl p-4 text-xs font-mono space-y-1">
                <div className="text-emerald-400">
                  GET /api/v1/sync/pull — next_cursor: {String(pullOutput.next_cursor)} | has_more: {String(pullOutput.has_more)}
                </div>
                <pre dir="ltr" className="overflow-x-auto max-h-56 text-left">
                  {JSON.stringify(((pullOutput.changes as unknown[]) ?? []).slice(0, 6), null, 2)}
                </pre>
              </div>
            )}

            <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-3">
              <h3 className="text-sm font-bold text-slate-900">تعارض‌های همگام‌سازی سازمان (Domain-Based Conflict Resolver)</h3>
              {(((syncData?.conflicts as Array<Record<string, unknown>>) ?? [])).map((c) => {
                const allowed = (c.allowed_resolutions as string[]) ?? ["USE_SERVER"];
                const statusVal = String(c.resolution_status || c.status || "OPEN");
                return (
                  <div key={String(c.id)} className="rounded-xl border border-slate-200 p-4 text-xs space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-bold">
                        {String(c.entity_type)} ({String(c.conflict_type)}) — دستگاه: {String(c.device_name)} (سرور v{String(c.server_version)} ↔ محلی v{String(c.local_version)})
                      </span>
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${statusVal === "OPEN" ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-700"}`}>
                        {statusVal} {c.resolution ? `(${String(c.resolution)})` : ""}
                      </span>
                    </div>
                    {Array.isArray(c.conflicting_fields) && c.conflicting_fields.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                        <span className="text-slate-500">فیلدهای متعارض:</span>
                        {(c.conflicting_fields as string[]).map((f) => (
                          <span key={f} className="font-mono bg-rose-50 text-rose-700 border border-rose-200 px-2 py-0.5 rounded-md">
                            {f}
                          </span>
                        ))}
                      </div>
                    )}
                    {statusVal === "OPEN" && (
                      <div className="flex flex-wrap gap-2 justify-end pt-1">
                        {allowed.includes("USE_SERVER") && (
                          <button type="button" onClick={() => resolveOrgConflict(String(c.id), "USE_SERVER")} className="rounded-lg border border-slate-300 px-3 py-1 cursor-pointer">
                            USE_SERVER
                          </button>
                        )}
                        {allowed.includes("MERGE") && (
                          <button type="button" onClick={() => resolveOrgConflict(String(c.id), "MERGE")} className="rounded-lg bg-indigo-50 text-indigo-700 border border-indigo-200 px-3 py-1 cursor-pointer">
                            MERGE
                          </button>
                        )}
                        {allowed.includes("USE_LOCAL") && (
                          <button type="button" onClick={() => resolveOrgConflict(String(c.id), "USE_LOCAL")} className="rounded-lg bg-emerald-700 text-white px-3 py-1 cursor-pointer">
                            USE_LOCAL
                          </button>
                        )}
                        {allowed.includes("RECREATE_AS_NEW") && (
                          <button type="button" onClick={() => resolveOrgConflict(String(c.id), "RECREATE_AS_NEW")} className="rounded-lg border border-teal-300 bg-teal-50 text-teal-800 px-3 py-1 cursor-pointer">
                            RECREATE_AS_NEW
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {syncStatus && (
              <div className="bg-white rounded-2xl border border-slate-200 p-5 overflow-x-auto">
                <h3 className="text-sm font-bold text-slate-900 mb-3">تله‌متری و گزارش Sync دستگاه‌ها (sync_logs)</h3>
                <table className="w-full text-xs text-right">
                  <thead className="bg-slate-50 border-b border-slate-200">
                    <tr>
                      <th className="px-3 py-2">دستگاه</th>
                      <th className="px-3 py-2">جهت</th>
                      <th className="px-3 py-2">Push / Pull</th>
                      <th className="px-3 py-2">موفق / خطا / تعارض</th>
                      <th className="px-3 py-2">مدت (ms)</th>
                      <th className="px-3 py-2">زمان</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 tabular-nums">
                    {(((syncStatus.sync_logs as Array<Record<string, unknown>>) ?? [])).map((l) => (
                      <tr key={String(l.sync_id)}>
                        <td className="px-3 py-2 font-medium">{String(l.device_name)}</td>
                        <td className="px-3 py-2 font-mono text-[11px]">{String(l.direction)}</td>
                        <td className="px-3 py-2 font-mono">{String(l.push_count)} / {String(l.pull_count)}</td>
                        <td className="px-3 py-2 font-mono">
                          {String(l.success_count)} / {String(l.failure_count)} / {String(l.conflict_count)}
                        </td>
                        <td className="px-3 py-2 font-mono">{String(l.duration_ms)} ms</td>
                        <td className="px-3 py-2 text-slate-400">{formatDateTimeFa(l.started_at as string)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

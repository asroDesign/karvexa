"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { apiFetch, formatIrr, formatQty } from "@/lib/format";
import { currentJalaliDate, gregorianIsoToJalali } from "@/lib/jalali";
import { JalaliDatePicker } from "@/components/JalaliDatePicker";

type Row = Record<string, unknown>;
type Toast = (message: string, type?: "success" | "error") => void;

const text = (value: unknown, fallback = "") => (value === null || value === undefined ? fallback : String(value));
const rows = (value: unknown): Row[] => (Array.isArray(value) ? (value as Row[]) : []);
const field = "w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs";
const button = "rounded-xl bg-emerald-700 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-800 disabled:opacity-50";
const card = "rounded-2xl border border-slate-200 bg-white p-5";
const today = () => new Date().toISOString().slice(0, 10);
const jalaliToday = () => currentJalaliDate();

async function downloadReport(url: string, organizationId: string, fileName: string, toast: Toast) {
  try {
    const response = await fetch(url, {
      credentials: "include",
      headers: { "X-Organization-Id": organizationId, "X-Client-Version": "1.0.0" },
    });
    if (!response.ok) throw new Error("خروجی از سرور دریافت نشد.");
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(objectUrl);
    toast("فایل گزارش دریافت شد.");
  } catch (error) {
    toast(error instanceof Error ? error.message : "خطا در دریافت فایل", "error");
  }
}

export function AccountingParityPanel({ orgId, onToast }: { orgId: string | null; onToast: Toast }) {
  const [balance, setBalance] = useState<Row | null>(null);
  const [cashFlow, setCashFlow] = useState<Row | null>(null);
  const [accounts, setAccounts] = useState<Row[]>([]);
  const [centers, setCenters] = useState<Row[]>([]);
  const [selectedAccount, setSelectedAccount] = useState("");
  const [statement, setStatement] = useState<Row[]>([]);
  const [selectedCenter, setSelectedCenter] = useState("");
  const [centerReport, setCenterReport] = useState<Row | null>(null);
  const [centerForm, setCenterForm] = useState({ code: "", name: "", type: "DEPARTMENT" });
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    if (!orgId) return;
    setBusy(true);
    try {
      const [bs, cf, accountRes, cc] = await Promise.all([
        apiFetch<Row>("/api/v1/accounting/balance-sheet", { organizationId: orgId }),
        apiFetch<Row>("/api/v1/reports/cash-flow", { organizationId: orgId }),
        apiFetch<{ accounts: Row[] }>("/api/v1/accounting/accounts", { organizationId: orgId }),
        apiFetch<Row[]>("/api/v1/accounting/cost-centers", { organizationId: orgId }),
      ]);
      setBalance(bs);
      setCashFlow(cf);
      setAccounts(rows(accountRes.accounts));
      setCenters(rows(cc));
      setSelectedAccount((current) => current || text(accountRes.accounts?.[0]?.id));
      setSelectedCenter((current) => current || text(cc[0]?.id));
    } catch (error) {
      onToast(error instanceof Error ? error.message : "دریافت گزارش‌های تکمیلی حسابداری ناموفق بود", "error");
    } finally {
      setBusy(false);
    }
  }, [orgId, onToast]);

  useEffect(() => { void reload(); }, [reload]);

  useEffect(() => {
    if (!orgId || !selectedAccount) { setStatement([]); return; }
    apiFetch<Row>(`/api/v1/accounting/account-statement?account_id=${encodeURIComponent(selectedAccount)}`, { organizationId: orgId })
      .then((res) => setStatement(rows(res.movements)))
      .catch((error: unknown) => onToast(error instanceof Error ? error.message : "دریافت گردش حساب ناموفق بود", "error"));
  }, [orgId, selectedAccount, onToast]);

  useEffect(() => {
    if (!orgId || !selectedCenter) { setCenterReport(null); return; }
    apiFetch<Row>(`/api/v1/accounting/cost-centers/${encodeURIComponent(selectedCenter)}/profit-loss`, { organizationId: orgId })
      .then(setCenterReport)
      .catch((error: unknown) => onToast(error instanceof Error ? error.message : "دریافت گزارش مرکز هزینه ناموفق بود", "error"));
  }, [orgId, selectedCenter, onToast]);

  async function createCenter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!orgId) return;
    try {
      await apiFetch("/api/v1/accounting/cost-centers", {
        method: "POST", organizationId: orgId,
        body: JSON.stringify({ ...centerForm, is_active: true }),
      });
      setCenterForm({ code: "", name: "", type: "DEPARTMENT" });
      onToast("مرکز هزینه ثبت شد.");
      await reload();
    } catch (error) { onToast(error instanceof Error ? error.message : "ثبت مرکز هزینه ناموفق بود", "error"); }
  }

  const assets = rows(balance?.assets);
  const liabilities = rows(balance?.liabilities);
  const equity = rows(balance?.equity);
  const movementValue = (item: Row, camel: string, snake: string) => text(item[camel] ?? item[snake]);

  return (
    <section className="space-y-4 border-t border-slate-200 pt-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><h3 className="text-sm font-bold text-slate-900">گزارش‌های تکمیلی دفتر کل</h3><p className="mt-1 text-xs text-slate-500">صورت وضعیت مالی، جریان نقد، گردش تفصیلی و مراکز هزینه</p></div>
        <div className="flex gap-2">
          <button type="button" onClick={() => void reload()} className="rounded-xl border border-slate-200 px-3 py-2 text-xs">{busy ? "در حال بروزرسانی…" : "بروزرسانی گزارش‌ها"}</button>
          {orgId && <button type="button" onClick={() => void downloadReport("/api/v1/accounting/journal-book/export", orgId, `journal-book-${today()}.xlsx`, onToast)} className={button}>خروجی دفتر روزنامه</button>}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div className={`${card} space-y-3`}>
          <h4 className="text-xs font-bold">صورت وضعیت مالی</h4>
          <div className="grid grid-cols-3 gap-2 text-xs">
            <div className="rounded-xl bg-emerald-50 p-3"><div className="text-slate-500">دارایی</div><strong className="mt-1 block">{formatIrr(text(balance?.totalAssets ?? balance?.total_assets))} ریال</strong></div>
            <div className="rounded-xl bg-amber-50 p-3"><div className="text-slate-500">بدهی</div><strong className="mt-1 block">{formatIrr(text(balance?.totalLiabilities ?? balance?.total_liabilities))} ریال</strong></div>
            <div className="rounded-xl bg-indigo-50 p-3"><div className="text-slate-500">حقوق مالکانه</div><strong className="mt-1 block">{formatIrr(text(balance?.totalEquity ?? balance?.total_equity))} ریال</strong></div>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3 text-xs">
            {[["دارایی‌ها", assets], ["بدهی‌ها", liabilities], ["حقوق مالکانه", equity]].map(([title, values]) => (
              <div key={String(title)} className="space-y-1"><div className="font-semibold text-slate-600">{String(title)}</div>{(values as Row[]).slice(0, 5).map((item) => <div key={text(item.account_id ?? item.accountId ?? item.id)} className="flex justify-between gap-2 border-b border-slate-100 py-1"><span className="truncate">{text(item.name ?? item.account_name)}</span><span className="shrink-0 tabular-nums">{formatIrr(text(item.netBalance ?? item.net_balance ?? item.balance))}</span></div>)}</div>
            ))}
          </div>
        </div>
        <div className={`${card} space-y-3`}>
          <h4 className="text-xs font-bold">جریان نقدی</h4>
          <div className="grid grid-cols-3 gap-2 text-xs">
            <div className="rounded-xl bg-emerald-50 p-3"><div className="text-slate-500">ورودی</div><strong className="mt-1 block">{formatIrr(text(cashFlow?.total_inflow))}</strong></div>
            <div className="rounded-xl bg-rose-50 p-3"><div className="text-slate-500">خروجی</div><strong className="mt-1 block">{formatIrr(text(cashFlow?.total_outflow))}</strong></div>
            <div className="rounded-xl bg-slate-100 p-3"><div className="text-slate-500">خالص</div><strong className="mt-1 block">{formatIrr(text(cashFlow?.net_cash_flow))}</strong></div>
          </div>
          <label className="block text-xs font-medium">گردش حساب معین
            <select className={`${field} mt-1`} value={selectedAccount} onChange={(event) => setSelectedAccount(event.target.value)}>
              {accounts.map((item) => <option key={text(item.id)} value={text(item.id)}>{text(item.code)} — {text(item.name)}</option>)}
            </select>
          </label>
          <div className="max-h-40 overflow-auto rounded-xl border border-slate-100">
            {statement.length ? statement.slice(0, 30).map((item, index) => <div key={text(item.id, String(index))} className="flex flex-wrap justify-between gap-2 border-b border-slate-100 px-3 py-2 text-[11px]"><span>{movementValue(item, "entryDate", "entry_date")} • {text(item.lineDescription ?? item.entryDescription ?? item.description)}</span><span className="tabular-nums">بد {formatIrr(text(item.debit))} / بس {formatIrr(text(item.credit))}</span></div>) : <div className="p-3 text-xs text-slate-500">گردشی برای این حساب ثبت نشده است.</div>}
          </div>
        </div>
      </div>
      <div className={`${card} grid grid-cols-1 gap-4 lg:grid-cols-[1fr_1.4fr]`}>
        <form onSubmit={createCenter} className="space-y-2">
          <h4 className="text-xs font-bold">تعریف مرکز هزینه</h4>
          <div className="grid grid-cols-2 gap-2"><input className={field} required minLength={2} placeholder="کد" value={centerForm.code} onChange={(event) => setCenterForm({ ...centerForm, code: event.target.value })}/><input className={field} required minLength={2} placeholder="عنوان" value={centerForm.name} onChange={(event) => setCenterForm({ ...centerForm, name: event.target.value })}/></div>
          <div className="flex gap-2"><select className={field} value={centerForm.type} onChange={(event) => setCenterForm({ ...centerForm, type: event.target.value })}><option value="DEPARTMENT">واحد</option><option value="BRANCH">شعبه</option><option value="PROJECT">پروژه</option><option value="PRODUCT_LINE">خط محصول</option><option value="GENERAL">عمومی</option></select><button className={button}>ثبت مرکز هزینه</button></div>
        </form>
        <div className="space-y-2">
          <label className="block text-xs font-medium">گزارش سود و زیان مرکز هزینه<select className={`${field} mt-1`} value={selectedCenter} onChange={(event) => setSelectedCenter(event.target.value)}><option value="">انتخاب مرکز هزینه</option>{centers.map((item) => <option key={text(item.id)} value={text(item.id)}>{text(item.code)} — {text(item.name)}</option>)}</select></label>
          {centerReport && <div className="grid grid-cols-3 gap-2 text-xs"><div className="rounded-xl bg-emerald-50 p-3">درآمد <strong className="block mt-1">{formatIrr(text(centerReport.total_revenue))}</strong></div><div className="rounded-xl bg-rose-50 p-3">هزینه <strong className="block mt-1">{formatIrr(text(centerReport.total_expense))}</strong></div><div className="rounded-xl bg-indigo-50 p-3">سود خالص <strong className="block mt-1">{formatIrr(text(centerReport.net_profit))}</strong></div></div>}
        </div>
      </div>
    </section>
  );
}

type ProductLine = { product_id: string; variant_id: string; quantity: string; unit_price: string };
type ReceiveLine = { transfer_item_id: string; product_id: string; accepted_quantity: string; missing_qty: string; damaged_qty: string; rejected_quantity: string; discrepancy_description: string };
type IssueLine = { product_id: string; variant_id: string; quantity: string; unit_cost: string };
type TransferLine = { product_id: string; variant_id: string; quantity: string };

export function InventoryParityPanel({ orgId, onToast }: { orgId: string | null; onToast: Toast }) {
  const [warehouses, setWarehouses] = useState<Row[]>([]);
  const [products, setProducts] = useState<Row[]>([]);
  const [variants, setVariants] = useState<Row[]>([]);
  const [contacts, setContacts] = useState<Row[]>([]);
  const [treasury, setTreasury] = useState<Row[]>([]);
  const [transfers, setTransfers] = useState<Row[]>([]);
  const [stock, setStock] = useState<Row | null>(null);
  const [movements, setMovements] = useState<Row[]>([]);
  const [receipts, setReceipts] = useState<Row[]>([]);
  const [issues, setIssues] = useState<Row[]>([]);
  const [stockSearch, setStockSearch] = useState("");
  const [transferSearch, setTransferSearch] = useState("");
  const [warehouseFilter, setWarehouseFilter] = useState("");
  const [movementDateFrom, setMovementDateFrom] = useState("");
  const [movementDateTo, setMovementDateTo] = useState("");
  const [documentSearch, setDocumentSearch] = useState("");
  const [warehouseDraft, setWarehouseDraft] = useState({ code: "", name: "", address: "" });
  const [documentFilter, setDocumentFilter] = useState<"RECEIPT" | "ISSUE">("RECEIPT");
  const [selectedStockDocument, setSelectedStockDocument] = useState<Row | null>(null);
  const [issue, setIssue] = useState({ warehouse_id: "", document_date_jalali: jalaliToday(), description: "حواله خروج کالا" });
  const [issueItems, setIssueItems] = useState<IssueLine[]>([{ product_id: "", variant_id: "", quantity: "", unit_cost: "" }]);
  const [supplierProfile, setSupplierProfile] = useState<Row | null>(null);
  const [receipt, setReceipt] = useState({ warehouse_id: "", supplier_id: "", supplier_invoice_number: "", invoice_date_jalali: jalaliToday(), shipping_cost: "0.00", customs_and_extra_cost: "0.00", supplier_discount: "0.00", paid_amount: "0.00", payment_bank_account_id: "", description: "رسید خرید کالا" });
  const [receiptItems, setReceiptItems] = useState<ProductLine[]>([{ product_id: "", variant_id: "", quantity: "", unit_price: "" }]);
  const [transferForm, setTransferForm] = useState({ source_warehouse_id: "", destination_warehouse_id: "", transfer_date_jalali: jalaliToday(), reason: "انتقال بین انبارها", notes: "" });
  const [transferItems, setTransferItems] = useState<TransferLine[]>([{ product_id: "", variant_id: "", quantity: "" }]);
  const [selectedTransfer, setSelectedTransfer] = useState<Row | null>(null);
  const [receiveLines, setReceiveLines] = useState<ReceiveLine[]>([]);
  const [receiveDate, setReceiveDate] = useState(jalaliToday());
  const [settlement, setSettlement] = useState({ supplier_id: "", financial_account_id: "", amount: "0.00", payment_method: "BANK_TRANSFER", settlement_date_jalali: jalaliToday(), description: "تسویه حساب تأمین‌کننده" });
  const [busy, setBusy] = useState(false);

  const suppliers = useMemo(() => contacts.filter((item) => ["SUPPLIER", "VENDOR"].includes(text(item.type ?? item.contactType).toUpperCase())), [contacts]);

  const reload = useCallback(async () => {
    if (!orgId) return;
    setBusy(true);
    try {
      const movementQuery = new URLSearchParams({ per_page: "100" });
      if (warehouseFilter) movementQuery.set("warehouse_id", warehouseFilter);
      if (movementDateFrom) movementQuery.set("date_from", movementDateFrom);
      if (movementDateTo) movementQuery.set("date_to", movementDateTo);
      const [wh, prod, cont, fin, trans, stockResult, movementRows, receiptRows, issueRows, variantResult] = await Promise.all([
        apiFetch<Row[]>("/api/v1/warehouses?per_page=100", { organizationId: orgId }),
        apiFetch<Row[]>("/api/v1/products?per_page=200", { organizationId: orgId }),
        apiFetch<Row[]>("/api/v1/contacts?per_page=200", { organizationId: orgId }),
        apiFetch<Row[]>("/api/v1/treasury/accounts", { organizationId: orgId }),
        apiFetch<Row[]>("/api/v1/inventory/transfers?per_page=100", { organizationId: orgId }),
        apiFetch<Row>("/api/v1/inventory/stock", { organizationId: orgId }),
        apiFetch<Row[]>(`/api/v1/inventory/movements?${movementQuery}`, { organizationId: orgId }),
        apiFetch<Row[]>("/api/v1/inventory/receipts?per_page=100", { organizationId: orgId }),
        apiFetch<Row[]>("/api/v1/inventory/issues?per_page=100", { organizationId: orgId }),
        apiFetch<Row>("/api/v1/variants", { organizationId: orgId }),
      ]);
      const productRows = rows(prod).filter((product) => Boolean(product.is_active ?? true));
      const variantRows = rows(variantResult.variants).filter((variant) => Boolean(variant.is_active ?? true));
      const availableWarehouses = rows(wh).filter((item) => Boolean(item.is_active ?? true));
      setWarehouses(rows(wh)); setProducts(productRows); setVariants(variantRows); setContacts(rows(cont)); setTreasury(rows(fin)); setTransfers(rows(trans));
      setStock(stockResult); setMovements(rows(movementRows)); setReceipts(rows(receiptRows)); setIssues(rows(issueRows));
      setReceipt((old) => ({ ...old, warehouse_id: old.warehouse_id || text(availableWarehouses[0]?.id), supplier_id: old.supplier_id || text(cont.find((item) => ["SUPPLIER", "VENDOR"].includes(text(item.type).toUpperCase()))?.id), payment_bank_account_id: old.payment_bank_account_id || text(fin[0]?.id) }));
      setReceiptItems((old) => old.map((line) => ({ ...line, product_id: line.product_id || text(productRows[0]?.id), unit_price: line.unit_price === "" ? text(productRows[0]?.purchase_price, "") : line.unit_price })));
      setSettlement((old) => ({ ...old, supplier_id: old.supplier_id || text(cont.find((item) => ["SUPPLIER", "VENDOR"].includes(text(item.type).toUpperCase()))?.id), financial_account_id: old.financial_account_id || text(fin[0]?.id) }));
      setTransferForm((old) => ({ ...old, source_warehouse_id: old.source_warehouse_id || text(availableWarehouses[0]?.id), destination_warehouse_id: old.destination_warehouse_id || text(availableWarehouses[1]?.id) }));
      setIssue((old) => ({ ...old, warehouse_id: old.warehouse_id || text(availableWarehouses[0]?.id) }));
      setTransferItems((old) => old.map((line) => ({ ...line, product_id: line.product_id || text(productRows[0]?.id) })));
      setIssueItems((old) => old.map((line) => ({ ...line, product_id: line.product_id || text(productRows[0]?.id) })));
    } catch (error) { onToast(error instanceof Error ? error.message : "دریافت اطلاعات انبار ناموفق بود", "error"); }
    finally { setBusy(false); }
  }, [orgId, onToast, warehouseFilter, movementDateFrom, movementDateTo]);

  useEffect(() => { void reload(); }, [reload]);

  useEffect(() => {
    if (!orgId || !settlement.supplier_id) { setSupplierProfile(null); return; }
    apiFetch<Row>(`/api/v1/suppliers/${settlement.supplier_id}/profile`, { organizationId: orgId })
      .then(setSupplierProfile)
      .catch((error: unknown) => onToast(error instanceof Error ? error.message : "دریافت حساب تأمین‌کننده ناموفق بود", "error"));
  }, [orgId, settlement.supplier_id, onToast]);

  function updateProductLine(index: number, changes: Partial<ProductLine>) {
    setReceiptItems((current) => current.map((line, i) => i === index ? { ...line, ...changes } : line));
  }

  async function createReceipt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!orgId) return;
    const validItems = receiptItems.filter((line) => line.product_id && Number(line.quantity) > 0 && line.unit_price.trim() !== "" && Number(line.unit_price) >= 0);
    if (!receipt.warehouse_id || !receipt.supplier_id || !receipt.supplier_invoice_number.trim() || validItems.length === 0) {
      onToast("انبار، تأمین‌کننده، شماره فاکتور و دست‌کم یک قلم با تعداد معتبر را وارد کنید.", "error");
      return;
    }
    try {
      await apiFetch("/api/v1/inventory/receipts", {
        method: "POST", organizationId: orgId, headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ ...receipt, items: validItems.map((item) => ({ ...item, variant_id: item.variant_id || null })), ...(Number(receipt.paid_amount) > 0 ? {} : { payment_bank_account_id: null }) }),
      });
      onToast("رسید با تخصیص بهای حمل و هزینه‌های جانبی ثبت و به موجودی و حساب تأمین‌کننده متصل شد.");
      const supplierId = receipt.supplier_id;
      setReceipt((old) => ({ ...old, supplier_invoice_number: "", paid_amount: "0.00" }));
      await reload();
      if (supplierId) setSupplierProfile(await apiFetch<Row>(`/api/v1/suppliers/${supplierId}/profile`, { organizationId: orgId }));
    } catch (error) { onToast(error instanceof Error ? error.message : "ثبت رسید کالا ناموفق بود", "error"); }
  }

  async function createIssue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!orgId) return;
    const validItems = issueItems.filter((line) => line.product_id && Number(line.quantity) > 0 && Number(line.unit_cost || 0) >= 0);
    if (!issue.warehouse_id || validItems.length === 0) {
      onToast("انبار خروج و دست‌کم یک قلم با تعداد معتبر را انتخاب کنید.", "error");
      return;
    }
    try {
      await apiFetch("/api/v1/inventory/issues", {
        method: "POST", organizationId: orgId, headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ warehouse_id: issue.warehouse_id, document_date_jalali: issue.document_date_jalali, description: issue.description, items: validItems.map(({ product_id, variant_id, quantity, unit_cost }) => ({ product_id, variant_id: variant_id || null, quantity, ...(unit_cost ? { unit_cost } : {}) })) }),
      });
      onToast("حواله خروج ثبت شد و کاردکس موجودی از دادهٔ سرور به‌روزرسانی شد.");
      setIssueItems([{ product_id: text(products[0]?.id), variant_id: "", quantity: "", unit_cost: "" }]);
      await reload();
    } catch (error) { onToast(error instanceof Error ? error.message : "ثبت حواله خروج ناموفق بود", "error"); }
  }

  async function createWarehouse(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!orgId) return;
    try {
      await apiFetch("/api/v1/warehouses", {
        method: "POST", organizationId: orgId,
        body: JSON.stringify({ code: warehouseDraft.code.trim().toUpperCase(), name: warehouseDraft.name.trim(), address: warehouseDraft.address.trim() }),
      });
      onToast("انبار جدید در سازمان ثبت شد.");
      setWarehouseDraft({ code: "", name: "", address: "" });
      await reload();
    } catch (error) { onToast(error instanceof Error ? error.message : "ثبت انبار ناموفق بود", "error"); }
  }

  async function toggleWarehouse(warehouse: Row) {
    if (!orgId || Boolean(warehouse.is_default)) return;
    try {
      await apiFetch(`/api/v1/warehouses/${encodeURIComponent(text(warehouse.id))}`, {
        method: "PATCH", organizationId: orgId,
        body: JSON.stringify({ is_active: !Boolean(warehouse.is_active) }),
      });
      onToast(Boolean(warehouse.is_active) ? "انبار غیرفعال شد." : "انبار فعال شد.");
      await reload();
    } catch (error) { onToast(error instanceof Error ? error.message : "تغییر وضعیت انبار ناموفق بود", "error"); }
  }

  async function openStockDocument(document: Row, type: "receipts" | "issues") {
    if (!orgId) return;
    try {
      const detail = await apiFetch<Row>(`/api/v1/inventory/${type}/${encodeURIComponent(text(document.id))}`, { organizationId: orgId });
      setSelectedStockDocument({ ...detail, _documentType: type });
    } catch (error) { onToast(error instanceof Error ? error.message : "دریافت جزئیات سند انبار ناموفق بود", "error"); }
  }

  function printStockDocument() {
    if (!selectedStockDocument) return;
    const escape = (value: unknown) => text(value, "—").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character] ?? character);
    const lines = rows(selectedStockDocument.items).map((item, index) => `<tr><td>${index + 1}</td><td>${escape(item.product_name ?? item.productName)}</td><td>${escape(item.quantity)}</td><td>${escape(item.unit_cost ?? item.unitCost)}</td></tr>`).join("");
    const popup = window.open("", "_blank", "width=900,height=700");
    if (!popup) { onToast("پنجرهٔ چاپ توسط مرورگر مسدود شد.", "error"); return; }
    popup.opener = null;
    popup.document.write(`<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><title>سند انبار ${escape(selectedStockDocument.document_number)}</title><style>body{font-family:Tahoma,sans-serif;margin:32px;color:#111}table{width:100%;border-collapse:collapse;margin-top:24px}th,td{border:1px solid #bbb;padding:8px;text-align:right}header{display:flex;justify-content:space-between;border-bottom:2px solid #222;padding-bottom:14px}</style><header><strong>سند انبار ${escape(selectedStockDocument.document_number)}</strong><span>${escape(gregorianIsoToJalali(text(selectedStockDocument.document_date)))}</span></header><p>${escape(selectedStockDocument.reason ?? selectedStockDocument.description)}</p><table><thead><tr><th>ردیف</th><th>کالا</th><th>مقدار</th><th>بهای واحد</th></tr></thead><tbody>${lines}</tbody></table><script>window.onload=()=>window.print()</script></html>`);
    popup.document.close();
  }

  async function createTransfer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!orgId) return;
    const validItems = transferItems.filter((line) => line.product_id && Number(line.quantity) > 0);
    if (!transferForm.source_warehouse_id || !transferForm.destination_warehouse_id || transferForm.source_warehouse_id === transferForm.destination_warehouse_id || validItems.length === 0) {
      onToast("انبار مبدأ و مقصد متفاوت و دست‌کم یک کالای دارای مقدار مثبت لازم است.", "error");
      return;
    }
    try {
      await apiFetch("/api/v1/inventory/transfers", {
        method: "POST", organizationId: orgId, headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ ...transferForm, dispatch_immediately: false, items: validItems.map((line) => ({ ...line, variant_id: line.variant_id || null })) }),
      });
      onToast("حوالهٔ چندقلمی به شکل پیش‌نویس ایجاد شد؛ موجودی تا زمان ارسال از مبدأ کم نمی‌شود.");
      await reload();
    } catch (error) { onToast(error instanceof Error ? error.message : "ایجاد حواله ناموفق بود", "error"); }
  }

  async function transferAction(id: string, action: "submit" | "dispatch" | "complete") {
    if (!orgId) return;
    try {
      await apiFetch(`/api/v1/inventory/transfers/${id}/${action}`, { method: "POST", organizationId: orgId, ...(action === "dispatch" ? { headers: { "Idempotency-Key": crypto.randomUUID() } } : {}) });
      onToast(action === "submit" ? "حواله برای ارسال تأیید شد." : action === "dispatch" ? "کالا از موجودی مبدأ خارج و در مسیر ثبت شد." : "انتقال انبار تکمیل شد.");
      setSelectedTransfer(null); await reload();
    } catch (error) { onToast(error instanceof Error ? error.message : "تغییر وضعیت حواله ناموفق بود", "error"); }
  }

  function openReceive(transfer: Row) {
    const items = rows(transfer.items);
    setSelectedTransfer(transfer);
    setReceiveDate(jalaliToday());
    setReceiveLines(items.map((item) => {
      const sent = Number(item.quantitySent ?? item.quantity_sent ?? item.quantity ?? 0);
      const accepted = Number(item.quantityAccepted ?? item.quantity_accepted ?? 0);
      const missing = Number(item.quantityMissing ?? item.quantity_missing ?? 0);
      const damaged = Number(item.quantityDamaged ?? item.quantity_damaged ?? 0);
      const rejected = Number(item.quantityRejected ?? item.quantity_rejected ?? 0);
      const remaining = Math.max(0, sent - accepted - missing - damaged - rejected).toFixed(4);
      return { transfer_item_id: text(item.id), product_id: text(item.productId ?? item.product_id), accepted_quantity: remaining, missing_qty: "0.0000", damaged_qty: "0.0000", rejected_quantity: "0.0000", discrepancy_description: "" };
    }));
  }

  async function receiveTransfer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!orgId || !selectedTransfer) return;
    try {
      await apiFetch(`/api/v1/inventory/transfers/${text(selectedTransfer.id)}/receive`, {
        method: "POST", organizationId: orgId, headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ received_date_jalali: receiveDate, items: receiveLines.filter((line) => line.product_id) }),
      });
      onToast("مقدار پذیرفته‌شده وارد مقصد شد و کسری/آسیب در گردش حواله ثبت شد.");
      setSelectedTransfer(null); await reload();
    } catch (error) { onToast(error instanceof Error ? error.message : "ثبت رسید انتقال ناموفق بود", "error"); }
  }

  async function settleSupplier(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!orgId || !settlement.supplier_id) return;
    try {
      await apiFetch(`/api/v1/suppliers/${settlement.supplier_id}/settlements`, {
        method: "POST", organizationId: orgId, headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ ...settlement, settlement_date_jalali: settlement.settlement_date_jalali }),
      });
      onToast("پرداخت ثبت شد و ماندهٔ تأمین‌کننده و حساب خزانه بروزرسانی شد.");
      const supplierId = settlement.supplier_id;
      setSettlement((old) => ({ ...old, amount: "0.00" })); await reload();
      if (supplierId) setSupplierProfile(await apiFetch<Row>(`/api/v1/suppliers/${supplierId}/profile`, { organizationId: orgId }));
    } catch (error) { onToast(error instanceof Error ? error.message : "تسویه تأمین‌کننده ناموفق بود", "error"); }
  }

  const lineSelect = (value: string, onChange: (value: string) => void) => <select className={field} required value={value} onChange={(event) => onChange(event.target.value)}><option value="">انتخاب کالا</option>{products.map((product) => <option key={text(product.id)} value={text(product.id)}>{text(product.name)} ({text(product.sku ?? product.code)})</option>)}</select>;
  const variantSelect = (productId: string, value: string, onChange: (value: string) => void) => {
    const options = variants.filter((variant) => text(variant.product_id) === productId);
    if (!options.length) return null;
    return <select className={field} aria-label="تنوع کالا" value={value} onChange={(event) => onChange(event.target.value)}><option value="">کالای پایه</option>{options.map((variant) => <option key={text(variant.id)} value={text(variant.id)}>{text(variant.variant_name)} ({text(variant.sku)})</option>)}</select>;
  };
  const availableQty = (warehouseId: string, productId: string, variantId: string) => text(rows(stock?.balances).find((row) => text(row.warehouse_id) === warehouseId && text(row.product_id) === productId && text(row.variant_id) === variantId)?.on_hand_qty, "0.0000");
  const warehouseSelect = (value: string, onChange: (value: string) => void) => <select className={field} required value={value} onChange={(event) => onChange(event.target.value)}>{warehouses.map((item) => <option key={text(item.id)} disabled={!Boolean(item.is_active ?? true)} value={text(item.id)}>{text(item.name)}{item.is_default ? " • اصلی" : ""}{!Boolean(item.is_active ?? true) ? " • غیرفعال" : ""}</option>)}</select>;
  const stockExportQuery = new URLSearchParams();
  if (warehouseFilter) stockExportQuery.set("warehouse_id", warehouseFilter);
  const movementExportQuery = new URLSearchParams();
  if (warehouseFilter) movementExportQuery.set("warehouse_id", warehouseFilter);
  if (movementDateFrom) movementExportQuery.set("date_from", movementDateFrom);
  if (movementDateTo) movementExportQuery.set("date_to", movementDateTo);
  const shownStockDocuments = (documentFilter === "RECEIPT" ? receipts : issues).filter((document) =>
    `${text(document.document_number)} ${text(document.reason ?? document.description)} ${text(document.document_date)}`.toLowerCase().includes(documentSearch.trim().toLowerCase())
  );
  const shownTransfers = transfers.filter((transfer) =>
    `${text(transfer.transfer_number)} ${text(transfer.source_warehouse_name)} ${text(transfer.destination_warehouse_name)} ${rows(transfer.items).map((item) => `${text(item.product_name)} ${text(item.variant_name)} ${text(item.variant_sku)}`).join(" ")}`
      .toLowerCase().includes(transferSearch.trim().toLowerCase())
  );

  return (
    <section className="space-y-4 border-t border-slate-200 pt-5">
      <div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="text-sm font-bold">رسید خرید، تسویه تأمین‌کننده و حواله مرحله‌ای</h3><p className="mt-1 text-xs text-slate-500">هزینهٔ تمام‌شده به تفکیک کالا تخصیص می‌یابد و جابجایی مرحله‌ای فقط با تأییدهای انبار ثبت می‌شود.</p></div><div className="flex flex-wrap gap-2">{orgId && <><button type="button" onClick={() => void downloadReport(`/api/v1/inventory/exports/stock${stockExportQuery.size ? `?${stockExportQuery}` : ""}`, orgId, `inventory-stock-${today()}.xlsx`, onToast)} className="rounded-xl border border-slate-200 px-3 py-2 text-xs">خروجی موجودی</button><button type="button" onClick={() => void downloadReport(`/api/v1/inventory/exports/movements${movementExportQuery.size ? `?${movementExportQuery}` : ""}`, orgId, `inventory-movements-${today()}.xlsx`, onToast)} className="rounded-xl border border-slate-200 px-3 py-2 text-xs">خروجی گردش انبار</button></>}<button type="button" onClick={() => void reload()} className="rounded-xl border border-slate-200 px-3 py-2 text-xs">{busy ? "در حال دریافت…" : "بروزرسانی"}</button></div></div>
      <div className={`${card} grid grid-cols-1 gap-4 xl:grid-cols-[minmax(280px,1fr)_2fr]`}>
        <form onSubmit={createWarehouse} className="space-y-2">
          <h4 className="text-xs font-bold">تعریف انبار جدید</h4>
          <input className={field} required minLength={2} maxLength={20} dir="ltr" placeholder="کد یکتا" value={warehouseDraft.code} onChange={(event) => setWarehouseDraft({ ...warehouseDraft, code: event.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, "") })}/>
          <input className={field} required minLength={2} maxLength={100} placeholder="نام انبار" value={warehouseDraft.name} onChange={(event) => setWarehouseDraft({ ...warehouseDraft, name: event.target.value })}/>
          <input className={field} maxLength={300} placeholder="نشانی" value={warehouseDraft.address} onChange={(event) => setWarehouseDraft({ ...warehouseDraft, address: event.target.value })}/>
          <button className={button}>ثبت انبار</button>
        </form>
        <div className="space-y-2"><h4 className="text-xs font-bold">انبارهای سازمان</h4><div className="grid grid-cols-1 gap-2 sm:grid-cols-2">{warehouses.map((warehouse) => <div key={text(warehouse.id)} className="flex items-center justify-between gap-2 rounded-xl border border-slate-100 p-3"><button type="button" className="min-w-0 text-right" onClick={() => setWarehouseFilter(text(warehouse.id))}><strong className="block truncate text-xs">{text(warehouse.name)}</strong><span className="text-[10px] text-slate-500">{text(warehouse.code)}{warehouse.address ? ` • ${text(warehouse.address)}` : ""}</span></button><div className="flex shrink-0 items-center gap-2"><span className="rounded-full bg-slate-100 px-2 py-1 text-[10px]">{warehouse.is_default ? "اصلی" : Boolean(warehouse.is_active ?? true) ? "فعال" : "غیرفعال"}</span>{!warehouse.is_default && <button type="button" onClick={() => void toggleWarehouse(warehouse)} className="text-[10px] underline">{Boolean(warehouse.is_active ?? true) ? "غیرفعال‌سازی" : "فعال‌سازی"}</button>}</div></div>)}{!warehouses.length && <p className="text-xs text-slate-500">انبار ثبت‌شده‌ای ندارید.</p>}</div></div>
      </div>
      <div className={`${card} space-y-3`}>
        <div className="flex flex-wrap items-center justify-between gap-2"><div><h4 className="text-xs font-bold">موجودی واقعی و ارزش هر انبار</h4><p className="mt-1 text-[11px] text-slate-500">مبنای نمایش، دفتر گردش ثبت‌شده در سرور است.</p></div><strong className="rounded-full bg-teal-50 px-3 py-1 text-xs text-teal-800">ارزش کل: {formatIrr(text(stock?.total_valuation))} ریال</strong></div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">{warehouses.map((warehouse) => {
          const balanceRows = rows(stock?.balances).filter((row) => text(row.warehouse_id) === text(warehouse.id));
          const quantity = balanceRows.reduce((sum, row) => sum + Number(row.on_hand_qty ?? 0), 0);
          const valuation = balanceRows.reduce((sum, row) => sum + Number(row.total_value ?? 0), 0);
          return <button key={text(warehouse.id)} type="button" onClick={() => setWarehouseFilter(text(warehouse.id))} className={`rounded-xl border p-3 text-right ${warehouseFilter === text(warehouse.id) ? "border-teal-500 bg-teal-50" : "border-slate-100 bg-slate-50"}`}><strong className="block text-xs">{text(warehouse.name)}</strong><span className="mt-2 block text-[11px] text-slate-600">{formatQty(quantity)} مقدار • {balanceRows.length} قلم</span><span className="mt-1 block text-[11px] font-semibold">{formatIrr(valuation)} ریال</span></button>;
        })}{!warehouses.length && <div className="rounded-xl border border-dashed p-4 text-xs text-slate-500">انبار فعالی از سرور دریافت نشد.</div>}</div>
        <div className="flex flex-wrap items-center gap-2"><select className={`${field} max-w-xs`} value={warehouseFilter} onChange={(event) => setWarehouseFilter(event.target.value)}><option value="">همهٔ انبارها</option>{warehouses.map((warehouse) => <option key={text(warehouse.id)} value={text(warehouse.id)}>{text(warehouse.name)}</option>)}</select><input className={`${field} max-w-sm`} value={stockSearch} onChange={(event) => setStockSearch(event.target.value)} placeholder="جستجوی کالا یا کد کالا"/></div>
        <div className="overflow-x-auto"><table className="w-full min-w-[680px] text-right text-[11px]"><thead className="border-b bg-slate-50 text-slate-500"><tr><th className="p-2">انبار</th><th className="p-2">کالا / کد</th><th className="p-2">مقدار واقعی</th><th className="p-2">بهای میانگین</th><th className="p-2">ارزش موجودی</th></tr></thead><tbody>{rows(stock?.balances).filter((row) => (!warehouseFilter || text(row.warehouse_id) === warehouseFilter) && `${text(row.product_name)} ${text(row.product_sku)}`.toLowerCase().includes(stockSearch.trim().toLowerCase())).map((row, index) => <tr key={`${text(row.warehouse_id)}-${text(row.product_id)}-${text(row.variant_id, String(index))}`} className="border-b border-slate-100"><td className="p-2">{text(row.warehouse_name)}</td><td className="p-2">{text(row.product_name)} <span className="text-slate-400">{text(row.product_sku)}</span>{text(row.variant_name) && ` • ${text(row.variant_name)}`}</td><td className="p-2 font-semibold">{formatQty(text(row.on_hand_qty))}</td><td className="p-2">{formatIrr(text(row.avg_unit_cost))} ریال</td><td className="p-2">{formatIrr(text(row.total_value))} ریال</td></tr>)}</tbody></table>{!rows(stock?.balances).length && <div className="py-4 text-center text-xs text-slate-500">برای این کسب‌وکار گردش موجودی ثبت‌شده‌ای پیدا نشد.</div>}</div>
      </div>
      <div className={`${card} space-y-3`}>
        <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-xs font-bold">اسناد رسید و حوالهٔ خروج</h4><div className="flex flex-wrap gap-2"><input className={`${field} max-w-xs`} placeholder="جستجوی شماره یا شرح سند" value={documentSearch} onChange={(event) => setDocumentSearch(event.target.value)}/><button type="button" onClick={() => setDocumentFilter("RECEIPT")} className={`rounded-lg px-3 py-1.5 text-xs ${documentFilter === "RECEIPT" ? "bg-teal-700 text-white" : "border"}`}>رسیدها ({receipts.length})</button><button type="button" onClick={() => setDocumentFilter("ISSUE")} className={`rounded-lg px-3 py-1.5 text-xs ${documentFilter === "ISSUE" ? "bg-teal-700 text-white" : "border"}`}>حواله‌های خروج ({issues.length})</button></div></div>
        <div className="max-h-56 space-y-2 overflow-auto">{shownStockDocuments.map((document) => <button key={text(document.id)} type="button" onClick={() => void openStockDocument(document, documentFilter === "RECEIPT" ? "receipts" : "issues")} className="flex w-full flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-100 p-3 text-right text-xs hover:bg-slate-50"><span><strong>{text(document.document_number, "سند انبار")}</strong> • {gregorianIsoToJalali(text(document.document_date))} • {text(document.reason ?? document.description)}</span><span className="rounded-full bg-slate-100 px-2 py-1">{text(document.status)}</span></button>)}{!shownStockDocuments.length && <div className="py-4 text-center text-xs text-slate-500">سندی مطابق جستجو پیدا نشد.</div>}</div>
        {selectedStockDocument && <div className="space-y-2 rounded-xl border border-teal-200 bg-teal-50/40 p-3"><div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-xs">{text(selectedStockDocument.document_number)} • {gregorianIsoToJalali(text(selectedStockDocument.document_date))}</strong><div className="flex gap-2"><button type="button" onClick={printStockDocument} className="rounded-lg border px-3 py-1.5 text-xs">چاپ سند</button><button type="button" onClick={() => setSelectedStockDocument(null)} className="text-xs underline">بستن</button></div></div><div className="text-[11px]">{rows(selectedStockDocument.items).map((item) => `${text(item.product_name)}: ${formatQty(text(item.quantity))}`).join("، ")}</div></div>}
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <form onSubmit={createReceipt} className={`${card} space-y-3`}>
          <h4 className="text-xs font-bold">رسید ورود با بهای تمام‌شده</h4>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2"><label className="text-[11px]">انبار{warehouseSelect(receipt.warehouse_id, (value) => setReceipt({ ...receipt, warehouse_id: value }))}</label><label className="text-[11px]">تأمین‌کننده<select className={`${field} mt-1`} required value={receipt.supplier_id} onChange={(event) => setReceipt({ ...receipt, supplier_id: event.target.value })}><option value="">انتخاب تأمین‌کننده</option>{suppliers.map((item) => <option key={text(item.id)} value={text(item.id)}>{text(item.display_name ?? item.name)}</option>)}</select></label><label className="text-[11px]">شماره فاکتور<input className={`${field} mt-1`} required value={receipt.supplier_invoice_number} onChange={(event) => setReceipt({ ...receipt, supplier_invoice_number: event.target.value })}/></label><label className="text-[11px]">تاریخ فاکتور<JalaliDatePicker className="mt-1" value={receipt.invoice_date_jalali} onChange={(value) => setReceipt({ ...receipt, invoice_date_jalali: value })}/></label></div>
          <div className="space-y-2">{receiptItems.map((line, index) => <div key={index} className="grid grid-cols-1 gap-2 sm:grid-cols-[1.3fr_1fr_.65fr_1fr]">{lineSelect(line.product_id, (productId) => { const product = products.find((item) => text(item.id) === productId); updateProductLine(index, { product_id: productId, variant_id: "", unit_price: text(product?.purchase_price, line.unit_price) }); })}{variantSelect(line.product_id, line.variant_id, (variantId) => { const variant = variants.find((item) => text(item.id) === variantId); const product = products.find((item) => text(item.id) === line.product_id); updateProductLine(index, { variant_id: variantId, unit_price: text(variant?.purchase_price, text(product?.purchase_price, line.unit_price)) }); })}<input className={field} aria-label="تعداد" required dir="ltr" inputMode="decimal" value={line.quantity} onChange={(event) => updateProductLine(index, { quantity: event.target.value })}/><input className={field} aria-label="قیمت واحد" required dir="ltr" inputMode="decimal" value={line.unit_price} onChange={(event) => updateProductLine(index, { unit_price: event.target.value })}/></div>)}</div>
          <div className="flex gap-2"><button type="button" className="rounded-xl border border-slate-200 px-3 py-2 text-xs" onClick={() => setReceiptItems((items) => [...items, { product_id: text(products[0]?.id), variant_id: "", quantity: "1.0000", unit_price: text(products[0]?.purchase_price, "0.00") }])}>افزودن قلم</button><button type="button" className="rounded-xl border border-slate-200 px-3 py-2 text-xs" disabled={receiptItems.length <= 1} onClick={() => setReceiptItems((items) => items.slice(0, -1))}>حذف قلم آخر</button></div>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">{([["shipping_cost", "هزینه حمل"], ["customs_and_extra_cost", "گمرک و سایر هزینه"], ["supplier_discount", "تخفیف"], ["paid_amount", "پرداخت‌شده"]] as const).map(([key, label]) => <label key={key} className="text-[11px]">{label}<input className={`${field} mt-1`} dir="ltr" inputMode="decimal" value={receipt[key]} onChange={(event) => setReceipt({ ...receipt, [key]: event.target.value })}/></label>)}</div>
          {Number(receipt.paid_amount) > 0 && <label className="block text-[11px]">پرداخت از حساب<select className={`${field} mt-1`} required value={receipt.payment_bank_account_id} onChange={(event) => setReceipt({ ...receipt, payment_bank_account_id: event.target.value })}>{treasury.map((item) => <option key={text(item.id)} value={text(item.id)}>{text(item.name)} — {formatIrr(text(item.balance))} ریال</option>)}</select></label>}
          <button className={button}>ثبت رسید و صدور سند موجودی</button>
        </form>
        <form onSubmit={createIssue} className={`${card} space-y-3`}>
          <h4 className="text-xs font-bold">حواله خروج کالا از انبار</h4>
          <label className="block text-[11px]">انبار مبدأ{warehouseSelect(issue.warehouse_id, (value) => setIssue({ ...issue, warehouse_id: value }))}</label>
          <label className="block text-[11px]">تاریخ حواله شمسی<JalaliDatePicker className="mt-1" value={issue.document_date_jalali} onChange={(value) => setIssue({ ...issue, document_date_jalali: value })}/></label>
          {issueItems.map((line, index) => <div key={index} className="grid grid-cols-1 gap-2 sm:grid-cols-[1.2fr_1fr_.6fr_1fr]"><div>{lineSelect(line.product_id, (productId) => setIssueItems((items) => items.map((item, i) => i === index ? { ...item, product_id: productId, variant_id: "" } : item)))}{variantSelect(line.product_id, line.variant_id, (variantId) => setIssueItems((items) => items.map((item, i) => i === index ? { ...item, variant_id: variantId } : item)))}<span className="mt-1 block text-[10px] text-slate-500">موجودی این تنوع: {formatQty(availableQty(issue.warehouse_id, line.product_id, line.variant_id))}</span></div><input className={field} required dir="ltr" inputMode="decimal" aria-label="مقدار خروج" placeholder="تعداد" value={line.quantity} onChange={(event) => setIssueItems((items) => items.map((item, i) => i === index ? { ...item, quantity: event.target.value } : item))}/><input className={field} dir="ltr" inputMode="decimal" aria-label="بهای واحد خروج" placeholder="بهای واحد اختیاری" value={line.unit_cost} onChange={(event) => setIssueItems((items) => items.map((item, i) => i === index ? { ...item, unit_cost: event.target.value } : item))}/></div>)}
          <div className="flex gap-2"><button type="button" className="rounded-xl border border-slate-200 px-3 py-2 text-xs" onClick={() => setIssueItems((items) => [...items, { product_id: text(products[0]?.id), variant_id: "", quantity: "", unit_cost: "" }])}>افزودن قلم</button><input className={field} aria-label="شرح حواله خروج" value={issue.description} onChange={(event) => setIssue({ ...issue, description: event.target.value })}/><button className={button}>ثبت حواله خروج</button></div>
        </form>
        <div className="space-y-4">
          <form onSubmit={settleSupplier} className={`${card} space-y-3`}>
            <h4 className="text-xs font-bold">تسویه بدهی تأمین‌کننده</h4>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2"><select className={field} required value={settlement.supplier_id} onChange={(event) => setSettlement({ ...settlement, supplier_id: event.target.value })}><option value="">تأمین‌کننده</option>{suppliers.map((item) => <option key={text(item.id)} value={text(item.id)}>{text(item.display_name ?? item.name)}</option>)}</select><select className={field} required value={settlement.financial_account_id} onChange={(event) => setSettlement({ ...settlement, financial_account_id: event.target.value })}><option value="">حساب پرداخت</option>{treasury.map((item) => <option key={text(item.id)} value={text(item.id)}>{text(item.name)}</option>)}</select><input className={field} required dir="ltr" inputMode="decimal" aria-label="مبلغ تسویه" value={settlement.amount} onChange={(event) => setSettlement({ ...settlement, amount: event.target.value })}/><JalaliDatePicker value={settlement.settlement_date_jalali} onChange={(value) => setSettlement({ ...settlement, settlement_date_jalali: value })}/></div>
            <div className="flex gap-2"><select className={field} value={settlement.payment_method} onChange={(event) => setSettlement({ ...settlement, payment_method: event.target.value })}><option value="BANK_TRANSFER">انتقال بانکی</option><option value="CASH">نقد</option><option value="BANK">بانک</option><option value="CARD_TERMINAL">کارت‌خوان</option><option value="CHEQUE">چک</option></select><input className={field} value={settlement.description} onChange={(event) => setSettlement({ ...settlement, description: event.target.value })}/><button className={button}>ثبت تسویه</button></div>
          </form>
          <form onSubmit={createTransfer} className={`${card} space-y-3`}>
            <h4 className="text-xs font-bold">ایجاد حواله چندقلمی</h4>
            <div className="grid grid-cols-2 gap-2">{warehouseSelect(transferForm.source_warehouse_id, (value) => setTransferForm({ ...transferForm, source_warehouse_id: value, destination_warehouse_id: transferForm.destination_warehouse_id === value ? text(warehouses.find((item) => text(item.id) !== value)?.id) : transferForm.destination_warehouse_id }))}{warehouseSelect(transferForm.destination_warehouse_id, (value) => setTransferForm({ ...transferForm, destination_warehouse_id: value }))}</div>
            <label className="block text-[11px]">تاریخ حواله شمسی<JalaliDatePicker className="mt-1" value={transferForm.transfer_date_jalali} onChange={(value) => setTransferForm({ ...transferForm, transfer_date_jalali: value })}/></label>
            {transferItems.map((line, index) => <div key={index} className="grid grid-cols-1 gap-2 sm:grid-cols-[1.2fr_1fr_.7fr]"><div>{lineSelect(line.product_id, (value) => setTransferItems((items) => items.map((item, i) => i === index ? { ...item, product_id: value, variant_id: "" } : item)))}{variantSelect(line.product_id, line.variant_id, (variantId) => setTransferItems((items) => items.map((item, i) => i === index ? { ...item, variant_id: variantId } : item)))}<span className="mt-1 block text-[10px] text-slate-500">موجودی مبدأ: {formatQty(availableQty(transferForm.source_warehouse_id, line.product_id, line.variant_id))}</span></div><input className={field} required dir="ltr" inputMode="decimal" aria-label="مقدار انتقال" value={line.quantity} onChange={(event) => setTransferItems((items) => items.map((item, i) => i === index ? { ...item, quantity: event.target.value } : item))}/></div>)}
            <div className="flex gap-2"><button type="button" className="rounded-xl border border-slate-200 px-3 py-2 text-xs" onClick={() => setTransferItems((items) => [...items, { product_id: text(products[0]?.id), variant_id: "", quantity: "" }])}>افزودن کالا</button><input className={field} aria-label="شرح حواله" value={transferForm.reason} onChange={(event) => setTransferForm({ ...transferForm, reason: event.target.value })}/><button className={button}>ایجاد پیش‌نویس</button></div>
          </form>
        </div>
      </div>
      {supplierProfile && <div className={`${card} space-y-3`}>
        <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-xs font-bold">حساب تأمین‌کننده • {text((supplierProfile.supplier as Row | undefined)?.display_name)}</h4><span className="rounded-full bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-800">مانده پرداختنی: {formatIrr(text((supplierProfile.summary as Row | undefined)?.outstanding_payable))} ریال</span></div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 text-xs"><div className="rounded-xl bg-slate-50 p-3">جمع فاکتورها<strong className="mt-1 block">{formatIrr(text((supplierProfile.summary as Row | undefined)?.total_billed_credit))} ریال</strong></div><div className="rounded-xl bg-emerald-50 p-3">جمع تسویه<strong className="mt-1 block">{formatIrr(text((supplierProfile.summary as Row | undefined)?.total_settled_debit))} ریال</strong></div><div className="rounded-xl bg-indigo-50 p-3">فاکتورهای خرید<strong className="mt-1 block">{text((supplierProfile.summary as Row | undefined)?.purchase_invoices_count, "0")}</strong></div><div className="rounded-xl bg-teal-50 p-3">رسیدهای انبار<strong className="mt-1 block">{text((supplierProfile.summary as Row | undefined)?.warehouse_receipts_count, "0")}</strong></div></div>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2"><div className="max-h-44 overflow-auto rounded-xl border border-slate-100 p-3"><strong className="text-[11px]">گردش دفتر حساب تأمین‌کننده</strong>{rows(supplierProfile.ledger_transactions).slice(0, 12).map((item, index) => <div key={text(item.id, String(index))} className="flex justify-between gap-2 border-b border-slate-100 py-1.5 text-[11px]"><span>{gregorianIsoToJalali(text(item.txDate ?? item.tx_date))} • {text(item.description)}</span><span className="tabular-nums">بد {formatIrr(text(item.debit))} / بس {formatIrr(text(item.credit))}</span></div>)}</div><div className="max-h-44 overflow-auto rounded-xl border border-slate-100 p-3"><strong className="text-[11px]">پرداخت‌های خزانه‌ای ثبت‌شده</strong>{rows(supplierProfile.settlements).slice(0, 12).map((item, index) => <div key={text(item.id, String(index))} className="flex justify-between gap-2 border-b border-slate-100 py-1.5 text-[11px]"><span>{gregorianIsoToJalali(text(item.txDate ?? item.tx_date))} • {text(item.description)}</span><span className="tabular-nums">{formatIrr(text(item.amount))} ریال</span></div>)}</div></div>
      </div>}
      <div className={`${card} space-y-3`}>
        <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-xs font-bold">کاردکس از دفتر گردش انبار</h4><span className="text-[10px] text-slate-500">{movements.length} گردش از سرور</span></div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2"><label className="text-[11px]">از تاریخ شمسی<JalaliDatePicker className="mt-1" value={movementDateFrom} onChange={(value) => setMovementDateFrom(value)} format="iso" placeholder="از تاریخ شمسی" allowEmpty/></label><label className="text-[11px]">تا تاریخ شمسی<JalaliDatePicker className="mt-1" value={movementDateTo} onChange={(value) => setMovementDateTo(value)} format="iso" placeholder="تا تاریخ شمسی" allowEmpty/></label></div>
        <div className="max-h-64 overflow-auto">{movements.filter((row) => `${text(row.document_number)} ${text(row.product_name)} ${text(row.product_sku)} ${text(row.variant_name)} ${text(row.variant_sku)}`.toLowerCase().includes(stockSearch.trim().toLowerCase())).slice(0, 100).map((row) => <div key={text(row.id)} className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 py-2 text-[11px]"><span>{gregorianIsoToJalali(text(row.movement_date))} • {text(row.document_number)} • {text(row.warehouse_name)} / {text(row.product_name)}{text(row.variant_name) ? ` • ${text(row.variant_name)}` : ""}</span><span className="font-semibold tabular-nums">{Number(row.quantity_delta) >= 0 ? "+" : ""}{formatQty(text(row.quantity_delta))} ← مانده {formatQty(text(row.balance_after_qty))}</span></div>)}{!movements.length && <div className="py-3 text-xs text-slate-500">گردش انباری در سرور ثبت نشده است.</div>}</div>
      </div>
      <div className={`${card} space-y-3`}>
        <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-xs font-bold">چرخه ارسال و تحویل حواله‌ها</h4><input className={`${field} max-w-sm`} value={transferSearch} onChange={(event) => setTransferSearch(event.target.value)} placeholder="جستجوی شماره، انبار، کالا یا تنوع"/></div>
        <div className="space-y-2">{shownTransfers.slice(0, 100).map((transfer) => {
          const id = text(transfer.id); const status = text(transfer.status);
          const sourceName = text(transfer.source_warehouse_name, text(warehouses.find((warehouse) => text(warehouse.id) === text(transfer.source_warehouse_id))?.name, "مبدأ"));
          const destinationName = text(transfer.destination_warehouse_name, text(warehouses.find((warehouse) => text(warehouse.id) === text(transfer.destination_warehouse_id))?.name, "مقصد"));
          return <div key={id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-100 p-3 text-xs"><div><strong>{text(transfer.transferNumber ?? transfer.transfer_number, "حواله")}</strong> — {sourceName} ← {destinationName} <span className="mx-1 rounded-full bg-slate-100 px-2 py-0.5">{status}</span><div className="mt-1 text-slate-500">{rows(transfer.items).map((item) => `${text(item.product_name)}${text(item.variant_name) ? ` • ${text(item.variant_name)}` : ""}: ${formatQty(text(item.quantitySent ?? item.quantity_sent ?? item.quantity))}`).join("، ")}</div></div><div className="flex flex-wrap gap-1.5">{status === "DRAFT" && <button className="rounded-lg border px-2 py-1" type="button" onClick={() => void transferAction(id, "submit")}>تأیید حواله</button>}{status === "SUBMITTED" && <button className="rounded-lg bg-indigo-600 px-2 py-1 text-white" type="button" onClick={() => void transferAction(id, "dispatch")}>ارسال از مبدأ</button>}{["IN_TRANSIT", "PARTIALLY_RECEIVED", "DISCREPANCY_REPORTED"].includes(status) && <button className="rounded-lg bg-emerald-700 px-2 py-1 text-white" type="button" onClick={() => openReceive(transfer)}>ثبت تحویل مقصد</button>}{["RECEIVED", "PARTIALLY_RECEIVED", "DISCREPANCY_REPORTED"].includes(status) && <button className="rounded-lg border px-2 py-1" type="button" onClick={() => void transferAction(id, "complete")}>تکمیل حواله</button>}</div></div>;
        })}{!shownTransfers.length && <div className="text-xs text-slate-500">حواله‌ای مطابق جستجو پیدا نشد.</div>}</div>
        {selectedTransfer && <form onSubmit={receiveTransfer} className="space-y-3 rounded-xl border border-emerald-200 bg-emerald-50/40 p-4">
          <div className="flex items-center justify-between"><strong className="text-xs">تحویل حواله {text(selectedTransfer.transferNumber ?? selectedTransfer.transfer_number)}</strong><button type="button" className="text-xs underline" onClick={() => setSelectedTransfer(null)}>بستن</button></div>
          <label className="block max-w-xs text-[11px]">تاریخ تحویل مقصد شمسی<JalaliDatePicker className="mt-1" value={receiveDate} onChange={setReceiveDate}/></label>
          <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-right text-[11px]"><thead><tr><th className="p-2">کالا</th><th className="p-2">پذیرفته</th><th className="p-2">کسری</th><th className="p-2">آسیب</th><th className="p-2">رد کیفیت</th><th className="p-2">شرح اختلاف</th></tr></thead><tbody>{receiveLines.map((line, index) => { const transferItem = rows(selectedTransfer.items).find((item) => text(item.id) === line.transfer_item_id); return <tr key={line.transfer_item_id}><td className="p-2">{text(transferItem?.product_name)}{text(transferItem?.variant_name) ? ` • ${text(transferItem?.variant_name)}` : ""}</td>{(["accepted_quantity", "missing_qty", "damaged_qty", "rejected_quantity"] as const).map((key) => <td key={key} className="p-1"><input className="w-24 rounded-lg border px-2 py-1 text-left" dir="ltr" inputMode="decimal" value={line[key]} onChange={(event) => setReceiveLines((items) => items.map((item, i) => i === index ? { ...item, [key]: event.target.value } : item))}/></td>)}<td className="p-1"><input className="w-36 rounded-lg border px-2 py-1" value={line.discrepancy_description} onChange={(event) => setReceiveLines((items) => items.map((item, i) => i === index ? { ...item, discrepancy_description: event.target.value } : item))}/></td></tr>; })}</tbody></table></div>
          <button className={button}>ثبت مقادیر تحویل و اختلاف</button>
        </form>}
      </div>
    </section>
  );
}

export function TreasuryParityPanel({ orgId, onToast }: { orgId: string | null; onToast: Toast }) {
  const [accounts, setAccounts] = useState<Row[]>([]);
  const [cheques, setCheques] = useState<Row[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [editingCheque, setEditingCheque] = useState<Row | null>(null);
  const [newCheque, setNewCheque] = useState({ cheque_number: "", serial_number: "", bank_name: "", amount: "0.00", issue_date_jalali: "", due_date_jalali: "", direction: "RECEIVABLE", drawer_name: "", recipient_name: "", notes: "", as_draft: false });
  const [transactions, setTransactions] = useState<Row[]>([]);
  const [filters, setFilters] = useState({ date_from: "", date_to: "", tx_type: "" });
  const [editingId, setEditingId] = useState("");
  const [form, setForm] = useState({ name: "", account_type: "BANK", bank_name: "", account_number: "", iban: "", opening_balance: "0.00", is_active: true });
  const [busy, setBusy] = useState(false);

  const reloadAccounts = useCallback(async () => {
    if (!orgId) return;
    try {
      const [list, chequeList] = await Promise.all([
        apiFetch<Row[]>("/api/v1/treasury/accounts", { organizationId: orgId }),
        apiFetch<Row[]>("/api/v1/cheques?per_page=100", { organizationId: orgId }),
      ]);
      setAccounts(rows(list));
      setCheques(rows(chequeList));
      setSelectedId((current) => current || text(list[0]?.id));
    } catch (error) { onToast(error instanceof Error ? error.message : "دریافت حساب‌های خزانه ناموفق بود", "error"); }
  }, [orgId, onToast]);
  useEffect(() => { void reloadAccounts(); }, [reloadAccounts]);

  const loadHistory = useCallback(async () => {
    if (!orgId || !selectedId) { setTransactions([]); return; }
    setBusy(true);
    try {
      const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => Boolean(value)));
      const result = await apiFetch<Row>(`/api/v1/treasury/accounts/${selectedId}/transactions${query.size ? `?${query}` : ""}`, { organizationId: orgId });
      setTransactions(rows(result.transactions));
    } catch (error) { onToast(error instanceof Error ? error.message : "دریافت گردش حساب ناموفق بود", "error"); }
    finally { setBusy(false); }
  }, [orgId, selectedId, filters, onToast]);
  useEffect(() => { void loadHistory(); }, [loadHistory]);

  function selectAccount(account: Row) {
    setSelectedId(text(account.id));
    setEditingId(text(account.id));
    setForm({ name: text(account.name), account_type: text(account.accountType ?? account.account_type, "BANK"), bank_name: text(account.bankName ?? account.bank_name), account_number: text(account.accountNumber ?? account.account_number), iban: text(account.iban), opening_balance: text(account.openingBalance ?? account.opening_balance, "0.00"), is_active: Boolean(account.isActive ?? account.is_active ?? true) });
  }

  async function saveAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!orgId) return;
    try {
      if (editingId) {
        await apiFetch(`/api/v1/treasury/accounts/${editingId}`, { method: "PATCH", organizationId: orgId, body: JSON.stringify({ name: form.name, bank_name: form.bank_name || null, account_number: form.account_number || null, iban: form.iban || null, is_active: form.is_active }) });
        onToast("مشخصات حساب خزانه بروزرسانی شد. مانده و گردش‌های تاریخی دست‌نخورده ماندند.");
      } else {
        const created = await apiFetch<Row>("/api/v1/treasury/accounts", { method: "POST", organizationId: orgId, body: JSON.stringify({ name: form.name, account_type: form.account_type, bank_name: form.bank_name || undefined, account_number: form.account_number || undefined, iban: form.iban || undefined, currency: "IRR", opening_balance: form.opening_balance }) });
        onToast("حساب خزانه و سند افتتاحیهٔ متناظر ثبت شد."); setSelectedId(text(created.id));
      }
      await reloadAccounts();
    } catch (error) { onToast(error instanceof Error ? error.message : "ذخیره حساب خزانه ناموفق بود", "error"); }
  }

  function newAccount() {
    setEditingId("");
    setForm({ name: "", account_type: "BANK", bank_name: "", account_number: "", iban: "", opening_balance: "0.00", is_active: true });
  }

  function toJalaliDate(value: unknown) {
    const iso = text(value).slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? gregorianIsoToJalali(iso) : "";
  }

  async function loadChequeForEdit(id: string) {
    if (!orgId) return;
    try {
      const cheque = await apiFetch<Row>(`/api/v1/cheques/${id}`, { organizationId: orgId });
      const initial = {
        cheque_number: text(cheque.sayadId ?? cheque.cheque_number), serial_number: text(cheque.serialNumber ?? cheque.serial_number),
        bank_name: text(cheque.bankName ?? cheque.bank_name), branch_name: text(cheque.branchName ?? cheque.branch_name),
        amount: text(cheque.amount), issue_date_jalali: toJalaliDate(cheque.issueDate ?? cheque.issue_date),
        due_date_jalali: toJalaliDate(cheque.dueDate ?? cheque.due_date),
        drawer_name: text(cheque.drawerName ?? cheque.drawer_name), recipient_name: text(cheque.recipientName ?? cheque.recipient_name), notes: text(cheque.notes),
      };
      setEditingCheque({ id: text(cheque.id), version: Number(cheque.version ?? 1), ...initial, original: initial, status: text(cheque.status), correction_reason: "" });
    } catch (error) { onToast(error instanceof Error ? error.message : "بازخوانی چک ناموفق بود", "error"); }
  }

  async function createCheque(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!orgId) return;
    try {
      await apiFetch("/api/v1/cheques", { method: "POST", organizationId: orgId, headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify(newCheque) });
      onToast("چک ثبت و رویداد حسابداری آن در دفتر ثبت شد.");
      setNewCheque({ cheque_number: "", serial_number: "", bank_name: "", amount: "0.00", issue_date_jalali: "", due_date_jalali: "", direction: "RECEIVABLE", drawer_name: "", recipient_name: "", notes: "", as_draft: false });
      await reloadAccounts();
    } catch (error) { onToast(error instanceof Error ? error.message : "ثبت چک ناموفق بود", "error"); }
  }

  async function saveCheque(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!orgId || !editingCheque) return;
    const original = (editingCheque.original ?? {}) as Row;
    const changed: Row = {};
    const keys = ["amount", "cheque_number", "serial_number", "bank_name", "branch_name", "drawer_name", "recipient_name", "issue_date_jalali", "due_date_jalali"] as const;
    for (const key of keys) if (text(editingCheque[key]) !== text(original[key])) changed[key] = text(editingCheque[key]);
    const financialChange = ["amount", "cheque_number", "bank_name", "issue_date_jalali", "due_date_jalali"].some((key) => key in changed);
    const settled = ["CLEARED", "CASHED", "CANCELLED"].includes(text(editingCheque.status));
    if (settled && financialChange) { onToast("چک تسویه‌شده است؛ مبلغ، شماره، بانک و تاریخ‌های مالی آن قابل اصلاح نیست.", "error"); return; }
    if (text(editingCheque.status) !== "DRAFT" && financialChange && text(editingCheque.correction_reason).trim().length < 5) { onToast("برای اصلاح فیلد مالی چک ثبت‌شده، دلیل حداقل ۵ نویسه‌ای لازم است.", "error"); return; }
    try {
      await apiFetch(`/api/v1/cheques/${text(editingCheque.id)}`, {
        method: "PATCH", organizationId: orgId,
        body: JSON.stringify({ ...changed, ...(text(editingCheque.notes) !== text(original.notes) ? { notes: text(editingCheque.notes) || null } : {}), correction_reason: text(editingCheque.correction_reason), version: Number(editingCheque.version) }),
      });
      onToast("چک با کنترل نسخه ذخیره شد؛ سند اصلاحی و ردپای حسابرسی توسط سرور ثبت شد.");
      setEditingCheque(null); await reloadAccounts();
    } catch (error) { onToast(error instanceof Error ? error.message : "اصلاح چک ناموفق بود", "error"); }
  }

  const selected = accounts.find((account) => text(account.id) === selectedId);
  const editingOriginal = (editingCheque?.original ?? {}) as Row;
  const editingFinancialChange = Boolean(editingCheque && ["amount", "cheque_number", "bank_name", "issue_date_jalali", "due_date_jalali"].some((key) => text(editingCheque[key]) !== text(editingOriginal[key])));
  const editingSettled = Boolean(editingCheque && ["CLEARED", "CASHED", "CANCELLED"].includes(text(editingCheque.status)));

  return (
    <section className="space-y-4 border-t border-slate-200 pt-5">
      <div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="text-sm font-bold">مدیریت حساب خزانه و تاریخچه تراکنش‌ها</h3><p className="mt-1 text-xs text-slate-500">مانده از گردش‌های ثبت‌شده محاسبه می‌شود؛ ویرایش فقط مشخصات حساب را تغییر می‌دهد.</p></div><button type="button" onClick={newAccount} className={button}>افزودن حساب جدید</button></div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[.9fr_1.1fr]">
        <div className="space-y-2">{accounts.map((account) => <button key={text(account.id)} type="button" onClick={() => selectAccount(account)} className={`flex w-full items-center justify-between gap-2 rounded-2xl border p-4 text-right ${selectedId === text(account.id) ? "border-emerald-400 bg-emerald-50" : "border-slate-200 bg-white"}`}><span><strong className="block text-xs">{text(account.name)}</strong><small className="text-slate-500">{text(account.accountType ?? account.account_type)} • {text(account.bankName ?? account.bank_name, "بدون بانک")}</small></span><strong className="text-xs tabular-nums">{formatIrr(text(account.balance))} ریال</strong></button>)}</div>
        <form onSubmit={saveAccount} className={`${card} grid grid-cols-1 gap-2 sm:grid-cols-2`}>
          <h4 className="sm:col-span-2 text-xs font-bold">{editingId ? "ویرایش مشخصات حساب" : "افزودن حساب خزانه"}</h4>
          <label className="text-[11px]">نام حساب<input className={`${field} mt-1`} required minLength={2} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })}/></label>
          {!editingId && <label className="text-[11px]">نوع حساب<select className={`${field} mt-1`} value={form.account_type} onChange={(event) => setForm({ ...form, account_type: event.target.value })}><option value="CASH">صندوق نقدی</option><option value="BANK">بانکی</option><option value="CARD_TERMINAL">کارت‌خوان</option><option value="WALLET">کیف پول</option><option value="OTHER_TREASURY">سایر</option></select></label>}
          <label className="text-[11px]">نام بانک<input className={`${field} mt-1`} value={form.bank_name} onChange={(event) => setForm({ ...form, bank_name: event.target.value })}/></label><label className="text-[11px]">شماره حساب<input className={`${field} mt-1`} dir="ltr" value={form.account_number} onChange={(event) => setForm({ ...form, account_number: event.target.value })}/></label><label className="text-[11px]">شماره شبا<input className={`${field} mt-1`} dir="ltr" value={form.iban} onChange={(event) => setForm({ ...form, iban: event.target.value })}/></label>
          {!editingId && <label className="text-[11px]">مانده افتتاحیه (ریال)<input className={`${field} mt-1`} dir="ltr" inputMode="decimal" value={form.opening_balance} onChange={(event) => setForm({ ...form, opening_balance: event.target.value })}/></label>}
          {editingId && <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={form.is_active} onChange={(event) => setForm({ ...form, is_active: event.target.checked })}/>حساب فعال</label>}
          <div className="sm:col-span-2 flex items-center gap-2"><button className={button}>{editingId ? "ذخیره مشخصات" : "ایجاد حساب"}</button>{editingId && <span className="text-[11px] text-slate-500">ویرایش مانده افتتاحیه یا گردش قبلی مجاز نیست.</span>}</div>
        </form>
      </div>
      <div className={`${card} space-y-4`}>
        <h4 className="text-xs font-bold">ثبت چک و اصلاح کنترل‌شده</h4>
        <form onSubmit={createCheque} className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <input className={field} required minLength={3} placeholder="شماره صیادی" value={newCheque.cheque_number} onChange={(event) => setNewCheque({ ...newCheque, cheque_number: event.target.value })}/>
          <input className={field} required minLength={2} placeholder="شماره سریال" value={newCheque.serial_number} onChange={(event) => setNewCheque({ ...newCheque, serial_number: event.target.value })}/>
          <input className={field} required minLength={2} placeholder="بانک" value={newCheque.bank_name} onChange={(event) => setNewCheque({ ...newCheque, bank_name: event.target.value })}/>
          <input className={field} required dir="ltr" inputMode="decimal" aria-label="مبلغ چک" value={newCheque.amount} onChange={(event) => setNewCheque({ ...newCheque, amount: event.target.value })}/>
          <JalaliDatePicker value={newCheque.issue_date_jalali} onChange={(value) => setNewCheque({ ...newCheque, issue_date_jalali: value })} placeholder="تاریخ صدور شمسی" allowEmpty/>
          <JalaliDatePicker value={newCheque.due_date_jalali} onChange={(value) => setNewCheque({ ...newCheque, due_date_jalali: value })} placeholder="سررسید شمسی" allowEmpty/>
          <select className={field} value={newCheque.direction} onChange={(event) => setNewCheque({ ...newCheque, direction: event.target.value })}><option value="RECEIVABLE">چک دریافتی</option><option value="PAYABLE">چک پرداختی</option></select>
          <input className={field} placeholder="صادرکننده" value={newCheque.drawer_name} onChange={(event) => setNewCheque({ ...newCheque, drawer_name: event.target.value })}/>
          <input className={field} placeholder="گیرنده" value={newCheque.recipient_name} onChange={(event) => setNewCheque({ ...newCheque, recipient_name: event.target.value })}/>
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={newCheque.as_draft} onChange={(event) => setNewCheque({ ...newCheque, as_draft: event.target.checked })}/>ذخیره به صورت پیش‌نویس</label>
          <button className={button}>ثبت چک</button>
        </form>
        <div className="max-h-48 space-y-2 overflow-auto">{cheques.map((cheque) => <div key={text(cheque.id)} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-100 p-3 text-xs"><div><strong>{text(cheque.bank_name)} • {text(cheque.cheque_number)}</strong><span className="mx-2 rounded-full bg-slate-100 px-2 py-0.5">{text(cheque.status)}</span><div className="mt-1 text-slate-500">{formatIrr(text(cheque.amount))} ریال • سررسید {toJalaliDate(cheque.due_date)}</div></div><button type="button" className="rounded-lg border border-slate-200 px-3 py-1.5" onClick={() => void loadChequeForEdit(text(cheque.id))}>ویرایش کنترل‌شده</button></div>)}</div>
        {editingCheque && <form onSubmit={saveCheque} className="grid grid-cols-1 gap-2 rounded-xl border border-amber-200 bg-amber-50/50 p-4 sm:grid-cols-3">
          <div className="sm:col-span-3 flex justify-between text-xs"><strong>ویرایش چک • نسخه {text(editingCheque.version)} • وضعیت {text(editingCheque.status)}</strong><button type="button" className="underline" onClick={() => setEditingCheque(null)}>بستن</button></div>
          {([ ["cheque_number", "شماره صیادی"], ["serial_number", "شماره سریال"], ["bank_name", "بانک"], ["amount", "مبلغ"], ["issue_date_jalali", "تاریخ صدور شمسی"], ["due_date_jalali", "سررسید شمسی"], ["branch_name", "شعبه"], ["drawer_name", "صادرکننده"], ["recipient_name", "گیرنده"] ] as const).map(([key, label]) => <label key={key} className="text-[11px]">{label}{key === "issue_date_jalali" || key === "due_date_jalali" ? <JalaliDatePicker className="mt-1" value={text(editingCheque[key])} onChange={(value) => setEditingCheque({ ...editingCheque, [key]: value })} disabled={editingSettled}/> : <input className={`${field} mt-1`} dir={key === "amount" ? "ltr" : undefined} disabled={editingSettled && ["cheque_number", "bank_name", "amount"].includes(key)} value={text(editingCheque[key])} onChange={(event) => setEditingCheque({ ...editingCheque, [key]: event.target.value })}/>}</label>)}
          <label className="sm:col-span-2 text-[11px]">دلیل اصلاح (برای فیلد مالی چک ثبت‌شده، حداقل ۵ نویسه)<input className={`${field} mt-1`} required={editingFinancialChange && text(editingCheque.status) !== "DRAFT"} minLength={editingFinancialChange && text(editingCheque.status) !== "DRAFT" ? 5 : undefined} value={text(editingCheque.correction_reason)} onChange={(event) => setEditingCheque({ ...editingCheque, correction_reason: event.target.value })}/></label>
          <button className={button}>ذخیره با کنترل نسخه و ثبت حسابرسی</button>
        </form>}
      </div>
      <div className={`${card} space-y-3`}>
        <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-xs font-bold">{text(selected?.name, "حساب")} • مانده فعلی {formatIrr(text(selected?.balance))} ریال</h4><button type="button" className="rounded-xl border border-slate-200 px-3 py-2 text-xs" onClick={() => void loadHistory()}>{busy ? "در حال دریافت…" : "اعمال فیلتر"}</button></div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3"><label className="text-[11px]">از تاریخ<JalaliDatePicker className="mt-1" value={filters.date_from} onChange={(value) => setFilters({ ...filters, date_from: value })} format="iso" placeholder="از تاریخ شمسی" allowEmpty/></label><label className="text-[11px]">تا تاریخ<JalaliDatePicker className="mt-1" value={filters.date_to} onChange={(value) => setFilters({ ...filters, date_to: value })} format="iso" placeholder="تا تاریخ شمسی" allowEmpty/></label><label className="text-[11px]">نوع تراکنش<select className={`${field} mt-1`} value={filters.tx_type} onChange={(event) => setFilters({ ...filters, tx_type: event.target.value })}><option value="">همه</option><option value="RECEIPT">دریافت</option><option value="PAYMENT">پرداخت</option><option value="TRANSFER">انتقال</option><option value="EXPENSE">هزینه</option><option value="INCOME">درآمد</option></select></label></div>
        <div className="overflow-x-auto"><table className="w-full min-w-[650px] text-right text-xs"><thead><tr className="border-b text-slate-500"><th className="p-2">تاریخ شمسی</th><th className="p-2">نوع</th><th className="p-2">روش</th><th className="p-2">شرح / پیگیری</th><th className="p-2">مبلغ (ریال)</th></tr></thead><tbody>{transactions.map((tx, index) => <tr key={text(tx.id, String(index))} className="border-b border-slate-100"><td className="p-2">{text(tx.tx_date_jalali ?? tx.txDate ?? tx.tx_date)}</td><td className="p-2">{text(tx.txType ?? tx.tx_type)}</td><td className="p-2">{text(tx.paymentMethod ?? tx.payment_method)}</td><td className="p-2">{text(tx.description)} {text(tx.trackingNumber ?? tx.tracking_number) && `• ${text(tx.trackingNumber ?? tx.tracking_number)}`}</td><td className="p-2 font-semibold tabular-nums">{formatIrr(text(tx.amount))}</td></tr>)}</tbody></table>{!transactions.length && <div className="py-4 text-center text-xs text-slate-500">تراکنشی مطابق فیلتر انتخاب‌شده پیدا نشد.</div>}</div>
      </div>
    </section>
  );
}

type ReturnLineDraft = {
  original_item_id: string;
  product_id: string;
  product_variant_id: string | null;
  product_name: string;
  quantity: string;
  accepted_quantity: string;
  damaged_quantity: string;
  physically_received: boolean;
  warehouse_id: string;
  unit_price: string;
  reason: string;
};

type ReturnDraft = { type: "sales" | "purchases"; invoice: Row; lines: ReturnLineDraft[]; notes: string; return_date_jalali: string };

export function CommerceParityPanel({
  orgId,
  contacts,
  products,
  warehouses,
  sales,
  purchases,
  onToast,
  onRefresh,
}: {
  orgId: string | null;
  contacts: Row[];
  products: Row[];
  warehouses: Row[];
  sales: Row[];
  purchases: Row[];
  onToast: Toast;
  onRefresh: () => void;
}) {
  const [purchase, setPurchase] = useState({ supplier_id: "", warehouse_id: "", product_id: "", quantity: "1.0000", unit_price: "0.00", document_date_jalali: jalaliToday() });
  const [returnDraft, setReturnDraft] = useState<ReturnDraft | null>(null);
  const suppliers = useMemo(() => contacts.filter((item) => ["SUPPLIER", "VENDOR"].includes(text(item.type ?? item.contactType).toUpperCase())), [contacts]);
  const returnable = (status: unknown) => ["CONFIRMED", "FINALIZED", "PARTIALLY_RETURNED"].includes(text(status));

  useEffect(() => {
    setPurchase((current) => ({
      ...current,
      supplier_id: current.supplier_id || text(suppliers[0]?.id),
      warehouse_id: current.warehouse_id || text(warehouses[0]?.id),
      product_id: current.product_id || text(products[0]?.id),
      unit_price: current.unit_price === "0.00" ? text(products[0]?.purchase_price, "0.00") : current.unit_price,
    }));
  }, [suppliers, warehouses, products]);

  async function createPurchase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!orgId) return;
    try {
      await apiFetch("/api/v1/purchases", {
        method: "POST", organizationId: orgId, headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ supplier_id: purchase.supplier_id, warehouse_id: purchase.warehouse_id, document_date_jalali: purchase.document_date_jalali, items: [{ product_id: purchase.product_id, quantity: purchase.quantity, unit_price: purchase.unit_price }] }),
      });
      onToast("پیش‌نویس خرید ساخته شد؛ پس از تأیید، ورود انبار و سند حسابداری به‌صورت اتمیک ثبت می‌شود.");
      onRefresh();
    } catch (error) { onToast(error instanceof Error ? error.message : "ایجاد فاکتور خرید ناموفق بود", "error"); }
  }

  async function openReturn(type: "sales" | "purchases", invoice: Row) {
    if (!orgId) return;
    try {
      const detail = await apiFetch<Row>(`/api/v1/${type}/${text(invoice.id)}`, { organizationId: orgId });
      const invoiceItems = rows(detail.items);
      if (!invoiceItems.length) throw new Error("فاکتور آیتم قابل برگشت ندارد.");
      setReturnDraft({
        type,
        invoice: detail,
        notes: `برگشت از فاکتور ${text(detail.invoiceNumber ?? detail.document_number)}`,
        return_date_jalali: jalaliToday(),
        lines: invoiceItems.map((item) => ({
          original_item_id: text(item.id),
          product_id: text(item.productId ?? item.product_id),
          product_variant_id: text(item.variantId ?? item.variant_id) || null,
          product_name: text(item.product_name ?? item.productName ?? products.find((product) => text(product.id) === text(item.productId ?? item.product_id))?.name, "کالا"),
          quantity: text(item.quantity),
          accepted_quantity: text(item.quantity),
          damaged_quantity: "0.0000",
          physically_received: true,
          warehouse_id: text(detail.warehouseId ?? detail.warehouse_id ?? invoice.warehouse_id),
          unit_price: text(item.unitPrice ?? item.unit_price),
          reason: "",
        })),
      });
    } catch (error) { onToast(error instanceof Error ? error.message : "بازخوانی فاکتور ناموفق بود", "error"); }
  }

  async function submitReturn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!orgId || !returnDraft) return;
    try {
      const bodyItems = returnDraft.lines.filter((line) => Number(line.quantity) > 0).map(({ product_name: _name, ...line }) => line);
      await apiFetch(`/api/v1/${returnDraft.type}/${text(returnDraft.invoice.id)}/return`, {
        method: "POST", organizationId: orgId, headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ notes: returnDraft.notes, return_date_jalali: returnDraft.return_date_jalali, items: bodyItems }),
      });
      onToast(returnDraft.type === "sales" ? "برگشت فروش ثبت شد؛ کالای سالم به انبار و سند تعدیل به دفتر حسابداری اضافه شد." : "برگشت خرید ثبت شد؛ گردش انبار و حساب تأمین‌کننده بروزرسانی شد.");
      setReturnDraft(null); onRefresh();
    } catch (error) { onToast(error instanceof Error ? error.message : "ثبت برگشت فاکتور ناموفق بود", "error"); }
  }

  const invoiceName = (invoice: Row, type: "sales" | "purchases") => `${text(invoice.document_number)} — ${text(type === "sales" ? invoice.customer_name : invoice.supplier_name)}`;

  return (
    <section className="space-y-4 border-t border-slate-200 pt-5">
      <div><h3 className="text-sm font-bold">خرید و برگشت‌های تجاری</h3><p className="mt-1 text-xs text-slate-500">خرید دستی، برگشت جزئی یا کامل و ثبت اثر مالی/انبار از مسیر رسمی فاکتور</p></div>
      <form onSubmit={createPurchase} className={`${card} grid grid-cols-1 gap-2 sm:grid-cols-3 lg:grid-cols-7`}>
        <h4 className="sm:col-span-3 lg:col-span-7 text-xs font-bold">ایجاد فاکتور خرید</h4>
        <select className={field} required value={purchase.supplier_id} onChange={(event) => setPurchase({ ...purchase, supplier_id: event.target.value })}><option value="">تأمین‌کننده</option>{suppliers.map((item) => <option key={text(item.id)} value={text(item.id)}>{text(item.display_name ?? item.name)}</option>)}</select>
        <select className={field} required value={purchase.warehouse_id} onChange={(event) => setPurchase({ ...purchase, warehouse_id: event.target.value })}><option value="">انبار مقصد</option>{warehouses.map((item) => <option key={text(item.id)} value={text(item.id)}>{text(item.name)}</option>)}</select>
        <select className={field} required value={purchase.product_id} onChange={(event) => { const product = products.find((item) => text(item.id) === event.target.value); setPurchase({ ...purchase, product_id: event.target.value, unit_price: text(product?.purchase_price, purchase.unit_price) }); }}><option value="">کالا</option>{products.map((item) => <option key={text(item.id)} value={text(item.id)}>{text(item.name)}</option>)}</select>
        <input className={field} required dir="ltr" inputMode="decimal" aria-label="تعداد خرید" value={purchase.quantity} onChange={(event) => setPurchase({ ...purchase, quantity: event.target.value })}/>
        <input className={field} required dir="ltr" inputMode="decimal" aria-label="قیمت خرید" value={purchase.unit_price} onChange={(event) => setPurchase({ ...purchase, unit_price: event.target.value })}/>
        <label className="text-[11px]">تاریخ فاکتور شمسی<JalaliDatePicker className="mt-1" value={purchase.document_date_jalali} onChange={(value) => setPurchase({ ...purchase, document_date_jalali: value })}/></label>
        <button className={button}>ثبت پیش‌نویس خرید</button>
      </form>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {([["sales", sales], ["purchases", purchases]] as const).map(([type, invoices]) => <div key={type} className={`${card} space-y-2`}><h4 className="text-xs font-bold">برگشت {type === "sales" ? "از فروش" : "از خرید"}</h4>{invoices.filter((invoice) => returnable(invoice.status)).map((invoice) => <div key={text(invoice.id)} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-100 p-3 text-xs"><span>{invoiceName(invoice, type)} • {formatIrr(text(invoice.grand_total))} ریال</span><button className="rounded-lg border border-slate-200 px-3 py-1.5" type="button" onClick={() => void openReturn(type, invoice)}>ثبت برگشت</button></div>)}{!invoices.some((invoice) => returnable(invoice.status)) && <div className="text-xs text-slate-500">فاکتور قطعیِ قابل برگشت ندارید.</div>}</div>)}
      </div>
      {returnDraft && <form onSubmit={submitReturn} className={`${card} space-y-3 border-amber-200`}>
        <div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-xs">برگشت {returnDraft.type === "sales" ? "فروش" : "خرید"} • {invoiceName(returnDraft.invoice, returnDraft.type)}</strong><button type="button" className="text-xs underline" onClick={() => setReturnDraft(null)}>بستن</button></div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2"><label className="text-[11px]">تاریخ برگشت شمسی<JalaliDatePicker className="mt-1" value={returnDraft.return_date_jalali} onChange={(value) => setReturnDraft({ ...returnDraft, return_date_jalali: value })}/></label><label className="text-[11px]">شرح برگشت<input className={`${field} mt-1`} required value={returnDraft.notes} onChange={(event) => setReturnDraft({ ...returnDraft, notes: event.target.value })}/></label></div>
        <div className="overflow-x-auto"><table className="w-full min-w-[800px] text-right text-xs"><thead><tr className="border-b text-slate-500"><th className="p-2">کالا</th><th className="p-2">تعداد برگشتی</th>{returnDraft.type === "sales" && <><th className="p-2">سالم</th><th className="p-2">آسیب‌دیده</th><th className="p-2">به انبار رسیده</th></>}</tr></thead><tbody>{returnDraft.lines.map((line, index) => <tr key={line.original_item_id} className="border-b border-slate-100"><td className="p-2">{line.product_name} • {formatIrr(line.unit_price)} ریال</td><td className="p-2"><input className="w-28 rounded-lg border px-2 py-1" required dir="ltr" inputMode="decimal" value={line.quantity} onChange={(event) => setReturnDraft({ ...returnDraft, lines: returnDraft.lines.map((item, i) => i === index ? { ...item, quantity: event.target.value } : item) })}/></td>{returnDraft.type === "sales" && <><td className="p-2"><input className="w-24 rounded-lg border px-2 py-1" dir="ltr" inputMode="decimal" value={line.accepted_quantity} onChange={(event) => setReturnDraft({ ...returnDraft, lines: returnDraft.lines.map((item, i) => i === index ? { ...item, accepted_quantity: event.target.value } : item) })}/></td><td className="p-2"><input className="w-24 rounded-lg border px-2 py-1" dir="ltr" inputMode="decimal" value={line.damaged_quantity} onChange={(event) => setReturnDraft({ ...returnDraft, lines: returnDraft.lines.map((item, i) => i === index ? { ...item, damaged_quantity: event.target.value } : item) })}/></td><td className="p-2"><input type="checkbox" checked={line.physically_received} onChange={(event) => setReturnDraft({ ...returnDraft, lines: returnDraft.lines.map((item, i) => i === index ? { ...item, physically_received: event.target.checked } : item) })}/></td></>}</tr>)}</tbody></table></div>
        <button className={button}>ثبت برگشت و صدور اسناد</button>
      </form>}
    </section>
  );
}

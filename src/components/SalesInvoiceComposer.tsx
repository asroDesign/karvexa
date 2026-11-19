"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { JalaliDatePicker } from "@/components/JalaliDatePicker";
import { ProductPickerModal } from "@/components/ProductPickerModal";
import { apiFetch, formatIrr } from "@/lib/format";
import { currentJalaliDate } from "@/lib/jalali";

type Row = Record<string, unknown>;
type Toast = (message: string, type?: "success" | "error") => void;
type InvoiceLine = { id: string; product_id: string; variant_id: string; quantity: string; unit_price: string; discount_amount: string; tax_rate: string };
type PaymentLine = { id: string; payment_method: string; financial_account_id: string; amount: string; reference_number: string };

const value = (item: unknown, fallback = "") => item == null ? fallback : String(item);
const digits = (raw: string) => raw.replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0)).replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660));
const numberValue = (raw: string) => {
  const normalized = digits(raw).trim().replace(/[٬,]/g, "").replace(/٫/g, ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
};
const moneyString = (raw: string, fallback = "0.00") => {
  const normalized = digits(raw).trim().replace(/[٬,]/g, "").replace(/٫/g, ".");
  if (!normalized) return fallback;
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) throw new Error("مبلغ‌ها را با حداکثر دو رقم اعشار وارد کنید.");
  return normalized;
};
const signedMoneyString = (raw: string) => {
  const normalized = digits(raw).trim().replace(/[٬,]/g, "").replace(/٫/g, ".");
  if (!normalized) return "0.00";
  if (!/^-?\d+(\.\d{1,2})?$/.test(normalized)) throw new Error("تعدیل رندکردن باید عددی با حداکثر دو رقم اعشار باشد.");
  return normalized;
};
const quantityString = (raw: string) => {
  const normalized = digits(raw).trim().replace(/[٬,]/g, "").replace(/٫/g, ".");
  if (!/^\d+(\.\d{1,4})?$/.test(normalized) || Number(normalized) <= 0) throw new Error("تعداد هر کالا باید بزرگ‌تر از صفر و حداکثر چهار رقم اعشار داشته باشد.");
  return normalized;
};
const lineDraft = (): InvoiceLine => ({ id: crypto.randomUUID(), product_id: "", variant_id: "", quantity: "1", unit_price: "0.00", discount_amount: "0.00", tax_rate: "0.00" });

const paymentOptions = [
  ["CASH", "نقد"], ["POS", "کارت‌خوان (POS)"], ["BANK_TRANSFER", "انتقال بانکی"],
  ["CARD_TERMINAL", "کارت‌خوان بانکی"], ["CHEQUE", "چک"], ["CREDIT", "نسیه"],
  ["ACCOUNT_BALANCE", "از مانده حساب"], ["WALLET", "کیف پول"], ["OTHER", "سایر"],
] as const;

export function SalesInvoiceComposer({
  orgId,
  onToast,
  onRefresh,
  title = "ثبت سریع فاکتور فروش",
}: {
  orgId: string | null;
  onToast: Toast;
  onRefresh?: () => void;
  title?: string;
}) {
  const [contacts, setContacts] = useState<Row[]>([]);
  const [products, setProducts] = useState<Row[]>([]);
  const [warehouses, setWarehouses] = useState<Row[]>([]);
  const [variants, setVariants] = useState<Row[]>([]);
  const [accounts, setAccounts] = useState<Row[]>([]);
  const [customerId, setCustomerId] = useState("");
  const [warehouseId, setWarehouseId] = useState("");
  const [documentDate, setDocumentDate] = useState(currentJalaliDate());
  const [dueDate, setDueDate] = useState("");
  const [lines, setLines] = useState<InvoiceLine[]>([lineDraft()]);
  const [discountTotal, setDiscountTotal] = useState("0.00");
  const [taxMode, setTaxMode] = useState<"AUTO" | "OVERRIDE">("AUTO");
  const [taxOverride, setTaxOverride] = useState("0.00");
  const [shippingCost, setShippingCost] = useState("0.00");
  const [otherCosts, setOtherCosts] = useState("0.00");
  const [roundingAdjustment, setRoundingAdjustment] = useState("0.00");
  const [notes, setNotes] = useState("");
  const [receiptUrl, setReceiptUrl] = useState("");
  const [payments, setPayments] = useState<PaymentLine[]>([]);
  const [paymentDraft, setPaymentDraft] = useState({ payment_method: "CASH", financial_account_id: "", amount: "", reference_number: "" });
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);

  const loadReferences = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    try {
      const [contactRows, productRows, warehouseRows, variantResponse, accountRows] = await Promise.all([
        apiFetch<Row[]>("/api/v1/contacts?per_page=200", { organizationId: orgId }),
        apiFetch<Row[]>("/api/v1/products?per_page=200", { organizationId: orgId }),
        apiFetch<Row[]>("/api/v1/warehouses?per_page=100", { organizationId: orgId }),
        apiFetch<Row>("/api/v1/variants?per_page=200", { organizationId: orgId }),
        apiFetch<Row[]>("/api/v1/treasury/accounts", { organizationId: orgId }),
      ]);
      const activeContacts = contactRows.filter((item) => Boolean(item.is_active ?? true));
      const activeProducts = productRows.filter((item) => Boolean(item.is_active ?? true));
      const activeWarehouses = warehouseRows.filter((item) => Boolean(item.is_active ?? true));
      const variantRows = Array.isArray(variantResponse) ? variantResponse : Array.isArray(variantResponse.variants) ? variantResponse.variants as Row[] : [];
      setContacts(activeContacts);
      setProducts(activeProducts);
      setWarehouses(activeWarehouses);
      setVariants(variantRows);
      setAccounts(accountRows.filter((item) => Boolean(item.is_active ?? item.isActive ?? true)));
      setCustomerId((current) => current || value(activeContacts.find((item) => value(item.type).toUpperCase() === "CUSTOMER")?.id, value(activeContacts[0]?.id)));
      setWarehouseId((current) => current || value(activeWarehouses.find((item) => Boolean(item.is_default ?? item.isDefault))?.id, value(activeWarehouses[0]?.id)));
      setPaymentDraft((current) => ({ ...current, financial_account_id: current.financial_account_id || value(accountRows[0]?.id) }));
    } catch (error) {
      onToast(error instanceof Error ? error.message : "دریافت اطلاعات فاکتور فروش ناموفق بود", "error");
    } finally {
      setLoading(false);
    }
  }, [orgId, onToast]);

  useEffect(() => { void loadReferences(); }, [loadReferences]);

  const subtotal = lines.reduce((sum, line) => sum + numberValue(line.quantity) * numberValue(line.unit_price), 0);
  const lineDiscounts = lines.reduce((sum, line) => sum + numberValue(line.discount_amount), 0);
  const taxableSubtotal = Math.max(0, subtotal - lineDiscounts);
  const headerDiscount = Math.min(taxableSubtotal, numberValue(discountTotal));
  const headerTaxBase = Math.max(0, taxableSubtotal - headerDiscount);
  const calculatedLineTax = lines.reduce((sum, line) => {
    const gross = numberValue(line.quantity) * numberValue(line.unit_price);
    const taxable = Math.max(0, gross - numberValue(line.discount_amount));
    return sum + taxable * numberValue(line.tax_rate) / 100;
  }, 0);
  const automaticTax = taxableSubtotal > 0 ? calculatedLineTax * (headerTaxBase / taxableSubtotal) : 0;
  const invoiceTax = taxMode === "OVERRIDE" ? numberValue(taxOverride) : automaticTax;
  const grandTotal = Math.max(0, subtotal - lineDiscounts - headerDiscount + invoiceTax + numberValue(shippingCost) + numberValue(otherCosts) + numberValue(roundingAdjustment));
  const allocatedTotal = payments.reduce((sum, payment) => sum + numberValue(payment.amount), 0);
  const creditRemainder = Math.max(0, grandTotal - allocatedTotal);

  function updateLine(id: string, changes: Partial<InvoiceLine>) {
    setLines((current) => current.map((line) => line.id === id ? { ...line, ...changes } : line));
  }

  function addPayment() {
    const amount = numberValue(paymentDraft.amount) || Math.max(0, grandTotal - allocatedTotal);
    if (amount <= 0) { onToast("مبلغ پرداختی باید بزرگ‌تر از صفر باشد.", "error"); return; }
    if (allocatedTotal + amount > grandTotal + 0.005) { onToast("جمع پرداخت‌ها نمی‌تواند از مبلغ فاکتور بیشتر باشد.", "error"); return; }
    setPayments((current) => [...current, { ...paymentDraft, id: crypto.randomUUID(), amount: amount.toFixed(2) }]);
    setPaymentDraft((current) => ({ ...current, amount: "", reference_number: "" }));
  }

  async function saveQuotation() {
    if (!orgId || !customerId || !warehouseId) {
      onToast("مشتری و انبار پیش‌فاکتور را انتخاب کنید.", "error");
      return;
    }
    const validLines = lines.filter((line) => line.product_id);
    if (!validLines.length) {
      onToast("دست‌کم یک کالا به پیش‌فاکتور اضافه کنید.", "error");
      return;
    }
    try {
      await apiFetch("/api/v1/quotations", {
        method: "POST",
        organizationId: orgId,
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          customer_id: customerId,
          warehouse_id: warehouseId,
          items: validLines.map((line) => ({
            product_id: line.product_id,
            quantity: quantityString(line.quantity),
            unit_price: moneyString(line.unit_price),
          })),
        }),
      });
      onToast("پیش‌فاکتور چندقلمی ذخیره شد؛ موجودی و حسابداری هنوز تغییر نکرده‌اند.");
      onRefresh?.();
    } catch (error) {
      onToast(error instanceof Error ? error.message : "ذخیره پیش‌فاکتور ناموفق بود", "error");
    }
  }

  async function saveInvoice(finalizeImmediately: boolean) {
    if (!orgId || busy) return;
    if (!customerId || !warehouseId) { onToast("مشتری و انبار فاکتور را انتخاب کنید.", "error"); return; }
    const validLines = lines.filter((line) => line.product_id);
    if (!validLines.length) { onToast("دست‌کم یک کالا به فاکتور اضافه کنید.", "error"); return; }
    if (numberValue(discountTotal) > taxableSubtotal) { onToast("تخفیف کل از مبلغ قابل تخفیف کالاها بیشتر است.", "error"); return; }
    if (allocatedTotal > grandTotal + 0.005) { onToast("جمع پرداخت‌ها نمی‌تواند از مبلغ نهایی بیشتر باشد.", "error"); return; }
    setBusy(true);
    let draftId = "";
    try {
      const invoice = await apiFetch<Row>("/api/v1/sales", {
        method: "POST",
        organizationId: orgId,
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          client_document_id: crypto.randomUUID(),
          customer_id: customerId,
          warehouse_id: warehouseId,
          document_date_jalali: documentDate,
          ...(dueDate ? { due_date_jalali: dueDate } : {}),
          rounding_adjustment: signedMoneyString(roundingAdjustment),
          discount_total: moneyString(discountTotal),
          tax_total: taxMode === "AUTO" ? "0.00" : moneyString(taxOverride),
          tax_calculation_mode: taxMode,
          shipping_cost: moneyString(shippingCost),
          other_costs: moneyString(otherCosts),
          receipt_url: receiptUrl.trim() || null,
          notes: notes.trim(),
          items: validLines.map((line) => ({
            product_id: line.product_id,
            variant_id: line.variant_id || null,
            quantity: quantityString(line.quantity),
            unit_price: moneyString(line.unit_price),
            discount_amount: moneyString(line.discount_amount),
            tax_rate: moneyString(line.tax_rate),
          })),
        }),
      });
      draftId = value(invoice.id);
      if (!draftId) throw new Error("پیش‌نویس ساخته شد اما شناسه فاکتور از سرور دریافت نشد.");
      if (finalizeImmediately) {
        const allocations = payments.filter((payment) => numberValue(payment.amount) > 0).map((payment) => ({
          financial_account_id: payment.financial_account_id || null,
          payment_method: payment.payment_method,
          amount: moneyString(payment.amount),
          reference_number: payment.reference_number.trim() || null,
        }));
        if (creditRemainder > 0.005) allocations.push({ financial_account_id: null, payment_method: "CREDIT", amount: creditRemainder.toFixed(2), reference_number: null });
        await apiFetch(`/api/v1/sales/${draftId}/confirm`, {
          method: "POST",
          organizationId: orgId,
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({ payment_allocations: allocations }),
        });
        onToast("فاکتور چندقلمی قطعی شد؛ پرداخت نقد، POS و مانده نسیه به موجودی و حسابداری ثبت شد.");
      } else {
        onToast("پیش‌نویس چندقلمی فاکتور فروش ذخیره شد.");
      }
      setLines([lineDraft()]);
      setPayments([]);
      setDiscountTotal("0.00");
      setTaxOverride("0.00");
      setShippingCost("0.00");
      setOtherCosts("0.00");
      setRoundingAdjustment("0.00");
      setDueDate("");
      setNotes("");
      setReceiptUrl("");
      onRefresh?.();
    } catch (error) {
      onRefresh?.();
      onToast(draftId ? `پیش‌نویس ${draftId.slice(0, 8)} ذخیره شد، اما تأیید کامل نشد: ${error instanceof Error ? error.message : "خطای ناشناخته"}` : (error instanceof Error ? error.message : "ثبت فاکتور فروش ناموفق بود"), "error");
    } finally {
      setBusy(false);
    }
  }

  const field = "w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs";
  const customers = useMemo(() => contacts.filter((contact) => ["CUSTOMER", "CLIENT", "PERSON", "COMPANY"].includes(value(contact.type ?? contact.contactType).toUpperCase())), [contacts]);

  return (
    <form onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void saveInvoice(false); }} className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h3 className="text-sm font-bold text-slate-900">{title}</h3><p className="mt-1 text-[11px] text-slate-500">فرم چندقلمی با جستجو و افزودن محصول، تخفیف، مالیات و تسویه ترکیبی؛ متصل به API فاکتور فروش.</p></div>
        <span className="rounded-full bg-teal-50 px-3 py-1.5 text-[10px] font-semibold text-teal-800">{loading ? "در حال دریافت داده‌ها…" : `${products.length} کالا • ${warehouses.length} انبار • ${accounts.length} حساب`}</span>
      </div>
      <div className="grid grid-cols-1 gap-3 text-xs md:grid-cols-3">
        <label>مشتری<select className={`${field} mt-1`} required value={customerId} onChange={(event) => setCustomerId(event.target.value)}><option value="">انتخاب مشتری</option>{customers.map((item) => <option key={value(item.id)} value={value(item.id)}>{value(item.display_name ?? item.displayName ?? item.name)}</option>)}</select></label>
        <label>انبار خروج<select className={`${field} mt-1`} required value={warehouseId} onChange={(event) => setWarehouseId(event.target.value)}><option value="">انتخاب انبار</option>{warehouses.map((item) => <option key={value(item.id)} value={value(item.id)}>{value(item.name)}</option>)}</select></label>
        <label>تاریخ فاکتور شمسی<JalaliDatePicker className="mt-1" value={documentDate} onChange={setDocumentDate}/></label>
        <label>سررسید شمسی<JalaliDatePicker className="mt-1" value={dueDate} onChange={setDueDate} format="iso" allowEmpty placeholder="بدون سررسید"/></label>
      </div>

      <section className="space-y-3 rounded-xl border border-slate-100 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-xs">اقلام فاکتور</strong><button type="button" onClick={() => setLines((current) => [...current, lineDraft()])} className="inline-flex items-center gap-1 rounded-lg border border-teal-200 bg-teal-50 px-3 py-2 text-[11px] font-semibold text-teal-800"><Plus className="h-3.5 w-3.5"/>افزودن قلم</button></div>
        <div className="space-y-3">
          {lines.map((line, index) => {
            const lineVariants = variants.filter((variant) => value(variant.product_id ?? variant.productId) === line.product_id);
            const gross = numberValue(line.quantity) * numberValue(line.unit_price);
            return <div key={line.id} className="grid grid-cols-1 gap-2 rounded-xl bg-slate-50 p-3 md:grid-cols-12 md:items-end">
              <div className="md:col-span-4"><label className="mb-1 block text-[10px] text-slate-500">کالا / خدمت {index + 1}</label><ProductPickerModal
                products={products}
                value={line.product_id}
                organizationId={orgId}
                onToast={onToast}
                onProductCreated={(product) => {
                  setProducts((current) => [product, ...current.filter((item) => value(item.id) !== value(product.id))]);
                  updateLine(line.id, { unit_price: value(product.sale_price ?? product.default_sale_price ?? product.defaultSalePrice, "0.00"), tax_rate: value(product.tax_rate ?? product.taxRate, "0.00") });
                }}
                onChange={(productId) => {
                  const product = products.find((item) => value(item.id) === productId);
                  updateLine(line.id, product
                    ? { product_id: productId, variant_id: "", unit_price: value(product.sale_price ?? product.default_sale_price ?? product.defaultSalePrice, "0.00"), tax_rate: value(product.tax_rate ?? product.taxRate, "0.00") }
                    : { product_id: productId, variant_id: "" });
                }}
              /></div>
              {lineVariants.length > 0 && <label className="md:col-span-2 text-[10px] text-slate-500">تنوع<select className={`${field} mt-1`} value={line.variant_id} onChange={(event) => {
                const variant = lineVariants.find((item) => value(item.id) === event.target.value);
                updateLine(line.id, { variant_id: event.target.value, unit_price: value(variant?.sale_price, line.unit_price) });
              }}><option value="">کالای پایه</option>{lineVariants.map((variant) => <option key={value(variant.id)} value={value(variant.id)}>{value(variant.variant_name ?? variant.variantName ?? variant.sku)}</option>)}</select></label>}
              <label className="md:col-span-2 text-[10px] text-slate-500">تعداد<input className={`${field} mt-1 text-left font-mono`} dir="ltr" inputMode="decimal" value={line.quantity} onChange={(event) => updateLine(line.id, { quantity: event.target.value })}/></label>
              <label className="md:col-span-2 text-[10px] text-slate-500">قیمت واحد (ریال)<input className={`${field} mt-1 text-left font-mono`} dir="ltr" inputMode="decimal" value={line.unit_price} onChange={(event) => updateLine(line.id, { unit_price: event.target.value })}/></label>
              <label className="md:col-span-1 text-[10px] text-slate-500">تخفیف ردیف<input className={`${field} mt-1 text-left font-mono`} dir="ltr" inputMode="decimal" value={line.discount_amount} onChange={(event) => updateLine(line.id, { discount_amount: event.target.value })}/></label>
              <label className="md:col-span-1 text-[10px] text-slate-500">مالیات ٪<input className={`${field} mt-1 text-left font-mono`} dir="ltr" inputMode="decimal" value={line.tax_rate} onChange={(event) => updateLine(line.id, { tax_rate: event.target.value })}/></label>
              <div className="flex items-center justify-between gap-2 text-[11px] md:col-span-12"><span className="text-slate-500">مبلغ قلم: <b className="text-slate-800">{formatIrr(Math.max(0, gross - numberValue(line.discount_amount)).toFixed(2))} ریال</b></span>{lines.length > 1 && <button type="button" aria-label="حذف قلم" onClick={() => setLines((current) => current.filter((item) => item.id !== line.id))} className="inline-flex items-center gap-1 text-rose-700"><Trash2 className="h-3.5 w-3.5"/>حذف قلم</button>}</div>
            </div>;
          })}
        </div>
      </section>

      <div className="grid grid-cols-1 gap-3 rounded-xl border border-slate-100 p-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
        <label>تخفیف کل فاکتور (ریال)<input className={`${field} mt-1 text-left font-mono`} dir="ltr" inputMode="decimal" value={discountTotal} onChange={(event) => setDiscountTotal(event.target.value)}/></label>
        <label>روش محاسبه مالیات<select className={`${field} mt-1`} value={taxMode} onChange={(event) => setTaxMode(event.target.value as "AUTO" | "OVERRIDE")}><option value="AUTO">خودکار از اقلام</option><option value="OVERRIDE">مبلغ مالیات دستی</option></select></label>
        {taxMode === "OVERRIDE" && <label>مالیات دستی (ریال)<input className={`${field} mt-1 text-left font-mono`} dir="ltr" inputMode="decimal" value={taxOverride} onChange={(event) => setTaxOverride(event.target.value)}/></label>}
        <label>هزینه حمل (ریال)<input className={`${field} mt-1 text-left font-mono`} dir="ltr" inputMode="decimal" value={shippingCost} onChange={(event) => setShippingCost(event.target.value)}/></label>
        <label>سایر هزینه‌ها (ریال)<input className={`${field} mt-1 text-left font-mono`} dir="ltr" inputMode="decimal" value={otherCosts} onChange={(event) => setOtherCosts(event.target.value)}/></label>
        <label>تعدیل رندکردن (ریال)<input dir="ltr" inputMode="decimal" className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-left font-mono text-xs" value={roundingAdjustment} onChange={(event) => setRoundingAdjustment(event.target.value)}/></label>
        <label className="sm:col-span-2 lg:col-span-2">یادداشت فاکتور<textarea rows={2} className={`${field} mt-1`} value={notes} onChange={(event) => setNotes(event.target.value)}/></label>
        <label className="sm:col-span-2 lg:col-span-2">لینک پیوست / تصویر رسید<input type="url" dir="ltr" className={`${field} mt-1 text-left`} value={receiptUrl} onChange={(event) => setReceiptUrl(event.target.value)} placeholder="https://…"/></label>
      </div>

      <section className="space-y-3 rounded-xl border border-slate-100 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-xs">پرداخت ترکیبی: نقد + POS + نسیه و سایر روش‌ها</strong><span className="text-[10px] text-slate-500">ماندهٔ پرداخت‌نشده در زمان قطعی‌سازی به‌صورت نسیه ثبت می‌شود.</span></div>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-4">
          <select className={field} value={paymentDraft.payment_method} onChange={(event) => setPaymentDraft({ ...paymentDraft, payment_method: event.target.value })}>{paymentOptions.map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select>
          <select className={field} value={paymentDraft.financial_account_id} onChange={(event) => setPaymentDraft({ ...paymentDraft, financial_account_id: event.target.value })}><option value="">حساب نقد / POS (اختیاری)</option>{accounts.map((account) => <option key={value(account.id)} value={value(account.id)}>{value(account.name)} • {formatIrr(value(account.balance, "0"))} ریال</option>)}</select>
          <input className={`${field} text-left font-mono`} dir="ltr" inputMode="decimal" placeholder="مبلغ پرداخت" value={paymentDraft.amount} onChange={(event) => setPaymentDraft({ ...paymentDraft, amount: event.target.value })}/>
          <div className="flex gap-2"><input className={field} placeholder="شماره پیگیری / چک" value={paymentDraft.reference_number} onChange={(event) => setPaymentDraft({ ...paymentDraft, reference_number: event.target.value })}/><button type="button" onClick={addPayment} className="shrink-0 rounded-xl border border-teal-200 px-3 text-[11px] font-semibold text-teal-800">افزودن</button></div>
        </div>
        {payments.map((payment) => <div key={payment.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2 text-[11px]"><span>{paymentOptions.find(([code]) => code === payment.payment_method)?.[1] ?? payment.payment_method} • {value(accounts.find((account) => value(account.id) === payment.financial_account_id)?.name, "بدون حساب خزانه")} • {payment.reference_number || "بدون پیگیری"}</span><span className="font-semibold">{formatIrr(payment.amount)} ریال <button type="button" className="mr-2 text-rose-700 underline" onClick={() => setPayments((current) => current.filter((item) => item.id !== payment.id))}>حذف</button></span></div>)}
      </section>

      <div className="flex flex-col gap-3 border-t border-slate-100 pt-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] sm:grid-cols-5"><span>جمع اقلام: {formatIrr(subtotal.toFixed(2))}</span><span>تخفیف: {formatIrr((lineDiscounts + headerDiscount).toFixed(2))}</span><span>مالیات: {formatIrr(invoiceTax.toFixed(2))}</span><span>پرداخت‌شده: {formatIrr(allocatedTotal.toFixed(2))}</span><strong className="text-sm text-slate-900">نهایی: {formatIrr(grandTotal.toFixed(2))} ریال</strong><span className="font-semibold text-amber-700">نسیه: {formatIrr(creditRemainder.toFixed(2))} ریال</span></div>
        <div className="flex flex-wrap gap-2"><button type="button" disabled={busy || loading} onClick={() => void saveQuotation()} className="rounded-xl border border-indigo-200 px-4 py-2.5 text-xs font-semibold text-indigo-800 disabled:opacity-50">ذخیره پیش‌فاکتور</button><button type="submit" disabled={busy || loading} className="rounded-xl border border-slate-200 px-4 py-2.5 text-xs font-semibold disabled:opacity-50">{busy ? "در حال ثبت…" : "ذخیره پیش‌نویس"}</button><button type="button" disabled={busy || loading} onClick={() => void saveInvoice(true)} className="rounded-xl bg-emerald-700 px-4 py-2.5 text-xs font-semibold text-white disabled:opacity-50">ثبت و تأیید فاکتور</button></div>
      </div>
    </form>
  );
}

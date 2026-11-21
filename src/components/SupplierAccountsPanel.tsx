"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch, formatDateFa, formatIrr } from "@/lib/format";
import { currentJalaliDate } from "@/lib/jalali";
import { JalaliDatePicker } from "@/components/JalaliDatePicker";

type Row = Record<string, unknown>;
type Toast = (message: string, type?: "success" | "error") => void;
const text = (value: unknown, fallback = "") => value == null ? fallback : String(value);
const list = (value: unknown): Row[] => Array.isArray(value) ? value as Row[] : [];
const input = "w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs";
const card = "rounded-2xl border border-slate-200 bg-white p-4 sm:p-5";
const button = "rounded-xl bg-emerald-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50";

export function SupplierAccountsPanel({ orgId, onToast }: { orgId: string | null; onToast: Toast }) {
  const [suppliers, setSuppliers] = useState<Row[]>([]);
  const [accounts, setAccounts] = useState<Row[]>([]);
  const [supplierId, setSupplierId] = useState("");
  const [profile, setProfile] = useState<Row | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [supplierModalOpen, setSupplierModalOpen] = useState(false);
  const [supplierDraft, setSupplierDraft] = useState({ display_name: "", company_name: "", mobile: "", phone: "", economic_code: "" });
  const [filters, setFilters] = useState({ date_from: "", date_to: "", payment_method: "" });
  const [settlement, setSettlement] = useState({
    financial_account_id: "",
    payment_method: "BANK_TRANSFER",
    amount: "",
    settlement_date_jalali: currentJalaliDate(),
    reference_number: "",
    description: "تسویه حساب تأمین‌کننده",
  });

  const reloadOptions = useCallback(async (preferredSupplierId?: string) => {
    if (!orgId) return;
    try {
      const [contacts, treasury] = await Promise.all([
        apiFetch<Row[]>("/api/v1/contacts?per_page=200", { organizationId: orgId }),
        apiFetch<Row[]>("/api/v1/treasury/accounts", { organizationId: orgId }),
      ]);
      const eligible = list(contacts).filter((item) =>
        ["SUPPLIER", "VENDOR"].includes(text(item.type ?? item.contactType ?? item.contact_type).toUpperCase())
      );
      const activeAccounts = list(treasury).filter((item) => Boolean(item.isActive ?? item.is_active ?? true));
      setSuppliers(eligible);
      setAccounts(activeAccounts);
      setSupplierId((current) => preferredSupplierId && eligible.some((item) => text(item.id) === preferredSupplierId)
        ? preferredSupplierId
        : eligible.some((item) => text(item.id) === current) ? current : text(eligible[0]?.id));
      setSettlement((current) => ({
        ...current,
        financial_account_id: activeAccounts.some((item) => text(item.id) === current.financial_account_id)
          ? current.financial_account_id
          : text(activeAccounts[0]?.id),
      }));
    } catch (error) {
      onToast(error instanceof Error ? error.message : "دریافت تأمین‌کنندگان و حساب‌های خزانه ناموفق بود", "error");
    }
  }, [orgId, onToast]);

  const reloadProfile = useCallback(async () => {
    if (!orgId || !supplierId) { setProfile(null); return; }
    setLoading(true);
    try {
      setProfile(await apiFetch<Row>("/api/v1/suppliers/" + encodeURIComponent(supplierId) + "/profile", { organizationId: orgId }));
    } catch (error) {
      setProfile(null);
      onToast(error instanceof Error ? error.message : "دریافت حساب تأمین‌کننده ناموفق بود", "error");
    } finally {
      setLoading(false);
    }
  }, [orgId, supplierId, onToast]);

  useEffect(() => { void reloadOptions(); }, [reloadOptions]);
  useEffect(() => { void reloadProfile(); }, [reloadProfile]);

  const supplier = (profile?.supplier ?? {}) as Row;
  const summary = (profile?.summary ?? {}) as Row;
  const ledger = useMemo(() => list(profile?.ledger_transactions).filter((row) => {
    const date = text(row.txDate ?? row.tx_date).slice(0, 10);
    return (!filters.date_from || date >= filters.date_from) && (!filters.date_to || date <= filters.date_to);
  }), [profile, filters.date_from, filters.date_to]);
  const settlements = useMemo(() => list(profile?.settlements).filter((row) => {
    const date = text(row.txDate ?? row.tx_date).slice(0, 10);
    return (!filters.date_from || date >= filters.date_from) &&
      (!filters.date_to || date <= filters.date_to) &&
      (!filters.payment_method || text(row.paymentMethod ?? row.payment_method).toUpperCase() === filters.payment_method);
  }), [profile, filters]);
  const payable = Number(summary.outstanding_payable ?? 0);

  async function recordSettlement(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!orgId || !supplierId || busy) return;
    setBusy(true);
    try {
      await apiFetch("/api/v1/suppliers/" + encodeURIComponent(supplierId) + "/settlements", {
        method: "POST",
        organizationId: orgId,
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify(settlement),
      });
      onToast("تسویه ثبت شد؛ دفتر تأمین‌کننده و حساب خزانه از سرور بروزرسانی می‌شوند.");
      setSettlement((current) => ({ ...current, amount: "", reference_number: "" }));
      await reloadProfile();
    } catch (error) {
      onToast(error instanceof Error ? error.message : "ثبت تسویه تأمین‌کننده ناموفق بود", "error");
    } finally {
      setBusy(false);
    }
  }

  async function createSupplier(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!orgId || busy) return;
    const displayName = supplierDraft.display_name.trim();
    if (displayName.length < 2) { onToast("نام تأمین‌کننده باید دست‌کم دو نویسه باشد.", "error"); return; }
    setBusy(true);
    try {
      const created = await apiFetch<Row>("/api/v1/contacts", {
        method: "POST",
        organizationId: orgId,
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          code: "SUP-" + crypto.randomUUID().slice(0, 8).toUpperCase(),
          type: "SUPPLIER",
          display_name: displayName,
          company_name: supplierDraft.company_name.trim(),
          mobile: supplierDraft.mobile.trim(),
          phone: supplierDraft.phone.trim(),
          economic_code: supplierDraft.economic_code.trim(),
          opening_balance: "0.00",
          credit_limit: "0.00",
        }),
      });
      setSupplierDraft({ display_name: "", company_name: "", mobile: "", phone: "", economic_code: "" });
      setSupplierModalOpen(false);
      onToast("تأمین‌کننده ثبت شد و برای مشاهدهٔ دفتر حساب انتخاب شد.");
      await reloadOptions(text(created.id));
    } catch (error) {
      onToast(error instanceof Error ? error.message : "ثبت تأمین‌کننده ناموفق بود", "error");
    } finally {
      setBusy(false);
    }
  }

  function exportLedger() {
    const escapeCell = (value: unknown) => {
      let cell = text(value);
      if (/^[=+@\\-\\t\\r]/.test(cell)) cell = "'" + cell;
      return '"' + cell.replaceAll('"', '""') + '"';
    };
    const csvRows = [
      ["تاریخ", "شرح", "بدهکار (ریال)", "بستانکار (ریال)", "شناسه سند"],
      ...ledger.map((row) => [
        text(row.txDate ?? row.tx_date),
        text(row.description),
        text(row.debit),
        text(row.credit),
        text(row.referenceId ?? row.reference_id),
      ]),
    ];
    const blob = new Blob(["\\uFEFF" + csvRows.map((row) => row.map(escapeCell).join(",")).join("\\r\\n")], { type: "text/csv;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = "karvexa-supplier-" + text(supplier.code, supplierId) + "-ledger.csv";
    link.click();
    URL.revokeObjectURL(href);
  }

  return <section className="space-y-4" dir="rtl">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="text-lg font-extrabold text-slate-900">حساب تأمین‌کنندگان</h2><p className="mt-1 text-xs text-slate-500">فاکتورهای خرید، بدهی و بستانکاری، پرداخت‌ها و تسویه‌ها از دفتر سرور خوانده می‌شوند.</p></div>
      <button type="button" className="rounded-xl border border-slate-200 px-3 py-2 text-xs" onClick={() => { void reloadOptions(); void reloadProfile(); }}>بروزرسانی</button>
    </header>

    <div className={card + " grid gap-3 md:grid-cols-[minmax(220px,1fr)_2fr]"}>
      <div className="space-y-1"><div className="flex items-center justify-between gap-2"><label htmlFor="supplier-account-picker" className="text-xs font-semibold">انتخاب تأمین‌کننده</label><button type="button" className="rounded-lg border border-emerald-200 px-2 py-1 text-[11px] font-semibold text-emerald-800 hover:bg-emerald-50" onClick={() => setSupplierModalOpen(true)}>+ ثبت تأمین‌کننده</button></div>
        <select id="supplier-account-picker" className={input + " mt-1"} value={supplierId} onChange={(event) => setSupplierId(event.target.value)}>
          <option value="">انتخاب تأمین‌کننده</option>
          {suppliers.map((item) => <option key={text(item.id)} value={text(item.id)}>{text(item.display_name ?? item.name)}{text(item.code) ? " • " + text(item.code) : ""}</option>)}
        </select>
      </div>
      {supplierId && <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-slate-600">
        <span>{text(supplier.mobile ?? supplier.phone, "شماره تماس ثبت نشده")}</span>
        <span>کد اقتصادی: {text(supplier.economic_code ?? supplier.economicCode, "—")}</span>
        <span className={"rounded-full px-3 py-1 font-bold " + (payable > 0 ? "bg-amber-50 text-amber-800" : "bg-emerald-50 text-emerald-800")}>
          {(payable >= 0 ? "بدهی به تأمین‌کننده" : "بستانکاری از تأمین‌کننده") + ": " + formatIrr(Math.abs(payable).toFixed(2)) + " ریال"}
        </span>
      </div>}
    </div>

    {!supplierId && <div className={card + " text-center text-sm text-slate-500"}>برای دیدن دفتر حساب، ابتدا یک تأمین‌کننده ثبت یا انتخاب کنید.</div>}
    {loading && <div className={card + " text-center text-xs text-slate-500"}>در حال دریافت دفتر حساب از سرور…</div>}
    {profile && <>
      <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
        <div className="rounded-2xl border border-slate-200 bg-white p-4 text-xs">جمع بستانکار ثبت‌شده<strong className="mt-2 block text-base">{formatIrr(text(summary.total_billed_credit))} ریال</strong></div>
        <div className="rounded-2xl border border-slate-200 bg-white p-4 text-xs">پرداخت و برگشت بدهکار<strong className="mt-2 block text-base">{formatIrr(text(summary.total_settled_debit))} ریال</strong></div>
        <div className="rounded-2xl border border-slate-200 bg-white p-4 text-xs">فاکتور خرید<strong className="mt-2 block text-base">{text(summary.purchase_invoices_count, "0")}</strong></div>
        <div className="rounded-2xl border border-slate-200 bg-white p-4 text-xs">رسید انبار<strong className="mt-2 block text-base">{text(summary.warehouse_receipts_count, "0")}</strong></div>
      </div>

      <section className={card + " space-y-3"}>
        <div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="text-sm font-bold">تسویه بدهی تأمین‌کننده</h3><p className="mt-1 text-[11px] text-slate-500">پرداخت با سند خزانه و گردش دفتر حساب سمت سرور ثبت می‌شود.</p></div><span className="text-[11px] text-slate-500">مانده باز: {formatIrr(text(summary.outstanding_payable))} ریال</span></div>
        <form onSubmit={recordSettlement} className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <select className={input} required value={settlement.financial_account_id} onChange={(event) => setSettlement({ ...settlement, financial_account_id: event.target.value })}><option value="">حساب بانک / صندوق</option>{accounts.map((item) => <option key={text(item.id)} value={text(item.id)}>{text(item.code)} • {text(item.name)}</option>)}</select>
          <select className={input} value={settlement.payment_method} onChange={(event) => setSettlement({ ...settlement, payment_method: event.target.value })}><option value="BANK_TRANSFER">انتقال بانکی</option><option value="CASH">نقد</option><option value="BANK">بانک</option><option value="CARD_TERMINAL">کارت‌خوان</option><option value="CHEQUE">چک</option><option value="OTHER">سایر</option></select>
          <input className={input} required dir="ltr" inputMode="decimal" min="0.01" placeholder="مبلغ تسویه (ریال)" value={settlement.amount} onChange={(event) => setSettlement({ ...settlement, amount: event.target.value })}/>
          <JalaliDatePicker value={settlement.settlement_date_jalali} onChange={(value) => setSettlement({ ...settlement, settlement_date_jalali: value })} placeholder="تاریخ تسویه شمسی"/>
          <input className="sm:col-span-2 xl:col-span-2 rounded-xl border border-slate-200 px-3 py-2 text-xs" placeholder="شماره پیگیری / شرح پرداخت" value={settlement.reference_number} onChange={(event) => setSettlement({ ...settlement, reference_number: event.target.value })}/>
          <input className="sm:col-span-2 xl:col-span-1 rounded-xl border border-slate-200 px-3 py-2 text-xs" placeholder="شرح سند" value={settlement.description} onChange={(event) => setSettlement({ ...settlement, description: event.target.value })}/>
          <button disabled={busy || !accounts.length} className={button}>{busy ? "در حال ثبت…" : "ثبت تسویه"}</button>
        </form>
      </section>

      <section className={card + " space-y-3"}>
        <div className="flex flex-wrap items-end justify-between gap-3"><div><h3 className="text-sm font-bold">فاکتورهای خرید و رسیدهای انبار</h3><p className="mt-1 text-[11px] text-slate-500">سوابق خرید به تأمین‌کنندهٔ انتخاب‌شده متصل هستند.</p></div><button type="button" onClick={exportLedger} className="rounded-xl border border-slate-200 px-3 py-2 text-xs">خروجی گردش حساب CSV</button></div>
        <div className="overflow-x-auto"><table className="w-full min-w-[680px] text-right text-xs"><thead className="border-b bg-slate-50 text-slate-500"><tr><th className="p-2">شماره</th><th className="p-2">تاریخ</th><th className="p-2">وضعیت</th><th className="p-2">مبلغ (ریال)</th><th className="p-2">پرداخت‌شده (ریال)</th></tr></thead><tbody>{list(profile.purchase_invoices).map((row, index) => <tr key={text(row.id, String(index))} className="border-b border-slate-100"><td className="p-2 font-mono">{text(row.invoiceNumber ?? row.invoice_number, "—")}</td><td className="p-2">{formatDateFa(text(row.invoiceDate ?? row.invoice_date))}</td><td className="p-2">{text(row.status, "—")}</td><td className="p-2">{formatIrr(text(row.grandTotal ?? row.grand_total ?? row.total_amount))}</td><td className="p-2">{formatIrr(text(row.paidAmount ?? row.paid_amount))}</td></tr>)}</tbody></table>{!list(profile.purchase_invoices).length && <p className="py-4 text-center text-xs text-slate-500">فاکتور خریدی برای این تأمین‌کننده ثبت نشده است.</p>}</div>
      </section>

      <section className={card + " space-y-3"}>
        <div className="flex flex-wrap items-end justify-between gap-3"><div><h3 className="text-sm font-bold">دفتر حساب و تاریخچه تسویه‌ها</h3><p className="mt-1 text-[11px] text-slate-500">فیلترهای تاریخ شمسی و روش پرداخت روی سوابق اعمال می‌شوند.</p></div><div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <label className="text-[10px]">از تاریخ<JalaliDatePicker className="mt-1" value={filters.date_from} onChange={(value) => setFilters({ ...filters, date_from: value })} format="iso" allowEmpty placeholder="از تاریخ شمسی"/></label>
          <label className="text-[10px]">تا تاریخ<JalaliDatePicker className="mt-1" value={filters.date_to} onChange={(value) => setFilters({ ...filters, date_to: value })} format="iso" allowEmpty placeholder="تا تاریخ شمسی"/></label>
          <label className="text-[10px]">روش پرداخت<select className={input + " mt-1"} value={filters.payment_method} onChange={(event) => setFilters({ ...filters, payment_method: event.target.value })}><option value="">همه روش‌ها</option><option value="BANK_TRANSFER">انتقال بانکی</option><option value="CASH">نقد</option><option value="BANK">بانک</option><option value="CARD_TERMINAL">کارت‌خوان</option><option value="CHEQUE">چک</option><option value="OTHER">سایر</option></select></label>
        </div></div>
        <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-right text-xs"><thead className="border-b bg-slate-50 text-slate-500"><tr><th className="p-2">تاریخ</th><th className="p-2">روش</th><th className="p-2">شرح / پیگیری</th><th className="p-2">مبلغ (ریال)</th><th className="p-2">وضعیت</th></tr></thead><tbody>{settlements.map((row, index) => <tr key={text(row.id, String(index))} className="border-b border-slate-100"><td className="p-2">{formatDateFa(text(row.txDate ?? row.tx_date))}</td><td className="p-2">{text(row.paymentMethod ?? row.payment_method)}</td><td className="p-2">{text(row.description)} {text(row.referenceNumber ?? row.reference_number) ? "• " + text(row.referenceNumber ?? row.reference_number) : ""}</td><td className="p-2 font-semibold">{formatIrr(text(row.amount))}</td><td className="p-2">{text(row.status, "ثبت‌شده")}</td></tr>)}</tbody></table>{!settlements.length && <p className="py-4 text-center text-xs text-slate-500">تسویه‌ای مطابق فیلترها ثبت نشده است.</p>}</div>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2"><div className="max-h-64 overflow-auto rounded-xl border border-slate-100 p-3"><strong className="text-xs">گردش دفتر تفصیلی</strong>{ledger.map((row, index) => <div key={text(row.id, String(index))} className="flex flex-wrap justify-between gap-2 border-b border-slate-100 py-2 text-[11px]"><span>{formatDateFa(text(row.txDate ?? row.tx_date))} • {text(row.description)}</span><span className="tabular-nums">بد {formatIrr(text(row.debit))} / بس {formatIrr(text(row.credit))}</span></div>)}{!ledger.length && <p className="py-3 text-[11px] text-slate-500">گردشی در این بازه ثبت نشده است.</p>}</div><div className="max-h-64 overflow-auto rounded-xl border border-slate-100 p-3"><strong className="text-xs">پرداخت‌های ثبت‌شده در خزانه</strong>{settlements.map((row, index) => <div key={"payment-" + text(row.id, String(index))} className="flex flex-wrap justify-between gap-2 border-b border-slate-100 py-2 text-[11px]"><span>{formatDateFa(text(row.txDate ?? row.tx_date))} • {text(row.description)}</span><span className="font-semibold">{formatIrr(text(row.amount))} ریال</span></div>)}</div></div>
      </section>
    </>}
    {supplierModalOpen && <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/50 p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSupplierModalOpen(false); }}>
      <section role="dialog" aria-modal="true" aria-labelledby="supplier-create-title" className="w-full max-w-xl rounded-2xl bg-white p-5 shadow-2xl">
        <div className="mb-4 flex items-center justify-between gap-3"><h3 id="supplier-create-title" className="text-base font-extrabold">ثبت تأمین‌کننده جدید</h3><button type="button" className="rounded-lg border px-3 py-1 text-lg" aria-label="بستن" onClick={() => setSupplierModalOpen(false)}>×</button></div>
        <p className="mb-4 text-xs leading-6 text-slate-600">پس از ثبت، تأمین‌کننده به فهرست حساب‌ها اضافه و دفتر حساب آن باز می‌شود.</p>
        <form onSubmit={createSupplier} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="text-xs sm:col-span-2">نام شخص / شرکت *<input autoFocus required minLength={2} maxLength={140} className={input + " mt-1"} value={supplierDraft.display_name} onChange={(event) => setSupplierDraft({ ...supplierDraft, display_name: event.target.value })}/></label>
          <label className="text-xs">نام شرکت<input maxLength={140} className={input + " mt-1"} value={supplierDraft.company_name} onChange={(event) => setSupplierDraft({ ...supplierDraft, company_name: event.target.value })}/></label>
          <label className="text-xs">موبایل<input inputMode="tel" className={input + " mt-1"} value={supplierDraft.mobile} onChange={(event) => setSupplierDraft({ ...supplierDraft, mobile: event.target.value })}/></label>
          <label className="text-xs">تلفن ثابت<input inputMode="tel" className={input + " mt-1"} value={supplierDraft.phone} onChange={(event) => setSupplierDraft({ ...supplierDraft, phone: event.target.value })}/></label>
          <label className="text-xs">کد اقتصادی<input className={input + " mt-1"} value={supplierDraft.economic_code} onChange={(event) => setSupplierDraft({ ...supplierDraft, economic_code: event.target.value })}/></label>
          <div className="flex justify-end gap-2 sm:col-span-2"><button type="button" className="rounded-xl border px-4 py-2 text-xs" onClick={() => setSupplierModalOpen(false)}>انصراف</button><button disabled={busy} className={button}>{busy ? "در حال ثبت…" : "ثبت و مشاهده حساب"}</button></div>
        </form>
      </section>
    </div>}
  </section>;
}

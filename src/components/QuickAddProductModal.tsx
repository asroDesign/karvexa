"use client";

import { FormEvent, useState } from "react";
import { apiFetch } from "@/lib/format";

type Row = Record<string, unknown>;
type Toast = (message: string, type?: "success" | "error") => void;

const englishDigits = (value: string) => value
  .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
  .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660));

function decimalValue(value: string, fallback = "0.00") {
  const normalized = englishDigits(value).trim().replace(/[٬,]/g, "").replace(/٫/g, ".");
  if (!normalized) return fallback;
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) throw new Error("قیمت و مالیات را با حداکثر دو رقم اعشار وارد کنید.");
  return normalized;
}

export function QuickAddProductModal({
  organizationId,
  onClose,
  onCreated,
  onToast,
}: {
  organizationId: string | null;
  onClose: () => void;
  onCreated: (product: Row) => void;
  onToast?: Toast;
}) {
  const [name, setName] = useState("");
  const [salePrice, setSalePrice] = useState("");
  const [purchasePrice, setPurchasePrice] = useState("");
  const [unitName, setUnitName] = useState("عدد");
  const [taxRate, setTaxRate] = useState("10");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!organizationId || busy) return;
    setBusy(true);
    setError("");
    try {
      const unitLabel = unitName.trim() || "عدد";
      const units = await apiFetch<Row[]>("/api/v1/units", { organizationId });
      let unit = units.find((item) => String(item.name ?? "").trim().toLocaleLowerCase("fa") === unitLabel.toLocaleLowerCase("fa")
        || String(item.symbol ?? "").trim().toLocaleLowerCase("fa") === unitLabel.toLocaleLowerCase("fa"));
      if (!unit) {
        unit = await apiFetch<Row>("/api/v1/units", {
          method: "POST",
          organizationId,
          body: JSON.stringify({ name: unitLabel, symbol: unitLabel }),
        });
      }
      const product = await apiFetch<Row>("/api/v1/products", {
        method: "POST",
        organizationId,
        body: JSON.stringify({
          name: name.trim(),
          item_type: "PRODUCT",
          base_unit_id: String(unit.id),
          purchase_price: decimalValue(purchasePrice),
          sale_price: decimalValue(salePrice),
          tax_rate: decimalValue(taxRate, "10.00"),
          minimum_stock: "5.0000",
          maximum_stock: "100.0000",
          track_inventory: true,
          allow_negative_stock: false,
          is_active: true,
        }),
      });
      onCreated(product);
      onToast?.("کالا ثبت و برای انتخاب آماده شد.");
      onClose();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "ثبت کالای جدید ناموفق بود.";
      setError(message);
      onToast?.(message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-950/50 p-3" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <form onSubmit={save} className="w-full max-w-xl space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div><h3 className="text-sm font-bold text-slate-900">افزودن سریع محصول</h3><p className="mt-1 text-[11px] text-slate-500">نام، قیمت‌ها، واحد و مالیات؛ مطابق فرم افزودن سریع اپلیکیشن.</p></div>
          <button type="button" disabled={busy} onClick={onClose} className="rounded-lg px-2 py-1 text-xs text-slate-500 hover:bg-slate-100">بستن</button>
        </div>
        <label className="block text-xs">نام محصول *<input autoFocus required minLength={2} maxLength={180} value={name} onChange={(event) => setName(event.target.value)} className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5" /></label>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block text-xs">قیمت فروش (ریال) *<input required dir="ltr" inputMode="decimal" value={salePrice} onChange={(event) => setSalePrice(event.target.value)} className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-left font-mono" /></label>
          <label className="block text-xs">قیمت خرید (ریال)<input dir="ltr" inputMode="decimal" value={purchasePrice} onChange={(event) => setPurchasePrice(event.target.value)} className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-left font-mono" /></label>
          <label className="block text-xs">واحد<input value={unitName} onChange={(event) => setUnitName(event.target.value)} placeholder="عدد" className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5" /></label>
          <label className="block text-xs">مالیات (٪)<input dir="ltr" inputMode="decimal" value={taxRate} onChange={(event) => setTaxRate(event.target.value)} className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-left font-mono" /></label>
        </div>
        {error && <p role="alert" className="rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" disabled={busy} onClick={onClose} className="rounded-xl border border-slate-200 px-4 py-2.5 text-xs">انصراف</button>
          <button type="submit" disabled={busy || name.trim().length < 2 || salePrice.trim() === ""} className="rounded-xl bg-emerald-700 px-5 py-2.5 text-xs font-semibold text-white disabled:opacity-50">{busy ? "در حال ثبت…" : "ثبت و انتخاب محصول"}</button>
        </div>
      </form>
    </div>
  );
}

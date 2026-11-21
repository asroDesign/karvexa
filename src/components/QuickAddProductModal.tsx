"use client";

import { useEffect, useState, type FormEvent } from "react";
import { apiFetch } from "@/lib/format";

type Row = Record<string, unknown>;
type Toast = (message: string, type?: "success" | "error") => void;
type ItemType = "PRODUCT" | "SERVICE" | "RAW_MATERIAL" | "FINISHED_PRODUCT";

const ITEM_TYPES: Array<{ value: ItemType; label: string }> = [
  { value: "PRODUCT", label: "کالا" },
  { value: "SERVICE", label: "خدمت" },
  { value: "RAW_MATERIAL", label: "مواد اولیه" },
  { value: "FINISHED_PRODUCT", label: "محصول نهایی" },
];

const englishDigits = (value: string) => value
  .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
  .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660));

const valueOf = (value: unknown) => value == null ? "" : String(value);
const normalizeLabel = (value: unknown) => valueOf(value).trim().toLocaleLowerCase("fa");

function decimalValue(value: string, scale: number, field: string) {
  const normalized = englishDigits(value).trim().replace(/[٬,]/g, "").replace(/٫/g, ".");
  const pattern = new RegExp("^\\d+(?:\\.\\d{1," + scale + "})?$");
  if (!pattern.test(normalized)) {
    throw new Error(field + " را با حداکثر " + scale + " رقم اعشار وارد کنید.");
  }
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
  const [code, setCode] = useState("");
  const [barcode, setBarcode] = useState("");
  const [description, setDescription] = useState("");
  const [itemType, setItemType] = useState<ItemType>("PRODUCT");
  const [categoryId, setCategoryId] = useState("");
  const [brandId, setBrandId] = useState("");
  const [categoryOptions, setCategoryOptions] = useState<Row[]>([]);
  const [brandOptions, setBrandOptions] = useState<Row[]>([]);
  const [lookupError, setLookupError] = useState("");
  const [salePrice, setSalePrice] = useState("");
  const [purchasePrice, setPurchasePrice] = useState("");
  const [unitName, setUnitName] = useState("عدد");
  const [taxRate, setTaxRate] = useState("10");
  const [minimumStock, setMinimumStock] = useState("5");
  const [maximumStock, setMaximumStock] = useState("100");
  const [trackInventory, setTrackInventory] = useState(true);
  const [allowNegativeStock, setAllowNegativeStock] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!organizationId) return;
    let active = true;
    void Promise.all([
      apiFetch<Row[]>("/api/v1/categories", { organizationId }),
      apiFetch<Row[]>("/api/v1/brands", { organizationId }),
    ]).then(([categories, brands]) => {
      if (!active) return;
      setCategoryOptions(categories);
      setBrandOptions(brands);
      setLookupError("");
    }).catch((cause) => {
      if (!active) return;
      setLookupError(cause instanceof Error ? cause.message : "بارگذاری دسته‌بندی و برند ناموفق بود.");
    });
    return () => { active = false; };
  }, [organizationId]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!organizationId || busy) return;
    setBusy(true);
    setError("");
    try {
      const unitLabel = unitName.trim() || "عدد";
      const units = await apiFetch<Row[]>("/api/v1/units", { organizationId });
      let unit = units.find((item) =>
        normalizeLabel(item.name) === normalizeLabel(unitLabel) ||
        normalizeLabel(item.symbol) === normalizeLabel(unitLabel)
      );
      if (!unit) {
        unit = await apiFetch<Row>("/api/v1/units", {
          method: "POST",
          organizationId,
          body: JSON.stringify({ name: unitLabel, symbol: unitLabel }),
        });
      }

      const isService = itemType === "SERVICE";
      const product = await apiFetch<Row>("/api/v1/products", {
        method: "POST",
        organizationId,
        body: JSON.stringify({
          ...(code.trim() ? { code: code.trim(), sku: code.trim() } : {}),
          name: name.trim(),
          description: description.trim(),
          item_type: itemType,
          category_id: categoryId || null,
          brand_id: brandId || null,
          barcode: barcode.trim(),
          base_unit_id: valueOf(unit.id),
          purchase_price: decimalValue(purchasePrice || "0", 2, "قیمت خرید"),
          sale_price: decimalValue(salePrice || "0", 2, "قیمت فروش"),
          tax_rate: decimalValue(taxRate || "10", 2, "نرخ مالیات"),
          minimum_stock: decimalValue(isService ? "0" : minimumStock || "0", 4, "حداقل موجودی"),
          maximum_stock: decimalValue(isService ? "0" : maximumStock || "0", 4, "حداکثر موجودی"),
          track_inventory: !isService && trackInventory,
          allow_negative_stock: !isService && allowNegativeStock,
          is_active: true,
          costing_method: "WEIGHTED_AVERAGE",
        }),
      });
      onCreated(product);
      onToast?.("کالا یا خدمت ثبت شد و برای انتخاب آماده است.");
      onClose();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "ثبت کالا یا خدمت ناموفق بود.";
      setError(message);
      onToast?.(message, "error");
    } finally {
      setBusy(false);
    }
  }

  const field = "mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-xs text-slate-900 outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100";
  const isService = itemType === "SERVICE";

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-950/50 p-3"
      onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}
    >
      <form onSubmit={save} className="max-h-[92vh] w-full max-w-2xl space-y-4 overflow-y-auto rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-slate-700 dark:bg-slate-950">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">افزودن کالا یا خدمت</h3>
            <p className="mt-1 text-[11px] text-slate-500">فیلدهای کاتالوگ مطابق فرم اپلیکیشن؛ خدمت موجودی انبار ندارد.</p>
          </div>
          <button type="button" disabled={busy} onClick={onClose} className="rounded-lg px-2 py-1 text-xs text-slate-500 hover:bg-slate-100">بستن</button>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="group" aria-label="نوع قلم">
          {ITEM_TYPES.map((type) => (
            <button
              key={type.value}
              type="button"
              aria-pressed={itemType === type.value}
              onClick={() => {
                setItemType(type.value);
                if (type.value === "SERVICE") {
                  setTrackInventory(false);
                  setAllowNegativeStock(false);
                }
              }}
              className={"rounded-xl border px-3 py-2.5 text-xs font-semibold transition " + (itemType === type.value ? "border-teal-600 bg-teal-50 text-teal-800 dark:bg-teal-950 dark:text-teal-200" : "border-slate-200 text-slate-600 dark:border-slate-700 dark:text-slate-300")}
            >
              {type.label}
            </button>
          ))}
        </div>

        <label className="block text-xs font-medium">نام کالا / خدمت *<input autoFocus required minLength={2} maxLength={180} value={name} onChange={(event) => setName(event.target.value)} className={field} /></label>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block text-xs font-medium">کد SKU<input minLength={2} maxLength={48} value={code} onChange={(event) => setCode(event.target.value)} className={field} dir="ltr" /></label>
          <label className="block text-xs font-medium">بارکد<input maxLength={96} value={barcode} onChange={(event) => setBarcode(event.target.value)} className={field} dir="ltr" inputMode="numeric" /></label>
          <label className="block text-xs font-medium">دسته‌بندی<select value={categoryId} onChange={(event) => setCategoryId(event.target.value)} className={field}><option value="">بدون دسته‌بندی</option>{categoryOptions.map((option) => <option key={valueOf(option.id)} value={valueOf(option.id)}>{valueOf(option.name)}</option>)}</select></label>
          <label className="block text-xs font-medium">برند<select value={brandId} onChange={(event) => setBrandId(event.target.value)} className={field}><option value="">بدون برند</option>{brandOptions.map((option) => <option key={valueOf(option.id)} value={valueOf(option.id)}>{valueOf(option.name)}</option>)}</select></label>
          <label className="block text-xs font-medium">واحد اصلی *<input required minLength={1} maxLength={60} value={unitName} onChange={(event) => setUnitName(event.target.value)} className={field} placeholder="عدد" /></label>
          <label className="block text-xs font-medium">نرخ مالیات (%)<input dir="ltr" inputMode="decimal" value={taxRate} onChange={(event) => setTaxRate(event.target.value)} className={field + " text-left font-mono"} /></label>
          <label className="block text-xs font-medium">قیمت خرید (ریال)<input dir="ltr" inputMode="decimal" value={purchasePrice} onChange={(event) => setPurchasePrice(event.target.value)} className={field + " text-left font-mono"} /></label>
          <label className="block text-xs font-medium">قیمت فروش (ریال)<input dir="ltr" inputMode="decimal" value={salePrice} onChange={(event) => setSalePrice(event.target.value)} className={field + " text-left font-mono"} /></label>
        </div>

        {!isService && (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block text-xs font-medium">حداقل موجودی<input dir="ltr" inputMode="decimal" value={minimumStock} onChange={(event) => setMinimumStock(event.target.value)} className={field + " text-left font-mono"} /></label>
              <label className="block text-xs font-medium">حداکثر موجودی<input dir="ltr" inputMode="decimal" value={maximumStock} onChange={(event) => setMaximumStock(event.target.value)} className={field + " text-left font-mono"} /></label>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <label className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 px-3 py-3 text-xs dark:border-slate-700">
                <span>کنترل موجودی انبار</span>
                <input type="checkbox" checked={trackInventory} onChange={(event) => setTrackInventory(event.target.checked)} className="size-4 accent-teal-700" />
              </label>
              <label className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 px-3 py-3 text-xs dark:border-slate-700">
                <span>اجازه موجودی منفی در فروش آفلاین</span>
                <input type="checkbox" checked={allowNegativeStock} onChange={(event) => setAllowNegativeStock(event.target.checked)} className="size-4 accent-teal-700" />
              </label>
            </div>
          </>
        )}

        <label className="block text-xs font-medium">توضیحات<textarea maxLength={1000} rows={3} value={description} onChange={(event) => setDescription(event.target.value)} className={field} /></label>
        {lookupError && <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">{lookupError}</p>}
        {error && <p role="alert" className="rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-950 dark:text-rose-200">{error}</p>}

        <div className="flex flex-col-reverse gap-2 border-t border-slate-100 pt-3 sm:flex-row sm:justify-end dark:border-slate-800">
          <button type="button" disabled={busy} onClick={onClose} className="rounded-xl border border-slate-200 px-4 py-2.5 text-xs dark:border-slate-700">انصراف</button>
          <button type="submit" disabled={busy || name.trim().length < 2 || !unitName.trim()} className="rounded-xl bg-teal-700 px-5 py-2.5 text-xs font-semibold text-white disabled:opacity-50">
            {busy ? "در حال ثبت…" : "ثبت و انتخاب کالا / خدمت"}
          </button>
        </div>
      </form>
    </div>
  );
}

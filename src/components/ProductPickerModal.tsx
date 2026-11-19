"use client";

import { useMemo, useState } from "react";
import { Search, X } from "lucide-react";

type ProductRow = Record<string, unknown>;

const valueOf = (value: unknown) => value == null ? "" : String(value);

export function ProductPickerModal({
  products,
  value,
  onChange,
  placeholder = "انتخاب کالا یا خدمت",
}: {
  products: ProductRow[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const selected = products.find((product) => valueOf(product.id) === value);
  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("fa");
    if (!query) return products;
    return products.filter((product) =>
      `${valueOf(product.name)} ${valueOf(product.sku ?? product.code)} ${valueOf(product.barcode)} ${valueOf(product.unit_name)}`
        .toLocaleLowerCase("fa").includes(query)
    );
  }, [products, search]);

  return <>
    <button
      type="button"
      onClick={() => { setSearch(""); setOpen(true); }}
      className="flex min-h-10 w-full items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-right text-xs hover:border-teal-400"
      aria-haspopup="dialog"
      aria-label={selected ? `کالای انتخاب‌شده: ${valueOf(selected.name)}` : placeholder}
    >
      <span className={selected ? "text-slate-800" : "text-slate-500"}>
        {selected ? `${valueOf(selected.name)}${valueOf(selected.sku ?? selected.code) ? ` (${valueOf(selected.sku ?? selected.code)})` : ""}` : placeholder}
      </span>
      <Search className="h-4 w-4 shrink-0 text-slate-400" />
    </button>
    {open && <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/45 p-3" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
      <section role="dialog" aria-modal="true" aria-label="انتخاب کالا" className="flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
        <header className="flex items-center gap-3 border-b border-slate-100 p-4">
          <div className="min-w-0 flex-1"><h3 className="text-sm font-bold">انتخاب کالا یا خدمت</h3><p className="mt-1 text-[11px] text-slate-500">نام، کد کالا یا بارکد را جستجو کنید.</p></div>
          <button type="button" onClick={() => setOpen(false)} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100" aria-label="بستن"><X className="h-4 w-4" /></button>
        </header>
        <div className="border-b border-slate-100 p-3">
          <label className="flex items-center gap-2 rounded-xl border border-slate-200 px-3">
            <Search className="h-4 w-4 text-slate-400" />
            <input autoFocus value={search} onChange={(event) => setSearch(event.target.value)} className="w-full border-0 py-2.5 text-xs outline-none" placeholder="جستجو در کالاها" />
          </label>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {filtered.map((product) => {
            const id = valueOf(product.id);
            return <button key={id} type="button" onClick={() => { onChange(id); setOpen(false); }} className={`flex w-full items-center justify-between gap-3 rounded-xl px-3 py-3 text-right hover:bg-teal-50 ${id === value ? "bg-teal-50 ring-1 ring-teal-200" : ""}`}>
              <span className="min-w-0"><strong className="block truncate text-xs">{valueOf(product.name)}</strong><span className="mt-1 block text-[10px] text-slate-500">{valueOf(product.sku ?? product.code) || "بدون کد"}{valueOf(product.barcode) ? ` • بارکد ${valueOf(product.barcode)}` : ""}{valueOf(product.unit_name) ? ` • ${valueOf(product.unit_name)}` : ""}</span></span>
              <span className="shrink-0 text-[10px] text-slate-500">{valueOf(product.item_type) === "SERVICE" ? "خدمت" : "کالا"}</span>
            </button>;
          })}
          {!filtered.length && <p className="p-6 text-center text-xs text-slate-500">کالایی با این جستجو پیدا نشد.</p>}
        </div>
      </section>
    </div>}
  </>;
}

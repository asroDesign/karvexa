"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { currentJalaliDate, gregorianIsoToJalali, jalaliToGregorianIso, normalizePersianDigits } from "@/lib/jalali";

const MONTHS = ["فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور", "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند"];
const WEEKDAYS = ["ش", "ی", "د", "س", "چ", "پ", "ج"];
const fa = (value: number | string) => String(value).replace(/\d/g, (digit) => "۰۱۲۳۴۵۶۷۸۹"[Number(digit)]);
const pad = (value: number) => String(value).padStart(2, "0");

function normalizeJalali(value: string) {
  const clean = normalizePersianDigits(value.trim()).replace(/-/g, "/");
  const match = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(clean);
  return match ? `${match[1]}/${pad(Number(match[2]))}/${pad(Number(match[3]))}` : "";
}
function valueToJalali(value: string) {
  const clean = normalizePersianDigits(value.trim());
  if (/^\d{4}-\d{2}-\d{2}$/.test(clean) && Number(clean.slice(0, 4)) > 1600) return gregorianIsoToJalali(clean);
  return normalizeJalali(clean);
}
function jalaliToIsoSafe(value: string) {
  try {
    const iso = jalaliToGregorianIso(value);
    return gregorianIsoToJalali(iso) === value ? iso : "";
  } catch { return ""; }
}

export function JalaliDatePicker({
  value,
  onChange,
  format = "jalali",
  placeholder = "انتخاب تاریخ شمسی",
  allowEmpty = false,
  disabled = false,
  className = "",
}: {
  value: string;
  onChange: (value: string) => void;
  /** Output shape expected by the caller; the calendar itself always displays Jalali. */
  format?: "jalali" | "iso";
  placeholder?: string;
  allowEmpty?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const today = useMemo(() => currentJalaliDate(), []);
  const selected = valueToJalali(value);
  const [year, month] = (selected || today).split("/").map(Number);
  const [visible, setVisible] = useState<[number, number]>([year, month]);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (selected) {
      const [y, m] = selected.split("/").map(Number);
      setVisible([y, m]);
    }
  }, [selected]);
  useEffect(() => {
    const closeOutside = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", closeOutside);
    return () => document.removeEventListener("mousedown", closeOutside);
  }, []);

  const [visibleYear, visibleMonth] = visible;
  const firstIso = jalaliToIsoSafe(`${visibleYear}/${pad(visibleMonth)}/01`);
  const offset = firstIso ? (new Date(`${firstIso}T00:00:00Z`).getUTCDay() + 1) % 7 : 0;
  const daysInMonth = (() => {
    let last = 0;
    for (let day = 1; day <= 31; day += 1) {
      const candidate = `${visibleYear}/${pad(visibleMonth)}/${pad(day)}`;
      if (jalaliToIsoSafe(candidate)) last = day;
    }
    return last;
  })();
  const emit = (jalali: string) => {
    const iso = jalaliToIsoSafe(jalali);
    if (!iso) return;
    onChange(format === "iso" ? iso : jalali);
    setOpen(false);
  };
  const moveMonth = (delta: number) => {
    let y = visibleYear;
    let m = visibleMonth + delta;
    if (m < 1) { y -= 1; m = 12; }
    if (m > 12) { y += 1; m = 1; }
    setVisible([y, m]);
  };
  const visibleYears = Array.from({ length: 401 }, (_, index) => 1600 - index);

  return (
    <div ref={root} className={`relative ${className}`}>
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-right text-xs disabled:cursor-not-allowed disabled:bg-slate-100"
      >
        <span className={selected ? "text-slate-900" : "text-slate-400"}>{selected ? fa(selected.replace(/\//g, "/")) : placeholder}</span>
        <CalendarDays className="h-4 w-4 shrink-0 text-slate-400" />
      </button>
      {open && !disabled && (
        <div role="dialog" aria-label="انتخاب تاریخ شمسی" className="absolute right-0 z-[100] mt-1 w-72 rounded-2xl border border-slate-200 bg-white p-3 shadow-xl">
          <div className="mb-2 flex items-center justify-between">
            <button type="button" aria-label="ماه قبل" onClick={() => moveMonth(-1)} className="rounded-lg p-1 hover:bg-slate-100"><ChevronRight className="h-4 w-4" /></button>
            <div className="flex items-center gap-1 text-sm font-bold">
              <select aria-label="ماه" value={visibleMonth} onChange={(event) => setVisible([visibleYear, Number(event.target.value)])} className="rounded border-0 bg-transparent">
                {MONTHS.map((name, index) => <option key={name} value={index + 1}>{name}</option>)}
              </select>
              <select aria-label="سال" value={visibleYear} onChange={(event) => setVisible([Number(event.target.value), visibleMonth])} className="rounded border-0 bg-transparent">
                {visibleYears.map((item) => <option key={item} value={item}>{fa(item)}</option>)}
              </select>
            </div>
            <button type="button" aria-label="ماه بعد" onClick={() => moveMonth(1)} className="rounded-lg p-1 hover:bg-slate-100"><ChevronLeft className="h-4 w-4" /></button>
          </div>
          <div className="grid grid-cols-7 gap-1 text-center text-xs">
            {WEEKDAYS.map((day) => <div key={day} className="py-1 text-slate-400">{day}</div>)}
            {Array.from({ length: offset }, (_, index) => <div key={`empty-${index}`} />)}
            {Array.from({ length: daysInMonth }, (_, index) => index + 1).map((day) => {
              const date = `${visibleYear}/${pad(visibleMonth)}/${pad(day)}`;
              return <button key={day} type="button" onClick={() => emit(date)} aria-pressed={date === selected} className={`rounded-lg py-1.5 ${date === selected ? "bg-emerald-700 text-white" : "hover:bg-emerald-50"}`}>{fa(day)}</button>;
            })}
          </div>
          <div className="mt-2 flex justify-between text-xs">
            <button type="button" className="text-emerald-700" onClick={() => emit(today)}>امروز</button>
            {allowEmpty && <button type="button" className="text-slate-500" onClick={() => { onChange(""); setOpen(false); }}>پاک کردن</button>}
          </div>
        </div>
      )}
    </div>
  );
}

export function JalaliMonthPicker({ value, onChange, className = "" }: { value: string; onChange: (value: string) => void; className?: string }) {
  const current = currentJalaliDate();
  const [currentYear, currentMonth] = current.split("/").map(Number);
  const [yearText, monthText] = value.split("-");
  const year = Number(normalizePersianDigits(yearText || String(currentYear))) || currentYear;
  const month = Number(normalizePersianDigits(monthText || pad(currentMonth))) || currentMonth;
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <select aria-label="ماه شمسی" value={month} onChange={(event) => onChange(`${year}-${pad(Number(event.target.value))}`)} className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs">
        {MONTHS.map((label, index) => <option key={label} value={index + 1}>{label}</option>)}
      </select>
      <select aria-label="سال شمسی" value={year} onChange={(event) => onChange(`${Number(event.target.value)}-${pad(month)}`)} className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs">
        {Array.from({ length: 401 }, (_, index) => 1600 - index).map((item) => <option key={item} value={item}>{fa(item)}</option>)}
      </select>
    </div>
  );
}

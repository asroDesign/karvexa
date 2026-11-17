"use client";

import React, { useState } from "react";
import { CheckCircle2, Mail, MapPin, Phone, Send, AlertCircle } from "lucide-react";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { apiFetch } from "@/lib/format";

export default function ContactPage() {
  const [form, setForm] = useState({
    full_name: "",
    mobile: "",
    email: "",
    company_name: "",
    subject: "",
    message: "",
  });
  const [loading, setLoading] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setSuccessMsg(null);
    setErrorMsg(null);
    try {
      const res = await apiFetch<{ message: string }>("/api/v1/public/contact", {
        method: "POST",
        body: JSON.stringify(form),
      });
      setSuccessMsg(res.message);
      setForm({ full_name: "", mobile: "", email: "", company_name: "", subject: "", message: "" });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "خطا در ارسال پیام");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col">
      <SiteHeader />

      <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 py-12">
        <div className="text-center max-w-2xl mx-auto mb-10 space-y-2">
          <h1 className="text-3xl font-extrabold">تماس با ما و درخواست دمو</h1>
          <p className="text-sm text-slate-600 dark:text-slate-300">
            سوالی درباره استقرار SaaS، اپلیکیشن آفلاین اندروید، انتقال داده‌های حسابداری یا پلن سازمانی دارید؟ پیام شما مستقیم در پنل پشتیبانی ما ثبت می‌شود.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-5 space-y-4 text-xs">
            <div className="glass-primary p-6 space-y-4">
              <h2 className="text-base font-bold">راه‌های ارتباط مستقیم</h2>
              <div className="flex items-start gap-3">
                <Phone className="h-4 w-4 text-violet-600 mt-0.5 shrink-0" />
                <div>
                  <div className="font-semibold">تلفن پشتیبانی و فروش</div>
                  <div className="text-slate-500 mt-0.5 tabular-nums">۰۲۱-۸۸۷۷۶۶۵۵ (شنبه تا پنجشنبه ۹ تا ۱۸)</div>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <Mail className="h-4 w-4 text-emerald-600 mt-0.5 shrink-0" />
                <div>
                  <div className="font-semibold">ایمیل پشتیبانی</div>
                  <div className="text-slate-500 font-mono mt-0.5" dir="ltr">
                    support@businessos.ir
                  </div>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <MapPin className="h-4 w-4 text-sky-600 mt-0.5 shrink-0" />
                <div>
                  <div className="font-semibold">نشانی دفتر مرکزی</div>
                  <div className="text-slate-500 mt-0.5 leading-relaxed">
                    تهران، خیابان شهید بهشتی، پلاک ۱۴۲، طبقه ۴، واحد فناوری Business OS
                  </div>
                </div>
              </div>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="lg:col-span-7 glass-primary p-6 sm:p-8 space-y-4 text-xs">
            <h2 className="text-base font-bold">ارسال پیام به تیم Business OS</h2>

            {successMsg && (
              <div className="rounded-xl border border-emerald-300 bg-emerald-500/15 text-emerald-800 dark:text-emerald-200 px-4 py-3 flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                <span>{successMsg}</span>
              </div>
            )}
            {errorMsg && (
              <div className="rounded-xl border border-rose-300 bg-rose-500/15 text-rose-800 dark:text-rose-200 px-4 py-3 flex items-center gap-2">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span>{errorMsg}</span>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              <div>
                <label className="block font-medium mb-1">نام و نام خانوادگی *</label>
                <input
                  required
                  value={form.full_name}
                  onChange={(e) => setForm({ ...form, full_name: e.target.value })}
                  className="w-full glass-input px-3.5 py-2.5"
                />
              </div>
              <div>
                <label className="block font-medium mb-1">شماره موبایل *</label>
                <input
                  required
                  dir="ltr"
                  placeholder="0912..."
                  value={form.mobile}
                  onChange={(e) => setForm({ ...form, mobile: e.target.value })}
                  className="w-full glass-input px-3.5 py-2.5 font-mono text-left"
                />
              </div>
              <div>
                <label className="block font-medium mb-1">ایمیل (اختیاری)</label>
                <input
                  type="email"
                  dir="ltr"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  className="w-full glass-input px-3.5 py-2.5 font-mono text-left"
                />
              </div>
              <div>
                <label className="block font-medium mb-1">نام کسب‌وکار / شرکت</label>
                <input
                  value={form.company_name}
                  onChange={(e) => setForm({ ...form, company_name: e.target.value })}
                  className="w-full glass-input px-3.5 py-2.5"
                />
              </div>
            </div>

            <div>
              <label className="block font-medium mb-1">موضوع پیام *</label>
              <input
                required
                value={form.subject}
                onChange={(e) => setForm({ ...form, subject: e.target.value })}
                placeholder="مثلاً: درخواست مشاوره راه‌اندازی برای شرکت پخش"
                className="w-full glass-input px-3.5 py-2.5"
              />
            </div>

            <div>
              <label className="block font-medium mb-1">متن پیام *</label>
              <textarea
                required
                rows={5}
                value={form.message}
                onChange={(e) => setForm({ ...form, message: e.target.value })}
                placeholder="توضیحات، سوالات یا نیازهای کسب‌وکار خود را بنویسید..."
                className="w-full glass-input px-3.5 py-2.5"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-l from-violet-600 to-indigo-600 hover:from-violet-700 hover:to-indigo-700 disabled:opacity-50 text-white py-3 text-sm font-bold cursor-pointer"
            >
              <Send className="h-4 w-4" />
              <span>{loading ? "در حال ارسال..." : "ارسال پیام"}</span>
            </button>
          </form>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}

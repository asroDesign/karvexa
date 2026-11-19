"use client";

import React, { useCallback, useEffect, useState } from "react";
import {
  BookOpen,
  CheckCircle2,
  Edit3,
  ExternalLink,
  Mail,
  MessageSquare,
  Plus,
  RefreshCw,
  Save,
  Send,
  Trash2,
  Upload,
} from "lucide-react";
import { apiFetch, formatDateTimeFa } from "@/lib/format";
import { RichTextEditor } from "./RichTextEditor";

interface SmsIrLineLookup {
  provider: "SMS_IR";
  line_numbers: string[];
  configured_line_number: string | null;
  configured_line_matches: boolean;
}

function normalizeSmsLineForCompare(value: unknown) {
  return String(value ?? "")
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[\s,٬]/g, "");
}

interface PlatformSaasAdminProps {
  mode: "academy" | "sms" | "inquiries" | "gateways";
  onToast: (msg: string, type?: "success" | "error") => void;
}

export function PlatformSaasAdmin({ mode, onToast }: PlatformSaasAdminProps) {
  const [loading, setLoading] = useState(false);

  // Academy CMS state
  const [articles, setArticles] = useState<Array<Record<string, unknown>>>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [artForm, setArtForm] = useState({
    slug: "",
    title: "",
    excerpt: "",
    cover_image_url: "/images/academy-accounting.png",
    category: "حسابداری",
    tags: "حسابداری دوبل, آموزش",
    reading_minutes: 5,
    is_featured: false,
    status: "PUBLISHED" as "DRAFT" | "PUBLISHED" | "ARCHIVED",
    author_name: "تیم آموزش Business OS",
    content_html: "<h2>مقدمه آموزش</h2><p>متن آموزشی را با ادیتور پیشرفته اینجا بنویسید...</p>",
  });

  // SMS.ir & Kavenegar state
  const [smsProviders, setSmsProviders] = useState<Array<Record<string, unknown>>>([]);
  const [smsLogsList, setSmsLogsList] = useState<Array<Record<string, unknown>>>([]);
  const [smsDrafts, setSmsDrafts] = useState<Record<string, Record<string, unknown>>>({});
  const [smsLineLookups, setSmsLineLookups] = useState<Record<string, { loading: boolean; result?: SmsIrLineLookup }>>({});
  const [testSmsForm, setTestSmsForm] = useState({
    provider: "SMS_IR" as "SMS_IR" | "KAVENEGAR",
    mobile: "09121000001",
    message: "پیامک تست اتصال درگاه Business OS — سامانه حسابداری و انبارداری",
  });

  // Inquiries state
  const [inquiries, setInquiries] = useState<Array<Record<string, unknown>>>([]);

  // Payment Gateways state (Zarinpal, Zibal, Balleh Pay, Saman)
  const [gatewaysList, setGatewaysList] = useState<Array<Record<string, unknown>>>([]);
  const [gwDrafts, setGwDrafts] = useState<Record<string, Record<string, unknown>>>({});
  const [recentOrders, setRecentOrders] = useState<Array<Record<string, unknown>>>([]);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      if (mode === "gateways") {
        const res = await apiFetch<{
          gateways: Array<Record<string, unknown>>;
          recent_orders: Array<Record<string, unknown>>;
        }>("/api/v1/platform/payment-gateways");
        setGatewaysList(res.gateways);
        setRecentOrders(res.recent_orders);
        const map: Record<string, Record<string, unknown>> = {};
        for (const g of res.gateways) {
          map[String(g.gateway)] = {
            is_active: Boolean(g.is_active),
            is_default: Boolean(g.is_default),
            sandbox_mode: Boolean(g.sandbox_mode),
            merchant_id: String(g.merchant_id_masked || ""),
            secret_token: String(g.secret_token_masked || ""),
            callback_base_url: String(g.callback_base_url || ""),
          };
        }
        setGwDrafts(map);
      } else if (mode === "academy") {
        const res = await apiFetch<{ articles: Array<Record<string, unknown>> }>(
          "/api/v1/platform/academy"
        );
        setArticles(res.articles);
      } else if (mode === "sms") {
        const res = await apiFetch<{
          providers: Array<Record<string, unknown>>;
          logs: Array<Record<string, unknown>>;
        }>("/api/v1/platform/sms");
        setSmsProviders(res.providers);
        setSmsLogsList(res.logs);
        const draftMap: Record<string, Record<string, unknown>> = {};
        for (const p of res.providers) {
          draftMap[String(p.provider)] = {
            is_active: Boolean(p.is_active),
            is_default: Boolean(p.is_default),
            sandbox_mode: Boolean(p.sandbox_mode),
            api_key: String(p.api_key_masked || ""),
            line_number: String(p.line_number || ""),
            otp_template_id: String(p.otp_template_id || ""),
            invoice_template_id: String(p.invoice_template_id || ""),
            cheque_template_id: String(p.cheque_template_id || ""),
            extra_config: (p.extra_config ?? {}) as Record<string, unknown>,
          };
        }
        setSmsDrafts(draftMap);
      } else if (mode === "inquiries") {
        const res = await apiFetch<{ inquiries: Array<Record<string, unknown>> }>(
          "/api/v1/platform/inquiries"
        );
        setInquiries(res.inquiries);
      }
    } catch (err) {
      onToast(err instanceof Error ? err.message : "خطا در بارگذاری اطلاعات", "error");
    } finally {
      setLoading(false);
    }
  }, [mode, onToast]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // ============================================================================
  // ACADEMY CMS ACTIONS
  // ============================================================================
  function startNewArticle() {
    setEditingId(null);
    setArtForm({
      slug: `tutorial-${Date.now().toString().slice(-4)}`,
      title: "",
      excerpt: "",
      cover_image_url: "/images/academy-accounting.png",
      category: "حسابداری",
      tags: "آموزش, راهنمای شروع",
      reading_minutes: 5,
      is_featured: false,
      status: "PUBLISHED",
      author_name: "تیم آموزش Business OS",
      content_html: "<h2>عنوان بخش اول</h2><p>توضیحات کامل آموزشی همراه با تصویر و مثال...</p>",
    });
    setShowEditor(true);
  }

  function startEditArticle(a: Record<string, unknown>) {
    setEditingId(String(a.id));
    setArtForm({
      slug: String(a.slug || ""),
      title: String(a.title || ""),
      excerpt: String(a.excerpt || ""),
      cover_image_url: String(a.cover_image_url || ""),
      category: String(a.category || "حسابداری"),
      tags: Array.isArray(a.tags) ? (a.tags as string[]).join(", ") : "",
      reading_minutes: Number(a.reading_minutes || 5),
      is_featured: Boolean(a.is_featured),
      status: (String(a.status || "PUBLISHED") as "DRAFT" | "PUBLISHED" | "ARCHIVED"),
      author_name: String(a.author_name || "تیم آموزش Business OS"),
      content_html: String(a.content_html || ""),
    });
    setShowEditor(true);
  }

  function handleCoverUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      onToast("حداکثر حجم تصویر کاور ۲ مگابایت است.", "error");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setArtForm((p) => ({ ...p, cover_image_url: String(reader.result || "") }));
    };
    reader.readAsDataURL(file);
  }

  async function saveArticle(e: React.FormEvent) {
    e.preventDefault();
    try {
      const payload = {
        ...(editingId ? { id: editingId } : {}),
        slug: artForm.slug.trim().toLowerCase(),
        title: artForm.title.trim(),
        excerpt: artForm.excerpt.trim(),
        cover_image_url: artForm.cover_image_url.trim() || null,
        category: artForm.category.trim(),
        tags: artForm.tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        reading_minutes: Number(artForm.reading_minutes) || 5,
        is_featured: artForm.is_featured,
        status: artForm.status,
        author_name: artForm.author_name.trim(),
        content_html: artForm.content_html,
      };
      await apiFetch("/api/v1/platform/academy", {
        method: editingId ? "PATCH" : "POST",
        body: JSON.stringify(payload),
      });
      onToast(editingId ? "مقاله آموزشی با موفقیت ویرایش و منتشر شد." : "مقاله آموزشی جدید در آکادمی منتشر شد.");
      setShowEditor(false);
      setEditingId(null);
      loadData();
    } catch (err) {
      onToast(err instanceof Error ? err.message : "خطا در ذخیره آموزش", "error");
    }
  }

  async function deleteArticle(id: string) {
    try {
      await apiFetch(`/api/v1/platform/academy?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      onToast("مقاله آموزشی حذف شد.");
      loadData();
    } catch (err) {
      onToast(err instanceof Error ? err.message : "خطا در حذف مقاله", "error");
    }
  }

  // ============================================================================
  // SMS.IR & KAVENEGAR ACTIONS
  // ============================================================================
  async function saveSmsProvider(providerCode: string) {
    const draft = smsDrafts[providerCode];
    if (!draft) return;
    try {
      await apiFetch("/api/v1/platform/sms", {
        method: "PATCH",
        body: JSON.stringify({
          provider: providerCode,
          ...draft,
        }),
      });
      onToast(`تنظیمات درگاه پیامکی ${providerCode === "SMS_IR" ? "SMS.ir" : "کاوه‌نگار (Kavenegar)"} ذخیره شد.`);
      loadData();
    } catch (err) {
      onToast(err instanceof Error ? err.message : "خطا در ذخیره تنظیمات پیامک", "error");
    }
  }

  async function loadSmsIrLines(providerCode: string) {
    setSmsLineLookups((current) => ({ ...current, [providerCode]: { loading: true, result: current[providerCode]?.result } }));
    try {
      const result = await apiFetch<SmsIrLineLookup>(
        `/api/v1/platform/sms?action=lines&provider=${encodeURIComponent(providerCode)}`
      );
      setSmsLineLookups((current) => ({ ...current, [providerCode]: { loading: false, result } }));
      if (result.configured_line_matches) {
        onToast("خط تنظیم‌شده در فهرست خطوط مجاز همین کلید SMS.ir است.");
      } else if (result.line_numbers.length) {
        onToast("خط فعلی در فهرست مجاز این کلید نیست؛ یکی از خطوط دریافتی را انتخاب و ذخیره کنید.", "error");
      } else {
        onToast("برای این کلید SMS.ir خط ارسال فعالی برنگشت.", "error");
      }
    } catch (error) {
      setSmsLineLookups((current) => ({ ...current, [providerCode]: { loading: false, result: current[providerCode]?.result } }));
      onToast(error instanceof Error ? error.message : "دریافت خطوط مجاز SMS.ir ناموفق بود.", "error");
    }
  }

  async function sendTestSms(e: React.FormEvent) {
    e.preventDefault();
    try {
      const res = await apiFetch<{ provider: string; sandbox: boolean; message_id: string }>(
        "/api/v1/platform/sms",
        {
          method: "POST",
          body: JSON.stringify(testSmsForm),
        }
      );
      onToast(
        `پیامک تست از طریق ${res.provider} (${res.sandbox ? "حالت Sandbox" : "ارسال زنده"}) ثبت شد — شناسه: ${res.message_id}`
      );
      loadData();
    } catch (err) {
      onToast(err instanceof Error ? err.message : "خطا در ارسال پیامک تست", "error");
    }
  }

  // ============================================================================
  // CONTACT INQUIRIES ACTIONS
  // ============================================================================
  async function updateInquiryStatus(id: string, status: "REVIEWED" | "REPLIED" | "ARCHIVED") {
    try {
      await apiFetch("/api/v1/platform/inquiries", {
        method: "PATCH",
        body: JSON.stringify({ id, status }),
      });
      onToast("وضعیت پیام تماس با ما به‌روزرسانی شد.");
      loadData();
    } catch (err) {
      onToast(err instanceof Error ? err.message : "خطا در به‌روزرسانی پیام", "error");
    }
  }

  // ============================================================================
  // RENDER
  // ============================================================================
  if (mode === "academy") {
    return (
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs text-slate-500">
            آموزش‌های منتشرشده به‌صورت آنی در صفحات داینامیک <code className="font-mono">/academy/[slug]</code> و API اپلیکیشن اندروید نمایش داده می‌شوند.
          </div>
          <div className="flex gap-2">
            <a
              href="/academy"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-xl glass-input px-3 py-2 text-xs font-medium"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              <span>مشاهده آکادمی عمومی</span>
            </a>
            <button
              type="button"
              onClick={startNewArticle}
              className="inline-flex items-center gap-1.5 rounded-xl bg-violet-600 hover:bg-violet-700 text-white px-4 py-2 text-xs font-semibold cursor-pointer"
            >
              <Plus className="h-4 w-4" />
              <span>ثبت آموزش جدید</span>
            </button>
          </div>
        </div>

        {showEditor && (
          <form onSubmit={saveArticle} className="glass-primary p-5 space-y-4 text-xs">
            <div className="flex items-center justify-between border-b border-slate-200/60 pb-3">
              <h3 className="text-sm font-bold flex items-center gap-2">
                <BookOpen className="h-4 w-4 text-violet-600" />
                <span>{editingId ? "ویرایش آموزش" : "ثبت آموزش جدید با ادیتور پیشرفته"}</span>
              </h3>
              <button type="button" onClick={() => setShowEditor(false)} className="text-slate-500 cursor-pointer">
                بستن
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="md:col-span-2">
                <label className="block font-medium mb-1">عنوان آموزش *</label>
                <input
                  required
                  value={artForm.title}
                  onChange={(e) => setArtForm({ ...artForm, title: e.target.value })}
                  placeholder="مثلاً: آموزش گام‌به‌گام بستن سال مالی و صدور سند اختتامیه"
                  className="w-full glass-input px-3 py-2"
                />
              </div>
              <div>
                <label className="block font-medium mb-1">اسلاگ یکتا (URL انگلیسی) *</label>
                <input
                  required
                  dir="ltr"
                  value={artForm.slug}
                  onChange={(e) => setArtForm({ ...artForm, slug: e.target.value })}
                  placeholder="fiscal-year-guide"
                  className="w-full glass-input px-3 py-2 font-mono text-left"
                />
              </div>
              <div>
                <label className="block font-medium mb-1">دسته‌بندی</label>
                <select
                  value={artForm.category}
                  onChange={(e) => setArtForm({ ...artForm, category: e.target.value })}
                  className="w-full glass-input px-3 py-2"
                >
                  <option value="حسابداری">حسابداری</option>
                  <option value="انبارداری و Sync">انبارداری و Sync</option>
                  <option value="مالی شخصی">مالی شخصی</option>
                  <option value="فروش و خزانه">فروش و خزانه</option>
                  <option value="شروع سریع">شروع سریع</option>
                </select>
              </div>
              <div>
                <label className="block font-medium mb-1">برچسب‌ها (با ویرگول جدا کنید)</label>
                <input
                  value={artForm.tags}
                  onChange={(e) => setArtForm({ ...artForm, tags: e.target.value })}
                  className="w-full glass-input px-3 py-2"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block font-medium mb-1">زمان مطالعه (دقیقه)</label>
                  <input
                    type="number"
                    min={1}
                    max={120}
                    value={artForm.reading_minutes}
                    onChange={(e) => setArtForm({ ...artForm, reading_minutes: Number(e.target.value) })}
                    className="w-full glass-input px-3 py-2 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium mb-1">وضعیت انتشار</label>
                  <select
                    value={artForm.status}
                    onChange={(e) => setArtForm({ ...artForm, status: e.target.value as typeof artForm.status })}
                    className="w-full glass-input px-3 py-2"
                  >
                    <option value="PUBLISHED">منتشرشده (PUBLISHED)</option>
                    <option value="DRAFT">پیش‌نویس (DRAFT)</option>
                    <option value="ARCHIVED">بایگانی (ARCHIVED)</option>
                  </select>
                </div>
              </div>
            </div>

            <div>
              <label className="block font-medium mb-1">خلاصه کوتاه (برای کارت آموزش و سئو) *</label>
              <textarea
                required
                rows={2}
                value={artForm.excerpt}
                onChange={(e) => setArtForm({ ...artForm, excerpt: e.target.value })}
                className="w-full glass-input px-3 py-2"
              />
            </div>

            {/* Cover Image URL + Upload */}
            <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
              <div className="md:col-span-8">
                <label className="block font-medium mb-1">تصویر شاخص آموزش (لینک یا آپلود)</label>
                <input
                  dir="ltr"
                  value={artForm.cover_image_url}
                  onChange={(e) => setArtForm({ ...artForm, cover_image_url: e.target.value })}
                  placeholder="/images/academy-accounting.png"
                  className="w-full glass-input px-3 py-2 font-mono text-left"
                />
              </div>
              <div className="md:col-span-2">
                <label className="w-full inline-flex items-center justify-center gap-1.5 glass-input px-3 py-2 cursor-pointer hover:border-violet-400">
                  <Upload className="h-3.5 w-3.5" />
                  <span>آپلود کاور</span>
                  <input type="file" accept="image/*" className="hidden" onChange={handleCoverUpload} />
                </label>
              </div>
              <label className="md:col-span-2 flex items-center gap-2 py-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={artForm.is_featured}
                  onChange={(e) => setArtForm({ ...artForm, is_featured: e.target.checked })}
                />
                <span>آموزش ویژه (Featured)</span>
              </label>
            </div>

            {/* Rich Text Editor */}
            <div>
              <label className="block font-medium mb-1.5">محتوای کامل آموزشی (ادیتور متن پیشرفته + درج تصویر)</label>
              <RichTextEditor
                value={artForm.content_html}
                onChange={(html) => setArtForm((p) => ({ ...p, content_html: html }))}
              />
            </div>

            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setShowEditor(false)} className="glass-input px-4 py-2 cursor-pointer">
                انصراف
              </button>
              <button
                type="submit"
                className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white px-5 py-2 font-semibold cursor-pointer"
              >
                <Save className="h-4 w-4" />
                <span>{editingId ? "ذخیره تغییرات" : "انتشار آموزش"}</span>
              </button>
            </div>
          </form>
        )}

        <div className="glass-data p-5 overflow-x-auto">
          <table className="w-full text-xs text-right">
            <thead className="border-b border-slate-200 dark:border-slate-700 text-slate-500">
              <tr>
                <th className="px-3 py-2">عنوان و اسلاگ</th>
                <th className="px-3 py-2">دسته‌بندی</th>
                <th className="px-3 py-2">بازدید / زمان مطالعه</th>
                <th className="px-3 py-2">وضعیت</th>
                <th className="px-3 py-2">عملیات</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200/50 dark:divide-slate-700/40">
              {articles.map((a) => (
                <tr key={String(a.id)}>
                  <td className="px-3 py-2.5">
                    <div className="font-bold">{String(a.title)}</div>
                    <div className="font-mono text-[11px] text-slate-400">/academy/{String(a.slug)}</div>
                  </td>
                  <td className="px-3 py-2.5">{String(a.category)}</td>
                  <td className="px-3 py-2.5 tabular-nums">
                    {String(a.view_count ?? 0)} بازدید • {String(a.reading_minutes ?? 5)} دقیقه
                  </td>
                  <td className="px-3 py-2.5">
                    <span
                      className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                        a.status === "PUBLISHED"
                          ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                          : "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                      }`}
                    >
                      {String(a.status)}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-1.5">
                      <a
                        href={`/academy/${String(a.slug)}`}
                        target="_blank"
                        rel="noreferrer"
                        className="glass-input p-1.5"
                        title="مشاهده"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                      <button
                        type="button"
                        onClick={() => startEditArticle(a)}
                        className="glass-input p-1.5 text-indigo-600 cursor-pointer"
                        title="ویرایش"
                      >
                        <Edit3 className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteArticle(String(a.id))}
                        className="glass-input p-1.5 text-rose-600 cursor-pointer"
                        title="حذف"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  // ============================================================================
  // SMS.IR & KAVENEGAR GATEWAY SETTINGS UI
  // ============================================================================
  if (mode === "sms") {
    return (
      <div className="space-y-5">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {smsProviders.map((p) => {
            const code = String(p.provider);
            const draft = smsDrafts[code] ?? {};
            const isSmsIr = code === "SMS_IR";
            const lineLookup = smsLineLookups[code];
            const currentLineMatches = Boolean(lineLookup?.result && lineLookup.result.line_numbers.includes(normalizeSmsLineForCompare(draft.line_number)));
            return (
              <div key={code} className="glass-primary p-5 space-y-4 text-xs">
                <div className="flex items-center justify-between border-b border-slate-200/60 pb-3">
                  <div>
                    <h3 className="text-sm font-bold flex items-center gap-2">
                      <MessageSquare className="h-4 w-4 text-violet-600" />
                      <span>{isSmsIr ? "پنل پیامکی SMS.ir (ایده‌پردازان)" : "پنل پیامکی کاوه‌نگار (Kavenegar)"}</span>
                    </h3>
                    <div className="font-mono text-[10px] text-slate-400 mt-0.5">
                      {isSmsIr ? "https://api.sms.ir/v1 (X-API-KEY)" : "https://api.kavenegar.com/v1/{API_KEY}"}
                    </div>
                  </div>
                  {Boolean(draft.is_default) && (
                    <span className="px-2.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 font-semibold text-[10px]">
                      درگاه پیش‌فرض فعال
                    </span>
                  )}
                </div>

                <div className="flex flex-wrap gap-4">
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={Boolean(draft.is_active)}
                      onChange={(e) =>
                        setSmsDrafts((prev) => ({ ...prev, [code]: { ...draft, is_active: e.target.checked } }))
                      }
                    />
                    <span>درگاه فعال</span>
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={Boolean(draft.is_default)}
                      onChange={(e) =>
                        setSmsDrafts((prev) => ({ ...prev, [code]: { ...draft, is_default: e.target.checked } }))
                      }
                    />
                    <span>پیش‌فرض کل سیستم (OTP و اعلان)</span>
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={Boolean(draft.sandbox_mode)}
                      onChange={(e) =>
                        setSmsDrafts((prev) => ({ ...prev, [code]: { ...draft, sandbox_mode: e.target.checked } }))
                      }
                    />
                    <span>حالت Sandbox (تست بدون ارسال واقعی)</span>
                  </label>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="md:col-span-2">
                    <label className="block font-medium mb-1">
                      کلید API ({isSmsIr ? "X-API-KEY" : "Kavenegar API Key"})
                    </label>
                    <input
                      dir="ltr"
                      type="text"
                      value={String(draft.api_key ?? "")}
                      onChange={(e) =>
                        setSmsDrafts((prev) => ({ ...prev, [code]: { ...draft, api_key: e.target.value } }))
                      }
                      placeholder={isSmsIr ? "کلید اختصاصی پنل SMS.ir را وارد کنید..." : "کلید اختصاصی کاوه‌نگار را وارد کنید..."}
                      className="w-full glass-input px-3 py-2 font-mono text-left"
                    />
                  </div>
                  <div>
                    <label className="block font-medium mb-1">{isSmsIr ? "شناسهٔ عددی خط ارسال SMS.ir" : "شماره خط ارسال‌کننده (Line / Sender)"}</label>
                    <input
                      dir="ltr"
                      inputMode={isSmsIr ? "numeric" : undefined}
                      value={String(draft.line_number ?? "")}
                      onChange={(e) =>
                        setSmsDrafts((prev) => ({ ...prev, [code]: { ...draft, line_number: e.target.value } }))
                      }
                      placeholder={isSmsIr ? "شناسهٔ خط از فهرست SMS.ir" : undefined}
                      className="w-full glass-input px-3 py-2 font-mono text-left"
                    />
                    {isSmsIr && <div className="mt-2 space-y-2">
                      <p className="text-[10px] leading-5 text-slate-500">آزمون SMS.ir و OTP از قالب Verify استفاده می‌کنند. شناسه خط برای ارسال پیامک‌های عادی است؛ دریافت خطوط مجاز پیامکی نمی‌فرستد.</p>
                      <button type="button" disabled={lineLookup?.loading} onClick={() => void loadSmsIrLines(code)} className="rounded-lg border border-violet-200 px-3 py-1.5 text-[10px] font-semibold text-violet-700 disabled:opacity-50">
                        {lineLookup?.loading ? "در حال دریافت خطوط…" : "دریافت خطوط مجاز از SMS.ir"}
                      </button>
                      {lineLookup?.result && <div className="rounded-lg bg-slate-50 p-2">
                        <p className={`text-[10px] ${currentLineMatches ? "text-emerald-700" : "text-amber-700"}`}>
                          {currentLineMatches ? "خط فعلی متعلق به همین کلید است." : `خط فعلی (${String(draft.line_number || "ثبت‌نشده")}) در خطوط این کلید نیست؛ یکی از خطوط زیر را انتخاب کنید.`}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {lineLookup.result.line_numbers.map((lineNumber) => <button key={lineNumber} type="button" onClick={() => setSmsDrafts((prev) => ({ ...prev, [code]: { ...draft, line_number: lineNumber } }))} className={`rounded-md border px-2 py-1 font-mono text-[10px] ${normalizeSmsLineForCompare(draft.line_number) === lineNumber ? "border-emerald-300 bg-emerald-50 text-emerald-800" : "border-slate-200 bg-white text-slate-700"}`}>
                            {lineNumber}{normalizeSmsLineForCompare(draft.line_number) === lineNumber ? " • انتخاب‌شده" : ""}
                          </button>)}
                          {!lineLookup.result.line_numbers.length && <span className="text-[10px] text-slate-500">این کلید خط فعالی ندارد.</span>}
                        </div>
                      </div>}
                    </div>}
                  </div>
                  <div>
                    <label className="block font-medium mb-1">
                      {isSmsIr ? "شناسه قالب OTP (TemplateId عددی)" : "نام الگوی اعتبارسنجی (Lookup Template)"}
                    </label>
                    <input
                      dir="ltr"
                      value={String(draft.otp_template_id ?? "")}
                      onChange={(e) =>
                        setSmsDrafts((prev) => ({ ...prev, [code]: { ...draft, otp_template_id: e.target.value } }))
                      }
                      className="w-full glass-input px-3 py-2 font-mono text-left"
                    />
                  </div>
                  {isSmsIr && <div>
                    <label className="block font-medium mb-1">نام پارامتر کد در قالب Verify</label>
                    <input
                      dir="ltr"
                      value={String(((draft.extra_config as Record<string, unknown> | undefined)?.otp_param_name) ?? "CODE")}
                      onChange={(e) => setSmsDrafts((prev) => ({
                        ...prev,
                        [code]: {
                          ...draft,
                          extra_config: { ...((draft.extra_config as Record<string, unknown> | undefined) ?? {}), otp_param_name: e.target.value },
                        },
                      }))}
                      className="w-full glass-input px-3 py-2 font-mono text-left"
                    />
                  </div>}
                  <div>
                    <label className="block font-medium mb-1">الگوی ارسال فاکتور (اختیاری)</label>
                    <input
                      dir="ltr"
                      value={String(draft.invoice_template_id ?? "")}
                      onChange={(e) =>
                        setSmsDrafts((prev) => ({ ...prev, [code]: { ...draft, invoice_template_id: e.target.value } }))
                      }
                      className="w-full glass-input px-3 py-2 font-mono text-left"
                    />
                  </div>
                  <div>
                    <label className="block font-medium mb-1">الگوی یادآوری سررسید چک</label>
                    <input
                      dir="ltr"
                      value={String(draft.cheque_template_id ?? "")}
                      onChange={(e) =>
                        setSmsDrafts((prev) => ({ ...prev, [code]: { ...draft, cheque_template_id: e.target.value } }))
                      }
                      className="w-full glass-input px-3 py-2 font-mono text-left"
                    />
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => saveSmsProvider(code)}
                  className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-violet-600 hover:bg-violet-700 text-white py-2 font-semibold cursor-pointer"
                >
                  <Save className="h-4 w-4" />
                  <span>ذخیره تنظیمات {isSmsIr ? "SMS.ir" : "کاوه‌نگار"}</span>
                </button>
              </div>
            );
          })}
        </div>

        {/* Live Test SMS Dispatcher */}
        <form onSubmit={sendTestSms} className="glass-primary p-5 space-y-3 text-xs">
          <h3 className="text-sm font-bold flex items-center gap-2">
            <Send className="h-4 w-4 text-emerald-600" />
            <span>ارسال پیامک آزمایشی (تست درگاه SMS.ir / Kavenegar)</span>
          </h3>
          {testSmsForm.provider === "SMS_IR" && <p className="rounded-lg bg-teal-50 px-3 py-2 text-[11px] text-teal-800">آزمون SMS.ir از قالب Verify و شناسهٔ قالب OTP ثبت‌شده استفاده می‌کند و یک کد ۶ رقمی می‌فرستد.</p>}
          <div className="grid grid-cols-1 md:grid-cols-12 gap-2.5">
            <select
              value={testSmsForm.provider}
              onChange={(e) => setTestSmsForm({ ...testSmsForm, provider: e.target.value as "SMS_IR" | "KAVENEGAR" })}
              className="md:col-span-3 glass-input px-3 py-2"
            >
              <option value="SMS_IR">SMS.ir</option>
              <option value="KAVENEGAR">کاوه‌نگار (Kavenegar)</option>
            </select>
            <input
              required
              dir="ltr"
              value={testSmsForm.mobile}
              onChange={(e) => setTestSmsForm({ ...testSmsForm, mobile: e.target.value })}
              placeholder="0912..."
              className="md:col-span-3 glass-input px-3 py-2 font-mono text-left"
            />
            <input
              required
              disabled={testSmsForm.provider === "SMS_IR"}
              placeholder={testSmsForm.provider === "SMS_IR" ? "متن و پارامتر از قالب Verify گرفته می‌شود" : undefined}
              value={testSmsForm.message}
              onChange={(e) => setTestSmsForm({ ...testSmsForm, message: e.target.value })}
              className="md:col-span-4 glass-input px-3 py-2"
            />
            <button type="submit" className="md:col-span-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white py-2 font-semibold cursor-pointer">
              ارسال تست
            </button>
          </div>
        </form>

        {/* SMS Delivery Logs */}
        <div className="glass-data p-5 overflow-x-auto">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-bold">گزارش ارسال‌های پیامکی اخیر ({smsLogsList.length})</h3>
            <button type="button" onClick={loadData} className="text-xs text-violet-600 inline-flex items-center gap-1 cursor-pointer">
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
              <span>بروزرسانی</span>
            </button>
          </div>
          <table className="w-full text-xs text-right">
            <thead className="border-b border-slate-200 dark:border-slate-700 text-slate-500">
              <tr>
                <th className="px-3 py-2">درگاه / نوع</th>
                <th className="px-3 py-2">موبایل گیرنده</th>
                <th className="px-3 py-2">پیش‌نمایش متن (OTP مخفی)</th>
                <th className="px-3 py-2">وضعیت / شناسه</th>
                <th className="px-3 py-2">زمان</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200/50 dark:divide-slate-700/40">
              {smsLogsList.map((l) => (
                <tr key={String(l.id)}>
                  <td className="px-3 py-2 font-mono text-[11px]">{String(l.provider)} • {String(l.purpose)}</td>
                  <td className="px-3 py-2 font-mono">{String(l.recipient_mobile)}</td>
                  <td className="px-3 py-2">{String(l.message_preview)}</td>
                  <td className="px-3 py-2">
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
                      {String(l.status)}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-slate-400">{formatDateTimeFa(l.created_at as string)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  // ============================================================================
  // 4 PAYMENT GATEWAY ADAPTERS (ZARINPAL, ZIBAL, BALLEH PAY, SAMAN)
  // ============================================================================
  if (mode === "gateways") {
    return (
      <div className="space-y-5">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 text-xs">
          {gatewaysList.map((g) => {
            const code = String(g.gateway);
            const d = gwDrafts[code] ?? {};
            return (
              <div key={code} className="glass-primary p-5 space-y-3">
                <div className="flex items-center justify-between border-b border-slate-200/60 pb-2.5">
                  <div>
                    <div className="font-bold text-sm">{String(g.display_name_fa)}</div>
                    <div className="font-mono text-[10px] text-slate-400">{code}</div>
                  </div>
                  {Boolean(d.is_default) && (
                    <span className="px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-700 font-semibold text-[10px]">
                      درگاه پیش‌فرض
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap gap-3">
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={Boolean(d.is_active)}
                      onChange={(e) => setGwDrafts((p) => ({ ...p, [code]: { ...d, is_active: e.target.checked } }))}
                    />
                    <span>فعال</span>
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={Boolean(d.is_default)}
                      onChange={(e) => setGwDrafts((p) => ({ ...p, [code]: { ...d, is_default: e.target.checked } }))}
                    />
                    <span>پیش‌فرض</span>
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={Boolean(d.sandbox_mode)}
                      onChange={(e) => setGwDrafts((p) => ({ ...p, [code]: { ...d, sandbox_mode: e.target.checked } }))}
                    />
                    <span>حالت Sandbox</span>
                  </label>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                  <div>
                    <label className="block mb-1 font-medium">
                      {code === "SAMAN" ? "Terminal ID" : code === "BALLEH_PAY" ? "Provider Token" : "Merchant ID"}
                    </label>
                    <input
                      dir="ltr"
                      value={String(d.merchant_id ?? "")}
                      onChange={(e) => setGwDrafts((p) => ({ ...p, [code]: { ...d, merchant_id: e.target.value } }))}
                      className="w-full glass-input px-3 py-1.5 font-mono text-left"
                    />
                  </div>
                  <div>
                    <label className="block mb-1 font-medium">
                      {code === "BALLEH_PAY" ? "Bot Token" : "Callback Base URL (اختیاری)"}
                    </label>
                    <input
                      dir="ltr"
                      value={code === "BALLEH_PAY" ? String(d.secret_token ?? "") : String(d.callback_base_url ?? "")}
                      onChange={(e) =>
                        setGwDrafts((p) => ({
                          ...p,
                          [code]: code === "BALLEH_PAY" ? { ...d, secret_token: e.target.value } : { ...d, callback_base_url: e.target.value },
                        }))
                      }
                      className="w-full glass-input px-3 py-1.5 font-mono text-left"
                    />
                  </div>
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await apiFetch("/api/v1/platform/payment-gateways", {
                        method: "PATCH",
                        body: JSON.stringify({ gateway: code, ...d }),
                      });
                      onToast(`پیکربندی درگاه ${code} ذخیره و در Audit ثبت شد.`);
                      loadData();
                    } catch (err) {
                      onToast(err instanceof Error ? err.message : "خطا در ذخیره درگاه", "error");
                    }
                  }}
                  className="w-full rounded-xl bg-violet-600 hover:bg-violet-700 text-white py-2 font-semibold cursor-pointer"
                >
                  ذخیره تنظیمات {code}
                </button>
              </div>
            );
          })}
        </div>

        <div className="glass-data p-5 overflow-x-auto text-xs">
          <h3 className="text-sm font-bold mb-3">سفارش‌های ارتقا پلن از درگاه‌های پرداخت ({recentOrders.length})</h3>
          <table className="w-full text-right">
            <thead className="border-b border-slate-200 dark:border-slate-700 text-slate-500">
              <tr>
                <th className="px-3 py-2">کد سفارش</th>
                <th className="px-3 py-2">درگاه</th>
                <th className="px-3 py-2">مبلغ (ریال)</th>
                <th className="px-3 py-2">کد پیگیری</th>
                <th className="px-3 py-2">وضعیت</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200/50 tabular-nums">
              {recentOrders.map((o) => (
                <tr key={String(o.id)}>
                  <td className="px-3 py-2 font-mono">{String(o.payment_reference)}</td>
                  <td className="px-3 py-2 font-mono">{String(o.gateway)}</td>
                  <td className="px-3 py-2 font-bold">{String(o.amount_irr)}</td>
                  <td className="px-3 py-2 font-mono text-slate-500">{String(o.gateway_ref_id || "—")}</td>
                  <td className="px-3 py-2">
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/15 text-emerald-700">
                      {String(o.status)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  // ============================================================================
  // CONTACT INQUIRIES INBOX
  // ============================================================================
  return (
    <div className="glass-data p-5 space-y-3 text-xs">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold flex items-center gap-2">
          <Mail className="h-4 w-4 text-violet-600" />
          <span>پیام‌های دریافتی از فرم تماس با ما ({inquiries.length})</span>
        </h3>
        <button type="button" onClick={loadData} className="text-violet-600 inline-flex items-center gap-1 cursor-pointer">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          <span>بروزرسانی</span>
        </button>
      </div>
      {inquiries.length === 0 && (
        <div className="text-slate-400 py-6 text-center">هنوز پیامی از فرم تماس با ما ثبت نشده است.</div>
      )}
      {inquiries.map((inq) => (
        <div key={String(inq.id)} className="glass-secondary p-4 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="font-bold text-sm">{String(inq.subject)}</div>
            <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-violet-500/15 text-violet-700 dark:text-violet-300">
              {String(inq.status)}
            </span>
          </div>
          <p className="text-slate-600 dark:text-slate-300 leading-relaxed">{String(inq.message)}</p>
          <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-200/50 text-[11px] text-slate-500">
            <span>
              {String(inq.full_name)} • <span className="font-mono">{String(inq.mobile)}</span>{" "}
              {inq.company_name ? `• ${String(inq.company_name)}` : ""}
            </span>
            <div className="flex gap-1.5">
              {inq.status !== "REPLIED" && (
                <button
                  type="button"
                  onClick={() => updateInquiryStatus(String(inq.id), "REPLIED")}
                  className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 text-white px-3 py-1 cursor-pointer"
                >
                  <CheckCircle2 className="h-3 w-3" />
                  <span>پاسخ داده شد</span>
                </button>
              )}
              {inq.status !== "ARCHIVED" && (
                <button
                  type="button"
                  onClick={() => updateInquiryStatus(String(inq.id), "ARCHIVED")}
                  className="rounded-lg glass-input px-2.5 py-1 cursor-pointer"
                >
                  بایگانی
                </button>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

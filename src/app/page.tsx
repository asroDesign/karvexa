import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import {
  ArrowLeft,
  BookOpen,
  Boxes,
  CheckCircle2,
  Landmark,
  ShieldCheck,
  ShoppingBag,
  Smartphone,
  Sparkles,
  Wallet,
} from "lucide-react";
import { db } from "@/db";
import { academyArticles, plans } from "@/db/schema";
import { ensureSeeded } from "@/db/seed";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { formatIrr } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function SaasHomePage() {
  await ensureSeeded();

  const [featuredArticles, activePlans] = await Promise.all([
    db
      .select()
      .from(academyArticles)
      .where(eq(academyArticles.status, "PUBLISHED"))
      .orderBy(desc(academyArticles.isFeatured), desc(academyArticles.publishedAt))
      .limit(3),
    db.select().from(plans).where(eq(plans.isActive, true)).orderBy(plans.priceIrr),
  ]);

  const features = [
    {
      title: "حسابداری دوبل و چرخه کامل سال مالی",
      desc: "کدینگ ۴ سطحی، سند افتتاحیه و اختتامیه خودکار، بستن کنترل‌شده حساب‌ها، تراز آزمایشی و خروجی رسمی Excel (.xlsx).",
      icon: BookOpen,
      tone: "text-violet-600 bg-violet-500/15",
    },
    {
      title: "انبارداری اتمیک و پیشنهاد خرید هوشمند",
      desc: "کاردکس Stock Ledger، انتقال اتمیک بین انبارها، ردیابی مستقل رنگ و سایز و پیشنهاد سفارش خرید با لحاظ PO در راه.",
      icon: Boxes,
      tone: "text-teal-600 bg-teal-500/15",
    },
    {
      title: "اپلیکیشن اندروید آفلاین + Sync دوطرفه",
      desc: "ثبت فاکتور بدون اینترنت با Outbox محلی، کنترل Idempotency و رفع تعارض هوشمند بدون موجودی منفی یا تکرار سند.",
      icon: Smartphone,
      tone: "text-sky-600 bg-sky-500/15",
    },
    {
      title: "فروش سریع با پرداخت ترکیبی و چاپ PDF",
      desc: "پرداخت هم‌زمان نقد + کارت‌خوان POS + نسیه روی یک فاکتور، باشگاه مشتریان، پیش‌فاکتور و خروجی چاپی راست‌به‌چپ.",
      icon: ShoppingBag,
      tone: "text-emerald-600 bg-emerald-500/15",
    },
    {
      title: "مالی شخصی مالک جدا از سود شرکت",
      desc: "ثبت برداشت‌های شخصی، اقساط و مخارج تکرارشونده بدون کاهش کاذب سود عملیاتی کسب‌وکار و با حریم خصوصی کامل.",
      icon: Wallet,
      tone: "text-rose-600 bg-rose-500/15",
    },
    {
      title: "چک صیادی، خزانه و امنیت چندمستاجری RLS",
      desc: "چرخه کامل چک‌ها با نمودار میله‌ای روزانه، دعوت کاربران با دسترسی شعب/انبار، لاگ ممیزی و ارسال OTP پیامکی.",
      icon: Landmark,
      tone: "text-amber-600 bg-amber-500/15",
    },
  ];

  return (
    <div className="min-h-screen flex flex-col">
      <SiteHeader />

      <main className="flex-1">
        {/* Hero Section */}
        <section className="max-w-7xl mx-auto px-4 sm:px-6 pt-12 pb-16">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-center">
            <div className="lg:col-span-6 space-y-6">
              <div className="inline-flex items-center gap-2 rounded-full glass-secondary px-3.5 py-1.5 text-xs font-semibold text-violet-700 dark:text-violet-300">
                <Sparkles className="h-3.5 w-3.5" />
                <span>نسخه SaaS ابری + اپلیکیشن آفلاین اندروید</span>
              </div>

              <h1 className="text-3xl sm:text-4xl lg:text-[2.75rem] font-extrabold leading-[1.25] tracking-tight">
                سیستم‌عامل هوشمند{" "}
                <span className="bg-gradient-to-l from-violet-600 to-emerald-600 bg-clip-text text-transparent">
                  حسابداری، انبار و فروش
                </span>{" "}
                برای رشد دقیق کسب‌وکارها
              </h1>

              <p className="text-sm sm:text-base text-slate-600 dark:text-slate-300 leading-relaxed">
                Business OS تمام نیازهای مالی و عملیاتی شما — از حسابداری دوبل و بستن سال مالی تا انبارداری چندشعبه‌ای، فروش آفلاین اندروید و مالی شخصی مالک — را در یک پلتفرم سریع، امن و مدرن یکپارچه می‌کند.
              </p>

              <div className="flex flex-wrap items-center gap-3 pt-1">
                <Link
                  href="/app"
                  className="inline-flex items-center gap-2 rounded-2xl bg-gradient-to-l from-violet-600 to-indigo-600 hover:from-violet-700 hover:to-indigo-700 text-white px-6 py-3.5 text-sm font-bold shadow-md transition-all"
                >
                  <span>شروع رایگان و ورود به پنل</span>
                  <ArrowLeft className="h-4 w-4" />
                </Link>
                <Link
                  href="/pricing"
                  className="inline-flex items-center gap-2 rounded-2xl glass-primary px-6 py-3.5 text-sm font-semibold hover:border-violet-400"
                >
                  <span>مشاهده تعرفه‌ها</span>
                </Link>
                <Link
                  href="/academy"
                  className="inline-flex items-center gap-2 rounded-2xl glass-secondary px-5 py-3.5 text-sm font-medium hover:border-emerald-400"
                >
                  <span>آموزش‌های رایگان</span>
                </Link>
              </div>

              <div className="grid grid-cols-3 gap-3 pt-3 text-xs">
                <div className="glass-secondary p-3 text-center">
                  <div className="font-extrabold text-base tabular-nums text-violet-600 dark:text-violet-400">
                    ۱۰۰٪
                  </div>
                  <div className="text-slate-500 mt-0.5">حسابداری دوبل دقیق</div>
                </div>
                <div className="glass-secondary p-3 text-center">
                  <div className="font-extrabold text-base tabular-nums text-emerald-600 dark:text-emerald-400">
                    آفلاین
                  </div>
                  <div className="text-slate-500 mt-0.5">همگام‌سازی اندروید</div>
                </div>
                <div className="glass-secondary p-3 text-center">
                  <div className="font-extrabold text-base tabular-nums text-sky-600 dark:text-sky-400">
                    RLS
                  </div>
                  <div className="text-slate-500 mt-0.5">امنیت چندمستاجری</div>
                </div>
              </div>
            </div>

            <div className="lg:col-span-6">
              <div className="glass-primary p-3 sm:p-4">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/images/saas-hero-dashboard.png"
                  alt="پیش‌نمایش داشبورد مالی Glassmorphism در Business OS"
                  className="w-full rounded-2xl object-cover aspect-video border border-white/40 dark:border-slate-700/50"
                />
                <div className="mt-4 grid grid-cols-3 gap-2.5 text-xs">
                  <div className="glass-secondary p-3">
                    <div className="text-[10px] text-slate-500">درگاه پیامک رسمی</div>
                    <div className="font-bold mt-0.5">SMS.ir + کاوه‌نگار</div>
                  </div>
                  <div className="glass-secondary p-3">
                    <div className="text-[10px] text-slate-500">درگاه اشتراک اندروید</div>
                    <div className="font-bold mt-0.5">کافه‌بازار ضد جعل</div>
                  </div>
                  <div className="glass-secondary p-3">
                    <div className="text-[10px] text-slate-500">حفظ داده پس از انقضا</div>
                    <div className="font-bold text-emerald-600 mt-0.5">خروجی همیشه آزاد</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Core Capabilities Grid */}
        <section className="max-w-7xl mx-auto px-4 sm:px-6 py-12">
          <div className="text-center max-w-2xl mx-auto mb-10">
            <h2 className="text-2xl sm:text-3xl font-extrabold">
              یک هسته مالی مطمئن برای تمام کسب‌وکارها
            </h2>
            <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 mt-2">
              از فروشگاه خرده‌فروشی و پوشاک تا شرکت‌های پخش عمده، بازرگانی و خدماتی
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {features.map((f) => {
              const Icon = f.icon;
              return (
                <div key={f.title} className="glass-primary p-6 space-y-3 hover:-translate-y-0.5">
                  <div className={`h-11 w-11 rounded-2xl flex items-center justify-center ${f.tone}`}>
                    <Icon className="h-5 w-5" />
                  </div>
                  <h3 className="text-base font-bold">{f.title}</h3>
                  <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                    {f.desc}
                  </p>
                </div>
              );
            })}
          </div>
        </section>

        {/* Pricing Preview Section */}
        <section className="max-w-7xl mx-auto px-4 sm:px-6 py-12">
          <div className="flex flex-wrap items-end justify-between gap-4 mb-8">
            <div>
              <h2 className="text-2xl font-extrabold">تعرفه‌های شفاف و منعطف Freemium</h2>
              <p className="text-xs text-slate-500 mt-1">
                با انقضای اشتراک هیچ‌یک از اطلاعات مالی شما حذف نمی‌شود و خروجی کامل داده همیشه آزاد است.
              </p>
            </div>
            <Link href="/pricing" className="text-xs font-bold text-violet-600 dark:text-violet-400">
              مقایسه کامل پلن‌ها ←
            </Link>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {activePlans.map((p) => (
              <div
                key={p.id}
                className={`glass-primary p-6 flex flex-col justify-between ${
                  p.code === "PRO" ? "ring-2 ring-violet-500/60" : ""
                }`}
              >
                <div>
                  <div className="flex items-center justify-between">
                    <h3 className="text-base font-bold">{p.nameFa}</h3>
                    <span className="font-mono text-[11px] px-2.5 py-0.5 rounded-full bg-violet-500/15 text-violet-700 dark:text-violet-300">
                      {p.code}
                    </span>
                  </div>
                  <div className="mt-4 text-2xl font-extrabold tabular-nums">
                    {Number(p.priceIrr) === 0 ? "رایگان" : `${formatIrr(p.priceIrr)} ریال`}
                    {Number(p.priceIrr) > 0 && (
                      <span className="text-xs font-normal text-slate-500 mr-1">
                        / {p.billingDays} روز
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-2 leading-relaxed">
                    {p.description}
                  </p>
                </div>
                <Link
                  href="/app"
                  className="mt-6 w-full inline-flex items-center justify-center rounded-xl bg-slate-900 dark:bg-violet-600 text-white py-2.5 text-xs font-semibold hover:opacity-90"
                >
                  شروع با این پلن
                </Link>
              </div>
            ))}
          </div>
        </section>

        {/* Dynamic Academy Articles Preview */}
        <section className="max-w-7xl mx-auto px-4 sm:px-6 py-12">
          <div className="flex flex-wrap items-end justify-between gap-4 mb-8">
            <div>
              <h2 className="text-2xl font-extrabold">آکادمی و راهنماهای آموزشی Business OS</h2>
              <p className="text-xs text-slate-500 mt-1">
                آموزش‌های عملی مدیریت حسابداری، انبار، فروش و Sync آفلاین (قابل مدیریت داینامیک از پنل ادمین)
              </p>
            </div>
            <Link href="/academy" className="text-xs font-bold text-violet-600 dark:text-violet-400">
              مشاهده همه آموزش‌ها ←
            </Link>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {featuredArticles.map((art) => (
              <Link
                key={art.id}
                href={`/academy/${art.slug}`}
                className="glass-primary overflow-hidden flex flex-col hover:-translate-y-0.5 group"
              >
                {art.coverImageUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={art.coverImageUrl}
                    alt={art.title}
                    className="w-full h-44 object-cover border-b border-slate-200/50 dark:border-slate-700/50"
                  />
                )}
                <div className="p-5 flex-1 flex flex-col justify-between space-y-3">
                  <div>
                    <div className="flex items-center justify-between text-[11px] text-violet-600 dark:text-violet-400 font-semibold mb-2">
                      <span>{art.category}</span>
                      <span className="text-slate-400">{art.readingMinutes} دقیقه مطالعه</span>
                    </div>
                    <h3 className="text-sm font-bold group-hover:text-violet-600 transition-colors leading-snug">
                      {art.title}
                    </h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-2 line-clamp-3 leading-relaxed">
                      {art.excerpt}
                    </p>
                  </div>
                  <div className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 pt-2">
                    مطالعه آموزش ←
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </section>

        {/* Bottom CTA Banner */}
        <section className="max-w-7xl mx-auto px-4 sm:px-6 pt-6">
          <div className="glass-modal p-8 sm:p-10 flex flex-wrap items-center justify-between gap-6">
            <div className="space-y-2 max-w-xl">
              <div className="inline-flex items-center gap-1.5 text-xs font-bold text-emerald-600">
                <ShieldCheck className="h-4 w-4" />
                <span>آماده تست زنده با داده‌های واقعی</span>
              </div>
              <h2 className="text-xl sm:text-2xl font-extrabold">
                همین حالا وارد پنل کاربری و مدیریت Business OS شوید
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                با ۴ نقش آماده (مدیر پلتفرم، حسابدار، مدیر انبار و مالک سازمان منقضی) تمام امکانات سیستم را آنلاین آزمایش کنید.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Link
                href="/app"
                className="inline-flex items-center gap-2 rounded-2xl bg-violet-600 hover:bg-violet-700 text-white px-6 py-3 text-sm font-bold"
              >
                <CheckCircle2 className="h-4 w-4" />
                <span>ورود به پنل Business OS</span>
              </Link>
              <Link
                href="/contact"
                className="inline-flex items-center gap-2 rounded-2xl glass-input px-6 py-3 text-sm font-semibold"
              >
                <span>درخواست دمو و مشاوره</span>
              </Link>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}

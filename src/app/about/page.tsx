import Link from "next/link";
import { sql } from "drizzle-orm";
import { Database, Lock, ShieldCheck, Smartphone } from "lucide-react";
import { db } from "@/db";
import { academyArticles, organizations, users } from "@/db/schema";
import { ensureSeeded } from "@/db/seed";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";

export const dynamic = "force-dynamic";

export default async function AboutPage() {
  await ensureSeeded();

  const [[orgStat], [userStat], [artStat]] = await Promise.all([
    db.select({ total: sql<number>`count(*)::int` }).from(organizations),
    db.select({ total: sql<number>`count(*)::int` }).from(users),
    db.select({ total: sql<number>`count(*)::int` }).from(academyArticles),
  ]);

  return (
    <div className="min-h-screen flex flex-col">
      <SiteHeader />

      <main className="flex-1 max-w-5xl w-full mx-auto px-4 sm:px-6 py-12 space-y-10">
        <div className="glass-primary p-8 sm:p-10 space-y-4">
          <span className="inline-block rounded-full bg-violet-500/15 text-violet-700 dark:text-violet-300 px-3 py-1 text-xs font-semibold">
            درباره Business OS
          </span>
          <h1 className="text-3xl font-extrabold leading-snug">
            ساخته شده بر پایه صحت مالی مطلق، سرعت آفلاین و تجربه کاربری مدرن
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-300 leading-loose">
            Business OS با هدف رفع شکاف میان نرم‌افزارهای حسابداری پیچیده قدیمی و اپلیکیشن‌های ساده فروشگاهی طراحی شده است. در هسته این سامانه، یک موتور واقعی حسابداری دوبل، کاردکس انبار مبتنی بر Stock Ledger، و یک پروتکل همگام‌سازی آفلاین دوطرفه برای اپلیکیشن اندروید قرار دارد که حتی در شرایط قطع اینترنت، صحت ریال‌به‌ریال حساب‌ها و موجودی انبار را تضمین می‌کند.
          </p>
        </div>

        {/* Live Platform Metrics */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="glass-primary p-6 text-center">
            <div className="text-3xl font-extrabold text-violet-600 tabular-nums">
              {orgStat?.total ?? 0}+
            </div>
            <div className="text-xs text-slate-500 mt-1">سازمان و کسب‌وکار فعال</div>
          </div>
          <div className="glass-primary p-6 text-center">
            <div className="text-3xl font-extrabold text-emerald-600 tabular-nums">
              {userStat?.total ?? 0}+
            </div>
            <div className="text-xs text-slate-500 mt-1">کاربر و حسابدار تاییدشده</div>
          </div>
          <div className="glass-primary p-6 text-center">
            <div className="text-3xl font-extrabold text-sky-600 tabular-nums">
              {artStat?.total ?? 0}
            </div>
            <div className="text-xs text-slate-500 mt-1">راهنما و مقاله تخصصی آکادمی</div>
          </div>
        </div>

        {/* Engineering Pillars */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5 text-xs">
          {[
            {
              icon: Database,
              title: "دقت اعشاری بدون Float",
              desc: "تمام محاسبات مالی و مقداری در PostgreSQL با نوع NUMERIC و در لایه منطق با BigInt ثابت‌اعشار انجام می‌شود تا هیچ خطای گردکردن رخ ندهد.",
            },
            {
              icon: ShieldCheck,
              title: "ایزوله‌سازی کامل چندمستاجری (RLS)",
              desc: "علاوه بر بررسی عضویت کاربر در لایه API، سیاست‌های PostgreSQL Row Level Security روی بیش از ۸۰ جدول مستاجری فعال است.",
            },
            {
              icon: Smartphone,
              title: "همگام‌سازی بدون تکرار و بدون LWW مالی",
              desc: "با الگوی Outbox/Inbox، کلید Idempotency و قفل تراکنشی انبار، هیچ فاکتور یا پرداختی در اثر قطعی اینترنت تکراری ثبت نمی‌شود.",
            },
            {
              icon: Lock,
              title: "حفظ حریم خصوصی و مالکیت داده‌ها",
              desc: "اطلاعات مالی شخصی مالک از دسترسی پرسنل جدا است و در صورت انقضای اشتراک نیز خروجی کامل داده‌ها همیشه در دسترس شماست.",
            },
          ].map((item) => {
            const Icon = item.icon;
            return (
              <div key={item.title} className="glass-primary p-6 flex items-start gap-4">
                <div className="h-10 w-10 rounded-xl bg-violet-500/15 text-violet-600 flex items-center justify-center shrink-0">
                  <Icon className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="font-bold text-sm">{item.title}</h3>
                  <p className="text-slate-600 dark:text-slate-300 mt-1 leading-relaxed">{item.desc}</p>
                </div>
              </div>
            );
          })}
        </div>

        <div className="text-center pt-2">
          <Link
            href="/contact"
            className="inline-flex items-center gap-2 rounded-2xl bg-violet-600 hover:bg-violet-700 text-white px-7 py-3 text-sm font-bold"
          >
            ارتباط با تیم فنی و فروش Business OS
          </Link>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}

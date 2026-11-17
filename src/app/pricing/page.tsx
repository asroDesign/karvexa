import Link from "next/link";
import { eq } from "drizzle-orm";
import { CheckCircle2, ShieldCheck, XCircle } from "lucide-react";
import { db } from "@/db";
import { features, planFeatures, plans } from "@/db/schema";
import { ensureSeeded } from "@/db/seed";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { formatIrr } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function PricingPage() {
  await ensureSeeded();

  const [allPlans, allFeatures, allPlanFeats] = await Promise.all([
    db.select().from(plans).where(eq(plans.isActive, true)).orderBy(plans.priceIrr),
    db.select().from(features),
    db.select().from(planFeatures),
  ]);

  return (
    <div className="min-h-screen flex flex-col">
      <SiteHeader />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-12 space-y-12">
        <div className="text-center max-w-2xl mx-auto space-y-3">
          <span className="inline-block rounded-full glass-secondary px-3.5 py-1 text-xs font-semibold text-violet-700 dark:text-violet-300">
            مدل Freemium شفاف — پرداخت امن از وب و کافه‌بازار
          </span>
          <h1 className="text-3xl sm:text-4xl font-extrabold">تعرفه‌ها و پلن‌های Business OS</h1>
          <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
            به‌صورت رایگان شروع کنید و همگام با رشد کسب‌وکار، قابلیت‌های چندانباره، تیم فروش، چک، امانی و همگام‌سازی چنددستگاهی را فعال کنید.
          </p>
        </div>

        {/* Plan Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-stretch">
          {allPlans.map((plan) => {
            const pFeats = allPlanFeats.filter((pf) => pf.planId === plan.id);
            const isPro = plan.code === "PRO";
            return (
              <div
                key={plan.id}
                className={`glass-primary p-7 flex flex-col justify-between ${
                  isPro ? "ring-2 ring-violet-500 shadow-lg" : ""
                }`}
              >
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h2 className="text-lg font-extrabold">{plan.nameFa}</h2>
                    {isPro && (
                      <span className="px-2.5 py-0.5 rounded-full bg-violet-600 text-white text-[10px] font-bold">
                        محبوب‌ترین
                      </span>
                    )}
                  </div>
                  <div className="text-3xl font-extrabold tabular-nums">
                    {Number(plan.priceIrr) === 0 ? "رایگان" : `${formatIrr(plan.priceIrr)}`}
                    {Number(plan.priceIrr) > 0 && (
                      <span className="text-xs font-normal text-slate-500 mr-1.5">
                        ریال / {plan.billingDays} روز
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                    {plan.description}
                  </p>
                  {plan.cafebazaarSku && (
                    <div className="font-mono text-[11px] text-slate-400">
                      CafeBazaar SKU: {plan.cafebazaarSku}
                    </div>
                  )}

                  <ul className="space-y-2.5 pt-4 border-t border-slate-200/60 dark:border-slate-700/60 text-xs">
                    {allFeatures.map((feat) => {
                      const link = pFeats.find((x) => x.featureId === feat.id);
                      const enabled = Boolean(link?.enabled);
                      return (
                        <li key={feat.id} className="flex items-center justify-between gap-2">
                          <span className="flex items-center gap-2">
                            {enabled ? (
                              <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
                            ) : (
                              <XCircle className="h-4 w-4 text-slate-300 dark:text-slate-600 shrink-0" />
                            )}
                            <span className={enabled ? "" : "text-slate-400"}>{feat.nameFa}</span>
                          </span>
                          {enabled && link?.limitValue && (
                            <span className="font-bold tabular-nums text-violet-600 dark:text-violet-400">
                              تا {link.limitValue}
                            </span>
                          )}
                        </li>
                      );
                    })}
                    <li className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400 font-semibold">
                      <CheckCircle2 className="h-4 w-4 shrink-0" />
                      <span>خروجی کامل داده‌ها و دفتر روزنامه (همیشه آزاد)</span>
                    </li>
                  </ul>
                </div>

                <Link
                  href="/app"
                  className={`mt-7 w-full inline-flex items-center justify-center rounded-2xl py-3 text-xs font-bold transition-all ${
                    isPro
                      ? "bg-gradient-to-l from-violet-600 to-indigo-600 text-white hover:opacity-95"
                      : "bg-slate-900 dark:bg-slate-800 text-white hover:opacity-90"
                  }`}
                >
                  فعالسازی و شروع ۱۴ روز تست رایگان
                </Link>
              </div>
            );
          })}
        </div>

        {/* Data Retention Promise */}
        <div className="glass-secondary p-6 flex flex-wrap items-center justify-between gap-4 text-xs">
          <div className="flex items-start gap-3 max-w-3xl">
            <ShieldCheck className="h-6 w-6 text-emerald-600 shrink-0 mt-0.5" />
            <div>
              <h3 className="font-bold text-sm">تضمین مالکیت و عدم حذف اطلاعات پس از انقضای اشتراک</h3>
              <p className="text-slate-600 dark:text-slate-300 mt-1 leading-relaxed">
                در Business OS با پایان دوره اشتراک، هیچ‌یک از اسناد مالی، کاردکس انبار یا لیست مشتریان شما حذف یا قفل نمی‌شود. دسترسی مشاهده و دریافت خروجی کامل (JSON / XLSX) همواره بدون محدودیت در اختیار مالک کسب‌وکار خواهد بود.
              </p>
            </div>
          </div>
          <Link
            href="/contact"
            className="rounded-xl glass-input px-4 py-2.5 font-semibold hover:border-violet-400"
          >
            نیاز به پلن سازمانی اختصاصی دارید؟
          </Link>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}

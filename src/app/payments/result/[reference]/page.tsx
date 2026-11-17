import Link from "next/link";
import { eq } from "drizzle-orm";
import { CheckCircle2, Smartphone, XCircle } from "lucide-react";
import { db } from "@/db";
import { paymentOrders, plans } from "@/db/schema";
import { ensureSeeded } from "@/db/seed";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { formatIrr } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function PaymentResultPage({
  params,
}: {
  params: Promise<{ reference: string }>;
}) {
  await ensureSeeded();
  const { reference } = await params;
  const decodedRef = decodeURIComponent(reference);

  const [row] = await db
    .select({
      order: paymentOrders,
      planNameFa: plans.nameFa,
      planCode: plans.code,
    })
    .from(paymentOrders)
    .innerJoin(plans, eq(paymentOrders.planId, plans.id))
    .where(eq(paymentOrders.paymentReference, decodedRef))
    .limit(1);

  const isVerified = row?.order.status === "VERIFIED";
  // Prompt 09A §13: Deep link carries ONLY safe opaque reference — NEVER client-trusted status flags!
  const deepLinkUrl = row
    ? `${row.order.returnDeepLink}?reference=${encodeURIComponent(row.order.paymentReference)}`
    : "karvexa://payment/result";

  return (
    <div className="min-h-screen flex flex-col">
      <SiteHeader />

      <main className="flex-1 flex items-center justify-center px-4 py-14">
        <div className="glass-modal max-w-lg w-full p-8 text-center space-y-5">
          {isVerified ? (
            <div className="h-16 w-16 mx-auto rounded-2xl bg-emerald-500/15 text-emerald-600 flex items-center justify-center">
              <CheckCircle2 className="h-9 w-9" />
            </div>
          ) : (
            <div className="h-16 w-16 mx-auto rounded-2xl bg-rose-500/15 text-rose-600 flex items-center justify-center">
              <XCircle className="h-9 w-9" />
            </div>
          )}

          <div className="space-y-1.5">
            <h1 className="text-xl font-extrabold">
              {isVerified
                ? "پرداخت شما با موفقیت در سرور تأیید شد"
                : "پرداخت تأیید نشد یا لغو گردید"}
            </h1>
            <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
              {isVerified
                ? "اشتراک و مجوزهای جدید سازمان فعال شده است. با کلیک روی دکمه زیر به اپلیکیشن بازگردید تا وضعیت جدید اشتراک دریافت و ذخیره شود."
                : "در صورت کسر وجه، مبلغ توسط شبکه بانکی بازگشت داده می‌شود."}
            </p>
          </div>

          {row && (
            <div className="glass-secondary p-4 text-xs space-y-2 text-right tabular-nums">
              <div className="flex justify-between">
                <span className="text-slate-500">پلن انتخابی:</span>
                <span className="font-bold">{row.planNameFa} ({row.planCode})</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">درگاه پرداخت:</span>
                <span className="font-mono font-semibold">{row.order.gateway}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">مبلغ:</span>
                <span className="font-bold">{formatIrr(row.order.amountIrr)} ریال</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">کد سفارش:</span>
                <span className="font-mono">{row.order.paymentReference}</span>
              </div>
              {row.order.gatewayRefId && (
                <div className="flex justify-between">
                  <span className="text-slate-500">کد پیگیری بانکی:</span>
                  <span className="font-mono text-emerald-600 font-bold">{row.order.gatewayRefId}</span>
                </div>
              )}
            </div>
          )}

          <div className="flex flex-col sm:flex-row gap-3 pt-2">
            <a
              href={deepLinkUrl}
              className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-l from-violet-600 to-indigo-600 text-white py-3 px-4 text-xs font-bold shadow-sm"
            >
              <Smartphone className="h-4 w-4" />
              <span>بازگشت به اپلیکیشن اندروید</span>
            </a>
            <Link
              href="/app"
              className="flex-1 inline-flex items-center justify-center rounded-xl glass-input py-3 px-4 text-xs font-semibold"
            >
              ورود به پنل وب
            </Link>
          </div>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}

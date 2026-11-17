import Link from "next/link";
import {
  Award,
  BarChart3,
  BookOpen,
  Boxes,
  CalendarRange,
  FileSpreadsheet,
  Landmark,
  MessageSquare,
  ShieldCheck,
  ShoppingBag,
  Smartphone,
  Wallet,
} from "lucide-react";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";

export default function ServicesPage() {
  const modules = [
    {
      title: "موتور حرفه‌ای حسابداری دوبل",
      desc: "کدینگ ۴ سطحی (گروه، کل، معین، تفصیلی)، اسناد تغییرناپذیر با سند معکوس، دفاتر روزنامه/کل/معین، تراز آزمایشی، سود و زیان و ترازنامه.",
      icon: BookOpen,
    },
    {
      title: "چرخه کامل سال مالی و بستن حساب",
      desc: "سند افتتاحیه، چک‌لیست هوشمند پیش از بستن سال، صدور سند اختتامیه به سود انباشته، انتقال خودکار حساب‌های دائمی به سال جدید و بازگشایی مجاز.",
      icon: CalendarRange,
    },
    {
      title: "انبارداری دقیق و تنوع کالا (Variants)",
      desc: "کاردکس تغییرناپذیر Stock Ledger، انتقال اتمیک بین انبارها، انبارگردانی با سند تعدیل اختلاف، مدیریت مستقل رنگ و سایز و روش‌های FIFO / میانگین موزون.",
      icon: Boxes,
    },
    {
      title: "پیشنهاد خرید هوشمند (Smart Replenishment)",
      desc: "تحلیل حداقل موجودی، نقطه سفارش، ذخیره اطمینان و سفارش‌های خرید در راه (Incoming PO) با تبدیل یک‌کلیکی به سفارش خرید رسمی.",
      icon: BarChart3,
    },
    {
      title: "فروش سریع، پرداخت ترکیبی و پیش‌فاکتور",
      desc: "تخصیص هم‌زمان نقد، کارت‌خوان (POS)، انتقال بانکی و نسیه در یک فاکتور، پیگیری تسویه بدهی‌های بعدی و خروجی چاپی PDF فارسی.",
      icon: ShoppingBag,
    },
    {
      title: "مالی شخصی مالک و برداشت‌ها",
      desc: "دفتر کل مجزای مخارج شخصی، اقساط، بودجه‌بندی و هزینه‌های تکرارشونده با ثبت دقیق برداشت مالک (کد ۳۲۰۱) بدون تحریف سود شرکت.",
      icon: Wallet,
    },
    {
      title: "خزانه‌داری، چک صیادی و کالای امانی",
      desc: "چرخه کامل وضعیت چک (دریافت، واگذاری، در جریان وصول، وصول یا برگشت) با نمودار روزانه و تسویه کارمزدی کالاهای امانی.",
      icon: Landmark,
    },
    {
      title: "همگام‌سازی آفلاین دوطرفه اندروید",
      desc: "معماری Local-First با Room Outbox، Inbox Idempotency، Opaque Cursor Pull، Tombstone و رفع تعارض دامنه‌محور بدون Last-Write-Wins روی اسناد مالی.",
      icon: Smartphone,
    },
    {
      title: "باشگاه مشتریان (CRM) و امتیاز وفاداری",
      desc: "پروفایل کامل خرید و مطالبات مشتری، سگمنت‌بندی خودکار (VIP / بدهکار / وفادار) و دفتر امتیازات تغییرناپذیر.",
      icon: Award,
    },
    {
      title: "دعوت کاربران، RBAC و امنیت چندمستاجری",
      desc: "دعوت با توکن یک‌بارمصرف، تفکیک نقش‌ها، محدودیت شعبه و انبار، ابطال فوری نشست‌ها، لاگ ممیزی و PostgreSQL Row Level Security.",
      icon: ShieldCheck,
    },
    {
      title: "اتصال رسمی پیامک (SMS.ir و کاوه‌نگار)",
      desc: "ارسال کد تایید OTP امن برای بازیابی رمز و احراز شماره موبایل، اعلان فاکتور و یادآوری سررسید چک با انتخاب درگاه پیش‌فرض از پنل ادمین.",
      icon: MessageSquare,
    },
    {
      title: "خروجی رسمی Excel (.xlsx) و PDF",
      desc: "دانلود مستقیم فایل اکسل دفتر روزنامه با تطابق دقیق تراز آزمایشی، به همراه قالب چاپی/PDF راست‌به‌چپ برای فاکتور و پیش‌فاکتور.",
      icon: FileSpreadsheet,
    },
  ];

  return (
    <div className="min-h-screen flex flex-col">
      <SiteHeader />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-12 space-y-10">
        <div className="text-center max-w-3xl mx-auto space-y-3">
          <span className="inline-block rounded-full glass-secondary px-3.5 py-1 text-xs font-semibold text-violet-700 dark:text-violet-300">
            معماری ماژولار یکپارچه (Modular Monolith)
          </span>
          <h1 className="text-3xl sm:text-4xl font-extrabold">خدمات و ماژول‌های Business OS</h1>
          <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
            تمام ابزارهایی که یک فروشگاه، شرکت پخش، مجموعه خدماتی یا تولیدی برای کنترل دقیق جریان نقدینگی، انبار و سودآوری واقعی نیاز دارد.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {modules.map((m) => {
            const Icon = m.icon;
            return (
              <div key={m.title} className="glass-primary p-6 space-y-3">
                <div className="h-10 w-10 rounded-xl bg-violet-500/15 text-violet-700 dark:text-violet-300 flex items-center justify-center">
                  <Icon className="h-5 w-5" />
                </div>
                <h2 className="text-base font-bold">{m.title}</h2>
                <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                  {m.desc}
                </p>
              </div>
            );
          })}
        </div>

        <div className="glass-modal p-7 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h3 className="text-lg font-bold">آماده تجربه آنلاین تمام این ماژول‌ها هستید؟</h3>
            <p className="text-xs text-slate-500 mt-1">
              بدون نیاز به نصب، همین حالا وارد نسخه آزمایشی زنده شوید یا راهنماهای آکادمی را مطالعه کنید.
            </p>
          </div>
          <div className="flex gap-3">
            <Link href="/app" className="rounded-xl bg-violet-600 text-white px-5 py-2.5 text-xs font-bold">
              ورود به پنل کاربری
            </Link>
            <Link href="/academy" className="rounded-xl glass-input px-5 py-2.5 text-xs font-semibold">
              مشاهده آموزش‌ها
            </Link>
          </div>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}

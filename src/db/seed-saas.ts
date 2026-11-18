import { db } from "@/db";
import { academyArticles, paymentGatewaySettings, smsSettings } from "@/db/schema";

const DEFAULT_PAYMENT_GATEWAYS = [
  {
    gateway: "ZARINPAL",
    displayNameFa: "درگاه پرداخت زرین‌پال (Zarinpal v4)",
    isActive: true,
    isDefault: true,
    sandboxMode: process.env.NODE_ENV !== "production",
    merchantId: "",
    secretToken: "",
    extraConfig: {
      request_url: "https://api.zarinpal.com/pg/v4/payment/request.json",
      verify_url: "https://api.zarinpal.com/pg/v4/payment/verify.json",
      start_pay_url: "https://www.zarinpal.com/pg/StartPay/",
      currency: "IRR",
    },
  },
  {
    gateway: "ZIBAL",
    displayNameFa: "درگاه پرداخت زیبال (Zibal v1)",
    isActive: true,
    isDefault: false,
    sandboxMode: process.env.NODE_ENV !== "production",
    merchantId: "zibal",
    secretToken: "",
    extraConfig: {
      request_url: "https://gateway.zibal.ir/v1/request",
      verify_url: "https://gateway.zibal.ir/v1/verify",
      start_pay_url: "https://gateway.zibal.ir/start/",
    },
  },
  {
    gateway: "BALLEH_PAY",
    displayNameFa: "درگاه پرداخت بله (Balleh Pay / Bale Wallet)",
    isActive: true,
    isDefault: false,
    sandboxMode: process.env.NODE_ENV !== "production",
    merchantId: "",
    secretToken: "",
    extraConfig: {
      api_base_url: "https://tapi.bale.ai",
      verify_method: "inquireTransaction",
    },
  },
  {
    gateway: "SAMAN",
    displayNameFa: "درگاه پرداخت الکترونیک سامان (SEP / شاپرک)",
    isActive: true,
    isDefault: false,
    sandboxMode: process.env.NODE_ENV !== "production",
    merchantId: "",
    secretToken: "",
    extraConfig: {
      token_url: "https://sep.shaparak.ir/onlinepg/onlinepg",
      send_token_url: "https://sep.shaparak.ir/OnlinePG/SendToken",
      verify_url: "https://sep.shaparak.ir/verifyTxnRandomSessionkey/ipg/VerifyTransaction",
    },
  },
];

const DEFAULT_SMS_PROVIDERS = [
  {
    provider: "SMS_IR",
    isActive: true,
    isDefault: true,
    sandboxMode: process.env.NODE_ENV !== "production",
    apiKey: "",
    lineNumber: "30007732000000",
    otpTemplateId: "100000",
    invoiceTemplateId: "100001",
    chequeTemplateId: "100002",
    extraConfig: {
      base_url: "https://api.sms.ir/v1",
      otp_param_name: "CODE",
    },
  },
  {
    provider: "KAVENEGAR",
    isActive: true,
    isDefault: false,
    sandboxMode: process.env.NODE_ENV !== "production",
    apiKey: "",
    lineNumber: "10004346",
    otpTemplateId: "businessos-otp",
    invoiceTemplateId: "businessos-invoice",
    chequeTemplateId: "businessos-cheque",
    extraConfig: {
      base_url: "https://api.kavenegar.com/v1",
      lookup_type: "sms",
    },
  },
];

const DEFAULT_ACADEMY_ARTICLES = [
  {
    slug: "double-entry-accounting-guide",
    title: "راهنمای جامع حسابداری دوبل، افتتاح حساب و بستن سال مالی در Business OS",
    excerpt:
      "چگونه کدینگ حساب‌های ۴ سطحی را تنظیم کنیم، سند افتتاحیه متوازن بزنیم، حساب‌های غیرفعال را ایمن ببندیم و در پایان سال سود خالص را به سود انباشته منتقل کنیم؟",
    coverImageUrl: "/images/academy-accounting.png",
    category: "حسابداری",
    tags: ["حسابداری دوبل", "سال مالی", "سند اختتامیه", "تراز آزمایشی"],
    readingMinutes: 6,
    isFeatured: true,
    authorName: "تیم تخصصی حسابداری Business OS",
    contentHtml: `
      <h2>چرا حسابداری دوبل ستون فقرات یک کسب‌وکار سالم است؟</h2>
      <p>در Business OS هر رویداد مالی — از صدور فاکتور فروش با پرداخت ترکیبی تا دریافت چک و ثبت هزینه سریع — به صورت خودکار و تراکنشی یک <strong>سند حسابداری دوبل متوازن</strong> تولید می‌کند که در آن جمع بدهکار همواره با جمع بستانکار برابر است.</p>
      <blockquote><strong>قانون طلایی:</strong> اسناد قطعی (Confirmed) هرگز به صورت مستقیم ویرایش یا حذف نمی‌شوند. هر اصلاحی از طریق سند معکوس یا اصلاحی با ردپای کامل ممیزی (Audit Trail) انجام می‌شود.</blockquote>
      <h3>گام‌های بستن سال مالی و انتقال به سال بعد</h3>
      <ol>
        <li><strong>چک‌لیست پیش از بستن:</strong> ابتدا تراز بودن آزمایشی، اسناد پیش‌نویس و پیکربندی حساب سود و زیان انباشته (کد ۳۳۰۱) را بررسی کنید.</li>
        <li><strong>پیش‌نمایش سند اختتامیه:</strong> سیستم به صورت خودکار تمام حساب‌های موقت درآمد و هزینه را صفر کرده و سود یا زیان خالص را به سود انباشته منتقل می‌کند.</li>
        <li><strong>افتتاح سال مالی بعد:</strong> تنها مانده حساب‌های دائمی (دارایی، بدهی و حقوق صاحبان سهام) به سند افتتاحیه سال جدید منتقل می‌شوند.</li>
      </ol>
      <p>همچنین در هر زمان می‌توانید دفتر روزنامه را با یک کلیک در قالب <strong>فایل رسمی Excel (.xlsx)</strong> خروجی بگیرید.</p>
    `,
  },
  {
    slug: "offline-android-sync-and-inventory",
    title: "مدیریت انبار، تنوع کالا و همگام‌سازی آفلاین اپلیکیشن اندروید",
    excerpt:
      "آشنایی با کاردکس Stock Ledger، انتقال اتمیک بین انبارها، ردیابی مستقل رنگ و سایز و نحوه جلوگیری از موجودی منفی هنگام فروش هم‌زمان چند دستگاه آفلاین.",
    coverImageUrl: "/images/academy-inventory-sync.png",
    category: "انبارداری و Sync",
    tags: ["انبارداری", "تنوع کالا", "آفلاین اندروید", "خرید هوشمند"],
    readingMinutes: 5,
    isFeatured: true,
    authorName: "تیم مهندسی نرم‌افزار Business OS",
    contentHtml: `
      <h2>کاردکس Stock Ledger؛ مرجع واحد و دقیق موجودی</h2>
      <p>در Business OS موجودی کالا هرگز با تغییر مستقیم یک عدد ساده محاسبه نمی‌شود. هر رسید ورود، حواله خروج، انتقال بین انبار یا تعدیل انبارگردانی یک ردیف تغییرناپذیر در <strong>Stock Ledger</strong> ثبت می‌کند.</p>
      <h3>همگام‌سازی آفلاین بدون از دست رفتن اطلاعات</h3>
      <ul>
        <li>در اپلیکیشن اندروید، فاکتورها و تغییرات به صورت اتمیک در دیتابیس Room و صف <code>Outbox</code> ذخیره می‌شوند.</li>
        <li>به محض برقراری اینترنت، درخواست‌ها با <code>Idempotency-Key</code> به سرور ارسال شده و در <code>sync_inbox</code> پردازش می‌شوند تا قطع ناگهانی اینترنت هرگز موجب ثبت فاکتور تکراری نشود.</li>
        <li>اگر دو فروشنده آفلاین هم‌زمان آخرین موجودی انبار را بفروشند، قفل تراکنشی سرور فروش اول را تایید و فروش دوم را وارد فرآیند تعارض (<code>STOCK_SHORTAGE</code>) می‌کند.</li>
      </ul>
      <h3>پیشنهاد خرید هوشمند (Smart Replenishment)</h3>
      <p>موتور تامین هوشمند با در نظر گرفتن موجودی قابل‌فروش، حداقل موجودی، زمان تامین و <strong>سفارش‌های خرید در راه (Incoming PO)</strong>، مقدار دقیق سفارش جدید را با دلیل شفاف پیشنهاد می‌دهد.</p>
    `,
  },
  {
    slug: "owner-personal-finance-separation",
    title: "جداسازی هوشمند مالی شخصی مالک از سود و زیان کسب‌وکار",
    excerpt:
      "چگونه برداشت‌های شخصی مالک، اجاره منزل و اقساط وام را ثبت کنیم تا حساب صندوق دقیق بماند اما سود خالص کسب‌وکار به اشتباه کاهش پیدا نکند؟",
    coverImageUrl: "/images/saas-hero-dashboard.png",
    category: "مالی شخصی",
    tags: ["مالی شخصی", "برداشت مالک", "هزینه تکرارشونده", "بودجه‌بندی"],
    readingMinutes: 4,
    isFeatured: false,
    authorName: "تیم مشاوره مالی Business OS",
    contentHtml: `
      <h2>اشتباه رایج کسب‌وکارها: ثبت برداشت شخصی به عنوان هزینه شرکت</h2>
      <p>بسیاری از صاحبان فروشگاه‌ها و شرکت‌ها زمانی که ۵ میلیون تومان از صندوق برای مخارج خانه برمی‌دارند، آن را در هزینه‌های شرکت ثبت می‌کنند؛ در نتیجه سود واقعی کسب‌وکار کوچک‌تر از واقعیت دیده می‌شود.</p>
      <h3>راه‌حل استاندارد در Business OS</h3>
      <p>با ثبت عملیات در بخش <strong>مالی شخصی و برداشت مالک</strong>:</p>
      <ol>
        <li>در حسابداری شرکت سند <strong>بدهکار: برداشت مالک (کد ۳۲۰۱) / بستانکار: صندوق یا بانک</strong> ثبت می‌شود.</li>
        <li>هیچ هزینه عملیاتی (گروه ۵) در شرکت ایجاد نمی‌شود و سود خالص کسب‌وکار کاملاً واقعی می‌ماند.</li>
        <li>در دفتر مالی شخصی مالک، می‌توانید همان ۵ میلیون تومان را به دسته‌بندی‌های شخصی (مثلاً ۳ میلیون مخارج خانه و ۲ میلیون قسط وام) تفکیک و پیگیری کنید.</li>
      </ol>
      <p>علاوه بر این، دسترسی پرسنل فروش و انبار به بخش مالی شخصی مالک به‌طور پیش‌فرض کاملاً مسدود است.</p>
    `,
  },
  {
    slug: "mixed-payments-pos-and-cheques",
    title: "فروش سریع با پرداخت ترکیبی (نقد، کارت‌خوان، نسیه) و مدیریت چرخه چک",
    excerpt:
      "آموزش ثبت هم‌زمان چندین روش پرداخت روی یک فاکتور فروش، پیگیری تسویه بدهی‌های بعدی مشتری و کنترل کامل وضعیت چک‌های صیادی با نمودار روزانه.",
    coverImageUrl: "/images/academy-accounting.png",
    category: "فروش و خزانه",
    tags: ["فروش سریع", "پرداخت ترکیبی", "چک صیادی", "باشگاه مشتریان"],
    readingMinutes: 5,
    isFeatured: false,
    authorName: "تیم آموزش Business OS",
    contentHtml: `
      <h2>تجربه فروش روزمره بدون پیچیدگی</h2>
      <p>در فروش روزانه بارها پیش می‌آید که مشتری بخشی از فاکتور را نقدی، بخشی را با دستگاه کارت‌خوان (POS) و مابقی را به صورت نسیه یا چک پرداخت کند. در Business OS کافیست مبلغ هر روش را در همان صفحه فاکتور وارد کنید.</p>
      <ul>
        <li>موجودی صندوق و حساب کارت‌خوان به صورت هم‌زمان به‌روزرسانی می‌شود.</li>
        <li>مانده پرداخت‌نشده به حساب دریافتنی مشتری اضافه شده و امتیاز وفاداری مشتری نیز در دفتر امتیازات ثبت می‌گردد.</li>
        <li>چک‌های دریافتی و پرداختی دارای چرخه کامل (دریافت، واگذاری به بانک، در جریان وصول، وصول قطعی یا برگشت) همراه با سند خودکار و نمودار میله‌ای روزانه هستند.</li>
      </ul>
    `,
  },
];

export async function ensureSaasSeeded() {
  for (const provider of DEFAULT_SMS_PROVIDERS) {
    await db.insert(smsSettings).values(provider).onConflictDoNothing();
  }
  for (const gw of DEFAULT_PAYMENT_GATEWAYS) {
    await db.insert(paymentGatewaySettings).values(gw).onConflictDoNothing();
  }
  for (const article of DEFAULT_ACADEMY_ARTICLES) {
    await db.insert(academyArticles).values(article).onConflictDoNothing();
  }
}

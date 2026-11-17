# Business OS — گزارش تغییرات وب‌سرویس‌ها برای ایجنت اپلیکیشن Android (API v1.2.0)

این سند شامل تمام تغییرات، اصلاحات امنیتی و اندپوینت‌های جدید بک‌اند است که باید به **ایجنت اپلیکیشن اندروید (Gemini)** ارسال شود.

---

## ۱. تغییر مهم امنیتی (Breaking Security Fix) در بازیابی رمز عبور و تایید موبایل (OTP)

در نسخه قبل، مسیرهای `reset-password` و `verify-mobile` به صورت موقت بدون بررسی کد OTP عمل می‌کردند. از این پس این مسیرها به درگاه رسمی **SMS.ir** و **کاوه‌نگار (Kavenegar)** و جدول `otp_codes` متصل شده‌اند:

### الف) درخواست کد OTP فراموشی رمز
- **Endpoint**: `POST /api/v1/auth/forgot-password`
- **Request**: `{ "mobile": "09121000001" }`
- **Response (`200 OK`)**:
  ```json
  {
    "success": true,
    "data": {
      "action": "forgot-password",
      "status": "OTP_SENT",
      "mobile": "09121000001",
      "purpose": "RESET_PASSWORD",
      "expires_in_seconds": 300,
      "provider": "SMS_IR",
      "sandbox": true
    }
  }
  ```

### ب) تغییر رمز عبور با کد OTP اجباری (فیلد جدید اجباری: `otp_code`)
- **Endpoint**: `POST /api/v1/auth/reset-password`
- **Request (به‌روزرسانی شده)**:
  ```json
  {
    "mobile": "09121000001",
    "otp_code": "123456",
    "new_password": "NewStrongPassword@1"
  }
  ```
- **نکته برای کلاینت اندروید**: فیلد `otp_code` (۶ رقمی، یک‌بارمصرف، اعتبار ۵ دقیقه، حداکثر ۵ تلاش اشتباه) **اجباری** است. پس از تغییر موفق رمز عبور، تمام `sessions` قبلی کاربر ابطال می‌شوند و کلاینت باید کاربر را به صفحه ورود هدایت کند.
- **کدهای خطای جدید**: `OTP_NOT_FOUND` (400)، `OTP_EXPIRED` (400)، `OTP_INVALID` (400)، `OTP_MAX_ATTEMPTS` (429).

### ج) ارسال و تایید کد موبایل (Verify Mobile)
- `POST /api/v1/auth/resend-verification` با `{ "mobile": "0912..." }`
- `POST /api/v1/auth/verify-mobile` با `{ "mobile": "0912...", "otp_code": "123456" }`

---

## ۲. وب‌سرویس‌های جدید عمومی (بدون نیاز به Bearer Token) قابل مصرف در اپلیکیشن اندروید

اپلیکیشن اندروید می‌تواند بخش **«آموزش‌ها / مرکز راهنما»**، **«صفحه تعرفه‌ها»**، **«تماس با پشتیبانی»** و **«پیکربندی اولیه اپ»** را مستقیماً از مسیرهای زیر دریافت کند:

1. **`GET /api/v1/public/app-config`**:
   - دریافت `api_version`، `min_android_version`، فعال بودن OTP (`otp_enabled`)، درگاه فعال پیامک (`active_sms_provider`) و آمار عمومی.
2. **`GET /api/v1/public/plans`**:
   - دریافت پلن‌های فعال اشتراک (با `cafebazaar_sku`، `price_irr`، `billing_days` و لیست کامل `features`) حتی پیش از لاگین کاربر.
3. **`GET /api/v1/public/academy?page=1&per_page=20&category=&search=`**:
   - فهرست صفحه‌بندی‌شده مقالات آموزشی منتشرشده از پنل ادمین (شامل `slug`, `title`, `excerpt`, `cover_image_url`, `category`, `tags`, `reading_minutes`, `view_count`).
4. **`GET /api/v1/public/academy/{slug}`**:
   - دریافت متن کامل آموزش با `content_html` ایمن‌شده (XSS-Sanitized) مناسب نمایش در `WebView` یا Compose HTML Renderer، به همراه لیست مقالات مرتبط (`related`).
5. **`POST /api/v1/public/contact`**:
   - ثبت پیام تماس/پشتیبانی از فرم اپلیکیشن (`full_name`, `mobile`, `email?`, `company_name?`, `subject`, `message`).

---

## ۳. بهبودهای رفتار بک‌اند (بدون Breaking Change برای اندروید)
1. **ثبت‌نام و ساخت سازمان جدید (`POST /api/v1/auth/register` و `POST /api/v1/organizations`)**:
   - به صورت خودکار ۱۴ روز اشتراک آزمایشی (`TRIAL` روی پلن `PRO`)، نقش `ORG_OWNER` و حساب‌های پیش‌فرض مالی شخصی/مالیات/سود انباشته برای سازمان جدید فعال می‌شود تا کاربر بلافاصله پس از ثبت‌نام در اندروید بتواند فاکتور و سند ثبت کند.
2. **برگشت از فروش و خرید (`POST /api/v1/sales/{id}/returns` و `POST /api/v1/purchases/{id}/returns`)**:
   - کنترل جدید: اگر `total_amount` بیشتر از مبلغ فاکتور اصلی باشد خطای `422 RETURN_EXCEEDS_INVOICE` برمی‌گرداند.
   - سند حسابداری متوازن برگشت و تراکنش دفتر طرف‌حساب (`contact_transactions`) به صورت اتمیک ثبت می‌شود.

---

## ۴. مسیرهای اختصاصی پنل مدیریت پلتفرم (فقط برای Admin Web Panel — مصرف‌نشده توسط Android)
- `GET/POST/PATCH/DELETE /api/v1/platform/academy` (مدیریت آموزش‌ها با ادیتور پیشرفته)
- `GET/PATCH/POST /api/v1/platform/sms` (تنظیمات و تست پیامک **SMS.ir** و **Kavenegar**)
- `GET/PATCH /api/v1/platform/inquiries` (مدیریت پیام‌های فرم تماس با ما)

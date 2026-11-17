# Business OS — Permission Matrix (Platform Admin vs Organization Workspace)

## Access Realms
Business OS strictly isolates two authorization realms:
1. **Platform Realm (`scope = 'PLATFORM'`)**: Accessible ONLY to users with `users.is_platform_admin = true` and a Platform Role. Cannot mutate tenant accounting vouchers directly without explicit tenant membership.
2. **Organization Realm (`scope = 'ORGANIZATION'`)**: Scoped to a verified `organization_members` record (`status = 'ACTIVE'`) and roles assigned in `user_roles` for that exact `organization_id`.

---

## 1. Platform Role Permission Matrix

| Permission Code | فارسی | Super Admin | Platform Ops | Support Agent | Billing Admin |
| --- | --- | :---: | :---: | :---: | :---: |
| `platform.dashboard.read` | مشاهده داشبورد کل سیستم | ✓ | ✓ | ✓ | ✓ |
| `platform.organizations.read` | مشاهده لیست سازمان‌ها | ✓ | ✓ | ✓ | ✓ |
| `platform.organizations.write` | ایجاد/ویرایش/تعلیق سازمان | ✓ | ✓ | ✗ | ✗ |
| `platform.users.read` | مشاهده کاربران پلتفرم | ✓ | ✓ | ✓ | ✗ |
| `platform.users.write` | مدیریت کاربران و عضویت‌ها | ✓ | ✓ | ✗ | ✗ |
| `platform.roles.manage` | مدیریت نقش‌ها و دسترسی‌ها | ✓ | ✗ | ✗ | ✗ |
| `platform.plans.manage` | مدیریت پلن‌ها و قابلیت‌ها | ✓ | ✗ | ✗ | ✓ |
| `platform.payments.read` | مشاهده پرداخت‌ها و رسیدها | ✓ | ✓ | ✓ | ✓ |
| `platform.payments.verify` | بررسی/بازتأیید رسید کافه‌بازار | ✓ | ✗ | ✗ | ✓ |
| `platform.sync.read` | مانیتور دستگاه‌ها و Sync | ✓ | ✓ | ✓ | ✗ |
| `platform.sync.resolve` | رفع تعارض Sync | ✓ | ✓ | ✗ | ✗ |
| `platform.audit.read` | مشاهده لاگ‌های ممیزی | ✓ | ✓ | ✓ | ✓ |
| `platform.errors.read` | مشاهده گزارش خطاها | ✓ | ✓ | ✓ | ✗ |
| `platform.errors.resolve` | تعیین وضعیت خطاها | ✓ | ✓ | ✗ | ✗ |
| `platform.settings.manage` | مدیریت تنظیمات عمومی | ✓ | ✗ | ✗ | ✗ |
| `platform.tickets.manage` | پشتیبانی و تیکت کاربران | ✓ | ✓ | ✓ | ✗ |

---

## 2. Organization Role Permission Matrix

| Permission Code | فارسی | Owner | Accountant | Warehouse Mgr | Salesperson | Viewer |
| --- | --- | :---: | :---: | :---: | :---: | :---: |
| `org.dashboard.read` | مشاهده داشبورد سازمان | ✓ | ✓ | ✓ | ✓ | ✓ |
| `org.settings.write` | ویرایش تنظیمات سازمان | ✓ | ✗ | ✗ | ✗ | ✗ |
| `org.members.manage` | مدیریت اعضای سازمان | ✓ | ✗ | ✗ | ✗ | ✗ |
| `contacts.read` | مشاهده اشخاص | ✓ | ✓ | ✓ | ✓ | ✓ |
| `contacts.write` | ایجاد/ویرایش اشخاص | ✓ | ✓ | ✗ | ✓ | ✗ |
| `catalog.read` | مشاهده کالاها و خدمات | ✓ | ✓ | ✓ | ✓ | ✓ |
| `catalog.write` | ایجاد/ویرایش کالاها | ✓ | ✗ | ✓ | ✗ | ✗ |
| `accounting.read` | مشاهده حساب‌ها و اسناد | ✓ | ✓ | ✗ | ✗ | ✓ |
| `accounting.write` | ثبت سند پیش‌نویس | ✓ | ✓ | ✗ | ✗ | ✗ |
| `accounting.post` | قطعی‌سازی سند حسابداری | ✓ | ✓ | ✗ | ✗ | ✗ |
| `accounting.reverse` | صدور سند معکوس/اصلاحی | ✓ | ✓ | ✗ | ✗ | ✗ |
| `accounting.period.manage` | بستن/بازکردن دوره مالی | ✓ | ✓ | ✗ | ✗ | ✗ |
| `inventory.read` | مشاهده انبار و کاردکس | ✓ | ✓ | ✓ | ✓ | ✓ |
| `inventory.write` | ثبت سند انبار و انتقال | ✓ | ✗ | ✓ | ✗ | ✗ |
| `inventory.count.approve` | تأیید انبارگردانی و تعدیل | ✓ | ✓ | ✓ | ✗ | ✗ |
| `purchasing.read` | مشاهده فاکتورهای خرید | ✓ | ✓ | ✓ | ✗ | ✓ |
| `purchasing.write` | ثبت و نهایی‌سازی خرید | ✓ | ✓ | ✓ | ✗ | ✗ |
| `sales.read` | مشاهده فاکتورهای فروش | ✓ | ✓ | ✗ | ✓ | ✓ |
| `sales.write` | ثبت و نهایی‌سازی فروش | ✓ | ✓ | ✗ | ✓ | ✗ |
| `treasury.read` | مشاهده خزانه و بانک | ✓ | ✓ | ✗ | ✗ | ✓ |
| `treasury.write` | ثبت دریافت و پرداخت | ✓ | ✓ | ✗ | ✗ | ✗ |
| `cheques.read` | مشاهده چک‌ها | ✓ | ✓ | ✗ | ✗ | ✓ |
| `cheques.write` | ثبت و تغییر وضعیت چک | ✓ | ✓ | ✗ | ✗ | ✗ |
| `consignment.read` | مشاهده کالاهای امانی | ✓ | ✓ | ✓ | ✗ | ✓ |
| `consignment.write` | ثبت و تسویه امانی | ✓ | ✓ | ✓ | ✗ | ✗ |
| `reports.read` | مشاهده گزارش‌های مالی و انبار | ✓ | ✓ | ✓ | ✓ | ✓ |
| `reports.export` | خروجی کامل داده‌ها (همیشه مجاز) | ✓ | ✓ | ✗ | ✗ | ✗ |
| `subscription.manage` | مدیریت اشتراک و کافه‌بازار | ✓ | ✗ | ✗ | ✗ | ✗ |
| `sync.execute` | همگام‌سازی آفلاین دستگاه | ✓ | ✓ | ✓ | ✓ | ✗ |

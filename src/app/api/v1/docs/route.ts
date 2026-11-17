import fs from "fs/promises";
import path from "path";
import { handleApiError, ok } from "@/lib/errors";

const CONTRACT_FILES = [
  { key: "openapi", titleFa: "OpenAPI 3.1 (YAML معتبر)", sub: "api/openapi.yaml", path: "docs/api/openapi.yaml" },
  { key: "endpoints", titleFa: "کاتالوگ کامل REST API (/api/v1)", sub: "api/endpoints.md", path: "docs/api/endpoints.md" },
  { key: "sync-api", titleFa: "قرارداد APIهای Sync", sub: "sync/sync-api-contract.md", path: "docs/sync/sync-api-contract.md" },
  { key: "sync-protocol", titleFa: "پروتکل Sync دوطرفه و WorkManager", sub: "sync/sync-protocol.md", path: "docs/sync/sync-protocol.md" },
  { key: "conflict-res", titleFa: "سیاست رفع تعارض دامنه‌محور", sub: "sync/conflict-resolution.md", path: "docs/sync/conflict-resolution.md" },
  { key: "offline-matrix", titleFa: "ماتریس قابلیت آفلاین", sub: "sync/offline-capability-matrix.md", path: "docs/sync/offline-capability-matrix.md" },
  { key: "recovery", titleFa: "استراتژی بازیابی ۱۵ سناریو", sub: "sync/recovery-strategy.md", path: "docs/sync/recovery-strategy.md" },
  { key: "sync-tests", titleFa: "سناریوهای تست Sync و چنددستگاهی", sub: "sync/sync-test-cases.md", path: "docs/sync/sync-test-cases.md" },
  { key: "db-mapping", titleFa: "نگاشت کامل Room ↔ API ↔ PostgreSQL", sub: "data/database-mapping.md", path: "docs/data/database-mapping.md" },
  { key: "local-db", titleFa: "معماری Room / SQLite اندروید", sub: "data/local-database.md", path: "docs/data/local-database.md" },
  { key: "server-db", titleFa: "معماری سرور PostgreSQL", sub: "data/server-database.md", path: "docs/data/server-database.md" },
  { key: "db-schema", titleFa: "مدل فیزیکی و Constraintها", sub: "data/database-schema.md", path: "docs/data/database-schema.md" },
  { key: "erd", titleFa: "نمودار ERD کامل", sub: "data/erd.md", path: "docs/data/erd.md" },
  { key: "examples", titleFa: "نمونه Request و Response", sub: "api/request-response-examples.md", path: "docs/api/request-response-examples.md" },
  { key: "errors", titleFa: "کدهای استاندارد خطا", sub: "api/errors.md", path: "docs/api/errors.md" },
  { key: "versioning", titleFa: "نسخه‌بندی و Change Log", sub: "api/api-versioning.md", path: "docs/api/api-versioning.md" },
  { key: "personal-ledger", titleFa: "مالی شخصی و برداشت مالک (Prompt 05)", sub: "personal-finance/personal-ledger.md", path: "docs/personal-finance/personal-ledger.md" },
  { key: "posting-rules", titleFa: "قواعد سندزنی حسابداری دوبل", sub: "accounting/journal-posting-rules.md", path: "docs/accounting/journal-posting-rules.md" },
  { key: "acceptance", titleFa: "معیار پذیرش سناریوهای A تا K", sub: "testing/acceptance-criteria.md", path: "docs/testing/acceptance-criteria.md" },
  { key: "p08-inv", titleFa: "قرارداد انبار، تسویه و تأمین‌کننده (Prompt 08)", sub: "contracts/inventory-settlement-contract.md", path: "docs/contracts/inventory-settlement-contract.md" },
  { key: "p08-offline", titleFa: "قرارداد OFFLINE_ONLY و مهاجرت ابری", sub: "contracts/offline-only-mode-contract.md", path: "docs/contracts/offline-only-mode-contract.md" },
  { key: "p08-pay", titleFa: "قرارداد ارتقا اشتراک و ۴ درگاه پرداخت", sub: "contracts/payment-flow-contract.md", path: "docs/contracts/payment-flow-contract.md" },
  { key: "p08-jalali", titleFa: "قرارداد تقویم شمسی و تاریخ استاندارد", sub: "contracts/jalali-date-contract.md", path: "docs/contracts/jalali-date-contract.md" },
  { key: "p07-report", titleFa: "گزارش نهایی توسعه Backend (Prompt 07)", sub: "development/backend-extension-report.md", path: "docs/development/backend-extension-report.md" },
  { key: "sync-manifest", titleFa: "مانیفست ۱۴ موجودیت Sync (Prompt 07)", sub: "sync/sync-entity-manifest.md", path: "docs/sync/sync-entity-manifest.md" },
  { key: "android-v1-2", titleFa: "گزارش تغییرات وب‌سرویس برای اندروید (v1.2)", sub: "api/android-changelog-v1.2.md", path: "docs/api/android-changelog-v1.2.md" },
  { key: "typography", titleFa: "تایپوگرافی آسروتراول و لایسنس (Prompt 06)", sub: "design/typography.md", path: "docs/design/typography.md" },
  { key: "glass-ui", titleFa: "سیستم طراحی Glassmorphism", sub: "design/glassmorphism-system.md", path: "docs/design/glassmorphism-system.md" },
  { key: "chart-defs", titleFa: "تعاریف ۳ نمودار روزانه داشبورد", sub: "dashboard/chart-definitions.md", path: "docs/dashboard/chart-definitions.md" },
  { key: "user-invites", titleFa: "دعوت کاربران و امنیت دسترسی", sub: "security/user-invitations.md", path: "docs/security/user-invitations.md" },
  { key: "fy-lifecycle", titleFa: "افتتاح و بستن حساب و سال مالی", sub: "accounting/fiscal-year-lifecycle.md", path: "docs/accounting/fiscal-year-lifecycle.md" },
  { key: "adrs", titleFa: "تصمیمات معماری (ADRs)", sub: "architecture/decisions.md", path: "docs/architecture/decisions.md" },
  { key: "modules", titleFa: "ماژول‌ها، حسابداری و انبار", sub: "product/modules.md", path: "docs/product/modules.md" },
  { key: "permissions", titleFa: "ماتریس دسترسی‌ها (RBAC)", sub: "product/permissions.md", path: "docs/product/permissions.md" },
];

export async function GET() {
  try {
    const docsDir = path.join(process.cwd(), "docs");
    const docs = await Promise.all(
      CONTRACT_FILES.map(async (f) => {
        const fullPath = path.join(/*turbopackIgnore: true*/ docsDir, f.sub);
        const content = await fs.readFile(fullPath, "utf8").catch(() => "");
        return { key: f.key, titleFa: f.titleFa, path: f.path, content };
      })
    );
    return ok({ docs });
  } catch (err) {
    return handleApiError(err);
  }
}

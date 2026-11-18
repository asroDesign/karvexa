import { eq } from "drizzle-orm";
import { db } from "@/db";
import {
  accountGroups,
  accountingPeriods,
  accounts,
  auditLogs,
  barcodes,
  brands,
  cashboxes,
  categories,
  chequeEvents,
  cheques,
  consignmentDocuments,
  consignmentItems,
  contactGroups,
  contacts,
  contactTransactions,
  costCenters,
  devices,
  entitlements,
  features,
  financialAccounts,
  financialTransactions,
  fiscalYears,
  journalEntries,
  journalEntryLines,
  organizationMembers,
  organizations,
  paymentTransactions,
  permissions,
  planFeatures,
  plans,
  platformSettings,
  products,
  purchaseInvoiceItems,
  purchaseInvoices,
  purchaseReceipts,
  rolePermissions,
  roles,
  salesInvoiceItems,
  salesInvoices,
  stockDocumentItems,
  stockDocuments,
  stockLedger,
  subscriptions,
  supportTickets,
  syncBatches,
  syncCheckpoints,
  syncConflicts,
  syncEvents,
  systemErrorLogs,
  units,
  userRoles,
  users,
  warehouses,
} from "@/db/schema";
import { hashPassword } from "@/lib/auth";
import { currentJalaliDate, jalaliToGregorianIso } from "@/lib/jalali";

function dayBeforeIso(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

export const PERMISSION_DEFINITIONS: Array<{
  scope: "PLATFORM" | "ORGANIZATION";
  module: string;
  code: string;
  labelFa: string;
}> = [
  // Platform permissions
  { scope: "PLATFORM", module: "dashboard", code: "platform.dashboard.read", labelFa: "مشاهده داشبورد کل سیستم" },
  { scope: "PLATFORM", module: "organizations", code: "platform.organizations.read", labelFa: "مشاهده سازمان‌ها" },
  { scope: "PLATFORM", module: "organizations", code: "platform.organizations.write", labelFa: "مدیریت و ایجاد سازمان" },
  { scope: "PLATFORM", module: "users", code: "platform.users.read", labelFa: "مشاهده کاربران پلتفرم" },
  { scope: "PLATFORM", module: "users", code: "platform.users.write", labelFa: "مدیریت کاربران و عضویت‌ها" },
  { scope: "PLATFORM", module: "roles", code: "platform.roles.manage", labelFa: "مدیریت نقش‌ها و دسترسی‌ها" },
  { scope: "PLATFORM", module: "plans", code: "platform.plans.manage", labelFa: "مدیریت پلن‌ها و قابلیت‌ها" },
  { scope: "PLATFORM", module: "payments", code: "platform.payments.read", labelFa: "مشاهده پرداخت‌ها و رسیدها" },
  { scope: "PLATFORM", module: "sync", code: "platform.sync.read", labelFa: "مانیتور دستگاه‌ها و Sync" },
  { scope: "PLATFORM", module: "sync", code: "platform.sync.resolve", labelFa: "رفع تعارض همگام‌سازی" },
  { scope: "PLATFORM", module: "audit", code: "platform.audit.read", labelFa: "مشاهده لاگ‌های ممیزی" },
  { scope: "PLATFORM", module: "errors", code: "platform.errors.read", labelFa: "مشاهده گزارش خطاها" },
  { scope: "PLATFORM", module: "errors", code: "platform.errors.resolve", labelFa: "رسیدگی به خطاهای سیستم" },
  { scope: "PLATFORM", module: "settings", code: "platform.settings.manage", labelFa: "مدیریت تنظیمات عمومی" },
  { scope: "PLATFORM", module: "support", code: "platform.tickets.manage", labelFa: "پشتیبانی و تیکت کاربران" },
  // Organization permissions
  { scope: "ORGANIZATION", module: "dashboard", code: "org.dashboard.read", labelFa: "مشاهده داشبورد سازمان" },
  { scope: "ORGANIZATION", module: "settings", code: "org.settings.write", labelFa: "تنظیمات سازمان" },
  { scope: "ORGANIZATION", module: "contacts", code: "contacts.read", labelFa: "مشاهده طرف‌حساب‌ها" },
  { scope: "ORGANIZATION", module: "contacts", code: "contacts.write", labelFa: "ثبت و ویرایش طرف‌حساب‌ها" },
  { scope: "ORGANIZATION", module: "catalog", code: "catalog.read", labelFa: "مشاهده کالا و کاتالوگ" },
  { scope: "ORGANIZATION", module: "catalog", code: "catalog.write", labelFa: "مدیریت کالا و کاتالوگ" },
  { scope: "ORGANIZATION", module: "accounting", code: "accounting.read", labelFa: "مشاهده حسابداری و اسناد" },
  { scope: "ORGANIZATION", module: "accounting", code: "accounting.write", labelFa: "ثبت سند پیش‌نویس" },
  { scope: "ORGANIZATION", module: "accounting", code: "accounting.post", labelFa: "قطعی‌سازی سند حسابداری" },
  { scope: "ORGANIZATION", module: "accounting", code: "accounting.reverse", labelFa: "صدور سند معکوس" },
  { scope: "ORGANIZATION", module: "accounting", code: "accounting.period.manage", labelFa: "بستن و بازکردن دوره مالی" },
  { scope: "ORGANIZATION", module: "inventory", code: "inventory.read", labelFa: "مشاهده انبار و کاردکس" },
  { scope: "ORGANIZATION", module: "inventory", code: "inventory.write", labelFa: "ثبت اسناد و انتقال انبار" },
  { scope: "ORGANIZATION", module: "inventory", code: "inventory.count.approve", labelFa: "تأیید انبارگردانی و تعدیل" },
  { scope: "ORGANIZATION", module: "purchasing", code: "purchasing.read", labelFa: "مشاهده فاکتورهای خرید" },
  { scope: "ORGANIZATION", module: "purchasing", code: "purchasing.write", labelFa: "ثبت و نهایی‌سازی خرید" },
  { scope: "ORGANIZATION", module: "sales", code: "sales.read", labelFa: "مشاهده فاکتورهای فروش" },
  { scope: "ORGANIZATION", module: "sales", code: "sales.write", labelFa: "ثبت و نهایی‌سازی فروش" },
  { scope: "ORGANIZATION", module: "treasury", code: "treasury.read", labelFa: "مشاهده خزانه‌داری" },
  { scope: "ORGANIZATION", module: "treasury", code: "treasury.write", labelFa: "ثبت دریافت و پرداخت" },
  { scope: "ORGANIZATION", module: "cheques", code: "cheques.read", labelFa: "مشاهده چک‌ها" },
  { scope: "ORGANIZATION", module: "cheques", code: "cheques.write", labelFa: "ثبت و تغییر وضعیت چک" },
  { scope: "ORGANIZATION", module: "consignment", code: "consignment.read", labelFa: "مشاهده کالای امانی" },
  { scope: "ORGANIZATION", module: "consignment", code: "consignment.write", labelFa: "ثبت و تسویه امانی" },
  { scope: "ORGANIZATION", module: "reports", code: "reports.read", labelFa: "مشاهده گزارش‌های مالی" },
  { scope: "ORGANIZATION", module: "reports", code: "reports.export", labelFa: "خروجی کامل داده‌ها" },
  { scope: "ORGANIZATION", module: "subscription", code: "subscription.manage", labelFa: "مدیریت اشتراک و پرداخت" },
  { scope: "ORGANIZATION", module: "sync", code: "sync.execute", labelFa: "همگام‌سازی آفلاین اندروید" },
];

export async function bootstrapOrganizationDefaults(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  organizationId: string
) {
  // 1. Account Groups
  const [gAsset, gLiab, gEquity, gRev, gExp] = await tx
    .insert(accountGroups)
    .values([
      { organizationId, code: "1", name: "دارایی‌ها", nature: "ASSET" },
      { organizationId, code: "2", name: "بدهی‌ها", nature: "LIABILITY" },
      { organizationId, code: "3", name: "حقوق صاحبان سهام", nature: "EQUITY" },
      { organizationId, code: "4", name: "درآمدها", nature: "REVENUE" },
      { organizationId, code: "5", name: "بهای تمام‌شده و هزینه‌ها", nature: "EXPENSE" },
    ])
    .returning();

  // 2. Standard Iranian Chart of Accounts
  const createdAccounts = await tx
    .insert(accounts)
    .values([
      { organizationId, groupId: gAsset.id, code: "1101", name: "صندوق ریالی مرکزی", accountType: "ASSET", normalBalance: "DEBIT", systemRole: "CASH" },
      { organizationId, groupId: gAsset.id, code: "1102", name: "موجودی نزد بانک‌ها", accountType: "ASSET", normalBalance: "DEBIT", systemRole: "BANK" },
      { organizationId, groupId: gAsset.id, code: "1201", name: "حساب‌های دریافتنی تجاری", accountType: "ASSET", normalBalance: "DEBIT", systemRole: "AR" },
      { organizationId, groupId: gAsset.id, code: "1301", name: "موجودی کالای انبار", accountType: "ASSET", normalBalance: "DEBIT", systemRole: "INVENTORY" },
      { organizationId, groupId: gLiab.id, code: "2101", name: "حساب‌های پرداختنی تجاری", accountType: "LIABILITY", normalBalance: "CREDIT", systemRole: "AP" },
      { organizationId, groupId: gLiab.id, code: "2201", name: "اسناد پرداختنی (چک‌ها)", accountType: "LIABILITY", normalBalance: "CREDIT", systemRole: "PAYABLE_CHEQUE" },
      { organizationId, groupId: gEquity.id, code: "3101", name: "سرمایه ثبت‌شده", accountType: "EQUITY", normalBalance: "CREDIT", systemRole: "CAPITAL" },
      { organizationId, groupId: gRev.id, code: "4101", name: "درآمد فروش کالا", accountType: "REVENUE", normalBalance: "CREDIT", systemRole: "SALES_REVENUE" },
      { organizationId, groupId: gExp.id, code: "5101", name: "بهای تمام‌شده کالای فروش‌رفته", accountType: "EXPENSE", normalBalance: "DEBIT", systemRole: "COGS" },
      { organizationId, groupId: gExp.id, code: "5201", name: "هزینه‌های اداری و عمومی", accountType: "EXPENSE", normalBalance: "DEBIT", systemRole: "OPEX" },
    ])
    .returning();

  // 3. Current Jalali fiscal year + 4 open quarterly periods
  const fiscalYear = Number(currentJalaliDate().split("/")[0]);
  const fiscalYearStart = jalaliToGregorianIso(`${fiscalYear}/01/01`);
  const fiscalYearEnd = dayBeforeIso(jalaliToGregorianIso(`${fiscalYear + 1}/01/01`));
  const quarterNames = ["بهار", "تابستان", "پاییز", "زمستان"];
  const periods = [1, 4, 7, 10].map((startMonth, index) => {
    const nextStart = index === 3
      ? jalaliToGregorianIso(`${fiscalYear + 1}/01/01`)
      : jalaliToGregorianIso(`${fiscalYear}/${startMonth + 3}/01`);
    return {
      organizationId,
      name: `فصل ${quarterNames[index]} ${fiscalYear}`,
      periodNumber: index + 1,
      startDate: jalaliToGregorianIso(`${fiscalYear}/${startMonth}/01`),
      endDate: dayBeforeIso(nextStart),
      status: "OPEN" as const,
    };
  });

  const [fy] = await tx
    .insert(fiscalYears)
    .values({
      organizationId,
      name: `سال مالی ${fiscalYear}`,
      startDate: fiscalYearStart,
      endDate: fiscalYearEnd,
      status: "OPEN",
      isDefault: true,
    })
    .returning();

  const createdPeriods = await tx
    .insert(accountingPeriods)
    .values(periods.map((period) => ({ ...period, fiscalYearId: fy.id })))
    .returning();

  // 4. Default Cost Center, Unit, Warehouse
  const [cc] = await tx
    .insert(costCenters)
    .values([
      { organizationId, code: "CC-01", name: "دفتر مرکزی و عملیات" },
      { organizationId, code: "CC-02", name: "واحد فروش و پخش" },
    ])
    .returning();

  const [unitPcs] = await tx
    .insert(units)
    .values([
      { organizationId, name: "عدد", symbol: "عدد" },
      { organizationId, name: "کارتن", symbol: "کارتن" },
      { organizationId, name: "کیلوگرم", symbol: "kg" },
    ])
    .returning();

  const [whMain] = await tx
    .insert(warehouses)
    .values([
      { organizationId, code: "WH-MAIN", name: "انبار مرکزی تهران", address: "تهران، بزرگراه فتح، مجتمع انبارهای پارس", isDefault: true },
    ])
    .returning();

  return {
    accounts: createdAccounts,
    fiscalYear: fy,
    periods: createdPeriods,
    costCenter: cc,
    defaultUnit: unitPcs,
    defaultWarehouse: whMain,
  };
}

let seedPromise: Promise<void> | null = null;

export async function ensureSeeded() {
  if (!seedPromise) {
    seedPromise = runSeed().catch((err) => {
      seedPromise = null;
      throw err;
    });
  }
  return seedPromise;
}

import { ensurePrompt05Seeded } from "./seed-prompt05";
import { ensureSaasSeeded } from "./seed-saas";

async function runSeed() {
  const existingUsers = await db.select({ id: users.id }).from(users).limit(1);
  if (existingUsers.length > 0) {
    await ensurePrompt05Seeded();
    await ensureSaasSeeded();
    return;
  }

  console.log("[SEED] Bootstrapping Business OS initial multi-tenant database...");

  await db.transaction(async (tx) => {
    // 1. Permissions
    const insertedPerms = await tx
      .insert(permissions)
      .values(PERMISSION_DEFINITIONS)
      .returning();
    const permByCode = new Map(insertedPerms.map((p) => [p.code, p]));

    // 2. Roles (Platform & Organization templates)
    const [
      roleSuperAdmin,
      rolePlatformOps,
      roleOrgOwner,
      roleOrgAccountant,
      roleOrgWarehouse,
      roleOrgSales,
    ] = await tx
      .insert(roles)
      .values([
        { scope: "PLATFORM", code: "SUPER_ADMIN", name: "مدیر ارشد پلتفرم", description: "دسترسی کامل به کل پلتفرم", isSystem: true },
        { scope: "PLATFORM", code: "PLATFORM_OPS", name: "عملیات و پشتیبانی پلتفرم", description: "مدیریت تیکت، خطاها و پایش Sync", isSystem: true },
        { scope: "ORGANIZATION", code: "ORG_OWNER", name: "مالک کسب‌وکار", description: "دسترسی کامل به تمام ماژول‌های سازمان", isSystem: true },
        { scope: "ORGANIZATION", code: "ACCOUNTANT", name: "حسابدار ارشد", description: "حسابداری دوبل، گزارش‌های مالی، خزانه و چک", isSystem: true },
        { scope: "ORGANIZATION", code: "WAREHOUSE_MGR", name: "مدیر انبار", description: "انبارداری، انتقال، انبارگردانی و کاتالوگ", isSystem: true },
        { scope: "ORGANIZATION", code: "SALESPERSON", name: "کارشناس فروش", description: "صدور فاکتور فروش، اشخاص و همگام‌سازی", isSystem: true },
      ])
      .returning();

    const grant = async (roleId: string, codes: string[]) => {
      const vals = codes
        .map((c) => permByCode.get(c))
        .filter((p): p is NonNullable<typeof p> => Boolean(p))
        .map((p) => ({ roleId, permissionId: p.id }));
      if (vals.length > 0) {
        await tx.insert(rolePermissions).values(vals).onConflictDoNothing();
      }
    };

    const allPlatformCodes = PERMISSION_DEFINITIONS.filter((p) => p.scope === "PLATFORM").map((p) => p.code);
    const allOrgCodes = PERMISSION_DEFINITIONS.filter((p) => p.scope === "ORGANIZATION").map((p) => p.code);

    await grant(roleSuperAdmin.id, allPlatformCodes);
    await grant(rolePlatformOps.id, [
      "platform.dashboard.read",
      "platform.organizations.read",
      "platform.sync.read",
      "platform.audit.read",
      "platform.errors.read",
      "platform.errors.resolve",
      "platform.tickets.manage",
    ]);
    await grant(roleOrgOwner.id, allOrgCodes);
    await grant(roleOrgAccountant.id, [
      "org.dashboard.read",
      "contacts.read",
      "contacts.write",
      "catalog.read",
      "accounting.read",
      "accounting.write",
      "accounting.post",
      "accounting.reverse",
      "accounting.period.manage",
      "inventory.read",
      "purchasing.read",
      "purchasing.write",
      "sales.read",
      "sales.write",
      "treasury.read",
      "treasury.write",
      "cheques.read",
      "cheques.write",
      "consignment.read",
      "reports.read",
      "reports.export",
      "sync.execute",
    ]);
    await grant(roleOrgWarehouse.id, [
      "org.dashboard.read",
      "contacts.read",
      "catalog.read",
      "catalog.write",
      "inventory.read",
      "inventory.write",
      "inventory.count.approve",
      "purchasing.read",
      "consignment.read",
      "consignment.write",
      "reports.read",
      "sync.execute",
    ]);
    await grant(roleOrgSales.id, [
      "org.dashboard.read",
      "contacts.read",
      "contacts.write",
      "catalog.read",
      "inventory.read",
      "sales.read",
      "sales.write",
      "reports.read",
      "sync.execute",
    ]);

    // 3. Subscription Plans & Features
    const [planFree, planPro, planEnterprise] = await tx
      .insert(plans)
      .values([
        {
          code: "FREE",
          nameFa: "پلن رایگان پایه",
          description: "مناسب شروع کار کسب‌وکارهای کوچک (۱ انبار و ۱ دستگاه اندروید)",
          cafebazaarSku: "bos_free_tier",
          priceIrr: "0.00",
          billingDays: 365,
        },
        {
          code: "PRO",
          nameFa: "پلن حرفه‌ای کسب‌وکار",
          description: "حسابداری کامل، چند انبار، مدیریت چک و امانی، تا ۵ دستگاه آفلاین اندروید",
          cafebazaarSku: "bos_pro_monthly",
          priceIrr: "12500000.00",
          billingDays: 30,
        },
        {
          code: "ENTERPRISE",
          nameFa: "پلن سازمانی پیشرفته",
          description: "نامحدود برای شرکت‌های پخش و بازرگانی با گزارش‌های تحلیلی و پشتیبانی VIP",
          cafebazaarSku: "bos_enterprise_yearly",
          priceIrr: "110000000.00",
          billingDays: 365,
        },
      ])
      .returning();

    const insertedFeatures = await tx
      .insert(features)
      .values([
        { code: "multi_warehouse", nameFa: "مدیریت چند انبار و انتقال اتمیک", valueType: "BOOLEAN" },
        { code: "cheques_module", nameFa: "ماژول مدیریت چک و صیاد", valueType: "BOOLEAN" },
        { code: "consignment_module", nameFa: "ماژول کالای امانی و تسویه", valueType: "BOOLEAN" },
        { code: "offline_sync_devices", nameFa: "تعداد دستگاه همگام‌سازی اندروید", valueType: "LIMIT" },
        { code: "advanced_reports", nameFa: "گزارش‌های تحلیلی تراز و سود و زیان", valueType: "BOOLEAN" },
        { code: "multi_user", nameFa: "کاربران هم‌زمان سازمانی", valueType: "LIMIT" },
      ])
      .returning();
    const featByCode = new Map(insertedFeatures.map((f) => [f.code, f]));

    await tx.insert(planFeatures).values([
      // Free
      { planId: planFree.id, featureId: featByCode.get("multi_warehouse")!.id, enabled: false, limitValue: 1 },
      { planId: planFree.id, featureId: featByCode.get("cheques_module")!.id, enabled: false },
      { planId: planFree.id, featureId: featByCode.get("consignment_module")!.id, enabled: false },
      { planId: planFree.id, featureId: featByCode.get("offline_sync_devices")!.id, enabled: true, limitValue: 1 },
      { planId: planFree.id, featureId: featByCode.get("advanced_reports")!.id, enabled: false },
      { planId: planFree.id, featureId: featByCode.get("multi_user")!.id, enabled: true, limitValue: 1 },
      // Pro
      { planId: planPro.id, featureId: featByCode.get("multi_warehouse")!.id, enabled: true, limitValue: 5 },
      { planId: planPro.id, featureId: featByCode.get("cheques_module")!.id, enabled: true },
      { planId: planPro.id, featureId: featByCode.get("consignment_module")!.id, enabled: true },
      { planId: planPro.id, featureId: featByCode.get("offline_sync_devices")!.id, enabled: true, limitValue: 5 },
      { planId: planPro.id, featureId: featByCode.get("advanced_reports")!.id, enabled: true },
      { planId: planPro.id, featureId: featByCode.get("multi_user")!.id, enabled: true, limitValue: 10 },
      // Enterprise
      { planId: planEnterprise.id, featureId: featByCode.get("multi_warehouse")!.id, enabled: true, limitValue: 50 },
      { planId: planEnterprise.id, featureId: featByCode.get("cheques_module")!.id, enabled: true },
      { planId: planEnterprise.id, featureId: featByCode.get("consignment_module")!.id, enabled: true },
      { planId: planEnterprise.id, featureId: featByCode.get("offline_sync_devices")!.id, enabled: true, limitValue: 50 },
      { planId: planEnterprise.id, featureId: featByCode.get("advanced_reports")!.id, enabled: true },
      { planId: planEnterprise.id, featureId: featByCode.get("multi_user")!.id, enabled: true, limitValue: 100 },
    ]);

    // Demo tenants and sample business records are opt-in only. System roles,
    // permissions, and subscription plans above are always provisioned, while
    // every normal environment starts with no fabricated organizations or books.
    if (process.env.NODE_ENV === "production" || process.env.SEED_DEMO_DATA !== "true") return;

    // 4. Organizations (2 strictly isolated tenants)
    const [orgPars, orgSepehr] = await tx
      .insert(organizations)
      .values([
        {
          name: "گروه بازرگانی پارس‌تک",
          legalName: "شرکت بازرگانی و پخش پارس‌تک نوین (سهامی خاص)",
          businessType: "DISTRIBUTION",
          economicCode: "411598745612",
          nationalId: "14009876543",
          phone: "021-88776655",
          email: "finance@parstech.ir",
          address: "تهران، خیابان بهشتی، پلاک ۱۴۲، طبقه ۴",
          fiscalYearStart: "01-01",
          baseCurrency: "IRR",
          timezone: "Asia/Tehran",
          costingMethod: "WEIGHTED_AVERAGE",
          negativeStockPolicy: "BLOCK",
          status: "ACTIVE",
        },
        {
          name: "فروشگاه زنجیره‌ای سپهر",
          legalName: "مجموعه فروشگاهی سپهر گستر البرز",
          businessType: "RETAIL",
          economicCode: "411223344556",
          nationalId: "14001122334",
          phone: "026-34455667",
          email: "info@sepehrstore.ir",
          address: "کرج، عظیمیه، بلوار شریعتی، مجتمع سپهر",
          fiscalYearStart: "01-01",
          baseCurrency: "IRR",
          timezone: "Asia/Tehran",
          costingMethod: "FIFO",
          negativeStockPolicy: "BLOCK",
          status: "ACTIVE",
        },
      ])
      .returning();

    // 5. Users
    const [adminHash, accHash, whHash, sepehrHash] = await Promise.all([
      hashPassword("Admin@1234"),
      hashPassword("Account@1234"),
      hashPassword("Stock@1234"),
      hashPassword("Sepehr@1234"),
    ]);

    const [userAdmin, userAccountant, userWarehouse, userSepehr] = await tx
      .insert(users)
      .values([
        {
          email: "admin@businessos.ir",
          phone: "09121000001",
          fullName: "امیرحسین رضایی (مدیر ارشد پلتفرم)",
          passwordHash: adminHash,
          isPlatformAdmin: true,
          status: "ACTIVE",
        },
        {
          email: "accountant@parstech.ir",
          phone: "09122000002",
          fullName: "مریم کریمی (حسابدار ارشد پارس‌تک)",
          passwordHash: accHash,
          isPlatformAdmin: false,
          status: "ACTIVE",
        },
        {
          email: "warehouse@parstech.ir",
          phone: "09123000003",
          fullName: "سعید محمدی (مدیر انبار پارس‌تک)",
          passwordHash: whHash,
          isPlatformAdmin: false,
          status: "ACTIVE",
        },
        {
          email: "owner@sepehr.ir",
          phone: "09124000004",
          fullName: "رضا ناصری (مالک فروشگاه سپهر)",
          passwordHash: sepehrHash,
          isPlatformAdmin: false,
          status: "ACTIVE",
        },
      ])
      .returning();

    // Memberships & Role Assignments
    await tx.insert(organizationMembers).values([
      { organizationId: orgPars.id, userId: userAdmin.id, isOwner: true, status: "ACTIVE" },
      { organizationId: orgPars.id, userId: userAccountant.id, isOwner: false, status: "ACTIVE" },
      { organizationId: orgPars.id, userId: userWarehouse.id, isOwner: false, status: "ACTIVE" },
      { organizationId: orgSepehr.id, userId: userSepehr.id, isOwner: true, status: "ACTIVE" },
    ]);

    await tx.insert(userRoles).values([
      { userId: userAdmin.id, roleId: roleSuperAdmin.id, organizationId: null },
      { userId: userAdmin.id, roleId: roleOrgOwner.id, organizationId: orgPars.id },
      { userId: userAccountant.id, roleId: roleOrgAccountant.id, organizationId: orgPars.id },
      { userId: userWarehouse.id, roleId: roleOrgWarehouse.id, organizationId: orgPars.id },
      { userId: userSepehr.id, roleId: roleOrgOwner.id, organizationId: orgSepehr.id },
    ]);

    // 6. Subscriptions & Payments
    const now = new Date();
    const in25Days = new Date(now.getTime() + 25 * 86400 * 1000);
    const fiveDaysAgo = new Date(now.getTime() - 5 * 86400 * 1000);
    const thirtyFiveDaysAgo = new Date(now.getTime() - 35 * 86400 * 1000);

    const [subPars] = await tx
      .insert(subscriptions)
      .values([
        {
          organizationId: orgPars.id,
          planId: planPro.id,
          status: "ACTIVE",
          startsAt: fiveDaysAgo,
          expiresAt: in25Days,
          autoRenew: true,
          source: "CAFEBAZAAR",
        },
        {
          organizationId: orgSepehr.id,
          planId: planPro.id,
          status: "EXPIRED",
          startsAt: thirtyFiveDaysAgo,
          expiresAt: fiveDaysAgo,
          autoRenew: false,
          source: "CAFEBAZAAR",
        },
      ])
      .returning();

    const [payPars] = await tx
      .insert(paymentTransactions)
      .values({
        organizationId: orgPars.id,
        subscriptionId: subPars.id,
        planId: planPro.id,
        provider: "CAFEBAZAAR",
        amountIrr: planPro.priceIrr,
        currency: "IRR",
        status: "VERIFIED",
        idempotencyKey: "seed-cbz-parstech-001",
        externalRef: "CBZ-8841209",
        paidAt: fiveDaysAgo,
      })
      .returning();

    await tx.insert(purchaseReceipts).values({
      organizationId: orgPars.id,
      paymentTransactionId: payPars.id,
      provider: "CAFEBAZAAR",
      packageName: "ir.businessos.app",
      sku: "bos_pro_monthly",
      purchaseToken: "CBZ-VALID-SEED998877",
      verificationStatus: "VALID",
      rawResponse: { purchaseState: 0, consumptionState: 0, seeded: true },
    });

    await tx.insert(entitlements).values([
      { organizationId: orgPars.id, featureCode: "multi_warehouse", enabled: true, limitValue: 5, source: "PLAN" },
      { organizationId: orgPars.id, featureCode: "cheques_module", enabled: true, source: "PLAN" },
      { organizationId: orgPars.id, featureCode: "consignment_module", enabled: true, source: "PLAN" },
      { organizationId: orgPars.id, featureCode: "offline_sync_devices", enabled: true, limitValue: 5, source: "PLAN" },
      { organizationId: orgPars.id, featureCode: "advanced_reports", enabled: true, source: "PLAN" },
    ]);

    // 7. Bootstrap Accounting & Inventory Defaults for BOTH Orgs
    const parsBoot = await bootstrapOrganizationDefaults(tx, orgPars.id);
    const sepehrBoot = await bootstrapOrganizationDefaults(tx, orgSepehr.id);

    // Add second warehouse for ParsTech (for Atomic Transfers!)
    const [whWest] = await tx
      .insert(warehouses)
      .values({
        organizationId: orgPars.id,
        code: "WH-WEST",
        name: "انبار پخش غرب تهران",
        address: "تهران، کیلومتر ۱۲ جاده مخصوص کرج",
        isDefault: false,
      })
      .returning();

    // 8. Contacts for ParsTech & Sepehr
    const [grpCust, grpVend] = await tx
      .insert(contactGroups)
      .values([
        { organizationId: orgPars.id, name: "مشتریان عمده تهران" },
        { organizationId: orgPars.id, name: "تأمین‌کنندگان رسمی" },
      ])
      .returning();

    const [cAfra, cDena, cKianVendor, cSinaConsignor] = await tx
      .insert(contacts)
      .values([
        {
          organizationId: orgPars.id,
          groupId: grpCust.id,
          code: "C-1001",
          name: "فروشگاه دیجیتال افرا",
          contactType: "CUSTOMER",
          mobile: "09121112233",
          nationalCode: "14005556677",
          creditLimit: "250000000.00",
          version: 2,
          syncSeq: 1001,
        },
        {
          organizationId: orgPars.id,
          groupId: grpCust.id,
          code: "C-1002",
          name: "پخش تجهیزات اداری دنا",
          contactType: "CUSTOMER",
          mobile: "09123334455",
          nationalCode: "14008889900",
          creditLimit: "500000000.00",
          version: 1,
          syncSeq: 1002,
        },
        {
          organizationId: orgPars.id,
          groupId: grpVend.id,
          code: "V-2001",
          name: "شرکت واردات و تأمین کیان‌الکترونیک",
          contactType: "VENDOR",
          mobile: "09125556677",
          economicCode: "411777888999",
          creditLimit: "1000000000.00",
          version: 1,
          syncSeq: 1003,
        },
        {
          organizationId: orgPars.id,
          groupId: grpVend.id,
          code: "V-2002",
          name: "تولیدی لوازم جانبی سینا (امانی)",
          contactType: "BOTH",
          mobile: "09127778899",
          creditLimit: "300000000.00",
          version: 1,
          syncSeq: 1004,
        },
      ])
      .returning();

    // Contact for Org 2 (Sepehr) for cross-tenant isolation testing
    await tx.insert(contacts).values({
      organizationId: orgSepehr.id,
      code: "SEP-01",
      name: "مشتری محرمانه فروشگاه سپهر",
      contactType: "CUSTOMER",
      mobile: "09190001122",
      creditLimit: "90000000.00",
    });

    // 9. Catalog (Categories, Brands, Products, Barcodes) for ParsTech
    const [catPos, catAcc] = await tx
      .insert(categories)
      .values([
        { organizationId: orgPars.id, name: "تجهیزات فروشگاهی و بارکد", code: "CAT-POS" },
        { organizationId: orgPars.id, name: "لوازم جانبی شبکه و کامپیوتر", code: "CAT-ACC" },
      ])
      .returning();

    const [brandBix, brandHoney] = await tx
      .insert(brands)
      .values([
        { organizationId: orgPars.id, name: "Bixolon" },
        { organizationId: orgPars.id, name: "Honeywell" },
      ])
      .returning();

    const [pPrinter, pScanner, pPaper, pSwitch] = await tx
      .insert(products)
      .values([
        {
          organizationId: orgPars.id,
          categoryId: catPos.id,
          brandId: brandBix.id,
          baseUnitId: parsBoot.defaultUnit.id,
          sku: "POS-PRT-350",
          name: "فیش‌پرینتر حرارتی Bixolon SRP-350",
          productType: "GOODS",
          costingMethod: "WEIGHTED_AVERAGE",
          defaultPurchasePrice: "42000000.00",
          defaultSalePrice: "54000000.00",
          minStockLevel: "5.0000",
          version: 2,
          syncSeq: 1005,
        },
        {
          organizationId: orgPars.id,
          categoryId: catPos.id,
          brandId: brandHoney.id,
          baseUnitId: parsBoot.defaultUnit.id,
          sku: "POS-SCN-1470",
          name: "بارکدخوان دوبعدی Honeywell Voyager 1470g",
          productType: "GOODS",
          costingMethod: "WEIGHTED_AVERAGE",
          defaultPurchasePrice: "28500000.00",
          defaultSalePrice: "36000000.00",
          minStockLevel: "8.0000",
          version: 1,
          syncSeq: 1006,
        },
        {
          organizationId: orgPars.id,
          categoryId: catPos.id,
          brandId: brandBix.id,
          baseUnitId: parsBoot.defaultUnit.id,
          sku: "CON-ROLL-80",
          name: "رول کاغذ حرارتی ۸ سانتی بسته ۱۰ عددی",
          productType: "GOODS",
          costingMethod: "FIFO",
          defaultPurchasePrice: "1800000.00",
          defaultSalePrice: "2450000.00",
          minStockLevel: "20.0000",
          version: 1,
          syncSeq: 1007,
        },
        {
          organizationId: orgPars.id,
          categoryId: catAcc.id,
          brandId: brandHoney.id,
          baseUnitId: parsBoot.defaultUnit.id,
          sku: "NET-SWT-24",
          name: "سوئیچ شبکه ۲۴ پورت گیگابیت صنعتی",
          productType: "CONSIGNMENT",
          costingMethod: "WEIGHTED_AVERAGE",
          defaultPurchasePrice: "65000000.00",
          defaultSalePrice: "79000000.00",
          minStockLevel: "3.0000",
          version: 1,
          syncSeq: 1008,
        },
      ])
      .returning();

    await tx.insert(barcodes).values([
      { organizationId: orgPars.id, productId: pPrinter.id, barcode: "6261002003501", isPrimary: true },
      { organizationId: orgPars.id, productId: pScanner.id, barcode: "6261002001470", isPrimary: true },
      { organizationId: orgPars.id, productId: pPaper.id, barcode: "6261002000809", isPrimary: true },
    ]);

    // Product for Org 2 (Sepehr)
    await tx.insert(products).values({
      organizationId: orgSepehr.id,
      baseUnitId: sepehrBoot.defaultUnit.id,
      sku: "SEP-ITEM-01",
      name: "کالای اختصاصی فروشگاه سپهر",
      defaultPurchasePrice: "1000000.00",
      defaultSalePrice: "1450000.00",
    });

    // 10. Opening Stock Documents & Stock Ledger (Source of Truth)
    const [sdOpenMain] = await tx
      .insert(stockDocuments)
      .values({
        organizationId: orgPars.id,
        warehouseId: parsBoot.defaultWarehouse.id,
        documentNumber: "SD-1404-0001",
        documentType: "OPENING",
        documentDate: "2025-07-01",
        reason: "موجودی اول دوره انبار مرکزی",
        status: "POSTED",
        createdBy: userWarehouse.id,
      })
      .returning();

    await tx.insert(stockDocumentItems).values([
      { organizationId: orgPars.id, stockDocumentId: sdOpenMain.id, productId: pPrinter.id, quantity: "25.0000", unitCost: "42000000.0000", totalCost: "1050000000.00" },
      { organizationId: orgPars.id, stockDocumentId: sdOpenMain.id, productId: pScanner.id, quantity: "40.0000", unitCost: "28500000.0000", totalCost: "1140000000.00" },
      { organizationId: orgPars.id, stockDocumentId: sdOpenMain.id, productId: pPaper.id, quantity: "120.0000", unitCost: "1800000.0000", totalCost: "216000000.00" },
    ]);

    await tx.insert(stockLedger).values([
      {
        organizationId: orgPars.id,
        stockDocumentId: sdOpenMain.id,
        warehouseId: parsBoot.defaultWarehouse.id,
        productId: pPrinter.id,
        movementType: "IN",
        reason: "موجودی اول دوره انبار مرکزی",
        quantityDelta: "25.0000",
        unitCost: "42000000.0000",
        valueDelta: "1050000000.00",
        balanceAfterQty: "25.0000",
        balanceAfterValue: "1050000000.00",
        movementDate: "2025-07-01",
      },
      {
        organizationId: orgPars.id,
        stockDocumentId: sdOpenMain.id,
        warehouseId: parsBoot.defaultWarehouse.id,
        productId: pScanner.id,
        movementType: "IN",
        reason: "موجودی اول دوره انبار مرکزی",
        quantityDelta: "40.0000",
        unitCost: "28500000.0000",
        valueDelta: "1140000000.00",
        balanceAfterQty: "40.0000",
        balanceAfterValue: "1140000000.00",
        movementDate: "2025-07-01",
      },
      {
        organizationId: orgPars.id,
        stockDocumentId: sdOpenMain.id,
        warehouseId: parsBoot.defaultWarehouse.id,
        productId: pPaper.id,
        movementType: "IN",
        reason: "موجودی اول دوره انبار مرکزی",
        quantityDelta: "120.0000",
        unitCost: "1800000.0000",
        valueDelta: "216000000.00",
        balanceAfterQty: "120.0000",
        balanceAfterValue: "216000000.00",
        movementDate: "2025-07-01",
      },
    ]);

    const [sdOpenWest] = await tx
      .insert(stockDocuments)
      .values({
        organizationId: orgPars.id,
        warehouseId: whWest.id,
        documentNumber: "SD-1404-0002",
        documentType: "OPENING",
        documentDate: "2025-07-02",
        reason: "موجودی اولیه انبار شعبه غرب",
        status: "POSTED",
        createdBy: userWarehouse.id,
      })
      .returning();

    await tx.insert(stockLedger).values([
      {
        organizationId: orgPars.id,
        stockDocumentId: sdOpenWest.id,
        warehouseId: whWest.id,
        productId: pPrinter.id,
        movementType: "IN",
        reason: "موجودی اولیه انبار شعبه غرب",
        quantityDelta: "6.0000",
        unitCost: "42000000.0000",
        valueDelta: "252000000.00",
        balanceAfterQty: "6.0000",
        balanceAfterValue: "252000000.00",
        movementDate: "2025-07-02",
      },
    ]);

    // 11. Balanced Double-Entry Accounting Journal Entries for ParsTech
    const accMap = new Map(parsBoot.accounts.map((a) => [a.systemRole!, a]));
    const openPeriod = parsBoot.periods[1]; // تابستان ۱۴۰۴ (OPEN)

    const [je1] = await tx
      .insert(journalEntries)
      .values({
        organizationId: orgPars.id,
        fiscalYearId: parsBoot.fiscalYear.id,
        accountingPeriodId: openPeriod.id,
        entryNumber: 1,
        entryDate: "2025-07-01",
        description: "سند افتتاحیه سرمایه، موجودی بانک، صندوق و موجودی کالا سال ۱۴۰۴",
        referenceType: "OPENING",
        status: "POSTED",
        totalDebit: "4858000000.00",
        totalCredit: "4858000000.00",
        createdBy: userAccountant.id,
        postedBy: userAccountant.id,
        postedAt: now,
        syncSeq: 1010,
      })
      .returning();

    await tx.insert(journalEntryLines).values([
      { organizationId: orgPars.id, journalEntryId: je1.id, accountId: accMap.get("BANK")!.id, lineOrder: 1, description: "مانده افتتاحیه حساب بانکی ملت", debit: "1950000000.00", credit: "0.00" },
      { organizationId: orgPars.id, journalEntryId: je1.id, accountId: accMap.get("CASH")!.id, lineOrder: 2, description: "مانده افتتاحیه صندوق مرکزی", debit: "250000000.00", credit: "0.00" },
      { organizationId: orgPars.id, journalEntryId: je1.id, accountId: accMap.get("INVENTORY")!.id, lineOrder: 3, description: "ارزش موجودی کالا در دو انبار", debit: "2658000000.00", credit: "0.00" },
      { organizationId: orgPars.id, journalEntryId: je1.id, accountId: accMap.get("CAPITAL")!.id, lineOrder: 4, description: "سرمایه ثبت‌شده شرکت پارس‌تک", debit: "0.00", credit: "4858000000.00" },
    ]);

    const [je2] = await tx
      .insert(journalEntries)
      .values({
        organizationId: orgPars.id,
        fiscalYearId: parsBoot.fiscalYear.id,
        accountingPeriodId: openPeriod.id,
        entryNumber: 2,
        entryDate: "2025-07-15",
        description: "ثبت درآمد فروش عمده به فروشگاه دیجیتال افرا و بهای تمام‌شده",
        referenceType: "SALES_INVOICE",
        status: "POSTED",
        totalDebit: "566000000.00",
        totalCredit: "566000000.00",
        createdBy: userAccountant.id,
        postedBy: userAccountant.id,
        postedAt: now,
        syncSeq: 1011,
      })
      .returning();

    await tx.insert(journalEntryLines).values([
      { organizationId: orgPars.id, journalEntryId: je2.id, accountId: accMap.get("AR")!.id, contactId: cAfra.id, lineOrder: 1, description: "بدهکار فروشگاه افرا بابت فاکتور SI-1404-101", debit: "342000000.00", credit: "0.00" },
      { organizationId: orgPars.id, journalEntryId: je2.id, accountId: accMap.get("SALES_REVENUE")!.id, lineOrder: 2, description: "فروش ۵ عدد فیش‌پرینتر و ۲ عدد بارکدخوان", debit: "0.00", credit: "342000000.00" },
      { organizationId: orgPars.id, journalEntryId: je2.id, accountId: accMap.get("COGS")!.id, lineOrder: 3, description: "بهای تمام‌شده کالای فروش‌رفته", debit: "224000000.00", credit: "0.00" },
      { organizationId: orgPars.id, journalEntryId: je2.id, accountId: accMap.get("INVENTORY")!.id, lineOrder: 4, description: "کاهش موجودی انبار بابت فروش", debit: "0.00", credit: "224000000.00" },
    ]);

    const [je3Draft] = await tx
      .insert(journalEntries)
      .values({
        organizationId: orgPars.id,
        fiscalYearId: parsBoot.fiscalYear.id,
        accountingPeriodId: openPeriod.id,
        entryNumber: 3,
        entryDate: "2025-07-22",
        description: "پیش‌نویس هزینه اجاره دفتر مرکزی مرداد ۱۴۰۴",
        referenceType: "MANUAL",
        status: "DRAFT",
        totalDebit: "85000000.00",
        totalCredit: "85000000.00",
        createdBy: userAccountant.id,
        syncSeq: 1012,
      })
      .returning();

    await tx.insert(journalEntryLines).values([
      { organizationId: orgPars.id, journalEntryId: je3Draft.id, accountId: accMap.get("OPEX")!.id, costCenterId: parsBoot.costCenter.id, lineOrder: 1, description: "هزینه اجاره دفتر مرکزی", debit: "85000000.00", credit: "0.00" },
      { organizationId: orgPars.id, journalEntryId: je3Draft.id, accountId: accMap.get("BANK")!.id, lineOrder: 2, description: "پرداخت از حساب بانک ملت", debit: "0.00", credit: "85000000.00" },
    ]);

    // 12. Sales & Purchase Invoices
    const [si1] = await tx
      .insert(salesInvoices)
      .values({
        organizationId: orgPars.id,
        contactId: cAfra.id,
        warehouseId: parsBoot.defaultWarehouse.id,
        invoiceNumber: "SI-1404-101",
        invoiceDate: "2025-07-15",
        subtotal: "342000000.00",
        totalAmount: "342000000.00",
        status: "FINALIZED",
        journalEntryId: je2.id,
        createdBy: userAccountant.id,
      })
      .returning();

    await tx.insert(salesInvoiceItems).values([
      { organizationId: orgPars.id, salesInvoiceId: si1.id, productId: pPrinter.id, quantity: "5.0000", unitPrice: "54000000.00", lineTotal: "270000000.00" },
      { organizationId: orgPars.id, salesInvoiceId: si1.id, productId: pScanner.id, quantity: "2.0000", unitPrice: "36000000.00", lineTotal: "72000000.00" },
    ]);

    const [si2Draft] = await tx
      .insert(salesInvoices)
      .values({
        organizationId: orgPars.id,
        contactId: cDena.id,
        warehouseId: parsBoot.defaultWarehouse.id,
        invoiceNumber: "SI-1404-102",
        invoiceDate: "2025-08-01",
        subtotal: "144000000.00",
        totalAmount: "144000000.00",
        status: "DRAFT",
        notes: "آماده نهایی‌سازی — با تایید، حواله انبار و سند حسابداری هم‌زمان ثبت می‌شود",
        createdBy: userAccountant.id,
      })
      .returning();

    await tx.insert(salesInvoiceItems).values([
      { organizationId: orgPars.id, salesInvoiceId: si2Draft.id, productId: pScanner.id, quantity: "4.0000", unitPrice: "36000000.00", lineTotal: "144000000.00" },
    ]);

    const [pi1Draft] = await tx
      .insert(purchaseInvoices)
      .values({
        organizationId: orgPars.id,
        contactId: cKianVendor.id,
        warehouseId: parsBoot.defaultWarehouse.id,
        invoiceNumber: "PI-1404-201",
        invoiceDate: "2025-08-02",
        subtotal: "210000000.00",
        totalAmount: "210000000.00",
        status: "DRAFT",
        notes: "خرید ۵ دستگاه فیش‌پرینتر جدید از کیان‌الکترونیک",
        createdBy: userWarehouse.id,
      })
      .returning();

    await tx.insert(purchaseInvoiceItems).values([
      { organizationId: orgPars.id, purchaseInvoiceId: pi1Draft.id, productId: pPrinter.id, quantity: "5.0000", unitPrice: "42000000.00", lineTotal: "210000000.00" },
    ]);

    await tx.insert(contactTransactions).values({
      organizationId: orgPars.id,
      contactId: cAfra.id,
      referenceType: "SALES_INVOICE",
      referenceId: si1.id,
      txDate: "2025-07-15",
      debit: "342000000.00",
      credit: "0.00",
      description: "فاکتور فروش SI-1404-101",
    });

    // 13. Treasury, Cashboxes, Cheques & Consignment
    const [finBank, finCash] = await tx
      .insert(financialAccounts)
      .values([
        {
          organizationId: orgPars.id,
          accountId: accMap.get("BANK")!.id,
          name: "حساب جاری بانک ملت - شعبه بهشتی",
          accountType: "BANK",
          bankName: "بانک ملت",
          accountNumber: "4588123490",
          iban: "IR820120000000004588123490",
          balance: "1950000000.00",
        },
        {
          organizationId: orgPars.id,
          accountId: accMap.get("CASH")!.id,
          name: "صندوق ریالی دفتر مرکزی",
          accountType: "CASHBOX",
          balance: "250000000.00",
        },
      ])
      .returning();

    await tx.insert(cashboxes).values({
      organizationId: orgPars.id,
      financialAccountId: finCash.id,
      cashierUserId: userAccountant.id,
      location: "دفتر مرکزی تهران - واحد مالی",
    });

    await tx.insert(financialTransactions).values({
      organizationId: orgPars.id,
      financialAccountId: finBank.id,
      contactId: cAfra.id,
      txType: "RECEIPT",
      amount: "150000000.00",
      txDate: "2025-07-18",
      trackingNumber: "SH-99281744",
      description: "دریافت علی‌الحساب فاکتور SI-1404-101",
      createdBy: userAccountant.id,
    });

    const [chq1, chq2] = await tx
      .insert(cheques)
      .values([
        {
          organizationId: orgPars.id,
          contactId: cAfra.id,
          financialAccountId: finBank.id,
          chequeType: "RECEIVABLE",
          sayadId: "4041987654321001",
          serialNumber: "884512/01",
          bankName: "بانک سامان",
          amount: "192000000.00",
          issueDate: "2025-07-16",
          dueDate: "2025-09-15",
          status: "REGISTERED",
          notes: "چک تسویه الباقی فاکتور فروشگاه افرا",
        },
        {
          organizationId: orgPars.id,
          contactId: cKianVendor.id,
          financialAccountId: finBank.id,
          chequeType: "PAYABLE",
          sayadId: "4041987654321002",
          serialNumber: "910234/02",
          bankName: "بانک ملت",
          amount: "210000000.00",
          issueDate: "2025-08-01",
          dueDate: "2025-10-01",
          status: "DEPOSITED",
          notes: "چک خرید محموله فیش‌پرینتر",
        },
      ])
      .returning();

    await tx.insert(chequeEvents).values([
      { organizationId: orgPars.id, chequeId: chq1.id, fromStatus: null, toStatus: "REGISTERED", eventDate: "2025-07-16", note: "ثبت اولیه چک صیادی در سامانه", actorUserId: userAccountant.id },
      { organizationId: orgPars.id, chequeId: chq2.id, fromStatus: "REGISTERED", toStatus: "DEPOSITED", eventDate: "2025-08-02", note: "تحویل چک پرداختنی به تأمین‌کننده", actorUserId: userAccountant.id },
    ]);

    const [consDoc] = await tx
      .insert(consignmentDocuments)
      .values({
        organizationId: orgPars.id,
        contactId: cSinaConsignor.id,
        warehouseId: parsBoot.defaultWarehouse.id,
        documentNumber: "CN-1404-01",
        direction: "IN",
        documentDate: "2025-07-10",
        commissionRate: "12.00",
        totalValue: "395000000.00",
        status: "OPEN",
        notes: "دریافت ۵ دستگاه سوئیچ صنعتی به صورت امانی جهت فروش",
      })
      .returning();

    await tx.insert(consignmentItems).values({
      organizationId: orgPars.id,
      consignmentDocumentId: consDoc.id,
      productId: pSwitch.id,
      quantityReceived: "5.0000",
      quantitySold: "2.0000",
      agreedUnitPrice: "79000000.00",
    });

    // 14. Android Devices, Sync Batches & Realistic Open Sync Conflict
    const [dev1, dev2] = await tx
      .insert(devices)
      .values([
        {
          organizationId: orgPars.id,
          userId: userAccountant.id,
          deviceUuid: "ANDR-SM-S928B-001",
          deviceName: "Samsung Galaxy S24 Ultra (ویزیتور ۱)",
          platform: "ANDROID",
          osVersion: "Android 15",
          appVersion: "2.4.1-offline",
          lastSyncAt: now,
          lastCheckpoint: 1012,
          status: "ACTIVE",
        },
        {
          organizationId: orgPars.id,
          userId: userWarehouse.id,
          deviceUuid: "ANDR-ZEBRA-TC21-002",
          deviceName: "هندهلد انبارداری Zebra TC21",
          platform: "ANDROID",
          osVersion: "Android 13",
          appVersion: "2.4.1-offline",
          lastSyncAt: new Date(now.getTime() - 3600 * 1000),
          lastCheckpoint: 1008,
          status: "ACTIVE",
        },
      ])
      .returning();

    await tx.insert(syncCheckpoints).values([
      { organizationId: orgPars.id, deviceId: dev1.id, checkpointSeq: 1012 },
      { organizationId: orgPars.id, deviceId: dev2.id, checkpointSeq: 1008 },
    ]);

    const [seedBatch] = await tx
      .insert(syncBatches)
      .values({
        organizationId: orgPars.id,
        deviceId: dev1.id,
        clientBatchId: "batch-android-1404-001",
        eventsCount: 2,
        appliedCount: 1,
        conflictCount: 1,
        rejectedCount: 0,
        status: "PARTIAL",
      })
      .returning();

    await tx.insert(syncEvents).values([
      {
        organizationId: orgPars.id,
        batchId: seedBatch.id,
        deviceId: dev1.id,
        clientEventId: "evt-seed-001",
        entityType: "CONTACT",
        entityId: cDena.id,
        operation: "CREATE",
        baseVersion: 0,
        payload: { name: "پخش تجهیزات اداری دنا", mobile: "09123334455" },
        status: "APPLIED",
      },
      {
        organizationId: orgPars.id,
        batchId: seedBatch.id,
        deviceId: dev1.id,
        clientEventId: "evt-seed-002",
        entityType: "CONTACT",
        entityId: cAfra.id,
        operation: "UPDATE",
        baseVersion: 1,
        payload: { name: "فروشگاه دیجیتال افرا (شعبه ولیعصر)", creditLimit: "300000000.00", mobile: "09121112299" },
        status: "CONFLICT",
        errorMessage: "نسخه سرور (v2) جدیدتر از نسخه آفلاین دستگاه (v1) است.",
      },
    ]);

    await tx.insert(syncConflicts).values({
      organizationId: orgPars.id,
      deviceId: dev1.id,
      entityType: "CONTACT",
      entityId: cAfra.id,
      clientVersion: 1,
      serverVersion: 2,
      clientPayload: {
        name: "فروشگاه دیجیتال افرا (شعبه ولیعصر)",
        creditLimit: "300000000.00",
        mobile: "09121112299",
      },
      serverPayload: {
        name: "فروشگاه دیجیتال افرا",
        creditLimit: "250000000.00",
        mobile: "09121112233",
      },
      status: "OPEN",
    });

    // 15. Audit Logs, System Error Logs, Support Tickets & Platform Settings
    await tx.insert(auditLogs).values([
      {
        organizationId: orgPars.id,
        actorUserId: userAccountant.id,
        actorEmail: userAccountant.email,
        scope: "ORGANIZATION",
        action: "JOURNAL_POSTED",
        entityType: "JOURNAL_ENTRY",
        entityId: je2.id,
        ipAddress: "185.110.24.12",
        severity: "INFO",
        metadata: { entryNumber: 2, totalDebit: "566000000.00" },
      },
      {
        organizationId: orgPars.id,
        actorUserId: userAdmin.id,
        actorEmail: userAdmin.email,
        scope: "PLATFORM",
        action: "ORGANIZATION_PROVISIONED",
        entityType: "ORGANIZATION",
        entityId: orgPars.id,
        ipAddress: "127.0.0.1",
        severity: "INFO",
        metadata: { plan: "PRO", rlsEnabled: true },
      },
      {
        organizationId: orgSepehr.id,
        actorUserId: userSepehr.id,
        actorEmail: userSepehr.email,
        scope: "SECURITY",
        action: "SUBSCRIPTION_EXPIRED_WRITE_GATED",
        entityType: "SUBSCRIPTION",
        entityId: orgSepehr.id,
        ipAddress: "91.98.42.19",
        severity: "WARN",
        metadata: { readAndExportAllowed: true },
      },
    ]);

    await tx.insert(systemErrorLogs).values([
      {
        organizationId: orgPars.id,
        source: "SYNC",
        errorCode: "SYNC_CONFLICT_DETECTED",
        message: "تعارض نسخه در همگام‌سازی آفلاین طرف‌حساب C-1001 از دستگاه Galaxy S24 Ultra",
        endpoint: "/api/v1/sync/push",
        status: "OPEN",
      },
      {
        organizationId: orgSepehr.id,
        source: "PAYMENT",
        errorCode: "CAFEBAZAAR_TOKEN_TIMEOUT",
        message: "تأخیر موقت در ارتباط با سرور کافه‌بازار هنگام بررسی تمدید خودکار",
        endpoint: "/api/v1/org/payments/cafebazaar/verify",
        status: "INVESTIGATING",
      },
    ]);

    await tx.insert(supportTickets).values([
      {
        organizationId: orgPars.id,
        userId: userAccountant.id,
        ticketNumber: "TKT-1404-101",
        subject: "راهنمایی جهت بازگشایی موقت دوره فصل بهار ۱۴۰۴",
        description: "نیاز به ثبت یک سند اصلاحی در فصل بهار داریم؛ لطفاً فرآیند مجوز بازگشایی دوره مالی را اعلام بفرمایید.",
        priority: "HIGH",
        status: "OPEN",
      },
      {
        organizationId: orgSepehr.id,
        userId: userSepehr.id,
        ticketNumber: "TKT-1404-102",
        subject: "تمدید اشتراک حرفه‌ای از طریق کافه‌بازار",
        description: "اشتراک ما منقضی شده و خروجی اکسل را دریافت کردیم؛ می‌خواهیم با توکن جدید کافه‌بازار تمدید کنیم.",
        priority: "MEDIUM",
        status: "IN_PROGRESS",
      },
    ]);

    await tx.insert(platformSettings).values([
      { key: "cafebazaar.package_name", category: "PAYMENTS", labelFa: "نام پکیج رسمی اندروید در کافه‌بازار", value: "ir.businessos.app" },
      { key: "security.refresh_rotation_enabled", category: "SECURITY", labelFa: "چرخش اجباری Refresh Token و مسدودسازی Reuse", value: true },
      { key: "security.rls_isolation_mode", category: "SECURITY", labelFa: "حالت جداسازی چندمستاجری (RLS + Membership Guard)", value: "STRICT_ENFORCED" },
      { key: "sync.max_batch_events", category: "SYNC", labelFa: "حداکثر تعداد رویداد در هر دسته Sync آفلاین", value: 250 },
      { key: "subscription.expiry_data_retention", category: "SUBSCRIPTION", labelFa: "حفظ کامل داده‌ها و مجاز بودن خروجی پس از انقضای اشتراک", value: "NEVER_DELETE_DATA" },
    ]);
  });

  await ensurePrompt05Seeded();
  await ensureSaasSeeded();
  console.log("[SEED] Business OS seeded successfully.");
}

export async function getOrganizationById(id: string) {
  const [org] = await db.select().from(organizations).where(eq(organizations.id, id)).limit(1);
  return org ?? null;
}

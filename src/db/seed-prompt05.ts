import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  accountGroups,
  accountingCategories,
  accountingPolicies,
  accounts,
  branches,
  categoryAccountMappings,
  contacts,
  employees,
  financialAccounts,
  loyaltyAccounts,
  loyaltyTransactions,
  organizations,
  permissions,
  personalExpenseCategories,
  rolePermissions,
  roles,
  users,
} from "@/db/schema";

const PROMPT05_PERMISSIONS: Array<{
  scope: "PLATFORM" | "ORGANIZATION";
  module: string;
  code: string;
  labelFa: string;
}> = [
  { scope: "ORGANIZATION", module: "reports", code: "reports.profit.view", labelFa: "مشاهده گزارش سود و زیان" },
  { scope: "ORGANIZATION", module: "personal_finance", code: "personal_finance.view", labelFa: "مشاهده مالی شخصی مالک" },
  { scope: "ORGANIZATION", module: "personal_finance", code: "personal_finance.manage", labelFa: "مدیریت مالی شخصی و برداشت مالک" },
  { scope: "ORGANIZATION", module: "employees", code: "employees.manage", labelFa: "مدیریت پرسنل و دسترسی انبار/شعبه" },
  { scope: "ORGANIZATION", module: "roles", code: "permissions.manage", labelFa: "تنظیم دسترسی‌های پرسنل سازمان" },
  { scope: "ORGANIZATION", module: "sales", code: "sales.return", labelFa: "ثبت برگشت از فروش" },
  { scope: "ORGANIZATION", module: "inventory", code: "inventory.adjust", labelFa: "تعدیل موجودی و انبارگردانی" },
  { scope: "ORGANIZATION", module: "accounting", code: "accounting.coa.manage", labelFa: "مدیریت کدینگ حساب‌ها، افتتاح و بستن حساب" },
  { scope: "ORGANIZATION", module: "accounting", code: "accounting.fiscal.open", labelFa: "افتتاح سال مالی و سند افتتاحیه" },
  { scope: "ORGANIZATION", module: "accounting", code: "accounting.fiscal.close", labelFa: "بستن سال مالی و صدور سند اختتامیه" },
  { scope: "ORGANIZATION", module: "accounting", code: "accounting.fiscal.reopen", labelFa: "بازگشایی مجاز سال مالی بسته‌شده" },
  { scope: "ORGANIZATION", module: "users", code: "users.invite", labelFa: "دعوت کاربر جدید و اشتراک‌گذاری دسترسی" },
  { scope: "ORGANIZATION", module: "users", code: "users.manage", labelFa: "مدیریت اعضا، نقش‌ها و نشست‌های سازمان" },
  { scope: "ORGANIZATION", module: "purchases", code: "purchases.return", labelFa: "ثبت برگشت از خرید" },
  { scope: "ORGANIZATION", module: "consignments", code: "consignments.create", labelFa: "ثبت سند امانی جدید" },
  { scope: "ORGANIZATION", module: "consignments", code: "consignments.confirm", labelFa: "تأیید سند امانی" },
  { scope: "ORGANIZATION", module: "consignments", code: "consignments.return", labelFa: "برگشت کالای امانی" },
  { scope: "ORGANIZATION", module: "accounting", code: "accounting.policy.view", labelFa: "مشاهده سیاست حسابداری و مالیات" },
  { scope: "ORGANIZATION", module: "accounting", code: "accounting.policy.update", labelFa: "تغییر سیاست حسابداری و مالیات" },
  { scope: "ORGANIZATION", module: "accounting", code: "accounting.cost_centers.view", labelFa: "مشاهده مراکز هزینه" },
  { scope: "ORGANIZATION", module: "accounting", code: "accounting.cost_centers.create", labelFa: "ایجاد مرکز هزینه" },
  { scope: "ORGANIZATION", module: "accounting", code: "accounting.cost_centers.update", labelFa: "ویرایش مرکز هزینه" },
  { scope: "ORGANIZATION", module: "accounting", code: "accounting.periods.lock", labelFa: "قفل دوره مالی" },
  { scope: "ORGANIZATION", module: "accounting", code: "accounting.periods.unlock", labelFa: "بازگشایی دوره مالی قفل‌شده" },
  { scope: "ORGANIZATION", module: "personal_finance", code: "personal_finance.create", labelFa: "ثبت تراکنش و انتقال مالی شخصی" },
  { scope: "ORGANIZATION", module: "employees", code: "employees.view", labelFa: "مشاهده لیست پرسنل" },
  { scope: "ORGANIZATION", module: "sync", code: "sync.push", labelFa: "ارسال تغییرات آفلاین (Sync Push)" },
  { scope: "ORGANIZATION", module: "sync", code: "sync.pull", labelFa: "دریافت تغییرات سرور (Sync Pull)" },
  { scope: "ORGANIZATION", module: "sales", code: "sales.settlement.manage", labelFa: "تخصیص تسویه ترکیبی فروش" },
  { scope: "ORGANIZATION", module: "inventory", code: "inventory.receipts.create", labelFa: "ثبت رسید ورود کالا با بهای تمام‌شده" },
  { scope: "ORGANIZATION", module: "inventory", code: "inventory.transfers.create", labelFa: "ثبت و ارسال انتقال بین انبارها" },
  { scope: "ORGANIZATION", module: "inventory", code: "inventory.transfers.receive", labelFa: "تحویل جزئی و ثبت مغایرت انتقال انبار" },
  { scope: "ORGANIZATION", module: "inventory", code: "inventory.exports", labelFa: "خروجی اکسل موجودی و گردش انبار" },
  { scope: "ORGANIZATION", module: "suppliers", code: "suppliers.view", labelFa: "مشاهده پروفایل و حساب تأمین‌کنندگان" },
  { scope: "ORGANIZATION", module: "suppliers", code: "suppliers.settle", labelFa: "ثبت تسویه بدهی تأمین‌کنندگان" },
  { scope: "ORGANIZATION", module: "cheques", code: "cheques.update", labelFa: "ویرایش کنترل‌شده چک‌های ثبت‌شده" },
  { scope: "ORGANIZATION", module: "treasury", code: "treasury.accounts.manage", labelFa: "ایجاد و مدیریت حساب‌های خزانه" },
  { scope: "ORGANIZATION", module: "treasury", code: "treasury.transactions.view", labelFa: "مشاهده گردش حساب‌های خزانه" },
  { scope: "ORGANIZATION", module: "subscription", code: "subscriptions.upgrade", labelFa: "ارتقا پلن اشتراک و پرداخت آنلاین" },
  { scope: "ORGANIZATION", module: "settings", code: "settings.offline_mode.manage", labelFa: "مدیریت حالت آفلاین خالص و مهاجرت ابری" },
  { scope: "PLATFORM", module: "payments", code: "platform.gateways.manage", labelFa: "تنظیم درگاه‌های پرداخت (زرین‌پال، زیبال، بله، سامان)" },
];

const DEFAULT_PERSONAL_CATEGORIES = [
  { code: "PF_HOUSING", nameFa: "اجاره و هزینه مسکن", icon: "home", color: "#4f46e5", budget: "15000000.00" },
  { code: "PF_HOUSEHOLD", nameFa: "مخارج خانه و خواربار", icon: "shopping-basket", color: "#059669", budget: "12000000.00" },
  { code: "PF_LOAN", nameFa: "اقساط وام و تسهیلات", icon: "landmark", color: "#dc2626", budget: "10000000.00" },
  { code: "PF_UTILITIES", nameFa: "آب، برق، گاز، اینترنت و موبایل", icon: "zap", color: "#d97706", budget: "3500000.00" },
  { code: "PF_VEHICLE", nameFa: "خودرو و حمل‌ونقل شخصی", icon: "car", color: "#0284c7", budget: "5000000.00" },
  { code: "PF_HEALTH", nameFa: "درمان، دارو و بیمه", icon: "heart-pulse", color: "#e11d48", budget: "4000000.00" },
  { code: "PF_EDUCATION", nameFa: "آموزش و مدرسه", icon: "graduation-cap", color: "#7c3aed", budget: "4000000.00" },
  { code: "PF_FAMILY", nameFa: "هزینه‌های خانواده و پوشاک", icon: "users", color: "#0d9488", budget: "6000000.00" },
  { code: "PF_OTHER", nameFa: "سایر مخارج شخصی", icon: "wallet", color: "#64748b", budget: "3000000.00" },
];

export async function ensurePrompt05OrgDefaults(organizationId: string) {
  // 1. Ensure extended Chart of Accounts roles exist for this org
  const groups = await db
    .select()
    .from(accountGroups)
    .where(eq(accountGroups.organizationId, organizationId));
  if (groups.length === 0) return;

  const groupByNature = new Map(groups.map((g) => [g.nature, g]));
  const existingAccs = await db
    .select()
    .from(accounts)
    .where(eq(accounts.organizationId, organizationId));
  const codeSet = new Set(existingAccs.map((a) => a.code));

  const extraAccounts: Array<{
    nature: string;
    code: string;
    name: string;
    accountType: string;
    normalBalance: string;
    systemRole: string;
  }> = [
    { nature: "ASSET", code: "1202", name: "اسناد دریافتنی (چک‌های نزد صندوق)", accountType: "ASSET", normalBalance: "DEBIT", systemRole: "RECEIVABLE_CHEQUE" },
    { nature: "ASSET", code: "1203", name: "اسناد دریافتنی در جریان وصول", accountType: "ASSET", normalBalance: "DEBIT", systemRole: "CHEQUE_IN_COLLECTION" },
    { nature: "LIABILITY", code: "2301", name: "مالیات بر ارزش افزوده پرداختنی", accountType: "LIABILITY", normalBalance: "CREDIT", systemRole: "TAX_PAYABLE" },
    { nature: "EQUITY", code: "3201", name: "برداشت مالک / جاری شرکا", accountType: "EQUITY", normalBalance: "DEBIT", systemRole: "OWNER_DRAWINGS" },
    { nature: "EQUITY", code: "3301", name: "سود و زیان انباشته (خلاصه سود و زیان)", accountType: "EQUITY", normalBalance: "CREDIT", systemRole: "RETAINED_EARNINGS" },
    { nature: "REVENUE", code: "4102", name: "درآمد ارائه خدمات فنی و پشتیبانی", accountType: "REVENUE", normalBalance: "CREDIT", systemRole: "SERVICE_REVENUE" },
    { nature: "REVENUE", code: "4109", name: "تخفیفات نقدی و تجاری فروش (کاهنده)", accountType: "REVENUE", normalBalance: "DEBIT", systemRole: "SALES_DISCOUNT" },
    { nature: "EXPENSE", code: "5202", name: "هزینه حمل‌ونقل و پیک", accountType: "EXPENSE", normalBalance: "DEBIT", systemRole: "TRANSPORT_EXPENSE" },
    { nature: "EXPENSE", code: "5203", name: "هزینه اجاره محل کسب", accountType: "EXPENSE", normalBalance: "DEBIT", systemRole: "RENT_EXPENSE" },
    { nature: "EXPENSE", code: "5204", name: "هزینه آب، برق، گاز و اینترنت", accountType: "EXPENSE", normalBalance: "DEBIT", systemRole: "UTILITIES_EXPENSE" },
  ];

  for (const ea of extraAccounts) {
    if (!codeSet.has(ea.code)) {
      const grp = groupByNature.get(ea.nature);
      if (grp) {
        await db
          .insert(accounts)
          .values({
            organizationId,
            groupId: grp.id,
            code: ea.code,
            name: ea.name,
            accountType: ea.accountType,
            normalBalance: ea.normalBalance,
            systemRole: ea.systemRole,
          })
          .onConflictDoNothing();
      }
    }
  }

  const allAccs = await db
    .select()
    .from(accounts)
    .where(eq(accounts.organizationId, organizationId));
  const accByRole = new Map(allAccs.filter((a) => a.systemRole).map((a) => [a.systemRole!, a]));

  // 2. Ensure a POS financial account exists for Mixed Payments (Cash + POS + Bank)
  const finAccs = await db
    .select()
    .from(financialAccounts)
    .where(eq(financialAccounts.organizationId, organizationId));
  if (finAccs.length === 0 && accByRole.get("CASH") && accByRole.get("BANK")) {
    await db.insert(financialAccounts).values([
      {
        organizationId,
        accountId: accByRole.get("CASH")!.id,
        name: "صندوق نقدی فروشگاه",
        accountType: "CASHBOX",
        balance: "50000000.00",
      },
      {
        organizationId,
        accountId: accByRole.get("BANK")!.id,
        name: "حساب بانکی اصلی",
        accountType: "BANK",
        bankName: "بانک ملت",
        balance: "150000000.00",
      },
      {
        organizationId,
        accountId: accByRole.get("BANK")!.id,
        name: "دستگاه کارت‌خوان (POS) فروشگاهی",
        accountType: "POS",
        bankName: "به‌پرداخت ملت",
        balance: "0.00",
      },
    ]);
  } else if (!finAccs.some((f) => f.accountType === "POS") && accByRole.get("BANK")) {
    await db.insert(financialAccounts).values({
      organizationId,
      accountId: accByRole.get("BANK")!.id,
      name: "دستگاه کارت‌خوان (POS) فروشگاهی",
      accountType: "POS",
      bankName: "به‌پرداخت ملت",
      balance: "0.00",
    });
  }

  // 2b. Ensure Default Accounting Policy (§9) & Default Branch exist
  await db
    .insert(accountingPolicies)
    .values({
      organizationId,
      defaultTaxRate: "10.00",
      isTaxInclusive: false,
      invoicePrefix: "SI-",
      lowStockAlertEnabled: true,
    })
    .onConflictDoNothing();

  await db
    .insert(branches)
    .values({
      organizationId,
      code: "BR-MAIN",
      name: "شعبه مرکزی",
      isDefault: true,
      isActive: true,
    })
    .onConflictDoNothing();

  // 3. Ensure Default Personal Expense Categories (§3.4)
  for (const cat of DEFAULT_PERSONAL_CATEGORIES) {
    await db
      .insert(personalExpenseCategories)
      .values({
        organizationId,
        code: cat.code,
        nameFa: cat.nameFa,
        icon: cat.icon,
        color: cat.color,
        monthlyBudgetLimit: cat.budget,
        isDefault: true,
        isActive: true,
      })
      .onConflictDoNothing();
  }

  // 4. Ensure Accounting Categories + Automatic Account Mappings (§5.4)
  const bankAcc = accByRole.get("BANK") ?? accByRole.get("CASH");
  const cashAcc = accByRole.get("CASH") ?? bankAcc;
  const taxAcc = accByRole.get("TAX_PAYABLE") ?? null;

  const defaultBizCats = [
    { kind: "EXPENSE", code: "EXP_TRANSPORT", nameFa: "حمل‌ونقل و پیک", icon: "truck", color: "#0284c7", debitRole: "TRANSPORT_EXPENSE", creditAcc: cashAcc },
    { kind: "EXPENSE", code: "EXP_RENT", nameFa: "اجاره محل کسب و انبار", icon: "building", color: "#7c3aed", debitRole: "RENT_EXPENSE", creditAcc: bankAcc },
    { kind: "EXPENSE", code: "EXP_UTILITIES", nameFa: "قبوض آب، برق، گاز و اینترنت", icon: "zap", color: "#d97706", debitRole: "UTILITIES_EXPENSE", creditAcc: bankAcc },
    { kind: "EXPENSE", code: "EXP_GENERAL", nameFa: "هزینه‌های اداری و عمومی", icon: "briefcase", color: "#475569", debitRole: "OPEX", creditAcc: cashAcc },
    { kind: "INCOME", code: "INC_SERVICE", nameFa: "درآمد خدمات نصب و پشتیبانی", icon: "wrench", color: "#059669", debitRole: "BANK", creditRole: "SERVICE_REVENUE" },
    { kind: "INCOME", code: "INC_OTHER", nameFa: "سایر درآمدهای عملیاتی", icon: "coins", color: "#0d9488", debitRole: "CASH", creditRole: "SALES_REVENUE" },
  ];

  for (const c of defaultBizCats) {
    await db
      .insert(accountingCategories)
      .values({
        organizationId,
        kind: c.kind,
        scope: "BUSINESS",
        code: c.code,
        nameFa: c.nameFa,
        icon: c.icon,
        color: c.color,
        isActive: true,
      })
      .onConflictDoNothing();

    const [catRow] = await db
      .select()
      .from(accountingCategories)
      .where(and(eq(accountingCategories.organizationId, organizationId), eq(accountingCategories.code, c.code)))
      .limit(1);

    if (catRow) {
      const debitAcc = accByRole.get(c.debitRole) ?? bankAcc;
      const creditAcc = c.creditRole ? accByRole.get(c.creditRole) ?? bankAcc : c.creditAcc;
      if (debitAcc && creditAcc) {
        await db
          .insert(categoryAccountMappings)
          .values({
            organizationId,
            categoryId: catRow.id,
            debitAccountId: debitAcc.id,
            creditAccountId: creditAcc.id,
            taxAccountId: taxAcc?.id ?? null,
            isActive: true,
          })
          .onConflictDoNothing();
      }
    }
  }

  // 5. Ensure at least one CRM Loyalty Account & Employee record for seeded demo
  const orgContacts = await db
    .select()
    .from(contacts)
    .where(eq(contacts.organizationId, organizationId))
    .limit(2);
  if (orgContacts.length > 0) {
    const firstCust = orgContacts[0];
    const [existingLoyalty] = await db
      .select()
      .from(loyaltyAccounts)
      .where(and(eq(loyaltyAccounts.organizationId, organizationId), eq(loyaltyAccounts.contactId, firstCust.id)))
      .limit(1);
    if (!existingLoyalty) {
      const [la] = await db
        .insert(loyaltyAccounts)
        .values({ organizationId, contactId: firstCust.id, tier: "GOLD" })
        .returning();
      await db.insert(loyaltyTransactions).values({
        organizationId,
        loyaltyAccountId: la.id,
        contactId: firstCust.id,
        txType: "EARN",
        pointsDelta: 342,
        referenceType: "SALES_INVOICE",
        description: "امتیاز خرید عمده اولیه مشتری",
      });
    }
  }
}

export async function ensurePrompt05Seeded() {
  // 1. Insert Prompt 05 granular permissions idempotently
  for (const p of PROMPT05_PERMISSIONS) {
    await db.insert(permissions).values(p).onConflictDoNothing();
  }

  const allPerms = await db.select().from(permissions);
  const permByCode = new Map(allPerms.map((p) => [p.code, p]));
  const allRoles = await db.select().from(roles);

  const grantRole = async (roleCode: string, codes: string[]) => {
    const role = allRoles.find((r) => r.code === roleCode);
    if (!role) return;
    for (const c of codes) {
      const perm = permByCode.get(c);
      if (perm) {
        await db
          .insert(rolePermissions)
          .values({ roleId: role.id, permissionId: perm.id })
          .onConflictDoNothing();
      }
    }
  };

  // Owner gets ALL org permissions including personal_finance & reports.profit.view & employees.manage
  await grantRole("ORG_OWNER", [
    "reports.profit.view",
    "personal_finance.view",
    "personal_finance.manage",
    "employees.manage",
    "permissions.manage",
    "sales.return",
    "inventory.adjust",
    "accounting.coa.manage",
    "accounting.fiscal.open",
    "accounting.fiscal.close",
    "accounting.fiscal.reopen",
    "users.invite",
    "users.manage",
  ]);
  // Accountant gets profit reports, COA & fiscal year open/close (NOT reopen or personal finance!)
  await grantRole("ACCOUNTANT", [
    "reports.profit.view",
    "sales.return",
    "accounting.coa.manage",
    "accounting.fiscal.open",
    "accounting.fiscal.close",
  ]);
  // Warehouse manager gets inventory.adjust, NOT profit reports or personal finance
  await grantRole("WAREHOUSE_MGR", ["inventory.adjust"]);
  // SALESPERSON gets sales.return, STRICTLY DENIED reports.profit.view & personal_finance.*!
  await grantRole("SALESPERSON", ["sales.return"]);

  // 2. Provision defaults for every existing organization
  const allOrgs = await db.select().from(organizations);
  for (const org of allOrgs) {
    await ensurePrompt05OrgDefaults(org.id);
  }

  // 3. Seed sample employee row for ParsTech if missing
  if (allOrgs.length > 0) {
    const pars = allOrgs[0];
    const existingEmps = await db
      .select({ id: employees.id })
      .from(employees)
      .where(eq(employees.organizationId, pars.id))
      .limit(1);
    if (existingEmps.length === 0) {
      const accUser = await db
        .select()
        .from(users)
        .where(eq(users.email, "accountant@parstech.ir"))
        .limit(1);
      const accRole = allRoles.find((r) => r.code === "ACCOUNTANT");
      if (accUser[0]) {
        await db
          .insert(employees)
          .values({
            organizationId: pars.id,
            userId: accUser[0].id,
            employeeCode: "EMP-101",
            fullName: accUser[0].fullName,
            mobile: accUser[0].phone,
            email: accUser[0].email,
            roleId: accRole?.id ?? null,
            branchName: "دفتر مرکزی تهران",
            employmentStatus: "ACTIVE",
            hireDate: "2024-04-01",
          })
          .onConflictDoNothing();
      }
    }
  }
}

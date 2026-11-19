import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  integer,
  numeric,
  timestamp,
  date,
  jsonb,
  uniqueIndex,
  index,
  bigint,
  bigserial,
} from "drizzle-orm/pg-core";

// ============================================================================
// 1. ORGANIZATION & MULTI-TENANCY
// ============================================================================

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: varchar("name", { length: 160 }).notNull(),
    legalName: varchar("legal_name", { length: 200 }),
    businessType: varchar("business_type", { length: 40 }).notNull().default("RETAIL"),
    economicCode: varchar("economic_code", { length: 32 }),
    nationalId: varchar("national_id", { length: 32 }),
    mobile: varchar("mobile", { length: 32 }),
    phone: varchar("phone", { length: 40 }),
    email: varchar("email", { length: 160 }),
    address: text("address"),
    postalCode: varchar("postal_code", { length: 24 }),
    fiscalYearStart: varchar("fiscal_year_start", { length: 16 }).notNull().default("01-01"),
    baseCurrency: varchar("base_currency", { length: 10 }).notNull().default("IRR"),
    currencyScale: integer("currency_scale").notNull().default(2),
    timezone: varchar("timezone", { length: 64 }).notNull().default("Asia/Tehran"),
    costingMethod: varchar("costing_method", { length: 32 }).notNull().default("WEIGHTED_AVERAGE"), // FIFO | WEIGHTED_AVERAGE
    negativeStockPolicy: varchar("negative_stock_policy", { length: 16 }).notNull().default("BLOCK"), // ALLOW | WARN | BLOCK
    enabledAddons: text("enabled_addons").array().notNull().default([]), // RETAIL_POS | DISTRIBUTION | SERVICE_REPAIR | LIGHT_MANUFACTURING
    uiModeDefault: varchar("ui_mode_default", { length: 32 }).notNull().default("SIMPLE_OWNER"), // SIMPLE_OWNER | ADVANCED_ACCOUNTING
    entitlementVersion: integer("entitlement_version").notNull().default(1),
    operatingMode: varchar("operating_mode", { length: 24 }).notNull().default("CLOUD_SYNC"), // CLOUD_SYNC | OFFLINE_ONLY
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
    status: varchar("status", { length: 24 }).notNull().default("ACTIVE"), // ACTIVE | SUSPENDED | ARCHIVED
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_organizations_status").on(t.status)]
);

// ============================================================================
// 2. IDENTITY, USERS, MEMBERSHIPS, RBAC, SESSIONS & DEVICES
// ============================================================================

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: varchar("email", { length: 180 }).notNull(),
    phone: varchar("phone", { length: 32 }),
    fullName: varchar("full_name", { length: 160 }).notNull(),
    passwordHash: text("password_hash").notNull(),
    mobileVerified: boolean("mobile_verified").notNull().default(false),
    isPlatformAdmin: boolean("is_platform_admin").notNull().default(false),
    status: varchar("status", { length: 24 }).notNull().default("ACTIVE"), // ACTIVE | SUSPENDED
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("uq_users_email").on(t.email)]
);

export const roles = pgTable(
  "roles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
    scope: varchar("scope", { length: 20 }).notNull().default("ORGANIZATION"), // PLATFORM | ORGANIZATION
    code: varchar("code", { length: 64 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    description: text("description"),
    isSystem: boolean("is_system").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("uq_roles_scope_code_org").on(t.scope, t.code, t.organizationId)]
);

export const permissions = pgTable(
  "permissions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    scope: varchar("scope", { length: 20 }).notNull().default("ORGANIZATION"), // PLATFORM | ORGANIZATION
    module: varchar("module", { length: 64 }).notNull(),
    code: varchar("code", { length: 96 }).notNull(),
    labelFa: varchar("label_fa", { length: 160 }).notNull(),
    description: text("description"),
  },
  (t) => [uniqueIndex("uq_permissions_code").on(t.code)]
);

export const rolePermissions = pgTable(
  "role_permissions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permissionId: uuid("permission_id")
      .notNull()
      .references(() => permissions.id, { onDelete: "cascade" }),
  },
  (t) => [uniqueIndex("uq_role_permission").on(t.roleId, t.permissionId)]
);

export const organizationMembers = pgTable(
  "organization_members",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: varchar("status", { length: 24 }).notNull().default("ACTIVE"), // ACTIVE | INVITED | SUSPENDED
    isOwner: boolean("is_owner").notNull().default(false),
    branchAccess: jsonb("branch_access").$type<string[]>().notNull().default(["ALL"]),
    warehouseAccess: jsonb("warehouse_access").$type<string[]>().notNull().default(["ALL"]),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uq_org_member").on(t.organizationId, t.userId),
    index("idx_org_members_user").on(t.userId),
  ]
);

export const userRoles = pgTable(
  "user_roles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("uq_user_role_org").on(t.userId, t.roleId, t.organizationId)]
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "set null" }),
    tokenFamily: uuid("token_family").defaultRandom().notNull(),
    refreshTokenHash: text("refresh_token_hash").notNull(),
    ipAddress: varchar("ip_address", { length: 64 }),
    userAgent: text("user_agent"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_sessions_user").on(t.userId), index("idx_sessions_family").on(t.tokenFamily)]
);

export const devices = pgTable(
  "devices",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    deviceUuid: varchar("device_uuid", { length: 128 }).notNull(),
    deviceName: varchar("device_name", { length: 160 }).notNull(),
    platform: varchar("platform", { length: 24 }).notNull().default("ANDROID"),
    osVersion: varchar("os_version", { length: 64 }),
    appVersion: varchar("app_version", { length: 40 }),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    lastCheckpoint: bigint("last_checkpoint", { mode: "number" }).notNull().default(0),
    status: varchar("status", { length: 24 }).notNull().default("ACTIVE"), // ACTIVE | BLOCKED
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uq_devices_org_uuid").on(t.organizationId, t.deviceUuid),
    index("idx_devices_org").on(t.organizationId),
  ]
);

// ============================================================================
// 3. CONTACTS MODULE
// ============================================================================

export const contactGroups = pgTable(
  "contact_groups",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 120 }).notNull(),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_contact_groups_org").on(t.organizationId)]
);

export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    groupId: uuid("group_id").references(() => contactGroups.id, { onDelete: "set null" }),
    code: varchar("code", { length: 48 }).notNull(),
    name: varchar("name", { length: 180 }).notNull(),
    firstName: varchar("first_name", { length: 100 }),
    lastName: varchar("last_name", { length: 100 }),
    companyName: varchar("company_name", { length: 180 }),
    contactType: varchar("contact_type", { length: 24 }).notNull().default("CUSTOMER"), // CUSTOMER | SUPPLIER | BOTH | EMPLOYEE | OTHER
    mobile: varchar("mobile", { length: 32 }),
    phone: varchar("phone", { length: 32 }),
    email: varchar("email", { length: 160 }),
    address: text("address"),
    postalCode: varchar("postal_code", { length: 24 }),
    nationalCode: varchar("national_code", { length: 32 }),
    economicCode: varchar("economic_code", { length: 32 }),
    creditLimit: numeric("credit_limit", { precision: 18, scale: 2 }).notNull().default("0.00"),
    openingBalance: numeric("opening_balance", { precision: 18, scale: 2 }).notNull().default("0.00"),
    notes: text("notes"),
    status: varchar("status", { length: 24 }).notNull().default("ACTIVE"),
    version: integer("version").notNull().default(1),
    syncSeq: bigint("sync_seq", { mode: "number" }).notNull().default(1),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uq_contacts_org_code").on(t.organizationId, t.code),
    index("idx_contacts_org_sync").on(t.organizationId, t.syncSeq),
  ]
);

export const contactAddresses = pgTable(
  "contact_addresses",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 80 }).notNull().default("دفتر مرکزی"),
    city: varchar("city", { length: 80 }),
    postalCode: varchar("postal_code", { length: 24 }),
    addressLine: text("address_line").notNull(),
    isDefault: boolean("is_default").notNull().default(true),
  },
  (t) => [index("idx_contact_addresses_org").on(t.organizationId, t.contactId)]
);

export const contactAccounts = pgTable(
  "contact_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    bankName: varchar("bank_name", { length: 100 }).notNull(),
    accountNumber: varchar("account_number", { length: 64 }),
    iban: varchar("iban", { length: 40 }),
    cardNumber: varchar("card_number", { length: 32 }),
  },
  (t) => [index("idx_contact_accounts_org").on(t.organizationId, t.contactId)]
);

export const contactTransactions = pgTable(
  "contact_transactions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    referenceType: varchar("reference_type", { length: 48 }).notNull(), // SALES_INVOICE | PURCHASE_INVOICE | TREASURY | JOURNAL
    referenceId: uuid("reference_id"),
    txDate: date("tx_date").notNull(),
    debit: numeric("debit", { precision: 18, scale: 2 }).notNull().default("0.00"),
    credit: numeric("credit", { precision: 18, scale: 2 }).notNull().default("0.00"),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_contact_tx_org_contact").on(t.organizationId, t.contactId)]
);

// ============================================================================
// 4. CATALOG MODULE
// ============================================================================

export const categories = pgTable(
  "categories",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id"),
    name: varchar("name", { length: 120 }).notNull(),
    code: varchar("code", { length: 48 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_categories_org").on(t.organizationId)]
);

export const brands = pgTable(
  "brands",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 120 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_brands_org").on(t.organizationId)]
);

export const units = pgTable(
  "units",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 64 }).notNull(),
    symbol: varchar("symbol", { length: 24 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_units_org").on(t.organizationId)]
);

export const products = pgTable(
  "products",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id").references(() => categories.id, { onDelete: "set null" }),
    brandId: uuid("brand_id").references(() => brands.id, { onDelete: "set null" }),
    baseUnitId: uuid("base_unit_id")
      .notNull()
      .references(() => units.id, { onDelete: "restrict" }),
    sku: varchar("sku", { length: 64 }).notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    description: text("description"),
    productType: varchar("product_type", { length: 24 }).notNull().default("PRODUCT"), // PRODUCT | SERVICE | RAW_MATERIAL | FINISHED_PRODUCT | GOODS | CONSIGNMENT
    costingMethod: varchar("costing_method", { length: 32 }).notNull().default("WEIGHTED_AVERAGE"),
    defaultPurchasePrice: numeric("default_purchase_price", { precision: 18, scale: 2 }).notNull().default("0.00"),
    defaultSalePrice: numeric("default_sale_price", { precision: 18, scale: 2 }).notNull().default("0.00"),
    taxRate: numeric("tax_rate", { precision: 8, scale: 2 }).notNull().default("10.00"),
    minStockLevel: numeric("min_stock_level", { precision: 18, scale: 4 }).notNull().default("0.0000"),
    maxStockLevel: numeric("max_stock_level", { precision: 18, scale: 4 }).notNull().default("0.0000"),
    trackInventory: boolean("track_inventory").notNull().default(true),
    allowNegativeStock: boolean("allow_negative_stock").notNull().default(false),
    attributes: jsonb("attributes").$type<Record<string, unknown>>().notNull().default({}),
    isActive: boolean("is_active").notNull().default(true),
    version: integer("version").notNull().default(1),
    syncSeq: bigint("sync_seq", { mode: "number" }).notNull().default(1),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uq_products_org_sku").on(t.organizationId, t.sku),
    index("idx_products_org_sync").on(t.organizationId, t.syncSeq),
  ]
);

export const productUnits = pgTable(
  "product_units",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    unitId: uuid("unit_id")
      .notNull()
      .references(() => units.id, { onDelete: "restrict" }),
    conversionFactor: numeric("conversion_factor", { precision: 18, scale: 4 }).notNull().default("1.0000"),
  },
  (t) => [index("idx_product_units_org").on(t.organizationId, t.productId)]
);

export const barcodes = pgTable(
  "barcodes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    barcode: varchar("barcode", { length: 96 }).notNull(),
    isPrimary: boolean("is_primary").notNull().default(true),
  },
  (t) => [uniqueIndex("uq_barcodes_org_code").on(t.organizationId, t.barcode)]
);

export const productPrices = pgTable(
  "product_prices",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    priceListName: varchar("price_list_name", { length: 80 }).notNull().default("عمده"),
    price: numeric("price", { precision: 18, scale: 2 }).notNull(),
    currency: varchar("currency", { length: 10 }).notNull().default("IRR"),
  },
  (t) => [index("idx_product_prices_org").on(t.organizationId, t.productId)]
);

export const productAttributes = pgTable(
  "product_attributes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    attrKey: varchar("attr_key", { length: 80 }).notNull(),
    attrValue: varchar("attr_value", { length: 160 }).notNull(),
  },
  (t) => [index("idx_product_attrs_org").on(t.organizationId, t.productId)]
);

export const productImages = pgTable(
  "product_images",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    isPrimary: boolean("is_primary").notNull().default(false),
  },
  (t) => [index("idx_product_images_org").on(t.organizationId, t.productId)]
);

// ============================================================================
// 5. ACCOUNTING MODULE (STRICT DOUBLE-ENTRY)
// ============================================================================

export const accountGroups = pgTable(
  "account_groups",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    code: varchar("code", { length: 24 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    nature: varchar("nature", { length: 24 }).notNull(), // ASSET | LIABILITY | EQUITY | REVENUE | EXPENSE
  },
  (t) => [uniqueIndex("uq_account_groups_org_code").on(t.organizationId, t.code)]
);

export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    groupId: uuid("group_id")
      .notNull()
      .references(() => accountGroups.id, { onDelete: "restrict" }),
    parentId: uuid("parent_id"),
    accountLevel: integer("account_level").notNull().default(3), // 1=Group, 2=GL, 3=Subsidiary, 4=Detail
    code: varchar("code", { length: 32 }).notNull(),
    name: varchar("name", { length: 160 }).notNull(),
    description: text("description"),
    accountType: varchar("account_type", { length: 24 }).notNull(), // ASSET | LIABILITY | EQUITY | REVENUE | EXPENSE
    normalBalance: varchar("normal_balance", { length: 10 }).notNull(), // DEBIT | CREDIT
    isPostable: boolean("is_postable").notNull().default(true),
    systemRole: varchar("system_role", { length: 48 }), // CASH | BANK | AR | AP | INVENTORY | SALES_REVENUE | COGS | CAPITAL | RETAINED_EARNINGS
    accountStatus: varchar("account_status", { length: 32 }).notNull().default("ACTIVE"), // ACTIVE | TEMPORARILY_SUSPENDED | PENDING_CLOSURE | CLOSED
    isActive: boolean("is_active").notNull().default(true),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: uuid("closed_by").references(() => users.id, { onDelete: "set null" }),
    closureReason: text("closure_reason"),
    version: integer("version").notNull().default(1),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uq_accounts_org_code").on(t.organizationId, t.code),
    index("idx_accounts_org_role").on(t.organizationId, t.systemRole),
  ]
);

export const fiscalYears = pgTable(
  "fiscal_years",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 80 }).notNull(),
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    calendarSystem: varchar("calendar_system", { length: 16 }).notNull().default("PERSIAN"), // PERSIAN | GREGORIAN
    currency: varchar("currency", { length: 10 }).notNull().default("IRR"),
    status: varchar("status", { length: 28 }).notNull().default("OPEN"), // DRAFT | PREPARING | OPEN | CLOSING_IN_PROGRESS | CLOSED | REOPENED
    isDefault: boolean("is_default").notNull().default(false),
    openingJournalId: uuid("opening_journal_id"),
    closingJournalId: uuid("closing_journal_id"),
    previousFiscalYearId: uuid("previous_fiscal_year_id"),
    nextFiscalYearId: uuid("next_fiscal_year_id"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: uuid("closed_by").references(() => users.id, { onDelete: "set null" }),
    reopenedAt: timestamp("reopened_at", { withTimezone: true }),
    reopenedBy: uuid("reopened_by").references(() => users.id, { onDelete: "set null" }),
    reopenReason: text("reopen_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_fiscal_years_org").on(t.organizationId)]
);

export const accountingPeriods = pgTable(
  "accounting_periods",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    fiscalYearId: uuid("fiscal_year_id")
      .notNull()
      .references(() => fiscalYears.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 80 }).notNull(),
    periodNumber: integer("period_number").notNull(),
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    status: varchar("status", { length: 20 }).notNull().default("OPEN"), // OPEN | LOCKED | CLOSED
    lockedUntil: date("locked_until"),
    lockedBy: uuid("locked_by").references(() => users.id, { onDelete: "set null" }),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    unlockReason: text("unlock_reason"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: uuid("closed_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    uniqueIndex("uq_periods_fy_num").on(t.fiscalYearId, t.periodNumber),
    index("idx_periods_org").on(t.organizationId, t.fiscalYearId),
  ]
);

export const costCenters = pgTable(
  "cost_centers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    code: varchar("code", { length: 32 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    type: varchar("type", { length: 32 }).notNull().default("DEPARTMENT"), // DEPARTMENT | BRANCH | PROJECT | PRODUCT_LINE | GENERAL
    isActive: boolean("is_active").notNull().default(true),
    version: integer("version").notNull().default(1),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("uq_cost_centers_org_code").on(t.organizationId, t.code)]
);

export const accountingPolicies = pgTable(
  "accounting_policies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    defaultTaxRate: numeric("default_tax_rate", { precision: 8, scale: 2 }).notNull().default("10.00"),
    isTaxInclusive: boolean("is_tax_inclusive").notNull().default(false),
    invoicePrefix: varchar("invoice_prefix", { length: 24 }).notNull().default("SI-"),
    lowStockAlertEnabled: boolean("low_stock_alert_enabled").notNull().default(true),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("uq_accounting_policies_org").on(t.organizationId)]
);

export const branches = pgTable(
  "branches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    code: varchar("code", { length: 32 }).notNull(),
    name: varchar("name", { length: 140 }).notNull(),
    address: text("address"),
    phone: varchar("phone", { length: 40 }),
    isDefault: boolean("is_default").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    version: integer("version").notNull().default(1),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("uq_branches_org_code").on(t.organizationId, t.code)]
);

export const journalEntries = pgTable(
  "journal_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    fiscalYearId: uuid("fiscal_year_id")
      .notNull()
      .references(() => fiscalYears.id, { onDelete: "restrict" }),
    accountingPeriodId: uuid("accounting_period_id")
      .notNull()
      .references(() => accountingPeriods.id, { onDelete: "restrict" }),
    clientDocumentId: uuid("client_document_id"),
    entryNumber: integer("entry_number").notNull(),
    entryDate: date("entry_date").notNull(),
    description: text("description").notNull(),
    referenceType: varchar("reference_type", { length: 48 }).notNull().default("MANUAL"), // MANUAL | SALES_INVOICE | PURCHASE_INVOICE | TREASURY | REVERSAL | OPENING
    referenceId: uuid("reference_id"),
    reversedEntryId: uuid("reversed_entry_id"),
    status: varchar("status", { length: 20 }).notNull().default("DRAFT"), // DRAFT | POSTED | REVERSED
    totalDebit: numeric("total_debit", { precision: 18, scale: 2 }).notNull().default("0.00"),
    totalCredit: numeric("total_credit", { precision: 18, scale: 2 }).notNull().default("0.00"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    postedBy: uuid("posted_by").references(() => users.id, { onDelete: "set null" }),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    syncSeq: bigint("sync_seq", { mode: "number" }).notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uq_journal_org_fy_num").on(t.organizationId, t.fiscalYearId, t.entryNumber),
    index("idx_journal_org_date").on(t.organizationId, t.entryDate),
  ]
);

export const journalEntryLines = pgTable(
  "journal_entry_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    journalEntryId: uuid("journal_entry_id")
      .notNull()
      .references(() => journalEntries.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    costCenterId: uuid("cost_center_id").references(() => costCenters.id, { onDelete: "set null" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    lineOrder: integer("line_order").notNull().default(1),
    description: text("description"),
    debit: numeric("debit", { precision: 18, scale: 2 }).notNull().default("0.00"),
    credit: numeric("credit", { precision: 18, scale: 2 }).notNull().default("0.00"),
  },
  (t) => [
    index("idx_jlines_org_entry").on(t.organizationId, t.journalEntryId),
    index("idx_jlines_org_account").on(t.organizationId, t.accountId),
  ]
);

export const openingBalances = pgTable(
  "opening_balances",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    fiscalYearId: uuid("fiscal_year_id")
      .notNull()
      .references(() => fiscalYears.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    debit: numeric("debit", { precision: 18, scale: 2 }).notNull().default("0.00"),
    credit: numeric("credit", { precision: 18, scale: 2 }).notNull().default("0.00"),
  },
  (t) => [uniqueIndex("uq_opening_fy_acc").on(t.fiscalYearId, t.accountId)]
);

// ============================================================================
// 6. INVENTORY MODULE (STOCK LEDGER AS SOURCE OF TRUTH)
// ============================================================================

export const warehouses = pgTable(
  "warehouses",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    code: varchar("code", { length: 32 }).notNull(),
    name: varchar("name", { length: 140 }).notNull(),
    address: text("address"),
    isDefault: boolean("is_default").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    version: integer("version").notNull().default(1),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("uq_warehouses_org_code").on(t.organizationId, t.code)]
);

export const stockDocuments = pgTable(
  "stock_documents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "restrict" }),
    clientDocumentId: uuid("client_document_id"),
    documentNumber: varchar("document_number", { length: 48 }).notNull(),
    documentType: varchar("document_type", { length: 32 }).notNull(), // RECEIPT | ISSUE | TRANSFER_OUT | TRANSFER_IN | ADJUSTMENT | OPENING
    documentDate: date("document_date").notNull(),
    referenceNumber: varchar("reference_number", { length: 64 }),
    reason: varchar("reason", { length: 200 }).notNull(),
    referenceType: varchar("reference_type", { length: 48 }),
    referenceId: uuid("reference_id"),
    supplierId: uuid("supplier_id").references(() => contacts.id, { onDelete: "set null" }),
    supplierInvoiceNumber: varchar("supplier_invoice_number", { length: 80 }),
    shippingCost: numeric("shipping_cost", { precision: 18, scale: 2 }).notNull().default("0.00"),
    customsAndExtraCost: numeric("customs_and_extra_cost", { precision: 18, scale: 2 }).notNull().default("0.00"),
    supplierDiscount: numeric("supplier_discount", { precision: 18, scale: 2 }).notNull().default("0.00"),
    totalAcquisitionCost: numeric("total_acquisition_cost", { precision: 18, scale: 2 }).notNull().default("0.00"),
    paymentBankAccountId: uuid("payment_bank_account_id"),
    paidAmount: numeric("paid_amount", { precision: 18, scale: 2 }).notNull().default("0.00"),
    remainingPayable: numeric("remaining_payable", { precision: 18, scale: 2 }).notNull().default("0.00"),
    attachmentUrl: text("attachment_url"),
    journalEntryId: uuid("journal_entry_id").references(() => journalEntries.id, { onDelete: "set null" }),
    status: varchar("status", { length: 24 }).notNull().default("POSTED"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uq_stock_docs_org_num").on(t.organizationId, t.documentNumber),
    index("idx_stock_docs_org").on(t.organizationId, t.warehouseId),
  ]
);

export const stockDocumentItems = pgTable(
  "stock_document_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    stockDocumentId: uuid("stock_document_id")
      .notNull()
      .references(() => stockDocuments.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    variantId: uuid("variant_id"),
    quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull(),
    unitCost: numeric("unit_cost", { precision: 18, scale: 4 }).notNull().default("0.0000"),
    totalCost: numeric("total_cost", { precision: 18, scale: 2 }).notNull().default("0.00"),
  },
  (t) => [index("idx_stock_doc_items_org").on(t.organizationId, t.stockDocumentId)]
);

export const stockLedger = pgTable(
  "stock_ledger",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    stockDocumentId: uuid("stock_document_id")
      .notNull()
      .references(() => stockDocuments.id, { onDelete: "restrict" }),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "restrict" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    variantId: uuid("variant_id"),
    movementType: varchar("movement_type", { length: 16 }).notNull(), // IN | OUT
    reason: varchar("reason", { length: 160 }).notNull(),
    quantityDelta: numeric("quantity_delta", { precision: 18, scale: 4 }).notNull(), // positive for IN, negative for OUT
    unitCost: numeric("unit_cost", { precision: 18, scale: 4 }).notNull().default("0.0000"),
    valueDelta: numeric("value_delta", { precision: 18, scale: 2 }).notNull().default("0.00"),
    balanceAfterQty: numeric("balance_after_qty", { precision: 18, scale: 4 }).notNull().default("0.0000"),
    balanceAfterValue: numeric("balance_after_value", { precision: 18, scale: 2 }).notNull().default("0.00"),
    movementDate: date("movement_date").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_stock_ledger_org_prod_wh").on(t.organizationId, t.productId, t.warehouseId, t.createdAt),
    index("idx_stock_ledger_org_date").on(t.organizationId, t.movementDate),
  ]
);

export const stockReservations = pgTable(
  "stock_reservations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull(),
    referenceType: varchar("reference_type", { length: 48 }).notNull(),
    referenceId: uuid("reference_id"),
    status: varchar("status", { length: 24 }).notNull().default("ACTIVE"), // ACTIVE | RELEASED | CONSUMED
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_stock_res_org").on(t.organizationId, t.productId)]
);

export const stockCounts = pgTable(
  "stock_counts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "restrict" }),
    countNumber: varchar("count_number", { length: 48 }).notNull(),
    countDate: date("count_date").notNull(),
    notes: text("notes"),
    adjustmentDocumentId: uuid("adjustment_document_id").references(() => stockDocuments.id, {
      onDelete: "set null",
    }),
    status: varchar("status", { length: 24 }).notNull().default("APPROVED"), // DRAFT | APPROVED
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("uq_stock_counts_org_num").on(t.organizationId, t.countNumber)]
);

export const stockCountItems = pgTable(
  "stock_count_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    stockCountId: uuid("stock_count_id")
      .notNull()
      .references(() => stockCounts.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    variantId: uuid("variant_id"),
    systemQty: numeric("system_qty", { precision: 18, scale: 4 }).notNull(),
    countedQty: numeric("counted_qty", { precision: 18, scale: 4 }).notNull(),
    varianceQty: numeric("variance_qty", { precision: 18, scale: 4 }).notNull(),
  },
  (t) => [index("idx_stock_count_items_org").on(t.organizationId, t.stockCountId)]
);

export const stockTransfers = pgTable(
  "stock_transfers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    transferNumber: varchar("transfer_number", { length: 48 }).notNull(),
    sourceWarehouseId: uuid("source_warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "restrict" }),
    targetWarehouseId: uuid("target_warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "restrict" }),
    productId: uuid("product_id").references(() => products.id, { onDelete: "restrict" }),
    quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull().default("0.0000"),
    unitCost: numeric("unit_cost", { precision: 18, scale: 4 }).notNull().default("0.0000"),
    reason: varchar("reason", { length: 240 }),
    sourceResponsibleName: varchar("source_responsible_name", { length: 140 }),
    destinationResponsibleName: varchar("destination_responsible_name", { length: 140 }),
    outDocumentId: uuid("out_document_id").references(() => stockDocuments.id, { onDelete: "set null" }),
    inDocumentId: uuid("in_document_id").references(() => stockDocuments.id, { onDelete: "set null" }),
    transferDate: date("transfer_date").notNull(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    notes: text("notes"),
    // DRAFT | SUBMITTED | IN_TRANSIT | PARTIALLY_RECEIVED | RECEIVED | DISCREPANCY_REPORTED | COMPLETED | CANCELLED
    status: varchar("status", { length: 32 }).notNull().default("COMPLETED"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("uq_stock_transfers_org_num").on(t.organizationId, t.transferNumber)]
);

// Master Prompt 08 §2.4 — Multi-Item Transfer Lines with Independent Partial Receipt & Discrepancy Tracking
export const stockTransferItems = pgTable(
  "stock_transfer_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    stockTransferId: uuid("stock_transfer_id")
      .notNull()
      .references(() => stockTransfers.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    variantId: uuid("variant_id"),
    quantitySent: numeric("quantity_sent", { precision: 18, scale: 4 }).notNull(),
    quantityAccepted: numeric("quantity_accepted", { precision: 18, scale: 4 }).notNull().default("0.0000"),
    quantityMissing: numeric("quantity_missing", { precision: 18, scale: 4 }).notNull().default("0.0000"),
    quantityDamaged: numeric("quantity_damaged", { precision: 18, scale: 4 }).notNull().default("0.0000"),
    quantityRejected: numeric("quantity_rejected", { precision: 18, scale: 4 }).notNull().default("0.0000"),
    unitCost: numeric("unit_cost", { precision: 18, scale: 4 }).notNull().default("0.0000"),
    discrepancyType: varchar("discrepancy_type", { length: 32 }), // MISSING | DAMAGED | WRONG_ITEM | QUALITY_REJECTED | OTHER
    discrepancyNote: text("discrepancy_note"),
    evidenceUrl: text("evidence_url"),
    evidenceAttachmentIds: jsonb("evidence_attachment_ids").$type<string[]>().notNull().default([]),
    itemStatus: varchar("item_status", { length: 32 }).notNull().default("PENDING"), // PENDING | IN_TRANSIT | ACCEPTED | PARTIAL | DISCREPANCY
  },
  (t) => [index("idx_transfer_items_org").on(t.organizationId, t.stockTransferId)]
);

// ============================================================================
// 7. PURCHASING & SALES MODULES
// ============================================================================

export const purchaseOrders = pgTable(
  "purchase_orders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "restrict" }),
    warehouseId: uuid("warehouse_id").references(() => warehouses.id, { onDelete: "set null" }),
    orderNumber: varchar("order_number", { length: 48 }).notNull(),
    orderDate: date("order_date").notNull(),
    expectedDeliveryDate: date("expected_delivery_date"),
    totalAmount: numeric("total_amount", { precision: 18, scale: 2 }).notNull().default("0.00"),
    status: varchar("status", { length: 24 }).notNull().default("OPEN"), // OPEN | CONFIRMED | RECEIVED | CANCELLED
    sourceSuggestionId: uuid("source_suggestion_id"),
    notes: text("notes"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("uq_po_org_num").on(t.organizationId, t.orderNumber)]
);

export const purchaseOrderItems = pgTable(
  "purchase_order_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    purchaseOrderId: uuid("purchase_order_id")
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    variantId: uuid("variant_id"),
    quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull(),
    receivedQuantity: numeric("received_quantity", { precision: 18, scale: 4 }).notNull().default("0.0000"),
    unitPrice: numeric("unit_price", { precision: 18, scale: 2 }).notNull().default("0.00"),
    lineTotal: numeric("line_total", { precision: 18, scale: 2 }).notNull().default("0.00"),
  },
  (t) => [index("idx_po_items_org").on(t.organizationId, t.purchaseOrderId)]
);

export const purchaseInvoices = pgTable(
  "purchase_invoices",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    clientDocumentId: uuid("client_document_id"),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "restrict" }),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "restrict" }),
    invoiceNumber: varchar("invoice_number", { length: 48 }).notNull(),
    invoiceDate: date("invoice_date").notNull(),
    dueDate: date("due_date"),
    currency: varchar("currency", { length: 10 }).notNull().default("IRR"),
    exchangeRate: numeric("exchange_rate", { precision: 18, scale: 4 }).notNull().default("1.0000"),
    subtotal: numeric("subtotal", { precision: 18, scale: 2 }).notNull().default("0.00"),
    taxAmount: numeric("tax_amount", { precision: 18, scale: 2 }).notNull().default("0.00"),
    discountAmount: numeric("discount_amount", { precision: 18, scale: 2 }).notNull().default("0.00"),
    shippingCost: numeric("shipping_cost", { precision: 18, scale: 2 }).notNull().default("0.00"),
    otherCosts: numeric("other_costs", { precision: 18, scale: 2 }).notNull().default("0.00"),
    roundingAdjustment: numeric("rounding_adjustment", { precision: 18, scale: 2 }).notNull().default("0.00"),
    totalAmount: numeric("total_amount", { precision: 18, scale: 2 }).notNull().default("0.00"),
    paidAmount: numeric("paid_amount", { precision: 18, scale: 2 }).notNull().default("0.00"),
    remainingAmount: numeric("remaining_amount", { precision: 18, scale: 2 }).notNull().default("0.00"),
    status: varchar("status", { length: 24 }).notNull().default("DRAFT"), // DRAFT | CONFIRMED | FINALIZED | CANCELLED | RETURNED | PARTIALLY_RETURNED
    relatedDocumentId: uuid("related_document_id"),
    relatedDocumentType: varchar("related_document_type", { length: 40 }),
    cancellationReason: text("cancellation_reason"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    receiptUrl: text("receipt_url"),
    taxRateSnapshot: numeric("tax_rate_snapshot", { precision: 8, scale: 2 }),
    isTaxInclusiveSnapshot: boolean("is_tax_inclusive_snapshot"),
    stockDocumentId: uuid("stock_document_id").references(() => stockDocuments.id, { onDelete: "set null" }),
    journalEntryId: uuid("journal_entry_id").references(() => journalEntries.id, { onDelete: "set null" }),
    notes: text("notes"),
    version: integer("version").notNull().default(1),
    syncSeq: bigint("sync_seq", { mode: "number" }).notNull().default(1),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("uq_purchase_inv_org_num").on(t.organizationId, t.invoiceNumber)]
);

export const purchaseInvoiceItems = pgTable(
  "purchase_invoice_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    purchaseInvoiceId: uuid("purchase_invoice_id")
      .notNull()
      .references(() => purchaseInvoices.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    variantId: uuid("variant_id"),
    quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull(),
    unitPrice: numeric("unit_price", { precision: 18, scale: 2 }).notNull(),
    discountAmount: numeric("discount_amount", { precision: 18, scale: 2 }).notNull().default("0.00"),
    taxRate: numeric("tax_rate", { precision: 8, scale: 2 }).notNull().default("0.00"),
    taxAmount: numeric("tax_amount", { precision: 18, scale: 2 }).notNull().default("0.00"),
    lineTotal: numeric("line_total", { precision: 18, scale: 2 }).notNull(),
  },
  (t) => [index("idx_purchase_items_org").on(t.organizationId, t.purchaseInvoiceId)]
);

export const purchaseReturns = pgTable(
  "purchase_returns",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    purchaseInvoiceId: uuid("purchase_invoice_id")
      .notNull()
      .references(() => purchaseInvoices.id, { onDelete: "restrict" }),
    returnNumber: varchar("return_number", { length: 48 }).notNull(),
    returnDate: date("return_date").notNull(),
    totalAmount: numeric("total_amount", { precision: 18, scale: 2 }).notNull().default("0.00"),
    reason: text("reason"),
    stockDocumentId: uuid("stock_document_id").references(() => stockDocuments.id, { onDelete: "set null" }),
    journalEntryId: uuid("journal_entry_id").references(() => journalEntries.id, { onDelete: "set null" }),
    idempotencyKey: varchar("idempotency_key", { length: 128 }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("uq_purchase_ret_org_num").on(t.organizationId, t.returnNumber)]
);

export const purchaseReturnItems = pgTable(
  "purchase_return_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    purchaseReturnId: uuid("purchase_return_id")
      .notNull()
      .references(() => purchaseReturns.id, { onDelete: "cascade" }),
    originalItemId: uuid("original_item_id")
      .notNull()
      .references(() => purchaseInvoiceItems.id, { onDelete: "restrict" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    variantId: uuid("variant_id"),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "restrict" }),
    quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull(),
    unitPrice: numeric("unit_price", { precision: 18, scale: 2 }).notNull(),
    lineTotal: numeric("line_total", { precision: 18, scale: 2 }).notNull(),
    reason: text("reason"),
  },
  (t) => [index("idx_purchase_ret_items_org").on(t.organizationId, t.purchaseReturnId, t.originalItemId)]
);

export const salesOrders = pgTable(
  "sales_orders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "restrict" }),
    orderNumber: varchar("order_number", { length: 48 }).notNull(),
    orderDate: date("order_date").notNull(),
    totalAmount: numeric("total_amount", { precision: 18, scale: 2 }).notNull().default("0.00"),
    status: varchar("status", { length: 24 }).notNull().default("OPEN"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("uq_so_org_num").on(t.organizationId, t.orderNumber)]
);

export const salesInvoices = pgTable(
  "sales_invoices",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    clientDocumentId: uuid("client_document_id"),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "restrict" }),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "restrict" }),
    invoiceNumber: varchar("invoice_number", { length: 48 }).notNull(),
    invoiceDate: date("invoice_date").notNull(),
    dueDate: date("due_date"),
    currency: varchar("currency", { length: 10 }).notNull().default("IRR"),
    exchangeRate: numeric("exchange_rate", { precision: 18, scale: 4 }).notNull().default("1.0000"),
    subtotal: numeric("subtotal", { precision: 18, scale: 2 }).notNull().default("0.00"),
    taxAmount: numeric("tax_amount", { precision: 18, scale: 2 }).notNull().default("0.00"),
    discountAmount: numeric("discount_amount", { precision: 18, scale: 2 }).notNull().default("0.00"),
    shippingCost: numeric("shipping_cost", { precision: 18, scale: 2 }).notNull().default("0.00"),
    otherCosts: numeric("other_costs", { precision: 18, scale: 2 }).notNull().default("0.00"),
    roundingAdjustment: numeric("rounding_adjustment", { precision: 18, scale: 2 }).notNull().default("0.00"),
    totalAmount: numeric("total_amount", { precision: 18, scale: 2 }).notNull().default("0.00"),
    paidAmount: numeric("paid_amount", { precision: 18, scale: 2 }).notNull().default("0.00"),
    remainingAmount: numeric("remaining_amount", { precision: 18, scale: 2 }).notNull().default("0.00"),
    status: varchar("status", { length: 24 }).notNull().default("DRAFT"), // DRAFT | CONFIRMED | FINALIZED | CANCELLED | RETURNED
    paymentStatus: varchar("payment_status", { length: 24 }).notNull().default("UNPAID"), // UNPAID | PARTIALLY_PAID | PAID | OVERPAID | REFUNDED
    accountingStatus: varchar("accounting_status", { length: 24 }).notNull().default("PENDING_POSTING"), // PENDING_POSTING | POSTED | REVERSED
    stockStatus: varchar("stock_status", { length: 24 }).notNull().default("PENDING"), // NOT_APPLICABLE | PENDING | RESERVED | ISSUED | REVERSED
    syncStatus: varchar("sync_status", { length: 24 }).notNull().default("SYNCED"), // PENDING | SYNCING | SYNCED | FAILED | CONFLICT
    creditLimitOverridden: boolean("credit_limit_overridden").notNull().default(false),
    quotationId: uuid("quotation_id"),
    relatedDocumentId: uuid("related_document_id"),
    relatedDocumentType: varchar("related_document_type", { length: 40 }),
    cancellationReason: text("cancellation_reason"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    receiptUrl: text("receipt_url"),
    taxRateSnapshot: numeric("tax_rate_snapshot", { precision: 8, scale: 2 }),
    isTaxInclusiveSnapshot: boolean("is_tax_inclusive_snapshot"),
    stockDocumentId: uuid("stock_document_id").references(() => stockDocuments.id, { onDelete: "set null" }),
    journalEntryId: uuid("journal_entry_id").references(() => journalEntries.id, { onDelete: "set null" }),
    notes: text("notes"),
    version: integer("version").notNull().default(1),
    syncSeq: bigint("sync_seq", { mode: "number" }).notNull().default(1),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("uq_sales_inv_org_num").on(t.organizationId, t.invoiceNumber)]
);

export const salesInvoiceItems = pgTable(
  "sales_invoice_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    salesInvoiceId: uuid("sales_invoice_id")
      .notNull()
      .references(() => salesInvoices.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    variantId: uuid("variant_id"),
    quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull(),
    unitPrice: numeric("unit_price", { precision: 18, scale: 2 }).notNull(),
    discountAmount: numeric("discount_amount", { precision: 18, scale: 2 }).notNull().default("0.00"),
    taxRate: numeric("tax_rate", { precision: 8, scale: 2 }).notNull().default("0.00"),
    taxAmount: numeric("tax_amount", { precision: 18, scale: 2 }).notNull().default("0.00"),
    lineTotal: numeric("line_total", { precision: 18, scale: 2 }).notNull(),
    description: text("description"),
  },
  (t) => [index("idx_sales_items_org").on(t.organizationId, t.salesInvoiceId)]
);

export const salesReturns = pgTable(
  "sales_returns",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    salesInvoiceId: uuid("sales_invoice_id")
      .notNull()
      .references(() => salesInvoices.id, { onDelete: "restrict" }),
    returnNumber: varchar("return_number", { length: 48 }).notNull(),
    returnDate: date("return_date").notNull(),
    totalAmount: numeric("total_amount", { precision: 18, scale: 2 }).notNull().default("0.00"),
    reason: text("reason"),
    stockDocumentId: uuid("stock_document_id").references(() => stockDocuments.id, { onDelete: "set null" }),
    journalEntryId: uuid("journal_entry_id").references(() => journalEntries.id, { onDelete: "set null" }),
    idempotencyKey: varchar("idempotency_key", { length: 128 }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("uq_sales_ret_org_num").on(t.organizationId, t.returnNumber)]
);

export const salesReturnItems = pgTable(
  "sales_return_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    salesReturnId: uuid("sales_return_id")
      .notNull()
      .references(() => salesReturns.id, { onDelete: "cascade" }),
    originalItemId: uuid("original_item_id")
      .notNull()
      .references(() => salesInvoiceItems.id, { onDelete: "restrict" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    variantId: uuid("variant_id"),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "restrict" }),
    quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull(),
    acceptedQuantity: numeric("accepted_quantity", { precision: 18, scale: 4 }).notNull().default("0.0000"),
    damagedQuantity: numeric("damaged_quantity", { precision: 18, scale: 4 }).notNull().default("0.0000"),
    physicallyReceived: boolean("physically_received").notNull().default(true),
    unitPrice: numeric("unit_price", { precision: 18, scale: 2 }).notNull(),
    lineTotal: numeric("line_total", { precision: 18, scale: 2 }).notNull(),
    reason: text("reason"),
  },
  (t) => [index("idx_sales_ret_items_org").on(t.organizationId, t.salesReturnId, t.originalItemId)]
);

// ============================================================================
// 8. TREASURY, CHEQUES & CONSIGNMENT MODULES
// ============================================================================

export const financialAccounts = pgTable(
  "financial_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").references(() => accounts.id, { onDelete: "set null" }),
    name: varchar("name", { length: 140 }).notNull(),
    accountType: varchar("account_type", { length: 24 }).notNull().default("BANK"), // BANK | CASHBOX | POS
    bankName: varchar("bank_name", { length: 100 }),
    accountNumber: varchar("account_number", { length: 64 }),
    iban: varchar("iban", { length: 40 }),
    currency: varchar("currency", { length: 10 }).notNull().default("IRR"),
    openingBalance: numeric("opening_balance", { precision: 18, scale: 2 }).notNull().default("0.00"),
    balance: numeric("balance", { precision: 18, scale: 2 }).notNull().default("0.00"),
    isActive: boolean("is_active").notNull().default(true),
    version: integer("version").notNull().default(1),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_fin_accounts_org").on(t.organizationId)]
);

export const cashboxes = pgTable(
  "cashboxes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    financialAccountId: uuid("financial_account_id")
      .notNull()
      .references(() => financialAccounts.id, { onDelete: "cascade" }),
    cashierUserId: uuid("cashier_user_id").references(() => users.id, { onDelete: "set null" }),
    location: varchar("location", { length: 120 }),
  },
  (t) => [index("idx_cashboxes_org").on(t.organizationId)]
);

export const financialTransactions = pgTable(
  "financial_transactions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    financialAccountId: uuid("financial_account_id")
      .notNull()
      .references(() => financialAccounts.id, { onDelete: "restrict" }),
    destinationAccountId: uuid("destination_account_id").references(() => financialAccounts.id, { onDelete: "set null" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    txType: varchar("tx_type", { length: 24 }).notNull(), // RECEIPT | PAYMENT | TRANSFER | EXPENSE | INCOME
    paymentMethod: varchar("payment_method", { length: 24 }).notNull().default("BANK_TRANSFER"), // CASH | BANK_TRANSFER | CARD | CHEQUE | OTHER
    currency: varchar("currency", { length: 10 }).notNull().default("IRR"),
    amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
    txDate: date("tx_date").notNull(),
    trackingNumber: varchar("tracking_number", { length: 80 }),
    relatedDocumentType: varchar("related_document_type", { length: 48 }),
    relatedDocumentId: uuid("related_document_id"),
    status: varchar("status", { length: 24 }).notNull().default("CONFIRMED"), // CONFIRMED | CANCELLED
    description: text("description"),
    journalEntryId: uuid("journal_entry_id").references(() => journalEntries.id, { onDelete: "set null" }),
    version: integer("version").notNull().default(1),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_fin_tx_org_date").on(t.organizationId, t.txDate)]
);

export const bankReconciliations = pgTable(
  "bank_reconciliations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    financialAccountId: uuid("financial_account_id")
      .notNull()
      .references(() => financialAccounts.id, { onDelete: "cascade" }),
    statementDate: date("statement_date").notNull(),
    statementBalance: numeric("statement_balance", { precision: 18, scale: 2 }).notNull(),
    bookBalance: numeric("book_balance", { precision: 18, scale: 2 }).notNull(),
    difference: numeric("difference", { precision: 18, scale: 2 }).notNull().default("0.00"),
    status: varchar("status", { length: 24 }).notNull().default("RECONCILED"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_bank_rec_org").on(t.organizationId)]
);

export const cheques = pgTable(
  "cheques",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    financialAccountId: uuid("financial_account_id").references(() => financialAccounts.id, {
      onDelete: "set null",
    }),
    chequeType: varchar("cheque_type", { length: 20 }).notNull(), // RECEIVABLE | PAYABLE
    sayadId: varchar("sayad_id", { length: 32 }).notNull(),
    serialNumber: varchar("serial_number", { length: 48 }).notNull(),
    bankName: varchar("bank_name", { length: 100 }).notNull(),
    branchName: varchar("branch_name", { length: 100 }),
    accountNumber: varchar("account_number", { length: 64 }),
    drawerName: varchar("drawer_name", { length: 140 }),
    recipientName: varchar("recipient_name", { length: 140 }),
    amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
    issueDate: date("issue_date").notNull(),
    dueDate: date("due_date").notNull(),
    relatedDocumentType: varchar("related_document_type", { length: 48 }),
    relatedDocumentId: uuid("related_document_id"),
    journalEntryId: uuid("journal_entry_id").references(() => journalEntries.id, { onDelete: "set null" }),
    status: varchar("status", { length: 24 }).notNull().default("RECEIVED"), // RECEIVED | ISSUED | ENDORSED | DEPOSITED | CASHED | BOUNCED | CANCELLED
    notes: text("notes"),
    version: integer("version").notNull().default(1),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uq_cheques_org_sayad").on(t.organizationId, t.sayadId),
    index("idx_cheques_org_due").on(t.organizationId, t.dueDate),
  ]
);

export const chequeEvents = pgTable(
  "cheque_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    chequeId: uuid("cheque_id")
      .notNull()
      .references(() => cheques.id, { onDelete: "cascade" }),
    fromStatus: varchar("from_status", { length: 24 }),
    toStatus: varchar("to_status", { length: 24 }).notNull(),
    eventDate: date("event_date").notNull(),
    note: text("note"),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_cheque_events_org").on(t.organizationId, t.chequeId)]
);

export const chequeAssignments = pgTable(
  "cheque_assignments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    chequeId: uuid("cheque_id")
      .notNull()
      .references(() => cheques.id, { onDelete: "cascade" }),
    assignedToContactId: uuid("assigned_to_contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "restrict" }),
    assignedDate: date("assigned_date").notNull(),
    notes: text("notes"),
  },
  (t) => [index("idx_cheque_assign_org").on(t.organizationId, t.chequeId)]
);

export const consignmentDocuments = pgTable(
  "consignment_documents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "restrict" }),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "restrict" }),
    documentNumber: varchar("document_number", { length: 48 }).notNull(),
    documentType: varchar("document_type", { length: 32 }).notNull().default("CONSIGNMENT_IN"), // CONSIGNMENT_IN | CONSIGNMENT_OUT | CONSIGNMENT_SALE | CONSIGNMENT_RETURN
    direction: varchar("direction", { length: 16 }).notNull().default("IN"), // IN | OUT
    ownershipScope: varchar("ownership_scope", { length: 24 }).notNull().default("THIRD_PARTY_HELD"), // THIRD_PARTY_HELD | OWNED_AT_AGENT
    relatedDocumentId: uuid("related_document_id"),
    relatedDocumentType: varchar("related_document_type", { length: 40 }),
    documentDate: date("document_date").notNull(),
    commissionRate: numeric("commission_rate", { precision: 8, scale: 2 }).notNull().default("10.00"),
    totalValue: numeric("total_value", { precision: 18, scale: 2 }).notNull().default("0.00"),
    status: varchar("status", { length: 24 }).notNull().default("DRAFT"), // DRAFT | OPEN | CONFIRMED | SETTLED | CANCELLED
    cancellationReason: text("cancellation_reason"),
    receiptUrl: text("receipt_url"),
    journalEntryId: uuid("journal_entry_id").references(() => journalEntries.id, { onDelete: "set null" }),
    notes: text("notes"),
    version: integer("version").notNull().default(1),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("uq_consign_org_num").on(t.organizationId, t.documentNumber)]
);

export const consignmentItems = pgTable(
  "consignment_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    consignmentDocumentId: uuid("consignment_document_id")
      .notNull()
      .references(() => consignmentDocuments.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    variantId: uuid("variant_id"),
    warehouseId: uuid("warehouse_id").references(() => warehouses.id, { onDelete: "set null" }),
    quantityReceived: numeric("quantity_received", { precision: 18, scale: 4 }).notNull(),
    quantitySold: numeric("quantity_sold", { precision: 18, scale: 4 }).notNull().default("0.0000"),
    quantityReturned: numeric("quantity_returned", { precision: 18, scale: 4 }).notNull().default("0.0000"),
    agreedUnitPrice: numeric("agreed_unit_price", { precision: 18, scale: 2 }).notNull(),
  },
  (t) => [index("idx_consign_items_org").on(t.organizationId, t.consignmentDocumentId)]
);

// Master Prompt 07 §5 — Independent Consignment Ledger (Strictly separate from Owned Stock Ledger!)
export const consignmentLedger = pgTable(
  "consignment_ledger",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    consignmentDocumentId: uuid("consignment_document_id")
      .notNull()
      .references(() => consignmentDocuments.id, { onDelete: "restrict" }),
    rootAgreementId: uuid("root_agreement_id").notNull(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "restrict" }),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "restrict" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    variantId: uuid("variant_id"),
    ownershipScope: varchar("ownership_scope", { length: 24 }).notNull(), // THIRD_PARTY_HELD | OWNED_AT_AGENT
    eventType: varchar("event_type", { length: 32 }).notNull(), // CONSIGNMENT_IN | CONSIGNMENT_OUT | CONSIGNMENT_SALE | CONSIGNMENT_RETURN
    quantityDelta: numeric("quantity_delta", { precision: 18, scale: 4 }).notNull(),
    agreedUnitPrice: numeric("agreed_unit_price", { precision: 18, scale: 2 }).notNull(),
    eventDate: date("event_date").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_consign_ledger_org_owner").on(t.organizationId, t.ownershipScope, t.productId),
    index("idx_consign_ledger_root").on(t.organizationId, t.rootAgreementId),
  ]
);

export const consignorSettlements = pgTable(
  "consignor_settlements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    consignmentDocumentId: uuid("consignment_document_id")
      .notNull()
      .references(() => consignmentDocuments.id, { onDelete: "restrict" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "restrict" }),
    settlementDate: date("settlement_date").notNull(),
    grossSales: numeric("gross_sales", { precision: 18, scale: 2 }).notNull(),
    commissionAmount: numeric("commission_amount", { precision: 18, scale: 2 }).notNull(),
    netPayable: numeric("net_payable", { precision: 18, scale: 2 }).notNull(),
    status: varchar("status", { length: 24 }).notNull().default("PAID"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_consign_settle_org").on(t.organizationId)]
);

// ============================================================================
// 9. SUBSCRIPTIONS, ENTITLEMENTS & CAFEBAZAAR PAYMENTS
// ============================================================================

export const plans = pgTable(
  "plans",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    code: varchar("code", { length: 48 }).notNull(),
    nameFa: varchar("name_fa", { length: 120 }).notNull(),
    description: text("description"),
    cafebazaarSku: varchar("cafebazaar_sku", { length: 96 }),
    priceIrr: numeric("price_irr", { precision: 18, scale: 2 }).notNull().default("0.00"),
    billingDays: integer("billing_days").notNull().default(30),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("uq_plans_code").on(t.code)]
);

export const features = pgTable(
  "features",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    code: varchar("code", { length: 64 }).notNull(),
    nameFa: varchar("name_fa", { length: 140 }).notNull(),
    valueType: varchar("value_type", { length: 24 }).notNull().default("BOOLEAN"), // BOOLEAN | LIMIT
    description: text("description"),
  },
  (t) => [uniqueIndex("uq_features_code").on(t.code)]
);

export const planFeatures = pgTable(
  "plan_features",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    planId: uuid("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "cascade" }),
    featureId: uuid("feature_id")
      .notNull()
      .references(() => features.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(true),
    limitValue: integer("limit_value"),
  },
  (t) => [uniqueIndex("uq_plan_feature").on(t.planId, t.featureId)]
);

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "restrict" }),
    status: varchar("status", { length: 24 }).notNull().default("ACTIVE"), // TRIAL | ACTIVE | EXPIRED | CANCELLED
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    autoRenew: boolean("auto_renew").notNull().default(false),
    source: varchar("source", { length: 32 }).notNull().default("ADMIN"), // ADMIN | CAFEBAZAAR | TRIAL
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_subscriptions_org").on(t.organizationId, t.status)]
);

export const entitlements = pgTable(
  "entitlements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    featureCode: varchar("feature_code", { length: 64 }).notNull(),
    enabled: boolean("enabled").notNull().default(true),
    limitValue: integer("limit_value"),
    source: varchar("source", { length: 32 }).notNull().default("PLAN"), // PLAN | OVERRIDE
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("uq_entitlements_org_feat").on(t.organizationId, t.featureCode)]
);

export const paymentTransactions = pgTable(
  "payment_transactions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    subscriptionId: uuid("subscription_id").references(() => subscriptions.id, { onDelete: "set null" }),
    planId: uuid("plan_id").references(() => plans.id, { onDelete: "set null" }),
    provider: varchar("provider", { length: 32 }).notNull().default("CAFEBAZAAR"),
    amountIrr: numeric("amount_irr", { precision: 18, scale: 2 }).notNull(),
    currency: varchar("currency", { length: 10 }).notNull().default("IRR"),
    status: varchar("status", { length: 24 }).notNull().default("VERIFIED"), // PENDING | VERIFIED | FAILED | REFUNDED
    idempotencyKey: varchar("idempotency_key", { length: 128 }),
    externalRef: varchar("external_ref", { length: 160 }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_payments_org").on(t.organizationId)]
);

export const purchaseReceipts = pgTable(
  "purchase_receipts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    paymentTransactionId: uuid("payment_transaction_id").references(() => paymentTransactions.id, {
      onDelete: "set null",
    }),
    provider: varchar("provider", { length: 32 }).notNull().default("CAFEBAZAAR"),
    packageName: varchar("package_name", { length: 160 }).notNull(),
    sku: varchar("sku", { length: 96 }).notNull(),
    purchaseToken: varchar("purchase_token", { length: 256 }).notNull(),
    verificationStatus: varchar("verification_status", { length: 24 }).notNull(), // VALID | INVALID | REPLAYED
    rawResponse: jsonb("raw_response").$type<Record<string, unknown>>().notNull().default({}),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("uq_receipts_provider_token").on(t.provider, t.purchaseToken)]
);

// ============================================================================
// 10. OFFLINE SYNCHRONIZATION ENGINE
// ============================================================================

export const syncBatches = pgTable(
  "sync_batches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    clientBatchId: varchar("client_batch_id", { length: 128 }).notNull(),
    eventsCount: integer("events_count").notNull().default(0),
    appliedCount: integer("applied_count").notNull().default(0),
    conflictCount: integer("conflict_count").notNull().default(0),
    rejectedCount: integer("rejected_count").notNull().default(0),
    status: varchar("status", { length: 24 }).notNull().default("COMPLETED"), // PROCESSING | COMPLETED | PARTIAL | FAILED
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("uq_sync_batches_dev_client").on(t.deviceId, t.clientBatchId)]
);

export const syncEvents = pgTable(
  "sync_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => syncBatches.id, { onDelete: "cascade" }),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    clientEventId: varchar("client_event_id", { length: 128 }).notNull(),
    entityType: varchar("entity_type", { length: 48 }).notNull(),
    entityId: uuid("entity_id"),
    operation: varchar("operation", { length: 24 }).notNull(), // CREATE | UPDATE | SOFT_DELETE
    baseVersion: integer("base_version").notNull().default(0),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: varchar("status", { length: 24 }).notNull().default("APPLIED"), // APPLIED | CONFLICT | REJECTED
    errorMessage: text("error_message"),
    processedAt: timestamp("processed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_sync_events_org_batch").on(t.organizationId, t.batchId)]
);

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
    key: varchar("key", { length: 160 }).notNull(),
    endpoint: varchar("endpoint", { length: 160 }).notNull(),
    requestHash: varchar("request_hash", { length: 128 }).notNull(),
    statusCode: integer("status_code").notNull(),
    responseBody: jsonb("response_body").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex("uq_idempotency_org_key").on(t.organizationId, t.key)]
);

export const syncConflicts = pgTable(
  "sync_conflicts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    entityType: varchar("entity_type", { length: 48 }).notNull(),
    entityId: uuid("entity_id").notNull(),
    conflictType: varchar("conflict_type", { length: 40 }).notNull().default("VERSION_MISMATCH"), // VERSION_MISMATCH | STOCK_SHORTAGE | FINANCIAL_IMMUTABLE | PAYMENT_MISMATCH | DEPENDENCY_MISSING
    clientVersion: integer("client_version").notNull(),
    serverVersion: integer("server_version").notNull(),
    clientPayload: jsonb("client_payload").$type<Record<string, unknown>>().notNull(),
    serverPayload: jsonb("server_payload").$type<Record<string, unknown>>().notNull(),
    conflictingFields: jsonb("conflicting_fields").$type<string[]>().notNull().default([]),
    status: varchar("status", { length: 24 }).notNull().default("OPEN"), // OPEN | RESOLVED
    resolutionStrategy: varchar("resolution_strategy", { length: 24 }), // USE_SERVER | USE_LOCAL | MERGE | RECREATE_AS_NEW
    resolvedBy: uuid("resolved_by").references(() => users.id, { onDelete: "set null" }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_sync_conflicts_org_status").on(t.organizationId, t.status)]
);

export const syncCheckpoints = pgTable(
  "sync_checkpoints",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    checkpointSeq: bigint("checkpoint_seq", { mode: "number" }).notNull().default(0),
    cursor: text("cursor"),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("uq_sync_checkpoint_dev").on(t.organizationId, t.deviceId)]
);

// Master Prompt 04 §7 — Sync Inbox & Per-Event Idempotency
export const syncInbox = pgTable(
  "sync_inbox",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    eventId: varchar("event_id", { length: 128 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull(),
    entityType: varchar("entity_type", { length: 48 }).notNull(),
    entityId: uuid("entity_id"),
    operation: varchar("operation", { length: 24 }).notNull(),
    payloadHash: varchar("payload_hash", { length: 128 }).notNull(),
    resultStatus: varchar("result_status", { length: 24 }).notNull(), // ACCEPTED | CONFIRMED | REJECTED | CONFLICT | DUPLICATE
    resultPayload: jsonb("result_payload").$type<Record<string, unknown>>().notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uq_sync_inbox_org_idem").on(t.organizationId, t.idempotencyKey),
    index("idx_sync_inbox_org_event").on(t.organizationId, t.eventId),
  ]
);

// Master Prompt 04 §10 — Stable Monotonic Ordered Change Log for Opaque Cursor Pull & Tombstones
export const syncChangeLog = pgTable(
  "sync_change_log",
  {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    changeId: uuid("change_id").defaultRandom().notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    entityType: varchar("entity_type", { length: 48 }).notNull(),
    entityId: uuid("entity_id").notNull(),
    operation: varchar("operation", { length: 16 }).notNull().default("UPSERT"), // UPSERT | TOMBSTONE
    version: integer("version").notNull().default(1),
    sourceDeviceId: uuid("source_device_id").references(() => devices.id, { onDelete: "set null" }),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uq_sync_changelog_id").on(t.changeId),
    index("idx_sync_changelog_org_seq").on(t.organizationId, t.seq),
    index("idx_sync_changelog_org_type_seq").on(t.organizationId, t.entityType, t.seq),
  ]
);

// Master Prompt 04 §21 — Sync Monitoring & Telemetry (Zero Sensitive Payloads)
export const syncLogs = pgTable(
  "sync_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    direction: varchar("direction", { length: 16 }).notNull().default("PUSH"), // PUSH | PULL
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }).notNull(),
    pushCount: integer("push_count").notNull().default(0),
    pullCount: integer("pull_count").notNull().default(0),
    successCount: integer("success_count").notNull().default(0),
    failureCount: integer("failure_count").notNull().default(0),
    conflictCount: integer("conflict_count").notNull().default(0),
    cursorBefore: text("cursor_before"),
    cursorAfter: text("cursor_after"),
    errorCode: varchar("error_code", { length: 64 }),
    durationMs: integer("duration_ms").notNull().default(0),
  },
  (t) => [index("idx_sync_logs_org_started").on(t.organizationId, t.startedAt)]
);

// ============================================================================
// 11. AUDIT, ERRORS, NOTIFICATIONS, FILES, SUPPORT & SETTINGS
// ============================================================================

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "set null" }),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorEmail: varchar("actor_email", { length: 180 }),
    scope: varchar("scope", { length: 20 }).notNull().default("ORGANIZATION"), // PLATFORM | ORGANIZATION | SECURITY
    action: varchar("action", { length: 96 }).notNull(),
    entityType: varchar("entity_type", { length: 64 }).notNull(),
    entityId: varchar("entity_id", { length: 128 }),
    ipAddress: varchar("ip_address", { length: 64 }),
    severity: varchar("severity", { length: 16 }).notNull().default("INFO"), // INFO | WARN | CRITICAL
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_audit_org_created").on(t.organizationId, t.createdAt),
    index("idx_audit_scope_created").on(t.scope, t.createdAt),
  ]
);

export const systemErrorLogs = pgTable(
  "system_error_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "set null" }),
    source: varchar("source", { length: 48 }).notNull().default("API"), // API | SYNC | PAYMENT | ACCOUNTING
    errorCode: varchar("error_code", { length: 64 }).notNull(),
    message: text("message").notNull(),
    endpoint: varchar("endpoint", { length: 180 }),
    stackTrace: text("stack_trace"),
    status: varchar("status", { length: 24 }).notNull().default("OPEN"), // OPEN | INVESTIGATING | RESOLVED
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_error_logs_status").on(t.status, t.createdAt)]
);

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    category: varchar("category", { length: 32 }).notNull().default("SYSTEM"),
    title: varchar("title", { length: 180 }).notNull(),
    body: text("body").notNull(),
    isRead: boolean("is_read").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_notifications_user").on(t.userId, t.isRead)]
);

export const files = pgTable(
  "files",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    uploadedBy: uuid("uploaded_by").references(() => users.id, { onDelete: "set null" }),
    entityType: varchar("entity_type", { length: 48 }),
    entityId: uuid("entity_id"),
    fileName: varchar("file_name", { length: 200 }).notNull(),
    mimeType: varchar("mime_type", { length: 100 }).notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    storageKey: varchar("storage_key", { length: 255 }).notNull(),
    uploadStatus: varchar("upload_status", { length: 24 }).notNull().default("PENDING"), // PENDING | COMPLETED
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_files_org").on(t.organizationId)]
);

export const userInvitations = pgTable(
  "user_invitations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    inviteeName: varchar("invitee_name", { length: 160 }),
    email: varchar("email", { length: 180 }).notNull(),
    mobile: varchar("mobile", { length: 32 }),
    roleId: uuid("role_id").references(() => roles.id, { onDelete: "set null" }),
    token: varchar("token", { length: 128 }),
    branchAccess: jsonb("branch_access").$type<string[]>().notNull().default(["ALL"]),
    warehouseAccess: jsonb("warehouse_access").$type<string[]>().notNull().default(["ALL"]),
    message: text("message"),
    invitedBy: uuid("invited_by").references(() => users.id, { onDelete: "set null" }),
    status: varchar("status", { length: 24 }).notNull().default("PENDING"), // PENDING | ACCEPTED | EXPIRED | REVOKED | REJECTED
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_invitations_org").on(t.organizationId),
    uniqueIndex("uq_invitations_token").on(t.token),
  ]
);

export const supportTicketDepartments = pgTable(
  "support_ticket_departments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    code: varchar("code", { length: 48 }).notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    description: varchar("description", { length: 300 }),
    isActive: boolean("is_active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("uq_support_ticket_departments_code").on(t.code), index("idx_support_ticket_departments_active_order").on(t.isActive, t.sortOrder)]
);

export const supportTickets = pgTable(
  "support_tickets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "set null" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    ticketNumber: varchar("ticket_number", { length: 32 }).notNull(),
    subject: varchar("subject", { length: 200 }).notNull(),
    description: text("description").notNull(),
    departmentId: uuid("department_id").references(() => supportTicketDepartments.id, { onDelete: "set null" }),
    assignedToUserId: uuid("assigned_to_user_id").references(() => users.id, { onDelete: "set null" }),
    priority: varchar("priority", { length: 20 }).notNull().default("MEDIUM"), // LOW | MEDIUM | HIGH | URGENT
    status: varchar("status", { length: 24 }).notNull().default("OPEN"), // OPEN | IN_PROGRESS | WAITING_CUSTOMER | WAITING_AGENT | RESOLVED | CLOSED
    resolutionNote: text("resolution_note"),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).defaultNow().notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uq_tickets_number").on(t.ticketNumber),
    index("idx_support_tickets_org_activity").on(t.organizationId, t.lastActivityAt),
    index("idx_support_tickets_status_activity").on(t.status, t.lastActivityAt),
    index("idx_support_tickets_department_activity").on(t.departmentId, t.lastActivityAt),
  ]
);

export const supportTicketMessages = pgTable(
  "support_ticket_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "set null" }),
    ticketId: uuid("ticket_id").notNull().references(() => supportTickets.id, { onDelete: "cascade" }),
    senderUserId: uuid("sender_user_id").references(() => users.id, { onDelete: "set null" }),
    senderType: varchar("sender_type", { length: 16 }).notNull(), // CUSTOMER | ADMIN
    senderName: varchar("sender_name", { length: 200 }).notNull(),
    body: text("body").notNull(),
    isInternal: boolean("is_internal").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_support_ticket_messages_ticket_created").on(t.ticketId, t.createdAt)]
);

export const supportTicketEvents = pgTable(
  "support_ticket_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "set null" }),
    ticketId: uuid("ticket_id").notNull().references(() => supportTickets.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorName: varchar("actor_name", { length: 200 }).notNull(),
    eventType: varchar("event_type", { length: 48 }).notNull(),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_support_ticket_events_ticket_created").on(t.ticketId, t.createdAt)]
);

export const platformSettings = pgTable(
  "platform_settings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    key: varchar("key", { length: 96 }).notNull(),
    category: varchar("category", { length: 48 }).notNull().default("GENERAL"),
    labelFa: varchar("label_fa", { length: 160 }).notNull(),
    value: jsonb("value").$type<unknown>().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("uq_platform_settings_key").on(t.key)]
);

// ============================================================================
// 12. MASTER PROMPT 05 — PERSONAL FINANCE MODULE (DEDICATED PERSONAL LEDGER)
// ============================================================================

export const personalFinanceProfiles = pgTable(
  "personal_finance_profiles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    currency: varchar("currency", { length: 10 }).notNull().default("IRR"),
    monthlyBudgetLimit: numeric("monthly_budget_limit", { precision: 18, scale: 2 }).notNull().default("50000000.00"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("uq_pf_profile_org_user").on(t.organizationId, t.ownerUserId)]
);

export const personalAccounts = pgTable(
  "personal_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    profileId: uuid("profile_id")
      .notNull()
      .references(() => personalFinanceProfiles.id, { onDelete: "cascade" }),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 140 }).notNull(),
    accountType: varchar("account_type", { length: 24 }).notNull().default("CASH"), // CASH | BANK | SAVINGS | CREDIT
    bankName: varchar("bank_name", { length: 100 }),
    currency: varchar("currency", { length: 10 }).notNull().default("IRR"),
    balance: numeric("balance", { precision: 18, scale: 2 }).notNull().default("0.00"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_pf_accounts_org_owner").on(t.organizationId, t.ownerUserId)]
);

export const personalExpenseCategories = pgTable(
  "personal_expense_categories",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id"),
    code: varchar("code", { length: 48 }).notNull(),
    nameFa: varchar("name_fa", { length: 120 }).notNull(),
    icon: varchar("icon", { length: 40 }).notNull().default("wallet"),
    color: varchar("color", { length: 24 }).notNull().default("#4f46e5"),
    monthlyBudgetLimit: numeric("monthly_budget_limit", { precision: 18, scale: 2 }).notNull().default("0.00"),
    isDefault: boolean("is_default").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("uq_pf_cat_org_code").on(t.organizationId, t.code)]
);

export const ownerWithdrawals = pgTable(
  "owner_withdrawals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    businessFinancialAccountId: uuid("business_financial_account_id")
      .notNull()
      .references(() => financialAccounts.id, { onDelete: "restrict" }),
    amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
    currency: varchar("currency", { length: 10 }).notNull().default("IRR"),
    withdrawalDate: date("withdrawal_date").notNull(),
    journalEntryId: uuid("journal_entry_id").references(() => journalEntries.id, { onDelete: "set null" }),
    idempotencyKey: varchar("idempotency_key", { length: 128 }),
    status: varchar("status", { length: 24 }).notNull().default("CONFIRMED"), // DRAFT | CONFIRMED | REVERSED
    notes: text("notes"),
    version: integer("version").notNull().default(1),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_owner_withdrawals_org").on(t.organizationId, t.ownerUserId)]
);

export const ownerContributions = pgTable(
  "owner_contributions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    businessFinancialAccountId: uuid("business_financial_account_id")
      .notNull()
      .references(() => financialAccounts.id, { onDelete: "restrict" }),
    amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
    currency: varchar("currency", { length: 10 }).notNull().default("IRR"),
    contributionDate: date("contribution_date").notNull(),
    journalEntryId: uuid("journal_entry_id").references(() => journalEntries.id, { onDelete: "set null" }),
    status: varchar("status", { length: 24 }).notNull().default("CONFIRMED"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_owner_contrib_org").on(t.organizationId, t.ownerUserId)]
);

export const personalTransactions = pgTable(
  "personal_transactions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    profileId: uuid("profile_id")
      .notNull()
      .references(() => personalFinanceProfiles.id, { onDelete: "cascade" }),
    personalAccountId: uuid("personal_account_id").references(() => personalAccounts.id, { onDelete: "set null" }),
    categoryId: uuid("category_id").references(() => personalExpenseCategories.id, { onDelete: "set null" }),
    linkedWithdrawalId: uuid("linked_withdrawal_id").references(() => ownerWithdrawals.id, { onDelete: "set null" }),
    txType: varchar("tx_type", { length: 32 }).notNull(), // PERSONAL_EXPENSE | PERSONAL_INCOME | WITHDRAWAL_FROM_BUSINESS | OWNER_CONTRIBUTION | PERSONAL_TRANSFER | LOAN_PAYMENT | LOAN_RECEIPT | SAVINGS | DEBT_SETTLEMENT | RECURRING_PAYMENT | REFUND
    paymentSource: varchar("payment_source", { length: 24 }).notNull().default("PERSONAL_CASH"), // PERSONAL_CASH | PERSONAL_BANK | BUSINESS_CASH | BUSINESS_BANK | CREDIT | OTHER
    title: varchar("title", { length: 180 }).notNull(),
    amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
    currency: varchar("currency", { length: 10 }).notNull().default("IRR"),
    txDate: date("tx_date").notNull(),
    notes: text("notes"),
    idempotencyKey: varchar("idempotency_key", { length: 128 }),
    status: varchar("status", { length: 24 }).notNull().default("CONFIRMED"), // DRAFT | CONFIRMED | REVERSED
    version: integer("version").notNull().default(1),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_pf_tx_org_owner").on(t.organizationId, t.ownerUserId, t.txDate)]
);

export const personalRecurringTransactions = pgTable(
  "personal_recurring_transactions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id").references(() => personalExpenseCategories.id, { onDelete: "set null" }),
    title: varchar("title", { length: 180 }).notNull(),
    amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
    currency: varchar("currency", { length: 10 }).notNull().default("IRR"),
    frequency: varchar("frequency", { length: 24 }).notNull().default("MONTHLY"), // DAILY | WEEKLY | MONTHLY | QUARTERLY | ANNUALLY | CUSTOM
    startDate: date("start_date").notNull(),
    endDate: date("end_date"),
    nextDueDate: date("next_due_date").notNull(),
    paymentSource: varchar("payment_source", { length: 24 }).notNull().default("BUSINESS_BANK"),
    reminderDaysBefore: integer("reminder_days_before").notNull().default(3),
    autoGenerate: boolean("auto_generate").notNull().default(false),
    obligationStatus: varchar("obligation_status", { length: 24 }).notNull().default("DUE"), // EXPECTED | DUE | PAID | OVERDUE | CANCELLED
    lastPaidAt: timestamp("last_paid_at", { withTimezone: true }),
    lastTransactionId: uuid("last_transaction_id"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_pf_recurring_org_owner").on(t.organizationId, t.ownerUserId)]
);

// ============================================================================
// 13. MIXED INVOICE PAYMENT ALLOCATIONS & QUOTATIONS (PROFORMA)
// ============================================================================

export const invoicePaymentAllocations = pgTable(
  "invoice_payment_allocations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    salesInvoiceId: uuid("sales_invoice_id")
      .notNull()
      .references(() => salesInvoices.id, { onDelete: "cascade" }),
    financialAccountId: uuid("financial_account_id").references(() => financialAccounts.id, { onDelete: "set null" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    chequeId: uuid("cheque_id").references(() => cheques.id, { onDelete: "set null" }),
    paymentMethod: varchar("payment_method", { length: 24 }).notNull(), // CASH | BANK | CARD_TERMINAL | POS | WALLET | CHEQUE | CREDIT | ACCOUNT_BALANCE | OTHER
    amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
    paidAt: date("paid_at").notNull(),
    referenceNumber: varchar("reference_number", { length: 80 }),
    journalEntryId: uuid("journal_entry_id").references(() => journalEntries.id, { onDelete: "set null" }),
    idempotencyKey: varchar("idempotency_key", { length: 128 }),
    status: varchar("status", { length: 24 }).notNull().default("CONFIRMED"), // CONFIRMED | REVERSED
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_inv_pay_alloc_org_inv").on(t.organizationId, t.salesInvoiceId),
    uniqueIndex("uq_inv_pay_alloc_org_idem").on(t.organizationId, t.idempotencyKey),
  ]
);

export const quotations = pgTable(
  "quotations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "restrict" }),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "restrict" }),
    quotationNumber: varchar("quotation_number", { length: 48 }).notNull(),
    issueDate: date("issue_date").notNull(),
    validUntil: date("valid_until").notNull(),
    subtotal: numeric("subtotal", { precision: 18, scale: 2 }).notNull().default("0.00"),
    discountTotal: numeric("discount_total", { precision: 18, scale: 2 }).notNull().default("0.00"),
    taxTotal: numeric("tax_total", { precision: 18, scale: 2 }).notNull().default("0.00"),
    grandTotal: numeric("grand_total", { precision: 18, scale: 2 }).notNull().default("0.00"),
    terms: text("terms"),
    status: varchar("status", { length: 24 }).notNull().default("DRAFT"), // DRAFT | SENT | ACCEPTED | CONVERTED | EXPIRED
    convertedInvoiceId: uuid("converted_invoice_id").references(() => salesInvoices.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("uq_quotations_org_num").on(t.organizationId, t.quotationNumber)]
);

export const quotationItems = pgTable(
  "quotation_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    quotationId: uuid("quotation_id")
      .notNull()
      .references(() => quotations.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    variantId: uuid("variant_id"),
    quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull(),
    unitPrice: numeric("unit_price", { precision: 18, scale: 2 }).notNull(),
    discountAmount: numeric("discount_amount", { precision: 18, scale: 2 }).notNull().default("0.00"),
    taxAmount: numeric("tax_amount", { precision: 18, scale: 2 }).notNull().default("0.00"),
    lineTotal: numeric("line_total", { precision: 18, scale: 2 }).notNull(),
  },
  (t) => [index("idx_quotation_items_org").on(t.organizationId, t.quotationId)]
);

// ============================================================================
// 14. QUICK EXPENSE & INCOME + AUTOMATIC ACCOUNT MAPPING
// ============================================================================

export const accountingCategories = pgTable(
  "accounting_categories",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 16 }).notNull(), // EXPENSE | INCOME
    scope: varchar("scope", { length: 16 }).notNull().default("BUSINESS"), // BUSINESS | PERSONAL
    code: varchar("code", { length: 48 }).notNull(),
    nameFa: varchar("name_fa", { length: 120 }).notNull(),
    icon: varchar("icon", { length: 40 }).notNull().default("receipt"),
    color: varchar("color", { length: 24 }).notNull().default("#0f766e"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("uq_acc_cat_org_code").on(t.organizationId, t.code)]
);

export const categoryAccountMappings = pgTable(
  "category_account_mappings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => accountingCategories.id, { onDelete: "cascade" }),
    debitAccountId: uuid("debit_account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    creditAccountId: uuid("credit_account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    taxAccountId: uuid("tax_account_id").references(() => accounts.id, { onDelete: "set null" }),
    isActive: boolean("is_active").notNull().default(true),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("uq_cat_mapping_org_cat").on(t.organizationId, t.categoryId)]
);

export const quickTransactions = pgTable(
  "quick_transactions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 16 }).notNull(), // EXPENSE | INCOME
    scope: varchar("scope", { length: 16 }).notNull().default("BUSINESS"), // BUSINESS | PERSONAL
    categoryId: uuid("category_id")
      .notNull()
      .references(() => accountingCategories.id, { onDelete: "restrict" }),
    financialAccountId: uuid("financial_account_id")
      .notNull()
      .references(() => financialAccounts.id, { onDelete: "restrict" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    costCenterId: uuid("cost_center_id").references(() => costCenters.id, { onDelete: "set null" }),
    warehouseId: uuid("warehouse_id").references(() => warehouses.id, { onDelete: "set null" }),
    title: varchar("title", { length: 180 }).notNull(),
    amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
    taxAmount: numeric("tax_amount", { precision: 18, scale: 2 }).notNull().default("0.00"),
    txDate: date("tx_date").notNull(),
    paymentMethod: varchar("payment_method", { length: 24 }).notNull().default("BANK_TRANSFER"),
    description: text("description"),
    receiptUrl: text("receipt_url"),
    status: varchar("status", { length: 24 }).notNull().default("CONFIRMED"), // DRAFT | CONFIRMED | REVERSED
    journalEntryId: uuid("journal_entry_id").references(() => journalEntries.id, { onDelete: "set null" }),
    idempotencyKey: varchar("idempotency_key", { length: 128 }),
    version: integer("version").notNull().default(1),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_quick_tx_org_date").on(t.organizationId, t.txDate),
    uniqueIndex("uq_quick_tx_org_idem").on(t.organizationId, t.idempotencyKey),
  ]
);

// ============================================================================
// 15. PRODUCT VARIANTS, WAREHOUSE THRESHOLDS & SMART REPLENISHMENT
// ============================================================================

export const productVariants = pgTable(
  "product_variants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    sku: varchar("sku", { length: 64 }).notNull(),
    barcode: varchar("barcode", { length: 96 }),
    variantName: varchar("variant_name", { length: 160 }).notNull(),
    attributes: jsonb("attributes").$type<Record<string, string>>().notNull().default({}),
    purchasePrice: numeric("purchase_price", { precision: 18, scale: 2 }).notNull().default("0.00"),
    salePrice: numeric("sale_price", { precision: 18, scale: 2 }).notNull().default("0.00"),
    minStockLevel: numeric("min_stock_level", { precision: 18, scale: 4 }).notNull().default("0.0000"),
    isActive: boolean("is_active").notNull().default(true),
    version: integer("version").notNull().default(1),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uq_variants_org_sku").on(t.organizationId, t.sku),
    index("idx_variants_org_prod").on(t.organizationId, t.productId),
  ]
);

export const warehouseStockThresholds = pgTable(
  "warehouse_stock_thresholds",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    variantId: uuid("variant_id").references(() => productVariants.id, { onDelete: "cascade" }),
    minStock: numeric("min_stock", { precision: 18, scale: 4 }).notNull().default("10.0000"),
    safetyStock: numeric("safety_stock", { precision: 18, scale: 4 }).notNull().default("4.0000"),
    leadTimeDays: integer("lead_time_days").notNull().default(5),
    avgDailyDemand: numeric("avg_daily_demand", { precision: 18, scale: 4 }).notNull().default("2.0000"),
    supplierMoq: numeric("supplier_moq", { precision: 18, scale: 4 }).notNull().default("1.0000"),
    preferredSupplierId: uuid("preferred_supplier_id").references(() => contacts.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_wh_thresholds_org").on(t.organizationId, t.warehouseId, t.productId)]
);

export const purchaseSuggestions = pgTable(
  "purchase_suggestions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    variantId: uuid("variant_id").references(() => productVariants.id, { onDelete: "set null" }),
    preferredSupplierId: uuid("preferred_supplier_id").references(() => contacts.id, { onDelete: "set null" }),
    onHandQty: numeric("on_hand_qty", { precision: 18, scale: 4 }).notNull(),
    reservedQty: numeric("reserved_qty", { precision: 18, scale: 4 }).notNull().default("0.0000"),
    availableQty: numeric("available_qty", { precision: 18, scale: 4 }).notNull(),
    incomingPoQty: numeric("incoming_po_qty", { precision: 18, scale: 4 }).notNull().default("0.0000"),
    reorderPoint: numeric("reorder_point", { precision: 18, scale: 4 }).notNull(),
    recommendedQty: numeric("recommended_qty", { precision: 18, scale: 4 }).notNull(),
    stockoutRisk: varchar("stockout_risk", { length: 16 }).notNull().default("MEDIUM"), // LOW | MEDIUM | HIGH | CRITICAL
    reasonFa: text("reason_fa").notNull(),
    status: varchar("status", { length: 24 }).notNull().default("PENDING"), // PENDING | ACCEPTED | REJECTED | CONVERTED
    convertedPoId: uuid("converted_po_id").references(() => purchaseOrders.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_purchase_sugg_org").on(t.organizationId, t.status)]
);

// ============================================================================
// 16. CRM LOYALTY LEDGER, EMPLOYEES & REPORT EXPORT JOBS
// ============================================================================

export const loyaltyAccounts = pgTable(
  "loyalty_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    tier: varchar("tier", { length: 24 }).notNull().default("BRONZE"), // BRONZE | SILVER | GOLD | VIP
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("uq_loyalty_org_contact").on(t.organizationId, t.contactId)]
);

export const loyaltyTransactions = pgTable(
  "loyalty_transactions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    loyaltyAccountId: uuid("loyalty_account_id")
      .notNull()
      .references(() => loyaltyAccounts.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    txType: varchar("tx_type", { length: 24 }).notNull(), // EARN | REDEEM | ADJUST | EXPIRE | REFERRAL
    pointsDelta: integer("points_delta").notNull(),
    referenceType: varchar("reference_type", { length: 48 }),
    referenceId: uuid("reference_id"),
    description: text("description"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_loyalty_tx_org_contact").on(t.organizationId, t.contactId)]
);

export const employees = pgTable(
  "employees",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    employeeCode: varchar("employee_code", { length: 40 }).notNull(),
    fullName: varchar("full_name", { length: 160 }).notNull(),
    mobile: varchar("mobile", { length: 32 }),
    email: varchar("email", { length: 180 }),
    roleId: uuid("role_id").references(() => roles.id, { onDelete: "set null" }),
    branchName: varchar("branch_name", { length: 120 }).default("شعبه مرکزی"),
    allowedWarehouseIds: jsonb("allowed_warehouse_ids").$type<string[]>().notNull().default([]),
    employmentStatus: varchar("employment_status", { length: 24 }).notNull().default("ACTIVE"), // ACTIVE | INACTIVE
    hireDate: date("hire_date").notNull(),
    notes: text("notes"),
    version: integer("version").notNull().default(1),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("uq_employees_org_code").on(t.organizationId, t.employeeCode)]
);

export const reportExportJobs = pgTable(
  "report_export_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
    reportType: varchar("report_type", { length: 48 }).notNull(), // JOURNAL_BOOK | TRIAL_BALANCE | PERSONAL_FINANCE | INVENTORY
    format: varchar("format", { length: 16 }).notNull(), // XLSX | CSV | PDF
    fileName: varchar("file_name", { length: 180 }).notNull(),
    rowCount: integer("row_count").notNull().default(0),
    status: varchar("status", { length: 24 }).notNull().default("COMPLETED"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_report_jobs_org").on(t.organizationId)]
);

// ============================================================================
// 17. MASTER PROMPT 06 — ACCOUNT CLOSURES & FISCAL YEAR CLOSING LIFECYCLE
// ============================================================================

export const accountClosures = pgTable(
  "account_closures",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    actionType: varchar("action_type", { length: 24 }).notNull().default("CLOSE_ONLY"), // SETTLE | TRANSFER | ADJUST | CLOSE_ONLY
    destinationAccountId: uuid("destination_account_id").references(() => accounts.id, { onDelete: "set null" }),
    closingBalance: numeric("closing_balance", { precision: 18, scale: 2 }).notNull().default("0.00"),
    transferJournalId: uuid("transfer_journal_id").references(() => journalEntries.id, { onDelete: "set null" }),
    reason: text("reason").notNull(),
    closedBy: uuid("closed_by").references(() => users.id, { onDelete: "set null" }),
    closedAt: timestamp("closed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_account_closures_org").on(t.organizationId, t.accountId)]
);

export const fiscalYearClosings = pgTable(
  "fiscal_year_closings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    fiscalYearId: uuid("fiscal_year_id")
      .notNull()
      .references(() => fiscalYears.id, { onDelete: "restrict" }),
    retainedEarningsAccountId: uuid("retained_earnings_account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    closingJournalId: uuid("closing_journal_id").references(() => journalEntries.id, { onDelete: "set null" }),
    netProfitOrLoss: numeric("net_profit_or_loss", { precision: 18, scale: 2 }).notNull().default("0.00"),
    checklistSnapshot: jsonb("checklist_snapshot").$type<Record<string, unknown>>().notNull().default({}),
    carryForwardSnapshot: jsonb("carry_forward_snapshot").$type<Array<Record<string, unknown>>>().notNull().default([]),
    status: varchar("status", { length: 24 }).notNull().default("POSTED"), // DRAFT | PREVIEWED | PENDING_APPROVAL | APPROVED | POSTED | REVERSED
    approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_fy_closings_org").on(t.organizationId, t.fiscalYearId)]
);

// ============================================================================
// 18. SAAS PUBLIC CMS (ACADEMY TUTORIALS), CONTACT INQUIRIES, SMS & OTP
// ============================================================================

export const academyArticles = pgTable(
  "academy_articles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    slug: varchar("slug", { length: 180 }).notNull(),
    title: varchar("title", { length: 240 }).notNull(),
    excerpt: text("excerpt").notNull(),
    contentHtml: text("content_html").notNull(),
    coverImageUrl: text("cover_image_url"),
    category: varchar("category", { length: 64 }).notNull().default("حسابداری"),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    readingMinutes: integer("reading_minutes").notNull().default(5),
    viewCount: integer("view_count").notNull().default(0),
    isFeatured: boolean("is_featured").notNull().default(false),
    status: varchar("status", { length: 24 }).notNull().default("PUBLISHED"), // DRAFT | PUBLISHED | ARCHIVED
    authorName: varchar("author_name", { length: 120 }).notNull().default("تیم آموزش Business OS"),
    authorUserId: uuid("author_user_id").references(() => users.id, { onDelete: "set null" }),
    publishedAt: timestamp("published_at", { withTimezone: true }).defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uq_academy_slug").on(t.slug),
    index("idx_academy_status_cat").on(t.status, t.category),
  ]
);

export const contactInquiries = pgTable(
  "contact_inquiries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    fullName: varchar("full_name", { length: 160 }).notNull(),
    email: varchar("email", { length: 180 }),
    mobile: varchar("mobile", { length: 32 }).notNull(),
    companyName: varchar("company_name", { length: 160 }),
    subject: varchar("subject", { length: 200 }).notNull(),
    message: text("message").notNull(),
    status: varchar("status", { length: 24 }).notNull().default("NEW"), // NEW | REVIEWED | REPLIED | ARCHIVED
    adminNote: text("admin_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_contact_inquiries_status").on(t.status, t.createdAt)]
);

export const smsSettings = pgTable(
  "sms_settings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: varchar("provider", { length: 24 }).notNull(), // SMS_IR | KAVENEGAR
    isActive: boolean("is_active").notNull().default(false),
    isDefault: boolean("is_default").notNull().default(false),
    sandboxMode: boolean("sandbox_mode").notNull().default(true),
    apiKey: text("api_key").notNull().default(""),
    lineNumber: varchar("line_number", { length: 48 }).notNull().default(""),
    otpTemplateId: varchar("otp_template_id", { length: 80 }).notNull().default(""), // sms.ir templateId OR kavenegar lookup template name
    invoiceTemplateId: varchar("invoice_template_id", { length: 80 }).notNull().default(""),
    chequeTemplateId: varchar("cheque_template_id", { length: 80 }).notNull().default(""),
    extraConfig: jsonb("extra_config").$type<Record<string, unknown>>().notNull().default({}),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("uq_sms_settings_provider").on(t.provider)]
);

export const smsLogs = pgTable(
  "sms_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "set null" }),
    provider: varchar("provider", { length: 24 }).notNull(), // SMS_IR | KAVENEGAR
    purpose: varchar("purpose", { length: 32 }).notNull().default("OTP"), // OTP | PASSWORD_RESET | TEST | INVITATION | NOTIFICATION
    recipientMobile: varchar("recipient_mobile", { length: 32 }).notNull(),
    messagePreview: varchar("message_preview", { length: 240 }).notNull(),
    status: varchar("status", { length: 24 }).notNull().default("SENT"), // SENT | SANDBOX_SENT | FAILED
    providerMessageId: varchar("provider_message_id", { length: 120 }),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_sms_logs_created").on(t.createdAt)]
);

export const otpCodes = pgTable(
  "otp_codes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    mobile: varchar("mobile", { length: 32 }).notNull(),
    purpose: varchar("purpose", { length: 32 }).notNull(), // VERIFY_MOBILE | RESET_PASSWORD | LOGIN_OTP
    codeHash: varchar("code_hash", { length: 128 }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_otp_mobile_purpose").on(t.mobile, t.purpose, t.createdAt)]
);

// ============================================================================
// 19. MASTER PROMPT 08 — OFFLINE_ONLY OPERATING MODE, CLOUD MIGRATION & 4 PAYMENT GATEWAYS
// ============================================================================

export const organizationOperatingModes = pgTable(
  "organization_operating_modes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    deviceId: uuid("device_id").references(() => devices.id, { onDelete: "set null" }),
    mode: varchar("mode", { length: 24 }).notNull().default("CLOUD_SYNC"), // CLOUD_SYNC | OFFLINE_ONLY
    agreementAccepted: boolean("agreement_accepted").notNull().default(false),
    agreementVersion: varchar("agreement_version", { length: 48 }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    changedBy: uuid("changed_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("uq_op_mode_org").on(t.organizationId)]
);

export const cloudMigrationSessions = pgTable(
  "cloud_migration_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    initiatedBy: uuid("initiated_by").references(() => users.id, { onDelete: "set null" }),
    idempotencyKey: varchar("idempotency_key", { length: 128 }),
    inventorySummary: jsonb("inventory_summary").$type<Record<string, number>>().notNull().default({}),
    uploadedBatches: integer("uploaded_batches").notNull().default(0),
    appliedRecords: integer("applied_records").notNull().default(0),
    conflictRecords: integer("conflict_records").notNull().default(0),
    duplicateRecords: integer("duplicate_records").notNull().default(0),
    status: varchar("status", { length: 24 }).notNull().default("PREPARING"), // PREPARING | UPLOADING | COMPLETED | FAILED
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [index("idx_cloud_mig_org").on(t.organizationId, t.status)]
);

// Master Prompt 08 §2.15 — Independent Payment Gateway Configs (Zarinpal, Zibal, Balleh Pay, Saman)
export const paymentGatewaySettings = pgTable(
  "payment_gateway_settings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    gateway: varchar("gateway", { length: 24 }).notNull(), // ZARINPAL | ZIBAL | BALLEH_PAY | SAMAN
    displayNameFa: varchar("display_name_fa", { length: 120 }).notNull(),
    isActive: boolean("is_active").notNull().default(true),
    isDefault: boolean("is_default").notNull().default(false),
    priority: integer("priority").notNull().default(10),
    sandboxMode: boolean("sandbox_mode").notNull().default(true),
    merchantId: text("merchant_id").notNull().default(""), // merchant_id (Zarinpal/Zibal) | terminal_id (Saman) | provider_token (Balleh)
    secretToken: text("secret_token").notNull().default(""), // bot_token (Balleh) | optional extra key
    callbackBaseUrl: varchar("callback_base_url", { length: 240 }).notNull().default(""),
    extraConfig: jsonb("extra_config").$type<Record<string, unknown>>().notNull().default({}),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("uq_payment_gateways_code").on(t.gateway)]
);

export const paymentOrders = pgTable(
  "payment_orders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "restrict" }),
    gateway: varchar("gateway", { length: 24 }).notNull(), // ZARINPAL | ZIBAL | BALLEH_PAY | SAMAN
    paymentReference: varchar("payment_reference", { length: 96 }).notNull(),
    gatewayAuthority: varchar("gateway_authority", { length: 160 }),
    gatewayRefId: varchar("gateway_ref_id", { length: 160 }),
    amountIrr: numeric("amount_irr", { precision: 18, scale: 2 }).notNull(),
    currency: varchar("currency", { length: 10 }).notNull().default("IRR"),
    paymentUrl: text("payment_url").notNull(),
    returnDeepLink: varchar("return_deep_link", { length: 240 }).notNull().default("karvexa://payment/result"),
    status: varchar("status", { length: 24 }).notNull().default("PENDING"), // PENDING | VERIFIED | FAILED | CANCELLED | EXPIRED
    idempotencyKey: varchar("idempotency_key", { length: 128 }),
    subscriptionId: uuid("subscription_id").references(() => subscriptions.id, { onDelete: "set null" }),
    paymentTransactionId: uuid("payment_transaction_id").references(() => paymentTransactions.id, { onDelete: "set null" }),
    callbackPayload: jsonb("callback_payload").$type<Record<string, unknown>>().notNull().default({}),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uq_payment_orders_ref").on(t.paymentReference),
    index("idx_payment_orders_org").on(t.organizationId, t.status),
  ]
);

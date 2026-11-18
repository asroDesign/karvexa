import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  accountGroups,
  accounts,
  branches,
  accountingCategories,
  categoryAccountMappings,
  costCenters,
  employees,
  financialAccounts,
  personalTransactions,
  products,
  productVariants,
  quickTransactions,
  syncConflicts,
  warehouses,
} from "@/db/schema";
import { addDec, formatDecimal, subDec } from "@/lib/decimal";
import { ApiError } from "@/lib/errors";
import { hasOrgPermission, loadUserPermissions, withTenantTransaction } from "@/lib/tenant";
import { createJournalEntryTx } from "@/modules/accounting/service";
import {
  confirmConsignmentDocument,
  ConsignmentDocType,
  createConsignmentDocument,
} from "@/modules/consignment/service";
import {
  createOwnerWithdrawal,
  createPersonalTransaction,
} from "@/modules/personal-finance/service";
import { appendSyncChangeLog } from "./changelog";
import type { SyncPushEventInput, SyncPushEventResult } from "./service";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

function diffFields(client: Record<string, unknown>, server: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(client)) {
    if (v === undefined) continue;
    if (String(v ?? "") !== String(server[k] ?? "")) out.push(k);
  }
  return out;
}

/**
 * Master Prompt 07 §12 — Extended Sync Entity Handlers
 * Covers: warehouse, account_code, branch, cost_center, treasury_account,
 * quick_cashflow, personal_transaction, consignment_document, product_variant,
 * employee, owner_withdrawal
 */
export async function processExtendedSyncEntity(params: {
  organizationId: string;
  userId: string;
  userEmail: string;
  ipAddress?: string | null;
  deviceId: string;
  entityType: string;
  operation: string;
  clientUuid: string;
  ev: SyncPushEventInput;
}): Promise<SyncPushEventResult | null> {
  const { organizationId, deviceId, entityType, operation, clientUuid, ev } = params;
  const p = ev.payload ?? {};
  const baseVer = ev.base_version ?? 0;

  // Enforce entity-level RBAC for sensitive domains!
  if (entityType === "personal_transaction" || entityType === "owner_withdrawal") {
    const perms = await loadUserPermissions(params.userId, organizationId, "ORGANIZATION");
    if (!hasOrgPermission(perms, "personal_finance.manage")) {
      throw new ApiError(403, "PERMISSION_DENIED", "مجوز دسترسی به داده‌های مالی شخصی برای این کاربر فعال نیست.");
    }
  }
  if (entityType === "employee") {
    const perms = await loadUserPermissions(params.userId, organizationId, "ORGANIZATION");
    if (!hasOrgPermission(perms, "employees.manage")) {
      throw new ApiError(403, "PERMISSION_DENIED", "مجوز مدیریت پرسنل برای همگام‌سازی employee فعال نیست.");
    }
  }

  // --------------------------------------------------------------------------
  // 1. WAREHOUSE
  // --------------------------------------------------------------------------
  if (entityType === "warehouse") {
    return withTenantTransaction(organizationId, async (tx) => {
      if (operation === "CREATE") {
        const [created] = await tx
          .insert(warehouses)
          .values({
            id: clientUuid,
            organizationId,
            code: String(p.code || `WH-${Date.now().toString().slice(-4)}`),
            name: String(p.name || "انبار جدید"),
            address: p.address ? String(p.address) : null,
            isActive: p.is_active !== false,
            version: 1,
          })
          .returning();
        await appendSyncChangeLog(tx, {
          organizationId,
          entityType: "warehouse",
          entityId: created.id,
          operation: "UPSERT",
          version: created.version,
          sourceDeviceId: deviceId,
          payload: { id: created.id, code: created.code, name: created.name, address: created.address, is_active: created.isActive },
        });
        return { event_id: ev.event_id, entity_id: clientUuid, server_id: created.id, status: "ACCEPTED", entity_version: created.version, business_status: "CONFIRMED", error: null };
      }
      const [srv] = await tx.select().from(warehouses).where(and(eq(warehouses.id, clientUuid), eq(warehouses.organizationId, organizationId))).limit(1);
      if (!srv) throw new ApiError(404, "WAREHOUSE_NOT_FOUND", "انبار یافت نشد.");

      if (operation === "UPDATE") {
        if (srv.version > baseVer) {
          const cf = diffFields({ name: p.name, address: p.address }, { name: srv.name, address: srv.address });
          if (cf.length > 0) {
            const [c] = await tx.insert(syncConflicts).values({
              organizationId, deviceId, entityType: "warehouse", entityId: srv.id,
              conflictType: "VERSION_MISMATCH", clientVersion: baseVer, serverVersion: srv.version,
              clientPayload: p, serverPayload: { name: srv.name, address: srv.address }, conflictingFields: cf, status: "OPEN",
            }).returning();
            return { event_id: ev.event_id, entity_id: srv.id, server_id: srv.id, status: "CONFLICT", entity_version: srv.version, business_status: "CONFLICT", conflict_id: c.id, error: { code: "VERSION_CONFLICT", message: "تعارض نسخه در انبار" } };
          }
        }
        const [upd] = await tx.update(warehouses).set({
          ...(p.name ? { name: String(p.name) } : {}),
          ...(p.address !== undefined ? { address: p.address ? String(p.address) : null } : {}),
          version: srv.version + 1, updatedAt: new Date(),
        }).where(eq(warehouses.id, srv.id)).returning();
        await appendSyncChangeLog(tx, { organizationId, entityType: "warehouse", entityId: upd.id, operation: "UPSERT", version: upd.version, sourceDeviceId: deviceId, payload: { id: upd.id, code: upd.code, name: upd.name } });
        return { event_id: ev.event_id, entity_id: upd.id, server_id: upd.id, status: "ACCEPTED", entity_version: upd.version, business_status: "CONFIRMED", error: null };
      }
      if (operation === "DELETE") {
        const [tomb] = await tx.update(warehouses).set({ isActive: false, deletedAt: new Date(), version: srv.version + 1, updatedAt: new Date() }).where(eq(warehouses.id, srv.id)).returning();
        await appendSyncChangeLog(tx, { organizationId, entityType: "warehouse", entityId: tomb.id, operation: "TOMBSTONE", version: tomb.version, sourceDeviceId: deviceId, payload: { id: tomb.id, is_deleted: true } });
        return { event_id: ev.event_id, entity_id: tomb.id, server_id: tomb.id, status: "ACCEPTED", entity_version: tomb.version, business_status: "CANCELLED", error: null };
      }
      throw new ApiError(422, "UNSUPPORTED_OPERATION", "عملیات نامعتبر برای warehouse");
    });
  }

  // --------------------------------------------------------------------------
  // 2. BRANCH
  // --------------------------------------------------------------------------
  if (entityType === "branch") {
    return withTenantTransaction(organizationId, async (tx) => {
      if (operation === "CREATE") {
        const [created] = await tx.insert(branches).values({
          id: clientUuid, organizationId,
          code: String(p.code || `BR-${Date.now().toString().slice(-4)}`),
          name: String(p.name || "شعبه جدید"),
          address: p.address ? String(p.address) : null,
          phone: p.phone ? String(p.phone) : null,
          isActive: p.is_active !== false,
          version: 1,
        }).returning();
        await appendSyncChangeLog(tx, { organizationId, entityType: "branch", entityId: created.id, operation: "UPSERT", version: created.version, sourceDeviceId: deviceId, payload: { id: created.id, code: created.code, name: created.name } });
        return { event_id: ev.event_id, entity_id: clientUuid, server_id: created.id, status: "ACCEPTED", entity_version: created.version, business_status: "CONFIRMED", error: null };
      }
      const [srv] = await tx.select().from(branches).where(and(eq(branches.id, clientUuid), eq(branches.organizationId, organizationId))).limit(1);
      if (!srv) throw new ApiError(404, "BRANCH_NOT_FOUND", "شعبه یافت نشد.");
      if (operation === "UPDATE") {
        if (srv.version > baseVer) {
          const [c] = await tx.insert(syncConflicts).values({
            organizationId, deviceId, entityType: "branch", entityId: srv.id,
            conflictType: "VERSION_MISMATCH", clientVersion: baseVer, serverVersion: srv.version,
            clientPayload: p, serverPayload: { name: srv.name, address: srv.address }, conflictingFields: ["name"], status: "OPEN",
          }).returning();
          return { event_id: ev.event_id, entity_id: srv.id, server_id: srv.id, status: "CONFLICT", entity_version: srv.version, business_status: "CONFLICT", conflict_id: c.id, error: { code: "VERSION_CONFLICT", message: "تعارض نسخه در شعبه" } };
        }
        const [upd] = await tx.update(branches).set({ ...(p.name ? { name: String(p.name) } : {}), version: srv.version + 1, updatedAt: new Date() }).where(eq(branches.id, srv.id)).returning();
        await appendSyncChangeLog(tx, { organizationId, entityType: "branch", entityId: upd.id, operation: "UPSERT", version: upd.version, sourceDeviceId: deviceId, payload: { id: upd.id, code: upd.code, name: upd.name } });
        return { event_id: ev.event_id, entity_id: upd.id, server_id: upd.id, status: "ACCEPTED", entity_version: upd.version, business_status: "CONFIRMED", error: null };
      }
      if (operation === "DELETE") {
        const [tomb] = await tx.update(branches).set({ isActive: false, deletedAt: new Date(), version: srv.version + 1, updatedAt: new Date() }).where(eq(branches.id, srv.id)).returning();
        await appendSyncChangeLog(tx, { organizationId, entityType: "branch", entityId: tomb.id, operation: "TOMBSTONE", version: tomb.version, sourceDeviceId: deviceId, payload: { id: tomb.id, is_deleted: true } });
        return { event_id: ev.event_id, entity_id: tomb.id, server_id: tomb.id, status: "ACCEPTED", entity_version: tomb.version, business_status: "CANCELLED", error: null };
      }
      throw new ApiError(422, "UNSUPPORTED_OPERATION", "عملیات نامعتبر برای branch");
    });
  }

  // --------------------------------------------------------------------------
  // 3. COST CENTER
  // --------------------------------------------------------------------------
  if (entityType === "cost_center") {
    return withTenantTransaction(organizationId, async (tx) => {
      if (operation === "CREATE") {
        const [created] = await tx.insert(costCenters).values({
          id: clientUuid, organizationId,
          code: String(p.code || `CC-${Date.now().toString().slice(-4)}`),
          name: String(p.name || "مرکز هزینه"),
          type: String(p.type || "DEPARTMENT"),
          isActive: p.is_active !== false,
          version: 1,
        }).returning();
        await appendSyncChangeLog(tx, { organizationId, entityType: "cost_center", entityId: created.id, operation: "UPSERT", version: created.version, sourceDeviceId: deviceId, payload: { id: created.id, code: created.code, name: created.name, type: created.type } });
        return { event_id: ev.event_id, entity_id: clientUuid, server_id: created.id, status: "ACCEPTED", entity_version: created.version, business_status: "CONFIRMED", error: null };
      }
      const [srv] = await tx.select().from(costCenters).where(and(eq(costCenters.id, clientUuid), eq(costCenters.organizationId, organizationId))).limit(1);
      if (!srv) throw new ApiError(404, "COST_CENTER_NOT_FOUND", "مرکز هزینه یافت نشد.");
      if (operation === "UPDATE") {
        if (srv.version > baseVer) {
          const [c] = await tx.insert(syncConflicts).values({
            organizationId, deviceId, entityType: "cost_center", entityId: srv.id,
            conflictType: "VERSION_MISMATCH", clientVersion: baseVer, serverVersion: srv.version,
            clientPayload: p, serverPayload: { name: srv.name, type: srv.type }, conflictingFields: ["name"], status: "OPEN",
          }).returning();
          return { event_id: ev.event_id, entity_id: srv.id, server_id: srv.id, status: "CONFLICT", entity_version: srv.version, business_status: "CONFLICT", conflict_id: c.id, error: { code: "VERSION_CONFLICT", message: "تعارض نسخه در مرکز هزینه" } };
        }
        const [upd] = await tx.update(costCenters).set({ ...(p.name ? { name: String(p.name) } : {}), ...(p.type ? { type: String(p.type) } : {}), version: srv.version + 1, updatedAt: new Date() }).where(eq(costCenters.id, srv.id)).returning();
        await appendSyncChangeLog(tx, { organizationId, entityType: "cost_center", entityId: upd.id, operation: "UPSERT", version: upd.version, sourceDeviceId: deviceId, payload: { id: upd.id, code: upd.code, name: upd.name, type: upd.type } });
        return { event_id: ev.event_id, entity_id: upd.id, server_id: upd.id, status: "ACCEPTED", entity_version: upd.version, business_status: "CONFIRMED", error: null };
      }
      if (operation === "DELETE") {
        const [tomb] = await tx.update(costCenters).set({ isActive: false, deletedAt: new Date(), version: srv.version + 1, updatedAt: new Date() }).where(eq(costCenters.id, srv.id)).returning();
        await appendSyncChangeLog(tx, { organizationId, entityType: "cost_center", entityId: tomb.id, operation: "TOMBSTONE", version: tomb.version, sourceDeviceId: deviceId, payload: { id: tomb.id, is_deleted: true } });
        return { event_id: ev.event_id, entity_id: tomb.id, server_id: tomb.id, status: "ACCEPTED", entity_version: tomb.version, business_status: "CANCELLED", error: null };
      }
      throw new ApiError(422, "UNSUPPORTED_OPERATION", "عملیات نامعتبر برای cost_center");
    });
  }

  // --------------------------------------------------------------------------
  // 4. ACCOUNT CODE (Chart of Accounts — controlled structural validation)
  // --------------------------------------------------------------------------
  if (entityType === "account_code") {
    return withTenantTransaction(organizationId, async (tx) => {
      if (operation === "CREATE") {
        let groupId = isUuid(p.group_id) ? p.group_id : null;
        const accType = String(p.account_type || "ASSET").toUpperCase();
        if (!groupId) {
          const [grp] = await tx.select().from(accountGroups).where(and(eq(accountGroups.organizationId, organizationId), eq(accountGroups.nature, accType))).limit(1);
          groupId = grp?.id ?? null;
        }
        if (!groupId) throw new ApiError(422, "ACCOUNT_GROUP_NOT_FOUND", "گروه حساب متناظر یافت نشد.");

        const [created] = await tx.insert(accounts).values({
          id: clientUuid, organizationId, groupId,
          code: String(p.code || `9${Date.now().toString().slice(-4)}`),
          name: String(p.name || "حساب جدید"),
          accountType: accType,
          normalBalance: String(p.normal_balance || (accType === "ASSET" || accType === "EXPENSE" ? "DEBIT" : "CREDIT")),
          accountLevel: Number(p.account_level || 3),
          isPostable: p.is_postable !== false,
          version: 1,
        }).returning();
        await appendSyncChangeLog(tx, { organizationId, entityType: "account_code", entityId: created.id, operation: "UPSERT", version: created.version, sourceDeviceId: deviceId, payload: { id: created.id, code: created.code, name: created.name, account_type: created.accountType } });
        return { event_id: ev.event_id, entity_id: clientUuid, server_id: created.id, status: "ACCEPTED", entity_version: created.version, business_status: "CONFIRMED", error: null };
      }
      const [srv] = await tx.select().from(accounts).where(and(eq(accounts.id, clientUuid), eq(accounts.organizationId, organizationId))).limit(1);
      if (!srv) throw new ApiError(404, "ACCOUNT_NOT_FOUND", "حساب یافت نشد.");
      if (srv.systemRole) throw new ApiError(409, "SYSTEM_ACCOUNT_PROTECTED", "تغییر حساب سیستمی از طریق Sync مجاز نیست.");
      if (operation === "UPDATE") {
        const [upd] = await tx.update(accounts).set({ ...(p.name ? { name: String(p.name) } : {}), version: srv.version + 1, updatedAt: new Date() }).where(eq(accounts.id, srv.id)).returning();
        await appendSyncChangeLog(tx, { organizationId, entityType: "account_code", entityId: upd.id, operation: "UPSERT", version: upd.version, sourceDeviceId: deviceId, payload: { id: upd.id, code: upd.code, name: upd.name } });
        return { event_id: ev.event_id, entity_id: upd.id, server_id: upd.id, status: "ACCEPTED", entity_version: upd.version, business_status: "CONFIRMED", error: null };
      }
      throw new ApiError(409, "USE_CONTROLLED_ACCOUNT_CLOSURE", "بستن حساب فقط از مسیر کنترل‌شده /api/v1/fiscal/accounts/{id}/close مجاز است.");
    });
  }

  // --------------------------------------------------------------------------
  // 5. TREASURY ACCOUNT (Never overwrites server `balance` via offline LWW!)
  // --------------------------------------------------------------------------
  if (entityType === "treasury_account") {
    return withTenantTransaction(organizationId, async (tx) => {
      if (operation === "CREATE") {
        const [created] = await tx.insert(financialAccounts).values({
          id: clientUuid, organizationId,
          name: String(p.name || "حساب خزانه جدید"),
          accountType: String(p.account_type || "BANK"),
          bankName: p.bank_name ? String(p.bank_name) : null,
          accountNumber: p.account_number ? String(p.account_number) : null,
          iban: p.iban ? String(p.iban) : null,
          currency: String(p.currency || "IRR"),
          balance: "0.00", // Server-authoritative: initial balance MUST come via Opening Journal!
          version: 1,
        }).returning();
        await appendSyncChangeLog(tx, { organizationId, entityType: "treasury_account", entityId: created.id, operation: "UPSERT", version: created.version, sourceDeviceId: deviceId, payload: { id: created.id, name: created.name, account_type: created.accountType, balance: created.balance } });
        return { event_id: ev.event_id, entity_id: clientUuid, server_id: created.id, status: "ACCEPTED", entity_version: created.version, business_status: "CONFIRMED", error: null };
      }
      const [srv] = await tx.select().from(financialAccounts).where(and(eq(financialAccounts.id, clientUuid), eq(financialAccounts.organizationId, organizationId))).limit(1);
      if (!srv) throw new ApiError(404, "TREASURY_ACCOUNT_NOT_FOUND", "حساب خزانه یافت نشد.");
      if (operation === "UPDATE") {
        const [upd] = await tx.update(financialAccounts).set({
          ...(p.name ? { name: String(p.name) } : {}),
          ...(p.bank_name !== undefined ? { bankName: p.bank_name ? String(p.bank_name) : null } : {}),
          ...(p.account_number !== undefined ? { accountNumber: p.account_number ? String(p.account_number) : null } : {}),
          ...(p.iban !== undefined ? { iban: p.iban ? String(p.iban) : null } : {}),
          ...(p.is_active !== undefined ? { isActive: Boolean(p.is_active) } : {}),
          version: srv.version + 1, updatedAt: new Date(),
        }).where(eq(financialAccounts.id, srv.id)).returning();
        await appendSyncChangeLog(tx, { organizationId, entityType: "treasury_account", entityId: upd.id, operation: "UPSERT", version: upd.version, sourceDeviceId: deviceId, payload: { id: upd.id, name: upd.name, balance: upd.balance } });
        return { event_id: ev.event_id, entity_id: upd.id, server_id: upd.id, status: "ACCEPTED", entity_version: upd.version, business_status: "CONFIRMED", error: null };
      }
      if (operation === "DELETE") {
        const [tomb] = await tx.update(financialAccounts).set({ isActive: false, deletedAt: new Date(), version: srv.version + 1, updatedAt: new Date() }).where(eq(financialAccounts.id, srv.id)).returning();
        await appendSyncChangeLog(tx, { organizationId, entityType: "treasury_account", entityId: tomb.id, operation: "TOMBSTONE", version: tomb.version, sourceDeviceId: deviceId, payload: { id: tomb.id, is_deleted: true } });
        return { event_id: ev.event_id, entity_id: tomb.id, server_id: tomb.id, status: "ACCEPTED", entity_version: tomb.version, business_status: "CANCELLED", error: null };
      }
      throw new ApiError(422, "UNSUPPORTED_OPERATION", "عملیات نامعتبر برای treasury_account");
    });
  }

  // --------------------------------------------------------------------------
  // 6. PRODUCT VARIANT (Validates parent product_id dependency!)
  // --------------------------------------------------------------------------
  if (entityType === "product_variant") {
    return withTenantTransaction(organizationId, async (tx) => {
      if (operation === "CREATE") {
        const prodId = String(p.product_id || "");
        if (!isUuid(prodId)) throw new ApiError(422, "PARENT_PRODUCT_REQUIRED", "شناسه کالای مادر (product_id) برای تنوع الزامی است.");
        const [parentProd] = await tx.select({ id: products.id }).from(products).where(and(eq(products.id, prodId), eq(products.organizationId, organizationId))).limit(1);
        if (!parentProd) throw new ApiError(409, "DEPENDENCY_NOT_SATISFIED", "کالای مادر (product_id) هنوز در سرور همگام‌سازی نشده است.");

        const [created] = await tx.insert(productVariants).values({
          id: clientUuid, organizationId, productId: prodId,
          sku: String(p.sku || `VAR-${Date.now().toString().slice(-5)}`),
          barcode: p.barcode ? String(p.barcode) : null,
          variantName: String(p.variant_name || "تنوع جدید"),
          attributes: (p.attributes as Record<string, string>) ?? {},
          purchasePrice: String(p.purchase_price || "0.00"),
          salePrice: String(p.sale_price || "0.00"),
          version: 1,
        }).returning();
        await appendSyncChangeLog(tx, { organizationId, entityType: "product_variant", entityId: created.id, operation: "UPSERT", version: created.version, sourceDeviceId: deviceId, payload: { id: created.id, product_id: created.productId, sku: created.sku, variant_name: created.variantName, sale_price: created.salePrice } });
        return { event_id: ev.event_id, entity_id: clientUuid, server_id: created.id, status: "ACCEPTED", entity_version: created.version, business_status: "CONFIRMED", error: null };
      }
      const [srv] = await tx.select().from(productVariants).where(and(eq(productVariants.id, clientUuid), eq(productVariants.organizationId, organizationId))).limit(1);
      if (!srv) throw new ApiError(404, "VARIANT_NOT_FOUND", "تنوع کالا یافت نشد.");
      if (operation === "UPDATE") {
        if (srv.version > baseVer) {
          const [c] = await tx.insert(syncConflicts).values({
            organizationId, deviceId, entityType: "product_variant", entityId: srv.id,
            conflictType: "VERSION_MISMATCH", clientVersion: baseVer, serverVersion: srv.version,
            clientPayload: p, serverPayload: { variant_name: srv.variantName, sale_price: srv.salePrice }, conflictingFields: ["variant_name", "sale_price"], status: "OPEN",
          }).returning();
          return { event_id: ev.event_id, entity_id: srv.id, server_id: srv.id, status: "CONFLICT", entity_version: srv.version, business_status: "CONFLICT", conflict_id: c.id, error: { code: "VERSION_CONFLICT", message: "تعارض نسخه در تنوع کالا" } };
        }
        const [upd] = await tx.update(productVariants).set({
          ...(p.variant_name ? { variantName: String(p.variant_name) } : {}),
          ...(p.sale_price ? { salePrice: String(p.sale_price) } : {}),
          version: srv.version + 1, updatedAt: new Date(),
        }).where(eq(productVariants.id, srv.id)).returning();
        await appendSyncChangeLog(tx, { organizationId, entityType: "product_variant", entityId: upd.id, operation: "UPSERT", version: upd.version, sourceDeviceId: deviceId, payload: { id: upd.id, variant_name: upd.variantName, sale_price: upd.salePrice } });
        return { event_id: ev.event_id, entity_id: upd.id, server_id: upd.id, status: "ACCEPTED", entity_version: upd.version, business_status: "CONFIRMED", error: null };
      }
      if (operation === "DELETE") {
        const [tomb] = await tx.update(productVariants).set({ isActive: false, deletedAt: new Date(), version: srv.version + 1, updatedAt: new Date() }).where(eq(productVariants.id, srv.id)).returning();
        await appendSyncChangeLog(tx, { organizationId, entityType: "product_variant", entityId: tomb.id, operation: "TOMBSTONE", version: tomb.version, sourceDeviceId: deviceId, payload: { id: tomb.id, is_deleted: true } });
        return { event_id: ev.event_id, entity_id: tomb.id, server_id: tomb.id, status: "ACCEPTED", entity_version: tomb.version, business_status: "CANCELLED", error: null };
      }
      throw new ApiError(422, "UNSUPPORTED_OPERATION", "عملیات نامعتبر برای product_variant");
    });
  }

  // --------------------------------------------------------------------------
  // 7. ACCOUNTING CATEGORY (custom quick cashflow category + its GL mapping)
  // --------------------------------------------------------------------------
  if (entityType === "accounting_category") {
    if (operation !== "CREATE") {
      throw new ApiError(409, "ACCOUNTING_CATEGORY_IMMUTABLE", "دسته‌بندی حسابداری از مسیر همگام‌سازی قابل حذف یا ویرایش نیست.");
    }
    return withTenantTransaction(organizationId, async (tx) => {
      const [existing] = await tx
        .select()
        .from(accountingCategories)
        .where(and(eq(accountingCategories.id, clientUuid), eq(accountingCategories.organizationId, organizationId)))
        .limit(1);
      if (existing) {
        return { event_id: ev.event_id, entity_id: clientUuid, server_id: existing.id, status: "ACCEPTED", entity_version: 1, business_status: "CONFIRMED", error: null };
      }

      const kind = String(p.kind || "EXPENSE").toUpperCase();
      if (kind !== "EXPENSE" && kind !== "INCOME") {
        throw new ApiError(422, "ACCOUNTING_CATEGORY_KIND_INVALID", "ماهیت دسته‌بندی باید هزینه یا درآمد باشد.");
      }
      const wantedAccountType = kind === "EXPENSE" ? "EXPENSE" : "REVENUE";
      const accountCode = String(p.account_code || "").trim();
      const [mappedAccount] = await tx
        .select()
        .from(accounts)
        .where(and(eq(accounts.organizationId, organizationId), eq(accounts.code, accountCode)))
        .limit(1);
      if (!mappedAccount || mappedAccount.accountType !== wantedAccountType || !mappedAccount.isPostable || !mappedAccount.isActive) {
        throw new ApiError(422, "ACCOUNTING_CATEGORY_ACCOUNT_INVALID", "حساب انتخاب‌شده با ماهیت دسته‌بندی سازگار یا قابل ثبت نیست.");
      }
      const [cashAccount] = await tx
        .select()
        .from(accounts)
        .where(and(eq(accounts.organizationId, organizationId), eq(accounts.systemRole, "CASH"), eq(accounts.isActive, true)))
        .limit(1);
      const [bankAccount] = cashAccount ? [] : await tx
        .select()
        .from(accounts)
        .where(and(eq(accounts.organizationId, organizationId), eq(accounts.systemRole, "BANK"), eq(accounts.isActive, true)))
        .limit(1);
      const counterpart = cashAccount ?? bankAccount;
      if (!counterpart) throw new ApiError(422, "CASH_ACCOUNT_NOT_FOUND", "حساب فعال صندوق یا بانک برای نگاشت دسته‌بندی پیدا نشد.");

      const [category] = await tx
        .insert(accountingCategories)
        .values({
          id: clientUuid,
          organizationId,
          kind,
          scope: "BUSINESS",
          code: String(p.code || `MOB-${clientUuid.slice(0, 8)}`).toUpperCase(),
          nameFa: String(p.name_fa || "دسته‌بندی جدید").trim(),
        })
        .returning();
      await tx.insert(categoryAccountMappings).values({
        organizationId,
        categoryId: category.id,
        debitAccountId: kind === "EXPENSE" ? mappedAccount.id : counterpart.id,
        creditAccountId: kind === "EXPENSE" ? counterpart.id : mappedAccount.id,
      });
      await appendSyncChangeLog(tx, {
        organizationId,
        entityType: "accounting_category",
        entityId: category.id,
        operation: "UPSERT",
        version: 1,
        sourceDeviceId: deviceId,
        payload: { id: category.id, kind: category.kind, code: category.code, name_fa: category.nameFa },
      });
      return { event_id: ev.event_id, entity_id: clientUuid, server_id: category.id, status: "ACCEPTED", entity_version: 1, business_status: "CONFIRMED", error: null };
    });
  }

  // --------------------------------------------------------------------------
  // 7. QUICK CASHFLOW (Expense/Income with Cost Center & Receipt URL + Auto Journal)
  // --------------------------------------------------------------------------
  if (entityType === "quick_cashflow") {
    if (operation !== "CREATE") {
      throw new ApiError(409, "QUICK_CASHFLOW_IMMUTABLE", "تراکنش نقدی قطعی از طریق Sync قابل ویرایش نیست؛ از Reverse استفاده کنید.");
    }
    return withTenantTransaction(organizationId, async (tx) => {
      const catId = String(p.category_id || "");
      const finAccId = String(p.financial_account_id || "");
      const kind = String(p.kind || "EXPENSE").toUpperCase();
      const amount = String(p.amount || "0.00");
      const txDate = String(p.tx_date || new Date().toISOString().slice(0, 10));

      if (p.scope === "PERSONAL") {
        throw new ApiError(422, "USE_PERSONAL_TRANSACTION", "هزینه شخصی باید با نوع personal_transaction ارسال شود.");
      }
      if (!isUuid(catId) || (kind !== "EXPENSE" && kind !== "INCOME")) {
        throw new ApiError(422, "QUICK_CASHFLOW_CATEGORY_INVALID", "دسته‌بندی یا ماهیت تراکنش معتبر نیست.");
      }

      if (p.cost_center_id) {
        const [cc] = await tx.select().from(costCenters).where(and(eq(costCenters.id, String(p.cost_center_id)), eq(costCenters.organizationId, organizationId))).limit(1);
        if (!cc || !cc.isActive) throw new ApiError(409, "COST_CENTER_INVALID", "مرکز هزینه معتبر یا فعال نیست.");
      }

      let [mapping] = await tx.select().from(categoryAccountMappings).where(and(eq(categoryAccountMappings.organizationId, organizationId), eq(categoryAccountMappings.categoryId, catId))).limit(1);
      if (!mapping) {
        const [category] = await tx.select().from(accountingCategories).where(and(eq(accountingCategories.id, catId), eq(accountingCategories.organizationId, organizationId))).limit(1);
        const accountCode = String(p.account_code || "").trim();
        const expectedType = kind === "EXPENSE" ? "EXPENSE" : "REVENUE";
        const [mappedAccount] = await tx.select().from(accounts).where(and(eq(accounts.organizationId, organizationId), eq(accounts.code, accountCode))).limit(1);
        if (!mappedAccount || mappedAccount.accountType !== expectedType || !mappedAccount.isPostable || !mappedAccount.isActive) {
          throw new ApiError(422, "CATEGORY_ACCOUNT_MAPPING_MISSING", "حساب معین سازگار برای دسته‌بندی پیدا نشد.");
        }
        const [cashAccount] = await tx.select().from(accounts).where(and(eq(accounts.organizationId, organizationId), eq(accounts.systemRole, "CASH"), eq(accounts.isActive, true))).limit(1);
        const [bankAccount] = cashAccount ? [] : await tx.select().from(accounts).where(and(eq(accounts.organizationId, organizationId), eq(accounts.systemRole, "BANK"), eq(accounts.isActive, true))).limit(1);
        const counterpart = cashAccount ?? bankAccount;
        if (!counterpart) throw new ApiError(422, "CASH_ACCOUNT_NOT_FOUND", "حساب صندوق یا بانک برای ثبت سند پیدا نشد.");
        if (!category) {
          await tx.insert(accountingCategories).values({
            id: catId,
            organizationId,
            kind,
            scope: "BUSINESS",
            code: String(p.category_code || `MOB-${catId.slice(0, 8)}`).toUpperCase(),
            nameFa: String(p.category_name || "دسته‌بندی جدید").trim(),
          });
        }
        [mapping] = await tx.insert(categoryAccountMappings).values({
          organizationId,
          categoryId: catId,
          debitAccountId: kind === "EXPENSE" ? mappedAccount.id : counterpart.id,
          creditAccountId: kind === "EXPENSE" ? counterpart.id : mappedAccount.id,
        }).returning();
      }
      if (!mapping) throw new ApiError(422, "CATEGORY_ACCOUNT_MAPPING_MISSING", "نگاشت حسابداری دسته‌بندی یافت نشد.");

      const [fa] = await tx.select().from(financialAccounts).where(and(eq(financialAccounts.id, finAccId), eq(financialAccounts.organizationId, organizationId))).limit(1);
      if (!fa) throw new ApiError(404, "TREASURY_ACCOUNT_NOT_FOUND", "حساب خزانه یافت نشد.");

      const nextBal = kind === "INCOME" ? addDec(fa.balance, amount) : subDec(fa.balance, amount);
      await tx.update(financialAccounts).set({ balance: formatDecimal(nextBal, 2) }).where(eq(financialAccounts.id, fa.id));

      const treasuryGl = fa.accountId ?? (kind === "EXPENSE" ? mapping.creditAccountId : mapping.debitAccountId);
      const jr = await createJournalEntryTx(tx, {
        organizationId, actorUserId: params.userId, actorEmail: params.userEmail,
        entryDate: txDate, description: String(p.title || "ثبت سریع آفلاین"),
        referenceType: kind === "EXPENSE" ? "QUICK_EXPENSE" : "QUICK_INCOME",
        postImmediately: true,
        lines: kind === "EXPENSE"
          ? [
              { accountId: mapping.debitAccountId, costCenterId: isUuid(p.cost_center_id) ? p.cost_center_id : null, debit: amount, credit: "0.00" },
              { accountId: treasuryGl, debit: "0.00", credit: amount },
            ]
          : [
              { accountId: treasuryGl, debit: amount, credit: "0.00" },
              { accountId: mapping.creditAccountId, costCenterId: isUuid(p.cost_center_id) ? p.cost_center_id : null, debit: "0.00", credit: amount },
            ],
      });

      const [saved] = await tx.insert(quickTransactions).values({
        id: clientUuid, organizationId, kind, scope: "BUSINESS",
        categoryId: catId, financialAccountId: fa.id,
        costCenterId: isUuid(p.cost_center_id) ? p.cost_center_id : null,
        title: String(p.title || "ثبت سریع آفلاین"),
        amount, txDate, paymentMethod: String(p.payment_method || "CASH"),
        receiptUrl: p.receipt_url ? String(p.receipt_url) : null,
        description: p.description ? String(p.description) : null,
        status: "CONFIRMED", journalEntryId: jr.entry.id, version: 1, createdBy: params.userId,
      }).returning();

      await appendSyncChangeLog(tx, { organizationId, entityType: "quick_cashflow", entityId: saved.id, operation: "UPSERT", version: 1, sourceDeviceId: deviceId, payload: { id: saved.id, kind: saved.kind, amount: saved.amount, cost_center_id: saved.costCenterId, receipt_url: saved.receiptUrl } });
      return { event_id: ev.event_id, entity_id: clientUuid, server_id: saved.id, status: "CONFIRMED", entity_version: 1, business_status: "CONFIRMED", error: null };
    });
  }

  // --------------------------------------------------------------------------
  // 8. CONSIGNMENT DOCUMENT (CREATE / CONFIRM via Consignment Domain Service)
  // --------------------------------------------------------------------------
  if (entityType === "consignment_document") {
    if (operation === "CREATE") {
      const items = (p.items as Array<{ product_id: string; product_variant_id?: string | null; warehouse_id?: string | null; quantity: string; agreed_unit_price: string }>) ?? [];
      const created = await createConsignmentDocument({
        organizationId,
        documentType: String(p.document_type || "CONSIGNMENT_IN") as ConsignmentDocType,
        contactId: String(p.contact_id || ""),
        warehouseId: String(p.warehouse_id || ""),
        relatedDocumentId: isUuid(p.related_document_id) ? p.related_document_id : null,
        documentDate: String(p.document_date || new Date().toISOString().slice(0, 10)),
        commissionRate: p.commission_rate ? String(p.commission_rate) : undefined,
        receiptUrl: p.receipt_url ? String(p.receipt_url) : null,
        notes: p.notes ? String(p.notes) : undefined,
        actorUserId: params.userId,
        actorEmail: params.userEmail,
        ipAddress: params.ipAddress,
        items,
      });
      return { event_id: ev.event_id, entity_id: clientUuid, server_id: created.document.id, status: "ACCEPTED", entity_version: created.document.version, business_status: "DRAFT", error: null };
    }
    if (operation === "CONFIRM") {
      const confirmed = await confirmConsignmentDocument({
        organizationId,
        documentId: clientUuid,
        actorUserId: params.userId,
        actorEmail: params.userEmail,
        ipAddress: params.ipAddress,
      });
      return { event_id: ev.event_id, entity_id: confirmed.document.id, server_id: confirmed.document.id, status: "CONFIRMED", entity_version: confirmed.document.version, business_status: "CONFIRMED", error: null };
    }
  }

  // --------------------------------------------------------------------------
  // 9. PERSONAL TRANSACTION & OWNER WITHDRAWAL (Strictly RBAC Protected!)
  // --------------------------------------------------------------------------
  if (entityType === "personal_transaction") {
    if (operation === "CREATE") {
      const saved = await createPersonalTransaction({
        organizationId,
        ownerUserId: params.userId,
        actorEmail: params.userEmail,
        ipAddress: params.ipAddress,
        txType: String(p.tx_type || "PERSONAL_EXPENSE"),
        paymentSource: String(p.payment_source || "PERSONAL_CASH"),
        title: String(p.title || "هزینه شخصی آفلاین"),
        amount: String(p.amount || "0.00"),
        txDate: String(p.tx_date || new Date().toISOString().slice(0, 10)),
        categoryId: isUuid(p.category_id) ? p.category_id : null,
        linkedWithdrawalId: isUuid(p.linked_withdrawal_id) ? p.linked_withdrawal_id : null,
        idempotencyKey: ev.idempotency_key,
      });
      await appendSyncChangeLog(db, { organizationId, entityType: "personal_transaction", entityId: saved.id, operation: "UPSERT", version: saved.version, sourceDeviceId: deviceId, payload: { id: saved.id, tx_type: saved.txType, amount: saved.amount, title: saved.title } });
      return { event_id: ev.event_id, entity_id: clientUuid, server_id: saved.id, status: "CONFIRMED", entity_version: saved.version, business_status: "CONFIRMED", error: null };
    }
    if (operation === "DELETE") {
      const [tomb] = await db.update(personalTransactions).set({ deletedAt: new Date(), status: "REVERSED", updatedAt: new Date() }).where(and(eq(personalTransactions.id, clientUuid), eq(personalTransactions.organizationId, organizationId), eq(personalTransactions.ownerUserId, params.userId))).returning();
      if (!tomb) throw new ApiError(404, "PERSONAL_TX_NOT_FOUND", "تراکنش شخصی یافت نشد.");
      await appendSyncChangeLog(db, { organizationId, entityType: "personal_transaction", entityId: tomb.id, operation: "TOMBSTONE", version: tomb.version + 1, sourceDeviceId: deviceId, payload: { id: tomb.id, is_deleted: true } });
      return { event_id: ev.event_id, entity_id: tomb.id, server_id: tomb.id, status: "ACCEPTED", entity_version: tomb.version + 1, business_status: "REVERSED", error: null };
    }
  }

  if (entityType === "owner_withdrawal") {
    if (operation !== "CREATE") {
      throw new ApiError(409, "OWNER_WITHDRAWAL_IMMUTABLE", "برداشت مالک قطعی قابل ویرایش مستقیم در Sync نیست.");
    }
    const wd = await createOwnerWithdrawal({
      organizationId,
      ownerUserId: params.userId,
      actorEmail: params.userEmail,
      ipAddress: params.ipAddress,
      businessFinancialAccountId: String(p.business_financial_account_id || p.from_account_id || ""),
      amount: String(p.amount || "0.00"),
      withdrawalDate: String(p.withdrawal_date || new Date().toISOString().slice(0, 10)),
      notes: p.notes ? String(p.notes) : "برداشت مالک آفلاین",
      idempotencyKey: ev.idempotency_key,
    });
    await appendSyncChangeLog(db, { organizationId, entityType: "owner_withdrawal", entityId: wd.withdrawal.id, operation: "UPSERT", version: 1, sourceDeviceId: deviceId, payload: { id: wd.withdrawal.id, amount: wd.withdrawal.amount, status: wd.withdrawal.status } });
    return { event_id: ev.event_id, entity_id: clientUuid, server_id: wd.withdrawal.id, status: "CONFIRMED", entity_version: 1, business_status: "CONFIRMED", error: null };
  }

  // --------------------------------------------------------------------------
  // 10. EMPLOYEE (Server-Validated RBAC)
  // --------------------------------------------------------------------------
  if (entityType === "employee") {
    return withTenantTransaction(organizationId, async (tx) => {
      if (operation === "CREATE") {
        const [created] = await tx.insert(employees).values({
          id: clientUuid, organizationId,
          employeeCode: String(p.employee_code || `EMP-${Date.now().toString().slice(-4)}`),
          fullName: String(p.full_name || "پرسنل جدید"),
          mobile: p.mobile ? String(p.mobile) : null,
          email: p.email ? String(p.email) : null,
          branchName: String(p.branch_name || "شعبه مرکزی"),
          hireDate: String(p.hire_date || new Date().toISOString().slice(0, 10)),
          version: 1,
        }).returning();
        await appendSyncChangeLog(tx, { organizationId, entityType: "employee", entityId: created.id, operation: "UPSERT", version: 1, sourceDeviceId: deviceId, payload: { id: created.id, employee_code: created.employeeCode, full_name: created.fullName } });
        return { event_id: ev.event_id, entity_id: clientUuid, server_id: created.id, status: "ACCEPTED", entity_version: 1, business_status: "CONFIRMED", error: null };
      }
      const [srv] = await tx.select().from(employees).where(and(eq(employees.id, clientUuid), eq(employees.organizationId, organizationId))).limit(1);
      if (!srv) throw new ApiError(404, "EMPLOYEE_NOT_FOUND", "پرسنل یافت نشد.");
      if (operation === "UPDATE") {
        const [upd] = await tx.update(employees).set({ ...(p.full_name ? { fullName: String(p.full_name) } : {}), ...(p.branch_name ? { branchName: String(p.branch_name) } : {}), version: srv.version + 1, updatedAt: new Date() }).where(eq(employees.id, srv.id)).returning();
        await appendSyncChangeLog(tx, { organizationId, entityType: "employee", entityId: upd.id, operation: "UPSERT", version: upd.version, sourceDeviceId: deviceId, payload: { id: upd.id, full_name: upd.fullName, branch_name: upd.branchName } });
        return { event_id: ev.event_id, entity_id: upd.id, server_id: upd.id, status: "ACCEPTED", entity_version: upd.version, business_status: "CONFIRMED", error: null };
      }
      if (operation === "DELETE") {
        const [tomb] = await tx.update(employees).set({ employmentStatus: "INACTIVE", deletedAt: new Date(), version: srv.version + 1, updatedAt: new Date() }).where(eq(employees.id, srv.id)).returning();
        await appendSyncChangeLog(tx, { organizationId, entityType: "employee", entityId: tomb.id, operation: "TOMBSTONE", version: tomb.version, sourceDeviceId: deviceId, payload: { id: tomb.id, is_deleted: true } });
        return { event_id: ev.event_id, entity_id: tomb.id, server_id: tomb.id, status: "ACCEPTED", entity_version: tomb.version, business_status: "CANCELLED", error: null };
      }
      throw new ApiError(422, "UNSUPPORTED_OPERATION", "عملیات نامعتبر برای employee");
    });
  }

  return null;
}

import crypto from "crypto";
import { and, asc, desc, eq, gt, inArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  accounts,
  chequeEvents,
  cheques,
  contacts,
  devices,
  financialAccounts,
  organizations,
  financialTransactions,
  journalEntries,
  loyaltyMembershipTiers,
  loyaltyProgramSettings,
  loyaltyAccounts,
  loyaltyTransactions,
  products,
  purchaseInvoiceItems,
  purchaseInvoices,
  salesInvoiceItems,
  salesInvoices,
  syncBatches,
  syncChangeLog,
  syncCheckpoints,
  syncConflicts,
  syncEvents,
  syncInbox,
  syncLogs,
  stockTransfers,
  stockTransferItems,
  units,
  warehouses,
} from "@/db/schema";
import { sha256 } from "@/lib/auth";
import { recordAuditLog } from "@/lib/audit";
import { addDec, divDec, eqDec, formatDecimal, mulDec, parseDecimal, subDec } from "@/lib/decimal";
import { ApiError } from "@/lib/errors";
import { withTenantTransaction } from "@/lib/tenant";
import { createJournalEntryTx } from "@/modules/accounting/service";
import {
  finalizePurchaseInvoice,
  finalizeSalesInvoice,
  type PaymentAllocationInput,
} from "@/modules/commerce/service";
import { approveStockCount, postStockDocumentTx } from "@/modules/inventory/service";
import { createLandedWarehouseReceipt } from "@/modules/inventory/prompt08.service";
import {
  appendSyncChangeLog,
  decodeSyncCursor,
  encodeSyncCursor,
} from "./changelog";
import { processExtendedSyncEntity } from "./extended-handlers";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_REGEX.test(v);
}

function optionalEpoch(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean).slice(0, 50) : [];
}

function contactSyncPayload(contact: typeof contacts.$inferSelect) {
  return {
    id: contact.id,
    organization_id: contact.organizationId,
    code: contact.code,
    display_name: contact.name,
    first_name: contact.firstName,
    last_name: contact.lastName,
    company_name: contact.companyName,
    type: contact.contactType,
    national_id: contact.nationalCode,
    economic_code: contact.economicCode,
    mobile: contact.mobile,
    phone: contact.phone,
    email: contact.email,
    address: contact.address,
    postal_code: contact.postalCode,
    credit_limit: contact.creditLimit,
    opening_balance: contact.openingBalance,
    notes: contact.notes,
    is_active: contact.status === "ACTIVE",
    birth_date_epoch: contact.birthDateEpoch,
    gender: contact.gender,
    customer_tags: contact.customerTags,
    awareness_source: contact.awarenessSource,
    marketing_consent: contact.marketingConsent,
    province: contact.province,
    city: contact.city,
    branch_local_id: contact.branchLocalId,
    membership_date_epoch: contact.membershipDateEpoch,
    customer_segment: contact.customerSegment,
    supplier_category: contact.supplierCategory,
    supplier_settlement_method: contact.supplierSettlementMethod,
    supplier_payment_due_days: contact.supplierPaymentDueDays,
    supplier_delivery_lead_time_days: contact.supplierDeliveryLeadTimeDays,
    supplier_bank_name: contact.supplierBankName,
    supplier_card_number: contact.supplierCardNumber,
    supplier_sheba: contact.supplierSheba,
    supplier_bank_account_number: contact.supplierBankAccountNumber,
  };
}

function syncDate(value: unknown, fallback: string): string {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const epoch = optionalEpoch(value);
  return epoch === null ? fallback : new Date(epoch).toISOString().slice(0, 10);
}

function normalizeChequeDirection(value: unknown): "RECEIVABLE" | "PAYABLE" {
  const direction = String(value || "RECEIVABLE").toUpperCase();
  return direction === "OUTGOING" || direction === "PAYABLE" ? "PAYABLE" : "RECEIVABLE";
}

function normalizeChequeStatus(value: unknown): string {
  const status = String(value || "RECEIVED").toUpperCase();
  const mapped: Record<string, string> = {
    AWAITING_COLLECTION: "IN_CUSTODY",
    REPLACED: "REISSUED",
  };
  return mapped[status] || status;
}

function chequeSyncPayload(cheque: typeof cheques.$inferSelect) {
  return {
    id: cheque.id,
    organization_id: cheque.organizationId,
    contact_id: cheque.contactId,
    financial_account_id: cheque.financialAccountId,
    direction: cheque.chequeType === "PAYABLE" ? "OUTGOING" : "INCOMING",
    cheque_number: cheque.sayadId,
    serial_number: cheque.serialNumber,
    bank_name: cheque.bankName,
    branch_name: cheque.branchName,
    account_number: cheque.accountNumber,
    amount: cheque.amount,
    issue_date: cheque.issueDate,
    due_date: cheque.dueDate,
    status: cheque.status,
    related_document_type: cheque.relatedDocumentType,
    related_document_id: cheque.relatedDocumentId,
    reference_document_number: cheque.referenceDocumentNumber,
    reminder_date_epoch: cheque.reminderDateEpoch,
    notes: cheque.notes,
  };
}

/**
 * Android sends its stable device UUID, while older clients may send the database ID.
 * Resolve both forms within the active tenant and keep database IDs for sync records.
 */
export async function resolveActiveSyncDevice(organizationId: string, deviceIdentifier: string) {
  const identityCondition = isUuid(deviceIdentifier)
    ? or(eq(devices.id, deviceIdentifier), eq(devices.deviceUuid, deviceIdentifier))
    : eq(devices.deviceUuid, deviceIdentifier);
  const [device] = await db
    .select()
    .from(devices)
    .where(and(eq(devices.organizationId, organizationId), identityCondition))
    .limit(1);

  if (!device) {
    throw new ApiError(403, "DEVICE_NOT_REGISTERED", "دستگاه اندروید در این سازمان ثبت نشده است.");
  }
  if (device.status !== "ACTIVE") {
    throw new ApiError(403, "DEVICE_REVOKED", "این دستگاه توسط مدیر سازمان مسدود شده و اجازه همگام‌سازی ندارد.");
  }
  return device;
}

function prepareOfflineInvoice(payload: Record<string, unknown>) {
  const rawItems = Array.isArray(payload.items)
    ? (payload.items as Array<Record<string, unknown>>)
    : [];
  if (rawItems.length === 0) {
    throw new ApiError(422, "VALIDATION_ERROR", "فاکتور آفلاین باید حداقل یک ردیف کالا داشته باشد.");
  }

  const normalized = rawItems.map((item) => {
    const productId = String(item.product_id || "");
    const quantity = String(item.quantity || "0");
    const unitPrice = String(item.unit_price || "0");
    if (!isUuid(productId) || parseDecimal(quantity) <= BigInt(0) || parseDecimal(unitPrice) < BigInt(0)) {
      throw new ApiError(422, "VALIDATION_ERROR", "شناسه کالا، تعداد یا قیمت ردیف فاکتور معتبر نیست.");
    }
    const gross = mulDec(quantity, unitPrice);
    const discountAmount = String(item.discount_amount || "0.00");
    if (parseDecimal(discountAmount) < BigInt(0) || parseDecimal(discountAmount) > gross) {
      throw new ApiError(422, "LINE_DISCOUNT_INVALID", "تخفیف ردیف فاکتور معتبر نیست.");
    }
    return {
      clientItemId: isUuid(item.client_item_id) ? String(item.client_item_id) : null,
      productId,
      variantId: isUuid(item.variant_id) ? String(item.variant_id) : null,
      quantity,
      unitPrice,
      gross,
      discountAmount,
      taxRate: String(item.tax_rate || "0.00"),
      requestedTax: String(item.tax_amount || "0.00"),
      description: item.description == null ? null : String(item.description),
    };
  });

  const grossSubtotal = normalized.reduce((sum, item) => addDec(sum, item.gross), BigInt(0));
  if (grossSubtotal <= BigInt(0)) {
    throw new ApiError(422, "INVOICE_TOTAL_INVALID", "جمع ردیف‌های فاکتور باید بزرگ‌تر از صفر باشد.");
  }

  const subtotal = String(payload.subtotal || formatDecimal(grossSubtotal, 2));
  const discountTotal = String(payload.discount_total || payload.discount_amount || "0.00");
  const taxTotal = String(payload.tax_total || payload.tax_amount || "0.00");
  const shippingCost = String(payload.shipping_cost || "0.00");
  const otherCosts = formatDecimal(
    addDec(String(payload.other_costs || "0.00"), String(payload.rounding_adjustment || "0.00")),
    2
  );
  const grandTotal = String(payload.grand_total || "");
  const calculatedTotal = formatDecimal(
    subDec(addDec(addDec(subtotal, taxTotal), addDec(shippingCost, otherCosts)), discountTotal),
    2
  );
  if (!grandTotal || !eqDec(calculatedTotal, grandTotal)) {
    throw new ApiError(422, "INVOICE_TOTAL_MISMATCH", "جمع فاکتور با ردیف‌ها، تخفیف، مالیات و هزینه‌ها تطبیق ندارد.");
  }

  let allocatedSubtotal = BigInt(0);
  const subtotalScaledItems = normalized.map((item, index) => {
    const allocated = index === normalized.length - 1
      ? subDec(subtotal, allocatedSubtotal)
      : mulDec(subtotal, formatDecimal(divDec(item.gross, grossSubtotal), 4));
    const lineTotal = formatDecimal(allocated, 2);
    allocatedSubtotal = addDec(allocatedSubtotal, lineTotal);
    return { ...item, lineTotal };
  });

  const taxWeightsTotal = normalized.reduce(
    (sum, item) => addDec(sum, item.requestedTax),
    BigInt(0)
  );
  let allocatedTax = BigInt(0);
  const items = subtotalScaledItems.map((item, index) => {
    const weight = taxWeightsTotal > BigInt(0) ? item.requestedTax : formatDecimal(item.gross, 2);
    const denominator = taxWeightsTotal > BigInt(0) ? taxWeightsTotal : grossSubtotal;
    const tax = index === subtotalScaledItems.length - 1
      ? subDec(taxTotal, allocatedTax)
      : mulDec(taxTotal, formatDecimal(divDec(weight, denominator), 4));
    const taxAmount = formatDecimal(tax, 2);
    allocatedTax = addDec(allocatedTax, taxAmount);
    return {
      clientItemId: item.clientItemId,
      productId: item.productId,
      variantId: item.variantId,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      discountAmount: item.discountAmount,
      taxRate: item.taxRate,
      taxAmount,
      lineTotal: item.lineTotal,
      description: item.description,
    };
  });

  return { items, subtotal, discountTotal, taxTotal, shippingCost, otherCosts, grandTotal };
}

function parseSyncPaymentAllocations(payload: Record<string, unknown>): PaymentAllocationInput[] {
  if (!Array.isArray(payload.payment_allocations)) return [];
  const supported = new Set<PaymentAllocationInput["paymentMethod"]>([
    "CASH", "BANK", "BANK_TRANSFER", "CARD_TERMINAL", "POS", "WALLET", "CHEQUE", "CREDIT", "ACCOUNT_BALANCE", "OTHER",
  ]);
  return (payload.payment_allocations as Array<Record<string, unknown>>).map((item) => {
    const paymentMethod = String(item.payment_method || "").toUpperCase() as PaymentAllocationInput["paymentMethod"];
    const amount = String(item.amount || "0.00");
    if (!supported.has(paymentMethod) || parseDecimal(amount) < BigInt(0)) {
      throw new ApiError(422, "PAYMENT_ALLOCATION_INVALID", "روش یا مبلغ یکی از تسویه‌های فاکتور معتبر نیست.");
    }
    const rawCheque = item.cheque && typeof item.cheque === "object"
      ? (item.cheque as Record<string, unknown>)
      : null;
    const cheque = rawCheque ? {
      chequeNumber: String(rawCheque.chequeNumber || item.reference_number || ""),
      serialNumber: rawCheque.serialNumber == null ? undefined : String(rawCheque.serialNumber),
      bankName: String(rawCheque.bankName || "بانک طرف‌حساب"),
      branchName: rawCheque.branchName == null ? undefined : String(rawCheque.branchName),
      drawerName: rawCheque.drawerName == null ? undefined : String(rawCheque.drawerName),
      issueDate: rawCheque.issueDate == null ? undefined : String(rawCheque.issueDate),
      dueDate: rawCheque.dueDate == null ? undefined : String(rawCheque.dueDate),
      notes: rawCheque.notes == null ? undefined : String(rawCheque.notes),
    } : null;
    return {
      financialAccountId: isUuid(item.financial_account_id) ? String(item.financial_account_id) : null,
      paymentMethod,
      amount,
      referenceNumber: item.reference_number == null ? null : String(item.reference_number),
      cheque,
    };
  });
}

async function ensureWalkInCustomer(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  organizationId: string,
  deviceId: string,
) {
  const [existing] = await tx.select().from(contacts).where(and(
    eq(contacts.organizationId, organizationId),
    eq(contacts.code, "WALK-IN"),
  )).limit(1);
  if (existing) return existing.id;

  const [created] = await tx.insert(contacts).values({
    organizationId,
    code: "WALK-IN",
    name: "فروش نقدی / مشتری متفرقه",
    contactType: "CUSTOMER",
    notes: "طرف‌حساب سیستمی برای فاکتورهای فروش نقدی بدون انتخاب مشتری در اندروید.",
    version: 1,
    syncSeq: Date.now(),
  }).returning();
  await appendSyncChangeLog(tx, {
    organizationId,
    entityType: "contact",
    entityId: created.id,
    operation: "UPSERT",
    version: created.version,
    sourceDeviceId: deviceId,
    payload: {
      id: created.id,
      code: created.code,
      display_name: created.name,
      type: created.contactType,
      mobile: null,
      credit_limit: created.creditLimit,
      is_active: true,
    },
  });
  return created.id;
}

export interface SyncPushEventInput {
  event_id: string;
  idempotency_key: string;
  entity_type: string;
  entity_id?: string | null;
  operation: string; // CREATE | UPDATE | DELETE | SOFT_DELETE | CONFIRM
  base_version?: number | null;
  dependencies?: string[];
  payload: Record<string, unknown>;
}

export interface SyncPushEventResult {
  event_id: string;
  entity_id: string | null;
  server_id: string | null;
  status: "ACCEPTED" | "CONFIRMED" | "REJECTED" | "CONFLICT" | "DUPLICATE";
  entity_version: number;
  business_status: string;
  conflict_id?: string;
  error: { code: string; message: string } | null;
}

function normalizeEntityType(raw: string): string {
  const s = raw.trim().toLowerCase();
  if (s === "purchase_invoice" || s === "purchases") return "purchase";
  if (s === "sales_invoice" || s === "sale") return "sales";
  if (s === "journal") return "journal_entry";
  if (s === "catalog_item") return "product";
  if (s === "treasury_transaction") return "financial_transaction";
  return s;
}

function normalizeOperation(raw: string): string {
  const s = raw.trim().toUpperCase();
  if (s === "SOFT_DELETE") return "DELETE";
  return s;
}

function detectConflictingFields(
  clientPayload: Record<string, unknown>,
  serverPayload: Record<string, unknown>
): string[] {
  const diffs: string[] = [];
  for (const [k, clientVal] of Object.entries(clientPayload)) {
    if (clientVal === undefined) continue;
    const serverVal = serverPayload[k];
    if (String(clientVal ?? "") !== String(serverVal ?? "")) {
      diffs.push(k);
    }
  }
  return diffs;
}

export function getAllowedResolutions(entityType: string, conflictType: string): string[] {
  const t = normalizeEntityType(entityType);
  if (t === "journal_entry" || conflictType === "FINANCIAL_IMMUTABLE") {
    return ["USE_SERVER", "RECREATE_AS_NEW"];
  }
  if (conflictType === "STOCK_SHORTAGE" || t === "sales" || t === "purchase") {
    return ["USE_SERVER", "RECREATE_AS_NEW"];
  }
  return ["USE_SERVER", "USE_LOCAL", "MERGE", "RECREATE_AS_NEW"];
}

/**
 * Ensures `sync_change_log` has initial baseline entries for an organization when empty
 * (so seeded entities are immediately discoverable via Opaque Cursor Pull).
 */
async function ensureOrgChangeLogBaseline(organizationId: string) {
  const existing = await db
    .select({ seq: syncChangeLog.seq })
    .from(syncChangeLog)
    .where(eq(syncChangeLog.organizationId, organizationId))
    .limit(1);
  if (existing.length > 0) return;

  const [orgContacts, orgProducts, orgWarehouses] = await Promise.all([
    db.select().from(contacts).where(eq(contacts.organizationId, organizationId)),
    db.select().from(products).where(eq(products.organizationId, organizationId)),
    db.select().from(warehouses).where(eq(warehouses.organizationId, organizationId)),
  ]);

  const rowsToInsert: Array<typeof syncChangeLog.$inferInsert> = [];
  for (const w of orgWarehouses) {
    rowsToInsert.push({
      organizationId,
      entityType: "warehouse",
      entityId: w.id,
      operation: "UPSERT",
      version: 1,
      payload: { id: w.id, code: w.code, name: w.name, address: w.address, is_active: w.isActive },
    });
  }
  for (const c of orgContacts) {
    rowsToInsert.push({
      organizationId,
      entityType: "contact",
      entityId: c.id,
      operation: c.deletedAt ? "TOMBSTONE" : "UPSERT",
      version: c.version,
      payload: {
        id: c.id,
        code: c.code,
        display_name: c.name,
        type: c.contactType,
        mobile: c.mobile,
        credit_limit: c.creditLimit,
        is_active: !c.deletedAt,
      },
    });
  }
  for (const p of orgProducts) {
    rowsToInsert.push({
      organizationId,
      entityType: "product",
      entityId: p.id,
      operation: p.deletedAt ? "TOMBSTONE" : "UPSERT",
      version: p.version,
      payload: {
        id: p.id,
        code: p.sku,
        name: p.name,
        purchase_price: p.defaultPurchasePrice,
        sale_price: p.defaultSalePrice,
        is_active: p.isActive,
      },
    });
  }
  if (rowsToInsert.length > 0) {
    await db.insert(syncChangeLog).values(rowsToInsert);
  }
}

/**
 * Master Prompt 04 §8 & §9 — Authoritative Push Engine
 */
export async function pushSyncBatch(params: {
  organizationId: string;
  userId: string;
  userEmail: string;
  ipAddress?: string | null;
  deviceId: string;
  batchId: string;
  bypassOfflineModeGuard?: boolean;
  events: SyncPushEventInput[];
}) {
  const startedAt = new Date();
  const startMs = Date.now();

  // Prompt 08 §2.11: Block background business sync when organization is in OFFLINE_ONLY mode!
  if (!params.bypassOfflineModeGuard) {
    const [orgRow] = await db
      .select({ operatingMode: organizations.operatingMode })
      .from(organizations)
      .where(eq(organizations.id, params.organizationId))
      .limit(1);
    if (orgRow?.operatingMode === "OFFLINE_ONLY") {
      throw new ApiError(
        409,
        "OPERATING_MODE_OFFLINE_ONLY",
        "سازمان در حالت OFFLINE_ONLY قرار دارد و همگام‌سازی ابری غیرفعال است. برای بازگشت به ابر از مسیر کنترل‌شده cloud-migration استفاده کنید."
      );
    }
  }

  // Resolve Android's stable device UUID or a legacy database ID within this tenant.
  const device = await resolveActiveSyncDevice(params.organizationId, params.deviceId);

  await ensureOrgChangeLogBaseline(params.organizationId);

  // Create batch tracking row (idempotent on device_id + client_batch_id)
  let [batch] = await db
    .select()
    .from(syncBatches)
    .where(
      and(
        eq(syncBatches.deviceId, device.id),
        eq(syncBatches.clientBatchId, params.batchId)
      )
    )
    .limit(1);

  if (!batch) {
    [batch] = await db
      .insert(syncBatches)
      .values({
        organizationId: params.organizationId,
        deviceId: device.id,
        clientBatchId: params.batchId,
        eventsCount: params.events.length,
        status: "PROCESSING",
      })
      .returning();
  }

  const results: SyncPushEventResult[] = [];
  const satisfiedIdsInBatch = new Set<string>();
  let appliedCount = 0;
  let conflictCount = 0;
  let rejectedCount = 0;
  let duplicateCount = 0;

  for (const ev of params.events) {
    const entityType = normalizeEntityType(ev.entity_type);
    const operation = normalizeOperation(ev.operation);
    const payloadHash = sha256(
      JSON.stringify({
        entity_type: entityType,
        entity_id: ev.entity_id ?? null,
        operation,
        payload: ev.payload ?? {},
      })
    );

    // Step 5: Per-Event Inbox Idempotency check (organization_id + idempotency_key)
    const [existingInbox] = await db
      .select()
      .from(syncInbox)
      .where(
        and(
          eq(syncInbox.organizationId, params.organizationId),
          eq(syncInbox.idempotencyKey, ev.idempotency_key)
        )
      )
      .limit(1);

    if (existingInbox) {
      if (existingInbox.payloadHash !== payloadHash) {
        rejectedCount += 1;
        results.push({
          event_id: ev.event_id,
          entity_id: ev.entity_id ?? null,
          server_id: existingInbox.entityId ?? null,
          status: "REJECTED",
          entity_version: 0,
          business_status: "REJECTED",
          error: {
            code: "IDEMPOTENCY_KEY_REUSED",
            message: "کلید یکتاسازی (idempotency_key) قبلاً با Payload متفاوتی ارسال شده است.",
          },
        });
        continue;
      }

      duplicateCount += 1;
      const prevRes = existingInbox.resultPayload as unknown as SyncPushEventResult;
      if (prevRes.server_id) satisfiedIdsInBatch.add(prevRes.server_id);
      satisfiedIdsInBatch.add(ev.event_id);
      results.push({
        ...prevRes,
        event_id: ev.event_id,
        status: "DUPLICATE",
      });
      continue;
    }

    // Step 7: Check declared event dependencies
    const deps = ev.dependencies ?? [];
    if (deps.length > 0) {
      const missingDep = await findMissingDependency(
        params.organizationId,
        deps,
        satisfiedIdsInBatch
      );
      if (missingDep) {
        rejectedCount += 1;
        const depRes: SyncPushEventResult = {
          event_id: ev.event_id,
          entity_id: ev.entity_id ?? null,
          server_id: null,
          status: "REJECTED",
          entity_version: 0,
          business_status: "PENDING_SYNC",
          error: {
            code: "DEPENDENCY_NOT_SATISFIED",
            message: `وابستگی (${missingDep}) هنوز در سرور ثبت نشده است.`,
          },
        };
        results.push(depRes);
        continue;
      }
    }

    // Steps 8–15: Execute individual event inside isolated tenant transaction
    let eventResult: SyncPushEventResult;
    try {
      eventResult = await processSingleSyncEvent({
        organizationId: params.organizationId,
        userId: params.userId,
        userEmail: params.userEmail,
        ipAddress: params.ipAddress,
        deviceId: device.id,
        entityType,
        operation,
        ev,
      });
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : null;
      const errCode = apiErr?.code ?? "SYNC_EVENT_FAILED";
      const errMsg = err instanceof Error ? err.message : "خطا در پردازش رویداد Sync";

      // Domain-based Stock Shortage on Sales Confirm -> Capture Formal Conflict!
      if (errCode === "INVENTORY_NEGATIVE_STOCK_BLOCKED" && ev.entity_id && isUuid(ev.entity_id)) {
        const [conflict] = await db
          .insert(syncConflicts)
          .values({
            organizationId: params.organizationId,
            deviceId: device.id,
            entityType,
            entityId: ev.entity_id,
            conflictType: "STOCK_SHORTAGE",
            clientVersion: ev.base_version ?? 1,
            serverVersion: 1,
            clientPayload: ev.payload,
            serverPayload: { reason: errMsg },
            conflictingFields: ["quantity", "warehouse_stock"],
            status: "OPEN",
          })
          .returning();

        eventResult = {
          event_id: ev.event_id,
          entity_id: ev.entity_id,
          server_id: ev.entity_id,
          status: "CONFLICT",
          entity_version: ev.base_version ?? 1,
          business_status: "REJECTED",
          conflict_id: conflict.id,
          error: { code: errCode, message: errMsg },
        };
      } else {
        eventResult = {
          event_id: ev.event_id,
          entity_id: ev.entity_id ?? null,
          server_id: null,
          status: "REJECTED",
          entity_version: 0,
          business_status: "REJECTED",
          error: { code: errCode, message: errMsg },
        };
      }
    }

    if (eventResult.status === "ACCEPTED" || eventResult.status === "CONFIRMED") {
      appliedCount += 1;
      satisfiedIdsInBatch.add(ev.event_id);
      if (eventResult.server_id) satisfiedIdsInBatch.add(eventResult.server_id);
      if (eventResult.entity_id) satisfiedIdsInBatch.add(eventResult.entity_id);
    } else if (eventResult.status === "CONFLICT") {
      conflictCount += 1;
    } else if (eventResult.status === "REJECTED") {
      rejectedCount += 1;
    }

    // Record in Sync Inbox (for idempotent replay on dropped connection!)
    await db
      .insert(syncInbox)
      .values({
        organizationId: params.organizationId,
        deviceId: device.id,
        eventId: ev.event_id,
        idempotencyKey: ev.idempotency_key,
        entityType,
        entityId: isUuid(eventResult.server_id) ? eventResult.server_id : null,
        operation,
        payloadHash,
        resultStatus: eventResult.status,
        resultPayload: eventResult as unknown as Record<string, unknown>,
      })
      .onConflictDoNothing();

    // Record in sync_events history
    await db.insert(syncEvents).values({
      organizationId: params.organizationId,
      batchId: batch.id,
      deviceId: device.id,
      clientEventId: ev.event_id,
      entityType,
      entityId: isUuid(eventResult.server_id) ? eventResult.server_id : null,
      operation,
      baseVersion: ev.base_version ?? 0,
      payload: ev.payload,
      status: eventResult.status,
      errorMessage: eventResult.error?.message ?? null,
    });

    results.push(eventResult);
  }

  // Latest monotonic seq for org
  const [maxSeqRow] = await db
    .select({ maxSeq: sql<number>`COALESCE(MAX(${syncChangeLog.seq}), 0)::int` })
    .from(syncChangeLog)
    .where(eq(syncChangeLog.organizationId, params.organizationId));
  const latestSeq = Number(maxSeqRow?.maxSeq ?? 0);
  const latestCursor = encodeSyncCursor({ seq: latestSeq, orgId: params.organizationId });

  const batchStatus =
    conflictCount > 0 || rejectedCount > 0 ? "PARTIAL" : "COMPLETED";
  await db
    .update(syncBatches)
    .set({
      appliedCount,
      conflictCount,
      rejectedCount,
      status: batchStatus,
    })
    .where(eq(syncBatches.id, batch.id));

  await db
    .update(devices)
    .set({ lastSyncAt: new Date(), updatedAt: new Date() })
    .where(eq(devices.id, device.id));

  // Prompt 04 §21 — Record Telemetry in `sync_logs` (ZERO sensitive payloads!)
  const finishedAt = new Date();
  await db.insert(syncLogs).values({
    organizationId: params.organizationId,
    deviceId: device.id,
    direction: "PUSH",
    startedAt,
    finishedAt,
    pushCount: params.events.length,
    pullCount: 0,
    successCount: appliedCount + duplicateCount,
    failureCount: rejectedCount,
    conflictCount,
    cursorBefore: null,
    cursorAfter: latestCursor,
    errorCode: rejectedCount > 0 ? results.find((r) => r.error)?.error?.code ?? null : null,
    durationMs: Date.now() - startMs,
  });

  await recordAuditLog({
    organizationId: params.organizationId,
    actorUserId: params.userId,
    actorEmail: params.userEmail,
    scope: "ORGANIZATION",
    action: "SYNC_PUSH_PROCESSED",
    entityType: "SYNC_BATCH",
    entityId: batch.id,
    ipAddress: params.ipAddress,
    metadata: {
      deviceId: device.id,
      batchId: params.batchId,
      appliedCount,
      conflictCount,
      rejectedCount,
      duplicateCount,
    },
  });

  return {
    batch_id: params.batchId,
    server_batch_id: batch.id,
    server_checkpoint: latestSeq,
    latest_cursor: latestCursor,
    applied_count: appliedCount,
    conflict_count: conflictCount,
    rejected_count: rejectedCount,
    duplicate_count: duplicateCount,
    results,
  };
}

async function findMissingDependency(
  organizationId: string,
  dependencies: string[],
  satisfiedInBatch: Set<string>
): Promise<string | null> {
  for (const dep of dependencies) {
    if (satisfiedInBatch.has(dep)) continue;
    // Check if event_id already processed in sync_inbox
    const [inInbox] = await db
      .select({ id: syncInbox.id })
      .from(syncInbox)
      .where(
        and(
          eq(syncInbox.organizationId, organizationId),
          eq(syncInbox.eventId, dep),
          inArray(syncInbox.resultStatus, ["ACCEPTED", "CONFIRMED", "DUPLICATE"])
        )
      )
      .limit(1);
    if (inInbox) continue;

    // Check if entity_id exists in sync_change_log
    if (isUuid(dep)) {
      const [inLog] = await db
        .select({ seq: syncChangeLog.seq })
        .from(syncChangeLog)
        .where(
          and(
            eq(syncChangeLog.organizationId, organizationId),
            eq(syncChangeLog.entityId, dep)
          )
        )
        .limit(1);
      if (inLog) continue;
    }
    return dep;
  }
  return null;
}

async function processSingleSyncEvent(params: {
  organizationId: string;
  userId: string;
  userEmail: string;
  ipAddress?: string | null;
  deviceId: string;
  entityType: string;
  operation: string;
  ev: SyncPushEventInput;
}): Promise<SyncPushEventResult> {
  const { organizationId, deviceId, entityType, operation, ev } = params;
  const p = ev.payload ?? {};
  const clientUuid = isUuid(ev.entity_id) ? ev.entity_id : crypto.randomUUID();

  // --------------------------------------------------------------------------
  // 1. CONTACT
  // --------------------------------------------------------------------------
  if (entityType === "contact") {
    return withTenantTransaction(organizationId, async (tx) => {
      if (operation === "CREATE") {
        const displayName = String(p.display_name || p.name || "").trim();
        if (displayName.length < 2) {
          throw new ApiError(422, "VALIDATION_ERROR", "نام نمایشی طرف‌حساب حداقل ۲ کاراکتر است.");
        }
        const code = String(p.code || `C-MOB-${Date.now().toString().slice(-5)}`);
        const [created] = await tx
          .insert(contacts)
          .values({
            id: clientUuid, // Preserves Client UUID!
            organizationId,
            code,
            name: displayName,
            firstName: p.first_name ? String(p.first_name) : null,
            lastName: p.last_name ? String(p.last_name) : null,
            companyName: p.company_name ? String(p.company_name) : null,
            contactType: String(p.type || p.contact_type || p.contactType || "CUSTOMER"),
            nationalCode: p.national_id ? String(p.national_id) : null,
            economicCode: p.economic_code ? String(p.economic_code) : null,
            mobile: p.mobile ? String(p.mobile) : null,
            phone: p.phone ? String(p.phone) : null,
            email: p.email ? String(p.email) : null,
            address: p.address ? String(p.address) : null,
            postalCode: p.postal_code ? String(p.postal_code) : null,
            creditLimit: p.credit_limit ? String(p.credit_limit) : "0.00",
            openingBalance: p.opening_balance ? String(p.opening_balance) : "0.00",
            notes: p.notes ? String(p.notes) : null,
            status: p.is_active === false ? "INACTIVE" : "ACTIVE",
            birthDateEpoch: optionalEpoch(p.birth_date_epoch),
            gender: String(p.gender || "UNSPECIFIED"),
            customerTags: stringArray(p.customer_tags),
            awarenessSource: p.awareness_source ? String(p.awareness_source) : null,
            marketingConsent: p.marketing_consent === true,
            province: p.province ? String(p.province) : null,
            city: p.city ? String(p.city) : null,
            branchLocalId: p.branch_local_id ? String(p.branch_local_id) : null,
            membershipDateEpoch: optionalEpoch(p.membership_date_epoch),
            customerSegment: String(p.customer_segment || "REGULAR"),
            supplierCategory: p.supplier_category ? String(p.supplier_category) : null,
            supplierSettlementMethod: p.supplier_settlement_method ? String(p.supplier_settlement_method) : null,
            supplierPaymentDueDays: Math.max(0, Math.trunc(Number(p.supplier_payment_due_days) || 0)),
            supplierDeliveryLeadTimeDays: Math.max(0, Math.trunc(Number(p.supplier_delivery_lead_time_days) || 0)),
            supplierBankName: p.supplier_bank_name ? String(p.supplier_bank_name) : null,
            supplierCardNumber: p.supplier_card_number ? String(p.supplier_card_number) : null,
            supplierSheba: p.supplier_sheba ? String(p.supplier_sheba) : null,
            supplierBankAccountNumber: p.supplier_bank_account_number ? String(p.supplier_bank_account_number) : null,
            version: 1,
            syncSeq: Date.now(),
          })
          .returning();

        await appendSyncChangeLog(tx, {
          organizationId,
          entityType: "contact",
          entityId: created.id,
          operation: "UPSERT",
          version: created.version,
          sourceDeviceId: deviceId,
          payload: contactSyncPayload(created),
        });

        return {
          event_id: ev.event_id,
          entity_id: clientUuid,
          server_id: created.id,
          status: "ACCEPTED",
          entity_version: created.version,
          business_status: "CONFIRMED",
          error: null,
        };
      }

      if (operation === "UPDATE") {
        const [srv] = await tx
          .select()
          .from(contacts)
          .where(and(eq(contacts.id, clientUuid), eq(contacts.organizationId, organizationId)))
          .limit(1);
        if (!srv) throw new ApiError(404, "CONTACT_NOT_FOUND", "طرف‌حساب در سرور یافت نشد.");

        const serverSnap = contactSyncPayload(srv);
        const normalizedClient: Record<string, unknown> = {};
        if (p.display_name !== undefined || p.name !== undefined) {
          normalizedClient.display_name = String(p.display_name ?? p.name);
        }
        if (p.mobile !== undefined) normalizedClient.mobile = String(p.mobile);
        if (p.credit_limit !== undefined || p.creditLimit !== undefined) {
          normalizedClient.credit_limit = String(p.credit_limit ?? p.creditLimit);
        }
        if (p.notes !== undefined) normalizedClient.notes = String(p.notes);
        if (p.first_name !== undefined) normalizedClient.first_name = p.first_name === null ? null : String(p.first_name);
        if (p.last_name !== undefined) normalizedClient.last_name = p.last_name === null ? null : String(p.last_name);
        if (p.company_name !== undefined) normalizedClient.company_name = p.company_name === null ? null : String(p.company_name);
        if (p.national_id !== undefined) normalizedClient.national_id = p.national_id === null ? null : String(p.national_id);
        if (p.economic_code !== undefined) normalizedClient.economic_code = p.economic_code === null ? null : String(p.economic_code);
        if (p.phone !== undefined) normalizedClient.phone = p.phone === null ? null : String(p.phone);
        if (p.email !== undefined) normalizedClient.email = p.email === null ? null : String(p.email);
        if (p.address !== undefined) normalizedClient.address = p.address === null ? null : String(p.address);
        if (p.postal_code !== undefined) normalizedClient.postal_code = p.postal_code === null ? null : String(p.postal_code);
        if (p.opening_balance !== undefined) normalizedClient.opening_balance = String(p.opening_balance);
        if (p.is_active !== undefined) normalizedClient.is_active = Boolean(p.is_active);
        if (p.birth_date_epoch !== undefined) normalizedClient.birth_date_epoch = optionalEpoch(p.birth_date_epoch);
        if (p.gender !== undefined) normalizedClient.gender = String(p.gender);
        if (p.customer_tags !== undefined) normalizedClient.customer_tags = stringArray(p.customer_tags);
        if (p.awareness_source !== undefined) normalizedClient.awareness_source = p.awareness_source === null ? null : String(p.awareness_source);
        if (p.marketing_consent !== undefined) normalizedClient.marketing_consent = Boolean(p.marketing_consent);
        if (p.province !== undefined) normalizedClient.province = p.province === null ? null : String(p.province);
        if (p.city !== undefined) normalizedClient.city = p.city === null ? null : String(p.city);
        if (p.branch_local_id !== undefined) normalizedClient.branch_local_id = p.branch_local_id === null ? null : String(p.branch_local_id);
        if (p.membership_date_epoch !== undefined) normalizedClient.membership_date_epoch = optionalEpoch(p.membership_date_epoch);
        if (p.customer_segment !== undefined) normalizedClient.customer_segment = String(p.customer_segment);
        if (p.supplier_category !== undefined) normalizedClient.supplier_category = p.supplier_category === null ? null : String(p.supplier_category);
        if (p.supplier_settlement_method !== undefined) normalizedClient.supplier_settlement_method = p.supplier_settlement_method === null ? null : String(p.supplier_settlement_method);
        if (p.supplier_payment_due_days !== undefined) normalizedClient.supplier_payment_due_days = Math.max(0, Math.trunc(Number(p.supplier_payment_due_days) || 0));
        if (p.supplier_delivery_lead_time_days !== undefined) normalizedClient.supplier_delivery_lead_time_days = Math.max(0, Math.trunc(Number(p.supplier_delivery_lead_time_days) || 0));
        if (p.supplier_bank_name !== undefined) normalizedClient.supplier_bank_name = p.supplier_bank_name === null ? null : String(p.supplier_bank_name);
        if (p.supplier_card_number !== undefined) normalizedClient.supplier_card_number = p.supplier_card_number === null ? null : String(p.supplier_card_number);
        if (p.supplier_sheba !== undefined) normalizedClient.supplier_sheba = p.supplier_sheba === null ? null : String(p.supplier_sheba);
        if (p.supplier_bank_account_number !== undefined) normalizedClient.supplier_bank_account_number = p.supplier_bank_account_number === null ? null : String(p.supplier_bank_account_number);

        const baseVer = ev.base_version ?? 0;
        if (srv.version > baseVer) {
          const conflictingFields = detectConflictingFields(normalizedClient, serverSnap);
          if (conflictingFields.length > 0) {
            const [conflict] = await tx
              .insert(syncConflicts)
              .values({
                organizationId,
                deviceId,
                entityType: "contact",
                entityId: srv.id,
                conflictType: "VERSION_MISMATCH",
                clientVersion: baseVer,
                serverVersion: srv.version,
                clientPayload: normalizedClient,
                serverPayload: serverSnap,
                conflictingFields,
                status: "OPEN",
              })
              .returning();

            return {
              event_id: ev.event_id,
              entity_id: srv.id,
              server_id: srv.id,
              status: "CONFLICT",
              entity_version: srv.version,
              business_status: "CONFLICT",
              conflict_id: conflict.id,
              error: {
                code: "VERSION_CONFLICT",
                message: `تعارض هم‌زمان در فیلدهای [${conflictingFields.join(", ")}] — نسخه سرور (${srv.version}) جدیدتر از مبنا (${baseVer}) است.`,
              },
            };
          }
        }

        const [updated] = await tx
          .update(contacts)
          .set({
            ...(normalizedClient.display_name ? { name: String(normalizedClient.display_name) } : {}),
            ...(normalizedClient.mobile !== undefined ? { mobile: String(normalizedClient.mobile) } : {}),
            ...(normalizedClient.credit_limit ? { creditLimit: String(normalizedClient.credit_limit) } : {}),
            ...(normalizedClient.notes !== undefined ? { notes: String(normalizedClient.notes) } : {}),
            ...(normalizedClient.first_name !== undefined ? { firstName: normalizedClient.first_name as string | null } : {}),
            ...(normalizedClient.last_name !== undefined ? { lastName: normalizedClient.last_name as string | null } : {}),
            ...(normalizedClient.company_name !== undefined ? { companyName: normalizedClient.company_name as string | null } : {}),
            ...(normalizedClient.national_id !== undefined ? { nationalCode: normalizedClient.national_id as string | null } : {}),
            ...(normalizedClient.economic_code !== undefined ? { economicCode: normalizedClient.economic_code as string | null } : {}),
            ...(normalizedClient.phone !== undefined ? { phone: normalizedClient.phone as string | null } : {}),
            ...(normalizedClient.email !== undefined ? { email: normalizedClient.email as string | null } : {}),
            ...(normalizedClient.address !== undefined ? { address: normalizedClient.address as string | null } : {}),
            ...(normalizedClient.postal_code !== undefined ? { postalCode: normalizedClient.postal_code as string | null } : {}),
            ...(normalizedClient.opening_balance !== undefined ? { openingBalance: String(normalizedClient.opening_balance) } : {}),
            ...(normalizedClient.is_active !== undefined ? { status: normalizedClient.is_active ? "ACTIVE" : "INACTIVE" } : {}),
            ...(normalizedClient.birth_date_epoch !== undefined ? { birthDateEpoch: normalizedClient.birth_date_epoch as number | null } : {}),
            ...(normalizedClient.gender !== undefined ? { gender: String(normalizedClient.gender) } : {}),
            ...(normalizedClient.customer_tags !== undefined ? { customerTags: normalizedClient.customer_tags as string[] } : {}),
            ...(normalizedClient.awareness_source !== undefined ? { awarenessSource: normalizedClient.awareness_source as string | null } : {}),
            ...(normalizedClient.marketing_consent !== undefined ? { marketingConsent: Boolean(normalizedClient.marketing_consent) } : {}),
            ...(normalizedClient.province !== undefined ? { province: normalizedClient.province as string | null } : {}),
            ...(normalizedClient.city !== undefined ? { city: normalizedClient.city as string | null } : {}),
            ...(normalizedClient.branch_local_id !== undefined ? { branchLocalId: normalizedClient.branch_local_id as string | null } : {}),
            ...(normalizedClient.membership_date_epoch !== undefined ? { membershipDateEpoch: normalizedClient.membership_date_epoch as number | null } : {}),
            ...(normalizedClient.customer_segment !== undefined ? { customerSegment: String(normalizedClient.customer_segment) } : {}),
            ...(normalizedClient.supplier_category !== undefined ? { supplierCategory: normalizedClient.supplier_category as string | null } : {}),
            ...(normalizedClient.supplier_settlement_method !== undefined ? { supplierSettlementMethod: normalizedClient.supplier_settlement_method as string | null } : {}),
            ...(normalizedClient.supplier_payment_due_days !== undefined ? { supplierPaymentDueDays: Number(normalizedClient.supplier_payment_due_days) } : {}),
            ...(normalizedClient.supplier_delivery_lead_time_days !== undefined ? { supplierDeliveryLeadTimeDays: Number(normalizedClient.supplier_delivery_lead_time_days) } : {}),
            ...(normalizedClient.supplier_bank_name !== undefined ? { supplierBankName: normalizedClient.supplier_bank_name as string | null } : {}),
            ...(normalizedClient.supplier_card_number !== undefined ? { supplierCardNumber: normalizedClient.supplier_card_number as string | null } : {}),
            ...(normalizedClient.supplier_sheba !== undefined ? { supplierSheba: normalizedClient.supplier_sheba as string | null } : {}),
            ...(normalizedClient.supplier_bank_account_number !== undefined ? { supplierBankAccountNumber: normalizedClient.supplier_bank_account_number as string | null } : {}),
            version: srv.version + 1,
            syncSeq: Date.now(),
            updatedAt: new Date(),
          })
          .where(eq(contacts.id, srv.id))
          .returning();

        await appendSyncChangeLog(tx, {
          organizationId,
          entityType: "contact",
          entityId: updated.id,
          operation: "UPSERT",
          version: updated.version,
          sourceDeviceId: deviceId,
          payload: contactSyncPayload(updated),
        });

        return {
          event_id: ev.event_id,
          entity_id: updated.id,
          server_id: updated.id,
          status: "ACCEPTED",
          entity_version: updated.version,
          business_status: "CONFIRMED",
          error: null,
        };
      }

      if (operation === "DELETE") {
        // Tombstone soft delete (never physically delete synced records!)
        const [srv] = await tx
          .select()
          .from(contacts)
          .where(and(eq(contacts.id, clientUuid), eq(contacts.organizationId, organizationId)))
          .limit(1);
        if (!srv) throw new ApiError(404, "CONTACT_NOT_FOUND", "طرف‌حساب جهت حذف یافت نشد.");

        const [tomb] = await tx
          .update(contacts)
          .set({
            deletedAt: new Date(),
            status: "ARCHIVED",
            version: srv.version + 1,
            syncSeq: Date.now(),
            updatedAt: new Date(),
          })
          .where(eq(contacts.id, srv.id))
          .returning();

        await appendSyncChangeLog(tx, {
          organizationId,
          entityType: "contact",
          entityId: tomb.id,
          operation: "TOMBSTONE",
          version: tomb.version,
          sourceDeviceId: deviceId,
          payload: { id: tomb.id, is_deleted: true },
        });

        return {
          event_id: ev.event_id,
          entity_id: tomb.id,
          server_id: tomb.id,
          status: "ACCEPTED",
          entity_version: tomb.version,
          business_status: "CANCELLED",
          error: null,
        };
      }

      throw new ApiError(422, "UNSUPPORTED_OPERATION", `عملیات ${operation} برای contact پشتیبانی نمی‌شود.`);
    });
  }

  if (entityType === "loyalty_transaction" && operation === "CREATE") {
    return withTenantTransaction(organizationId, async (tx) => {
      const contactId = isUuid(p.contact_id) ? String(p.contact_id) : "";
      const txType = String(p.tx_type || "").toUpperCase();
      const pointsDelta = Number(p.points_delta);
      const allowedTypes = new Set(["EARN", "REDEEM", "ADJUST", "EXPIRE", "REFERRAL"]);
      if (!contactId || !allowedTypes.has(txType) || !Number.isSafeInteger(pointsDelta) || pointsDelta === 0) {
        throw new ApiError(422, "LOYALTY_TRANSACTION_INVALID", "نوع تراکنش و تعداد صحیح امتیاز معتبر نیست.");
      }
      if ((txType === "REDEEM" || txType === "EXPIRE") && pointsDelta > 0) {
        throw new ApiError(422, "LOYALTY_TRANSACTION_INVALID", "مصرف یا انقضای امتیاز باید از موجودی کم کند.");
      }
      if ((txType === "EARN" || txType === "REFERRAL") && pointsDelta < 0) {
        throw new ApiError(422, "LOYALTY_TRANSACTION_INVALID", "کسب امتیاز باید به موجودی اضافه کند.");
      }

      const [contact] = await tx
        .select()
        .from(contacts)
        .where(and(eq(contacts.id, contactId), eq(contacts.organizationId, organizationId)))
        .limit(1);
      if (!contact || !["CUSTOMER", "BOTH"].includes(contact.contactType)) {
        throw new ApiError(404, "LOYALTY_CUSTOMER_NOT_FOUND", "مشتری در این سازمان یافت نشد.");
      }

      const [duplicate] = await tx
        .select()
        .from(loyaltyTransactions)
        .where(and(eq(loyaltyTransactions.id, clientUuid), eq(loyaltyTransactions.organizationId, organizationId)))
        .limit(1);
      if (duplicate) {
        return { event_id: ev.event_id, entity_id: duplicate.id, server_id: duplicate.id, status: "ACCEPTED", entity_version: 1, business_status: "CONFIRMED", error: null };
      }

      let [account] = await tx
        .select()
        .from(loyaltyAccounts)
        .where(and(eq(loyaltyAccounts.organizationId, organizationId), eq(loyaltyAccounts.contactId, contactId)))
        .limit(1);
      if (!account) {
        [account] = await tx
          .insert(loyaltyAccounts)
          .values({ organizationId, contactId, tier: "BRONZE" })
          .returning();
      }

      const history = await tx
        .select({ pointsDelta: loyaltyTransactions.pointsDelta })
        .from(loyaltyTransactions)
        .where(and(eq(loyaltyTransactions.organizationId, organizationId), eq(loyaltyTransactions.contactId, contactId)));
      const currentBalance = history.reduce((sum, row) => sum + row.pointsDelta, 0);
      if (currentBalance + pointsDelta < 0) {
        throw new ApiError(422, "INSUFFICIENT_LOYALTY_POINTS", `امتیاز کافی نیست (موجود: ${currentBalance}).`);
      }

      const createdAtEpoch = optionalEpoch(p.created_at_epoch);
      const createdAt = createdAtEpoch ? new Date(createdAtEpoch) : new Date();
      const [saved] = await tx
        .insert(loyaltyTransactions)
        .values({
          id: clientUuid,
          organizationId,
          loyaltyAccountId: account.id,
          contactId,
          txType,
          pointsDelta,
          referenceType: isUuid(p.reference_id) ? "DOCUMENT" : null,
          referenceId: isUuid(p.reference_id) ? String(p.reference_id) : null,
          description: String(p.description || "").slice(0, 2000),
          createdBy: userId,
          createdAt,
        })
        .returning();

      const nextBalance = currentBalance + pointsDelta;
      const [configuredTier] = await tx
        .select()
        .from(loyaltyMembershipTiers)
        .where(and(eq(loyaltyMembershipTiers.organizationId, organizationId), eq(loyaltyMembershipTiers.isActive, true)))
        .orderBy(desc(loyaltyMembershipTiers.minimumPoints));
      const tiers = await tx
        .select()
        .from(loyaltyMembershipTiers)
        .where(and(eq(loyaltyMembershipTiers.organizationId, organizationId), eq(loyaltyMembershipTiers.isActive, true)));
      const matchedTier = tiers
        .filter((tier) => !tier.deletedAt && Number(tier.minimumPoints) <= nextBalance)
        .sort((a, b) => Number(b.minimumPoints) - Number(a.minimumPoints))[0];
      const fallbackTier = configuredTier && Number(configuredTier.minimumPoints) <= nextBalance
        ? configuredTier.name
        : nextBalance >= 1000 ? "GOLD" : nextBalance >= 300 ? "SILVER" : "BRONZE";
      await tx.update(loyaltyAccounts).set({ tier: (matchedTier?.name ?? fallbackTier).slice(0, 24) }).where(eq(loyaltyAccounts.id, account.id));

      await appendSyncChangeLog(tx, {
        organizationId,
        entityType: "loyalty_transaction",
        entityId: saved.id,
        operation: "UPSERT",
        version: 1,
        sourceDeviceId: deviceId,
        payload: {
          id: saved.id,
          organization_id: organizationId,
          contact_id: contactId,
          tx_type: saved.txType,
          points_delta: saved.pointsDelta,
          reference_id: saved.referenceId,
          description: saved.description,
          created_at_epoch: saved.createdAt.getTime(),
        },
      });
      return { event_id: ev.event_id, entity_id: saved.id, server_id: saved.id, status: "ACCEPTED", entity_version: 1, business_status: "CONFIRMED", error: null };
    });
  }

  if (entityType === "loyalty_tier") {
    return withTenantTransaction(organizationId, async (tx) => {
      const [existing] = await tx
        .select()
        .from(loyaltyMembershipTiers)
        .where(and(eq(loyaltyMembershipTiers.id, clientUuid), eq(loyaltyMembershipTiers.organizationId, organizationId)))
        .limit(1);
      const now = new Date();
      if (operation === "DELETE") {
        if (!existing) throw new ApiError(404, "LOYALTY_TIER_NOT_FOUND", "سطح عضویت در سرور یافت نشد.");
        const [deleted] = await tx
          .update(loyaltyMembershipTiers)
          .set({ isActive: false, deletedAt: now, version: existing.version + 1, syncSeq: Date.now(), updatedAt: now })
          .where(eq(loyaltyMembershipTiers.id, existing.id))
          .returning();
        await appendSyncChangeLog(tx, {
          organizationId,
          entityType: "loyalty_tier",
          entityId: deleted.id,
          operation: "TOMBSTONE",
          version: deleted.version,
          sourceDeviceId: deviceId,
          payload: { id: deleted.id, is_deleted: true },
        });
        return { event_id: ev.event_id, entity_id: deleted.id, server_id: deleted.id, status: "ACCEPTED", entity_version: deleted.version, business_status: "CANCELLED", error: null };
      }

      if (operation !== "CREATE" && operation !== "UPDATE") {
        throw new ApiError(422, "UNSUPPORTED_OPERATION", `عملیات ${operation} برای loyalty_tier پشتیبانی نمی‌شود.`);
      }
      const name = String(p.name || "").trim();
      const minimumPoints = String(p.minimum_points ?? "0");
      if (name.length < 2 || name.length > 80 || !Number.isFinite(Number(minimumPoints)) || Number(minimumPoints) < 0) {
        throw new ApiError(422, "VALIDATION_ERROR", "نام سطح عضویت و حداقل امتیاز معتبر نیست.");
      }
      const colorHex = String(p.color_hex || "#78909C");
      if (!/^#[0-9a-fA-F]{6}$/.test(colorHex)) throw new ApiError(422, "VALIDATION_ERROR", "رنگ سطح عضویت معتبر نیست.");
      if (operation === "UPDATE" && !existing) throw new ApiError(404, "LOYALTY_TIER_NOT_FOUND", "سطح عضویت جهت ویرایش یافت نشد.");

      const values = {
        name,
        minimumPoints,
        colorHex,
        isActive: p.is_active !== false,
        deletedAt: null,
        version: (existing?.version ?? 0) + 1,
        syncSeq: Date.now(),
        updatedAt: now,
      };
      const [saved] = existing
        ? await tx.update(loyaltyMembershipTiers).set(values).where(eq(loyaltyMembershipTiers.id, existing.id)).returning()
        : await tx.insert(loyaltyMembershipTiers).values({ id: clientUuid, organizationId, ...values }).returning();
      await appendSyncChangeLog(tx, {
        organizationId,
        entityType: "loyalty_tier",
        entityId: saved.id,
        operation: "UPSERT",
        version: saved.version,
        sourceDeviceId: deviceId,
        payload: { id: saved.id, organization_id: organizationId, name: saved.name, minimum_points: saved.minimumPoints, color_hex: saved.colorHex, is_active: saved.isActive },
      });
      return { event_id: ev.event_id, entity_id: saved.id, server_id: saved.id, status: "ACCEPTED", entity_version: saved.version, business_status: "CONFIRMED", error: null };
    });
  }

  if (entityType === "loyalty_program_settings") {
    return withTenantTransaction(organizationId, async (tx) => {
      if (operation !== "CREATE" && operation !== "UPDATE") {
        throw new ApiError(422, "UNSUPPORTED_OPERATION", `عملیات ${operation} برای تنظیمات باشگاه مشتریان پشتیبانی نمی‌شود.`);
      }
      const amount = String(p.purchase_amount_per_point ?? "1000000");
      if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
        throw new ApiError(422, "VALIDATION_ERROR", "مبلغ لازم برای کسب یک امتیاز باید بیشتر از صفر باشد.");
      }
      const [existing] = await tx
        .select()
        .from(loyaltyProgramSettings)
        .where(eq(loyaltyProgramSettings.organizationId, organizationId))
        .limit(1);
      const now = new Date();
      const values = { purchaseAmountPerPoint: amount, version: (existing?.version ?? 0) + 1, syncSeq: Date.now(), updatedAt: now };
      const [saved] = existing
        ? await tx.update(loyaltyProgramSettings).set(values).where(eq(loyaltyProgramSettings.id, existing.id)).returning()
        : await tx.insert(loyaltyProgramSettings).values({ id: clientUuid, organizationId, ...values }).returning();
      await appendSyncChangeLog(tx, {
        organizationId,
        entityType: "loyalty_program_settings",
        entityId: saved.id,
        operation: "UPSERT",
        version: saved.version,
        sourceDeviceId: deviceId,
        payload: { id: saved.id, organization_id: organizationId, purchase_amount_per_point: saved.purchaseAmountPerPoint },
      });
      return { event_id: ev.event_id, entity_id: saved.id, server_id: saved.id, status: "ACCEPTED", entity_version: saved.version, business_status: "CONFIRMED", error: null };
    });
  }

  // --------------------------------------------------------------------------
  // 2. PRODUCT
  // --------------------------------------------------------------------------
  if (entityType === "product") {
    return withTenantTransaction(organizationId, async (tx) => {
      if (operation === "CREATE") {
        const [defUnit] = await tx
          .select()
          .from(units)
          .where(eq(units.organizationId, organizationId))
          .limit(1);
        if (!defUnit) throw new ApiError(422, "UNIT_NOT_FOUND", "واحد اندازه‌گیری پایه یافت نشد.");

        const [created] = await tx
          .insert(products)
          .values({
            id: clientUuid,
            organizationId,
            baseUnitId: isUuid(p.base_unit_id) ? p.base_unit_id : defUnit.id,
            sku: String(p.code || p.sku || `SKU-MOB-${Date.now().toString().slice(-5)}`),
            name: String(p.name || "کالای آفلاین"),
            defaultPurchasePrice: String(p.purchase_price || p.defaultPurchasePrice || "0.00"),
            defaultSalePrice: String(p.sale_price || p.defaultSalePrice || "0.00"),
            version: 1,
            syncSeq: Date.now(),
          })
          .returning();

        await appendSyncChangeLog(tx, {
          organizationId,
          entityType: "product",
          entityId: created.id,
          operation: "UPSERT",
          version: created.version,
          sourceDeviceId: deviceId,
          payload: {
            id: created.id,
            code: created.sku,
            name: created.name,
            purchase_price: created.defaultPurchasePrice,
            sale_price: created.defaultSalePrice,
            is_active: true,
          },
        });

        return {
          event_id: ev.event_id,
          entity_id: clientUuid,
          server_id: created.id,
          status: "ACCEPTED",
          entity_version: created.version,
          business_status: "CONFIRMED",
          error: null,
        };
      }

      if (operation === "UPDATE") {
        const [srv] = await tx
          .select()
          .from(products)
          .where(and(eq(products.id, clientUuid), eq(products.organizationId, organizationId)))
          .limit(1);
        if (!srv) throw new ApiError(404, "PRODUCT_NOT_FOUND", "کالا در سرور یافت نشد.");

        const serverSnap = {
          name: srv.name,
          sale_price: srv.defaultSalePrice,
          purchase_price: srv.defaultPurchasePrice,
        };
        const clientSnap: Record<string, unknown> = {};
        if (p.name !== undefined) clientSnap.name = String(p.name);
        if (p.sale_price !== undefined || p.defaultSalePrice !== undefined) {
          clientSnap.sale_price = String(p.sale_price ?? p.defaultSalePrice);
        }
        if (p.purchase_price !== undefined || p.defaultPurchasePrice !== undefined) {
          clientSnap.purchase_price = String(p.purchase_price ?? p.defaultPurchasePrice);
        }

        const baseVer = ev.base_version ?? 0;
        if (srv.version > baseVer) {
          const conflictingFields = detectConflictingFields(clientSnap, serverSnap);
          if (conflictingFields.length > 0) {
            const [conflict] = await tx
              .insert(syncConflicts)
              .values({
                organizationId,
                deviceId,
                entityType: "product",
                entityId: srv.id,
                conflictType: "VERSION_MISMATCH",
                clientVersion: baseVer,
                serverVersion: srv.version,
                clientPayload: clientSnap,
                serverPayload: serverSnap,
                conflictingFields,
                status: "OPEN",
              })
              .returning();

            return {
              event_id: ev.event_id,
              entity_id: srv.id,
              server_id: srv.id,
              status: "CONFLICT",
              entity_version: srv.version,
              business_status: "CONFLICT",
              conflict_id: conflict.id,
              error: {
                code: "VERSION_CONFLICT",
                message: `تعارض نسخه در کالا روی فیلدهای [${conflictingFields.join(", ")}]`,
              },
            };
          }
        }

        const [upd] = await tx
          .update(products)
          .set({
            ...(clientSnap.name ? { name: String(clientSnap.name) } : {}),
            ...(clientSnap.sale_price ? { defaultSalePrice: String(clientSnap.sale_price) } : {}),
            ...(clientSnap.purchase_price ? { defaultPurchasePrice: String(clientSnap.purchase_price) } : {}),
            version: srv.version + 1,
            syncSeq: Date.now(),
            updatedAt: new Date(),
          })
          .where(eq(products.id, srv.id))
          .returning();

        await appendSyncChangeLog(tx, {
          organizationId,
          entityType: "product",
          entityId: upd.id,
          operation: "UPSERT",
          version: upd.version,
          sourceDeviceId: deviceId,
          payload: {
            id: upd.id,
            code: upd.sku,
            name: upd.name,
            purchase_price: upd.defaultPurchasePrice,
            sale_price: upd.defaultSalePrice,
            is_active: upd.isActive,
          },
        });

        return {
          event_id: ev.event_id,
          entity_id: upd.id,
          server_id: upd.id,
          status: "ACCEPTED",
          entity_version: upd.version,
          business_status: "CONFIRMED",
          error: null,
        };
      }

      if (operation === "DELETE") {
        const [srv] = await tx
          .select()
          .from(products)
          .where(and(eq(products.id, clientUuid), eq(products.organizationId, organizationId)))
          .limit(1);
        if (!srv) throw new ApiError(404, "PRODUCT_NOT_FOUND", "کالا یافت نشد.");

        const [tomb] = await tx
          .update(products)
          .set({ deletedAt: new Date(), isActive: false, version: srv.version + 1, syncSeq: Date.now() })
          .where(eq(products.id, srv.id))
          .returning();

        await appendSyncChangeLog(tx, {
          organizationId,
          entityType: "product",
          entityId: tomb.id,
          operation: "TOMBSTONE",
          version: tomb.version,
          sourceDeviceId: deviceId,
          payload: { id: tomb.id, is_deleted: true },
        });

        return {
          event_id: ev.event_id,
          entity_id: tomb.id,
          server_id: tomb.id,
          status: "ACCEPTED",
          entity_version: tomb.version,
          business_status: "CANCELLED",
          error: null,
        };
      }

      throw new ApiError(422, "UNSUPPORTED_OPERATION", `عملیات ${operation} برای product پشتیبانی نمی‌شود.`);
    });
  }

  // --------------------------------------------------------------------------
  // 3. PURCHASE DOCUMENT (Local Draft CREATE -> Server Authoritative CONFIRM)
  // --------------------------------------------------------------------------
  if (entityType === "purchase") {
    if (operation === "CREATE") {
      return withTenantTransaction(organizationId, async (tx) => {
        const supplierId = String(p.supplier_id || p.contact_id || "");
        const warehouseId = String(p.warehouse_id || "");
        if (p.document_type && String(p.document_type).toUpperCase() !== "PURCHASE_INVOICE") {
          throw new ApiError(422, "UNSUPPORTED_DOCUMENT_TYPE", "همگام‌سازی خرید فقط فاکتور خرید را می‌پذیرد.");
        }
        const prepared = prepareOfflineInvoice(p);
        if (!isUuid(supplierId) || !isUuid(warehouseId) || prepared.items.length === 0) {
          throw new ApiError(422, "VALIDATION_ERROR", "اطلاعات خرید آفلاین (supplier_id, warehouse_id, items) ناقص است.");
        }

        const docNum = String(p.document_number || `PI-OFF-${Date.now().toString().slice(-6)}`);
        const [inv] = await tx
          .insert(purchaseInvoices)
          .values({
            id: clientUuid,
            clientDocumentId: clientUuid,
            organizationId,
            contactId: supplierId,
            warehouseId,
            invoiceNumber: docNum,
            invoiceDate: String(p.document_date || new Date().toISOString().slice(0, 10)),
            currency: String(p.currency || "IRR"),
            exchangeRate: String(p.exchange_rate || "1.0000"),
            subtotal: prepared.subtotal,
            discountAmount: prepared.discountTotal,
            taxAmount: prepared.taxTotal,
            shippingCost: prepared.shippingCost,
            otherCosts: prepared.otherCosts,
            totalAmount: prepared.grandTotal,
            paidAmount: "0.00",
            remainingAmount: prepared.grandTotal,
            relatedDocumentId: isUuid(p.related_document_id) ? String(p.related_document_id) : null,
            relatedDocumentType: p.related_document_type ? String(p.related_document_type) : null,
            receiptUrl: p.receipt_url ? String(p.receipt_url) : null,
            // Android CANNOT directly confirm — server creates as DRAFT!
            status: "DRAFT",
            notes: p.notes ? String(p.notes) : "ثبت‌شده در حالت آفلاین اندروید",
            createdBy: params.userId,
            version: 1,
            syncSeq: Date.now(),
          })
          .returning();

        await tx.insert(purchaseInvoiceItems).values(
          prepared.items.map((it) => ({
            ...(isUuid(it.clientItemId) ? { id: it.clientItemId } : {}),
            organizationId,
            purchaseInvoiceId: inv.id,
            productId: it.productId,
            variantId: it.variantId,
            quantity: it.quantity,
            unitPrice: it.unitPrice,
            discountAmount: it.discountAmount,
            taxRate: it.taxRate,
            taxAmount: it.taxAmount,
            lineTotal: it.lineTotal,
          }))
        );

        await appendSyncChangeLog(tx, {
          organizationId,
          entityType: "purchase",
          entityId: inv.id,
          operation: "UPSERT",
          version: inv.version,
          sourceDeviceId: deviceId,
          payload: {
            id: inv.id,
            document_number: inv.invoiceNumber,
            supplier_id: inv.contactId,
            grand_total: inv.totalAmount,
            status: "DRAFT",
          },
        });

        return {
          event_id: ev.event_id,
          entity_id: clientUuid,
          server_id: inv.id,
          status: "ACCEPTED",
          entity_version: inv.version,
          business_status: "DRAFT",
          error: null,
        };
      });
    }

    if (operation === "UPDATE") {
      return withTenantTransaction(organizationId, async (tx) => {
        const [existing] = await tx.select().from(purchaseInvoices).where(and(
          eq(purchaseInvoices.id, clientUuid),
          eq(purchaseInvoices.organizationId, organizationId)
        )).limit(1);
        if (!existing) throw new ApiError(404, "INVOICE_NOT_FOUND", "پیش‌نویس خرید برای بروزرسانی یافت نشد.");
        if (existing.status !== "DRAFT") throw new ApiError(409, "INVOICE_ALREADY_FINALIZED", "فقط پیش‌نویس خرید قابل ویرایش است.");
        const supplierId = String(p.supplier_id || p.contact_id || "");
        const warehouseId = String(p.warehouse_id || "");
        if (!isUuid(supplierId) || !isUuid(warehouseId)) throw new ApiError(422, "VALIDATION_ERROR", "تأمین‌کننده یا انبار فاکتور خرید معتبر نیست.");
        const prepared = prepareOfflineInvoice(p);
        const [updated] = await tx.update(purchaseInvoices).set({
          contactId: supplierId,
          warehouseId,
          invoiceNumber: String(p.document_number || existing.invoiceNumber),
          invoiceDate: String(p.document_date || existing.invoiceDate),
          currency: String(p.currency || existing.currency),
          exchangeRate: String(p.exchange_rate || existing.exchangeRate),
          subtotal: prepared.subtotal,
          discountAmount: prepared.discountTotal,
          taxAmount: prepared.taxTotal,
          shippingCost: prepared.shippingCost,
          otherCosts: prepared.otherCosts,
          totalAmount: prepared.grandTotal,
          paidAmount: "0.00",
          remainingAmount: prepared.grandTotal,
          relatedDocumentId: isUuid(p.related_document_id) ? String(p.related_document_id) : null,
          relatedDocumentType: p.related_document_type ? String(p.related_document_type) : null,
          notes: p.notes ? String(p.notes) : null,
          version: existing.version + 1,
          syncSeq: Date.now(),
          updatedAt: new Date(),
        }).where(eq(purchaseInvoices.id, existing.id)).returning();
        await tx.delete(purchaseInvoiceItems).where(eq(purchaseInvoiceItems.purchaseInvoiceId, existing.id));
        await tx.insert(purchaseInvoiceItems).values(prepared.items.map((item) => ({
          ...(isUuid(item.clientItemId) ? { id: item.clientItemId } : {}),
          organizationId,
          purchaseInvoiceId: updated.id,
          productId: item.productId,
          variantId: item.variantId,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          discountAmount: item.discountAmount,
          taxRate: item.taxRate,
          taxAmount: item.taxAmount,
          lineTotal: item.lineTotal,
        })));
        await appendSyncChangeLog(tx, {
          organizationId,
          entityType: "purchase",
          entityId: updated.id,
          operation: "UPSERT",
          version: updated.version,
          sourceDeviceId: deviceId,
          payload: { id: updated.id, document_number: updated.invoiceNumber, grand_total: updated.totalAmount, status: "DRAFT" },
        });
        return { event_id: ev.event_id, entity_id: updated.id, server_id: updated.id, status: "ACCEPTED", entity_version: updated.version, business_status: "DRAFT", error: null };
      });
    }

    if (operation === "CONFIRM") {
      const finalized = await finalizePurchaseInvoice({
        organizationId,
        invoiceId: clientUuid,
        actorUserId: params.userId,
        actorEmail: params.userEmail,
        ipAddress: params.ipAddress,
        paymentAllocations: parseSyncPaymentAllocations(p),
      });

      await appendSyncChangeLog(db, {
        organizationId,
        entityType: "purchase",
        entityId: finalized.invoice.id,
        operation: "UPSERT",
        version: finalized.invoice.version,
        sourceDeviceId: deviceId,
        payload: {
          id: finalized.invoice.id,
          document_number: finalized.invoice.invoiceNumber,
          grand_total: finalized.invoice.totalAmount,
          status: "CONFIRMED",
          stock_document_id: finalized.stockDocument.id,
          journal_entry_id: finalized.journalEntry.id,
        },
      });

      return {
        event_id: ev.event_id,
        entity_id: finalized.invoice.id,
        server_id: finalized.invoice.id,
        status: "CONFIRMED",
        entity_version: finalized.invoice.version,
        business_status: "CONFIRMED",
        error: null,
      };
    }
  }

  // --------------------------------------------------------------------------
  // 4. SALES DOCUMENT (Local Draft CREATE -> Server Authoritative Stock Lock CONFIRM)
  // --------------------------------------------------------------------------
  if (entityType === "sales") {
    if (operation === "CREATE") {
      return withTenantTransaction(organizationId, async (tx) => {
        let customerId = String(p.customer_id || p.contact_id || "");
        if (customerId === "walk-in") customerId = await ensureWalkInCustomer(tx, organizationId, deviceId);
        const warehouseId = String(p.warehouse_id || "");
        if (p.document_type && String(p.document_type).toUpperCase() !== "SALES_INVOICE") {
          throw new ApiError(422, "UNSUPPORTED_DOCUMENT_TYPE", "همگام‌سازی فروش فقط فاکتور فروش را می‌پذیرد.");
        }
        const prepared = prepareOfflineInvoice(p);
        if (!isUuid(customerId) || !isUuid(warehouseId) || prepared.items.length === 0) {
          throw new ApiError(422, "VALIDATION_ERROR", "اطلاعات فروش آفلاین (customer_id, warehouse_id, items) ناقص است.");
        }

        const docNum = String(p.document_number || `SI-OFF-${Date.now().toString().slice(-6)}`);
        const [inv] = await tx
          .insert(salesInvoices)
          .values({
            id: clientUuid,
            clientDocumentId: clientUuid,
            organizationId,
            contactId: customerId,
            warehouseId,
            invoiceNumber: docNum,
            invoiceDate: String(p.document_date || new Date().toISOString().slice(0, 10)),
            currency: String(p.currency || "IRR"),
            exchangeRate: String(p.exchange_rate || "1.0000"),
            subtotal: prepared.subtotal,
            discountAmount: prepared.discountTotal,
            taxAmount: prepared.taxTotal,
            shippingCost: prepared.shippingCost,
            otherCosts: prepared.otherCosts,
            totalAmount: prepared.grandTotal,
            paidAmount: "0.00",
            remainingAmount: prepared.grandTotal,
            relatedDocumentId: isUuid(p.related_document_id) ? String(p.related_document_id) : null,
            relatedDocumentType: p.related_document_type ? String(p.related_document_type) : null,
            receiptUrl: p.receipt_url ? String(p.receipt_url) : null,
            status: "DRAFT", // Never CONFIRMED directly from Android!
            notes: p.notes ? String(p.notes) : "ثبت‌شده در حالت آفلاین اندروید",
            createdBy: params.userId,
            version: 1,
            syncSeq: Date.now(),
          })
          .returning();

        await tx.insert(salesInvoiceItems).values(
          prepared.items.map((it) => ({
            ...(isUuid(it.clientItemId) ? { id: it.clientItemId } : {}),
            organizationId,
            salesInvoiceId: inv.id,
            productId: it.productId,
            variantId: it.variantId,
            quantity: it.quantity,
            unitPrice: it.unitPrice,
            discountAmount: it.discountAmount,
            taxRate: it.taxRate,
            taxAmount: it.taxAmount,
            lineTotal: it.lineTotal,
            description: it.description,
          }))
        );

        await appendSyncChangeLog(tx, {
          organizationId,
          entityType: "sales",
          entityId: inv.id,
          operation: "UPSERT",
          version: inv.version,
          sourceDeviceId: deviceId,
          payload: {
            id: inv.id,
            document_number: inv.invoiceNumber,
            customer_id: inv.contactId,
            grand_total: inv.totalAmount,
            status: "DRAFT",
          },
        });

        return {
          event_id: ev.event_id,
          entity_id: clientUuid,
          server_id: inv.id,
          status: "ACCEPTED",
          entity_version: inv.version,
          business_status: "DRAFT",
          error: null,
        };
      });
    }

    if (operation === "UPDATE") {
      return withTenantTransaction(organizationId, async (tx) => {
        const [existing] = await tx.select().from(salesInvoices).where(and(
          eq(salesInvoices.id, clientUuid),
          eq(salesInvoices.organizationId, organizationId)
        )).limit(1);
        if (!existing) throw new ApiError(404, "INVOICE_NOT_FOUND", "پیش‌نویس فروش برای بروزرسانی یافت نشد.");
        if (existing.status !== "DRAFT") throw new ApiError(409, "INVOICE_ALREADY_FINALIZED", "فقط پیش‌نویس فروش قابل ویرایش است.");
        let customerId = String(p.customer_id || p.contact_id || "");
        if (customerId === "walk-in") customerId = await ensureWalkInCustomer(tx, organizationId, deviceId);
        const warehouseId = String(p.warehouse_id || "");
        if (!isUuid(customerId) || !isUuid(warehouseId)) throw new ApiError(422, "VALIDATION_ERROR", "مشتری یا انبار فاکتور فروش معتبر نیست.");
        const prepared = prepareOfflineInvoice(p);
        const [updated] = await tx.update(salesInvoices).set({
          contactId: customerId,
          warehouseId,
          invoiceNumber: String(p.document_number || existing.invoiceNumber),
          invoiceDate: String(p.document_date || existing.invoiceDate),
          currency: String(p.currency || existing.currency),
          exchangeRate: String(p.exchange_rate || existing.exchangeRate),
          subtotal: prepared.subtotal,
          discountAmount: prepared.discountTotal,
          taxAmount: prepared.taxTotal,
          shippingCost: prepared.shippingCost,
          otherCosts: prepared.otherCosts,
          totalAmount: prepared.grandTotal,
          paidAmount: "0.00",
          remainingAmount: prepared.grandTotal,
          relatedDocumentId: isUuid(p.related_document_id) ? String(p.related_document_id) : null,
          relatedDocumentType: p.related_document_type ? String(p.related_document_type) : null,
          notes: p.notes ? String(p.notes) : null,
          version: existing.version + 1,
          syncSeq: Date.now(),
          updatedAt: new Date(),
        }).where(eq(salesInvoices.id, existing.id)).returning();
        await tx.delete(salesInvoiceItems).where(eq(salesInvoiceItems.salesInvoiceId, existing.id));
        await tx.insert(salesInvoiceItems).values(prepared.items.map((item) => ({
          ...(isUuid(item.clientItemId) ? { id: item.clientItemId } : {}),
          organizationId,
          salesInvoiceId: updated.id,
          productId: item.productId,
          variantId: item.variantId,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          discountAmount: item.discountAmount,
          taxRate: item.taxRate,
          taxAmount: item.taxAmount,
          lineTotal: item.lineTotal,
          description: item.description,
        })));
        await appendSyncChangeLog(tx, {
          organizationId,
          entityType: "sales",
          entityId: updated.id,
          operation: "UPSERT",
          version: updated.version,
          sourceDeviceId: deviceId,
          payload: { id: updated.id, document_number: updated.invoiceNumber, grand_total: updated.totalAmount, status: "DRAFT" },
        });
        return { event_id: ev.event_id, entity_id: updated.id, server_id: updated.id, status: "ACCEPTED", entity_version: updated.version, business_status: "DRAFT", error: null };
      });
    }

    if (operation === "CONFIRM") {
      // Uses PostgreSQL advisory lock in Stock Ledger — prevents multi-device negative stock!
      const finalized = await finalizeSalesInvoice({
        organizationId,
        invoiceId: clientUuid,
        actorUserId: params.userId,
        actorEmail: params.userEmail,
        ipAddress: params.ipAddress,
        paymentAllocations: parseSyncPaymentAllocations(p),
      });

      await appendSyncChangeLog(db, {
        organizationId,
        entityType: "sales",
        entityId: finalized.invoice.id,
        operation: "UPSERT",
        version: finalized.invoice.version,
        sourceDeviceId: deviceId,
        payload: {
          id: finalized.invoice.id,
          document_number: finalized.invoice.invoiceNumber,
          grand_total: finalized.invoice.totalAmount,
          status: "CONFIRMED",
          stock_document_id: finalized.stockDocument.id,
          journal_entry_id: finalized.journalEntry.id,
        },
      });

      return {
        event_id: ev.event_id,
        entity_id: finalized.invoice.id,
        server_id: finalized.invoice.id,
        status: "CONFIRMED",
        entity_version: finalized.invoice.version,
        business_status: "CONFIRMED",
        error: null,
      };
    }
  }

  // --------------------------------------------------------------------------
  // 5. JOURNAL ENTRY (Draft Offline Only — Immutable Confirmed Entries Never LWW!)
  // --------------------------------------------------------------------------
  if (entityType === "journal_entry") {
    if (operation === "UPDATE" || operation === "DELETE") {
      const [existing] = await db
        .select()
        .from(journalEntries)
        .where(and(eq(journalEntries.id, clientUuid), eq(journalEntries.organizationId, organizationId)))
        .limit(1);

      if (existing && existing.status !== "DRAFT") {
        const [conflict] = await db
          .insert(syncConflicts)
          .values({
            organizationId,
            deviceId,
            entityType: "journal_entry",
            entityId: existing.id,
            conflictType: "FINANCIAL_IMMUTABLE",
            clientVersion: ev.base_version ?? 1,
            serverVersion: existing.version,
            clientPayload: p,
            serverPayload: {
              entry_number: existing.entryNumber,
              status: existing.status,
              total_debit: existing.totalDebit,
            },
            conflictingFields: ["status", "lines"],
            status: "OPEN",
          })
          .returning();

        return {
          event_id: ev.event_id,
          entity_id: existing.id,
          server_id: existing.id,
          status: "CONFLICT",
          entity_version: existing.version,
          business_status: "CONFIRMED",
          conflict_id: conflict.id,
          error: {
            code: "ACCOUNTING_ENTRY_IMMUTABLE",
            message: "سند قطعی حسابداری تغییرناپذیر است و از طریق Sync قابل ویرایش یا حذف نیست.",
          },
        };
      }
      throw new ApiError(409, "ACCOUNTING_ENTRY_IMMUTABLE", "ویرایش یا حذف آفلاین سند حسابداری مجاز نیست.");
    }

    if (operation === "CREATE") {
      const lines = (p.lines as Array<{
        account_id?: string;
        account_code?: string;
        debit: string;
        credit: string;
        description?: string;
      }>) ?? [];
      const created = await withTenantTransaction(organizationId, async (tx) => {
        const resolvedLines = [];
        for (const line of lines) {
          let accountId = line.account_id;
          if (!isUuid(accountId) && line.account_code) {
            const [account] = await tx
              .select({ id: accounts.id })
              .from(accounts)
              .where(and(eq(accounts.organizationId, organizationId), eq(accounts.code, line.account_code)))
              .limit(1);
            accountId = account?.id;
          }
          if (!isUuid(accountId)) {
            throw new ApiError(
              422,
              "ACCOUNT_NOT_FOUND",
              "حساب با کد " + String(line.account_code ?? "") + " در سرور همگام نشده است."
            );
          }
          resolvedLines.push({
            accountId,
            debit: line.debit,
            credit: line.credit,
            description: line.description,
          });
        }
        const res = await createJournalEntryTx(tx, {
          organizationId,
          actorUserId: params.userId,
          actorEmail: params.userEmail,
          entryDate: String(p.document_date || new Date().toISOString().slice(0, 10)),
          description: String(p.description || "پیش‌نویس سند آفلاین"),
          postImmediately: false, // Prompt 04 §14: No final journal approval offline!
          lines: resolvedLines,
        });
        await appendSyncChangeLog(tx, {
          organizationId,
          entityType: "journal_entry",
          entityId: res.entry.id,
          operation: "UPSERT",
          version: res.entry.version,
          sourceDeviceId: deviceId,
          payload: {
            id: res.entry.id,
            document_number: res.entry.entryNumber,
            status: "DRAFT",
            total_debit: res.entry.totalDebit,
          },
        });
        return res;
      });
      return {
        event_id: ev.event_id,
        entity_id: clientUuid,
        server_id: created.entry.id,
        status: "ACCEPTED",
        entity_version: created.entry.version,
        business_status: "DRAFT",
        error: null,
      };
    }
  }

  // --------------------------------------------------------------------------
  // 6. STOCK COUNT / CHEQUE / FINANCIAL TRANSACTION
  // --------------------------------------------------------------------------
  if (entityType === "stock_count" && operation === "CREATE") {
    const items = (p.items as Array<{ product_id: string; counted_qty: string }>) ?? [];
    const res = await approveStockCount({
      organizationId,
      warehouseId: String(p.warehouse_id),
      countDate: String(p.count_date || new Date().toISOString().slice(0, 10)),
      notes: p.notes ? String(p.notes) : "انبارگردانی آفلاین اندروید",
      items: items.map((i) => ({ productId: i.product_id, countedQty: i.counted_qty })),
      actorUserId: params.userId,
      actorEmail: params.userEmail,
      ipAddress: params.ipAddress,
    });
    return {
      event_id: ev.event_id,
      entity_id: clientUuid,
      server_id: res.countDoc.id,
      status: "CONFIRMED",
      entity_version: 1,
      business_status: "CONFIRMED",
      error: null,
    };
  }

  if (entityType === "inventory_document" && operation === "CREATE") {
    const documentType = String(p.document_type || "").toUpperCase();
    const warehouseId = String(p.warehouse_id || p.source_warehouse_id || "");
    const documentDate = String(p.document_date || new Date().toISOString().slice(0, 10));
    const documentNumber = String(p.document_number || ("INV-" + Date.now().toString().slice(-7)));
    const reason = String(p.description || p.reference_number || "سند انبار آفلاین اندروید");
    const items = (p.items as Array<{ product_id: string; variant_id?: string | null; quantity: string; unit_cost?: string }>) ?? [];
    if (!isUuid(warehouseId) || items.length === 0) {
      throw new ApiError(422, "VALIDATION_ERROR", "اطلاعات سند انبار آفلاین (warehouse_id, items) ناقص است.");
    }

    if (documentType === "RECEIPT" && p.supplier_id && p.supplier_invoice_number) {
      const landedReceipt = await createLandedWarehouseReceipt({
        organizationId,
        warehouseId,
        documentId: clientUuid,
        supplierId: String(p.supplier_id),
        supplierInvoiceNumber: String(p.supplier_invoice_number),
        invoiceDate: String(p.invoice_date || documentDate),
        invoiceDateJalali: p.invoice_date_jalali == null ? undefined : String(p.invoice_date_jalali),
        shippingCost: String(p.shipping_cost || "0.00"),
        customsAndExtraCost: String(p.customs_and_extra_cost || "0.00"),
        supplierDiscount: String(p.supplier_discount || "0.00"),
        taxAmount: String(p.tax_amount || "0.00"),
        paidAmount: String(p.paid_amount || "0.00"),
        paymentBankAccountId: p.payment_bank_account_id ? String(p.payment_bank_account_id) : null,
        paymentTrackingNumber: p.payment_tracking_number == null ? null : String(p.payment_tracking_number),
        description: reason,
        actorUserId: params.userId,
        actorEmail: params.userEmail,
        ipAddress: params.ipAddress,
        items: items.map((item) => ({
          product_id: item.product_id,
          variant_id: item.variant_id ?? null,
          quantity: item.quantity,
          unit_price: String((item as { unit_price?: string }).unit_price || item.unit_cost || "0.00"),
        })),
      });
      return {
        event_id: ev.event_id,
        entity_id: clientUuid,
        server_id: landedReceipt.document.id,
        status: "CONFIRMED",
        entity_version: 1,
        business_status: "POSTED",
        error: null,
      };
    }

    if (documentType === "RECEIPT" || documentType === "ISSUE") {
      const posted = await withTenantTransaction(organizationId, (tx) =>
        postStockDocumentTx(tx, {
          organizationId,
          warehouseId,
          documentType: documentType === "RECEIPT" ? "RECEIPT" : "ISSUE",
          documentDate,
          reason,
          referenceType: "ANDROID_INVENTORY_DOCUMENT",
          referenceId: clientUuid,
          actorUserId: params.userId,
          items: items.map((item) => ({
            productId: item.product_id,
            direction: documentType === "RECEIPT" ? "IN" : "OUT",
            quantity: item.quantity,
            ...(item.unit_cost ? { unitCost: item.unit_cost } : {}),
          })),
        })
      );
      return {
        event_id: ev.event_id,
        entity_id: clientUuid,
        server_id: posted.document.id,
        status: "CONFIRMED",
        entity_version: 1,
        business_status: "CONFIRMED",
        error: null,
      };
    }

    if (documentType === "TRANSFER") {
      const targetWarehouseId = String(p.destination_warehouse_id || p.target_warehouse_id || "");
      if (!isUuid(targetWarehouseId) || targetWarehouseId === warehouseId) {
        throw new ApiError(422, "TRANSFER_WAREHOUSES_INVALID", "انبار مبدأ و مقصد انتقال معتبر نیستند.");
      }
      // An offline sync event creates a server draft only. Stock is moved to
      // transit at the explicit dispatch action and enters the destination
      // only when that warehouse accepts the received quantities.
      const transferResult = await withTenantTransaction(organizationId, async (tx) => {
        const [source] = await tx.select().from(warehouses)
          .where(and(eq(warehouses.id, warehouseId), eq(warehouses.organizationId, organizationId))).limit(1);
        const [target] = await tx.select().from(warehouses)
          .where(and(eq(warehouses.id, targetWarehouseId), eq(warehouses.organizationId, organizationId))).limit(1);
        if (!source || !target) throw new ApiError(422, "TRANSFER_WAREHOUSES_INVALID", "انبار مبدأ یا مقصد متعلق به این سازمان نیست.");

        const productIds = [...new Set(items.map((item) => item.product_id))];
        if (items.some((item) => !isUuid(item.product_id))) throw new ApiError(422, "TRANSFER_PRODUCT_INVALID", "شناسه یکی از کالاهای انتقال معتبر نیست.");
        const orgProducts = await tx.select({ id: products.id }).from(products)
          .where(and(eq(products.organizationId, organizationId), inArray(products.id, productIds)));
        if (orgProducts.length !== productIds.length) throw new ApiError(422, "TRANSFER_PRODUCT_INVALID", "یکی از کالاها متعلق به این سازمان نیست.");

        const grouped = new Map<string, { productId: string; variantId: string | null; quantity: bigint }>();
        for (const item of items) {
          const quantity = parseDecimal(item.quantity);
          if (quantity <= BigInt(0)) throw new ApiError(422, "TRANSFER_QUANTITY_INVALID", "مقدار انتقال باید بزرگ‌تر از صفر باشد.");
          const variantId = isUuid(item.variant_id) ? item.variant_id : null;
          const key = `${item.product_id}:${variantId ?? ""}`;
          const existing = grouped.get(key);
          grouped.set(key, {
            productId: item.product_id,
            variantId,
            quantity: addDec(existing?.quantity ?? BigInt(0), quantity),
          });
        }
        const transferItems = [...grouped.values()];
        const totalQuantity = transferItems.reduce((sum, item) => addDec(sum, item.quantity), BigInt(0));
        const [transfer] = await tx.insert(stockTransfers).values({
          id: clientUuid,
          organizationId,
          transferNumber: `${documentNumber}-${clientUuid.slice(0, 8)}`.slice(0, 48),
          sourceWarehouseId: warehouseId,
          targetWarehouseId,
          productId: transferItems[0]?.productId ?? null,
          quantity: formatDecimal(totalQuantity, 4),
          reason,
          sourceResponsibleName: String(p.source_responsible_name || "مسئول انبار مبدأ"),
          destinationResponsibleName: String(p.destination_responsible_name || "مسئول انبار مقصد"),
          transferDate: documentDate,
          notes: p.description ? String(p.description) : null,
          status: "DRAFT",
          createdBy: params.userId,
        }).returning();
        await tx.insert(stockTransferItems).values(transferItems.map((item) => ({
          organizationId,
          stockTransferId: transfer.id,
          productId: item.productId,
          variantId: item.variantId,
          quantitySent: formatDecimal(item.quantity, 4),
          itemStatus: "PENDING",
        })));
        await appendSyncChangeLog(tx, {
          organizationId,
          entityType: "stock_transfer",
          entityId: transfer.id,
          operation: "UPSERT",
          version: 1,
          sourceDeviceId: deviceId,
          payload: { id: transfer.id, transfer_number: transfer.transferNumber, status: transfer.status },
        });
        return transfer;
      });
      return {
        event_id: ev.event_id,
        entity_id: clientUuid,
        server_id: transferResult.id,
        status: "ACCEPTED",
        entity_version: 1,
        business_status: "DRAFT",
        error: null,
      };
    }

    throw new ApiError(422, "SYNC_ENTITY_UNSUPPORTED", "نوع سند انبار آفلاین پشتیبانی نمی‌شود.");
  }

  if (entityType === "cheque" && operation === "CREATE") {
    return withTenantTransaction(organizationId, async (tx) => {
      const [ch] = await tx
        .insert(cheques)
        .values({
          id: clientUuid,
          organizationId,
          contactId: isUuid(p.contact_id) ? p.contact_id : null,
          chequeType: normalizeChequeDirection(p.direction),
          sayadId: String(p.cheque_number || `404${Date.now().toString().slice(-13)}`),
          serialNumber: String(p.serial_number || "0001"),
          bankName: String(p.bank_name || "بانک ملت"),
          branchName: p.branch_name ? String(p.branch_name) : null,
          accountNumber: p.account_number ? String(p.account_number) : null,
          amount: String(p.amount || "0.00"),
          issueDate: syncDate(p.issue_date, new Date().toISOString().slice(0, 10)),
          dueDate: syncDate(p.due_date, new Date().toISOString().slice(0, 10)),
          financialAccountId: isUuid(p.financial_account_id || p.treasury_account_local_id) ? String(p.financial_account_id || p.treasury_account_local_id) : null,
          relatedDocumentType: p.related_document_type ? String(p.related_document_type) : null,
          relatedDocumentId: isUuid(p.related_document_id || p.related_document_local_id) ? String(p.related_document_id || p.related_document_local_id) : null,
          referenceDocumentNumber: p.reference_document_number ? String(p.reference_document_number) : null,
          reminderDateEpoch: optionalEpoch(p.reminder_date_epoch ?? p.reminder_date),
          notes: p.notes ? String(p.notes) : null,
          status: normalizeChequeStatus(p.status),
        })
        .returning();
      await tx.insert(chequeEvents).values({
        organizationId,
        chequeId: ch.id,
        fromStatus: null,
        toStatus: ch.status,
        eventDate: ch.issueDate,
        note: "ثبت چک در حالت آفلاین اندروید",
        actorUserId: params.userId,
      });
      await appendSyncChangeLog(tx, {
        organizationId,
        entityType: "cheque",
        entityId: ch.id,
        operation: "UPSERT",
        version: 1,
        sourceDeviceId: deviceId,
        payload: { ...chequeSyncPayload(ch), contact_name: p.contact_name ? String(p.contact_name) : null },
      });
      return {
        event_id: ev.event_id,
        entity_id: clientUuid,
        server_id: ch.id,
        status: "ACCEPTED",
        entity_version: 1,
        business_status: ch.status,
        error: null,
      };
    });
  }

  if (entityType === "cheque" && operation === "UPDATE") {
    return withTenantTransaction(organizationId, async (tx) => {
      const [current] = await tx
        .select()
        .from(cheques)
        .where(and(eq(cheques.id, clientUuid), eq(cheques.organizationId, organizationId)))
        .limit(1);
      if (!current) throw new ApiError(404, "CHEQUE_NOT_FOUND", "چک در سرور یافت نشد.");

      const nextStatus = normalizeChequeStatus(p.status);
      if (!nextStatus || nextStatus === current.status) {
        return { event_id: ev.event_id, entity_id: current.id, server_id: current.id, status: "ACCEPTED", entity_version: current.version, business_status: current.status, error: null };
      }
      const [updated] = await tx
        .update(cheques)
        .set({ status: nextStatus, version: current.version + 1, updatedAt: new Date() })
        .where(eq(cheques.id, current.id))
        .returning();
      await tx.insert(chequeEvents).values({
        organizationId,
        chequeId: current.id,
        fromStatus: current.status,
        toStatus: nextStatus,
        eventDate: new Date().toISOString().slice(0, 10),
        note: "تغییر وضعیت چک از برنامه اندروید",
        actorUserId: params.userId,
      });
      await appendSyncChangeLog(tx, {
        organizationId,
        entityType: "cheque",
        entityId: updated.id,
        operation: "UPSERT",
        version: updated.version,
        sourceDeviceId: deviceId,
        payload: chequeSyncPayload(updated),
      });
      return {
        event_id: ev.event_id,
        entity_id: current.id,
        server_id: current.id,
        status: "ACCEPTED",
        entity_version: updated.version,
        business_status: updated.status,
        error: null,
      };
    });
  }

  if (entityType === "financial_transaction" && operation === "CREATE") {
    return withTenantTransaction(organizationId, async (tx) => {
      const accId = String(p.account_id || "");
      const [fa] = await tx
        .select()
        .from(financialAccounts)
        .where(and(eq(financialAccounts.id, accId), eq(financialAccounts.organizationId, organizationId)))
        .limit(1);
      if (!fa) throw new ApiError(404, "TREASURY_ACCOUNT_NOT_FOUND", "حساب خزانه یافت نشد.");
      const amount = String(p.amount || "0.00");
      const txType = String(p.transaction_type || "RECEIPT");
      const nextBal = txType === "PAYMENT" ? subDec(fa.balance, amount) : addDec(fa.balance, amount);
      const [ftx] = await tx
        .insert(financialTransactions)
        .values({
          id: clientUuid,
          organizationId,
          financialAccountId: fa.id,
          contactId: isUuid(p.contact_id) ? p.contact_id : null,
          txType,
          amount,
          txDate: String(p.transaction_date || new Date().toISOString().slice(0, 10)),
          paymentMethod: String(p.payment_method || "CASH"),
          description: String(p.description || "تراکنش آفلاین خزانه"),
          createdBy: params.userId,
        })
        .returning();
      await tx.update(financialAccounts).set({ balance: formatDecimal(nextBal, 2) }).where(eq(financialAccounts.id, fa.id));
      await appendSyncChangeLog(tx, {
        organizationId,
        entityType: "financial_transaction",
        entityId: ftx.id,
        operation: "UPSERT",
        version: 1,
        sourceDeviceId: deviceId,
        payload: { id: ftx.id, transaction_type: txType, amount, status: "CONFIRMED" },
      });
      return {
        event_id: ev.event_id,
        entity_id: clientUuid,
        server_id: ftx.id,
        status: "CONFIRMED",
        entity_version: 1,
        business_status: "CONFIRMED",
        error: null,
      };
    });
  }

  // Delegate Prompt 07 extended Sync Entity Types (warehouse, branch, cost_center, account_code, treasury_account, product_variant, quick_cashflow, consignment_document, personal_transaction, owner_withdrawal, employee)
  const extResult = await processExtendedSyncEntity({
    organizationId,
    userId: params.userId,
    userEmail: params.userEmail,
    ipAddress: params.ipAddress,
    deviceId,
    entityType,
    operation,
    clientUuid,
    ev,
  });
  if (extResult) return extResult;

  throw new ApiError(422, "SYNC_ENTITY_UNSUPPORTED", `موجودیت ${entityType} با عملیات ${operation} پشتیبانی نمی‌شود.`);
}

/**
 * Master Prompt 04 §10 — Stable Monotonic Opaque Cursor Pull from `sync_change_log`
 */
export async function pullSyncDelta(params: {
  organizationId: string;
  deviceId: string;
  cursor?: string | null;
  limit?: number;
  entityTypes?: string[];
}) {
  const startedAt = new Date();
  const startMs = Date.now();

  const [orgRow] = await db
    .select({ operatingMode: organizations.operatingMode })
    .from(organizations)
    .where(eq(organizations.id, params.organizationId))
    .limit(1);
  if (orgRow?.operatingMode === "OFFLINE_ONLY") {
    throw new ApiError(
      409,
      "OPERATING_MODE_OFFLINE_ONLY",
      "سازمان در حالت OFFLINE_ONLY قرار دارد و دریافت همگام‌سازی ابری غیرفعال است."
    );
  }

  const device = await resolveActiveSyncDevice(params.organizationId, params.deviceId);

  await ensureOrgChangeLogBaseline(params.organizationId);

  const afterSeq = decodeSyncCursor(params.cursor, params.organizationId);
  const pageLimit = Math.min(200, Math.max(1, params.limit ?? 50));

  const conditions = [
    eq(syncChangeLog.organizationId, params.organizationId),
    gt(syncChangeLog.seq, afterSeq),
  ];

  if (params.entityTypes && params.entityTypes.length > 0) {
    const normalized = params.entityTypes.map(normalizeEntityType);
    conditions.push(inArray(syncChangeLog.entityType, normalized));
  }

  const rows = await db
    .select()
    .from(syncChangeLog)
    .where(and(...conditions))
    .orderBy(asc(syncChangeLog.seq))
    .limit(pageLimit + 1);

  const hasMore = rows.length > pageLimit;
  const pageRows = hasMore ? rows.slice(0, pageLimit) : rows;
  const lastSeq = pageRows.length > 0 ? pageRows[pageRows.length - 1].seq : afterSeq;
  const nextCursor = encodeSyncCursor({ seq: lastSeq, orgId: params.organizationId });

  const finishedAt = new Date();
  await db.insert(syncLogs).values({
    organizationId: params.organizationId,
    deviceId: device.id,
    direction: "PULL",
    startedAt,
    finishedAt,
    pushCount: 0,
    pullCount: pageRows.length,
    successCount: pageRows.length,
    failureCount: 0,
    conflictCount: 0,
    cursorBefore: params.cursor ?? null,
    cursorAfter: nextCursor,
    durationMs: Date.now() - startMs,
  });

  return {
    device_id: device.id,
    changes: pageRows.map((r) => ({
      change_id: r.changeId,
      seq: r.seq,
      entity_type: r.entityType,
      entity_id: r.entityId,
      operation: r.operation, // UPSERT | TOMBSTONE
      version: r.version,
      changed_at: r.changedAt.toISOString(),
      payload: r.payload,
    })),
    next_cursor: nextCursor,
    next_checkpoint: lastSeq,
    has_more: hasMore,
  };
}

/**
 * Master Prompt 04 §15 — Acknowledge Cursor ONLY after Android Room Transaction Commit
 */
export async function acknowledgeSyncCursor(params: {
  organizationId: string;
  deviceId: string;
  cursor: string;
}) {
  const seq = decodeSyncCursor(params.cursor, params.organizationId);
  const now = new Date();
  const device = await resolveActiveSyncDevice(params.organizationId, params.deviceId);

  const [cp] = await db
    .insert(syncCheckpoints)
    .values({
      organizationId: params.organizationId,
      deviceId: device.id,
      checkpointSeq: seq,
      cursor: params.cursor,
      acknowledgedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [syncCheckpoints.organizationId, syncCheckpoints.deviceId],
      set: {
        checkpointSeq: seq,
        cursor: params.cursor,
        acknowledgedAt: now,
        updatedAt: now,
      },
    })
    .returning();

  await db
    .update(devices)
    .set({ lastCheckpoint: seq, lastSyncAt: now, updatedAt: now })
    .where(and(eq(devices.id, device.id), eq(devices.organizationId, params.organizationId)));

  return {
    acknowledged: true,
    device_id: device.id,
    checkpoint_seq: cp.checkpointSeq,
    cursor: cp.cursor,
    acknowledged_at: now.toISOString(),
  };
}

/**
 * Master Prompt 04 §15 — Protected Reset Checkpoint (NEVER deletes local or server data!)
 */
export async function resetSyncCheckpoint(params: {
  organizationId: string;
  deviceId: string;
  actorUserId: string;
  actorEmail: string;
  ipAddress?: string | null;
  reason?: string;
}) {
  const zeroCursor = encodeSyncCursor({ seq: 0, orgId: params.organizationId });
  const now = new Date();
  const device = await resolveActiveSyncDevice(params.organizationId, params.deviceId);

  await db
    .insert(syncCheckpoints)
    .values({
      organizationId: params.organizationId,
      deviceId: device.id,
      checkpointSeq: 0,
      cursor: zeroCursor,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [syncCheckpoints.organizationId, syncCheckpoints.deviceId],
      set: { checkpointSeq: 0, cursor: zeroCursor, updatedAt: now },
    });

  await db
    .update(devices)
    .set({ lastCheckpoint: 0, updatedAt: now })
    .where(and(eq(devices.id, device.id), eq(devices.organizationId, params.organizationId)));

  await recordAuditLog({
    organizationId: params.organizationId,
    actorUserId: params.actorUserId,
    actorEmail: params.actorEmail,
    scope: "ORGANIZATION",
    action: "SYNC_CHECKPOINT_RESET",
    entityType: "SYNC_CHECKPOINT",
    entityId: device.id,
    ipAddress: params.ipAddress,
    metadata: { reason: params.reason ?? "Cursor recovery requested", localDataPreserved: true },
  });

  return {
    reset: true,
    device_id: device.id,
    new_cursor: zeroCursor,
    data_deleted: false,
  };
}

/**
 * Master Prompt 04 §15 & §21 — Sync Status & Telemetry Overview
 */
export async function getOrganizationSyncStatus(organizationId: string) {
  await ensureOrgChangeLogBaseline(organizationId);
  const [orgDevices, checkpoints, openConflicts, recentLogs, [latestLogSeq], recentBatches] =
    await Promise.all([
      db.select().from(devices).where(eq(devices.organizationId, organizationId)).orderBy(desc(devices.lastSyncAt)),
      db.select().from(syncCheckpoints).where(eq(syncCheckpoints.organizationId, organizationId)),
      db
        .select()
        .from(syncConflicts)
        .where(and(eq(syncConflicts.organizationId, organizationId), eq(syncConflicts.status, "OPEN"))),
      db
        .select()
        .from(syncLogs)
        .where(eq(syncLogs.organizationId, organizationId))
        .orderBy(desc(syncLogs.startedAt))
        .limit(25),
      db
        .select({ maxSeq: sql<number>`COALESCE(MAX(${syncChangeLog.seq}), 0)::int` })
        .from(syncChangeLog)
        .where(eq(syncChangeLog.organizationId, organizationId)),
      db
        .select()
        .from(syncBatches)
        .where(eq(syncBatches.organizationId, organizationId))
        .orderBy(desc(syncBatches.createdAt))
        .limit(20),
    ]);

  const headSeq = Number(latestLogSeq?.maxSeq ?? 0);
  const headCursor = encodeSyncCursor({ seq: headSeq, orgId: organizationId });
  const devMap = new Map(orgDevices.map((d) => [d.id, d.deviceName]));

  return {
    server_time_utc: new Date().toISOString(),
    server_head_seq: headSeq,
    server_head_cursor: headCursor,
    open_conflicts_count: openConflicts.length,
    devices: orgDevices.map((d) => {
      const cp = checkpoints.find((c) => c.deviceId === d.id);
      const cpSeq = cp?.checkpointSeq ?? d.lastCheckpoint ?? 0;
      return {
        ...d,
        cursor: cp?.cursor ?? encodeSyncCursor({ seq: cpSeq, orgId: organizationId }),
        lag_events: Math.max(0, headSeq - cpSeq),
        acknowledged_at: cp?.acknowledgedAt ?? d.lastSyncAt,
      };
    }),
    sync_logs: recentLogs.map((l) => ({
      sync_id: l.id,
      device_id: l.deviceId,
      device_name: devMap.get(l.deviceId) ?? "",
      organization_id: l.organizationId,
      direction: l.direction,
      started_at: l.startedAt,
      finished_at: l.finishedAt,
      push_count: l.pushCount,
      pull_count: l.pullCount,
      success_count: l.successCount,
      failure_count: l.failureCount,
      conflict_count: l.conflictCount,
      cursor_before: l.cursorBefore,
      cursor_after: l.cursorAfter,
      error_code: l.errorCode,
      duration_ms: l.durationMs,
    })),
    batches: recentBatches.map((b) => ({ ...b, device_name: devMap.get(b.deviceId) ?? "" })),
  };
}

/**
 * Master Prompt 04 §16 — Domain-Restricted Conflict Resolution
 * Supports: USE_SERVER | USE_LOCAL | MERGE | RECREATE_AS_NEW
 */
export async function resolveSyncConflict(params: {
  organizationId: string;
  conflictId: string;
  resolution: "USE_SERVER" | "USE_LOCAL" | "MERGE" | "RECREATE_AS_NEW";
  mergedPayload?: Record<string, unknown> | null;
  actorUserId: string;
  actorEmail: string;
  ipAddress?: string | null;
}) {
  const resolved = await withTenantTransaction(params.organizationId, async (tx) => {
    const [conflict] = await tx
      .select()
      .from(syncConflicts)
      .where(
        and(
          eq(syncConflicts.id, params.conflictId),
          eq(syncConflicts.organizationId, params.organizationId)
        )
      )
      .limit(1);

    if (!conflict) {
      throw new ApiError(404, "CONFLICT_NOT_FOUND", "تعارض همگام‌سازی یافت نشد.");
    }
    if (conflict.status === "RESOLVED") {
      throw new ApiError(409, "CONFLICT_ALREADY_RESOLVED", "این تعارض قبلاً برطرف شده است.");
    }

    const allowed = getAllowedResolutions(conflict.entityType, conflict.conflictType);
    if (!allowed.includes(params.resolution)) {
      throw new ApiError(
        409,
        "RESOLUTION_NOT_ALLOWED_FOR_ENTITY",
        `استراتژی ${params.resolution} برای موجودیت ${conflict.entityType} مجاز نیست. گزینه‌های مجاز: ${allowed.join(", ")}`
      );
    }

    const normType = normalizeEntityType(conflict.entityType);
    let createdEntityId: string | null = null;

    if (params.resolution === "USE_LOCAL" || params.resolution === "MERGE") {
      const payloadToApply =
        params.resolution === "MERGE"
          ? { ...conflict.serverPayload, ...(params.mergedPayload ?? conflict.clientPayload) }
          : conflict.clientPayload;

      if (normType === "contact") {
        const [upd] = await tx
          .update(contacts)
          .set({
            ...(payloadToApply.display_name || payloadToApply.name
              ? { name: String(payloadToApply.display_name ?? payloadToApply.name) }
              : {}),
            ...(payloadToApply.mobile ? { mobile: String(payloadToApply.mobile) } : {}),
            ...(payloadToApply.credit_limit || payloadToApply.creditLimit
              ? { creditLimit: String(payloadToApply.credit_limit ?? payloadToApply.creditLimit) }
              : {}),
            version: conflict.serverVersion + 1,
            syncSeq: Date.now(),
            updatedAt: new Date(),
          })
          .where(and(eq(contacts.id, conflict.entityId), eq(contacts.organizationId, params.organizationId)))
          .returning();

        if (upd) {
          await appendSyncChangeLog(tx, {
            organizationId: params.organizationId,
            entityType: "contact",
            entityId: upd.id,
            operation: "UPSERT",
            version: upd.version,
            payload: { id: upd.id, display_name: upd.name, mobile: upd.mobile, credit_limit: upd.creditLimit },
          });
        }
      } else if (normType === "product") {
        const [upd] = await tx
          .update(products)
          .set({
            ...(payloadToApply.name ? { name: String(payloadToApply.name) } : {}),
            ...(payloadToApply.sale_price || payloadToApply.defaultSalePrice
              ? { defaultSalePrice: String(payloadToApply.sale_price ?? payloadToApply.defaultSalePrice) }
              : {}),
            version: conflict.serverVersion + 1,
            syncSeq: Date.now(),
            updatedAt: new Date(),
          })
          .where(and(eq(products.id, conflict.entityId), eq(products.organizationId, params.organizationId)))
          .returning();

        if (upd) {
          await appendSyncChangeLog(tx, {
            organizationId: params.organizationId,
            entityType: "product",
            entityId: upd.id,
            operation: "UPSERT",
            version: upd.version,
            payload: { id: upd.id, code: upd.sku, name: upd.name, sale_price: upd.defaultSalePrice },
          });
        }
      }
    } else if (params.resolution === "RECREATE_AS_NEW" && normType === "contact") {
      const lp = conflict.clientPayload;
      const [clone] = await tx
        .insert(contacts)
        .values({
          organizationId: params.organizationId,
          code: `C-RES-${Date.now().toString().slice(-5)}`,
          name: String(lp.display_name || lp.name || "طرف‌حساب بازآفرینی‌شده"),
          mobile: lp.mobile ? String(lp.mobile) : null,
          creditLimit: lp.credit_limit ? String(lp.credit_limit) : "0.00",
          version: 1,
          syncSeq: Date.now(),
        })
        .returning();
      createdEntityId = clone.id;
      await appendSyncChangeLog(tx, {
        organizationId: params.organizationId,
        entityType: "contact",
        entityId: clone.id,
        operation: "UPSERT",
        version: 1,
        payload: { id: clone.id, code: clone.code, display_name: clone.name, mobile: clone.mobile },
      });
    }

    const [updated] = await tx
      .update(syncConflicts)
      .set({
        status: "RESOLVED",
        resolutionStrategy: params.resolution,
        resolvedBy: params.actorUserId,
        resolvedAt: new Date(),
      })
      .where(eq(syncConflicts.id, conflict.id))
      .returning();

    return { conflict: updated, recreated_entity_id: createdEntityId };
  });

  await recordAuditLog({
    organizationId: params.organizationId,
    actorUserId: params.actorUserId,
    actorEmail: params.actorEmail,
    scope: "ORGANIZATION",
    action: "SYNC_CONFLICT_RESOLVED",
    entityType: "SYNC_CONFLICT",
    entityId: resolved.conflict.id,
    ipAddress: params.ipAddress,
    metadata: {
      resolution: params.resolution,
      entityType: resolved.conflict.entityType,
      recreatedEntityId: resolved.recreated_entity_id,
    },
  });

  return resolved;
}

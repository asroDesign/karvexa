import { and, eq, inArray } from "drizzle-orm";
import {
  accounts,
  contactTransactions,
  journalEntries,
  journalEntryLines,
  purchaseInvoiceItems,
  purchaseInvoices,
  purchaseReturnItems,
  purchaseReturns,
  salesInvoiceItems,
  salesInvoices,
  salesReturnItems,
  salesReturns,
} from "@/db/schema";
import { recordAuditLog } from "@/lib/audit";
import {
  addDec,
  formatDecimal,
  gtDec,
  isPositiveDec,
  mulDec,
  parseDecimal,
  subDec,
} from "@/lib/decimal";
import { ApiError } from "@/lib/errors";
import { withTenantTransaction } from "@/lib/tenant";
import { createJournalEntryTx, JournalLineInput } from "@/modules/accounting/service";
import { postStockDocumentTx } from "@/modules/inventory/service";
import { appendSyncChangeLog } from "@/modules/sync/changelog";

export interface ReturnItemInput {
  original_item_id: string;
  product_id: string;
  product_variant_id?: string | null;
  quantity: string;
  accepted_quantity?: string;
  damaged_quantity?: string;
  physically_received?: boolean;
  warehouse_id: string;
  unit_price?: string;
  reason?: string;
}

// ============================================================================
// 1. CANCEL SALES INVOICE (DRAFT or CONFIRMED — preserves full audit history!)
// ============================================================================
export async function cancelSalesInvoice(params: {
  organizationId: string;
  invoiceId: string;
  reason: string;
  actorUserId: string;
  actorEmail: string;
  ipAddress?: string | null;
}) {
  const result = await withTenantTransaction(params.organizationId, async (tx) => {
    const [inv] = await tx
      .select()
      .from(salesInvoices)
      .where(and(eq(salesInvoices.id, params.invoiceId), eq(salesInvoices.organizationId, params.organizationId)))
      .limit(1);

    if (!inv) throw new ApiError(404, "SALES_INVOICE_NOT_FOUND", "فاکتور فروش یافت نشد.");
    if (inv.status === "CANCELLED") {
      throw new ApiError(409, "DOCUMENT_ALREADY_CANCELLED", "این فاکتور فروش قبلاً لغو شده است.");
    }
    if (inv.status === "RETURNED" || inv.status === "PARTIALLY_RETURNED") {
      throw new ApiError(
        409,
        "DOCUMENT_HAS_RETURNS",
        "برای فاکتوری که قبلاً سند برگشت دارد، امکان لغو مستقیم وجود ندارد؛ از تکمیل برگشت استفاده کنید."
      );
    }

    const existingReturns = await tx
      .select({ id: salesReturns.id })
      .from(salesReturns)
      .where(eq(salesReturns.salesInvoiceId, inv.id))
      .limit(1);
    if (existingReturns.length > 0) {
      throw new ApiError(409, "DOCUMENT_HAS_RETURNS", "این فاکتور دارای سابقه برگشت است و قابل لغو مستقیم نیست.");
    }

    let reversalJournal = null;
    let restorationStockDoc = null;
    const cancelDate = new Date().toISOString().slice(0, 10);

    if (inv.status === "CONFIRMED" || inv.status === "FINALIZED") {
      // 1. Restore Stock Ledger via RECEIPT
      const invItems = await tx
        .select()
        .from(salesInvoiceItems)
        .where(eq(salesInvoiceItems.salesInvoiceId, inv.id));

      if (invItems.length > 0) {
        const stockRes = await postStockDocumentTx(tx, {
          organizationId: params.organizationId,
          warehouseId: inv.warehouseId,
          documentType: "RECEIPT",
          documentDate: cancelDate,
          reason: `بازگشت موجودی بابت لغو فاکتور فروش ${inv.invoiceNumber}: ${params.reason}`,
          referenceType: "SALES_CANCELLATION",
          referenceId: inv.id,
          actorUserId: params.actorUserId,
          items: invItems.map((it) => ({
            productId: it.productId,
            variantId: it.variantId ?? null,
            direction: "IN",
            quantity: it.quantity,
          })),
        });
        restorationStockDoc = stockRes.document;
      }

      // 2. Reverse linked Journal Entry cleanly (swapping debits/credits — respects period lock!)
      if (inv.journalEntryId) {
        const origLines = await tx
          .select()
          .from(journalEntryLines)
          .where(eq(journalEntryLines.journalEntryId, inv.journalEntryId));

        if (origLines.length >= 2) {
          const revRes = await createJournalEntryTx(tx, {
            organizationId: params.organizationId,
            actorUserId: params.actorUserId,
            actorEmail: params.actorEmail,
            entryDate: cancelDate,
            description: `سند معکوس بابت لغو فاکتور فروش ${inv.invoiceNumber} — ${params.reason}`,
            referenceType: "REVERSAL",
            referenceId: inv.journalEntryId,
            postImmediately: true,
            lines: origLines.map((l) => ({
              accountId: l.accountId,
              costCenterId: l.costCenterId,
              contactId: l.contactId,
              debit: l.credit,
              credit: l.debit,
              description: `لغو فاکتور ${inv.invoiceNumber}: ${l.description ?? ""}`,
            })),
          });
          reversalJournal = revRes.entry;
          await tx
            .update(journalEntries)
            .set({ status: "REVERSED", updatedAt: new Date() })
            .where(eq(journalEntries.id, inv.journalEntryId));
        }
      }

      // 3. Neutralize customer receivable
      await tx.insert(contactTransactions).values({
        organizationId: params.organizationId,
        contactId: inv.contactId,
        referenceType: "SALES_CANCELLATION",
        referenceId: inv.id,
        txDate: cancelDate,
        debit: "0.00",
        credit: inv.remainingAmount === "0.00" && inv.paidAmount === "0.00" ? inv.totalAmount : inv.remainingAmount,
        description: `لغو فاکتور فروش ${inv.invoiceNumber}: ${params.reason}`,
      });
    }

    const [cancelled] = await tx
      .update(salesInvoices)
      .set({
        status: "CANCELLED",
        accountingStatus: inv.journalEntryId ? "REVERSED" : inv.accountingStatus,
        stockStatus: restorationStockDoc ? "REVERSED" : inv.stockStatus,
        cancellationReason: params.reason,
        cancelledAt: new Date(),
        version: inv.version + 1,
        syncSeq: Date.now(),
        updatedAt: new Date(),
      })
      .where(eq(salesInvoices.id, inv.id))
      .returning();

    await appendSyncChangeLog(tx, {
      organizationId: params.organizationId,
      entityType: "sales",
      entityId: cancelled.id,
      operation: "UPSERT",
      version: cancelled.version,
      payload: {
        id: cancelled.id,
        document_number: cancelled.invoiceNumber,
        status: "CANCELLED",
        cancellation_reason: cancelled.cancellationReason,
      },
    });

    return {
      invoice: cancelled,
      reversal_journal: reversalJournal,
      restoration_stock_document: restorationStockDoc,
    };
  });

  await recordAuditLog({
    organizationId: params.organizationId,
    actorUserId: params.actorUserId,
    actorEmail: params.actorEmail,
    scope: "ORGANIZATION",
    action: "SALES_INVOICE_CANCELLED",
    entityType: "SALES_INVOICE",
    entityId: params.invoiceId,
    ipAddress: params.ipAddress,
    metadata: { reason: params.reason, reversalJournalId: result.reversal_journal?.id ?? null },
  });

  return result;
}

// ============================================================================
// 2. ITEM-LEVEL PARTIAL/FULL SALES RETURN (Stock IN + Accounting + Cumulative Qty Check)
// ============================================================================
export async function returnSalesInvoice(params: {
  organizationId: string;
  invoiceId: string;
  notes?: string;
  returnDate?: string;
  items: ReturnItemInput[];
  idempotencyKey?: string | null;
  actorUserId: string;
  actorEmail: string;
  ipAddress?: string | null;
}) {
  const result = await withTenantTransaction(params.organizationId, async (tx) => {
    const [inv] = await tx
      .select()
      .from(salesInvoices)
      .where(and(eq(salesInvoices.id, params.invoiceId), eq(salesInvoices.organizationId, params.organizationId)))
      .limit(1);

    if (!inv) throw new ApiError(404, "SALES_INVOICE_NOT_FOUND", "فاکتور فروش یافت نشد.");
    if (!["CONFIRMED", "FINALIZED", "PARTIALLY_RETURNED"].includes(inv.status)) {
      throw new ApiError(
        409,
        "INVOICE_NOT_RETURNABLE",
        `امکان ثبت برگشت برای فاکتور با وضعیت ${inv.status} وجود ندارد.`
      );
    }

    const origItems = await tx
      .select()
      .from(salesInvoiceItems)
      .where(eq(salesInvoiceItems.salesInvoiceId, inv.id));
    const origMap = new Map(origItems.map((it) => [it.id, it]));

    // Cumulative previous returns for this invoice's items
    const prevReturnItems =
      origItems.length > 0
        ? await tx
            .select()
            .from(salesReturnItems)
            .where(
              and(
                eq(salesReturnItems.organizationId, params.organizationId),
                inArray(
                  salesReturnItems.originalItemId,
                  origItems.map((i) => i.id)
                )
              )
            )
        : [];

    const returnedByOrigId = new Map<string, bigint>();
    for (const pri of prevReturnItems) {
      returnedByOrigId.set(
        pri.originalItemId,
        addDec(returnedByOrigId.get(pri.originalItemId) ?? BigInt(0), pri.quantity)
      );
    }

    let returnGrandTotal = BigInt(0);
    const validatedItems: Array<{
      originalItemId: string;
      productId: string;
      variantId: string | null;
      warehouseId: string;
      quantity: string;
      acceptedQuantity: string;
      damagedQuantity: string;
      physicallyReceived: boolean;
      unitPrice: string;
      lineTotal: string;
      reason: string | null;
    }> = [];

    for (const reqItem of params.items) {
      const orig = origMap.get(reqItem.original_item_id);
      if (!orig) {
        throw new ApiError(
          422,
          "ORIGINAL_ITEM_NOT_FOUND",
          `آیتم فاکتور اصلی (${reqItem.original_item_id}) در این فاکتور یافت نشد.`
        );
      }
      if (orig.productId !== reqItem.product_id) {
        throw new ApiError(422, "PRODUCT_MISMATCH", "کالای برگشتی با کالای آیتم اصلی فاکتور مطابقت ندارد.");
      }
      const reqQty = parseDecimal(reqItem.quantity);
      if (!isPositiveDec(reqQty)) {
        throw new ApiError(422, "QUANTITY_INVALID", "تعداد برگشتی باید بزرگ‌تر از صفر باشد.");
      }

      const alreadyReturned = returnedByOrigId.get(orig.id) ?? BigInt(0);
      const remainingReturnable = subDec(orig.quantity, alreadyReturned);
      if (gtDec(reqQty, remainingReturnable)) {
        throw new ApiError(
          422,
          "RETURN_QTY_EXCEEDS_REMAINING",
          `مقدار برگشتی (${reqItem.quantity}) از مقدار باقی‌مانده قابل برگشت (${formatDecimal(remainingReturnable, 4)}) بیشتر است.`
        );
      }
      returnedByOrigId.set(orig.id, addDec(alreadyReturned, reqQty));

      // Server authoritative pricing (default to original unitPrice; reject price > original unitPrice)
      const verifiedPrice = reqItem.unit_price
        ? parseDecimal(reqItem.unit_price)
        : parseDecimal(orig.unitPrice);
      if (gtDec(verifiedPrice, parseDecimal(orig.unitPrice))) {
        throw new ApiError(422, "RETURN_PRICE_EXCEEDS_ORIGINAL", "قیمت برگشتی نمی‌تواند بیشتر از قیمت فاکتور اصلی باشد.");
      }
      const lineTotalDec = mulDec(reqQty, verifiedPrice);
      returnGrandTotal = addDec(returnGrandTotal, lineTotalDec);

      // Prompt 08 §2.5: Physical receipt & damaged split (ONLY physically accepted qty enters sellable stock!)
      const physRecv = reqItem.physically_received !== false;
      const dmgDec = parseDecimal(reqItem.damaged_quantity || "0");
      const accDec = reqItem.accepted_quantity !== undefined
        ? parseDecimal(reqItem.accepted_quantity)
        : physRecv
          ? subDec(reqQty, dmgDec)
          : BigInt(0);
      if (gtDec(addDec(accDec, dmgDec), reqQty)) {
        throw new ApiError(422, "RETURN_SPLIT_INVALID", "مجموع مقدار سالم و آسیب‌دیده نمی‌تواند از کل مقدار برگشتی بیشتر باشد.");
      }

      validatedItems.push({
        originalItemId: orig.id,
        productId: orig.productId,
        variantId: reqItem.product_variant_id ?? orig.variantId ?? null,
        warehouseId: reqItem.warehouse_id || inv.warehouseId,
        quantity: formatDecimal(reqQty, 4),
        acceptedQuantity: formatDecimal(accDec, 4),
        damagedQuantity: formatDecimal(dmgDec, 4),
        physicallyReceived: physRecv,
        unitPrice: formatDecimal(verifiedPrice, 2),
        lineTotal: formatDecimal(lineTotalDec, 2),
        reason: reqItem.reason ?? params.notes ?? null,
      });
    }

    const retDate = params.returnDate || new Date().toISOString().slice(0, 10);
    const retNum = `SR-${Date.now().toString().slice(-6)}`;
    const totalStr = formatDecimal(returnGrandTotal, 2);

    // 1. Stock Ledger IN ONLY for physically accepted, non-damaged quantities!
    const byWh = new Map<string, typeof validatedItems>();
    for (const vi of validatedItems) {
      if (vi.physicallyReceived && isPositiveDec(parseDecimal(vi.acceptedQuantity))) {
        const list = byWh.get(vi.warehouseId) ?? [];
        list.push(vi);
        byWh.set(vi.warehouseId, list);
      }
    }

    let primaryStockDocId: string | null = null;
    let totalRestoredCost = BigInt(0);
    for (const [whId, whItems] of byWh.entries()) {
      const stkRes = await postStockDocumentTx(tx, {
        organizationId: params.organizationId,
        warehouseId: whId,
        documentType: "RECEIPT",
        documentDate: retDate,
        reason: `رسید کالای سالم برگشت از فروش ${retNum} (فاکتور ${inv.invoiceNumber})`,
        referenceType: "SALES_RETURN",
        referenceId: inv.id,
        actorUserId: params.actorUserId,
        items: whItems.map((i) => ({
          productId: i.productId,
          variantId: i.variantId,
          direction: "IN",
          quantity: i.acceptedQuantity,
        })),
      });
      if (!primaryStockDocId) primaryStockDocId = stkRes.document.id;
      totalRestoredCost = addDec(totalRestoredCost, stkRes.totalCostValue);
    }

    // 2. Balanced Double-Entry Accounting Journal (DR Sales Revenue / CR AR + DR Inventory / CR COGS)
    const orgAccs = await tx.select().from(accounts).where(eq(accounts.organizationId, params.organizationId));
    const byRole = new Map(orgAccs.filter((a) => a.systemRole).map((a) => [a.systemRole!, a]));
    const revAcc = byRole.get("SALES_REVENUE");
    const arAcc = byRole.get("AR");
    const invAcc = byRole.get("INVENTORY");
    const cogsAcc = byRole.get("COGS");

    let journalEntry = null;
    if (revAcc && arAcc) {
      const jLines: JournalLineInput[] = [
        { accountId: revAcc.id, debit: totalStr, credit: "0.00", description: `برگشت از فروش ${retNum}` },
        { accountId: arAcc.id, contactId: inv.contactId, debit: "0.00", credit: totalStr, description: `بستانکاری مشتری بابت برگشت ${retNum}` },
      ];
      if (isPositiveDec(totalRestoredCost) && invAcc && cogsAcc) {
        const costStr = formatDecimal(totalRestoredCost, 2);
        jLines.push(
          { accountId: invAcc.id, debit: costStr, credit: "0.00", description: `بازگشت کالا به انبار (${retNum})` },
          { accountId: cogsAcc.id, debit: "0.00", credit: costStr, description: `کاهش بهای تمام‌شده بابت برگشت (${retNum})` }
        );
      }

      const jr = await createJournalEntryTx(tx, {
        organizationId: params.organizationId,
        actorUserId: params.actorUserId,
        actorEmail: params.actorEmail,
        entryDate: retDate,
        description: `سند برگشت از فروش ${retNum} بابت فاکتور ${inv.invoiceNumber}`,
        referenceType: "SALES_RETURN",
        referenceId: inv.id,
        postImmediately: true,
        lines: jLines,
      });
      journalEntry = jr.entry;
    }

    // 3. Create Sales Return header & items
    const [retDoc] = await tx
      .insert(salesReturns)
      .values({
        organizationId: params.organizationId,
        salesInvoiceId: inv.id,
        returnNumber: retNum,
        returnDate: retDate,
        totalAmount: totalStr,
        reason: params.notes ?? "برگشت از فروش",
        stockDocumentId: primaryStockDocId,
        journalEntryId: journalEntry?.id ?? null,
        idempotencyKey: params.idempotencyKey ?? null,
        createdBy: params.actorUserId,
      })
      .returning();

    const savedRetItems = await tx
      .insert(salesReturnItems)
      .values(
        validatedItems.map((vi) => ({
          organizationId: params.organizationId,
          salesReturnId: retDoc.id,
          originalItemId: vi.originalItemId,
          productId: vi.productId,
          variantId: vi.variantId,
          warehouseId: vi.warehouseId,
          quantity: vi.quantity,
          acceptedQuantity: vi.acceptedQuantity,
          damagedQuantity: vi.damagedQuantity,
          physicallyReceived: vi.physicallyReceived,
          unitPrice: vi.unitPrice,
          lineTotal: vi.lineTotal,
          reason: vi.reason,
        }))
      )
      .returning();

    // 4. Customer Ledger credit (reduces receivable; does NOT automatically refund cash!)
    await tx.insert(contactTransactions).values({
      organizationId: params.organizationId,
      contactId: inv.contactId,
      referenceType: "SALES_RETURN",
      referenceId: retDoc.id,
      txDate: retDate,
      debit: "0.00",
      credit: totalStr,
      description: `برگشت از فروش ${retNum} (فاکتور ${inv.invoiceNumber})`,
    });

    // 5. Determine whether invoice is now fully RETURNED or PARTIALLY_RETURNED
    const fullyReturned = origItems.every((it) => {
      const totRet = returnedByOrigId.get(it.id) ?? BigInt(0);
      return subDec(it.quantity, totRet) <= BigInt(0);
    });
    const nextRem = subDec(inv.remainingAmount, returnGrandTotal);
    const [updatedInv] = await tx
      .update(salesInvoices)
      .set({
        status: fullyReturned ? "RETURNED" : "PARTIALLY_RETURNED",
        remainingAmount: formatDecimal(nextRem < BigInt(0) ? BigInt(0) : nextRem, 2),
        version: inv.version + 1,
        syncSeq: Date.now(),
        updatedAt: new Date(),
      })
      .where(eq(salesInvoices.id, inv.id))
      .returning();

    await appendSyncChangeLog(tx, {
      organizationId: params.organizationId,
      entityType: "sales",
      entityId: updatedInv.id,
      operation: "UPSERT",
      version: updatedInv.version,
      payload: {
        id: updatedInv.id,
        document_number: updatedInv.invoiceNumber,
        status: updatedInv.status,
        remaining_amount: updatedInv.remainingAmount,
      },
    });

    return {
      return_document: retDoc,
      items: savedRetItems,
      invoice: updatedInv,
      journal_entry: journalEntry,
      refund_required_amount: nextRem < BigInt(0) ? formatDecimal(-nextRem, 2) : "0.00",
    };
  });

  await recordAuditLog({
    organizationId: params.organizationId,
    actorUserId: params.actorUserId,
    actorEmail: params.actorEmail,
    scope: "ORGANIZATION",
    action: "SALES_RETURN_CREATED",
    entityType: "SALES_RETURN",
    entityId: result.return_document.id,
    ipAddress: params.ipAddress,
    metadata: {
      invoiceId: params.invoiceId,
      returnNumber: result.return_document.returnNumber,
      totalAmount: result.return_document.totalAmount,
    },
  });

  return result;
}

// ============================================================================
// 3. CANCEL PURCHASE INVOICE (DRAFT or CONFIRMED)
// ============================================================================
export async function cancelPurchaseInvoice(params: {
  organizationId: string;
  invoiceId: string;
  reason: string;
  actorUserId: string;
  actorEmail: string;
  ipAddress?: string | null;
}) {
  const result = await withTenantTransaction(params.organizationId, async (tx) => {
    const [inv] = await tx
      .select()
      .from(purchaseInvoices)
      .where(and(eq(purchaseInvoices.id, params.invoiceId), eq(purchaseInvoices.organizationId, params.organizationId)))
      .limit(1);

    if (!inv) throw new ApiError(404, "PURCHASE_NOT_FOUND", "فاکتور خرید یافت نشد.");
    if (inv.status === "CANCELLED") {
      throw new ApiError(409, "DOCUMENT_ALREADY_CANCELLED", "این فاکتور خرید قبلاً لغو شده است.");
    }
    if (inv.status === "RETURNED" || inv.status === "PARTIALLY_RETURNED") {
      throw new ApiError(409, "DOCUMENT_HAS_RETURNS", "فاکتور خرید دارای برگشت، قابل لغو مستقیم نیست.");
    }

    let reversalJournal = null;
    let reversalStockDoc = null;
    const cancelDate = new Date().toISOString().slice(0, 10);

    if (inv.status === "CONFIRMED" || inv.status === "FINALIZED") {
      const invItems = await tx
        .select()
        .from(purchaseInvoiceItems)
        .where(eq(purchaseInvoiceItems.purchaseInvoiceId, inv.id));

      if (invItems.length > 0) {
        // Deducts Stock Ledger (blocks if goods were already sold/consumed under BLOCK policy!)
        const stkRes = await postStockDocumentTx(tx, {
          organizationId: params.organizationId,
          warehouseId: inv.warehouseId,
          documentType: "ISSUE",
          documentDate: cancelDate,
          reason: `خروج کالا بابت لغو فاکتور خرید ${inv.invoiceNumber}: ${params.reason}`,
          referenceType: "PURCHASE_CANCELLATION",
          referenceId: inv.id,
          actorUserId: params.actorUserId,
          items: invItems.map((it) => ({
            productId: it.productId,
            variantId: it.variantId ?? null,
            direction: "OUT",
            quantity: it.quantity,
          })),
        });
        reversalStockDoc = stkRes.document;
      }

      if (inv.journalEntryId) {
        const origLines = await tx
          .select()
          .from(journalEntryLines)
          .where(eq(journalEntryLines.journalEntryId, inv.journalEntryId));
        if (origLines.length >= 2) {
          const revRes = await createJournalEntryTx(tx, {
            organizationId: params.organizationId,
            actorUserId: params.actorUserId,
            actorEmail: params.actorEmail,
            entryDate: cancelDate,
            description: `سند معکوس لغو فاکتور خرید ${inv.invoiceNumber} — ${params.reason}`,
            referenceType: "REVERSAL",
            referenceId: inv.journalEntryId,
            postImmediately: true,
            lines: origLines.map((l) => ({
              accountId: l.accountId,
              costCenterId: l.costCenterId,
              contactId: l.contactId,
              debit: l.credit,
              credit: l.debit,
              description: `لغو خرید ${inv.invoiceNumber}`,
            })),
          });
          reversalJournal = revRes.entry;
          await tx
            .update(journalEntries)
            .set({ status: "REVERSED", updatedAt: new Date() })
            .where(eq(journalEntries.id, inv.journalEntryId));
        }
      }

      await tx.insert(contactTransactions).values({
        organizationId: params.organizationId,
        contactId: inv.contactId,
        referenceType: "PURCHASE_CANCELLATION",
        referenceId: inv.id,
        txDate: cancelDate,
        debit: inv.totalAmount,
        credit: "0.00",
        description: `لغو فاکتور خرید ${inv.invoiceNumber}: ${params.reason}`,
      });
    }

    const [cancelled] = await tx
      .update(purchaseInvoices)
      .set({
        status: "CANCELLED",
        cancellationReason: params.reason,
        cancelledAt: new Date(),
        version: inv.version + 1,
        syncSeq: Date.now(),
        updatedAt: new Date(),
      })
      .where(eq(purchaseInvoices.id, inv.id))
      .returning();

    await appendSyncChangeLog(tx, {
      organizationId: params.organizationId,
      entityType: "purchase",
      entityId: cancelled.id,
      operation: "UPSERT",
      version: cancelled.version,
      payload: { id: cancelled.id, document_number: cancelled.invoiceNumber, status: "CANCELLED" },
    });

    return {
      invoice: cancelled,
      reversal_journal: reversalJournal,
      reversal_stock_document: reversalStockDoc,
    };
  });

  await recordAuditLog({
    organizationId: params.organizationId,
    actorUserId: params.actorUserId,
    actorEmail: params.actorEmail,
    scope: "ORGANIZATION",
    action: "PURCHASE_INVOICE_CANCELLED",
    entityType: "PURCHASE_INVOICE",
    entityId: params.invoiceId,
    ipAddress: params.ipAddress,
    metadata: { reason: params.reason },
  });

  return result;
}

// ============================================================================
// 4. ITEM-LEVEL PARTIAL/FULL PURCHASE RETURN (Stock OUT + DR AP / CR Inventory)
// ============================================================================
export async function returnPurchaseInvoice(params: {
  organizationId: string;
  invoiceId: string;
  notes?: string;
  returnDate?: string;
  items: ReturnItemInput[];
  idempotencyKey?: string | null;
  actorUserId: string;
  actorEmail: string;
  ipAddress?: string | null;
}) {
  const result = await withTenantTransaction(params.organizationId, async (tx) => {
    const [inv] = await tx
      .select()
      .from(purchaseInvoices)
      .where(and(eq(purchaseInvoices.id, params.invoiceId), eq(purchaseInvoices.organizationId, params.organizationId)))
      .limit(1);

    if (!inv) throw new ApiError(404, "PURCHASE_NOT_FOUND", "فاکتور خرید یافت نشد.");
    if (!["CONFIRMED", "FINALIZED", "PARTIALLY_RETURNED"].includes(inv.status)) {
      throw new ApiError(409, "INVOICE_NOT_RETURNABLE", `فاکتور خرید با وضعیت ${inv.status} قابل برگشت نیست.`);
    }

    const origItems = await tx
      .select()
      .from(purchaseInvoiceItems)
      .where(eq(purchaseInvoiceItems.purchaseInvoiceId, inv.id));
    const origMap = new Map(origItems.map((it) => [it.id, it]));

    const prevReturnItems =
      origItems.length > 0
        ? await tx
            .select()
            .from(purchaseReturnItems)
            .where(
              and(
                eq(purchaseReturnItems.organizationId, params.organizationId),
                inArray(
                  purchaseReturnItems.originalItemId,
                  origItems.map((i) => i.id)
                )
              )
            )
        : [];

    const returnedByOrigId = new Map<string, bigint>();
    for (const pri of prevReturnItems) {
      returnedByOrigId.set(
        pri.originalItemId,
        addDec(returnedByOrigId.get(pri.originalItemId) ?? BigInt(0), pri.quantity)
      );
    }

    let returnGrandTotal = BigInt(0);
    const validatedItems: Array<{
      originalItemId: string;
      productId: string;
      variantId: string | null;
      warehouseId: string;
      quantity: string;
      unitPrice: string;
      lineTotal: string;
      reason: string | null;
    }> = [];

    for (const reqItem of params.items) {
      const orig = origMap.get(reqItem.original_item_id);
      if (!orig) {
        throw new ApiError(422, "ORIGINAL_ITEM_NOT_FOUND", `آیتم فاکتور خرید (${reqItem.original_item_id}) یافت نشد.`);
      }
      if (orig.productId !== reqItem.product_id) {
        throw new ApiError(422, "PRODUCT_MISMATCH", "کالای برگشتی با آیتم فاکتور خرید مطابقت ندارد.");
      }
      const reqQty = parseDecimal(reqItem.quantity);
      if (!isPositiveDec(reqQty)) {
        throw new ApiError(422, "QUANTITY_INVALID", "تعداد برگشتی باید بزرگ‌تر از صفر باشد.");
      }

      const alreadyReturned = returnedByOrigId.get(orig.id) ?? BigInt(0);
      const remaining = subDec(orig.quantity, alreadyReturned);
      if (gtDec(reqQty, remaining)) {
        throw new ApiError(
          422,
          "RETURN_QTY_EXCEEDS_REMAINING",
          `مقدار برگشت خرید (${reqItem.quantity}) از مقدار باقی‌مانده قابل برگشت (${formatDecimal(remaining, 4)}) بیشتر است.`
        );
      }
      returnedByOrigId.set(orig.id, addDec(alreadyReturned, reqQty));

      const verifiedPrice = reqItem.unit_price
        ? parseDecimal(reqItem.unit_price)
        : parseDecimal(orig.unitPrice);
      if (gtDec(verifiedPrice, parseDecimal(orig.unitPrice))) {
        throw new ApiError(422, "RETURN_PRICE_EXCEEDS_ORIGINAL", "قیمت برگشت خرید نمی‌تواند بیشتر از قیمت فاکتور اصلی باشد.");
      }
      const lineTotalDec = mulDec(reqQty, verifiedPrice);
      returnGrandTotal = addDec(returnGrandTotal, lineTotalDec);

      validatedItems.push({
        originalItemId: orig.id,
        productId: orig.productId,
        variantId: reqItem.product_variant_id ?? orig.variantId ?? null,
        warehouseId: reqItem.warehouse_id || inv.warehouseId,
        quantity: formatDecimal(reqQty, 4),
        unitPrice: formatDecimal(verifiedPrice, 2),
        lineTotal: formatDecimal(lineTotalDec, 2),
        reason: reqItem.reason ?? params.notes ?? null,
      });
    }

    const retDate = params.returnDate || new Date().toISOString().slice(0, 10);
    const retNum = `PR-${Date.now().toString().slice(-6)}`;
    const totalStr = formatDecimal(returnGrandTotal, 2);

    // 1. Stock Ledger OUT (blocks if goods were already sold/consumed under negative stock BLOCK policy!)
    const byWh = new Map<string, typeof validatedItems>();
    for (const vi of validatedItems) {
      const list = byWh.get(vi.warehouseId) ?? [];
      list.push(vi);
      byWh.set(vi.warehouseId, list);
    }

    let primaryStockDocId: string | null = null;
    for (const [whId, whItems] of byWh.entries()) {
      const stkRes = await postStockDocumentTx(tx, {
        organizationId: params.organizationId,
        warehouseId: whId,
        documentType: "ISSUE",
        documentDate: retDate,
        reason: `حواله خروج برگشت از خرید ${retNum} (فاکتور ${inv.invoiceNumber})`,
        referenceType: "PURCHASE_RETURN",
        referenceId: inv.id,
        actorUserId: params.actorUserId,
        items: whItems.map((i) => ({
          productId: i.productId,
          variantId: i.variantId,
          direction: "OUT",
          quantity: i.quantity,
        })),
      });
      if (!primaryStockDocId) primaryStockDocId = stkRes.document.id;
    }

    // 2. Balanced Accounting Journal: DR AP / CR Inventory
    const orgAccs = await tx.select().from(accounts).where(eq(accounts.organizationId, params.organizationId));
    const apAcc = orgAccs.find((a) => a.systemRole === "AP");
    const invAcc = orgAccs.find((a) => a.systemRole === "INVENTORY");
    let journalEntry = null;
    if (apAcc && invAcc) {
      const jr = await createJournalEntryTx(tx, {
        organizationId: params.organizationId,
        actorUserId: params.actorUserId,
        actorEmail: params.actorEmail,
        entryDate: retDate,
        description: `سند برگشت از خرید ${retNum} بابت فاکتور ${inv.invoiceNumber}`,
        referenceType: "PURCHASE_RETURN",
        referenceId: inv.id,
        postImmediately: true,
        lines: [
          { accountId: apAcc.id, contactId: inv.contactId, debit: totalStr, credit: "0.00", description: `کاهش بدهی تأمین‌کننده (${retNum})` },
          { accountId: invAcc.id, debit: "0.00", credit: totalStr, description: `کاهش موجودی کالا بابت برگشت خرید (${retNum})` },
        ],
      });
      journalEntry = jr.entry;
    }

    const [retDoc] = await tx
      .insert(purchaseReturns)
      .values({
        organizationId: params.organizationId,
        purchaseInvoiceId: inv.id,
        returnNumber: retNum,
        returnDate: retDate,
        totalAmount: totalStr,
        reason: params.notes ?? "برگشت از خرید",
        stockDocumentId: primaryStockDocId,
        journalEntryId: journalEntry?.id ?? null,
        idempotencyKey: params.idempotencyKey ?? null,
        createdBy: params.actorUserId,
      })
      .returning();

    const savedItems = await tx
      .insert(purchaseReturnItems)
      .values(
        validatedItems.map((vi) => ({
          organizationId: params.organizationId,
          purchaseReturnId: retDoc.id,
          originalItemId: vi.originalItemId,
          productId: vi.productId,
          variantId: vi.variantId,
          warehouseId: vi.warehouseId,
          quantity: vi.quantity,
          unitPrice: vi.unitPrice,
          lineTotal: vi.lineTotal,
          reason: vi.reason,
        }))
      )
      .returning();

    await tx.insert(contactTransactions).values({
      organizationId: params.organizationId,
      contactId: inv.contactId,
      referenceType: "PURCHASE_RETURN",
      referenceId: retDoc.id,
      txDate: retDate,
      debit: totalStr,
      credit: "0.00",
      description: `برگشت از خرید ${retNum} (فاکتور ${inv.invoiceNumber})`,
    });

    const fullyReturned = origItems.every((it) => {
      const totRet = returnedByOrigId.get(it.id) ?? BigInt(0);
      return subDec(it.quantity, totRet) <= BigInt(0);
    });
    const nextRem = subDec(inv.remainingAmount, returnGrandTotal);
    const [updatedInv] = await tx
      .update(purchaseInvoices)
      .set({
        status: fullyReturned ? "RETURNED" : "PARTIALLY_RETURNED",
        remainingAmount: formatDecimal(nextRem < BigInt(0) ? BigInt(0) : nextRem, 2),
        version: inv.version + 1,
        syncSeq: Date.now(),
        updatedAt: new Date(),
      })
      .where(eq(purchaseInvoices.id, inv.id))
      .returning();

    await appendSyncChangeLog(tx, {
      organizationId: params.organizationId,
      entityType: "purchase",
      entityId: updatedInv.id,
      operation: "UPSERT",
      version: updatedInv.version,
      payload: { id: updatedInv.id, document_number: updatedInv.invoiceNumber, status: updatedInv.status },
    });

    return {
      return_document: retDoc,
      items: savedItems,
      invoice: updatedInv,
      journal_entry: journalEntry,
    };
  });

  await recordAuditLog({
    organizationId: params.organizationId,
    actorUserId: params.actorUserId,
    actorEmail: params.actorEmail,
    scope: "ORGANIZATION",
    action: "PURCHASE_RETURN_CREATED",
    entityType: "PURCHASE_RETURN",
    entityId: result.return_document.id,
    ipAddress: params.ipAddress,
    metadata: { invoiceId: params.invoiceId, totalAmount: result.return_document.totalAmount },
  });

  return result;
}

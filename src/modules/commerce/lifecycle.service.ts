import { and, eq, inArray, sql } from "drizzle-orm";
import {
  accounts,
  contactTransactions,
  journalEntries,
  journalEntryLines,
  organizations,
  purchaseInvoiceItems,
  purchaseInvoices,
  purchaseReturnItems,
  purchaseReturns,
  salesInvoiceItems,
  salesInvoices,
  salesReturnItems,
  salesReturns,
  stockDocumentItems,
} from "@/db/schema";
import { recordAuditLog } from "@/lib/audit";
import {
  addDec,
  divDec,
  eqDec,
  formatDecimal,
  gtDec,
  isNegativeDec,
  isPositiveDec,
  isZeroDec,
  mulDec,
  parseDecimal,
  subDec,
} from "@/lib/decimal";
import { ApiError } from "@/lib/errors";
import { withTenantTransaction } from "@/lib/tenant";
import { createJournalEntryTx, JournalLineInput } from "@/modules/accounting/service";
import { postStockDocumentTx } from "@/modules/inventory/service";
import { appendSyncChangeLog } from "@/modules/sync/changelog";
import { ensurePrompt05OrgDefaults } from "@/db/seed-prompt05";

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
    await tx.execute(sql`
      SELECT id FROM sales_invoices
      WHERE id = ${params.invoiceId} AND organization_id = ${params.organizationId}
      FOR UPDATE
    `);
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
    if ((inv.status === "CONFIRMED" || inv.status === "FINALIZED") && isPositiveDec(parseDecimal(inv.paidAmount))) {
      throw new ApiError(
        409,
        "PAID_SALE_REQUIRES_RETURN",
        "این فاکتور دریافت وجه دارد؛ از برگشت کالا و ثبت جداگانهٔ استرداد وجه استفاده کنید تا ماندهٔ خزانه هم اصلاح شود."
      );
    }
    if ((inv.status === "CONFIRMED" || inv.status === "FINALIZED") && !inv.journalEntryId) {
      throw new ApiError(
        409,
        "CONFIRMED_SALE_MISSING_JOURNAL",
        "فاکتور قطعی فاقد سند حسابداری پیوندخورده است؛ ابتدا مغایرت حسابداری را رفع کنید."
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

      const originalStockItems = inv.stockDocumentId
        ? await tx
            .select()
            .from(stockDocumentItems)
            .where(eq(stockDocumentItems.stockDocumentId, inv.stockDocumentId))
        : [];
      const originalUnitCost = new Map(
        originalStockItems.map((item) => [`${item.productId}:${item.variantId ?? "BASE"}`, item.unitCost])
      );

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
            unitCost: originalUnitCost.get(`${it.productId}:${it.variantId ?? "BASE"}`),
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
          const [markedOriginal] = await tx
            .update(journalEntries)
            .set({
              status: "REVERSED",
              reversedEntryId: revRes.entry.id,
              version: sql`${journalEntries.version} + 1`,
              syncSeq: Date.now(),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(journalEntries.id, inv.journalEntryId),
                eq(journalEntries.organizationId, params.organizationId),
                eq(journalEntries.status, "POSTED")
              )
            )
            .returning();
          if (!markedOriginal) {
            throw new ApiError(409, "JOURNAL_ALREADY_CHANGED", "سند حسابداری فاکتور هم‌زمان تغییر کرده است.");
          }
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
    await tx.execute(sql`
      SELECT id FROM sales_invoices
      WHERE id = ${params.invoiceId} AND organization_id = ${params.organizationId}
      FOR UPDATE
    `);
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
    const originalStockItems = inv.stockDocumentId
      ? await tx
          .select()
          .from(stockDocumentItems)
          .where(eq(stockDocumentItems.stockDocumentId, inv.stockDocumentId))
      : [];
    const originalUnitCost = new Map(
      originalStockItems.map((item) => [`${item.productId}:${item.variantId ?? "BASE"}`, item.unitCost])
    );

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

    let grossReturnTotal = BigInt(0);
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
      unitCost?: string;
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
      grossReturnTotal = addDec(grossReturnTotal, lineTotalDec);

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
        unitCost: originalUnitCost.get(`${orig.productId}:${reqItem.product_variant_id ?? orig.variantId ?? "BASE"}`),
        lineTotal: formatDecimal(lineTotalDec, 2),
        reason: reqItem.reason ?? params.notes ?? null,
      });
    }

    const previousGrossReturnTotal = prevReturnItems.reduce((sum, item) => addDec(sum, parseDecimal(item.lineTotal)), BigInt(0));
    const cumulativeGrossReturnTotal = addDec(previousGrossReturnTotal, grossReturnTotal);
    const invoiceSubtotal = parseDecimal(inv.subtotal);
    const allocateInvoiceAmount = (amount: string, grossAmount: bigint) =>
      isPositiveDec(parseDecimal(amount)) && isPositiveDec(invoiceSubtotal)
        ? mulDec(parseDecimal(amount), divDec(grossAmount, invoiceSubtotal))
        : BigInt(0);
    const discountShare = subDec(
      allocateInvoiceAmount(inv.discountAmount, cumulativeGrossReturnTotal),
      allocateInvoiceAmount(inv.discountAmount, previousGrossReturnTotal)
    );
    const taxShare = subDec(
      allocateInvoiceAmount(inv.taxAmount, cumulativeGrossReturnTotal),
      allocateInvoiceAmount(inv.taxAmount, previousGrossReturnTotal)
    );
    const revenueReturnTotal = subDec(grossReturnTotal, discountShare);
    const returnGrandTotal = addDec(revenueReturnTotal, taxShare);
    if (!isPositiveDec(returnGrandTotal)) throw new ApiError(422, "RETURN_TOTAL_INVALID", "مبلغ برگشت پس از محاسبهٔ تخفیف و مالیات باید بزرگ‌تر از صفر باشد.");

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
          unitCost: i.unitCost,
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
    const taxPayableAcc = byRole.get("TAX_PAYABLE");
    const discountAcc = byRole.get("SALES_DISCOUNT");
    if (!revAcc || !arAcc) throw new ApiError(422, "SALES_RETURN_ACCOUNT_MAPPING_MISSING", "حساب‌های درآمد فروش و دریافتنی برای ثبت برگشت فروش لازم‌اند.");
    if (isPositiveDec(taxShare) && !taxPayableAcc) throw new ApiError(422, "TAX_PAYABLE_ACCOUNT_MISSING", "برای برگشت فروش دارای مالیات، حساب مالیات پرداختنی لازم است.");
    if (isPositiveDec(discountShare) && !discountAcc) throw new ApiError(422, "SALES_DISCOUNT_ACCOUNT_MISSING", "برای برگشت فاکتور تخفیف‌دار، حساب تخفیف فروش لازم است.");
    if (isPositiveDec(totalRestoredCost) && (!invAcc || !cogsAcc)) throw new ApiError(422, "SALES_RETURN_INVENTORY_ACCOUNT_MISSING", "برای برگشت کالای سالم، حساب موجودی و بهای تمام‌شده لازم است.");

    const jLines: JournalLineInput[] = [];
    if (isPositiveDec(revenueReturnTotal)) jLines.push({ accountId: revAcc.id, debit: formatDecimal(revenueReturnTotal, 2), credit: "0.00", description: `برگشت خالص فروش ${retNum}` });
    if (isPositiveDec(taxShare)) jLines.push({ accountId: taxPayableAcc!.id, debit: formatDecimal(taxShare, 2), credit: "0.00", description: `برگشت مالیات فروش ${retNum}` });
    if (isPositiveDec(discountShare)) jLines.push({ accountId: discountAcc!.id, debit: "0.00", credit: formatDecimal(discountShare, 2), description: `برگشت تخفیف فروش ${retNum}` });
    jLines.push({ accountId: arAcc.id, contactId: inv.contactId, debit: "0.00", credit: totalStr, description: `بستانکاری مشتری بابت برگشت ${retNum}` });
    if (isPositiveDec(totalRestoredCost)) {
      const costStr = formatDecimal(totalRestoredCost, 2);
      jLines.push(
        { accountId: invAcc!.id, debit: costStr, credit: "0.00", description: `بازگشت کالا به انبار (${retNum})` },
        { accountId: cogsAcc!.id, debit: "0.00", credit: costStr, description: `کاهش بهای تمام‌شده بابت برگشت (${retNum})` }
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
    const journalEntry = jr.entry;

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
    await tx.execute(sql`
      SELECT id FROM purchase_invoices
      WHERE id = ${params.invoiceId} AND organization_id = ${params.organizationId}
      FOR UPDATE
    `);
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
    if ((inv.status === "CONFIRMED" || inv.status === "FINALIZED") && !inv.journalEntryId) {
      throw new ApiError(
        409,
        "CONFIRMED_PURCHASE_MISSING_JOURNAL",
        "فاکتور خرید قطعی فاقد سند حسابداری پیوندخورده است؛ ابتدا مغایرت حسابداری را رفع کنید."
      );
    }

    let reversalJournal = null;
    let reversalStockDoc = null;
    const cancelDate = new Date().toISOString().slice(0, 10);

    if (inv.status === "CONFIRMED" || inv.status === "FINALIZED") {
      const invItems = await tx
        .select()
        .from(purchaseInvoiceItems)
        .where(eq(purchaseInvoiceItems.purchaseInvoiceId, inv.id));
      const originalStockItems = inv.stockDocumentId
        ? await tx
            .select()
            .from(stockDocumentItems)
            .where(eq(stockDocumentItems.stockDocumentId, inv.stockDocumentId))
        : [];
      const originalUnitCost = new Map(
        originalStockItems.map((item) => [`${item.productId}:${item.variantId ?? "BASE"}`, item.unitCost])
      );

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
            unitCost: originalUnitCost.get(`${it.productId}:${it.variantId ?? "BASE"}`),
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
          const [markedOriginal] = await tx
            .update(journalEntries)
            .set({
              status: "REVERSED",
              reversedEntryId: revRes.entry.id,
              version: sql`${journalEntries.version} + 1`,
              syncSeq: Date.now(),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(journalEntries.id, inv.journalEntryId),
                eq(journalEntries.organizationId, params.organizationId),
                eq(journalEntries.status, "POSTED")
              )
            )
            .returning();
          if (!markedOriginal) {
            throw new ApiError(409, "JOURNAL_ALREADY_CHANGED", "سند حسابداری فاکتور خرید هم‌زمان تغییر کرده است.");
          }
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
  await ensurePrompt05OrgDefaults(params.organizationId);
  const result = await withTenantTransaction(params.organizationId, async (tx) => {
    if (params.idempotencyKey) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${params.organizationId}:purchase-return:${params.idempotencyKey}`}))`);
      const [existingReturn] = await tx.select().from(purchaseReturns).where(and(
        eq(purchaseReturns.organizationId, params.organizationId),
        eq(purchaseReturns.idempotencyKey, params.idempotencyKey)
      )).limit(1);
      if (existingReturn) throw new ApiError(409, "PURCHASE_RETURN_ALREADY_APPLIED", "این کلید تکرار قبلاً برای برگشت خرید استفاده شده است.");
    }
    await tx.execute(sql`
      SELECT id FROM purchase_invoices
      WHERE id = ${params.invoiceId} AND organization_id = ${params.organizationId}
      FOR UPDATE
    `);
    const [inv] = await tx
      .select()
      .from(purchaseInvoices)
      .where(and(eq(purchaseInvoices.id, params.invoiceId), eq(purchaseInvoices.organizationId, params.organizationId)))
      .limit(1);

    if (!inv) throw new ApiError(404, "PURCHASE_NOT_FOUND", "فاکتور خرید یافت نشد.");
    if (!["CONFIRMED", "FINALIZED", "PARTIALLY_RETURNED"].includes(inv.status)) {
      throw new ApiError(409, "INVOICE_NOT_RETURNABLE", `فاکتور خرید با وضعیت ${inv.status} قابل برگشت نیست.`);
    }
    const [organization] = await tx.select({ baseCurrency: organizations.baseCurrency }).from(organizations).where(eq(organizations.id, params.organizationId)).limit(1);
    if (!organization) throw new ApiError(404, "ORG_NOT_FOUND", "سازمان یافت نشد.");
    if (inv.currency !== organization.baseCurrency) {
      throw new ApiError(422, "FOREIGN_CURRENCY_POSTING_UNSUPPORTED", `برگشت فاکتور با ارز ${inv.currency} تا پیاده‌سازی تسعیر چندارزی مجاز نیست.`);
    }

    const origItems = await tx
      .select()
      .from(purchaseInvoiceItems)
      .where(eq(purchaseInvoiceItems.purchaseInvoiceId, inv.id));
    const origMap = new Map(origItems.map((it) => [it.id, it]));
    const originalStockItems = inv.stockDocumentId
      ? await tx
          .select()
          .from(stockDocumentItems)
          .where(eq(stockDocumentItems.stockDocumentId, inv.stockDocumentId))
      : [];
    const originalUnitCost = new Map(
      originalStockItems.map((item) => [`${item.productId}:${item.variantId ?? "BASE"}`, item.unitCost])
    );

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
    const previousGrossByOrigId = new Map<string, bigint>();
    for (const pri of prevReturnItems) {
      returnedByOrigId.set(
        pri.originalItemId,
        addDec(returnedByOrigId.get(pri.originalItemId) ?? BigInt(0), pri.quantity)
      );
      previousGrossByOrigId.set(
        pri.originalItemId,
        addDec(previousGrossByOrigId.get(pri.originalItemId) ?? BigInt(0), parseDecimal(pri.lineTotal))
      );
    }

    const originalDiscountTotal = origItems.reduce((sum, item) => addDec(sum, parseDecimal(item.discountAmount)), BigInt(0));
    if (gtDec(originalDiscountTotal, parseDecimal(inv.discountAmount))) {
      throw new ApiError(409, "PURCHASE_DISCOUNT_SNAPSHOT_INVALID", "جمع تخفیف ردیف‌های خرید از تخفیف ثبت‌شده در فاکتور بیشتر است.");
    }
    const headerDiscount = subDec(parseDecimal(inv.discountAmount), originalDiscountTotal);
    const invoiceNetBeforeHeaderDiscount = subDec(parseDecimal(inv.subtotal), originalDiscountTotal);
    const previousReturnedNetBeforeHeaderDiscount = origItems.reduce((sum, item) => {
      const originalGross = parseDecimal(item.lineTotal);
      const previousGross = previousGrossByOrigId.get(item.id) ?? BigInt(0);
      const discountBefore = isPositiveDec(originalGross)
        ? mulDec(parseDecimal(item.discountAmount), divDec(previousGross, originalGross))
        : BigInt(0);
      return addDec(sum, subDec(previousGross, discountBefore));
    }, BigInt(0));
    const persistedLineTaxTotal = origItems.reduce((sum, item) => addDec(sum, parseDecimal(item.taxAmount)), BigInt(0));
    if (isPositiveDec(persistedLineTaxTotal) && !eqDec(persistedLineTaxTotal, parseDecimal(inv.taxAmount))) {
      throw new ApiError(409, "PURCHASE_TAX_SNAPSHOT_INVALID", "جمع مالیات ردیف‌های خرید با مالیات ثبت‌شده در فاکتور برابر نیست.");
    }
    const lineTaxByOrigId = new Map<string, bigint>();
    if (isPositiveDec(persistedLineTaxTotal)) {
      for (const item of origItems) lineTaxByOrigId.set(item.id, parseDecimal(item.taxAmount));
    } else if (isPositiveDec(parseDecimal(inv.taxAmount))) {
      let allocatedTax = BigInt(0);
      const originalTaxableBasis = invoiceNetBeforeHeaderDiscount;
      origItems.forEach((item, index) => {
        const netBasis = subDec(parseDecimal(item.lineTotal), parseDecimal(item.discountAmount));
        const allocated = index === origItems.length - 1
          ? subDec(parseDecimal(inv.taxAmount), allocatedTax)
          : (isPositiveDec(originalTaxableBasis) ? mulDec(parseDecimal(inv.taxAmount), divDec(netBasis, originalTaxableBasis)) : BigInt(0));
        lineTaxByOrigId.set(item.id, allocated);
        allocatedTax = addDec(allocatedTax, allocated);
      });
    }
    const cumulativeGrossByOrigId = new Map(previousGrossByOrigId);

    let grossPurchaseReturn = BigInt(0);
    let lineDiscountShareTotal = BigInt(0);
    let returnTaxShareTotal = BigInt(0);
    let currentReturnedNetBeforeHeaderDiscount = BigInt(0);
    const validatedItems: Array<{
      originalItemId: string;
      productId: string;
      variantId: string | null;
      warehouseId: string;
      quantity: string;
      unitPrice: string;
      unitCost?: string;
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
      if (reqItem.product_variant_id != null && reqItem.product_variant_id !== (orig.variantId ?? null)) {
        throw new ApiError(422, "VARIANT_MISMATCH", "تنوع کالای برگشتی با ردیف اصلی فاکتور خرید مطابقت ندارد.");
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
      if (!isPositiveDec(verifiedPrice)) throw new ApiError(422, "RETURN_PRICE_INVALID", "قیمت برگشت کالا باید بزرگ‌تر از صفر باشد.");
      if (gtDec(verifiedPrice, parseDecimal(orig.unitPrice))) {
        throw new ApiError(422, "RETURN_PRICE_EXCEEDS_ORIGINAL", "قیمت برگشت خرید نمی‌تواند بیشتر از قیمت فاکتور اصلی باشد.");
      }
      const lineTotalDec = mulDec(reqQty, verifiedPrice);
      grossPurchaseReturn = addDec(grossPurchaseReturn, lineTotalDec);
      const originalGross = parseDecimal(orig.lineTotal);
      const grossBefore = cumulativeGrossByOrigId.get(orig.id) ?? BigInt(0);
      const grossAfter = addDec(grossBefore, lineTotalDec);
      if (gtDec(grossAfter, originalGross)) throw new ApiError(422, "RETURN_VALUE_EXCEEDS_ORIGINAL", "مبلغ تجمعی برگشت این ردیف از مبلغ ردیف اصلی بیشتر است.");
      const originalDiscount = parseDecimal(orig.discountAmount);
      const discountBefore = isPositiveDec(originalGross) ? mulDec(originalDiscount, divDec(grossBefore, originalGross)) : BigInt(0);
      const discountAfter = isPositiveDec(originalGross) ? mulDec(originalDiscount, divDec(grossAfter, originalGross)) : BigInt(0);
      const itemDiscountShare = subDec(discountAfter, discountBefore);
      const netBefore = subDec(grossBefore, discountBefore);
      const netAfter = subDec(grossAfter, discountAfter);
      const originalNetBasis = subDec(originalGross, originalDiscount);
      const originalTax = lineTaxByOrigId.get(orig.id) ?? BigInt(0);
      const taxBefore = isPositiveDec(originalNetBasis) ? mulDec(originalTax, divDec(netBefore, originalNetBasis)) : BigInt(0);
      const taxAfter = isPositiveDec(originalNetBasis) ? mulDec(originalTax, divDec(netAfter, originalNetBasis)) : BigInt(0);
      lineDiscountShareTotal = addDec(lineDiscountShareTotal, subDec(discountAfter, discountBefore));
      returnTaxShareTotal = addDec(returnTaxShareTotal, subDec(taxAfter, taxBefore));
      currentReturnedNetBeforeHeaderDiscount = addDec(currentReturnedNetBeforeHeaderDiscount, subDec(lineTotalDec, itemDiscountShare));
      cumulativeGrossByOrigId.set(orig.id, grossAfter);

      validatedItems.push({
        originalItemId: orig.id,
        productId: orig.productId,
        variantId: reqItem.product_variant_id ?? orig.variantId ?? null,
        warehouseId: reqItem.warehouse_id || inv.warehouseId,
        quantity: formatDecimal(reqQty, 4),
        unitPrice: formatDecimal(verifiedPrice, 2),
        unitCost: originalUnitCost.get(`${orig.productId}:${reqItem.product_variant_id ?? orig.variantId ?? "BASE"}`),
        lineTotal: formatDecimal(lineTotalDec, 2),
        reason: reqItem.reason ?? params.notes ?? null,
      });
    }

    const cumulativeReturnedNetBeforeHeaderDiscount = addDec(previousReturnedNetBeforeHeaderDiscount, currentReturnedNetBeforeHeaderDiscount);
    const headerDiscountBefore = isPositiveDec(invoiceNetBeforeHeaderDiscount)
      ? mulDec(headerDiscount, divDec(previousReturnedNetBeforeHeaderDiscount, invoiceNetBeforeHeaderDiscount))
      : BigInt(0);
    const headerDiscountAfter = isPositiveDec(invoiceNetBeforeHeaderDiscount)
      ? mulDec(headerDiscount, divDec(cumulativeReturnedNetBeforeHeaderDiscount, invoiceNetBeforeHeaderDiscount))
      : BigInt(0);
    const headerDiscountShare = subDec(headerDiscountAfter, headerDiscountBefore);
    const totalDiscountShare = addDec(lineDiscountShareTotal, headerDiscountShare);
    const returnGrandTotal = addDec(subDec(grossPurchaseReturn, totalDiscountShare), returnTaxShareTotal);
    if (!isPositiveDec(returnGrandTotal)) throw new ApiError(422, "PURCHASE_RETURN_TOTAL_INVALID", "مبلغ برگشت خرید پس از محاسبهٔ تخفیف و مالیات باید بزرگ‌تر از صفر باشد.");

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
    let totalIssuedCost = BigInt(0);
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
          unitCost: i.unitCost,
        })),
      });
      if (!primaryStockDocId) primaryStockDocId = stkRes.document.id;
      totalIssuedCost = addDec(totalIssuedCost, stkRes.totalCostValue);
    }

    // 2. Balanced Accounting Journal: DR AP / CR Inventory
    const orgAccs = await tx.select().from(accounts).where(eq(accounts.organizationId, params.organizationId));
    const apAcc = orgAccs.find((a) => a.systemRole === "AP");
    const invAcc = orgAccs.find((a) => a.systemRole === "INVENTORY");
    const cogsAcc = orgAccs.find((a) => a.systemRole === "COGS");
    const taxReceivableAcc = orgAccs.find((a) => a.systemRole === "TAX_RECEIVABLE");
    const supplierAdvanceAcc = orgAccs.find((a) => a.systemRole === "SUPPLIER_ADVANCE");
    if (!apAcc || !invAcc) throw new ApiError(422, "PURCHASE_RETURN_ACCOUNT_MAPPING_MISSING", "حساب‌های پرداختنی و موجودی برای ثبت برگشت خرید لازم‌اند.");
    if (isPositiveDec(returnTaxShareTotal) && !taxReceivableAcc) throw new ApiError(422, "TAX_RECEIVABLE_ACCOUNT_MISSING", "برای برگشت خرید دارای مالیات، حساب اعتبار مالیات بر ارزش افزوده لازم است.");
    const apReduction = parseDecimal(inv.remainingAmount) < returnGrandTotal ? parseDecimal(inv.remainingAmount) : returnGrandTotal;
    const supplierAdvanceCreated = subDec(returnGrandTotal, apReduction);
    if (isPositiveDec(supplierAdvanceCreated) && !supplierAdvanceAcc) {
      throw new ApiError(422, "SUPPLIER_ADVANCE_ACCOUNT_MISSING", "برای برگشتی که از ماندهٔ پرداختنی بیشتر است، حساب پیش‌پرداخت تأمین‌کننده لازم است.");
    }
    const variance = subDec(addDec(totalIssuedCost, returnTaxShareTotal), returnGrandTotal);
    if (!isZeroDec(variance) && !cogsAcc) throw new ApiError(422, "PURCHASE_RETURN_VARIANCE_ACCOUNT_REQUIRED", "برای ثبت اختلاف بهای برگشت خرید، حساب بهای تمام‌شده لازم است.");
    const purchaseReturnLines: JournalLineInput[] = [
      ...(isPositiveDec(apReduction) ? [{ accountId: apAcc.id, contactId: inv.contactId, debit: formatDecimal(apReduction, 2), credit: "0.00", description: `کاهش ماندهٔ پرداختنی تأمین‌کننده (${retNum})` }] : []),
      ...(isPositiveDec(supplierAdvanceCreated) ? [{ accountId: supplierAdvanceAcc!.id, contactId: inv.contactId, debit: formatDecimal(supplierAdvanceCreated, 2), credit: "0.00", description: `اعتبار برگشت کالا نزد تأمین‌کننده (${retNum})` }] : []),
      ...(isPositiveDec(totalIssuedCost) ? [{ accountId: invAcc.id, debit: "0.00", credit: formatDecimal(totalIssuedCost, 2), description: `کاهش موجودی کالا با بهای دفتری (${retNum})` }] : []),
      ...(isPositiveDec(returnTaxShareTotal) ? [{ accountId: taxReceivableAcc!.id, debit: "0.00", credit: formatDecimal(returnTaxShareTotal, 2), description: `برگشت اعتبار مالیات خرید (${retNum})` }] : []),
      ...(!isZeroDec(variance) ? [{
        accountId: cogsAcc!.id,
        debit: isPositiveDec(variance) ? formatDecimal(variance, 2) : "0.00",
        credit: isNegativeDec(variance) ? formatDecimal(-variance, 2) : "0.00",
        description: `مابه‌التفاوت بهای دفتری و مبلغ برگشت خرید (${retNum})`,
      }] : []),
    ];
    const jr = await createJournalEntryTx(tx, {
      organizationId: params.organizationId,
      actorUserId: params.actorUserId,
      actorEmail: params.actorEmail,
      entryDate: retDate,
      description: `سند برگشت از خرید ${retNum} بابت فاکتور ${inv.invoiceNumber}`,
      referenceType: "PURCHASE_RETURN",
      referenceId: inv.id,
      postImmediately: true,
      lines: purchaseReturnLines,
    });
    const journalEntry = jr.entry;

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
    const nextRem = subDec(inv.remainingAmount, apReduction);
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

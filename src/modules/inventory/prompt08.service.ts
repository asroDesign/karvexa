import { and, asc, desc, eq, gt, gte, inArray, lte, sql } from "drizzle-orm";
import * as XLSX from "xlsx";
import { db } from "@/db";
import {
  accounts,
  categories,
  contacts,
  contactTransactions,
  financialAccounts,
  financialTransactions,
  organizations,
  products,
  productVariants,
  purchaseInvoices,
  reportExportJobs,
  stockDocuments,
  stockLedger,
  stockTransferItems,
  stockTransfers,
  warehouses,
} from "@/db/schema";
import { recordAuditLog } from "@/lib/audit";
import {
  addDec,
  divDec,
  formatDecimal,
  gtDec,
  isNegativeDec,
  isPositiveDec,
  mulDec,
  parseDecimal,
  subDec,
} from "@/lib/decimal";
import { ApiError } from "@/lib/errors";
import { gregorianIsoToJalali, resolveCanonicalDate } from "@/lib/jalali";
import { withTenantTransaction } from "@/lib/tenant";
import { createJournalEntryTx, JournalLineInput } from "@/modules/accounting/service";
import { getLiveStockBalances, postStockDocumentTx } from "./service";

// ============================================================================
// 1. INCOMING WAREHOUSE RECEIPT WITH LANDED COSTING & SUPPLIER PAYABLE (§2.3)
// ============================================================================
export async function createLandedWarehouseReceipt(params: {
  organizationId: string;
  warehouseId: string;
  supplierId: string;
  supplierInvoiceNumber: string;
  invoiceDate?: string;
  invoiceDateJalali?: string;
  shippingCost: string;
  customsAndExtraCost: string;
  supplierDiscount: string;
  paymentBankAccountId?: string | null;
  paidAmount: string;
  attachmentUrl?: string | null;
  description?: string;
  actorUserId: string;
  actorEmail: string;
  ipAddress?: string | null;
  items: Array<{
    product_id: string;
    variant_id?: string | null;
    quantity: string;
    unit_price: string;
  }>;
}) {
  if (!params.supplierInvoiceNumber || params.supplierInvoiceNumber.trim().length < 1) {
    throw new ApiError(422, "SUPPLIER_INVOICE_NUMBER_REQUIRED", "شماره فاکتور تأمین‌کننده الزامی است.");
  }

  const canonicalDate = resolveCanonicalDate(params.invoiceDate, params.invoiceDateJalali);
  const shippingDec = parseDecimal(params.shippingCost || "0");
  const customsDec = parseDecimal(params.customsAndExtraCost || "0");
  const discountDec = parseDecimal(params.supplierDiscount || "0");
  const paidDec = parseDecimal(params.paidAmount || "0");

  if (isNegativeDec(shippingDec) || isNegativeDec(customsDec) || isNegativeDec(discountDec) || isNegativeDec(paidDec)) {
    throw new ApiError(422, "NEGATIVE_AMOUNT_NOT_ALLOWED", "مبالغ حمل، گمرک، تخفیف و پرداختی نمی‌توانند منفی باشند.");
  }

  let grossItemsTotal = BigInt(0);
  const lineGrossMap = params.items.map((it) => {
    const qty = parseDecimal(it.quantity);
    const price = parseDecimal(it.unit_price);
    if (!isPositiveDec(qty)) throw new ApiError(422, "QUANTITY_INVALID", "مقدار کالا باید بزرگ‌تر از صفر باشد.");
    const lineGross = mulDec(qty, price);
    grossItemsTotal = addDec(grossItemsTotal, lineGross);
    return { ...it, qty, price, lineGross };
  });

  if (!isPositiveDec(grossItemsTotal)) {
    throw new ApiError(422, "RECEIPT_GROSS_ZERO", "جمع مبلغ کالاهای رسید باید بزرگ‌تر از صفر باشد.");
  }

  // Exact Landed Acquisition Cost = grossItems + shipping + customs - supplierDiscount
  const netAcquisitionDec = subDec(
    addDec(grossItemsTotal, addDec(shippingDec, customsDec)),
    discountDec
  );
  if (isNegativeDec(netAcquisitionDec)) {
    throw new ApiError(422, "DISCOUNT_EXCEEDS_COST", "تخفیف تأمین‌کننده نمی‌تواند بیشتر از بهای کل کالاها باشد.");
  }
  if (gtDec(paidDec, netAcquisitionDec)) {
    throw new ApiError(
      422,
      "PAID_EXCEEDS_ACQUISITION_COST",
      `مبلغ پرداخت‌شده (${params.paidAmount}) نمی‌تواند بیشتر از بهای کل تمام‌شده (${formatDecimal(netAcquisitionDec, 2)}) باشد.`
    );
  }
  const remainingPayableDec = subDec(netAcquisitionDec, paidDec);

  // Proportionally allocate shipping + customs - discount to each item's effective landed unit cost
  let allocatedTotal = BigInt(0);
  const allocatedItems = lineGrossMap.map((li, index) => {
    const shareRatio = divDec(li.lineGross, grossItemsTotal); // scale-4 fraction
    // Assign any cent rounding remainder to the final line so the ledger cost
    // equals the AP/inventory journal exactly.
    const allocatedLineCost =
      index === lineGrossMap.length - 1
        ? subDec(netAcquisitionDec, allocatedTotal)
        : mulDec(netAcquisitionDec, shareRatio);
    allocatedTotal = addDec(allocatedTotal, allocatedLineCost);
    const effectiveUnitCost = divDec(allocatedLineCost, li.qty);
    return {
      productId: li.product_id,
      variantId: li.variant_id ?? null,
      direction: "IN" as const,
      quantity: li.quantity,
      unitCost: formatDecimal(effectiveUnitCost, 4),
      totalCost: formatDecimal(allocatedLineCost, 2),
    };
  });

  const result = await withTenantTransaction(params.organizationId, async (tx) => {
    const [organization] = await tx.select({ baseCurrency: organizations.baseCurrency }).from(organizations).where(eq(organizations.id, params.organizationId)).limit(1);
    if (!organization) throw new ApiError(404, "ORG_NOT_FOUND", "سازمان یافت نشد.");
    // Verify supplier exists in this org
    const [supplier] = await tx
      .select()
      .from(contacts)
      .where(and(eq(contacts.id, params.supplierId), eq(contacts.organizationId, params.organizationId)))
      .limit(1);
    if (!supplier) {
      throw new ApiError(404, "SUPPLIER_NOT_FOUND", "تأمین‌کننده انتخاب‌شده در این سازمان یافت نشد.");
    }

    // 1. Post Stock Ledger IN with landed unit costs
    const stockRes = await postStockDocumentTx(tx, {
      organizationId: params.organizationId,
      warehouseId: params.warehouseId,
      documentType: "RECEIPT",
      documentDate: canonicalDate,
      reason: params.description || `رسید ورود کالا — فاکتور تأمین‌کننده ${params.supplierInvoiceNumber}`,
      referenceType: "SUPPLIER_RECEIPT",
      actorUserId: params.actorUserId,
      items: allocatedItems,
    });

    // 2. If partial/full payment made, deduct selected Treasury Bank/Cash account
    let paymentFinAcc = null;
    if (isPositiveDec(paidDec)) {
      if (!params.paymentBankAccountId) {
        throw new ApiError(422, "PAYMENT_BANK_ACCOUNT_REQUIRED", "برای ثبت مبلغ پرداختی، انتخاب حساب بانکی/خزانه الزامی است.");
      }
      await tx.execute(sql`
        SELECT id FROM financial_accounts
        WHERE id = ${params.paymentBankAccountId} AND organization_id = ${params.organizationId}
        FOR UPDATE
      `);
      const [fa] = await tx
        .select()
        .from(financialAccounts)
        .where(
          and(
            eq(financialAccounts.id, params.paymentBankAccountId),
            eq(financialAccounts.organizationId, params.organizationId)
          )
        )
        .limit(1);
      if (!fa) throw new ApiError(404, "TREASURY_ACCOUNT_NOT_FOUND", "حساب بانکی/خزانه انتخاب‌شده یافت نشد.");
      if (!fa.isActive) throw new ApiError(409, "TREASURY_ACCOUNT_INACTIVE", "حساب بانکی/خزانه غیرفعال است.");
      if (fa.currency !== organization.baseCurrency) throw new ApiError(422, "FOREIGN_CURRENCY_TREASURY_UNSUPPORTED", `پرداخت رسید باید با حساب دارای ارز پایه ${organization.baseCurrency} انجام شود.`);
      if ((fa.accountType === "CASHBOX" || fa.accountType === "CASH") && gtDec(paidDec, parseDecimal(fa.balance))) {
        throw new ApiError(422, "INSUFFICIENT_CASH_BALANCE", "موجودی صندوق برای پرداخت رسید کافی نیست.");
      }
      paymentFinAcc = fa;

      const nextBal = subDec(fa.balance, paidDec);
      await tx
        .update(financialAccounts)
        .set({ balance: formatDecimal(nextBal, 2), version: fa.version + 1, updatedAt: new Date() })
        .where(and(eq(financialAccounts.id, fa.id), eq(financialAccounts.version, fa.version)));

      await tx.insert(financialTransactions).values({
        organizationId: params.organizationId,
        financialAccountId: fa.id,
        contactId: supplier.id,
        txType: "PAYMENT",
        paymentMethod: fa.accountType === "CASHBOX" ? "CASH" : "BANK_TRANSFER",
        amount: formatDecimal(paidDec, 2),
        currency: organization.baseCurrency,
        txDate: canonicalDate,
        trackingNumber: params.supplierInvoiceNumber,
        relatedDocumentType: "WAREHOUSE_RECEIPT",
        relatedDocumentId: stockRes.document.id,
        description: `پرداخت بابت رسید انبار ${stockRes.document.documentNumber} (فاکتور ${params.supplierInvoiceNumber})`,
        createdBy: params.actorUserId,
      });
    }

    // 3. Post Strictly Balanced Double-Entry Acquisition Journal:
    //    DR Inventory (1301) = netAcquisitionDec
    //    CR Bank/Cash (if paid > 0) = paidDec
    //    CR Accounts Payable (2101, supplier) = remainingPayableDec
    const orgAccs = await tx.select().from(accounts).where(eq(accounts.organizationId, params.organizationId));
    const byRole = new Map(orgAccs.filter((a) => a.systemRole).map((a) => [a.systemRole!, a]));
    const invAcc = byRole.get("INVENTORY");
    const apAcc = byRole.get("AP");
    const bankAcc = byRole.get("BANK");
    const cashAcc = byRole.get("CASH");

    let journalEntry = null;
    if (!invAcc || (isPositiveDec(remainingPayableDec) && !apAcc)) {
      throw new ApiError(422, "PURCHASE_ACCOUNTS_MISSING", "حساب موجودی کالا و حساب پرداختنی برای ثبت رسید خرید باید در کدینگ فعال باشند.");
    }
    const jLines: JournalLineInput[] = [
        {
          accountId: invAcc.id,
          debit: formatDecimal(netAcquisitionDec, 2),
          credit: "0.00",
          description: `بهای تمام‌شده رسید انبار ${stockRes.document.documentNumber} (شامل حمل و گمرک پس از تخفیف)`,
        },
      ];
    if (isPositiveDec(paidDec)) {
        const payGlId =
          paymentFinAcc?.accountId ??
          (paymentFinAcc?.accountType === "CASHBOX" ? cashAcc?.id : bankAcc?.id) ??
          bankAcc?.id;
        if (!payGlId) throw new ApiError(422, "TREASURY_GL_MAPPING_MISSING", "حساب دفتر کل متناظر با حساب پرداخت رسید تنظیم نشده است.");
        jLines.push({
          accountId: payGlId,
          debit: "0.00",
          credit: formatDecimal(paidDec, 2),
          description: `پرداخت نقدی/بانکی به ${supplier.name} بابت فاکتور ${params.supplierInvoiceNumber}`,
        });
      }
    if (isPositiveDec(remainingPayableDec)) {
      jLines.push({
        accountId: apAcc!.id,
        contactId: supplier.id,
        debit: "0.00",
        credit: formatDecimal(remainingPayableDec, 2),
        description: `بستانکاری تأمین‌کننده (${supplier.name}) بابت مانده فاکتور ${params.supplierInvoiceNumber}`,
      });
    }

    const jr = await createJournalEntryTx(tx, {
        organizationId: params.organizationId,
        actorUserId: params.actorUserId,
        actorEmail: params.actorEmail,
        entryDate: canonicalDate,
        description: `سند رسید انبار ${stockRes.document.documentNumber} — فاکتور ${params.supplierInvoiceNumber}`,
        referenceType: "WAREHOUSE_RECEIPT",
        referenceId: stockRes.document.id,
        postImmediately: true,
        lines: jLines,
      });
    journalEntry = jr.entry;

    // 4. Post Supplier Account Ledger entries (Credit net acquisition + Debit immediate payment)
    await tx.insert(contactTransactions).values({
      organizationId: params.organizationId,
      contactId: supplier.id,
      referenceType: "WAREHOUSE_RECEIPT",
      referenceId: stockRes.document.id,
      txDate: canonicalDate,
      debit: "0.00",
      credit: formatDecimal(netAcquisitionDec, 2),
      description: `رسید انبار ${stockRes.document.documentNumber} — فاکتور تأمین‌کننده ${params.supplierInvoiceNumber}`,
    });
    if (isPositiveDec(paidDec)) {
      await tx.insert(contactTransactions).values({
        organizationId: params.organizationId,
        contactId: supplier.id,
        referenceType: "TREASURY",
        referenceId: stockRes.document.id,
        txDate: canonicalDate,
        debit: formatDecimal(paidDec, 2),
        credit: "0.00",
        description: `پرداخت هم‌زمان رسید انبار ${stockRes.document.documentNumber}`,
      });
    }

    // 5. Enrich Stock Document header with landed costing metadata
    const [updatedDoc] = await tx
      .update(stockDocuments)
      .set({
        supplierId: supplier.id,
        supplierInvoiceNumber: params.supplierInvoiceNumber.trim(),
        shippingCost: formatDecimal(shippingDec, 2),
        customsAndExtraCost: formatDecimal(customsDec, 2),
        supplierDiscount: formatDecimal(discountDec, 2),
        totalAcquisitionCost: formatDecimal(netAcquisitionDec, 2),
        paymentBankAccountId: paymentFinAcc?.id ?? null,
        paidAmount: formatDecimal(paidDec, 2),
        remainingPayable: formatDecimal(remainingPayableDec, 2),
        attachmentUrl: params.attachmentUrl ?? null,
        journalEntryId: journalEntry?.id ?? null,
      })
      .where(eq(stockDocuments.id, stockRes.document.id))
      .returning();

    return {
      document: { ...updatedDoc, document_date_jalali: gregorianIsoToJalali(updatedDoc.documentDate) },
      ledger_rows: stockRes.ledgerRows,
      journal_entry: journalEntry,
      cost_breakdown: {
        gross_items_total: formatDecimal(grossItemsTotal, 2),
        shipping_cost: formatDecimal(shippingDec, 2),
        customs_and_extra_cost: formatDecimal(customsDec, 2),
        supplier_discount: formatDecimal(discountDec, 2),
        total_acquisition_cost: formatDecimal(netAcquisitionDec, 2),
        paid_amount: formatDecimal(paidDec, 2),
        remaining_payable: formatDecimal(remainingPayableDec, 2),
      },
    };
  });

  await recordAuditLog({
    organizationId: params.organizationId,
    actorUserId: params.actorUserId,
    actorEmail: params.actorEmail,
    scope: "ORGANIZATION",
    action: "LANDED_WAREHOUSE_RECEIPT_POSTED",
    entityType: "STOCK_DOCUMENT",
    entityId: result.document.id,
    ipAddress: params.ipAddress,
    metadata: {
      supplierInvoiceNumber: params.supplierInvoiceNumber,
      totalAcquisitionCost: result.cost_breakdown.total_acquisition_cost,
      paidAmount: result.cost_breakdown.paid_amount,
      remainingPayable: result.cost_breakdown.remaining_payable,
    },
  });

  return result;
}

// ============================================================================
// 2. MULTI-ITEM WAREHOUSE TRANSFER WITH IN-TRANSIT & PARTIAL RECEIPT (§2.4)
// ============================================================================
export async function createMultiItemTransfer(params: {
  organizationId: string;
  sourceWarehouseId: string;
  destinationWarehouseId: string;
  transferDate?: string;
  transferDateJalali?: string;
  reason: string;
  sourceResponsibleName: string;
  destinationResponsibleName: string;
  notes?: string;
  dispatchImmediately?: boolean;
  actorUserId: string;
  actorEmail: string;
  ipAddress?: string | null;
  items: Array<{
    product_id: string;
    variant_id?: string | null;
    quantity: string;
  }>;
}) {
  if (params.sourceWarehouseId === params.destinationWarehouseId) {
    throw new ApiError(422, "TRANSFER_SAME_WAREHOUSE", "انبار مبدأ و انبار مقصد نمی‌توانند یکسان باشند.");
  }
  const canonicalDate = resolveCanonicalDate(params.transferDate, params.transferDateJalali);

  const created = await withTenantTransaction(params.organizationId, async (tx) => {
    const transferWarehouses = await tx
      .select()
      .from(warehouses)
      .where(
        and(
          eq(warehouses.organizationId, params.organizationId),
          inArray(warehouses.id, [params.sourceWarehouseId, params.destinationWarehouseId])
        )
      )
      .orderBy(asc(warehouses.id))
      .for("update");
    const sourceWarehouse = transferWarehouses.find((warehouse) => warehouse.id === params.sourceWarehouseId);
    const destinationWarehouse = transferWarehouses.find((warehouse) => warehouse.id === params.destinationWarehouseId);
    if (!sourceWarehouse || !destinationWarehouse) {
      throw new ApiError(404, "WAREHOUSE_NOT_FOUND", "انبار مبدأ یا مقصد در این کسب‌وکار پیدا نشد.");
    }
    if (!sourceWarehouse.isActive || !destinationWarehouse.isActive) {
      throw new ApiError(409, "WAREHOUSE_INACTIVE", "انتقال فقط بین انبارهای فعال امکان‌پذیر است.");
    }

    const productIds = [...new Set(params.items.map((item) => item.product_id))];
    const organizationProducts = await tx
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.organizationId, params.organizationId), inArray(products.id, productIds)));
    if (organizationProducts.length !== productIds.length) {
      throw new ApiError(404, "PRODUCT_NOT_FOUND", "یک یا چند کالای حواله در این کسب‌وکار پیدا نشد.");
    }

    const variantIds = [...new Set(params.items.map((item) => item.variant_id).filter((id): id is string => Boolean(id)))];
    const organizationVariants = variantIds.length
      ? await tx
          .select({ id: productVariants.id, productId: productVariants.productId })
          .from(productVariants)
          .where(and(eq(productVariants.organizationId, params.organizationId), inArray(productVariants.id, variantIds)))
      : [];
    if (organizationVariants.length !== variantIds.length) {
      throw new ApiError(404, "PRODUCT_VARIANT_NOT_FOUND", "یک یا چند تنوع کالا در این کسب‌وکار پیدا نشد.");
    }
    const variantProducts = new Map(organizationVariants.map((variant) => [variant.id, variant.productId]));
    if (params.items.some((item) => item.variant_id && variantProducts.get(item.variant_id) !== item.product_id)) {
      throw new ApiError(422, "VARIANT_PRODUCT_MISMATCH", "تنوع انتخاب‌شده متعلق به کالای همان ردیف نیست.");
    }

    const trNumber = `TR-${Date.now().toString().slice(-6)}`;
    let totalQty = BigInt(0);
    for (const it of params.items) {
      const q = parseDecimal(it.quantity);
      if (!isPositiveDec(q)) throw new ApiError(422, "QUANTITY_INVALID", "مقدار انتقال باید بزرگ‌تر از صفر باشد.");
      totalQty = addDec(totalQty, q);
    }

    const [transfer] = await tx
      .insert(stockTransfers)
      .values({
        organizationId: params.organizationId,
        transferNumber: trNumber,
        sourceWarehouseId: params.sourceWarehouseId,
        targetWarehouseId: params.destinationWarehouseId,
        productId: params.items[0]?.product_id ?? null,
        quantity: formatDecimal(totalQty, 4),
        reason: params.reason,
        sourceResponsibleName: params.sourceResponsibleName,
        destinationResponsibleName: params.destinationResponsibleName,
        transferDate: canonicalDate,
        notes: params.notes ?? null,
        status: "DRAFT",
        createdBy: params.actorUserId,
      })
      .returning();

    const savedItems = await tx
      .insert(stockTransferItems)
      .values(
        params.items.map((it) => ({
          organizationId: params.organizationId,
          stockTransferId: transfer.id,
          productId: it.product_id,
          variantId: it.variant_id ?? null,
          quantitySent: formatDecimal(parseDecimal(it.quantity), 4),
          itemStatus: "PENDING",
        }))
      )
      .returning();

    return { transfer, items: savedItems };
  });

  if (params.dispatchImmediately) {
    return dispatchMultiItemTransfer({
      organizationId: params.organizationId,
      transferId: created.transfer.id,
      actorUserId: params.actorUserId,
      actorEmail: params.actorEmail,
      ipAddress: params.ipAddress,
    });
  }

  return created;
}

/**
 * Transitions transfer DRAFT -> SUBMITTED without deducting stock yet (Master Prompt 09A §4).
 */
export async function submitMultiItemTransfer(params: {
  organizationId: string;
  transferId: string;
  actorUserId: string;
  actorEmail: string;
  ipAddress?: string | null;
}) {
  const submitted = await withTenantTransaction(params.organizationId, async (tx) => {
    const [tr] = await tx
      .select()
      .from(stockTransfers)
      .where(and(eq(stockTransfers.id, params.transferId), eq(stockTransfers.organizationId, params.organizationId)))
      .for("update")
      .limit(1);
    if (!tr) throw new ApiError(404, "TRANSFER_NOT_FOUND", "سند انتقال انبار یافت نشد.");
    if (tr.status !== "DRAFT") {
      throw new ApiError(409, "TRANSFER_INVALID_STATE", `فقط حواله انتقال پیش‌نویس (DRAFT) قابل ارسال برای تایید (SUBMITTED) است (وضعیت فعلی: ${tr.status}).`);
    }

    const [updated] = await tx
      .update(stockTransfers)
      .set({ status: "SUBMITTED" })
      .where(and(eq(stockTransfers.id, tr.id), eq(stockTransfers.organizationId, params.organizationId)))
      .returning();
    return updated;
  });

  await recordAuditLog({
    organizationId: params.organizationId,
    actorUserId: params.actorUserId,
    actorEmail: params.actorEmail,
    scope: "ORGANIZATION",
    action: "WAREHOUSE_TRANSFER_SUBMITTED",
    entityType: "STOCK_TRANSFER",
    entityId: params.transferId,
    ipAddress: params.ipAddress,
  });

  return submitted;
}

/**
 * Transitions transfer DRAFT/SUBMITTED -> IN_TRANSIT and deducts ONLY from source warehouse (zero duplication!).
 */
export async function dispatchMultiItemTransfer(params: {
  organizationId: string;
  transferId: string;
  actorUserId: string;
  actorEmail: string;
  ipAddress?: string | null;
}) {
  const result = await withTenantTransaction(params.organizationId, async (tx) => {
    const [tr] = await tx
      .select()
      .from(stockTransfers)
      .where(and(eq(stockTransfers.id, params.transferId), eq(stockTransfers.organizationId, params.organizationId)))
      .for("update")
      .limit(1);
    if (!tr) throw new ApiError(404, "TRANSFER_NOT_FOUND", "سند انتقال انبار یافت نشد.");
    if (!["DRAFT", "SUBMITTED"].includes(tr.status)) {
      throw new ApiError(409, "TRANSFER_INVALID_STATE", `امکان ارسال انتقال با وضعیت ${tr.status} وجود ندارد.`);
    }

    const items = await tx
      .select()
      .from(stockTransferItems)
      .where(eq(stockTransferItems.stockTransferId, tr.id));
    if (items.length === 0) throw new ApiError(422, "TRANSFER_NO_ITEMS", "انتقال فاقد ردیف کالا است.");

    // Deduct from Source Warehouse into IN_TRANSIT
    const outRes = await postStockDocumentTx(tx, {
      organizationId: params.organizationId,
      warehouseId: tr.sourceWarehouseId,
      documentType: "TRANSFER_OUT",
      documentDate: tr.transferDate,
      reason: `ارسال انتقال ${tr.transferNumber} به انبار مقصد (${tr.reason || "انتقال بین انبار"})`,
      referenceType: "STOCK_TRANSFER",
      referenceId: tr.id,
      actorUserId: params.actorUserId,
      items: items.map((it) => ({
        productId: it.productId,
        variantId: it.variantId ?? null,
        direction: "OUT",
        quantity: it.quantitySent,
      })),
    });

    // Preserve unit cost per item so destination receives exact transferred cost
    for (let i = 0; i < items.length; i++) {
      const unitCost = outRes.ledgerRows[i]?.unitCost ?? "0.0000";
      await tx
        .update(stockTransferItems)
        .set({ unitCost, itemStatus: "IN_TRANSIT" })
        .where(eq(stockTransferItems.id, items[i].id));
    }

    const [updated] = await tx
      .update(stockTransfers)
      .set({
        status: "IN_TRANSIT",
        outDocumentId: outRes.document.id,
        dispatchedAt: new Date(),
      })
      .where(eq(stockTransfers.id, tr.id))
      .returning();

    const updatedItems = await tx
      .select()
      .from(stockTransferItems)
      .where(eq(stockTransferItems.stockTransferId, tr.id));

    return { transfer: updated, items: updatedItems, out_document: outRes.document };
  });

  await recordAuditLog({
    organizationId: params.organizationId,
    actorUserId: params.actorUserId,
    actorEmail: params.actorEmail,
    scope: "ORGANIZATION",
    action: "WAREHOUSE_TRANSFER_DISPATCHED_IN_TRANSIT",
    entityType: "STOCK_TRANSFER",
    entityId: params.transferId,
    ipAddress: params.ipAddress,
  });

  return result;
}

/**
 * Independent Destination Receiving with Per-Item Accepted / Missing / Damaged Discrepancies (§2.4):
 * - NEVER rejects the entire transfer when 1 out of N items has a discrepancy!
 * - ONLY `accepted_qty` is added to Destination Warehouse Stock Ledger!
 */
export async function receiveMultiItemTransfer(params: {
  organizationId: string;
  transferId: string;
  receivedDate?: string;
  receivedDateJalali?: string;
  notes?: string;
  actorUserId: string;
  actorEmail: string;
  ipAddress?: string | null;
  items: Array<{
    transfer_item_id?: string;
    product_id: string;
    accepted_qty?: string;
    accepted_quantity?: string;
    rejected_quantity?: string;
    missing_qty?: string;
    damaged_qty?: string;
    discrepancy_type?: string;
    discrepancy_note?: string;
    discrepancy_description?: string;
    evidence_url?: string;
    evidence_attachment_ids?: string[];
  }>;
}) {
  const receiveDate = resolveCanonicalDate(params.receivedDate, params.receivedDateJalali);

  const result = await withTenantTransaction(params.organizationId, async (tx) => {
    const [tr] = await tx
      .select()
      .from(stockTransfers)
      .where(and(eq(stockTransfers.id, params.transferId), eq(stockTransfers.organizationId, params.organizationId)))
      .for("update")
      .limit(1);
    if (!tr) throw new ApiError(404, "TRANSFER_NOT_FOUND", "سند انتقال یافت نشد.");
    if (!["IN_TRANSIT", "PARTIALLY_RECEIVED", "DISCREPANCY_REPORTED"].includes(tr.status)) {
      throw new ApiError(409, "TRANSFER_NOT_RECEIVABLE", `تحویل انتقال با وضعیت ${tr.status} مجاز نیست.`);
    }

    const dbItems = await tx
      .select()
      .from(stockTransferItems)
      .where(eq(stockTransferItems.stockTransferId, tr.id));

    const stockInBatch: Array<{
      productId: string;
      variantId?: string | null;
      direction: "IN";
      quantity: string;
      unitCost: string;
    }> = [];

    for (const reqIt of params.items) {
      const target =
        (reqIt.transfer_item_id && dbItems.find((d) => d.id === reqIt.transfer_item_id)) ||
        dbItems.find((d) => d.productId === reqIt.product_id);
      if (!target) {
        throw new ApiError(422, "TRANSFER_ITEM_NOT_FOUND", `کالای ${reqIt.product_id} در این سند انتقال وجود ندارد.`);
      }

      const accDec = parseDecimal(reqIt.accepted_quantity ?? reqIt.accepted_qty ?? "0");
      const missDec = parseDecimal(reqIt.missing_qty || "0");
      const dmgDec = parseDecimal(reqIt.damaged_qty || "0");
      const rejDec = parseDecimal(reqIt.rejected_quantity || "0");
      if (isNegativeDec(accDec) || isNegativeDec(missDec) || isNegativeDec(dmgDec) || isNegativeDec(rejDec)) {
        throw new ApiError(422, "QUANTITY_NEGATIVE", "مقادیر تحویلی، کسری، آسیب‌دیده و ردشده نمی‌توانند منفی باشند.");
      }

      const nextAccepted = addDec(target.quantityAccepted, accDec);
      const nextMissing = addDec(target.quantityMissing, missDec);
      const nextDamaged = addDec(target.quantityDamaged, dmgDec);
      const nextRejected = addDec(target.quantityRejected, rejDec);
      const accountedTotal = addDec(
        nextAccepted,
        addDec(nextMissing, addDec(nextDamaged, nextRejected))
      );

      if (gtDec(accountedTotal, parseDecimal(target.quantitySent))) {
        throw new ApiError(
          422,
          "RECEIVED_EXCEEDS_SENT",
          `مجموع مقدار پذیرفته‌شده، کسری، آسیب‌دیده و ردشده (${formatDecimal(accountedTotal, 4)}) نمی‌تواند بیشتر از مقدار ارسالی (${target.quantitySent}) باشد.`
        );
      }

      const hasDiscrepancy =
        isPositiveDec(nextMissing) || isPositiveDec(nextDamaged) || isPositiveDec(nextRejected);
      const fullyAccounted = accountedTotal === parseDecimal(target.quantitySent);
      const itemStatus = hasDiscrepancy
        ? "DISCREPANCY"
        : fullyAccounted
          ? "ACCEPTED"
          : "PARTIAL";

      const inferredDiscType =
        reqIt.discrepancy_type ||
        (isPositiveDec(dmgDec) ? "DAMAGED" : isPositiveDec(missDec) ? "MISSING" : isPositiveDec(rejDec) ? "QUALITY_REJECTED" : target.discrepancyType);

      await tx
        .update(stockTransferItems)
        .set({
          quantityAccepted: formatDecimal(nextAccepted, 4),
          quantityMissing: formatDecimal(nextMissing, 4),
          quantityDamaged: formatDecimal(nextDamaged, 4),
          quantityRejected: formatDecimal(nextRejected, 4),
          discrepancyType: inferredDiscType ?? null,
          discrepancyNote: reqIt.discrepancy_description ?? reqIt.discrepancy_note ?? target.discrepancyNote,
          evidenceUrl: reqIt.evidence_url ?? target.evidenceUrl,
          evidenceAttachmentIds: reqIt.evidence_attachment_ids ?? target.evidenceAttachmentIds,
          itemStatus,
        })
        .where(eq(stockTransferItems.id, target.id));

      // ONLY physically accepted qty enters Destination Warehouse Stock Ledger!
      if (isPositiveDec(accDec)) {
        stockInBatch.push({
          productId: target.productId,
          variantId: target.variantId ?? null,
          direction: "IN",
          quantity: formatDecimal(accDec, 4),
          unitCost: target.unitCost,
        });
      }
    }

    let inDoc = null;
    if (stockInBatch.length > 0) {
      const inRes = await postStockDocumentTx(tx, {
        organizationId: params.organizationId,
        warehouseId: tr.targetWarehouseId,
        documentType: "TRANSFER_IN",
        documentDate: receiveDate,
        reason: `تحویل کالای سالم انتقال ${tr.transferNumber}`,
        referenceType: "STOCK_TRANSFER",
        referenceId: tr.id,
        actorUserId: params.actorUserId,
        items: stockInBatch,
      });
      inDoc = inRes.document;
    }

    const refreshedItems = await tx
      .select()
      .from(stockTransferItems)
      .where(eq(stockTransferItems.stockTransferId, tr.id));

    const anyDiscrepancy = refreshedItems.some(
      (i) =>
        isPositiveDec(parseDecimal(i.quantityMissing)) ||
        isPositiveDec(parseDecimal(i.quantityDamaged)) ||
        isPositiveDec(parseDecimal(i.quantityRejected))
    );
    const allAccounted = refreshedItems.every((i) => {
      const sum = addDec(
        i.quantityAccepted,
        addDec(i.quantityMissing, addDec(i.quantityDamaged, i.quantityRejected))
      );
      return sum >= parseDecimal(i.quantitySent);
    });

    const nextStatus = anyDiscrepancy
      ? "DISCREPANCY_REPORTED"
      : allAccounted
        ? "RECEIVED"
        : "PARTIALLY_RECEIVED";

    const [updatedTr] = await tx
      .update(stockTransfers)
      .set({
        status: nextStatus,
        inDocumentId: inDoc?.id ?? tr.inDocumentId,
        receivedAt: new Date(),
        ...(params.notes ? { notes: `${tr.notes ?? ""}\n[تحویل مقصد]: ${params.notes}`.trim() } : {}),
      })
      .where(eq(stockTransfers.id, tr.id))
      .returning();

    return {
      transfer: updatedTr,
      items: refreshedItems,
      in_document: inDoc,
      discrepancies: refreshedItems.filter((i) => i.itemStatus === "DISCREPANCY"),
    };
  });

  await recordAuditLog({
    organizationId: params.organizationId,
    actorUserId: params.actorUserId,
    actorEmail: params.actorEmail,
    scope: "ORGANIZATION",
    action: "WAREHOUSE_TRANSFER_RECEIVED",
    entityType: "STOCK_TRANSFER",
    entityId: params.transferId,
    ipAddress: params.ipAddress,
    metadata: {
      status: result.transfer.status,
      discrepanciesCount: result.discrepancies.length,
    },
  });

  return result;
}

export async function completeWarehouseTransfer(params: {
  organizationId: string;
  transferId: string;
  actorUserId: string;
  actorEmail: string;
  ipAddress?: string | null;
}) {
  const completed = await withTenantTransaction(params.organizationId, async (tx) => {
    const [tr] = await tx
      .select()
      .from(stockTransfers)
      .where(and(eq(stockTransfers.id, params.transferId), eq(stockTransfers.organizationId, params.organizationId)))
      .for("update")
      .limit(1);
    if (!tr) throw new ApiError(404, "TRANSFER_NOT_FOUND", "سند انتقال یافت نشد.");
    if (!["RECEIVED", "DISCREPANCY_REPORTED"].includes(tr.status)) {
      throw new ApiError(409, "TRANSFER_CANNOT_COMPLETE", "حواله تا ثبت کامل شمارش مقصد قابل بستن نیست.");
    }

    const items = await tx
      .select()
      .from(stockTransferItems)
      .where(eq(stockTransferItems.stockTransferId, tr.id));
    const hasUnaccountedQuantity = items.some((item) => {
      const accounted = addDec(
        item.quantityAccepted,
        addDec(item.quantityMissing, addDec(item.quantityDamaged, item.quantityRejected))
      );
      return gtDec(parseDecimal(item.quantitySent), accounted);
    });
    if (hasUnaccountedQuantity) {
      throw new ApiError(409, "TRANSFER_RECEIPT_INCOMPLETE", "برای تک‌تک اقلام باید مقدار پذیرفته‌شده یا نوع مغایرت ثبت شود.");
    }

    const [updated] = await tx
      .update(stockTransfers)
      .set({ status: "COMPLETED", completedAt: new Date() })
      .where(and(eq(stockTransfers.id, tr.id), eq(stockTransfers.organizationId, params.organizationId)))
      .returning();
    return updated;
  });

  await recordAuditLog({
    organizationId: params.organizationId,
    actorUserId: params.actorUserId,
    actorEmail: params.actorEmail,
    scope: "ORGANIZATION",
    action: "WAREHOUSE_TRANSFER_COMPLETED",
    entityType: "STOCK_TRANSFER",
    entityId: params.transferId,
    ipAddress: params.ipAddress,
  });

  return completed;
}

export async function cancelMultiItemTransfer(params: {
  organizationId: string;
  transferId: string;
  reason: string;
  actorUserId: string;
  actorEmail: string;
  ipAddress?: string | null;
}) {
  const cancelled = await withTenantTransaction(params.organizationId, async (tx) => {
    const [tr] = await tx
      .select()
      .from(stockTransfers)
      .where(and(eq(stockTransfers.id, params.transferId), eq(stockTransfers.organizationId, params.organizationId)))
      .for("update")
      .limit(1);
    if (!tr) throw new ApiError(404, "TRANSFER_NOT_FOUND", "سند انتقال یافت نشد.");
    if (!["DRAFT", "SUBMITTED"].includes(tr.status)) {
      throw new ApiError(409, "TRANSFER_CANNOT_CANCEL", "پس از ارسال کالا، حواله قابل ابطال نیست؛ مغایرت یا برگشت باید با سند مستقل ثبت شود.");
    }

    const reason = params.reason.trim();
    const [updated] = await tx
      .update(stockTransfers)
      .set({
        status: "CANCELLED",
        notes: [tr.notes?.trim(), reason ? `[علت ابطال]: ${reason}` : null].filter(Boolean).join("\n") || null,
      })
      .where(and(eq(stockTransfers.id, tr.id), eq(stockTransfers.organizationId, params.organizationId)))
      .returning();
    return updated;
  });

  await recordAuditLog({
    organizationId: params.organizationId,
    actorUserId: params.actorUserId,
    actorEmail: params.actorEmail,
    scope: "ORGANIZATION",
    action: "WAREHOUSE_TRANSFER_CANCELLED",
    entityType: "STOCK_TRANSFER",
    entityId: params.transferId,
    ipAddress: params.ipAddress,
    metadata: { reason: params.reason },
  });

  return cancelled;
}

// ============================================================================
// 3. SUPPLIER ACCOUNT PROFILE// ============================================================================
// 3. SUPPLIER ACCOUNT PROFILE & SETTLEMENTS (§2.6)
// ============================================================================
export async function getSupplierProfile(organizationId: string, supplierId: string) {
  const [supplier] = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.id, supplierId), eq(contacts.organizationId, organizationId)))
    .limit(1);
  if (!supplier) throw new ApiError(404, "SUPPLIER_NOT_FOUND", "تأمین‌کننده یافت نشد.");

  const [pInvs, receipts, ledgerTxs, finTxs] = await Promise.all([
    db
      .select()
      .from(purchaseInvoices)
      .where(and(eq(purchaseInvoices.organizationId, organizationId), eq(purchaseInvoices.contactId, supplier.id)))
      .orderBy(desc(purchaseInvoices.invoiceDate)),
    db
      .select()
      .from(stockDocuments)
      .where(and(eq(stockDocuments.organizationId, organizationId), eq(stockDocuments.supplierId, supplier.id)))
      .orderBy(desc(stockDocuments.documentDate)),
    db
      .select()
      .from(contactTransactions)
      .where(and(eq(contactTransactions.organizationId, organizationId), eq(contactTransactions.contactId, supplier.id)))
      .orderBy(desc(contactTransactions.txDate), desc(contactTransactions.createdAt)),
    db
      .select()
      .from(financialTransactions)
      .where(and(eq(financialTransactions.organizationId, organizationId), eq(financialTransactions.contactId, supplier.id)))
      .orderBy(desc(financialTransactions.txDate)),
  ]);

  let totalCredit = BigInt(0); // We owe supplier
  let totalDebit = BigInt(0);  // We paid/returned to supplier
  for (const t of ledgerTxs) {
    totalCredit = addDec(totalCredit, t.credit);
    totalDebit = addDec(totalDebit, t.debit);
  }
  // Net payable owed to supplier = credit - debit
  const outstandingPayable = subDec(totalCredit, totalDebit);

  return {
    supplier: {
      id: supplier.id,
      code: supplier.code,
      display_name: supplier.name,
      type: supplier.contactType,
      mobile: supplier.mobile,
      phone: supplier.phone,
      economic_code: supplier.economicCode,
    },
    summary: {
      total_billed_credit: formatDecimal(totalCredit, 2),
      total_settled_debit: formatDecimal(totalDebit, 2),
      outstanding_payable: formatDecimal(outstandingPayable, 2),
      purchase_invoices_count: pInvs.length,
      warehouse_receipts_count: receipts.length,
    },
    purchase_invoices: pInvs,
    warehouse_receipts: receipts,
    settlements: finTxs,
    ledger_transactions: ledgerTxs,
  };
}

export async function recordSupplierSettlement(params: {
  organizationId: string;
  supplierId: string;
  financialAccountId: string;
  paymentMethod: "CASH" | "BANK" | "BANK_TRANSFER" | "CARD_TERMINAL" | "CHEQUE" | "OTHER";
  amount: string;
  settlementDate?: string;
  settlementDateJalali?: string;
  referenceNumber?: string;
  description?: string;
  actorUserId: string;
  actorEmail: string;
  ipAddress?: string | null;
}) {
  if (params.paymentMethod === "CHEQUE") {
    throw new ApiError(422, "USE_CHEQUE_WORKFLOW", "برای پرداخت با چک، چک پرداختنی را از ماژول چک‌ها صادر کنید؛ ثبت تسویه نقدی/بانکی با روش چک مجاز نیست.");
  }
  const amtDec = parseDecimal(params.amount);
  if (!isPositiveDec(amtDec)) {
    throw new ApiError(422, "AMOUNT_INVALID", "مبلغ تسویه تأمین‌کننده باید بزرگ‌تر از صفر باشد.");
  }
  const canonicalDate = resolveCanonicalDate(params.settlementDate, params.settlementDateJalali);

  const result = await withTenantTransaction(params.organizationId, async (tx) => {
    await tx.execute(sql`
      SELECT id FROM contacts
      WHERE id = ${params.supplierId} AND organization_id = ${params.organizationId}
      FOR UPDATE
    `);
    const [supplier] = await tx
      .select()
      .from(contacts)
      .where(and(eq(contacts.id, params.supplierId), eq(contacts.organizationId, params.organizationId)))
      .limit(1);
    if (!supplier) throw new ApiError(404, "SUPPLIER_NOT_FOUND", "تأمین‌کننده یافت نشد.");
    const [organization] = await tx.select({ baseCurrency: organizations.baseCurrency }).from(organizations).where(eq(organizations.id, params.organizationId)).limit(1);
    if (!organization) throw new ApiError(404, "ORG_NOT_FOUND", "سازمان یافت نشد.");

    await tx.execute(sql`
      SELECT id FROM purchase_invoices
      WHERE organization_id = ${params.organizationId}
        AND contact_id = ${supplier.id}
        AND status IN ('CONFIRMED', 'FINALIZED', 'PARTIALLY_RETURNED')
        AND remaining_amount > 0
      ORDER BY invoice_date, created_at, id
      FOR UPDATE
    `);
    const openInvoices = await tx.select().from(purchaseInvoices).where(and(
      eq(purchaseInvoices.organizationId, params.organizationId),
      eq(purchaseInvoices.contactId, supplier.id),
      inArray(purchaseInvoices.status, ["CONFIRMED", "FINALIZED", "PARTIALLY_RETURNED"]),
      gt(purchaseInvoices.remainingAmount, "0.00")
    )).orderBy(asc(purchaseInvoices.invoiceDate), asc(purchaseInvoices.createdAt), asc(purchaseInvoices.id));
    let invoiceOutstanding = BigInt(0);
    for (const invoice of openInvoices) invoiceOutstanding = addDec(invoiceOutstanding, invoice.remainingAmount);
    const supplierLedger = await tx.select({ debit: contactTransactions.debit, credit: contactTransactions.credit }).from(contactTransactions).where(and(
      eq(contactTransactions.organizationId, params.organizationId),
      eq(contactTransactions.contactId, supplier.id)
    ));
    let ledgerPayable = BigInt(0);
    for (const row of supplierLedger) ledgerPayable = addDec(ledgerPayable, subDec(row.credit, row.debit));
    const payableAvailable = ledgerPayable < invoiceOutstanding ? ledgerPayable : invoiceOutstanding;
    if (!isPositiveDec(payableAvailable) || gtDec(amtDec, payableAvailable)) {
      throw new ApiError(422, "SETTLEMENT_EXCEEDS_PAYABLE", `مبلغ تسویه از بدهی باز تأمین‌کننده بیشتر است (حداکثر قابل تسویه: ${formatDecimal(payableAvailable, 2)}).`);
    }
    let remainingToAllocate = amtDec;
    const invoiceAllocations: Array<{ invoiceId: string; invoiceNumber: string; amount: string }> = [];
    for (const invoice of openInvoices) {
      if (!isPositiveDec(remainingToAllocate)) break;
      const invoiceBalance = parseDecimal(invoice.remainingAmount);
      const applied = remainingToAllocate < invoiceBalance ? remainingToAllocate : invoiceBalance;
      if (!isPositiveDec(applied)) continue;
      const nextRemaining = subDec(invoiceBalance, applied);
      await tx.update(purchaseInvoices).set({
        paidAmount: formatDecimal(addDec(invoice.paidAmount, applied), 2),
        remainingAmount: formatDecimal(nextRemaining, 2),
        version: invoice.version + 1,
        syncSeq: Date.now(),
        updatedAt: new Date(),
      }).where(and(eq(purchaseInvoices.id, invoice.id), eq(purchaseInvoices.version, invoice.version)));
      invoiceAllocations.push({ invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, amount: formatDecimal(applied, 2) });
      remainingToAllocate = subDec(remainingToAllocate, applied);
    }
    if (isPositiveDec(remainingToAllocate)) {
      throw new ApiError(409, "SUPPLIER_INVOICE_ALLOCATION_INCOMPLETE", "بخشی از پرداخت به فاکتورهای باز تخصیص نیافت؛ مانده‌ها را بررسی کنید.");
    }

    await tx.execute(sql`
      SELECT id FROM financial_accounts
      WHERE id = ${params.financialAccountId} AND organization_id = ${params.organizationId}
      FOR UPDATE
    `);
    const [fa] = await tx
      .select()
      .from(financialAccounts)
      .where(and(eq(financialAccounts.id, params.financialAccountId), eq(financialAccounts.organizationId, params.organizationId)))
      .limit(1);
    if (!fa) throw new ApiError(404, "TREASURY_ACCOUNT_NOT_FOUND", "حساب بانکی/صندوق یافت نشد.");
    if (!fa.isActive) throw new ApiError(409, "TREASURY_ACCOUNT_INACTIVE", "حساب بانکی/صندوق غیرفعال است.");
    if (fa.currency !== organization.baseCurrency) throw new ApiError(422, "FOREIGN_CURRENCY_TREASURY_UNSUPPORTED", `تسویه باید از حسابی با ارز پایه ${organization.baseCurrency} انجام شود.`);
    if ((fa.accountType === "CASHBOX" || fa.accountType === "CASH") && gtDec(amtDec, parseDecimal(fa.balance))) {
      throw new ApiError(422, "INSUFFICIENT_CASH_BALANCE", "موجودی صندوق برای این پرداخت کافی نیست.");
    }

    const nextBal = subDec(fa.balance, amtDec);
    await tx
      .update(financialAccounts)
      .set({ balance: formatDecimal(nextBal, 2), version: fa.version + 1, updatedAt: new Date() })
      .where(eq(financialAccounts.id, fa.id));

    const orgAccs = await tx.select().from(accounts).where(eq(accounts.organizationId, params.organizationId));
    const apAcc = orgAccs.find((a) => a.systemRole === "AP");
    const bankAcc = orgAccs.find((a) => a.systemRole === "BANK");
    const cashAcc = orgAccs.find((a) => a.systemRole === "CASH");
    const glOutId = fa.accountId ?? (fa.accountType === "CASHBOX" ? cashAcc?.id : bankAcc?.id) ?? bankAcc?.id;
    if (!apAcc || !glOutId) {
      throw new ApiError(422, "SUPPLIER_SETTLEMENT_ACCOUNTS_MISSING", "حساب‌های سیستمی پرداخت به تأمین‌کننده کامل نیست؛ ابتدا کدینگ حسابداری را اصلاح کنید.");
    }

    const jr = await createJournalEntryTx(tx, {
      organizationId: params.organizationId,
      actorUserId: params.actorUserId,
      actorEmail: params.actorEmail,
      entryDate: canonicalDate,
      description: params.description || `تسویه بدهی تأمین‌کننده (${supplier.name})`,
      referenceType: "SUPPLIER_SETTLEMENT",
      referenceId: supplier.id,
      postImmediately: true,
      lines: [
        { accountId: apAcc.id, contactId: supplier.id, debit: formatDecimal(amtDec, 2), credit: "0.00", description: `کاهش بدهی به ${supplier.name}` },
        { accountId: glOutId, debit: "0.00", credit: formatDecimal(amtDec, 2), description: `پرداخت از ${fa.name}` },
      ],
    });
    const journalEntry = jr.entry;

    const [finTx] = await tx
      .insert(financialTransactions)
      .values({
        organizationId: params.organizationId,
        financialAccountId: fa.id,
        contactId: supplier.id,
        txType: "PAYMENT",
        paymentMethod: params.paymentMethod === "BANK" ? "BANK_TRANSFER" : params.paymentMethod,
        amount: formatDecimal(amtDec, 2),
        txDate: canonicalDate,
        trackingNumber: params.referenceNumber ?? null,
        relatedDocumentType: "SUPPLIER_SETTLEMENT",
        relatedDocumentId: supplier.id,
        journalEntryId: journalEntry?.id ?? null,
        description: `${params.description || `تسویه حساب تأمین‌کننده ${supplier.name}`} — ${invoiceAllocations.map((allocation) => `${allocation.invoiceNumber}: ${allocation.amount}`).join("، ")}`,
        createdBy: params.actorUserId,
      })
      .returning();

    await tx.insert(contactTransactions).values({
      organizationId: params.organizationId,
      contactId: supplier.id,
      referenceType: "SUPPLIER_SETTLEMENT",
      referenceId: finTx.id,
      txDate: canonicalDate,
      debit: formatDecimal(amtDec, 2),
      credit: "0.00",
      description: params.description || `تسویه وجه به تأمین‌کننده (${fa.name})`,
    });

    return {
      settlement: finTx,
      allocated_invoices: invoiceAllocations,
      journal_entry: journalEntry,
      treasury_new_balance: formatDecimal(nextBal, 2),
      settlement_date_jalali: gregorianIsoToJalali(canonicalDate),
    };
  });

  await recordAuditLog({
    organizationId: params.organizationId,
    actorUserId: params.actorUserId,
    actorEmail: params.actorEmail,
    scope: "ORGANIZATION",
    action: "SUPPLIER_SETTLEMENT_POSTED",
    entityType: "FINANCIAL_TRANSACTION",
    entityId: result.settlement.id,
    ipAddress: params.ipAddress,
    metadata: { supplierId: params.supplierId, amount: params.amount },
  });

  return result;
}

// ============================================================================
// 4. REAL EXCEL (.XLSX) EXPORTS FOR WAREHOUSE INVENTORY & TRANSACTIONS (§2.7)
// ============================================================================
export async function exportInventoryStockXlsx(params: {
  organizationId: string;
  actorUserId: string;
  actorEmail: string;
  ipAddress?: string | null;
  warehouseId?: string | null;
  productId?: string | null;
  categoryId?: string | null;
  stockStatus?: string | null; // IN_STOCK | LOW_STOCK | OUT_OF_STOCK
}) {
  const [stock, orgProducts, orgCats] = await Promise.all([
    getLiveStockBalances(params.organizationId),
    db.select().from(products).where(eq(products.organizationId, params.organizationId)),
    db.select().from(categories).where(eq(categories.organizationId, params.organizationId)),
  ]);

  const prodMap = new Map(orgProducts.map((p) => [p.id, p]));
  const catMap = new Map(orgCats.map((c) => [c.id, c.name]));

  let filtered = stock.balances.map((b) => {
    const prod = prodMap.get(b.productId);
    const qtyNum = Number(b.onHandQty);
    const minNum = Number(prod?.minStockLevel ?? 0);
    const status = qtyNum <= 0 ? "OUT_OF_STOCK" : qtyNum <= minNum ? "LOW_STOCK" : "IN_STOCK";
    return {
      ...b,
      categoryId: prod?.categoryId ?? null,
      categoryName: prod?.categoryId ? catMap.get(prod.categoryId) ?? "" : "",
      stockStatus: status,
    };
  });

  if (params.warehouseId) filtered = filtered.filter((r) => r.warehouseId === params.warehouseId);
  if (params.productId) filtered = filtered.filter((r) => r.productId === params.productId);
  if (params.categoryId) filtered = filtered.filter((r) => r.categoryId === params.categoryId);
  if (params.stockStatus) {
    const targetStatus = params.stockStatus.toUpperCase();
    filtered = filtered.filter((r) => r.stockStatus === targetStatus);
  }

  const sheetRows = filtered.map((r) => ({
    "انبار": r.warehouseName,
    "کد کالا / تنوع": r.productSku,
    "نام کالا": r.productName,
    "تنوع": r.variantName ?? "—",
    "دسته‌بندی": r.categoryName || "—",
    "روش ارزش‌گذاری": r.costingMethod,
    "موجودی فعلی": r.onHandQty,
    "میانگین بهای واحد": r.avgUnitCost,
    "ارزش کل موجودی": r.totalValue,
    "وضعیت موجودی": r.stockStatus,
  }));

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(sheetRows);
  XLSX.utils.book_append_sheet(wb, ws, "WarehouseStock");
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  const fileName = `warehouse-stock-${new Date().toISOString().slice(0, 10)}.xlsx`;

  await db.insert(reportExportJobs).values({
    organizationId: params.organizationId,
    requestedBy: params.actorUserId,
    reportType: "INVENTORY_STOCK",
    format: "XLSX",
    fileName,
    rowCount: filtered.length,
    status: "COMPLETED",
  });

  await recordAuditLog({
    organizationId: params.organizationId,
    actorUserId: params.actorUserId,
    actorEmail: params.actorEmail,
    scope: "ORGANIZATION",
    action: "INVENTORY_STOCK_XLSX_EXPORTED",
    entityType: "REPORT_EXPORT",
    ipAddress: params.ipAddress,
    metadata: { rowCount: filtered.length },
  });

  return { buffer, fileName, rowCount: filtered.length };
}

export async function exportInventoryMovementsXlsx(params: {
  organizationId: string;
  actorUserId: string;
  actorEmail: string;
  ipAddress?: string | null;
  warehouseId?: string | null;
  productId?: string | null;
  categoryId?: string | null;
  movementType?: string | null; // IN | OUT | RECEIPT | ISSUE | TRANSFER_OUT | TRANSFER_IN
  dateFrom?: string | null;
  dateTo?: string | null;
}) {
  const conds = [eq(stockLedger.organizationId, params.organizationId)];
  if (params.warehouseId) conds.push(eq(stockLedger.warehouseId, params.warehouseId));
  if (params.productId) conds.push(eq(stockLedger.productId, params.productId));
  if (params.dateFrom) conds.push(gte(stockLedger.movementDate, resolveCanonicalDate(params.dateFrom)));
  if (params.dateTo) conds.push(lte(stockLedger.movementDate, resolveCanonicalDate(params.dateTo)));

  const rows = await db
    .select({
      documentNumber: stockDocuments.documentNumber,
      documentType: stockDocuments.documentType,
      warehouseName: warehouses.name,
      productSku: products.sku,
      productName: products.name,
      categoryId: products.categoryId,
      movementType: stockLedger.movementType,
      reason: stockLedger.reason,
      quantityDelta: stockLedger.quantityDelta,
      unitCost: stockLedger.unitCost,
      valueDelta: stockLedger.valueDelta,
      balanceAfterQty: stockLedger.balanceAfterQty,
      balanceAfterValue: stockLedger.balanceAfterValue,
      movementDate: stockLedger.movementDate,
    })
    .from(stockLedger)
    .innerJoin(stockDocuments, eq(stockLedger.stockDocumentId, stockDocuments.id))
    .innerJoin(warehouses, eq(stockLedger.warehouseId, warehouses.id))
    .innerJoin(products, eq(stockLedger.productId, products.id))
    .where(and(...conds))
    .orderBy(desc(stockLedger.movementDate), desc(stockLedger.createdAt))
    .limit(2000);

  let filtered = rows;
  if (params.categoryId) filtered = filtered.filter((r) => r.categoryId === params.categoryId);
  if (params.movementType) {
    const mt = params.movementType.toUpperCase();
    filtered = filtered.filter((r) => r.movementType === mt || r.documentType === mt);
  }

  const sheetRows = filtered.map((r) => ({
    "شماره سند": r.documentNumber,
    "نوع سند": r.documentType,
    "تاریخ (میلادی)": r.movementDate,
    "تاریخ (شمسی)": gregorianIsoToJalali(r.movementDate),
    "انبار": r.warehouseName,
    "کد کالا": r.productSku,
    "نام کالا": r.productName,
    "جهت": r.movementType,
    "تغییر مقدار": r.quantityDelta,
    "بهای واحد": r.unitCost,
    "تغییر ارزش": r.valueDelta,
    "مانده تعدادی بعد": r.balanceAfterQty,
    "مانده ریالی بعد": r.balanceAfterValue,
    "توضیحات": r.reason,
  }));

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(sheetRows);
  XLSX.utils.book_append_sheet(wb, ws, "WarehouseMovements");
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  const fileName = `warehouse-movements-${new Date().toISOString().slice(0, 10)}.xlsx`;

  await db.insert(reportExportJobs).values({
    organizationId: params.organizationId,
    requestedBy: params.actorUserId,
    reportType: "INVENTORY_MOVEMENTS",
    format: "XLSX",
    fileName,
    rowCount: filtered.length,
    status: "COMPLETED",
  });

  await recordAuditLog({
    organizationId: params.organizationId,
    actorUserId: params.actorUserId,
    actorEmail: params.actorEmail,
    scope: "ORGANIZATION",
    action: "INVENTORY_MOVEMENTS_XLSX_EXPORTED",
    entityType: "REPORT_EXPORT",
    ipAddress: params.ipAddress,
    metadata: { rowCount: filtered.length },
  });

  return { buffer, fileName, rowCount: filtered.length };
}

export async function listMultiItemTransferWithItems(organizationId: string, transferId: string) {
  const [tr] = await db
    .select()
    .from(stockTransfers)
    .where(and(eq(stockTransfers.id, transferId), eq(stockTransfers.organizationId, organizationId)))
    .limit(1);
  if (!tr) throw new ApiError(404, "TRANSFER_NOT_FOUND", "سند انتقال یافت نشد.");
  const items = await db
    .select()
    .from(stockTransferItems)
    .where(eq(stockTransferItems.stockTransferId, tr.id));
  const prodIds = [...new Set(items.map((i) => i.productId))];
  const prods =
    prodIds.length > 0
      ? await db.select().from(products).where(inArray(products.id, prodIds))
      : [];
  const pMap = new Map(prods.map((p) => [p.id, p]));
  return {
    ...tr,
    items: items.map((i) => ({
      ...i,
      product_name: pMap.get(i.productId)?.name ?? "",
      product_sku: pMap.get(i.productId)?.sku ?? "",
    })),
  };
}

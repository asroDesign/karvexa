import { and, asc, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  accounts,
  organizations,
  products,
  productVariants,
  purchaseOrderItems,
  purchaseOrders,
  purchaseSuggestions,
  stockCountItems,
  stockCounts,
  stockDocumentItems,
  stockDocuments,
  stockLedger,
  stockReservations,
  stockTransfers,
  warehouses,
  warehouseStockThresholds,
} from "@/db/schema";
import {
  assertAccountingDateWritableTx,
  createJournalEntryTx,
  JournalLineInput,
} from "@/modules/accounting/service";
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
import { recordAuditLog } from "@/lib/audit";
import { withTenantTransaction } from "@/lib/tenant";

/**
 * Reconstructs the current stock balance and FIFO layers for one locked SKU.
 */
async function getCurrentStockStateTx(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  organizationId: string,
  warehouseId: string,
  productId: string,
  variantId?: string | null,
  costingMethod: string = "WEIGHTED_AVERAGE"
) {
  // Deterministic advisory lock per (org, wh, prod, variant) prevents concurrent stock races
  const lockKey = `${organizationId}:${warehouseId}:${productId}:${variantId ?? "BASE"}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);

  const movements = await tx
    .select()
    .from(stockLedger)
    .where(
      and(
        eq(stockLedger.organizationId, organizationId),
        eq(stockLedger.warehouseId, warehouseId),
        eq(stockLedger.productId, productId),
        variantId ? eq(stockLedger.variantId, variantId) : isNull(stockLedger.variantId)
      )
    )
    .orderBy(asc(stockLedger.movementDate), asc(stockLedger.createdAt), asc(stockLedger.id));

  if (movements.length === 0) {
    return {
      qty: BigInt(0),
      value: BigInt(0),
      avgUnitCost: BigInt(0),
      fifoLayers: [] as Array<{ qty: bigint; value: bigint }>,
      latestMovementDate: null as string | null,
    };
  }

  let qty = BigInt(0);
  let value = BigInt(0);
  let shortageQty = BigInt(0);
  const fifoLayers: Array<{ qty: bigint; value: bigint }> = [];
  for (const movement of movements) {
    const movementQty = parseDecimal(movement.quantityDelta);
    const movementValue = parseDecimal(movement.valueDelta);
    qty = addDec(qty, movementQty);
    value = addDec(value, movementValue);
    if (movementQty > BigInt(0)) {
      let receivedQty = movementQty;
      let receivedValue = movementValue;
      if (shortageQty > BigInt(0)) {
        const absorbedQty = receivedQty < shortageQty ? receivedQty : shortageQty;
        const absorbedValue = absorbedQty === receivedQty
          ? receivedValue
          : mulDec(absorbedQty, divDec(receivedValue, receivedQty));
        receivedQty = subDec(receivedQty, absorbedQty);
        receivedValue = subDec(receivedValue, absorbedValue);
        shortageQty = subDec(shortageQty, absorbedQty);
      }
      if (isPositiveDec(receivedQty)) fifoLayers.push({ qty: receivedQty, value: receivedValue });
      continue;
    }

    let issueQty = -movementQty;
    while (isPositiveDec(issueQty) && fifoLayers.length > 0) {
      const layer = fifoLayers[0];
      if (!isPositiveDec(layer.qty)) {
        fifoLayers.shift();
        continue;
      }
      const usedQty = issueQty < layer.qty ? issueQty : layer.qty;
      const usedValue = usedQty === layer.qty ? layer.value : mulDec(usedQty, divDec(layer.value, layer.qty));
      layer.qty = subDec(layer.qty, usedQty);
      layer.value = subDec(layer.value, usedValue);
      issueQty = subDec(issueQty, usedQty);
      if (!isPositiveDec(layer.qty)) fifoLayers.shift();
    }
    shortageQty = addDec(shortageQty, issueQty);
  }

  // Reconcile legacy negative-stock or rounding history into a final layer so FIFO
  // layers always represent the current ledger quantity and value exactly.
  const positiveQty = fifoLayers.reduce((sum, layer) => addDec(sum, layer.qty), BigInt(0));
  const positiveValue = fifoLayers.reduce((sum, layer) => addDec(sum, layer.value), BigInt(0));
  if (isPositiveDec(qty)) {
    if (gtDec(qty, positiveQty)) {
      fifoLayers.push({ qty: subDec(qty, positiveQty), value: subDec(value, positiveValue) });
    } else if (qty === positiveQty && fifoLayers.length > 0) {
      fifoLayers[fifoLayers.length - 1].value = addDec(
        fifoLayers[fifoLayers.length - 1].value,
        subDec(value, positiveValue)
      );
    }
  }

  const [latest] = movements.slice(-1);
  const avgUnitCost = isPositiveDec(qty) ? divDec(value, qty) : parseDecimal(latest.unitCost);

  return { qty, value, avgUnitCost, fifoLayers, latestMovementDate: latest.movementDate };
}

function calculateFifoIssueValue(
  layers: Array<{ qty: bigint; value: bigint }>,
  quantity: bigint,
  fallbackUnitCost: bigint
) {
  let remainingQty = quantity;
  let totalValue = BigInt(0);
  for (const layer of layers) {
    if (!isPositiveDec(remainingQty)) break;
    if (!isPositiveDec(layer.qty)) continue;
    const usedQty = remainingQty < layer.qty ? remainingQty : layer.qty;
    if (isNegativeDec(layer.value)) {
      throw new ApiError(409, "FIFO_LAYER_VALUE_INVALID", "لایه بهای FIFO موجودی ارزش منفی دارد و باید پیش از خروج انبار اصلاح شود.");
    }
    const usedValue = usedQty === layer.qty ? layer.value : mulDec(usedQty, divDec(layer.value, layer.qty));
    totalValue = addDec(totalValue, usedValue);
    remainingQty = subDec(remainingQty, usedQty);
  }
  if (isPositiveDec(remainingQty)) totalValue = addDec(totalValue, mulDec(remainingQty, fallbackUnitCost));
  return totalValue;
}

export async function postStockDocumentTx(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  params: {
    organizationId: string;
    warehouseId: string;
    documentType: "RECEIPT" | "ISSUE" | "TRANSFER_OUT" | "TRANSFER_IN" | "ADJUSTMENT" | "OPENING";
    documentDate: string;
    reason: string;
    referenceType?: string | null;
    referenceId?: string | null;
    actorUserId: string;
    items: Array<{
      productId: string;
      variantId?: string | null;
      direction: "IN" | "OUT";
      quantity: string;
      unitCost?: string;
      totalCost?: string;
    }>;
  }
) {
  const [org] = await tx
    .select()
    .from(organizations)
    .where(eq(organizations.id, params.organizationId))
    .limit(1);
  if (!org) throw new ApiError(404, "ORG_NOT_FOUND", "سازمان یافت نشد.");

  const [wh] = await tx
    .select()
    .from(warehouses)
    .where(
      and(
        eq(warehouses.id, params.warehouseId),
        eq(warehouses.organizationId, params.organizationId)
      )
    )
    .limit(1);
  if (!wh) {
    throw new ApiError(404, "WAREHOUSE_NOT_FOUND", "انبار انتخاب‌شده متعلق به این سازمان نیست.");
  }
  await assertAccountingDateWritableTx(tx, params.organizationId, params.documentDate);

  const docNum = `SD-${Date.now().toString().slice(-7)}-${Math.floor(Math.random() * 900 + 100)}`;

  const [doc] = await tx
    .insert(stockDocuments)
    .values({
      organizationId: params.organizationId,
      warehouseId: params.warehouseId,
      documentNumber: docNum,
      documentType: params.documentType,
      documentDate: params.documentDate,
      reason: params.reason,
      referenceType: params.referenceType ?? null,
      referenceId: params.referenceId ?? null,
      status: "POSTED",
      createdBy: params.actorUserId,
    })
    .returning();

  const ledgerRows = [];
  let totalCostValue = BigInt(0);
  const warnings: string[] = [];

  for (const item of params.items) {
    const qty = parseDecimal(item.quantity);
    if (!isPositiveDec(qty)) {
      throw new ApiError(422, "QUANTITY_INVALID", "مقدار حرکت کالا باید بزرگ‌تر از صفر باشد.");
    }

    const [prod] = await tx
      .select()
      .from(products)
      .where(
        and(
          eq(products.id, item.productId),
          eq(products.organizationId, params.organizationId)
        )
      )
      .limit(1);
    if (!prod) {
      throw new ApiError(404, "PRODUCT_NOT_FOUND", "کالای انتخاب‌شده متعلق به این سازمان نیست.");
    }
    if (item.variantId) {
      const [variant] = await tx
        .select({ id: productVariants.id })
        .from(productVariants)
        .where(
          and(
            eq(productVariants.id, item.variantId),
            eq(productVariants.organizationId, params.organizationId),
            eq(productVariants.productId, item.productId)
          )
        )
        .limit(1);
      if (!variant) {
        throw new ApiError(422, "PRODUCT_VARIANT_MISMATCH", "تنوع انتخاب‌شده به همین کالا و سازمان تعلق ندارد.");
      }
    }

    const current = await getCurrentStockStateTx(
      tx,
      params.organizationId,
      params.warehouseId,
      item.productId,
      item.variantId ?? null,
      prod.costingMethod
    );
    if (current.latestMovementDate && params.documentDate < current.latestMovementDate) {
      throw new ApiError(
        409,
        "BACKDATED_STOCK_MOVEMENT_NOT_SUPPORTED",
        `تاریخ گردش کالا (${params.documentDate}) از آخرین گردش ثبت‌شده (${current.latestMovementDate}) قدیمی‌تر است؛ برای حفظ کاردکس و بهای FIFO، ابتدا تاریخ سند را اصلاح کنید.`
      );
    }

    const deltaQty = item.direction === "IN" ? qty : -qty;
    const nextQty = addDec(current.qty, deltaQty);

    // Explicit Negative Stock Policy Enforcement
    if (isNegativeDec(nextQty)) {
      if (org.negativeStockPolicy === "BLOCK") {
        throw new ApiError(
          409,
          "INVENTORY_NEGATIVE_STOCK_BLOCKED",
          `موجودی کالای «${prod.name}» در انبار «${wh.name}» کافی نیست (موجود: ${formatDecimal(current.qty, 4)}، درخواستی: ${formatDecimal(qty, 4)}). سیاست موجودی منفی: مسدود.`
        );
      } else if (org.negativeStockPolicy === "WARN") {
        warnings.push(`هشدار موجودی منفی برای کالای «${prod.name}» در انبار «${wh.name}».`);
      }
    }

    // Persist the actual line value when supplied (e.g. allocated landed cost);
    // otherwise value at the explicit cost or current weighted average.
    let unitCost: bigint;
    if (item.unitCost !== undefined) {
      unitCost = parseDecimal(item.unitCost);
      if (isNegativeDec(unitCost)) {
        throw new ApiError(422, "UNIT_COST_NEGATIVE", "بهای واحد کالا نمی‌تواند منفی باشد.");
      }
    } else if (item.direction === "OUT" && prod.costingMethod !== "FIFO") {
      unitCost = isPositiveDec(current.avgUnitCost)
        ? current.avgUnitCost
        : parseDecimal(prod.defaultPurchasePrice);
    } else if (item.direction === "OUT") {
      unitCost = isPositiveDec(current.avgUnitCost)
        ? current.avgUnitCost
        : parseDecimal(prod.defaultPurchasePrice);
    } else {
      unitCost = parseDecimal(prod.defaultPurchasePrice);
    }

    const lineValue = item.totalCost !== undefined
      ? parseDecimal(item.totalCost)
      : item.direction === "OUT" && prod.costingMethod === "FIFO"
        ? calculateFifoIssueValue(current.fifoLayers, qty, unitCost)
        : mulDec(qty, unitCost);
    if (item.totalCost !== undefined && item.unitCost === undefined) {
      unitCost = divDec(lineValue, qty);
    }
    if (item.totalCost === undefined && item.direction === "OUT" && prod.costingMethod === "FIFO") {
      unitCost = divDec(lineValue, qty);
    }
    if (isNegativeDec(lineValue)) {
      throw new ApiError(422, "TOTAL_COST_NEGATIVE", "ارزش کل گردش کالا نمی‌تواند منفی باشد.");
    }
    const deltaValue = item.direction === "IN" ? lineValue : -lineValue;
    const nextValue = addDec(current.value, deltaValue);
    totalCostValue = addDec(totalCostValue, lineValue);

    await tx.insert(stockDocumentItems).values({
      organizationId: params.organizationId,
      stockDocumentId: doc.id,
      productId: item.productId,
      variantId: item.variantId ?? null,
      quantity: formatDecimal(qty, 4),
      unitCost: formatDecimal(unitCost, 4),
      totalCost: formatDecimal(lineValue, 2),
    });

    const [ledgerRow] = await tx
      .insert(stockLedger)
      .values({
        organizationId: params.organizationId,
        stockDocumentId: doc.id,
        warehouseId: params.warehouseId,
        productId: item.productId,
        variantId: item.variantId ?? null,
        movementType: item.direction,
        reason: params.reason,
        quantityDelta: formatDecimal(deltaQty, 4),
        unitCost: formatDecimal(unitCost, 4),
        valueDelta: formatDecimal(deltaValue, 2),
        balanceAfterQty: formatDecimal(nextQty, 4),
        balanceAfterValue: formatDecimal(nextValue, 2),
        movementDate: params.documentDate,
      })
      .returning();

    ledgerRows.push(ledgerRow);
  }

  return {
    document: doc,
    ledgerRows,
    totalCostValue: formatDecimal(totalCostValue, 2),
    warnings,
  };
}

/**
 * Atomic Warehouse Transfer: Deducts from Source Warehouse and Adds to Target Warehouse inside 1 ACID Transaction.
 */
export async function executeAtomicWarehouseTransfer(params: {
  organizationId: string;
  sourceWarehouseId: string;
  targetWarehouseId: string;
  productId: string;
  quantity: string;
  transferDate: string;
  notes?: string;
  actorUserId: string;
  actorEmail: string;
  ipAddress?: string | null;
}) {
  if (params.sourceWarehouseId === params.targetWarehouseId) {
    throw new ApiError(
      422,
      "TRANSFER_SAME_WAREHOUSE",
      "انبار مبدأ و انبار مقصد نمی‌توانند یکسان باشند."
    );
  }

  const result = await withTenantTransaction(params.organizationId, async (tx) => {
    const skuLocks = [params.sourceWarehouseId, params.targetWarehouseId]
      .map((warehouseId) => `${params.organizationId}:${warehouseId}:${params.productId}:BASE`)
      .sort();
    for (const lockKey of skuLocks) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    }
    const outRes = await postStockDocumentTx(tx, {
      organizationId: params.organizationId,
      warehouseId: params.sourceWarehouseId,
      documentType: "TRANSFER_OUT",
      documentDate: params.transferDate,
      reason: params.notes || "انتقال بین انبارها (خروج از مبدأ)",
      referenceType: "STOCK_TRANSFER",
      actorUserId: params.actorUserId,
      items: [
        {
          productId: params.productId,
          direction: "OUT",
          quantity: params.quantity,
        },
      ],
    });

    const transferredUnitCost = outRes.ledgerRows[0]?.unitCost ?? "0.0000";

    const inRes = await postStockDocumentTx(tx, {
      organizationId: params.organizationId,
      warehouseId: params.targetWarehouseId,
      documentType: "TRANSFER_IN",
      documentDate: params.transferDate,
      reason: params.notes || "انتقال بین انبارها (ورود به مقصد)",
      referenceType: "STOCK_TRANSFER",
      actorUserId: params.actorUserId,
      items: [
        {
          productId: params.productId,
          direction: "IN",
          quantity: params.quantity,
          unitCost: transferredUnitCost,
          totalCost: outRes.totalCostValue,
        },
      ],
    });

    const transferNumber = `TR-${Date.now().toString().slice(-6)}`;
    const [transfer] = await tx
      .insert(stockTransfers)
      .values({
        organizationId: params.organizationId,
        transferNumber,
        sourceWarehouseId: params.sourceWarehouseId,
        targetWarehouseId: params.targetWarehouseId,
        productId: params.productId,
        quantity: formatDecimal(parseDecimal(params.quantity), 4),
        unitCost: transferredUnitCost,
        outDocumentId: outRes.document.id,
        inDocumentId: inRes.document.id,
        transferDate: params.transferDate,
        notes: params.notes ?? null,
        status: "COMPLETED",
        createdBy: params.actorUserId,
      })
      .returning();

    return {
      transfer,
      outDocument: outRes.document,
      inDocument: inRes.document,
      warnings: [...outRes.warnings, ...inRes.warnings],
    };
  });

  await recordAuditLog({
    organizationId: params.organizationId,
    actorUserId: params.actorUserId,
    actorEmail: params.actorEmail,
    scope: "ORGANIZATION",
    action: "WAREHOUSE_TRANSFER_COMPLETED",
    entityType: "STOCK_TRANSFER",
    entityId: result.transfer.id,
    ipAddress: params.ipAddress,
    metadata: {
      transferNumber: result.transfer.transferNumber,
      sourceWarehouseId: params.sourceWarehouseId,
      targetWarehouseId: params.targetWarehouseId,
      productId: params.productId,
      quantity: result.transfer.quantity,
    },
  });

  return result;
}

/**
 * Stock Count Approval: calculates countedQty - systemQty from Stock Ledger and posts an ADJUSTMENT stock document.
 */
export async function approveStockCount(params: {
  organizationId: string;
  warehouseId: string;
  countDate: string;
  notes?: string;
  items: Array<{ productId: string; countedQty: string }>;
  actorUserId: string;
  actorEmail: string;
  ipAddress?: string | null;
}) {
  const result = await withTenantTransaction(params.organizationId, async (tx) => {
    await assertAccountingDateWritableTx(tx, params.organizationId, params.countDate);
    const countNumber = `SC-${Date.now().toString().slice(-6)}`;
    const productIds = [...new Set(params.items.map((item) => item.productId))];
    if (productIds.length !== params.items.length) {
      throw new ApiError(422, "DUPLICATE_COUNT_PRODUCT", "هر کالا باید فقط یک‌بار در یک سند انبارگردانی ثبت شود.");
    }
    const [warehouse] = await tx
      .select({ id: warehouses.id })
      .from(warehouses)
      .where(
        and(
          eq(warehouses.id, params.warehouseId),
          eq(warehouses.organizationId, params.organizationId),
          eq(warehouses.isActive, true)
        )
      )
      .limit(1);
    if (!warehouse) throw new ApiError(404, "WAREHOUSE_NOT_FOUND", "انبار فعال متعلق به این سازمان یافت نشد.");
    const scopedProducts = await tx
      .select({ id: products.id, costingMethod: products.costingMethod, defaultPurchasePrice: products.defaultPurchasePrice })
      .from(products)
      .where(and(eq(products.organizationId, params.organizationId), inArray(products.id, productIds)));
    if (scopedProducts.length !== productIds.length) {
      throw new ApiError(403, "PRODUCT_NOT_FOUND", "یکی از کالاهای انبارگردانی متعلق به این سازمان نیست.");
    }

    const evaluatedItems: Array<{
      productId: string;
      systemQty: bigint;
      countedQty: bigint;
      varianceQty: bigint;
      adjustmentUnitCost: bigint;
    }> = [];

    for (const item of params.items) {
      const current = await getCurrentStockStateTx(
        tx,
        params.organizationId,
        params.warehouseId,
        item.productId,
        null,
        scopedProducts.find((product) => product.id === item.productId)?.costingMethod ?? "WEIGHTED_AVERAGE"
      );
      if (current.latestMovementDate && params.countDate < current.latestMovementDate) {
        throw new ApiError(409, "BACKDATED_STOCK_COUNT_NOT_SUPPORTED", "تاریخ انبارگردانی از آخرین گردش ثبت‌شده کالا قدیمی‌تر است؛ موجودی را در تاریخ جاری انبارگردانی کنید.");
      }
      const product = scopedProducts.find((entry) => entry.id === item.productId)!;
      const counted = parseDecimal(item.countedQty);
      if (isNegativeDec(counted)) {
        throw new ApiError(422, "COUNTED_QTY_NEGATIVE", "مقدار شمارش‌شده نمی‌تواند منفی باشد.");
      }
      const variance = subDec(counted, current.qty);
      evaluatedItems.push({
        productId: item.productId,
        systemQty: current.qty,
        countedQty: counted,
        varianceQty: variance,
        adjustmentUnitCost: product.costingMethod === "FIFO" && current.fifoLayers.length > 0
          ? divDec(current.fifoLayers[current.fifoLayers.length - 1].value, current.fifoLayers[current.fifoLayers.length - 1].qty)
          : isPositiveDec(current.avgUnitCost)
            ? current.avgUnitCost
            : parseDecimal(product.defaultPurchasePrice),
      });
    }

    const adjustmentItems = evaluatedItems
      .filter((i) => i.varianceQty !== BigInt(0))
      .map((i) => ({
        productId: i.productId,
        direction: (isPositiveDec(i.varianceQty) ? "IN" : "OUT") as "IN" | "OUT",
        quantity: formatDecimal(
          isPositiveDec(i.varianceQty) ? i.varianceQty : -i.varianceQty,
          4
        ),
        ...(isPositiveDec(i.varianceQty)
          ? { unitCost: formatDecimal(i.adjustmentUnitCost, 4) }
          : {}),
      }));

    let adjustmentDocId: string | null = null;
    let adjustmentJournal = null;
    if (adjustmentItems.length > 0) {
      const adjRes = await postStockDocumentTx(tx, {
        organizationId: params.organizationId,
        warehouseId: params.warehouseId,
        documentType: "ADJUSTMENT",
        documentDate: params.countDate,
        reason: `سند تعدیل انبارگردانی ${countNumber}`,
        referenceType: "STOCK_COUNT",
        actorUserId: params.actorUserId,
        items: adjustmentItems,
      });
      adjustmentDocId = adjRes.document.id;

      let inventoryIncrease = BigInt(0);
      let inventoryDecrease = BigInt(0);
      for (const ledgerRow of adjRes.ledgerRows) {
        const value = parseDecimal(ledgerRow.valueDelta);
        if (ledgerRow.movementType === "IN") inventoryIncrease = addDec(inventoryIncrease, value);
        if (ledgerRow.movementType === "OUT") inventoryDecrease = addDec(inventoryDecrease, -value);
      }

      const orgAccounts = await tx
        .select()
        .from(accounts)
        .where(eq(accounts.organizationId, params.organizationId));
      const inventoryAccount = orgAccounts.find((account) => account.systemRole === "INVENTORY");
      const cogsAccount = orgAccounts.find((account) => account.systemRole === "COGS");
      if (!inventoryAccount || !cogsAccount) {
        throw new ApiError(422, "STOCK_COUNT_ACCOUNT_MAPPING_MISSING", "برای ثبت مالی انبارگردانی، حساب موجودی و بهای تمام‌شده باید تعریف شده باشند.");
      }

      const journalLines: JournalLineInput[] = [];
      if (isPositiveDec(inventoryIncrease)) {
        journalLines.push(
          { accountId: inventoryAccount.id, debit: formatDecimal(inventoryIncrease, 2), credit: "0.00", description: `افزایش موجودی طبق انبارگردانی ${countNumber}` },
          { accountId: cogsAccount.id, debit: "0.00", credit: formatDecimal(inventoryIncrease, 2), description: `کاهش بهای تمام‌شده بابت کسری کمتر از سیستم ${countNumber}` }
        );
      }
      if (isPositiveDec(inventoryDecrease)) {
        journalLines.push(
          { accountId: cogsAccount.id, debit: formatDecimal(inventoryDecrease, 2), credit: "0.00", description: `زیان کسری موجودی طبق انبارگردانی ${countNumber}` },
          { accountId: inventoryAccount.id, debit: "0.00", credit: formatDecimal(inventoryDecrease, 2), description: `کاهش موجودی طبق انبارگردانی ${countNumber}` }
        );
      }
      if (journalLines.length >= 2) {
        const journal = await createJournalEntryTx(tx, {
          organizationId: params.organizationId,
          actorUserId: params.actorUserId,
          actorEmail: params.actorEmail,
          entryDate: params.countDate,
          description: `سند مالی انبارگردانی ${countNumber}`,
          referenceType: "STOCK_COUNT",
          referenceId: adjRes.document.id,
          postImmediately: true,
          lines: journalLines,
        });
        adjustmentJournal = journal.entry;
        await tx
          .update(stockDocuments)
          .set({ journalEntryId: adjustmentJournal.id })
          .where(eq(stockDocuments.id, adjRes.document.id));
      }
    }

    const [countDoc] = await tx
      .insert(stockCounts)
      .values({
        organizationId: params.organizationId,
        warehouseId: params.warehouseId,
        countNumber,
        countDate: params.countDate,
        notes: params.notes ?? null,
        adjustmentDocumentId: adjustmentDocId,
        status: "APPROVED",
        createdBy: params.actorUserId,
      })
      .returning();

    if (adjustmentDocId) {
      await tx
        .update(stockDocuments)
        .set({ referenceId: countDoc.id })
        .where(eq(stockDocuments.id, adjustmentDocId));
    }

    const savedItems = await tx
      .insert(stockCountItems)
      .values(
        evaluatedItems.map((i) => ({
          organizationId: params.organizationId,
          stockCountId: countDoc.id,
          productId: i.productId,
          systemQty: formatDecimal(i.systemQty, 4),
          countedQty: formatDecimal(i.countedQty, 4),
          varianceQty: formatDecimal(i.varianceQty, 4),
        }))
      )
      .returning();

    return {
      countDoc,
      items: savedItems,
      adjustmentDocumentId: adjustmentDocId,
      journalEntry: adjustmentJournal,
    };
  });

  await recordAuditLog({
    organizationId: params.organizationId,
    actorUserId: params.actorUserId,
    actorEmail: params.actorEmail,
    scope: "ORGANIZATION",
    action: "STOCK_COUNT_APPROVED",
    entityType: "STOCK_COUNT",
    entityId: result.countDoc.id,
    ipAddress: params.ipAddress,
    metadata: {
      countNumber: result.countDoc.countNumber,
      adjustmentDocumentId: result.adjustmentDocumentId,
      journalEntryId: result.journalEntry?.id ?? null,
    },
  });

  return result;
}

/**
 * Reconstructs current on-hand stock quantities & valuations strictly from `stock_ledger`.
 */
export async function getLiveStockBalances(organizationId: string, asOfDate?: string) {
  const [rows, allVariants] = await Promise.all([
    db
      .select({
        warehouseId: stockLedger.warehouseId,
        warehouseName: warehouses.name,
        productId: stockLedger.productId,
        variantId: stockLedger.variantId,
        productSku: products.sku,
        productName: products.name,
        costingMethod: products.costingMethod,
        quantityDelta: stockLedger.quantityDelta,
        valueDelta: stockLedger.valueDelta,
      })
      .from(stockLedger)
      .innerJoin(warehouses, eq(stockLedger.warehouseId, warehouses.id))
      .innerJoin(products, eq(stockLedger.productId, products.id))
      .where(
        asOfDate
          ? and(
              eq(stockLedger.organizationId, organizationId),
              lte(stockLedger.movementDate, asOfDate)
            )
          : eq(stockLedger.organizationId, organizationId)
      ),
    db.select().from(productVariants).where(eq(productVariants.organizationId, organizationId)),
  ]);

  const vMap = new Map(allVariants.map((v) => [v.id, v]));

  const map = new Map<
    string,
    {
      warehouseId: string;
      warehouseName: string;
      productId: string;
      variantId: string | null;
      variantName: string | null;
      productSku: string;
      productName: string;
      costingMethod: string;
      qty: bigint;
      val: bigint;
    }
  >();

  for (const r of rows) {
    const key = `${r.warehouseId}:${r.productId}:${r.variantId ?? "BASE"}`;
    const variant = r.variantId ? vMap.get(r.variantId) : null;
    const existing = map.get(key) ?? {
      warehouseId: r.warehouseId,
      warehouseName: r.warehouseName,
      productId: r.productId,
      variantId: r.variantId ?? null,
      variantName: variant?.variantName ?? null,
      productSku: variant?.sku ?? r.productSku,
      productName: r.productName,
      costingMethod: r.costingMethod,
      qty: BigInt(0),
      val: BigInt(0),
    };
    existing.qty = addDec(existing.qty, r.quantityDelta);
    existing.val = addDec(existing.val, r.valueDelta);
    map.set(key, existing);
  }

  let totalValuation = BigInt(0);
  const balances = Array.from(map.values()).map((entry) => {
    totalValuation = addDec(totalValuation, entry.val);
    const avgCost = isPositiveDec(entry.qty) ? divDec(entry.val, entry.qty) : BigInt(0);
    return {
      warehouseId: entry.warehouseId,
      warehouseName: entry.warehouseName,
      productId: entry.productId,
      variantId: entry.variantId,
      variantName: entry.variantName,
      productSku: entry.productSku,
      productName: entry.productName,
      costingMethod: entry.costingMethod,
      onHandQty: formatDecimal(entry.qty, 4),
      totalValue: formatDecimal(entry.val, 2),
      avgUnitCost: formatDecimal(avgCost, 2),
    };
  });

  return {
    totalValuation: formatDecimal(totalValuation, 2),
    balances,
  };
}

/**
 * Master Prompt 05 §6.3 — Opening Stock Document (Stock Ledger + Opening Accounting Voucher)
 */
export async function postOpeningStockDocument(params: {
  organizationId: string;
  warehouseId: string;
  productId: string;
  variantId?: string | null;
  quantity: string;
  unitCost: string;
  effectiveDate: string;
  description?: string;
  actorUserId: string;
  actorEmail: string;
  ipAddress?: string | null;
}) {
  const result = await withTenantTransaction(params.organizationId, async (tx) => {
    const stockRes = await postStockDocumentTx(tx, {
      organizationId: params.organizationId,
      warehouseId: params.warehouseId,
      documentType: "OPENING",
      documentDate: params.effectiveDate,
      reason: params.description || "سند موجودی اول دوره کالا/تنوع",
      referenceType: "OPENING_STOCK",
      actorUserId: params.actorUserId,
      items: [
        {
          productId: params.productId,
          variantId: params.variantId ?? null,
          direction: "IN",
          quantity: params.quantity,
          unitCost: params.unitCost,
        },
      ],
    });

    let journalEntry = null;
    if (isPositiveDec(parseDecimal(stockRes.totalCostValue))) {
      const [invAcc] = await tx
        .select()
        .from(accounts)
        .where(and(eq(accounts.organizationId, params.organizationId), eq(accounts.systemRole, "INVENTORY")))
        .limit(1);
      const [capAcc] = await tx
        .select()
        .from(accounts)
        .where(and(eq(accounts.organizationId, params.organizationId), eq(accounts.systemRole, "CAPITAL")))
        .limit(1);

      if (invAcc && capAcc) {
        const jRes = await createJournalEntryTx(tx, {
          organizationId: params.organizationId,
          actorUserId: params.actorUserId,
          actorEmail: params.actorEmail,
          entryDate: params.effectiveDate,
          description: `سند افتتاحیه موجودی کالا (${stockRes.document.documentNumber})`,
          referenceType: "OPENING",
          referenceId: stockRes.document.id,
          postImmediately: true,
          lines: [
            { accountId: invAcc.id, debit: stockRes.totalCostValue, credit: "0.00", description: "افزایش موجودی اول دوره کالا" },
            { accountId: capAcc.id, debit: "0.00", credit: stockRes.totalCostValue, description: "تعدیل سرمایه بابت موجودی اول دوره" },
          ],
        });
        journalEntry = jRes.entry;
      }
    }

    return { stockDocument: stockRes.document, ledgerRows: stockRes.ledgerRows, journalEntry };
  });

  await recordAuditLog({
    organizationId: params.organizationId,
    actorUserId: params.actorUserId,
    actorEmail: params.actorEmail,
    scope: "ORGANIZATION",
    action: "OPENING_STOCK_POSTED",
    entityType: "STOCK_DOCUMENT",
    entityId: result.stockDocument.id,
    ipAddress: params.ipAddress,
    metadata: { productId: params.productId, variantId: params.variantId ?? null, quantity: params.quantity },
  });

  return result;
}

/**
 * Master Prompt 05 §7.1 & §7.2 & Scenario E — Inventory Metrics + Smart Purchase Recommendation Engine
 */
export async function computeSmartPurchaseRecommendations(organizationId: string) {
  const [stock, thresholds, activeReservations, openPoItems, allWhs, allProds] =
    await Promise.all([
      getLiveStockBalances(organizationId),
      db
        .select()
        .from(warehouseStockThresholds)
        .where(eq(warehouseStockThresholds.organizationId, organizationId)),
      db
        .select()
        .from(stockReservations)
        .where(and(eq(stockReservations.organizationId, organizationId), eq(stockReservations.status, "ACTIVE"))),
      db
        .select({
          warehouseId: purchaseOrders.warehouseId,
          productId: purchaseOrderItems.productId,
          variantId: purchaseOrderItems.variantId,
          quantity: purchaseOrderItems.quantity,
          receivedQuantity: purchaseOrderItems.receivedQuantity,
          status: purchaseOrders.status,
        })
        .from(purchaseOrderItems)
        .innerJoin(purchaseOrders, eq(purchaseOrderItems.purchaseOrderId, purchaseOrders.id))
        .where(eq(purchaseOrders.organizationId, organizationId)),
      db.select().from(warehouses).where(eq(warehouses.organizationId, organizationId)),
      db.select().from(products).where(eq(products.organizationId, organizationId)),
    ]);

  const whMap = new Map(allWhs.map((w) => [w.id, w.name]));
  const pMap = new Map(allProds.map((p) => [p.id, p]));

  // Build candidate tuples from thresholds + low-stock products
  const generated: Array<typeof purchaseSuggestions.$inferSelect> = [];

  for (const th of thresholds) {
    const prod = pMap.get(th.productId);
    if (!prod) continue;

    const matchingStock = stock.balances.find(
      (b) =>
        b.warehouseId === th.warehouseId &&
        b.productId === th.productId &&
        (b.variantId ?? null) === (th.variantId ?? null)
    );
    const onHand = parseDecimal(matchingStock?.onHandQty ?? "0");

    let reserved = BigInt(0);
    for (const r of activeReservations.filter(
      (x) => x.warehouseId === th.warehouseId && x.productId === th.productId
    )) {
      reserved = addDec(reserved, r.quantity);
    }

    const available = subDec(onHand, reserved);

    // Incoming open/confirmed PO quantities! (Scenario E requirement)
    let incomingPo = BigInt(0);
    for (const poi of openPoItems.filter(
      (x) =>
        (x.status === "OPEN" || x.status === "CONFIRMED") &&
        x.productId === th.productId &&
        (!x.warehouseId || x.warehouseId === th.warehouseId) &&
        (x.variantId ?? null) === (th.variantId ?? null)
    )) {
      const rem = subDec(poi.quantity, poi.receivedQuantity);
      if (isPositiveDec(rem)) incomingPo = addDec(incomingPo, rem);
    }

    // Reorder Point = max(minStock, avgDailyDemand * leadTimeDays + safetyStock)
    const demandDuringLead = mulDec(th.avgDailyDemand, `${th.leadTimeDays}.0000`);
    const formulaRop = addDec(demandDuringLead, th.safetyStock);
    const minStockDec = parseDecimal(th.minStock);
    const reorderPoint = formulaRop > minStockDec ? formulaRop : minStockDec;

    // Effective projected stock = available + incomingPo
    const projectedStock = addDec(available, incomingPo);

    // Recommend if available <= minStock OR projectedStock < reorderPoint
    if (available <= minStockDec || projectedStock < reorderPoint) {
      let rawNeed = subDec(reorderPoint, projectedStock);
      if (!isPositiveDec(rawNeed)) {
        // Still below minStock right now even with incoming PO -> recommend safety buffer
        rawNeed = parseDecimal(th.safetyStock);
      }
      const moq = parseDecimal(th.supplierMoq);
      const recommended = rawNeed < moq ? moq : rawNeed;

      const risk =
        !isPositiveDec(available)
          ? "CRITICAL"
          : available < minStockDec
            ? "HIGH"
            : "MEDIUM";

      const reasonFa = `موجودی قابل‌فروش (${formatDecimal(available, 2)}) و سفارش در راه (${formatDecimal(
        incomingPo,
        2
      )}) در برابر نقطه سفارش (${formatDecimal(reorderPoint, 2)} = تقاضای ${
        th.leadTimeDays
      } روز + ذخیره اطمینان ${formatDecimal(parseDecimal(th.safetyStock), 2)}) و حداقل موجودی (${formatDecimal(
        minStockDec,
        2
      )}). مقدار پیشنهادی با لحاظ سفارش در راه: ${formatDecimal(recommended, 2)}.`;

      // Reuse pending suggestion if already open for same tuple to prevent duplicates
      const [existingPending] = await db
        .select()
        .from(purchaseSuggestions)
        .where(
          and(
            eq(purchaseSuggestions.organizationId, organizationId),
            eq(purchaseSuggestions.warehouseId, th.warehouseId),
            eq(purchaseSuggestions.productId, th.productId),
            eq(purchaseSuggestions.status, "PENDING")
          )
        )
        .limit(1);

      if (existingPending) {
        const [upd] = await db
          .update(purchaseSuggestions)
          .set({
            onHandQty: formatDecimal(onHand, 4),
            reservedQty: formatDecimal(reserved, 4),
            availableQty: formatDecimal(available, 4),
            incomingPoQty: formatDecimal(incomingPo, 4),
            reorderPoint: formatDecimal(reorderPoint, 4),
            recommendedQty: formatDecimal(recommended, 4),
            stockoutRisk: risk,
            reasonFa,
          })
          .where(eq(purchaseSuggestions.id, existingPending.id))
          .returning();
        generated.push(upd);
      } else {
        const [ins] = await db
          .insert(purchaseSuggestions)
          .values({
            organizationId,
            warehouseId: th.warehouseId,
            productId: th.productId,
            variantId: th.variantId ?? null,
            preferredSupplierId: th.preferredSupplierId ?? null,
            onHandQty: formatDecimal(onHand, 4),
            reservedQty: formatDecimal(reserved, 4),
            availableQty: formatDecimal(available, 4),
            incomingPoQty: formatDecimal(incomingPo, 4),
            reorderPoint: formatDecimal(reorderPoint, 4),
            recommendedQty: formatDecimal(recommended, 4),
            stockoutRisk: risk,
            reasonFa,
            status: "PENDING",
          })
          .returning();
        generated.push(ins);
      }
    }
  }

  const allSuggestions = await db
    .select()
    .from(purchaseSuggestions)
    .where(eq(purchaseSuggestions.organizationId, organizationId))
    .orderBy(desc(purchaseSuggestions.createdAt));

  return allSuggestions.map((s) => ({
    ...s,
    warehouse_name: whMap.get(s.warehouseId) ?? "",
    product_name: pMap.get(s.productId)?.name ?? "",
    product_sku: pMap.get(s.productId)?.sku ?? "",
  }));
}

export async function convertSuggestionToPurchaseOrder(params: {
  organizationId: string;
  suggestionId: string;
  supplierId?: string | null;
  overrideQty?: string;
  actorUserId: string;
  actorEmail: string;
  ipAddress?: string | null;
}) {
  const result = await withTenantTransaction(params.organizationId, async (tx) => {
    const [sugg] = await tx
      .select()
      .from(purchaseSuggestions)
      .where(
        and(
          eq(purchaseSuggestions.id, params.suggestionId),
          eq(purchaseSuggestions.organizationId, params.organizationId)
        )
      )
      .limit(1);

    if (!sugg) throw new ApiError(404, "SUGGESTION_NOT_FOUND", "پیشنهاد خرید یافت نشد.");

    // Prevent duplicate PO conversion! (Scenario E requirement)
    if (sugg.status === "CONVERTED" && sugg.convertedPoId) {
      const [existingPo] = await tx
        .select()
        .from(purchaseOrders)
        .where(eq(purchaseOrders.id, sugg.convertedPoId))
        .limit(1);
      return { purchaseOrder: existingPo, suggestion: sugg, alreadyConverted: true };
    }

    const supplierId = params.supplierId || sugg.preferredSupplierId;
    if (!supplierId) {
      throw new ApiError(422, "SUPPLIER_REQUIRED", "انتخاب تأمین‌کننده جهت تبدیل به سفارش خرید الزامی است.");
    }

    const [prod] = await tx
      .select()
      .from(products)
      .where(eq(products.id, sugg.productId))
      .limit(1);

    const qty = params.overrideQty || sugg.recommendedQty;
    const unitPrice = prod?.defaultPurchasePrice ?? "0.00";
    const lineTotal = formatDecimal(mulDec(qty, unitPrice), 2);

    const [po] = await tx
      .insert(purchaseOrders)
      .values({
        organizationId: params.organizationId,
        contactId: supplierId,
        warehouseId: sugg.warehouseId,
        orderNumber: `PO-${Date.now().toString().slice(-6)}`,
        orderDate: new Date().toISOString().slice(0, 10),
        totalAmount: lineTotal,
        status: "CONFIRMED",
        sourceSuggestionId: sugg.id,
        notes: `ایجادشده از پیشنهاد خرید هوشمند: ${sugg.reasonFa}`,
        createdBy: params.actorUserId,
      })
      .returning();

    await tx.insert(purchaseOrderItems).values({
      organizationId: params.organizationId,
      purchaseOrderId: po.id,
      productId: sugg.productId,
      variantId: sugg.variantId ?? null,
      quantity: qty,
      unitPrice,
      lineTotal,
    });

    const [updSugg] = await tx
      .update(purchaseSuggestions)
      .set({ status: "CONVERTED", convertedPoId: po.id })
      .where(eq(purchaseSuggestions.id, sugg.id))
      .returning();

    return { purchaseOrder: po, suggestion: updSugg, alreadyConverted: false };
  });

  await recordAuditLog({
    organizationId: params.organizationId,
    actorUserId: params.actorUserId,
    actorEmail: params.actorEmail,
    scope: "ORGANIZATION",
    action: "SUGGESTION_CONVERTED_TO_PO",
    entityType: "PURCHASE_ORDER",
    entityId: result.purchaseOrder?.id ?? null,
    ipAddress: params.ipAddress,
  });

  return result;
}

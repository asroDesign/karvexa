import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  products,
  stockCountItems,
  stockCounts,
  stockDocumentItems,
  stockDocuments,
  stockLedger,
  stockTransferItems,
  stockTransfers,
  productVariants,
  warehouses,
} from "@/db/schema";
import { ensureSeeded } from "@/db/seed";
import {
  ApiError,
  applyListFilterAndPaginate,
  ok,
  okList,
  parseListQuery,
} from "@/lib/errors";
import { checkIdempotency, saveIdempotency } from "@/lib/idempotency";
import { resolveCanonicalDate } from "@/lib/jalali";
import { requireOrgContext, withTenantTransaction } from "@/lib/tenant";
import {
  approveStockCount,
  executeAtomicWarehouseTransfer,
  getLiveStockBalances,
  postStockDocumentTx,
} from "@/modules/inventory/service";
import {
  completeWarehouseTransfer,
  createLandedWarehouseReceipt,
  createMultiItemTransfer,
  dispatchMultiItemTransfer,
  exportInventoryMovementsXlsx,
  exportInventoryStockXlsx,
  getSupplierProfile,
  listMultiItemTransferWithItems,
  receiveMultiItemTransfer,
  recordSupplierSettlement,
  submitMultiItemTransfer,
} from "@/modules/inventory/prompt08.service";

const createWhSchema = z.object({
  code: z.string().min(2),
  name: z.string().min(2),
  address: z.string().optional(),
  is_default: z.boolean().default(false),
});

const stockDocSchema = z.object({
  client_document_id: z.string().uuid().optional(),
  warehouse_id: z.string().uuid(),
  document_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  document_date_jalali: z.string().optional(),
  reference_number: z.string().optional(),
  description: z.string().min(2).default("سند انبار"),
  items: z
    .array(
      z.object({
        product_id: z.string().uuid(),
        variant_id: z.string().uuid().nullable().optional(),
        quantity: z.string().regex(/^\d+(\.\d{1,4})?$/),
        unit_cost: z.string().regex(/^\d+(\.\d{1,4})?$/).optional(),
      })
    )
    .min(1),
});

const transferSchema = z.object({
  source_warehouse_id: z.string().uuid(),
  destination_warehouse_id: z.string().uuid().optional(),
  target_warehouse_id: z.string().uuid().optional(),
  product_id: z.string().uuid(),
  quantity: z.string().regex(/^\d+(\.\d{1,4})?$/),
  transfer_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  transfer_date_jalali: z.string().optional(),
  document_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  notes: z.string().optional(),
  description: z.string().optional(),
});

const countSchema = z.object({
  warehouse_id: z.string().uuid(),
  count_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  count_date_jalali: z.string().optional(),
  document_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  notes: z.string().optional(),
  items: z
    .array(
      z.object({
        product_id: z.string().uuid(),
        counted_qty: z.string().regex(/^\d+(\.\d{1,4})?$/).optional(),
        quantity: z.string().regex(/^\d+(\.\d{1,4})?$/).optional(),
      })
    )
    .min(1),
});

export async function handleWarehouseAndInventoryRoutes(
  req: NextRequest,
  method: string,
  segments: string[]
) {
  await ensureSeeded();
  const root = segments[0]; // warehouses | inventory
  const seg1 = segments[1];
  const seg2 = segments[2];
  const seg3 = segments[3];

  // ============================================================================
  // /api/v1/warehouses
  // ============================================================================
  if (root === "warehouses") {
    if (method === "GET" && !seg1) {
      const ctx = await requireOrgContext(req, "inventory.view");
      const q = parseListQuery(req);
      const list = await db
        .select()
        .from(warehouses)
        .where(eq(warehouses.organizationId, ctx.organizationId));
      const { items, total } = applyListFilterAndPaginate(list, q, ["name", "code"]);
      return okList(items, { page: q.page, perPage: q.perPage, total }, {
        costing_method: ctx.organization.costingMethod,
        negative_stock_policy: ctx.organization.negativeStockPolicy,
      });
    }
    if (method === "POST" && !seg1) {
      const ctx = await requireOrgContext(req, "inventory.confirm", { requireActiveSubscription: true });
      const body = createWhSchema.parse(await req.json());
      if (body.is_default) {
        const [existingDefault] = await db
          .select({ id: warehouses.id })
          .from(warehouses)
          .where(and(eq(warehouses.organizationId, ctx.organizationId), eq(warehouses.isDefault, true)))
          .limit(1);
        if (existingDefault) throw new ApiError(409, "DEFAULT_WAREHOUSE_EXISTS", "برای هر سازمان فقط یک انبار اصلی مجاز است.");
      }
      const [wh] = await db
        .insert(warehouses)
        .values({
          organizationId: ctx.organizationId,
          code: body.code.trim(),
          name: body.name.trim(),
          address: body.address ?? null,
          isDefault: body.is_default,
        })
        .returning();
      return ok(wh, 201);
    }
    if (seg1) {
      const ctx = await requireOrgContext(req, "inventory.view");
      const [wh] = await db
        .select()
        .from(warehouses)
        .where(and(eq(warehouses.id, seg1), eq(warehouses.organizationId, ctx.organizationId)))
        .limit(1);
      if (!wh) throw new ApiError(404, "WAREHOUSE_NOT_FOUND", "انبار یافت نشد.");

      if (method === "GET" && !seg2) return ok(wh);
      if (method === "GET" && seg2 === "stock") {
        const stock = await getLiveStockBalances(ctx.organizationId);
        return ok(stock.balances.filter((b) => b.warehouseId === wh.id));
      }
      if (method === "PATCH" && !seg2) {
        await requireOrgContext(req, "inventory.confirm", { requireActiveSubscription: true });
        const body = (await req.json()) as { name?: string; address?: string; is_active?: boolean };
        if (body.is_active === false && wh.isDefault) {
          throw new ApiError(422, "DEFAULT_WAREHOUSE_CANNOT_BE_DISABLED", "انبار اصلی سازمان قابل غیرفعال‌سازی نیست.");
        }
        if (body.is_active === false && wh.isActive) {
          const liveStock = await getLiveStockBalances(ctx.organizationId);
          const hasStock = liveStock.balances.some((balance) => balance.warehouseId === wh.id && Number(balance.onHandQty) !== 0);
          if (hasStock) {
            throw new ApiError(409, "WAREHOUSE_HAS_STOCK", "ابتدا موجودی این انبار را با حوالهٔ رسمی به انبار دیگری منتقل کنید.");
          }
        }
        const [upd] = await db
          .update(warehouses)
          .set({
            ...(body.name ? { name: body.name } : {}),
            ...(body.address !== undefined ? { address: body.address } : {}),
            ...(body.is_active !== undefined ? { isActive: body.is_active } : {}),
          })
          .where(eq(warehouses.id, wh.id))
          .returning();
        return ok(upd);
      }
      if (method === "DELETE" && !seg2) {
        await requireOrgContext(req, "inventory.confirm", { requireActiveSubscription: true });
        if (wh.isDefault) {
          throw new ApiError(422, "DEFAULT_WAREHOUSE_CANNOT_BE_DISABLED", "انبار اصلی سازمان قابل غیرفعال‌سازی نیست.");
        }
        const liveStock = await getLiveStockBalances(ctx.organizationId);
        const hasStock = liveStock.balances.some((balance) => balance.warehouseId === wh.id && Number(balance.onHandQty) !== 0);
        if (hasStock) {
          throw new ApiError(409, "WAREHOUSE_HAS_STOCK", "ابتدا موجودی این انبار را با حوالهٔ رسمی به انبار دیگری منتقل کنید.");
        }
        const [upd] = await db
          .update(warehouses)
          .set({ isActive: false })
          .where(eq(warehouses.id, wh.id))
          .returning();
        return ok(upd);
      }
    }
  }

  // ============================================================================
  // /api/v1/suppliers/{id}/{account|profile|transactions|settlements} (Prompt 09A §3)
  // ============================================================================
  if (root === "suppliers") {
    if (method === "GET" && seg1 && (seg2 === "profile" || seg2 === "account")) {
      const ctx = await requireOrgContext(req, "suppliers.view");
      return ok(await getSupplierProfile(ctx.organizationId, seg1));
    }
    if (method === "GET" && seg1 && seg2 === "transactions") {
      const ctx = await requireOrgContext(req, "suppliers.view");
      const prof = await getSupplierProfile(ctx.organizationId, seg1);
      const sp = req.nextUrl.searchParams;
      const dateFrom = sp.get("date_from");
      const dateTo = sp.get("date_to");
      let txs = prof.ledger_transactions;
      if (dateFrom) txs = txs.filter((t) => t.txDate >= dateFrom);
      if (dateTo) txs = txs.filter((t) => t.txDate <= dateTo);
      return ok({ supplier: prof.supplier, summary: prof.summary, transactions: txs });
    }
    if (method === "GET" && seg1 && seg2 === "settlements") {
      const ctx = await requireOrgContext(req, "suppliers.view");
      const prof = await getSupplierProfile(ctx.organizationId, seg1);
      const sp = req.nextUrl.searchParams;
      const dateFrom = sp.get("date_from");
      const dateTo = sp.get("date_to");
      const pm = sp.get("payment_method")?.toUpperCase();
      let list = prof.settlements;
      if (dateFrom) list = list.filter((s) => s.txDate >= dateFrom);
      if (dateTo) list = list.filter((s) => s.txDate <= dateTo);
      if (pm) list = list.filter((s) => s.paymentMethod.toUpperCase() === pm);
      return ok({ supplier: prof.supplier, summary: prof.summary, settlements: list });
    }
    if (method === "POST" && seg1 && seg2 === "settlements") {
      const ctx = await requireOrgContext(req, "suppliers.settle", { requireActiveSubscription: true });
      const body = z
        .object({
          financial_account_id: z.string().uuid(),
          payment_method: z.enum(["CASH", "BANK", "BANK_TRANSFER", "CARD_TERMINAL", "CHEQUE", "OTHER"]).default("BANK"),
          amount: z.string().regex(/^\d+(\.\d{1,2})?$/),
          settlement_date: z.string().optional(),
          settlement_date_jalali: z.string().optional(),
          reference_number: z.string().optional(),
          description: z.string().optional(),
        })
        .parse(await req.json());

      const idemKey = req.headers.get("idempotency-key");
      const cached = await checkIdempotency({
        organizationId: ctx.organizationId,
        key: idemKey,
        endpoint: `/api/v1/suppliers/${seg1}/settlements`,
        payload: body,
      });
      if (cached) return ok(cached.responseBody, cached.statusCode, { replayed: true });

      const res = await recordSupplierSettlement({
        organizationId: ctx.organizationId,
        supplierId: seg1,
        financialAccountId: body.financial_account_id,
        paymentMethod: body.payment_method,
        amount: body.amount,
        settlementDate: body.settlement_date,
        settlementDateJalali: body.settlement_date_jalali,
        referenceNumber: body.reference_number,
        description: body.description,
        actorUserId: ctx.userId,
        actorEmail: ctx.email,
        ipAddress: ctx.ipAddress,
      });
      await saveIdempotency({
        organizationId: ctx.organizationId,
        key: idemKey,
        endpoint: `/api/v1/suppliers/${seg1}/settlements`,
        payload: body,
        statusCode: 201,
        responseBody: res as unknown as Record<string, unknown>,
      });
      return ok(res, 201);
    }
  }

  // ============================================================================
  // /api/v1/inventory/*
  // ============================================================================
  if (root === "inventory") {
    // GET /api/v1/inventory/exports/stock & /api/v1/inventory/exports/movements (.xlsx — §2.7)
    if (method === "GET" && seg1 === "exports") {
      const ctx = await requireOrgContext(req, "inventory.exports");
      const sp = req.nextUrl.searchParams;
      if (seg2 === "stock") {
        const res = await exportInventoryStockXlsx({
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          actorEmail: ctx.email,
          ipAddress: ctx.ipAddress,
          warehouseId: sp.get("warehouse_id"),
          productId: sp.get("product_id"),
          categoryId: sp.get("category_id"),
          stockStatus: sp.get("stock_status"),
        });
        return new NextResponse(new Uint8Array(res.buffer), {
          status: 200,
          headers: {
            "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Content-Disposition": `attachment; filename="${res.fileName}"`,
            "X-Export-Row-Count": String(res.rowCount),
          },
        });
      }
      if (seg2 === "movements" || seg2 === "transactions") {
        const res = await exportInventoryMovementsXlsx({
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          actorEmail: ctx.email,
          ipAddress: ctx.ipAddress,
          warehouseId: sp.get("warehouse_id"),
          productId: sp.get("product_id"),
          categoryId: sp.get("category_id"),
          movementType: sp.get("movement_type") || sp.get("transaction_type"),
          dateFrom: sp.get("date_from"),
          dateTo: sp.get("date_to"),
        });
        return new NextResponse(new Uint8Array(res.buffer), {
          status: 200,
          headers: {
            "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Content-Disposition": `attachment; filename="${res.fileName}"`,
            "X-Export-Row-Count": String(res.rowCount),
          },
        });
      }
    }

    // GET /api/v1/inventory/stock
    if (method === "GET" && seg1 === "stock") {
      const ctx = await requireOrgContext(req, "inventory.view");
      const stock = await getLiveStockBalances(ctx.organizationId);
      return ok({
        policy: {
          costing_method: ctx.organization.costingMethod,
          negative_stock_policy: ctx.organization.negativeStockPolicy,
        },
        total_valuation: stock.totalValuation,
        balances: stock.balances,
      });
    }

    // GET /api/v1/inventory/movements
    if (method === "GET" && seg1 === "movements") {
      const ctx = await requireOrgContext(req, "inventory.view");
      const q = parseListQuery(req);
      const search = req.nextUrl.searchParams;
      const movementConditions = [eq(stockLedger.organizationId, ctx.organizationId)];
      const warehouseId = search.get("warehouse_id");
      const productId = search.get("product_id");
      const dateFrom = search.get("date_from");
      const dateTo = search.get("date_to");
      const movementType = search.get("movement_type");
      if (warehouseId) movementConditions.push(eq(stockLedger.warehouseId, warehouseId));
      if (productId) movementConditions.push(eq(stockLedger.productId, productId));
      if (dateFrom) movementConditions.push(gte(stockLedger.movementDate, resolveCanonicalDate(dateFrom)));
      if (dateTo) movementConditions.push(lte(stockLedger.movementDate, resolveCanonicalDate(dateTo)));
      if (movementType) movementConditions.push(eq(stockLedger.movementType, movementType.toUpperCase()));
      const rows = await db
        .select({
          id: stockLedger.id,
          stockDocumentId: stockLedger.stockDocumentId,
          documentNumber: stockDocuments.documentNumber,
          documentType: stockDocuments.documentType,
          warehouseId: stockLedger.warehouseId,
          warehouseName: warehouses.name,
          productId: stockLedger.productId,
          variantId: stockLedger.variantId,
          productSku: products.sku,
          productName: products.name,
          variantName: productVariants.variantName,
          variantSku: productVariants.sku,
          movementType: stockLedger.movementType,
          reason: stockLedger.reason,
          quantityDelta: stockLedger.quantityDelta,
          unitCost: stockLedger.unitCost,
          valueDelta: stockLedger.valueDelta,
          balanceAfterQty: stockLedger.balanceAfterQty,
          balanceAfterValue: stockLedger.balanceAfterValue,
          movementDate: stockLedger.movementDate,
          createdAt: stockLedger.createdAt,
        })
        .from(stockLedger)
        .innerJoin(stockDocuments, eq(stockLedger.stockDocumentId, stockDocuments.id))
        .innerJoin(warehouses, eq(stockLedger.warehouseId, warehouses.id))
        .innerJoin(products, eq(stockLedger.productId, products.id))
        .leftJoin(productVariants, eq(stockLedger.variantId, productVariants.id))
        .where(and(...movementConditions))
        .orderBy(desc(stockLedger.createdAt))
        .limit(200);
      const { items, total } = applyListFilterAndPaginate(rows, q, ["documentNumber", "productName", "warehouseName"]);
      return okList(items, { page: q.page, perPage: q.perPage, total });
    }

    // /api/v1/inventory/receipts & /api/v1/inventory/issues
    if (seg1 === "receipts" || seg1 === "issues") {
      const docType = seg1 === "receipts" ? "RECEIPT" : "ISSUE";
      const direction = seg1 === "receipts" ? "IN" : "OUT";

      if (method === "GET" && !seg2) {
        const ctx = await requireOrgContext(req, "inventory.view");
        const q = parseListQuery(req);
        const docs = await db
          .select()
          .from(stockDocuments)
          .where(and(eq(stockDocuments.organizationId, ctx.organizationId), eq(stockDocuments.documentType, docType)))
          .orderBy(desc(stockDocuments.createdAt));
        const { items, total } = applyListFilterAndPaginate(docs, q, ["documentNumber", "reason"]);
        return okList(items, { page: q.page, perPage: q.perPage, total });
      }

      if (method === "POST" && !seg2) {
        const ctx = await requireOrgContext(
          req,
          seg1 === "receipts" ? "inventory.receipts.create" : "inventory.confirm",
          { requireActiveSubscription: true }
        );
        const rawBody = (await req.json()) as Record<string, unknown>;

        // Prompt 08 §2.3: Landed-Cost Incoming Warehouse Receipt (when supplier_id or supplier_invoice_number provided)
        if (seg1 === "receipts" && (rawBody.supplier_id || rawBody.supplier_invoice_number)) {
          const landedBody = z
            .object({
              warehouse_id: z.string().uuid(),
              supplier_id: z.string().uuid(),
              supplier_invoice_number: z.string().min(1, "شماره فاکتور تأمین‌کننده الزامی است."),
              invoice_date: z.string().optional(),
              invoice_date_jalali: z.string().optional(),
              document_date: z.string().optional(),
              shipping_cost: z.string().regex(/^\d+(\.\d{1,2})?$/).default("0.00"),
              customs_and_extra_cost: z.string().regex(/^\d+(\.\d{1,2})?$/).default("0.00"),
              supplier_discount: z.string().regex(/^\d+(\.\d{1,2})?$/).default("0.00"),
              payment_bank_account_id: z.string().uuid().nullable().optional(),
              paid_amount: z.string().regex(/^\d+(\.\d{1,2})?$/).default("0.00"),
              attachment_url: z.string().nullable().optional(),
              description: z.string().optional(),
              items: z
                .array(
                  z.object({
                    product_id: z.string().uuid(),
                    variant_id: z.string().uuid().nullable().optional(),
                    quantity: z.string().regex(/^\d+(\.\d{1,4})?$/),
                    unit_price: z.string().regex(/^\d+(\.\d{1,2})?$/),
                  })
                )
                .min(1),
            })
            .parse(rawBody);

          const idemKey = req.headers.get("idempotency-key");
          const cached = await checkIdempotency({
            organizationId: ctx.organizationId,
            key: idemKey,
            endpoint: "/api/v1/inventory/receipts",
            payload: landedBody,
          });
          if (cached) return ok(cached.responseBody, cached.statusCode, { replayed: true });

          const res = await createLandedWarehouseReceipt({
            organizationId: ctx.organizationId,
            warehouseId: landedBody.warehouse_id,
            supplierId: landedBody.supplier_id,
            supplierInvoiceNumber: landedBody.supplier_invoice_number,
            invoiceDate: landedBody.invoice_date || landedBody.document_date,
            invoiceDateJalali: landedBody.invoice_date_jalali,
            shippingCost: landedBody.shipping_cost,
            customsAndExtraCost: landedBody.customs_and_extra_cost,
            supplierDiscount: landedBody.supplier_discount,
            paymentBankAccountId: landedBody.payment_bank_account_id ?? null,
            paidAmount: landedBody.paid_amount,
            attachmentUrl: landedBody.attachment_url ?? null,
            description: landedBody.description,
            actorUserId: ctx.userId,
            actorEmail: ctx.email,
            ipAddress: ctx.ipAddress,
            items: landedBody.items,
          });

          await saveIdempotency({
            organizationId: ctx.organizationId,
            key: idemKey,
            endpoint: "/api/v1/inventory/receipts",
            payload: landedBody,
            statusCode: 201,
            responseBody: res as unknown as Record<string, unknown>,
          });
          return ok(res, 201);
        }

        const body = stockDocSchema.parse(rawBody);
        const res = await withTenantTransaction(ctx.organizationId, (tx) =>
          postStockDocumentTx(tx, {
            organizationId: ctx.organizationId,
            warehouseId: body.warehouse_id,
            documentType: docType,
            documentDate: resolveCanonicalDate(body.document_date, body.document_date_jalali),
            reason: body.description,
            actorUserId: ctx.userId,
            items: body.items.map((it) => ({
              productId: it.product_id,
              variantId: it.variant_id ?? null,
              direction,
              quantity: it.quantity,
              unitCost: it.unit_cost,
            })),
          })
        );
        return ok(res, 201);
      }

      if (seg2) {
        const ctx = await requireOrgContext(req, "inventory.view");
        const [doc] = await db
          .select()
          .from(stockDocuments)
          .where(and(eq(stockDocuments.id, seg2), eq(stockDocuments.organizationId, ctx.organizationId)))
          .limit(1);
        if (!doc) throw new ApiError(404, "STOCK_DOCUMENT_NOT_FOUND", "سند انبار یافت نشد.");

        if (method === "GET" && !seg3) {
          const items = await db
            .select({
              id: stockDocumentItems.id,
              stockDocumentId: stockDocumentItems.stockDocumentId,
              productId: stockDocumentItems.productId,
              variantId: stockDocumentItems.variantId,
              quantity: stockDocumentItems.quantity,
              unitCost: stockDocumentItems.unitCost,
              lineTotal: stockDocumentItems.totalCost,
              productName: products.name,
              productSku: products.sku,
              variantName: productVariants.variantName,
              variantSku: productVariants.sku,
            })
            .from(stockDocumentItems)
            .innerJoin(products, eq(stockDocumentItems.productId, products.id))
            .leftJoin(productVariants, eq(stockDocumentItems.variantId, productVariants.id))
            .where(eq(stockDocumentItems.stockDocumentId, doc.id));
          return ok({ ...doc, items });
        }
        if (method === "POST" && (seg3 === "confirm" || seg3 === "cancel")) {
          throw new ApiError(
            409,
            "POSTED_STOCK_DOCUMENT_IMMUTABLE",
            seg3 === "cancel"
              ? "سند قطعی انبار را نمی‌توان با تغییر وضعیت لغو کرد؛ برای اصلاح، سند معکوس یا تعدیل رسمی صادر کنید."
              : "سند انبار هنگام ثبت در دفتر گردش قطعی می‌شود و قابل تأیید مجدد نیست."
          );
        }
      }
    }

    // /api/v1/inventory/transfers
    if (seg1 === "transfers") {
      if (method === "GET" && !seg2) {
        const ctx = await requireOrgContext(req, "inventory.view");
        const q = parseListQuery(req);
        const [list, whs, prods, variants] = await Promise.all([
          db
            .select()
            .from(stockTransfers)
            .where(eq(stockTransfers.organizationId, ctx.organizationId))
            .orderBy(desc(stockTransfers.createdAt)),
          db.select().from(warehouses).where(eq(warehouses.organizationId, ctx.organizationId)),
          db.select().from(products).where(eq(products.organizationId, ctx.organizationId)),
          db.select().from(productVariants).where(eq(productVariants.organizationId, ctx.organizationId)),
        ]);
        const whMap = new Map(whs.map((w) => [w.id, w.name]));
        const pMap = new Map(prods.map((p) => [p.id, p.name]));
        const vMap = new Map(variants.map((v) => [v.id, v]));
        const allTrItems = await db
          .select()
          .from(stockTransferItems)
          .where(eq(stockTransferItems.organizationId, ctx.organizationId));
        const enriched = list.map((t) => ({
          ...t,
          destination_warehouse_id: t.targetWarehouseId,
          source_warehouse_name: whMap.get(t.sourceWarehouseId) ?? "",
          destination_warehouse_name: whMap.get(t.targetWarehouseId) ?? "",
          product_name: t.productId ? pMap.get(t.productId) ?? "" : "چند قلم کالا",
          items: allTrItems
            .filter((i) => i.stockTransferId === t.id)
            .map((i) => ({
              ...i,
              product_name: pMap.get(i.productId) ?? "",
              variant_name: i.variantId ? vMap.get(i.variantId)?.variantName ?? "" : "",
              variant_sku: i.variantId ? vMap.get(i.variantId)?.sku ?? "" : "",
            })),
        }));
        const { items, total } = applyListFilterAndPaginate(enriched, q, ["transferNumber", "product_name"]);
        return okList(items, { page: q.page, perPage: q.perPage, total });
      }

      if (method === "POST" && !seg2) {
        const ctx = await requireOrgContext(req, "inventory.transfers.create", { requireActiveSubscription: true });
        const raw = (await req.json()) as Record<string, unknown>;

        // Prompt 08 §2.4: Multi-Item Transfer Lifecycle (DRAFT -> IN_TRANSIT -> PARTIALLY_RECEIVED / DISCREPANCY -> COMPLETED)
        if (Array.isArray(raw.items) && raw.items.length > 0) {
          const multiBody = z
            .object({
              source_warehouse_id: z.string().uuid(),
              destination_warehouse_id: z.string().uuid(),
              transfer_date: z.string().optional(),
              transfer_date_jalali: z.string().optional(),
              reason: z.string().min(2).default("انتقال بین انبارها"),
              source_responsible_name: z.string().min(2).default("مسئول انبار مبدأ"),
              destination_responsible_name: z.string().min(2).default("مسئول انبار مقصد"),
              notes: z.string().optional(),
              dispatch_immediately: z.boolean().default(false),
              items: z
                .array(
                  z.object({
                    product_id: z.string().uuid(),
                    variant_id: z.string().uuid().nullable().optional(),
                    quantity: z.string().regex(/^\d+(\.\d{1,4})?$/),
                  })
                )
                .min(1),
            })
            .parse(raw);

          const res = await createMultiItemTransfer({
            organizationId: ctx.organizationId,
            sourceWarehouseId: multiBody.source_warehouse_id,
            destinationWarehouseId: multiBody.destination_warehouse_id,
            transferDate: multiBody.transfer_date,
            transferDateJalali: multiBody.transfer_date_jalali,
            reason: multiBody.reason,
            sourceResponsibleName: multiBody.source_responsible_name,
            destinationResponsibleName: multiBody.destination_responsible_name,
            notes: multiBody.notes,
            dispatchImmediately: multiBody.dispatch_immediately,
            actorUserId: ctx.userId,
            actorEmail: ctx.email,
            ipAddress: ctx.ipAddress,
            items: multiBody.items,
          });
          return ok(res, 201);
        }

        // Backward-compatible single-item immediate atomic transfer
        const body = transferSchema.parse(raw);
        const targetWh = body.destination_warehouse_id || body.target_warehouse_id;
        if (!targetWh) {
          throw new ApiError(422, "VALIDATION_ERROR", "شناسه انبار مقصد الزامی است.");
        }
        const res = await executeAtomicWarehouseTransfer({
          organizationId: ctx.organizationId,
          sourceWarehouseId: body.source_warehouse_id,
          targetWarehouseId: targetWh,
          productId: body.product_id,
          quantity: body.quantity,
          transferDate: resolveCanonicalDate(body.transfer_date || body.document_date, body.transfer_date_jalali),
          notes: body.notes || body.description,
          actorUserId: ctx.userId,
          actorEmail: ctx.email,
          ipAddress: ctx.ipAddress,
        });
        return ok(res, 201);
      }

      if (seg2) {
        const ctx = await requireOrgContext(req, "inventory.view");
        if (method === "GET" && !seg3) {
          return ok(await listMultiItemTransferWithItems(ctx.organizationId, seg2));
        }
        if (method === "POST" && seg3 === "submit") {
          await requireOrgContext(req, "inventory.transfers.create", { requireActiveSubscription: true });
          return ok(
            await submitMultiItemTransfer({
              organizationId: ctx.organizationId,
              transferId: seg2,
              actorUserId: ctx.userId,
              actorEmail: ctx.email,
              ipAddress: ctx.ipAddress,
            })
          );
        }
        if (method === "POST" && (seg3 === "dispatch" || seg3 === "confirm")) {
          await requireOrgContext(req, "inventory.transfers.create", { requireActiveSubscription: true });
          const idemKey = req.headers.get("idempotency-key");
          const cached = await checkIdempotency({
            organizationId: ctx.organizationId,
            key: idemKey,
            endpoint: `/api/v1/inventory/transfers/${seg2}/dispatch`,
            payload: { transferId: seg2 },
          });
          if (cached) return ok(cached.responseBody, cached.statusCode, { replayed: true });

          const res = await dispatchMultiItemTransfer({
            organizationId: ctx.organizationId,
            transferId: seg2,
            actorUserId: ctx.userId,
            actorEmail: ctx.email,
            ipAddress: ctx.ipAddress,
          });
          await saveIdempotency({
            organizationId: ctx.organizationId,
            key: idemKey,
            endpoint: `/api/v1/inventory/transfers/${seg2}/dispatch`,
            payload: { transferId: seg2 },
            statusCode: 200,
            responseBody: res as unknown as Record<string, unknown>,
          });
          return ok(res);
        }
        if (method === "POST" && seg3 === "receive") {
          await requireOrgContext(req, "inventory.transfers.receive", { requireActiveSubscription: true });
          const recvBody = z
            .object({
              received_date: z.string().optional(),
              received_date_jalali: z.string().optional(),
              notes: z.string().optional(),
              items: z
                .array(
                  z.object({
                    transfer_item_id: z.string().uuid().optional(),
                    product_id: z.string().uuid(),
                    transferred_quantity: z.string().optional(),
                    received_quantity: z.string().optional(),
                    accepted_qty: z.string().regex(/^\d+(\.\d{1,4})?$/).optional(),
                    accepted_quantity: z.string().regex(/^\d+(\.\d{1,4})?$/).optional(),
                    rejected_quantity: z.string().regex(/^\d+(\.\d{1,4})?$/).default("0.0000"),
                    missing_qty: z.string().regex(/^\d+(\.\d{1,4})?$/).default("0.0000"),
                    damaged_qty: z.string().regex(/^\d+(\.\d{1,4})?$/).default("0.0000"),
                    discrepancy_type: z
                      .enum(["MISSING", "DAMAGED", "WRONG_ITEM", "QUALITY_REJECTED", "OTHER"])
                      .optional(),
                    discrepancy_note: z.string().optional(),
                    discrepancy_description: z.string().optional(),
                    evidence_url: z.string().optional(),
                    evidence_attachment_ids: z.array(z.string().uuid()).optional(),
                  })
                )
                .min(1),
            })
            .parse(await req.json());

          const idemKey = req.headers.get("idempotency-key");
          const cached = await checkIdempotency({
            organizationId: ctx.organizationId,
            key: idemKey,
            endpoint: `/api/v1/inventory/transfers/${seg2}/receive`,
            payload: recvBody,
          });
          if (cached) return ok(cached.responseBody, cached.statusCode, { replayed: true });

          const res = await receiveMultiItemTransfer({
            organizationId: ctx.organizationId,
            transferId: seg2,
            receivedDate: recvBody.received_date,
            receivedDateJalali: recvBody.received_date_jalali,
            notes: recvBody.notes,
            actorUserId: ctx.userId,
            actorEmail: ctx.email,
            ipAddress: ctx.ipAddress,
            items: recvBody.items,
          });
          await saveIdempotency({
            organizationId: ctx.organizationId,
            key: idemKey,
            endpoint: `/api/v1/inventory/transfers/${seg2}/receive`,
            payload: recvBody,
            statusCode: 200,
            responseBody: res as unknown as Record<string, unknown>,
          });
          return ok(res);
        }
        if (method === "POST" && seg3 === "complete") {
          await requireOrgContext(req, "inventory.transfers.receive", { requireActiveSubscription: true });
          return ok(
            await completeWarehouseTransfer({
              organizationId: ctx.organizationId,
              transferId: seg2,
              actorUserId: ctx.userId,
              actorEmail: ctx.email,
              ipAddress: ctx.ipAddress,
            })
          );
        }
        if (method === "POST" && seg3 === "cancel") {
          await requireOrgContext(req, "inventory.transfers.create", { requireActiveSubscription: true });
          const [upd] = await db
            .update(stockTransfers)
            .set({ status: "CANCELLED" })
            .where(and(eq(stockTransfers.id, seg2), eq(stockTransfers.organizationId, ctx.organizationId)))
            .returning();
          return ok(upd);
        }
      }
    }

    // /api/v1/inventory/counts
    if (seg1 === "counts") {
      if (method === "GET" && !seg2) {
        const ctx = await requireOrgContext(req, "inventory.view");
        const q = parseListQuery(req);
        const [counts, items, whs, prods] = await Promise.all([
          db
            .select()
            .from(stockCounts)
            .where(eq(stockCounts.organizationId, ctx.organizationId))
            .orderBy(desc(stockCounts.createdAt)),
          db.select().from(stockCountItems).where(eq(stockCountItems.organizationId, ctx.organizationId)),
          db.select().from(warehouses).where(eq(warehouses.organizationId, ctx.organizationId)),
          db.select().from(products).where(eq(products.organizationId, ctx.organizationId)),
        ]);
        const whMap = new Map(whs.map((w) => [w.id, w.name]));
        const pMap = new Map(prods.map((p) => [p.id, p.name]));
        const enriched = counts.map((c) => ({
          ...c,
          warehouse_name: whMap.get(c.warehouseId) ?? "",
          items: items
            .filter((i) => i.stockCountId === c.id)
            .map((i) => ({ ...i, product_name: pMap.get(i.productId) ?? "" })),
        }));
        const { items: pageItems, total } = applyListFilterAndPaginate(enriched, q, ["countNumber", "warehouse_name"]);
        return okList(pageItems, { page: q.page, perPage: q.perPage, total });
      }

      if (method === "POST" && !seg2) {
        const ctx = await requireOrgContext(req, "inventory.count.confirm", { requireActiveSubscription: true });
        const body = countSchema.parse(await req.json());
        const res = await approveStockCount({
          organizationId: ctx.organizationId,
          warehouseId: body.warehouse_id,
          countDate: resolveCanonicalDate(body.count_date || body.document_date, body.count_date_jalali),
          notes: body.notes,
          items: body.items.map((i) => ({
            productId: i.product_id,
            countedQty: i.counted_qty ?? i.quantity ?? "0.0000",
          })),
          actorUserId: ctx.userId,
          actorEmail: ctx.email,
          ipAddress: ctx.ipAddress,
        });
        return ok(res, 201);
      }

      if (seg2) {
        const ctx = await requireOrgContext(req, "inventory.view");
        const [cnt] = await db
          .select()
          .from(stockCounts)
          .where(and(eq(stockCounts.id, seg2), eq(stockCounts.organizationId, ctx.organizationId)))
          .limit(1);
        if (!cnt) throw new ApiError(404, "STOCK_COUNT_NOT_FOUND", "سند انبارگردانی یافت نشد.");
        if (method === "GET" && !seg3) {
          const items = await db.select().from(stockCountItems).where(eq(stockCountItems.stockCountId, cnt.id));
          return ok({ ...cnt, items });
        }
        if (method === "POST" && (seg3 === "submit" || seg3 === "confirm")) {
          const [upd] = await db
            .update(stockCounts)
            .set({ status: "CONFIRMED" })
            .where(eq(stockCounts.id, cnt.id))
            .returning();
          return ok(upd);
        }
      }
    }
  }

  throw new ApiError(404, "ROUTE_NOT_FOUND", "مسیر انبارداری یافت نشد.");
}

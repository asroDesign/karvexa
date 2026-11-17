import { NextRequest } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  consignmentDocuments,
  consignmentItems,
  consignorSettlements,
  contacts,
  financialAccounts,
  financialTransactions,
  products,
  purchaseInvoiceItems,
  purchaseInvoices,
  purchaseReturns,
  salesInvoiceItems,
  salesInvoices,
  salesReturns,
  warehouses,
} from "@/db/schema";
import { ensureSeeded } from "@/db/seed";
import { addDec, formatDecimal, mulDec, subDec } from "@/lib/decimal";
import {
  ApiError,
  applyListFilterAndPaginate,
  ok,
  okList,
  parseListQuery,
} from "@/lib/errors";
import { checkIdempotency, saveIdempotency } from "@/lib/idempotency";
import { requireOrgContext, withTenantTransaction } from "@/lib/tenant";
import {
  finalizePurchaseInvoice,
  finalizeSalesInvoice,
  recordSubsequentInvoicePayment,
} from "@/modules/commerce/service";
import {
  cancelPurchaseInvoice,
  cancelSalesInvoice,
  returnPurchaseInvoice,
  returnSalesInvoice,
} from "@/modules/commerce/lifecycle.service";
import {
  confirmConsignmentDocument,
  createConsignmentDocument,
  getConsignmentBalancesReport,
} from "@/modules/consignment/service";
import { accountingPolicies, accounts, contactTransactions, invoicePaymentAllocations } from "@/db/schema";
import { gtDec, parseDecimal } from "@/lib/decimal";
import { createJournalEntryTx } from "@/modules/accounting/service";

const cancelDocSchema = z.object({
  reason: z.string().min(2, "ذکر دلیل لغو سند (حداقل ۲ کاراکتر) الزامی است."),
});

const invoiceReturnSchema = z.object({
  notes: z.string().optional(),
  return_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  total_amount: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  reason: z.string().optional(),
  items: z
    .array(
      z.object({
        original_item_id: z.string().uuid(),
        product_id: z.string().uuid(),
        product_variant_id: z.string().uuid().nullable().optional(),
        quantity: z.string().regex(/^\d+(\.\d{1,4})?$/),
        accepted_quantity: z.string().regex(/^\d+(\.\d{1,4})?$/).optional(),
        damaged_quantity: z.string().regex(/^\d+(\.\d{1,4})?$/).optional(),
        physically_received: z.boolean().optional(),
        warehouse_id: z.string().uuid(),
        unit_price: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
        reason: z.string().optional(),
      })
    )
    .optional(),
});

const invoiceCreateSchema = z.object({
  client_document_id: z.string().uuid().optional(),
  supplier_id: z.string().uuid().optional(),
  customer_id: z.string().uuid().optional(),
  contact_id: z.string().uuid().optional(),
  warehouse_id: z.string().uuid(),
  document_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  invoice_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  currency: z.string().default("IRR"),
  exchange_rate: z.string().regex(/^\d+(\.\d{1,4})?$/).default("1.0000"),
  discount_total: z.string().regex(/^\d+(\.\d{1,2})?$/).default("0.00"),
  tax_total: z.string().regex(/^\d+(\.\d{1,2})?$/).default("0.00"),
  shipping_cost: z.string().regex(/^\d+(\.\d{1,2})?$/).default("0.00"),
  other_costs: z.string().regex(/^\d+(\.\d{1,2})?$/).default("0.00"),
  related_document_id: z.string().uuid().nullable().optional(),
  related_document_type: z.string().max(40).nullable().optional(),
  receipt_url: z.string().nullable().optional(),
  notes: z.string().optional(),
  items: z
    .array(
      z.object({
        product_id: z.string().uuid(),
        variant_id: z.string().uuid().nullable().optional(),
        quantity: z.string().regex(/^\d+(\.\d{1,4})?$/),
        unit_price: z.string().regex(/^\d+(\.\d{1,2})?$/),
        discount_amount: z.string().regex(/^\d+(\.\d{1,2})?$/).default("0.00"),
        tax_rate: z.string().regex(/^\d+(\.\d{1,2})?$/).default("0.00"),
        description: z.string().optional(),
      })
    )
    .min(1),
});

export async function handleCommerceRoutes(
  req: NextRequest,
  method: string,
  segments: string[]
) {
  await ensureSeeded();
  const root = segments[0]; // purchases | purchase-returns | sales | sales-returns | consignments
  const id = segments[1];
  const sub = segments[2];

  // ============================================================================
  // PURCHASES & PURCHASE RETURNS (/api/v1/purchases, /api/v1/purchase-returns)
  // ============================================================================
  if (root === "purchase-returns") {
    const ctx = await requireOrgContext(req, "purchases.view");
    if (method === "GET" && !id) {
      const q = parseListQuery(req);
      const list = await db
        .select()
        .from(purchaseReturns)
        .where(eq(purchaseReturns.organizationId, ctx.organizationId))
        .orderBy(desc(purchaseReturns.createdAt));
      const { items, total } = applyListFilterAndPaginate(list, q, ["returnNumber"]);
      return okList(items, { page: q.page, perPage: q.perPage, total });
    }
    if (method === "GET" && id) {
      const [ret] = await db
        .select()
        .from(purchaseReturns)
        .where(and(eq(purchaseReturns.id, id), eq(purchaseReturns.organizationId, ctx.organizationId)))
        .limit(1);
      if (!ret) throw new ApiError(404, "PURCHASE_RETURN_NOT_FOUND", "برگشت از خرید یافت نشد.");
      return ok(ret);
    }
  }

  if (root === "purchases") {
    if (method === "GET" && !id) {
      const ctx = await requireOrgContext(req, "purchases.view");
      const q = parseListQuery(req);
      const [invs, items, allContacts, allWhs, allProds] = await Promise.all([
        db
          .select()
          .from(purchaseInvoices)
          .where(eq(purchaseInvoices.organizationId, ctx.organizationId))
          .orderBy(desc(purchaseInvoices.createdAt)),
        db.select().from(purchaseInvoiceItems).where(eq(purchaseInvoiceItems.organizationId, ctx.organizationId)),
        db.select().from(contacts).where(eq(contacts.organizationId, ctx.organizationId)),
        db.select().from(warehouses).where(eq(warehouses.organizationId, ctx.organizationId)),
        db.select().from(products).where(eq(products.organizationId, ctx.organizationId)),
      ]);
      const cMap = new Map(allContacts.map((c) => [c.id, c.name]));
      const wMap = new Map(allWhs.map((w) => [w.id, w.name]));
      const pMap = new Map(allProds.map((p) => [p.id, p.name]));

      const enriched = invs.map((inv) => ({
        id: inv.id,
        organization_id: inv.organizationId,
        client_document_id: inv.clientDocumentId,
        supplier_id: inv.contactId,
        supplier_name: cMap.get(inv.contactId) ?? "",
        warehouse_id: inv.warehouseId,
        warehouse_name: wMap.get(inv.warehouseId) ?? "",
        document_number: inv.invoiceNumber,
        document_date: inv.invoiceDate,
        due_date: inv.dueDate,
        currency: inv.currency,
        exchange_rate: inv.exchangeRate,
        subtotal: inv.subtotal,
        discount_total: inv.discountAmount,
        tax_total: inv.taxAmount,
        shipping_cost: inv.shippingCost,
        other_costs: inv.otherCosts,
        grand_total: inv.totalAmount,
        paid_amount: inv.paidAmount,
        remaining_amount: inv.remainingAmount === "0.00" && inv.paidAmount === "0.00" ? inv.totalAmount : inv.remainingAmount,
        status: inv.status === "FINALIZED" ? "CONFIRMED" : inv.status,
        notes: inv.notes,
        journal_entry_id: inv.journalEntryId,
        stock_document_id: inv.stockDocumentId,
        items: items
          .filter((i) => i.purchaseInvoiceId === inv.id)
          .map((i) => ({ ...i, product_name: pMap.get(i.productId) ?? "" })),
        created_at: inv.createdAt,
      }));
      const { items: pageItems, total } = applyListFilterAndPaginate(enriched, q, ["document_number", "supplier_name"]);
      return okList(pageItems, { page: q.page, perPage: q.perPage, total });
    }

    if (method === "POST" && !id) {
      const ctx = await requireOrgContext(req, "purchases.create", { requireActiveSubscription: true });
      const body = invoiceCreateSchema.parse(await req.json());
      const idemKey = req.headers.get("idempotency-key");
      const cached = await checkIdempotency({
        organizationId: ctx.organizationId,
        key: idemKey,
        endpoint: "/api/v1/purchases",
        payload: body,
      });
      if (cached) return ok(cached.responseBody, cached.statusCode, { replayed: true });

      const supplierId = body.supplier_id || body.contact_id;
      if (!supplierId) throw new ApiError(422, "VALIDATION_ERROR", "شناسه تأمین‌کننده (supplier_id) الزامی است.");

      let subtotal = BigInt(0);
      const lineItems = body.items.map((it) => {
        const lt = mulDec(it.quantity, it.unit_price);
        subtotal = addDec(subtotal, lt);
        return { ...it, line_total: formatDecimal(lt, 2) };
      });
      const grandTotal = addDec(
        subDec(addDec(subtotal, body.tax_total), body.discount_total),
        addDec(body.shipping_cost, body.other_costs)
      );
      const [policy] = await db
        .select()
        .from(accountingPolicies)
        .where(eq(accountingPolicies.organizationId, ctx.organizationId))
        .limit(1);
      const docNum = `PI-${Date.now().toString().slice(-6)}`;

      const created = await withTenantTransaction(ctx.organizationId, async (tx) => {
        const [inv] = await tx
          .insert(purchaseInvoices)
          .values({
            organizationId: ctx.organizationId,
            clientDocumentId: body.client_document_id ?? null,
            contactId: supplierId,
            warehouseId: body.warehouse_id,
            invoiceNumber: docNum,
            invoiceDate: body.document_date || body.invoice_date || new Date().toISOString().slice(0, 10),
            dueDate: body.due_date ?? null,
            currency: body.currency,
            exchangeRate: body.exchange_rate,
            subtotal: formatDecimal(subtotal, 2),
            discountAmount: body.discount_total,
            taxAmount: body.tax_total,
            shippingCost: body.shipping_cost,
            otherCosts: body.other_costs,
            totalAmount: formatDecimal(grandTotal, 2),
            remainingAmount: formatDecimal(grandTotal, 2),
            status: "DRAFT",
            relatedDocumentId: body.related_document_id ?? null,
            relatedDocumentType: body.related_document_type ?? null,
            receiptUrl: body.receipt_url ?? null,
            taxRateSnapshot: policy?.defaultTaxRate ?? "10.00",
            isTaxInclusiveSnapshot: policy?.isTaxInclusive ?? false,
            notes: body.notes ?? null,
            createdBy: ctx.userId,
            syncSeq: Date.now(),
          })
          .returning();

        const savedItems = await tx
          .insert(purchaseInvoiceItems)
          .values(
            lineItems.map((li) => ({
              organizationId: ctx.organizationId,
              purchaseInvoiceId: inv.id,
              productId: li.product_id,
              quantity: li.quantity,
              unitPrice: li.unit_price,
              lineTotal: li.line_total,
            }))
          )
          .returning();

        return {
          ...inv,
          supplier_id: inv.contactId,
          document_number: inv.invoiceNumber,
          document_date: inv.invoiceDate,
          grand_total: inv.totalAmount,
          items: savedItems,
        };
      });

      await saveIdempotency({
        organizationId: ctx.organizationId,
        key: idemKey,
        endpoint: "/api/v1/purchases",
        payload: body,
        statusCode: 201,
        responseBody: created as unknown as Record<string, unknown>,
      });

      return ok(created, 201);
    }

    if (id) {
      const ctx = await requireOrgContext(req, "purchases.view");
      const [inv] = await db
        .select()
        .from(purchaseInvoices)
        .where(and(eq(purchaseInvoices.id, id), eq(purchaseInvoices.organizationId, ctx.organizationId)))
        .limit(1);
      if (!inv) throw new ApiError(404, "PURCHASE_NOT_FOUND", "فاکتور خرید یافت نشد.");

      if (method === "GET" && !sub) {
        const items = await db.select().from(purchaseInvoiceItems).where(eq(purchaseInvoiceItems.purchaseInvoiceId, inv.id));
        return ok({ ...inv, supplier_id: inv.contactId, document_number: inv.invoiceNumber, grand_total: inv.totalAmount, items });
      }
      if (method === "PATCH" && !sub) {
        await requireOrgContext(req, "purchases.create", { requireActiveSubscription: true });
        if (inv.status !== "DRAFT") {
          throw new ApiError(409, "DOCUMENT_IMMUTABLE", "فاکتور خرید تاییدشده قابل ویرایش مستقیم نیست.");
        }
        const body = (await req.json()) as { notes?: string; due_date?: string };
        const [upd] = await db
          .update(purchaseInvoices)
          .set({ ...(body.notes !== undefined ? { notes: body.notes } : {}), ...(body.due_date ? { dueDate: body.due_date } : {}), updatedAt: new Date() })
          .where(eq(purchaseInvoices.id, inv.id))
          .returning();
        return ok(upd);
      }
      if (method === "POST" && sub === "confirm") {
        await requireOrgContext(req, "purchases.confirm", { requireActiveSubscription: true });
        const result = await finalizePurchaseInvoice({
          organizationId: ctx.organizationId,
          invoiceId: inv.id,
          actorUserId: ctx.userId,
          actorEmail: ctx.email,
          ipAddress: ctx.ipAddress,
        });
        return ok({
          ...result,
          invoice: { ...result.invoice, status: "CONFIRMED", document_number: result.invoice.invoiceNumber, grand_total: result.invoice.totalAmount },
        });
      }
      if (method === "POST" && sub === "cancel") {
        await requireOrgContext(req, "purchases.cancel", { requireActiveSubscription: true });
        const body = cancelDocSchema.parse(await req.json());
        const idemKey = req.headers.get("idempotency-key");
        const cached = await checkIdempotency({
          organizationId: ctx.organizationId,
          key: idemKey,
          endpoint: `/api/v1/purchases/${inv.id}/cancel`,
          payload: body,
        });
        if (cached) return ok(cached.responseBody, cached.statusCode, { replayed: true });

        const res = await cancelPurchaseInvoice({
          organizationId: ctx.organizationId,
          invoiceId: inv.id,
          reason: body.reason,
          actorUserId: ctx.userId,
          actorEmail: ctx.email,
          ipAddress: ctx.ipAddress,
        });
        await saveIdempotency({
          organizationId: ctx.organizationId,
          key: idemKey,
          endpoint: `/api/v1/purchases/${inv.id}/cancel`,
          payload: body,
          statusCode: 200,
          responseBody: res as unknown as Record<string, unknown>,
        });
        return ok(res);
      }
      if (method === "POST" && (sub === "return" || sub === "returns")) {
        await requireOrgContext(req, "purchases.return", { requireActiveSubscription: true });
        const body = invoiceReturnSchema.parse(await req.json());
        const idemKey = req.headers.get("idempotency-key");
        const cached = await checkIdempotency({
          organizationId: ctx.organizationId,
          key: idemKey,
          endpoint: `/api/v1/purchases/${inv.id}/return`,
          payload: body,
        });
        if (cached) return ok(cached.responseBody, cached.statusCode, { replayed: true });

        if (body.items && body.items.length > 0) {
          const res = await returnPurchaseInvoice({
            organizationId: ctx.organizationId,
            invoiceId: inv.id,
            notes: body.notes ?? body.reason,
            returnDate: body.return_date,
            items: body.items,
            idempotencyKey: idemKey,
            actorUserId: ctx.userId,
            actorEmail: ctx.email,
            ipAddress: ctx.ipAddress,
          });
          await saveIdempotency({
            organizationId: ctx.organizationId,
            key: idemKey,
            endpoint: `/api/v1/purchases/${inv.id}/return`,
            payload: body,
            statusCode: 201,
            responseBody: res as unknown as Record<string, unknown>,
          });
          return ok(res, 201);
        }

        // Legacy total_amount fallback (strictly validated <= invoice total)
        const retAmount = body.total_amount ?? inv.totalAmount;
        if (gtDec(parseDecimal(retAmount), parseDecimal(inv.totalAmount))) {
          throw new ApiError(422, "RETURN_EXCEEDS_INVOICE", "مبلغ برگشت از خرید نمی‌تواند بیشتر از مبلغ کل فاکتور باشد.");
        }
        const retDate = body.return_date || new Date().toISOString().slice(0, 10);
        const createdRet = await withTenantTransaction(ctx.organizationId, async (tx) => {
          const [ret] = await tx
            .insert(purchaseReturns)
            .values({
              organizationId: ctx.organizationId,
              purchaseInvoiceId: inv.id,
              returnNumber: `PR-${Date.now().toString().slice(-6)}`,
              returnDate: retDate,
              totalAmount: retAmount,
              reason: body.reason ?? body.notes ?? "برگشت از خرید",
            })
            .returning();
          await tx.insert(contactTransactions).values({
            organizationId: ctx.organizationId,
            contactId: inv.contactId,
            referenceType: "PURCHASE_RETURN",
            referenceId: ret.id,
            txDate: retDate,
            debit: retAmount,
            credit: "0.00",
            description: `برگشت از خرید ${ret.returnNumber}`,
          });
          const orgAccs = await tx.select().from(accounts).where(eq(accounts.organizationId, ctx.organizationId));
          const apAcc = orgAccs.find((a) => a.systemRole === "AP");
          const invAcc = orgAccs.find((a) => a.systemRole === "INVENTORY");
          if (apAcc && invAcc) {
            await createJournalEntryTx(tx, {
              organizationId: ctx.organizationId,
              actorUserId: ctx.userId,
              actorEmail: ctx.email,
              entryDate: retDate,
              description: `سند برگشت از خرید ${ret.returnNumber}`,
              referenceType: "PURCHASE_RETURN",
              referenceId: ret.id,
              postImmediately: true,
              lines: [
                { accountId: apAcc.id, contactId: inv.contactId, debit: retAmount, credit: "0.00" },
                { accountId: invAcc.id, debit: "0.00", credit: retAmount },
              ],
            });
          }
          return ret;
        });
        return ok(createdRet, 201);
      }
    }
  }

  // ============================================================================
  // SALES & SALES RETURNS (/api/v1/sales, /api/v1/sales-returns)
  // ============================================================================
  if (root === "sales-returns") {
    const ctx = await requireOrgContext(req, "sales.view");
    if (method === "GET" && !id) {
      const q = parseListQuery(req);
      const list = await db
        .select()
        .from(salesReturns)
        .where(eq(salesReturns.organizationId, ctx.organizationId))
        .orderBy(desc(salesReturns.createdAt));
      const { items, total } = applyListFilterAndPaginate(list, q, ["returnNumber"]);
      return okList(items, { page: q.page, perPage: q.perPage, total });
    }
    if (method === "GET" && id) {
      const [ret] = await db
        .select()
        .from(salesReturns)
        .where(and(eq(salesReturns.id, id), eq(salesReturns.organizationId, ctx.organizationId)))
        .limit(1);
      if (!ret) throw new ApiError(404, "SALES_RETURN_NOT_FOUND", "برگشت از فروش یافت نشد.");
      return ok(ret);
    }
  }

  if (root === "sales") {
    if (method === "GET" && !id) {
      const ctx = await requireOrgContext(req, "sales.view");
      const q = parseListQuery(req);
      const [invs, items, allContacts, allWhs, allProds] = await Promise.all([
        db
          .select()
          .from(salesInvoices)
          .where(eq(salesInvoices.organizationId, ctx.organizationId))
          .orderBy(desc(salesInvoices.createdAt)),
        db.select().from(salesInvoiceItems).where(eq(salesInvoiceItems.organizationId, ctx.organizationId)),
        db.select().from(contacts).where(eq(contacts.organizationId, ctx.organizationId)),
        db.select().from(warehouses).where(eq(warehouses.organizationId, ctx.organizationId)),
        db.select().from(products).where(eq(products.organizationId, ctx.organizationId)),
      ]);
      const cMap = new Map(allContacts.map((c) => [c.id, c.name]));
      const wMap = new Map(allWhs.map((w) => [w.id, w.name]));
      const pMap = new Map(allProds.map((p) => [p.id, p.name]));

      const enriched = invs.map((inv) => ({
        id: inv.id,
        organization_id: inv.organizationId,
        client_document_id: inv.clientDocumentId,
        customer_id: inv.contactId,
        customer_name: cMap.get(inv.contactId) ?? "",
        warehouse_id: inv.warehouseId,
        warehouse_name: wMap.get(inv.warehouseId) ?? "",
        document_number: inv.invoiceNumber,
        document_date: inv.invoiceDate,
        due_date: inv.dueDate,
        currency: inv.currency,
        exchange_rate: inv.exchangeRate,
        subtotal: inv.subtotal,
        discount_total: inv.discountAmount,
        tax_total: inv.taxAmount,
        shipping_cost: inv.shippingCost,
        other_costs: inv.otherCosts,
        grand_total: inv.totalAmount,
        paid_amount: inv.paidAmount,
        remaining_amount: inv.remainingAmount === "0.00" && inv.paidAmount === "0.00" ? inv.totalAmount : inv.remainingAmount,
        status: inv.status === "FINALIZED" ? "CONFIRMED" : inv.status,
        notes: inv.notes,
        journal_entry_id: inv.journalEntryId,
        stock_document_id: inv.stockDocumentId,
        items: items
          .filter((i) => i.salesInvoiceId === inv.id)
          .map((i) => ({ ...i, product_name: pMap.get(i.productId) ?? "" })),
        created_at: inv.createdAt,
      }));
      const { items: pageItems, total } = applyListFilterAndPaginate(enriched, q, ["document_number", "customer_name"]);
      return okList(pageItems, { page: q.page, perPage: q.perPage, total });
    }

    if (method === "POST" && !id) {
      const ctx = await requireOrgContext(req, "sales.create", { requireActiveSubscription: true });
      const body = invoiceCreateSchema.parse(await req.json());
      const idemKey = req.headers.get("idempotency-key");
      const cached = await checkIdempotency({
        organizationId: ctx.organizationId,
        key: idemKey,
        endpoint: "/api/v1/sales",
        payload: body,
      });
      if (cached) return ok(cached.responseBody, cached.statusCode, { replayed: true });

      const customerId = body.customer_id || body.contact_id;
      if (!customerId) throw new ApiError(422, "VALIDATION_ERROR", "شناسه مشتری (customer_id) الزامی است.");

      let subtotal = BigInt(0);
      const lineItems = body.items.map((it) => {
        const lt = mulDec(it.quantity, it.unit_price);
        subtotal = addDec(subtotal, lt);
        return { ...it, line_total: formatDecimal(lt, 2) };
      });
      const grandTotal = addDec(
        subDec(addDec(subtotal, body.tax_total), body.discount_total),
        addDec(body.shipping_cost, body.other_costs)
      );
      const [policy] = await db
        .select()
        .from(accountingPolicies)
        .where(eq(accountingPolicies.organizationId, ctx.organizationId))
        .limit(1);
      const prefix = policy?.invoicePrefix || "SI-";
      const docNum = `${prefix}${Date.now().toString().slice(-6)}`;

      const created = await withTenantTransaction(ctx.organizationId, async (tx) => {
        const [inv] = await tx
          .insert(salesInvoices)
          .values({
            organizationId: ctx.organizationId,
            clientDocumentId: body.client_document_id ?? null,
            contactId: customerId,
            warehouseId: body.warehouse_id,
            invoiceNumber: docNum,
            invoiceDate: body.document_date || body.invoice_date || new Date().toISOString().slice(0, 10),
            dueDate: body.due_date ?? null,
            currency: body.currency,
            exchangeRate: body.exchange_rate,
            subtotal: formatDecimal(subtotal, 2),
            discountAmount: body.discount_total,
            taxAmount: body.tax_total,
            shippingCost: body.shipping_cost,
            otherCosts: body.other_costs,
            totalAmount: formatDecimal(grandTotal, 2),
            remainingAmount: formatDecimal(grandTotal, 2),
            status: "DRAFT",
            relatedDocumentId: body.related_document_id ?? null,
            relatedDocumentType: body.related_document_type ?? null,
            receiptUrl: body.receipt_url ?? null,
            taxRateSnapshot: policy?.defaultTaxRate ?? "10.00",
            isTaxInclusiveSnapshot: policy?.isTaxInclusive ?? false,
            notes: body.notes ?? null,
            createdBy: ctx.userId,
            syncSeq: Date.now(),
          })
          .returning();

        const savedItems = await tx
          .insert(salesInvoiceItems)
          .values(
            lineItems.map((li) => ({
              organizationId: ctx.organizationId,
              salesInvoiceId: inv.id,
              productId: li.product_id,
              variantId: li.variant_id ?? null,
              quantity: li.quantity,
              unitPrice: li.unit_price,
              discountAmount: li.discount_amount ?? "0.00",
              taxRate: li.tax_rate ?? "0.00",
              lineTotal: li.line_total,
              description: li.description ?? null,
            }))
          )
          .returning();

        return {
          ...inv,
          customer_id: inv.contactId,
          document_number: inv.invoiceNumber,
          document_date: inv.invoiceDate,
          grand_total: inv.totalAmount,
          items: savedItems,
        };
      });

      await saveIdempotency({
        organizationId: ctx.organizationId,
        key: idemKey,
        endpoint: "/api/v1/sales",
        payload: body,
        statusCode: 201,
        responseBody: created as unknown as Record<string, unknown>,
      });

      return ok(created, 201);
    }

    if (id) {
      const ctx = await requireOrgContext(req, "sales.view");
      const [inv] = await db
        .select()
        .from(salesInvoices)
        .where(and(eq(salesInvoices.id, id), eq(salesInvoices.organizationId, ctx.organizationId)))
        .limit(1);
      if (!inv) throw new ApiError(404, "SALES_INVOICE_NOT_FOUND", "فاکتور فروش یافت نشد.");

      if (method === "GET" && !sub) {
        const items = await db.select().from(salesInvoiceItems).where(eq(salesInvoiceItems.salesInvoiceId, inv.id));
        return ok({ ...inv, customer_id: inv.contactId, document_number: inv.invoiceNumber, grand_total: inv.totalAmount, items });
      }
      if (method === "PATCH" && !sub) {
        await requireOrgContext(req, "sales.update", { requireActiveSubscription: true });
        if (inv.status !== "DRAFT") {
          throw new ApiError(409, "DOCUMENT_IMMUTABLE", "فاکتور فروش تاییدشده قابل ویرایش مستقیم نیست.");
        }
        const body = (await req.json()) as { notes?: string; due_date?: string };
        const [upd] = await db
          .update(salesInvoices)
          .set({ ...(body.notes !== undefined ? { notes: body.notes } : {}), ...(body.due_date ? { dueDate: body.due_date } : {}), updatedAt: new Date() })
          .where(eq(salesInvoices.id, inv.id))
          .returning();
        return ok(upd);
      }
      if (method === "POST" && sub === "confirm") {
        await requireOrgContext(req, "sales.confirm", { requireActiveSubscription: true });
        const confirmBody = z
          .object({
            payment_allocations: z
              .array(
                z.object({
                  financial_account_id: z.string().uuid().nullable().optional(),
                  payment_method: z.enum([
                    "CASH",
                    "BANK",
                    "BANK_TRANSFER",
                    "CARD_TERMINAL",
                    "POS",
                    "WALLET",
                    "CHEQUE",
                    "CREDIT",
                    "ACCOUNT_BALANCE",
                    "OTHER",
                  ]),
                  amount: z.string().regex(/^\d+(\.\d{1,2})?$/),
                  reference_number: z.string().nullable().optional(),
                  cheque: z
                    .object({
                      cheque_number: z.string().min(2),
                      serial_number: z.string().optional(),
                      bank_name: z.string().min(2),
                      branch_name: z.string().optional(),
                      drawer_name: z.string().optional(),
                      issue_date: z.string().optional(),
                      issue_date_jalali: z.string().optional(),
                      due_date: z.string().optional(),
                      due_date_jalali: z.string().optional(),
                      notes: z.string().optional(),
                    })
                    .nullable()
                    .optional(),
                })
              )
              .optional(),
          })
          .parse(await req.json().catch(() => ({})));

        const result = await finalizeSalesInvoice({
          organizationId: ctx.organizationId,
          invoiceId: inv.id,
          actorUserId: ctx.userId,
          actorEmail: ctx.email,
          ipAddress: ctx.ipAddress,
          paymentAllocations: (confirmBody.payment_allocations ?? []).map((p) => ({
            financialAccountId: p.financial_account_id ?? null,
            paymentMethod: p.payment_method,
            amount: p.amount,
            referenceNumber: p.reference_number ?? null,
            cheque: p.cheque
              ? {
                  chequeNumber: p.cheque.cheque_number,
                  serialNumber: p.cheque.serial_number,
                  bankName: p.cheque.bank_name,
                  branchName: p.cheque.branch_name,
                  drawerName: p.cheque.drawer_name,
                  issueDate: p.cheque.issue_date,
                  issueDateJalali: p.cheque.issue_date_jalali,
                  dueDate: p.cheque.due_date,
                  dueDateJalali: p.cheque.due_date_jalali,
                  notes: p.cheque.notes,
                }
              : null,
          })),
        });
        return ok({
          ...result,
          invoice: {
            ...result.invoice,
            status: "CONFIRMED",
            document_number: result.invoice.invoiceNumber,
            grand_total: result.invoice.totalAmount,
          },
        });
      }
      if (method === "POST" && sub === "cancel") {
        await requireOrgContext(req, "sales.cancel", { requireActiveSubscription: true });
        const body = cancelDocSchema.parse(await req.json());
        const idemKey = req.headers.get("idempotency-key");
        const cached = await checkIdempotency({
          organizationId: ctx.organizationId,
          key: idemKey,
          endpoint: `/api/v1/sales/${inv.id}/cancel`,
          payload: body,
        });
        if (cached) return ok(cached.responseBody, cached.statusCode, { replayed: true });

        const res = await cancelSalesInvoice({
          organizationId: ctx.organizationId,
          invoiceId: inv.id,
          reason: body.reason,
          actorUserId: ctx.userId,
          actorEmail: ctx.email,
          ipAddress: ctx.ipAddress,
        });
        await saveIdempotency({
          organizationId: ctx.organizationId,
          key: idemKey,
          endpoint: `/api/v1/sales/${inv.id}/cancel`,
          payload: body,
          statusCode: 200,
          responseBody: res as unknown as Record<string, unknown>,
        });
        return ok(res);
      }
      if (method === "POST" && (sub === "return" || sub === "returns")) {
        await requireOrgContext(req, "sales.return", { requireActiveSubscription: true });
        const body = invoiceReturnSchema.parse(await req.json());
        const idemKey = req.headers.get("idempotency-key");
        const cached = await checkIdempotency({
          organizationId: ctx.organizationId,
          key: idemKey,
          endpoint: `/api/v1/sales/${inv.id}/return`,
          payload: body,
        });
        if (cached) return ok(cached.responseBody, cached.statusCode, { replayed: true });

        if (body.items && body.items.length > 0) {
          const res = await returnSalesInvoice({
            organizationId: ctx.organizationId,
            invoiceId: inv.id,
            notes: body.notes ?? body.reason,
            returnDate: body.return_date,
            items: body.items,
            idempotencyKey: idemKey,
            actorUserId: ctx.userId,
            actorEmail: ctx.email,
            ipAddress: ctx.ipAddress,
          });
          await saveIdempotency({
            organizationId: ctx.organizationId,
            key: idemKey,
            endpoint: `/api/v1/sales/${inv.id}/return`,
            payload: body,
            statusCode: 201,
            responseBody: res as unknown as Record<string, unknown>,
          });
          return ok(res, 201);
        }

        // Legacy total_amount fallback
        const retAmount = body.total_amount ?? inv.totalAmount;
        if (gtDec(parseDecimal(retAmount), parseDecimal(inv.totalAmount))) {
          throw new ApiError(422, "RETURN_EXCEEDS_INVOICE", "مبلغ برگشت از فروش نمی‌تواند بیشتر از مبلغ کل فاکتور باشد.");
        }
        const retDate = body.return_date || new Date().toISOString().slice(0, 10);
        const createdRet = await withTenantTransaction(ctx.organizationId, async (tx) => {
          const [ret] = await tx
            .insert(salesReturns)
            .values({
              organizationId: ctx.organizationId,
              salesInvoiceId: inv.id,
              returnNumber: `SR-${Date.now().toString().slice(-6)}`,
              returnDate: retDate,
              totalAmount: retAmount,
              reason: body.reason ?? body.notes ?? "برگشت از فروش",
            })
            .returning();
          await tx.insert(contactTransactions).values({
            organizationId: ctx.organizationId,
            contactId: inv.contactId,
            referenceType: "SALES_RETURN",
            referenceId: ret.id,
            txDate: retDate,
            debit: "0.00",
            credit: retAmount,
            description: `برگشت از فروش ${ret.returnNumber}`,
          });
          const orgAccs = await tx.select().from(accounts).where(eq(accounts.organizationId, ctx.organizationId));
          const arAcc = orgAccs.find((a) => a.systemRole === "AR");
          const revAcc = orgAccs.find((a) => a.systemRole === "SALES_REVENUE");
          if (arAcc && revAcc) {
            await createJournalEntryTx(tx, {
              organizationId: ctx.organizationId,
              actorUserId: ctx.userId,
              actorEmail: ctx.email,
              entryDate: retDate,
              description: `سند برگشت از فروش ${ret.returnNumber}`,
              referenceType: "SALES_RETURN",
              referenceId: ret.id,
              postImmediately: true,
              lines: [
                { accountId: revAcc.id, debit: retAmount, credit: "0.00" },
                { accountId: arAcc.id, contactId: inv.contactId, debit: "0.00", credit: retAmount },
              ],
            });
          }
          return ret;
        });
        return ok(createdRet, 201);
      }
      if (sub === "payments") {
        if (method === "GET") {
          const allocs = await db
            .select()
            .from(invoicePaymentAllocations)
            .where(
              and(
                eq(invoicePaymentAllocations.organizationId, ctx.organizationId),
                eq(invoicePaymentAllocations.salesInvoiceId, inv.id)
              )
            );
          return ok(allocs);
        }
        if (method === "POST") {
          await requireOrgContext(req, "treasury.create", { requireActiveSubscription: true });
          const body = z
            .object({
              account_id: z.string().uuid(),
              amount: z.string().regex(/^\d+(\.\d{1,2})?$/),
              payment_method: z.enum(["CASH", "POS", "BANK_TRANSFER", "CARD", "WALLET", "CHEQUE", "OTHER"]).default("BANK_TRANSFER"),
              transaction_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
              reference_number: z.string().optional(),
            })
            .parse(await req.json());
          const idemKey = req.headers.get("idempotency-key");
          const normMethod = body.payment_method === "CARD" ? "POS" : body.payment_method;
          const saved = await recordSubsequentInvoicePayment({
            organizationId: ctx.organizationId,
            invoiceId: inv.id,
            financialAccountId: body.account_id,
            paymentMethod: normMethod,
            amount: body.amount,
            paidAt: body.transaction_date || new Date().toISOString().slice(0, 10),
            referenceNumber: body.reference_number ?? null,
            idempotencyKey: idemKey,
            actorUserId: ctx.userId,
            actorEmail: ctx.email,
            ipAddress: ctx.ipAddress,
          });
          return ok(saved, saved.replayed ? 200 : 201, saved.replayed ? { replayed: true } : undefined);
        }
      }
    }
  }

  // ============================================================================
  // CONSIGNMENTS (/api/v1/consignments/* — Master Prompt 07 §5)
  // ============================================================================
  if (root === "consignments") {
    // GET /api/v1/consignments/balances — Ownership-separated Consignment Inventory Report
    if (method === "GET" && id === "balances") {
      const ctx = await requireOrgContext(req, "consignments.view");
      return ok(await getConsignmentBalancesReport(ctx.organizationId));
    }

    if (method === "GET" && !id) {
      const ctx = await requireOrgContext(req, "consignments.view");
      const q = parseListQuery(req);
      const sp = req.nextUrl.searchParams;
      const filterDocType = sp.get("document_type")?.toUpperCase();
      const filterContact = sp.get("contact_id");
      const filterWh = sp.get("warehouse_id");
      const filterDateFrom = sp.get("date_from");
      const filterDateTo = sp.get("date_to");

      const [docs, items, orgContacts, orgProducts] = await Promise.all([
        db.select().from(consignmentDocuments).where(eq(consignmentDocuments.organizationId, ctx.organizationId)).orderBy(desc(consignmentDocuments.createdAt)),
        db.select().from(consignmentItems).where(eq(consignmentItems.organizationId, ctx.organizationId)),
        db.select().from(contacts).where(eq(contacts.organizationId, ctx.organizationId)),
        db.select().from(products).where(eq(products.organizationId, ctx.organizationId)),
      ]);
      const cMap = new Map(orgContacts.map((c) => [c.id, c.name]));
      const pMap = new Map(orgProducts.map((p) => [p.id, p.name]));

      let filtered = docs;
      if (filterDocType) filtered = filtered.filter((d) => d.documentType === filterDocType);
      if (filterContact) filtered = filtered.filter((d) => d.contactId === filterContact);
      if (filterWh) filtered = filtered.filter((d) => d.warehouseId === filterWh);
      if (filterDateFrom) filtered = filtered.filter((d) => d.documentDate >= filterDateFrom);
      if (filterDateTo) filtered = filtered.filter((d) => d.documentDate <= filterDateTo);

      const enriched = filtered.map((d) => ({
        ...d,
        contact_name: cMap.get(d.contactId) ?? "",
        items: items
          .filter((i) => i.consignmentDocumentId === d.id)
          .map((i) => ({ ...i, product_name: pMap.get(i.productId) ?? "" })),
      }));
      const { items: pageItems, total } = applyListFilterAndPaginate(enriched, q, ["documentNumber", "contact_name"]);
      return okList(pageItems, { page: q.page, perPage: q.perPage, total });
    }

    if (method === "POST" && !id) {
      const ctx = await requireOrgContext(req, "consignments.create", { requireActiveSubscription: true });
      const body = z
        .object({
          document_type: z
            .enum(["CONSIGNMENT_IN", "CONSIGNMENT_OUT", "CONSIGNMENT_SALE", "CONSIGNMENT_RETURN"])
            .optional(),
          direction: z.enum(["IN", "OUT"]).optional(),
          contact_id: z.string().uuid(),
          warehouse_id: z.string().uuid(),
          related_document_id: z.string().uuid().nullable().optional(),
          document_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          commission_rate: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
          receipt_url: z.string().nullable().optional(),
          notes: z.string().optional(),
          items: z
            .array(
              z.object({
                product_id: z.string().uuid(),
                product_variant_id: z.string().uuid().nullable().optional(),
                warehouse_id: z.string().uuid().nullable().optional(),
                quantity: z.string().regex(/^\d+(\.\d{1,4})?$/),
                agreed_unit_price: z.string().regex(/^\d+(\.\d{1,2})?$/),
              })
            )
            .min(1),
        })
        .parse(await req.json());

      const docType =
        body.document_type ??
        (body.direction === "OUT" ? "CONSIGNMENT_OUT" : "CONSIGNMENT_IN");

      const created = await createConsignmentDocument({
        organizationId: ctx.organizationId,
        documentType: docType,
        contactId: body.contact_id,
        warehouseId: body.warehouse_id,
        relatedDocumentId: body.related_document_id ?? null,
        documentDate: body.document_date || new Date().toISOString().slice(0, 10),
        commissionRate: body.commission_rate,
        receiptUrl: body.receipt_url ?? null,
        notes: body.notes,
        actorUserId: ctx.userId,
        actorEmail: ctx.email,
        ipAddress: ctx.ipAddress,
        items: body.items,
      });

      return ok({ ...created.document, items: created.items }, 201);
    }

    if (id) {
      const ctx = await requireOrgContext(req, "consignments.view");
      const [doc] = await db
        .select()
        .from(consignmentDocuments)
        .where(and(eq(consignmentDocuments.id, id), eq(consignmentDocuments.organizationId, ctx.organizationId)))
        .limit(1);
      if (!doc) throw new ApiError(404, "CONSIGNMENT_NOT_FOUND", "سند امانی یافت نشد.");

      if (method === "GET" && !sub) {
        const items = await db.select().from(consignmentItems).where(eq(consignmentItems.consignmentDocumentId, doc.id));
        return ok({ ...doc, items });
      }
      if (method === "GET" && sub === "balance") {
        const items = await db.select().from(consignmentItems).where(eq(consignmentItems.consignmentDocumentId, doc.id));
        const settlements = await db.select().from(consignorSettlements).where(eq(consignorSettlements.consignmentDocumentId, doc.id));
        return ok({
          consignment_id: doc.id,
          document_type: doc.documentType,
          ownership_scope: doc.ownershipScope,
          direction: doc.direction,
          status: doc.status,
          total_value: doc.totalValue,
          items_remaining: items.map((i) => ({
            product_id: i.productId,
            received: i.quantityReceived,
            sold: i.quantitySold,
            returned: i.quantityReturned,
            remaining: formatDecimal(subDec(subDec(i.quantityReceived, i.quantitySold), i.quantityReturned), 4),
          })),
          settlements_count: settlements.length,
        });
      }
      if (sub === "settlements") {
        if (method === "GET") {
          return ok(
            await db
              .select()
              .from(consignorSettlements)
              .where(eq(consignorSettlements.consignmentDocumentId, doc.id))
          );
        }
        if (method === "POST") {
          await requireOrgContext(req, "consignments.confirm", { requireActiveSubscription: true });
          const body = z.object({ gross_sales: z.string().regex(/^\d+(\.\d{1,2})?$/) }).parse(await req.json());
          const rateFraction = mulDec(doc.commissionRate, "0.01");
          const commission = mulDec(body.gross_sales, rateFraction);
          const netPayable = subDec(body.gross_sales, commission);

          const settlement = await withTenantTransaction(ctx.organizationId, async (tx) => {
            const [s] = await tx
              .insert(consignorSettlements)
              .values({
                organizationId: ctx.organizationId,
                consignmentDocumentId: doc.id,
                contactId: doc.contactId,
                settlementDate: new Date().toISOString().slice(0, 10),
                grossSales: body.gross_sales,
                commissionAmount: formatDecimal(commission, 2),
                netPayable: formatDecimal(netPayable, 2),
                status: "PAID",
              })
              .returning();
            await tx.update(consignmentDocuments).set({ status: "SETTLED" }).where(eq(consignmentDocuments.id, doc.id));
            return s;
          });
          return ok(settlement, 201);
        }
      }
      if (method === "POST" && sub === "confirm") {
        await requireOrgContext(req, "consignments.confirm", { requireActiveSubscription: true });
        const idemKey = req.headers.get("idempotency-key");
        const cached = await checkIdempotency({
          organizationId: ctx.organizationId,
          key: idemKey,
          endpoint: `/api/v1/consignments/${doc.id}/confirm`,
          payload: { id: doc.id },
        });
        if (cached) return ok(cached.responseBody, cached.statusCode, { replayed: true });

        const res = await confirmConsignmentDocument({
          organizationId: ctx.organizationId,
          documentId: doc.id,
          actorUserId: ctx.userId,
          actorEmail: ctx.email,
          ipAddress: ctx.ipAddress,
        });
        await saveIdempotency({
          organizationId: ctx.organizationId,
          key: idemKey,
          endpoint: `/api/v1/consignments/${doc.id}/confirm`,
          payload: { id: doc.id },
          statusCode: 200,
          responseBody: res as unknown as Record<string, unknown>,
        });
        return ok(res);
      }
    }
  }

  throw new ApiError(404, "ROUTE_NOT_FOUND", "مسیر بازرگانی یافت نشد.");
}

import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  accountingCategories,
  accounts,
  categoryAccountMappings,
  contacts,
  contactTransactions,
  costCenters,
  employees,
  financialAccounts,
  invoicePaymentAllocations,
  loyaltyAccounts,
  loyaltyTransactions,
  organizationMembers,
  products,
  productVariants,
  purchaseOrderItems,
  purchaseOrders,
  purchaseSuggestions,
  quickTransactions,
  quotationItems,
  quotations,
  roles,
  salesInvoiceItems,
  salesInvoices,
  salesReturns,
  userRoles,
  users,
  warehouses,
  warehouseStockThresholds,
} from "@/db/schema";
import { ensureSeeded } from "@/db/seed";
import { ensurePrompt05OrgDefaults } from "@/db/seed-prompt05";
import { hashPassword } from "@/lib/auth";
import { recordAuditLog } from "@/lib/audit";
import { addDec, formatDecimal, isPositiveDec, mulDec, parseDecimal, subDec } from "@/lib/decimal";
import { ApiError, ok } from "@/lib/errors";
import { checkIdempotency, saveIdempotency } from "@/lib/idempotency";
import { requireOrgContext, withTenantTransaction } from "@/lib/tenant";
import { createJournalEntryTx, reverseJournalEntry } from "@/modules/accounting/service";
import {
  computeSmartPurchaseRecommendations,
  convertSuggestionToPurchaseOrder,
  getLiveStockBalances,
  postOpeningStockDocument,
} from "@/modules/inventory/service";

// ============================================================================
// 1. QUICK EXPENSE & INCOME + AUTOMATIC ACCOUNT MAPPING (§5)
// ============================================================================

export async function handleQuickFinanceRoutes(
  req: NextRequest,
  method: string,
  segments: string[]
) {
  await ensureSeeded();
  const root = segments[0]; // accounting-categories | quick-transactions
  const id = segments[1];
  const action = segments[2];

  if (root === "accounting-categories") {
    const ctx = await requireOrgContext(req, method === "GET" ? "treasury.view" : "accounting.journal.create", {
      requireActiveSubscription: method !== "GET",
    });
    await ensurePrompt05OrgDefaults(ctx.organizationId);

    if (method === "GET" && !id) {
      const [cats, mappings, accs] = await Promise.all([
        db.select().from(accountingCategories).where(eq(accountingCategories.organizationId, ctx.organizationId)),
        db.select().from(categoryAccountMappings).where(eq(categoryAccountMappings.organizationId, ctx.organizationId)),
        db.select().from(accounts).where(eq(accounts.organizationId, ctx.organizationId)),
      ]);
      const accMap = new Map(accs.map((a) => [a.id, a]));
      return ok(
        cats.map((c) => {
          const m = mappings.find((x) => x.categoryId === c.id);
          return {
            ...c,
            mapping: m
              ? {
                  id: m.id,
                  debit_account_id: m.debitAccountId,
                  debit_account_name: accMap.get(m.debitAccountId)?.name ?? "",
                  credit_account_id: m.creditAccountId,
                  credit_account_name: accMap.get(m.creditAccountId)?.name ?? "",
                  tax_account_id: m.taxAccountId,
                }
              : null,
          };
        })
      );
    }

    if (method === "POST" && !id) {
      const body = z
        .object({
          kind: z.enum(["EXPENSE", "INCOME"]),
          scope: z.enum(["BUSINESS", "PERSONAL"]).default("BUSINESS"),
          code: z.string().min(2),
          name_fa: z.string().min(2),
          debit_account_id: z.string().uuid().optional(),
          credit_account_id: z.string().uuid().optional(),
        })
        .parse(await req.json());

      const created = await withTenantTransaction(ctx.organizationId, async (tx) => {
        const [cat] = await tx
          .insert(accountingCategories)
          .values({
            organizationId: ctx.organizationId,
            kind: body.kind,
            scope: body.scope,
            code: body.code.toUpperCase(),
            nameFa: body.name_fa,
          })
          .returning();

        if (body.debit_account_id && body.credit_account_id) {
          await tx.insert(categoryAccountMappings).values({
            organizationId: ctx.organizationId,
            categoryId: cat.id,
            debitAccountId: body.debit_account_id,
            creditAccountId: body.credit_account_id,
          });
        }
        return cat;
      });
      return ok(created, 201);
    }

    if (method === "POST" && id && action === "mapping") {
      const body = z
        .object({
          debit_account_id: z.string().uuid(),
          credit_account_id: z.string().uuid(),
          tax_account_id: z.string().uuid().nullable().optional(),
        })
        .parse(await req.json());
      const [saved] = await db
        .insert(categoryAccountMappings)
        .values({
          organizationId: ctx.organizationId,
          categoryId: id,
          debitAccountId: body.debit_account_id,
          creditAccountId: body.credit_account_id,
          taxAccountId: body.tax_account_id ?? null,
        })
        .onConflictDoUpdate({
          target: [categoryAccountMappings.organizationId, categoryAccountMappings.categoryId],
          set: {
            debitAccountId: body.debit_account_id,
            creditAccountId: body.credit_account_id,
            taxAccountId: body.tax_account_id ?? null,
            updatedAt: new Date(),
          },
        })
        .returning();
      return ok(saved);
    }
  }

  if (root === "quick-transactions" || root === "quick-cashflows") {
    if (method === "GET" && !id) {
      const ctx = await requireOrgContext(req, "treasury.view");
      await ensurePrompt05OrgDefaults(ctx.organizationId);
      const [txs, cats, fas] = await Promise.all([
        db
          .select()
          .from(quickTransactions)
          .where(eq(quickTransactions.organizationId, ctx.organizationId))
          .orderBy(desc(quickTransactions.txDate), desc(quickTransactions.createdAt))
          .limit(80),
        db.select().from(accountingCategories).where(eq(accountingCategories.organizationId, ctx.organizationId)),
        db.select().from(financialAccounts).where(eq(financialAccounts.organizationId, ctx.organizationId)),
      ]);
      const cMap = new Map(cats.map((c) => [c.id, c.nameFa]));
      const fMap = new Map(fas.map((f) => [f.id, f.name]));
      return ok(
        txs.map((t) => ({
          ...t,
          category_name: cMap.get(t.categoryId) ?? "",
          account_name: fMap.get(t.financialAccountId) ?? "",
        }))
      );
    }

    if (method === "POST" && !id) {
      const ctx = await requireOrgContext(req, "treasury.create", { requireActiveSubscription: true });
      await ensurePrompt05OrgDefaults(ctx.organizationId);
      const body = z
        .object({
          kind: z.enum(["EXPENSE", "INCOME"]),
          scope: z.enum(["BUSINESS", "PERSONAL"]).default("BUSINESS"),
          category_id: z.string().uuid(),
          financial_account_id: z.string().uuid(),
          contact_id: z.string().uuid().nullable().optional(),
          cost_center_id: z.string().uuid().nullable().optional(),
          warehouse_id: z.string().uuid().nullable().optional(),
          title: z.string().min(2),
          amount: z.string().regex(/^\d+(\.\d{1,2})?$/),
          tax_amount: z.string().regex(/^\d+(\.\d{1,2})?$/).default("0.00"),
          tx_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          payment_method: z.enum(["CASH", "POS", "BANK_TRANSFER", "CARD", "CHEQUE", "OTHER"]).default("BANK_TRANSFER"),
          receipt_url: z.string().nullable().optional(),
          description: z.string().optional(),
        })
        .parse(await req.json());

      // Master Prompt 07 §11: Reject PERSONAL expense from posting as Business OpEx + Validate active cost_center_id!
      if (body.scope === "PERSONAL") {
        throw new ApiError(
          422,
          "USE_PERSONAL_FINANCE_ENDPOINT",
          "هزینه‌های شخصی مالک نباید در جریان نقدی عملیاتی کسب‌وکار ثبت شوند؛ از /api/v1/personal-finance/transactions استفاده کنید."
        );
      }
      if (body.cost_center_id) {
        const [cc] = await db
          .select()
          .from(costCenters)
          .where(and(eq(costCenters.id, body.cost_center_id), eq(costCenters.organizationId, ctx.organizationId)))
          .limit(1);
        if (!cc) throw new ApiError(404, "COST_CENTER_NOT_FOUND", "مرکز هزینه متعلق به این سازمان نیست.");
        if (!cc.isActive) throw new ApiError(409, "COST_CENTER_INACTIVE", "مرکز هزینه انتخاب‌شده غیرفعال است.");
      }

      const idemKey = req.headers.get("idempotency-key");
      const cached = await checkIdempotency({
        organizationId: ctx.organizationId,
        key: idemKey,
        endpoint: "/api/v1/quick-transactions",
        payload: body,
      });
      if (cached) return ok(cached.responseBody, cached.statusCode, { replayed: true });

      const result = await withTenantTransaction(ctx.organizationId, async (tx) => {
        const [mapping] = await tx
          .select()
          .from(categoryAccountMappings)
          .where(
            and(
              eq(categoryAccountMappings.organizationId, ctx.organizationId),
              eq(categoryAccountMappings.categoryId, body.category_id),
              eq(categoryAccountMappings.isActive, true)
            )
          )
          .limit(1);

        // §5.4: Never silently post to arbitrary account if mapping is missing!
        if (!mapping) {
          throw new ApiError(
            422,
            "CATEGORY_ACCOUNT_MAPPING_MISSING",
            "نگاشت حسابداری برای این دسته‌بندی تعریف نشده است. لطفاً ابتدا حساب معین متناظر را تنظیم کنید."
          );
        }

        const [fa] = await tx
          .select()
          .from(financialAccounts)
          .where(
            and(
              eq(financialAccounts.id, body.financial_account_id),
              eq(financialAccounts.organizationId, ctx.organizationId)
            )
          )
          .limit(1);
        if (!fa) throw new ApiError(404, "TREASURY_ACCOUNT_NOT_FOUND", "حساب خزانه یافت نشد.");

        const totalWithTax = addDec(body.amount, body.tax_amount);
        const totalStr = formatDecimal(totalWithTax, 2);
        const nextBal =
          body.kind === "INCOME"
            ? addDec(fa.balance, totalWithTax)
            : subDec(fa.balance, totalWithTax);

        await tx
          .update(financialAccounts)
          .set({ balance: formatDecimal(nextBal, 2) })
          .where(eq(financialAccounts.id, fa.id));

        const treasuryGlAccId = fa.accountId ?? (body.kind === "EXPENSE" ? mapping.creditAccountId : mapping.debitAccountId);
        const txDate = body.tx_date || new Date().toISOString().slice(0, 10);

        const lines =
          body.kind === "EXPENSE"
            ? [
                {
                  accountId: mapping.debitAccountId,
                  costCenterId: body.cost_center_id ?? null,
                  debit: body.amount,
                  credit: "0.00",
                  description: body.title,
                },
                ...(isPositiveDec(parseDecimal(body.tax_amount)) && mapping.taxAccountId
                  ? [{ accountId: mapping.taxAccountId, debit: body.tax_amount, credit: "0.00", description: "مالیات هزینه" }]
                  : []),
                {
                  accountId: treasuryGlAccId,
                  debit: "0.00",
                  credit: mapping.taxAccountId ? totalStr : body.amount,
                  description: `پرداخت از ${fa.name}`,
                },
              ]
            : [
                {
                  accountId: treasuryGlAccId,
                  debit: mapping.taxAccountId ? totalStr : body.amount,
                  credit: "0.00",
                  description: `واریز به ${fa.name}`,
                },
                {
                  accountId: mapping.creditAccountId,
                  costCenterId: body.cost_center_id ?? null,
                  debit: "0.00",
                  credit: body.amount,
                  description: body.title,
                },
                ...(isPositiveDec(parseDecimal(body.tax_amount)) && mapping.taxAccountId
                  ? [{ accountId: mapping.taxAccountId, debit: "0.00", credit: body.tax_amount, description: "مالیات درآمد" }]
                  : []),
              ];

        const journalRes = await createJournalEntryTx(tx, {
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          actorEmail: ctx.email,
          entryDate: txDate,
          description: `ثبت سریع ${body.kind === "EXPENSE" ? "هزینه" : "درآمد"}: ${body.title}`,
          referenceType: body.kind === "EXPENSE" ? "QUICK_EXPENSE" : "QUICK_INCOME",
          postImmediately: true,
          lines,
        });

        const [saved] = await tx
          .insert(quickTransactions)
          .values({
            organizationId: ctx.organizationId,
            kind: body.kind,
            scope: body.scope,
            categoryId: body.category_id,
            financialAccountId: fa.id,
            contactId: body.contact_id ?? null,
            costCenterId: body.cost_center_id ?? null,
            warehouseId: body.warehouse_id ?? null,
            title: body.title,
            amount: body.amount,
            taxAmount: body.tax_amount,
            txDate,
            paymentMethod: body.payment_method,
            receiptUrl: body.receipt_url ?? null,
            description: body.description ?? null,
            status: "CONFIRMED",
            journalEntryId: journalRes.entry.id,
            idempotencyKey: idemKey ?? null,
            createdBy: ctx.userId,
          })
          .returning();

        return { transaction: saved, journal_entry: journalRes.entry };
      });

      await saveIdempotency({
        organizationId: ctx.organizationId,
        key: idemKey,
        endpoint: "/api/v1/quick-transactions",
        payload: body,
        statusCode: 201,
        responseBody: result as unknown as Record<string, unknown>,
      });

      return ok(result, 201);
    }

    if (method === "POST" && id && action === "reverse") {
      const ctx = await requireOrgContext(req, "accounting.journal.reverse", { requireActiveSubscription: true });
      const [qtx] = await db
        .select()
        .from(quickTransactions)
        .where(and(eq(quickTransactions.id, id), eq(quickTransactions.organizationId, ctx.organizationId)))
        .limit(1);
      if (!qtx) throw new ApiError(404, "QUICK_TX_NOT_FOUND", "تراکنش یافت نشد.");
      let rev = null;
      if (qtx.journalEntryId) {
        rev = await reverseJournalEntry({
          organizationId: ctx.organizationId,
          journalEntryId: qtx.journalEntryId,
          reason: `برگشت ${qtx.title}`,
          actorUserId: ctx.userId,
          actorEmail: ctx.email,
          ipAddress: ctx.ipAddress,
        });
      }
      const [upd] = await db
        .update(quickTransactions)
        .set({ status: "REVERSED" })
        .where(eq(quickTransactions.id, qtx.id))
        .returning();
      return ok({ transaction: upd, reversal: rev });
    }
  }

  throw new ApiError(404, "ROUTE_NOT_FOUND", "مسیر ثبت سریع هزینه/درآمد یافت نشد.");
}

// ============================================================================
// 2. PRODUCT VARIANTS, OPENING STOCK, SMART REPLENISHMENT & PURCHASE ORDERS (§6 & §7)
// ============================================================================

export async function handleVariantsAndReplenishmentRoutes(
  req: NextRequest,
  method: string,
  segments: string[]
) {
  await ensureSeeded();
  const root = segments[0]; // variants | opening-stock | replenishment | purchase-orders
  const seg1 = segments[1];
  const seg2 = segments[2];
  const seg3 = segments[3];

  // /api/v1/variants
  if (root === "variants") {
    if (method === "GET") {
      const ctx = await requireOrgContext(req, "catalog.view");
      const productId = seg1 === "product" ? seg2 : req.nextUrl.searchParams.get("product_id");
      const [allVars, stock] = await Promise.all([
        db
          .select()
          .from(productVariants)
          .where(
            productId
              ? and(eq(productVariants.organizationId, ctx.organizationId), eq(productVariants.productId, productId))
              : eq(productVariants.organizationId, ctx.organizationId)
          )
          .orderBy(desc(productVariants.createdAt)),
        getLiveStockBalances(ctx.organizationId),
      ]);

      let parentProjectionTotal = BigInt(0);
      const enriched = allVars.map((v) => {
        let varTotal = BigInt(0);
        const byWarehouse = stock.balances
          .filter((b) => b.variantId === v.id)
          .map((b) => {
            varTotal = addDec(varTotal, b.onHandQty);
            return { warehouse_id: b.warehouseId, warehouse_name: b.warehouseName, on_hand_qty: b.onHandQty };
          });
        parentProjectionTotal = addDec(parentProjectionTotal, varTotal);
        return {
          ...v,
          on_hand_qty: formatDecimal(varTotal, 4),
          warehouse_stocks: byWarehouse,
        };
      });

      return ok({
        variants: enriched,
        parent_stock_projection: formatDecimal(parentProjectionTotal, 4),
      });
    }

    if (method === "POST") {
      const ctx = await requireOrgContext(req, "catalog.create", { requireActiveSubscription: true });
      const body = z
        .object({
          product_id: z.string().uuid(),
          sku: z.string().min(2),
          barcode: z.string().optional(),
          variant_name: z.string().min(2),
          attributes: z.record(z.string(), z.string()).default({}),
          purchase_price: z.string().regex(/^\d+(\.\d{1,2})?$/).default("0.00"),
          sale_price: z.string().regex(/^\d+(\.\d{1,2})?$/).default("0.00"),
          min_stock_level: z.string().regex(/^\d+(\.\d{1,4})?$/).default("0.0000"),
        })
        .parse(await req.json());

      const [created] = await db
        .insert(productVariants)
        .values({
          organizationId: ctx.organizationId,
          productId: body.product_id,
          sku: body.sku.trim(),
          barcode: body.barcode ?? null,
          variantName: body.variant_name.trim(),
          attributes: body.attributes,
          purchasePrice: body.purchase_price,
          salePrice: body.sale_price,
          minStockLevel: body.min_stock_level,
        })
        .returning();

      return ok(created, 201);
    }
  }

  // POST /api/v1/opening-stock
  if (root === "opening-stock" && method === "POST") {
    const ctx = await requireOrgContext(req, "inventory.adjust", { requireActiveSubscription: true });
    const body = z
      .object({
        warehouse_id: z.string().uuid(),
        product_id: z.string().uuid(),
        variant_id: z.string().uuid().nullable().optional(),
        quantity: z.string().regex(/^\d+(\.\d{1,4})?$/),
        unit_cost: z.string().regex(/^\d+(\.\d{1,4})?$/),
        effective_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        description: z.string().optional(),
      })
      .parse(await req.json());

    const res = await postOpeningStockDocument({
      organizationId: ctx.organizationId,
      warehouseId: body.warehouse_id,
      productId: body.product_id,
      variantId: body.variant_id ?? null,
      quantity: body.quantity,
      unitCost: body.unit_cost,
      effectiveDate: body.effective_date || new Date().toISOString().slice(0, 10),
      description: body.description,
      actorUserId: ctx.userId,
      actorEmail: ctx.email,
      ipAddress: ctx.ipAddress,
    });
    return ok(res, 201);
  }

  // /api/v1/purchase-orders (Incoming POs for Smart Replenishment)
  if (root === "purchase-orders") {
    if (method === "GET") {
      const ctx = await requireOrgContext(req, "purchases.view");
      const [pos, items] = await Promise.all([
        db.select().from(purchaseOrders).where(eq(purchaseOrders.organizationId, ctx.organizationId)).orderBy(desc(purchaseOrders.createdAt)),
        db.select().from(purchaseOrderItems).where(eq(purchaseOrderItems.organizationId, ctx.organizationId)),
      ]);
      return ok(pos.map((po) => ({ ...po, items: items.filter((i) => i.purchaseOrderId === po.id) })));
    }
    if (method === "POST") {
      const ctx = await requireOrgContext(req, "purchases.create", { requireActiveSubscription: true });
      const body = z
        .object({
          supplier_id: z.string().uuid(),
          warehouse_id: z.string().uuid(),
          order_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          expected_delivery_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          notes: z.string().optional(),
          items: z
            .array(
              z.object({
                product_id: z.string().uuid(),
                variant_id: z.string().uuid().nullable().optional(),
                quantity: z.string().regex(/^\d+(\.\d{1,4})?$/),
                unit_price: z.string().regex(/^\d+(\.\d{1,2})?$/).default("0.00"),
              })
            )
            .min(1),
        })
        .parse(await req.json());

      let total = BigInt(0);
      const calcItems = body.items.map((it) => {
        const lt = mulDec(it.quantity, it.unit_price);
        total = addDec(total, lt);
        return { ...it, line_total: formatDecimal(lt, 2) };
      });

      const created = await withTenantTransaction(ctx.organizationId, async (tx) => {
        const [po] = await tx
          .insert(purchaseOrders)
          .values({
            organizationId: ctx.organizationId,
            contactId: body.supplier_id,
            warehouseId: body.warehouse_id,
            orderNumber: `PO-${Date.now().toString().slice(-6)}`,
            orderDate: body.order_date || new Date().toISOString().slice(0, 10),
            expectedDeliveryDate: body.expected_delivery_date ?? null,
            totalAmount: formatDecimal(total, 2),
            status: "CONFIRMED",
            notes: body.notes ?? null,
            createdBy: ctx.userId,
          })
          .returning();

        const savedItems = await tx
          .insert(purchaseOrderItems)
          .values(
            calcItems.map((ci) => ({
              organizationId: ctx.organizationId,
              purchaseOrderId: po.id,
              productId: ci.product_id,
              variantId: ci.variant_id ?? null,
              quantity: ci.quantity,
              unitPrice: ci.unit_price,
              lineTotal: ci.line_total,
            }))
          )
          .returning();
        return { ...po, items: savedItems };
      });
      return ok(created, 201);
    }
  }

  // /api/v1/replenishment/*
  if (root === "replenishment") {
    if (seg1 === "thresholds") {
      if (method === "GET") {
        const ctx = await requireOrgContext(req, "inventory.view");
        return ok(
          await db
            .select()
            .from(warehouseStockThresholds)
            .where(eq(warehouseStockThresholds.organizationId, ctx.organizationId))
        );
      }
      if (method === "POST") {
        const ctx = await requireOrgContext(req, "inventory.adjust", { requireActiveSubscription: true });
        const body = z
          .object({
            warehouse_id: z.string().uuid(),
            product_id: z.string().uuid(),
            variant_id: z.string().uuid().nullable().optional(),
            min_stock: z.string().regex(/^\d+(\.\d{1,4})?$/),
            safety_stock: z.string().regex(/^\d+(\.\d{1,4})?$/).default("4.0000"),
            lead_time_days: z.number().int().min(1).default(5),
            avg_daily_demand: z.string().regex(/^\d+(\.\d{1,4})?$/).default("2.0000"),
            supplier_moq: z.string().regex(/^\d+(\.\d{1,4})?$/).default("1.0000"),
            preferred_supplier_id: z.string().uuid().nullable().optional(),
          })
          .parse(await req.json());

        const [saved] = await db
          .insert(warehouseStockThresholds)
          .values({
            organizationId: ctx.organizationId,
            warehouseId: body.warehouse_id,
            productId: body.product_id,
            variantId: body.variant_id ?? null,
            minStock: body.min_stock,
            safetyStock: body.safety_stock,
            leadTimeDays: body.lead_time_days,
            avgDailyDemand: body.avg_daily_demand,
            supplierMoq: body.supplier_moq,
            preferredSupplierId: body.preferred_supplier_id ?? null,
          })
          .returning();
        return ok(saved, 201);
      }
    }

    if (seg1 === "suggestions") {
      if (method === "GET" && !seg2) {
        const ctx = await requireOrgContext(req, "inventory.view");
        return ok(await computeSmartPurchaseRecommendations(ctx.organizationId));
      }
      if (method === "POST" && !seg2) {
        const ctx = await requireOrgContext(req, "inventory.view");
        return ok(await computeSmartPurchaseRecommendations(ctx.organizationId), 201);
      }
      if (method === "POST" && seg2 && seg3 === "convert-po") {
        const ctx = await requireOrgContext(req, "purchases.create", { requireActiveSubscription: true });
        const body = z
          .object({
            supplier_id: z.string().uuid().nullable().optional(),
            override_qty: z.string().regex(/^\d+(\.\d{1,4})?$/).optional(),
          })
          .parse(await req.json().catch(() => ({})));
        const res = await convertSuggestionToPurchaseOrder({
          organizationId: ctx.organizationId,
          suggestionId: seg2,
          supplierId: body.supplier_id,
          overrideQty: body.override_qty,
          actorUserId: ctx.userId,
          actorEmail: ctx.email,
          ipAddress: ctx.ipAddress,
        });
        return ok(res, res.alreadyConverted ? 200 : 201);
      }
      if (method === "POST" && seg2 && seg3 === "reject") {
        const ctx = await requireOrgContext(req, "purchases.create", { requireActiveSubscription: true });
        const [upd] = await db
          .update(purchaseSuggestions)
          .set({ status: "REJECTED" })
          .where(and(eq(purchaseSuggestions.id, seg2), eq(purchaseSuggestions.organizationId, ctx.organizationId)))
          .returning();
        return ok(upd);
      }
    }
  }

  throw new ApiError(404, "ROUTE_NOT_FOUND", "مسیر تنوع کالا یا تامین هوشمند یافت نشد.");
}

// ============================================================================
// 3. QUOTATIONS, CRM & LOYALTY, EMPLOYEES & PRINTABLE PDF (§4.9, §8, §9, §14)
// ============================================================================

export async function handleQuotationsCrmEmployeesRoutes(
  req: NextRequest,
  method: string,
  segments: string[]
) {
  await ensureSeeded();
  const root = segments[0]; // quotations | crm | employees | documents
  const seg1 = segments[1];
  const seg2 = segments[2];

  // /api/v1/quotations (§4.9 — Zero accounting or stock impact until converted!)
  if (root === "quotations") {
    if (method === "GET" && !seg1) {
      const ctx = await requireOrgContext(req, "sales.view");
      const [qs, items, orgContacts] = await Promise.all([
        db.select().from(quotations).where(eq(quotations.organizationId, ctx.organizationId)).orderBy(desc(quotations.createdAt)),
        db.select().from(quotationItems).where(eq(quotationItems.organizationId, ctx.organizationId)),
        db.select().from(contacts).where(eq(contacts.organizationId, ctx.organizationId)),
      ]);
      const cMap = new Map(orgContacts.map((c) => [c.id, c.name]));
      return ok(
        qs.map((q) => ({
          ...q,
          customer_name: cMap.get(q.contactId) ?? "",
          items: items.filter((i) => i.quotationId === q.id),
        }))
      );
    }

    if (method === "POST" && !seg1) {
      const ctx = await requireOrgContext(req, "sales.create", { requireActiveSubscription: true });
      const body = z
        .object({
          customer_id: z.string().uuid(),
          warehouse_id: z.string().uuid(),
          issue_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          valid_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          discount_total: z.string().regex(/^\d+(\.\d{1,2})?$/).default("0.00"),
          tax_total: z.string().regex(/^\d+(\.\d{1,2})?$/).default("0.00"),
          terms: z.string().optional(),
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
        .parse(await req.json());

      let subtotal = BigInt(0);
      const calcItems = body.items.map((it) => {
        const lt = mulDec(it.quantity, it.unit_price);
        subtotal = addDec(subtotal, lt);
        return { ...it, line_total: formatDecimal(lt, 2) };
      });
      const grandTotal = addDec(subDec(subtotal, body.discount_total), body.tax_total);
      const issueDate = body.issue_date || new Date().toISOString().slice(0, 10);
      const validUntil = body.valid_until || new Date(Date.now() + 14 * 86400 * 1000).toISOString().slice(0, 10);

      const created = await withTenantTransaction(ctx.organizationId, async (tx) => {
        const [q] = await tx
          .insert(quotations)
          .values({
            organizationId: ctx.organizationId,
            contactId: body.customer_id,
            warehouseId: body.warehouse_id,
            quotationNumber: `QT-${Date.now().toString().slice(-6)}`,
            issueDate,
            validUntil,
            subtotal: formatDecimal(subtotal, 2),
            discountTotal: body.discount_total,
            taxTotal: body.tax_total,
            grandTotal: formatDecimal(grandTotal, 2),
            terms: body.terms ?? "اعتبار پیش‌فاکتور ۱۴ روز کاری است.",
            status: "SENT",
            createdBy: ctx.userId,
          })
          .returning();

        const savedItems = await tx
          .insert(quotationItems)
          .values(
            calcItems.map((ci) => ({
              organizationId: ctx.organizationId,
              quotationId: q.id,
              productId: ci.product_id,
              variantId: ci.variant_id ?? null,
              quantity: ci.quantity,
              unitPrice: ci.unit_price,
              lineTotal: ci.line_total,
            }))
          )
          .returning();

        return { ...q, items: savedItems };
      });
      return ok(created, 201);
    }

    if (method === "POST" && seg1 && seg2 === "convert") {
      const ctx = await requireOrgContext(req, "sales.create", { requireActiveSubscription: true });
      const converted = await withTenantTransaction(ctx.organizationId, async (tx) => {
        const [q] = await tx
          .select()
          .from(quotations)
          .where(and(eq(quotations.id, seg1), eq(quotations.organizationId, ctx.organizationId)))
          .limit(1);
        if (!q) throw new ApiError(404, "QUOTATION_NOT_FOUND", "پیش‌فاکتور یافت نشد.");
        if (q.status === "CONVERTED" && q.convertedInvoiceId) {
          throw new ApiError(409, "QUOTATION_ALREADY_CONVERTED", "این پیش‌فاکتور قبلاً به فاکتور فروش تبدیل شده است.");
        }

        const qItems = await tx.select().from(quotationItems).where(eq(quotationItems.quotationId, q.id));
        const [inv] = await tx
          .insert(salesInvoices)
          .values({
            organizationId: ctx.organizationId,
            contactId: q.contactId,
            warehouseId: q.warehouseId,
            quotationId: q.id,
            invoiceNumber: `SI-${Date.now().toString().slice(-6)}`,
            invoiceDate: new Date().toISOString().slice(0, 10),
            subtotal: q.subtotal,
            discountAmount: q.discountTotal,
            taxAmount: q.taxTotal,
            totalAmount: q.grandTotal,
            remainingAmount: q.grandTotal,
            status: "DRAFT",
            notes: `تبدیل‌شده از پیش‌فاکتور ${q.quotationNumber}`,
            createdBy: ctx.userId,
            syncSeq: Date.now(),
          })
          .returning();

        await tx.insert(salesInvoiceItems).values(
          qItems.map((qi) => ({
            organizationId: ctx.organizationId,
            salesInvoiceId: inv.id,
            productId: qi.productId,
            variantId: qi.variantId,
            quantity: qi.quantity,
            unitPrice: qi.unitPrice,
            lineTotal: qi.lineTotal,
          }))
        );

        await tx
          .update(quotations)
          .set({ status: "CONVERTED", convertedInvoiceId: inv.id })
          .where(eq(quotations.id, q.id));

        return inv;
      });
      return ok(converted, 201);
    }
  }

  // /api/v1/crm/* (§8 Customer Profiles, Segmentation & Immutable Loyalty Ledger)
  if (root === "crm") {
    if (method === "GET" && seg1 === "customers") {
      const ctx = await requireOrgContext(req, "contacts.view");
      const [allContacts, allSales, allReturns, allContactTxs, allLoyaltyAccs, allLoyaltyTxs] =
        await Promise.all([
          db.select().from(contacts).where(eq(contacts.organizationId, ctx.organizationId)),
          db.select().from(salesInvoices).where(eq(salesInvoices.organizationId, ctx.organizationId)),
          db.select().from(salesReturns).where(eq(salesReturns.organizationId, ctx.organizationId)),
          db.select().from(contactTransactions).where(eq(contactTransactions.organizationId, ctx.organizationId)),
          db.select().from(loyaltyAccounts).where(eq(loyaltyAccounts.organizationId, ctx.organizationId)),
          db.select().from(loyaltyTransactions).where(eq(loyaltyTransactions.organizationId, ctx.organizationId)).orderBy(desc(loyaltyTransactions.createdAt)),
        ]);

      const profiles = allContacts.map((c) => {
        const cSales = allSales.filter((s) => s.contactId === c.id && s.status !== "CANCELLED");
        let totalPurchases = BigInt(0);
        for (const s of cSales) totalPurchases = addDec(totalPurchases, s.totalAmount);

        const cSaleIds = new Set(cSales.map((s) => s.id));
        let totalReturns = BigInt(0);
        for (const r of allReturns.filter((x) => cSaleIds.has(x.salesInvoiceId))) {
          totalReturns = addDec(totalReturns, r.totalAmount);
        }

        let outstanding = addDec(c.openingBalance, "0");
        for (const t of allContactTxs.filter((x) => x.contactId === c.id)) {
          outstanding = subDec(addDec(outstanding, t.debit), t.credit);
        }

        const la = allLoyaltyAccs.find((x) => x.contactId === c.id);
        const lTxs = allLoyaltyTxs.filter((x) => x.contactId === c.id);
        const pointsBalance = lTxs.reduce((sum, x) => sum + x.pointsDelta, 0);

        const segmentsList: string[] = [];
        if (pointsBalance >= 500 || Number(formatDecimal(totalPurchases, 2)) >= 300_000_000) segmentsList.push("VIP");
        if (cSales.length >= 3) segmentsList.push("FREQUENT");
        if (isPositiveDec(outstanding)) segmentsList.push("DEBTOR");
        if (cSales.length === 0) segmentsList.push("NEW");

        const overCredit =
          isPositiveDec(parseDecimal(c.creditLimit)) &&
          outstanding > parseDecimal(c.creditLimit);

        return {
          contact_id: c.id,
          code: c.code,
          display_name: c.name,
          type: c.contactType,
          mobile: c.mobile,
          credit_limit: c.creditLimit,
          over_credit_limit: overCredit,
          invoices_count: cSales.length,
          total_purchases: formatDecimal(totalPurchases, 2),
          total_returns: formatDecimal(totalReturns, 2),
          outstanding_receivable: formatDecimal(outstanding, 2),
          loyalty_tier: la?.tier ?? "BRONZE",
          loyalty_points: pointsBalance,
          segments: segmentsList,
          recent_loyalty_transactions: lTxs.slice(0, 10),
        };
      });

      return ok(profiles);
    }

    if (method === "POST" && seg1 === "loyalty" && seg2 === "transactions") {
      const ctx = await requireOrgContext(req, "contacts.update", { requireActiveSubscription: true });
      const body = z
        .object({
          contact_id: z.string().uuid(),
          tx_type: z.enum(["EARN", "REDEEM", "ADJUST", "EXPIRE", "REFERRAL"]),
          points: z.number().int().positive(),
          description: z.string().min(2),
        })
        .parse(await req.json());

      const saved = await withTenantTransaction(ctx.organizationId, async (tx) => {
        let [la] = await tx
          .select()
          .from(loyaltyAccounts)
          .where(and(eq(loyaltyAccounts.organizationId, ctx.organizationId), eq(loyaltyAccounts.contactId, body.contact_id)))
          .limit(1);
        if (!la) {
          [la] = await tx
            .insert(loyaltyAccounts)
            .values({ organizationId: ctx.organizationId, contactId: body.contact_id, tier: "BRONZE" })
            .returning();
        }

        const existingTxs = await tx
          .select()
          .from(loyaltyTransactions)
          .where(eq(loyaltyTransactions.loyaltyAccountId, la.id));
        const currentPoints = existingTxs.reduce((s, x) => s + x.pointsDelta, 0);
        const delta =
          body.tx_type === "REDEEM" || body.tx_type === "EXPIRE"
            ? -body.points
            : body.points;

        if (currentPoints + delta < 0) {
          throw new ApiError(422, "INSUFFICIENT_LOYALTY_POINTS", `امتیاز کافی نیست (موجود: ${currentPoints}).`);
        }

        const [ltx] = await tx
          .insert(loyaltyTransactions)
          .values({
            organizationId: ctx.organizationId,
            loyaltyAccountId: la.id,
            contactId: body.contact_id,
            txType: body.tx_type,
            pointsDelta: delta,
            description: body.description,
            createdBy: ctx.userId,
          })
          .returning();

        const nextPts = currentPoints + delta;
        const nextTier = nextPts >= 1000 ? "VIP" : nextPts >= 500 ? "GOLD" : nextPts >= 200 ? "SILVER" : "BRONZE";
        await tx.update(loyaltyAccounts).set({ tier: nextTier }).where(eq(loyaltyAccounts.id, la.id));

        return { transaction: ltx, new_points_balance: nextPts, tier: nextTier };
      });

      return ok(saved, 201);
    }
  }

  // /api/v1/employees (§9 Employee Management + Scoped RBAC — Scenario I!)
  if (root === "employees") {
    const ctx = await requireOrgContext(req, "employees.manage", {
      requireActiveSubscription: method !== "GET",
    });

    if (method === "GET" && !seg1) {
      const [emps, allRoles] = await Promise.all([
        db.select().from(employees).where(eq(employees.organizationId, ctx.organizationId)).orderBy(desc(employees.createdAt)),
        db.select().from(roles),
      ]);
      const rMap = new Map(allRoles.map((r) => [r.id, r]));
      return ok(
        emps.map((e) => ({
          ...e,
          role_code: e.roleId ? rMap.get(e.roleId)?.code ?? null : null,
          role_name: e.roleId ? rMap.get(e.roleId)?.name ?? null : null,
        }))
      );
    }

    if (method === "POST" && !seg1) {
      const body = z
        .object({
          employee_code: z.string().min(2),
          full_name: z.string().min(2),
          mobile: z.string().min(10),
          email: z.string().email(),
          password: z.string().min(6).default("Emp@1234"),
          role_code: z.string().default("SALESPERSON"),
          branch_name: z.string().default("شعبه مرکزی"),
          allowed_warehouse_ids: z.array(z.string().uuid()).default([]),
          hire_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          notes: z.string().optional(),
        })
        .parse(await req.json());

      const passwordHash = await hashPassword(body.password);
      const created = await db.transaction(async (tx) => {
        const [role] = await tx
          .select()
          .from(roles)
          .where(and(eq(roles.code, body.role_code.toUpperCase()), eq(roles.scope, "ORGANIZATION")))
          .limit(1);

        const [user] = await tx
          .insert(users)
          .values({
            fullName: body.full_name,
            email: body.email.trim().toLowerCase(),
            phone: body.mobile,
            passwordHash,
            isPlatformAdmin: false,
            status: "ACTIVE",
          })
          .returning();

        await tx.insert(organizationMembers).values({
          organizationId: ctx.organizationId,
          userId: user.id,
          isOwner: false,
          status: "ACTIVE",
        });

        if (role) {
          await tx.insert(userRoles).values({
            userId: user.id,
            roleId: role.id,
            organizationId: ctx.organizationId,
          });
        }

        const [emp] = await tx
          .insert(employees)
          .values({
            organizationId: ctx.organizationId,
            userId: user.id,
            employeeCode: body.employee_code.trim(),
            fullName: body.full_name,
            mobile: body.mobile,
            email: body.email.trim().toLowerCase(),
            roleId: role?.id ?? null,
            branchName: body.branch_name,
            allowedWarehouseIds: body.allowed_warehouse_ids,
            employmentStatus: "ACTIVE",
            hireDate: body.hire_date || new Date().toISOString().slice(0, 10),
            notes: body.notes ?? null,
          })
          .returning();

        return { employee: emp, user: { id: user.id, email: user.email, mobile: user.phone }, role_code: role?.code ?? null };
      });

      await recordAuditLog({
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorEmail: ctx.email,
        scope: "ORGANIZATION",
        action: "EMPLOYEE_CREATED",
        entityType: "EMPLOYEE",
        entityId: created.employee.id,
        ipAddress: ctx.ipAddress,
        metadata: { roleCode: body.role_code },
      });

      return ok(created, 201);
    }

    if (method === "PATCH" && seg1) {
      const body = z
        .object({
          employment_status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
          branch_name: z.string().optional(),
          allowed_warehouse_ids: z.array(z.string().uuid()).optional(),
        })
        .parse(await req.json());
      const [upd] = await db
        .update(employees)
        .set({
          ...(body.employment_status ? { employmentStatus: body.employment_status } : {}),
          ...(body.branch_name ? { branchName: body.branch_name } : {}),
          ...(body.allowed_warehouse_ids ? { allowedWarehouseIds: body.allowed_warehouse_ids } : {}),
        })
        .where(and(eq(employees.id, seg1), eq(employees.organizationId, ctx.organizationId)))
        .returning();
      return ok(upd);
    }
  }

  // GET /api/v1/documents/pdf?type=sales_invoice|quotation&id=... (§14 RTL Print/PDF Template)
  if (root === "documents" && seg1 === "pdf" && method === "GET") {
    const ctx = await requireOrgContext(req, "sales.view");
    const docType = req.nextUrl.searchParams.get("type") || "sales_invoice";
    const docId = req.nextUrl.searchParams.get("id");
    if (!docId) throw new ApiError(400, "DOCUMENT_ID_REQUIRED", "شناسه سند الزامی است.");

    const [orgProducts, orgContacts] = await Promise.all([
      db.select().from(products).where(eq(products.organizationId, ctx.organizationId)),
      db.select().from(contacts).where(eq(contacts.organizationId, ctx.organizationId)),
    ]);
    const pMap = new Map(orgProducts.map((p) => [p.id, p.name]));
    const cMap = new Map(orgContacts.map((c) => [c.id, c]));

    let title = "فاکتور فروش رسمی";
    let docNumber = "";
    let docDate = "";
    let customerName = "";
    let grandTotal = "0.00";
    let paidAmount = "0.00";
    let remainingAmount = "0.00";
    let rowsHtml = "";

    if (docType === "quotation") {
      const [q] = await db
        .select()
        .from(quotations)
        .where(and(eq(quotations.id, docId), eq(quotations.organizationId, ctx.organizationId)))
        .limit(1);
      if (!q) throw new ApiError(404, "QUOTATION_NOT_FOUND", "پیش‌فاکتور یافت نشد.");
      const qItems = await db.select().from(quotationItems).where(eq(quotationItems.quotationId, q.id));
      title = "پیش‌فاکتور فروش (Quotation)";
      docNumber = q.quotationNumber;
      docDate = q.issueDate;
      customerName = cMap.get(q.contactId)?.name ?? "";
      grandTotal = q.grandTotal;
      rowsHtml = qItems
        .map(
          (it, idx) =>
            `<tr><td>${idx + 1}</td><td>${pMap.get(it.productId) ?? ""}</td><td>${it.quantity}</td><td>${it.unitPrice}</td><td>${it.lineTotal}</td></tr>`
        )
        .join("");
    } else {
      const [inv] = await db
        .select()
        .from(salesInvoices)
        .where(and(eq(salesInvoices.id, docId), eq(salesInvoices.organizationId, ctx.organizationId)))
        .limit(1);
      if (!inv) throw new ApiError(404, "SALES_INVOICE_NOT_FOUND", "فاکتور فروش یافت نشد.");
      const [invItems, allocs] = await Promise.all([
        db.select().from(salesInvoiceItems).where(eq(salesInvoiceItems.salesInvoiceId, inv.id)),
        db.select().from(invoicePaymentAllocations).where(eq(invoicePaymentAllocations.salesInvoiceId, inv.id)),
      ]);
      docNumber = inv.invoiceNumber;
      docDate = inv.invoiceDate;
      customerName = cMap.get(inv.contactId)?.name ?? "";
      grandTotal = inv.totalAmount;
      paidAmount = inv.paidAmount;
      remainingAmount = inv.remainingAmount;
      rowsHtml = invItems
        .map(
          (it, idx) =>
            `<tr><td>${idx + 1}</td><td>${pMap.get(it.productId) ?? ""}</td><td>${it.quantity}</td><td>${it.unitPrice}</td><td>${it.lineTotal}</td></tr>`
        )
        .join("");
      if (allocs.length > 0) {
        rowsHtml += `<tr><td colspan="5" style="background:#f8fafc;font-size:12px">پرداخت‌ها: ${allocs.map((a) => `${a.paymentMethod}: ${a.amount}`).join(" | ")}</td></tr>`;
      }
    }

    const html = `<!doctype html>
<html lang="fa" dir="rtl"><head><meta charset="utf-8" /><title>${title} ${docNumber}</title>
<style>
  body { font-family: "Yekan Bakh", "bakh", "IRANSansWeb", "Vazirmatn", Tahoma, Arial, sans-serif; padding: 32px; color: #0f172a; background: #fff; font-variant-numeric: tabular-nums; }
  .header { display: flex; justify-content: space-between; border-bottom: 2px solid #0f172a; padding-bottom: 16px; margin-bottom: 20px; }
  table { width: 100%; border-collapse: collapse; margin-top: 16px; }
  th, td { border: 1px solid #cbd5e1; padding: 8px 10px; text-align: right; font-size: 13px; }
  th { background: #f1f5f9; }
  .totals { margin-top: 20px; max-width: 340px; margin-right: auto; border: 1px solid #cbd5e1; padding: 12px; border-radius: 8px; }
  @media print { .no-print { display: none; } }
</style></head>
<body>
  <button class="no-print" onclick="window.print()" style="margin-bottom:16px;padding:8px 16px;background:#0f172a;color:#fff;border:none;border-radius:6px;cursor:pointer">چاپ / ذخیره PDF</button>
  <div class="header">
    <div><h2 style="margin:0">${ctx.organization.name}</h2><div style="font-size:12px;color:#475569">${ctx.organization.legalName || ""} • ${ctx.organization.phone || ""}</div></div>
    <div style="text-align:left"><strong>${title}</strong><div style="font-size:12px">شماره: ${docNumber}</div><div style="font-size:12px">تاریخ: ${docDate}</div></div>
  </div>
  <div><strong>خریدار:</strong> ${customerName}</div>
  <table><thead><tr><th>#</th><th>شرح کالا</th><th>تعداد</th><th>قیمت واحد (${ctx.organization.baseCurrency})</th><th>جمع کل</th></tr></thead><tbody>${rowsHtml}</tbody></table>
  <div class="totals">
    <div>جمع کل قابل پرداخت: <strong>${grandTotal} ${ctx.organization.baseCurrency}</strong></div>
    ${docType !== "quotation" ? `<div>پرداخت‌شده: ${paidAmount} | مانده: <strong>${remainingAmount}</strong></div>` : ""}
  </div>
</body></html>`;

    return new NextResponse(html, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  throw new ApiError(404, "ROUTE_NOT_FOUND", "مسیر درخواستی یافت نشد.");
}

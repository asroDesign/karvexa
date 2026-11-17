import { NextRequest } from "next/server";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  barcodes,
  brands,
  categories,
  contactGroups,
  contacts,
  contactTransactions,
  productPrices,
  products,
  stockLedger,
  units,
} from "@/db/schema";
import { ensureSeeded } from "@/db/seed";
import { recordAuditLog } from "@/lib/audit";
import { addDec, formatDecimal, subDec } from "@/lib/decimal";
import {
  ApiError,
  applyListFilterAndPaginate,
  ok,
  okList,
  parseListQuery,
} from "@/lib/errors";
import { requireOrgContext } from "@/lib/tenant";
import { getLiveStockBalances } from "@/modules/inventory/service";
import { appendSyncChangeLog } from "@/modules/sync/changelog";

const createContactSchema = z.object({
  code: z.string().min(2),
  type: z.enum(["CUSTOMER", "SUPPLIER", "VENDOR", "BOTH", "EMPLOYEE", "OTHER"]).default("CUSTOMER"),
  display_name: z.string().min(2).optional(),
  name: z.string().min(2).optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  company_name: z.string().optional(),
  national_id: z.string().optional(),
  economic_code: z.string().optional(),
  mobile: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional().or(z.literal("")),
  address: z.string().optional(),
  postal_code: z.string().optional(),
  group_id: z.string().uuid().nullable().optional(),
  credit_limit: z.string().regex(/^\d+(\.\d{1,2})?$/).default("0.00"),
  opening_balance: z.string().regex(/^-?\d+(\.\d{1,2})?$/).default("0.00"),
  notes: z.string().optional(),
});

const createProductSchema = z.object({
  code: z.string().min(2).optional(),
  sku: z.string().min(2).optional(),
  name: z.string().min(2),
  description: z.string().optional(),
  item_type: z.enum(["PRODUCT", "SERVICE", "RAW_MATERIAL", "FINISHED_PRODUCT", "GOODS", "CONSIGNMENT"]).default("PRODUCT"),
  category_id: z.string().uuid().nullable().optional(),
  brand_id: z.string().uuid().nullable().optional(),
  barcode: z.string().optional(),
  base_unit_id: z.string().uuid(),
  purchase_price: z.string().regex(/^\d+(\.\d{1,2})?$/).default("0.00"),
  sale_price: z.string().regex(/^\d+(\.\d{1,2})?$/).default("0.00"),
  tax_rate: z.string().regex(/^\d+(\.\d{1,2})?$/).default("10.00"),
  minimum_stock: z.string().regex(/^\d+(\.\d{1,4})?$/).default("0.0000"),
  maximum_stock: z.string().regex(/^\d+(\.\d{1,4})?$/).default("0.0000"),
  track_inventory: z.boolean().default(true),
  allow_negative_stock: z.boolean().default(false),
  costing_method: z.enum(["FIFO", "WEIGHTED_AVERAGE"]).default("WEIGHTED_AVERAGE"),
  attributes: z.record(z.string(), z.unknown()).default({}),
});

export async function handleContactRoutes(
  req: NextRequest,
  method: string,
  segments: string[]
) {
  await ensureSeeded();
  const root = segments[0]; // contacts | contact-groups
  const id = segments[1];
  const sub = segments[2];

  // /api/v1/contact-groups
  if (root === "contact-groups") {
    if (method === "GET") {
      const ctx = await requireOrgContext(req, "contacts.view");
      const q = parseListQuery(req);
      const list = await db
        .select()
        .from(contactGroups)
        .where(eq(contactGroups.organizationId, ctx.organizationId));
      const { items, total } = applyListFilterAndPaginate(list, q, ["name"]);
      return okList(items, { page: q.page, perPage: q.perPage, total });
    }
    if (method === "POST") {
      const ctx = await requireOrgContext(req, "contacts.create", { requireActiveSubscription: true });
      const body = z.object({ name: z.string().min(2), description: z.string().optional() }).parse(await req.json());
      const [created] = await db
        .insert(contactGroups)
        .values({ organizationId: ctx.organizationId, name: body.name, description: body.description ?? null })
        .returning();
      return ok(created, 201);
    }
    if (method === "PATCH" && id) {
      const ctx = await requireOrgContext(req, "contacts.update", { requireActiveSubscription: true });
      const body = z.object({ name: z.string().min(2).optional(), description: z.string().optional() }).parse(await req.json());
      const [upd] = await db
        .update(contactGroups)
        .set({ ...(body.name ? { name: body.name } : {}), ...(body.description !== undefined ? { description: body.description } : {}) })
        .where(and(eq(contactGroups.id, id), eq(contactGroups.organizationId, ctx.organizationId)))
        .returning();
      return ok(upd);
    }
    if (method === "DELETE" && id) {
      const ctx = await requireOrgContext(req, "contacts.delete", { requireActiveSubscription: true });
      await db.delete(contactGroups).where(and(eq(contactGroups.id, id), eq(contactGroups.organizationId, ctx.organizationId)));
      return ok({ deleted_id: id });
    }
  }

  // /api/v1/contacts
  if (method === "GET" && !id) {
    const ctx = await requireOrgContext(req, "contacts.view");
    const q = parseListQuery(req);
    const [allContacts, groups, txs] = await Promise.all([
      db
        .select()
        .from(contacts)
        .where(and(eq(contacts.organizationId, ctx.organizationId), isNull(contacts.deletedAt)))
        .orderBy(desc(contacts.createdAt)),
      db.select().from(contactGroups).where(eq(contactGroups.organizationId, ctx.organizationId)),
      db.select().from(contactTransactions).where(eq(contactTransactions.organizationId, ctx.organizationId)),
    ]);

    const enriched = allContacts.map((c) => {
      let balance = addDec(c.openingBalance, "0");
      for (const t of txs.filter((x) => x.contactId === c.id)) {
        balance = subDec(addDec(balance, t.debit), t.credit);
      }
      return {
        id: c.id,
        organization_id: c.organizationId,
        code: c.code,
        type: c.contactType === "VENDOR" ? "SUPPLIER" : c.contactType,
        display_name: c.name,
        first_name: c.firstName,
        last_name: c.lastName,
        company_name: c.companyName,
        national_id: c.nationalCode,
        economic_code: c.economicCode,
        mobile: c.mobile,
        phone: c.phone,
        email: c.email,
        address: c.address,
        postal_code: c.postalCode,
        group_id: c.groupId,
        group_name: groups.find((g) => g.id === c.groupId)?.name ?? null,
        credit_limit: c.creditLimit,
        opening_balance: c.openingBalance,
        running_balance: formatDecimal(balance, 2),
        notes: c.notes,
        is_active: c.status === "ACTIVE",
        status: c.status,
        version: c.version,
        created_at: c.createdAt,
        updated_at: c.updatedAt,
      };
    });

    const { items, total } = applyListFilterAndPaginate(enriched, q, ["display_name", "code", "mobile"]);
    return okList(items, { page: q.page, perPage: q.perPage, total });
  }

  if (method === "POST" && !id) {
    const ctx = await requireOrgContext(req, "contacts.create", { requireActiveSubscription: true });
    const body = createContactSchema.parse(await req.json());
    const displayName = (body.display_name || body.name || `${body.first_name ?? ""} ${body.last_name ?? ""}`.trim()).trim();
    if (displayName.length < 2) {
      throw new ApiError(422, "VALIDATION_ERROR", "نام نمایشی طرف‌حساب الزامی است.", [
        { field: "display_name", code: "REQUIRED", message: "display_name is required" },
      ]);
    }

    const [created] = await db
      .insert(contacts)
      .values({
        organizationId: ctx.organizationId,
        code: body.code.trim(),
        name: displayName,
        firstName: body.first_name ?? null,
        lastName: body.last_name ?? null,
        companyName: body.company_name ?? null,
        contactType: body.type === "VENDOR" ? "SUPPLIER" : body.type,
        nationalCode: body.national_id ?? null,
        economicCode: body.economic_code ?? null,
        mobile: body.mobile ?? null,
        phone: body.phone ?? null,
        email: body.email || null,
        address: body.address ?? null,
        postalCode: body.postal_code ?? null,
        groupId: body.group_id ?? null,
        creditLimit: body.credit_limit,
        openingBalance: body.opening_balance,
        notes: body.notes ?? null,
        syncSeq: Date.now(),
      })
      .returning();

    await appendSyncChangeLog(db, {
      organizationId: ctx.organizationId,
      entityType: "contact",
      entityId: created.id,
      operation: "UPSERT",
      version: created.version,
      payload: {
        id: created.id,
        code: created.code,
        display_name: created.name,
        type: created.contactType,
        mobile: created.mobile,
        credit_limit: created.creditLimit,
        is_active: true,
      },
    });

    await recordAuditLog({
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      actorEmail: ctx.email,
      scope: "ORGANIZATION",
      action: "CONTACT_CREATED",
      entityType: "CONTACT",
      entityId: created.id,
      ipAddress: ctx.ipAddress,
    });

    return ok({ ...created, display_name: created.name, type: created.contactType }, 201);
  }

  if (id) {
    const ctx = await requireOrgContext(req, "contacts.view");
    const [contact] = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.id, id), eq(contacts.organizationId, ctx.organizationId)))
      .limit(1);
    if (!contact) throw new ApiError(404, "CONTACT_NOT_FOUND", "طرف‌حساب یافت نشد.");

    if (method === "GET" && !sub) {
      return ok({ ...contact, display_name: contact.name, type: contact.contactType });
    }

    if (method === "GET" && (sub === "transactions" || sub === "statement" || sub === "balance")) {
      const txs = await db
        .select()
        .from(contactTransactions)
        .where(
          and(
            eq(contactTransactions.organizationId, ctx.organizationId),
            eq(contactTransactions.contactId, contact.id)
          )
        )
        .orderBy(desc(contactTransactions.txDate));

      let running = addDec(contact.openingBalance, "0");
      let totalDebit = BigInt(0);
      let totalCredit = BigInt(0);
      for (const t of txs) {
        totalDebit = addDec(totalDebit, t.debit);
        totalCredit = addDec(totalCredit, t.credit);
        running = subDec(addDec(running, t.debit), t.credit);
      }

      if (sub === "balance") {
        return ok({
          contact_id: contact.id,
          opening_balance: contact.openingBalance,
          total_debit: formatDecimal(totalDebit, 2),
          total_credit: formatDecimal(totalCredit, 2),
          balance: formatDecimal(running, 2),
        });
      }
      if (sub === "statement") {
        return ok({
          contact: { id: contact.id, code: contact.code, display_name: contact.name },
          opening_balance: contact.openingBalance,
          closing_balance: formatDecimal(running, 2),
          transactions: txs,
        });
      }
      return ok(txs);
    }

    if (method === "PATCH" && !sub) {
      await requireOrgContext(req, "contacts.update", { requireActiveSubscription: true });
      const body = (await req.json()) as Record<string, unknown>;
      // Prompt 03 §9: Direct modification of opening_balance after activity is forbidden!
      if (body.opening_balance !== undefined && body.opening_balance !== contact.openingBalance) {
        const existingTx = await db
          .select({ id: contactTransactions.id })
          .from(contactTransactions)
          .where(eq(contactTransactions.contactId, contact.id))
          .limit(1);
        if (existingTx.length > 0) {
          throw new ApiError(
            422,
            "OPENING_BALANCE_LOCKED",
            "تغییر مستقیم مانده اول دوره پس از ثبت گردش مجاز نیست؛ از سند افتتاحیه یا اصلاحی حسابداری استفاده کنید."
          );
        }
      }
      const [upd] = await db
        .update(contacts)
        .set({
          ...(body.display_name ? { name: String(body.display_name) } : {}),
          ...(body.mobile !== undefined ? { mobile: String(body.mobile) } : {}),
          ...(body.credit_limit ? { creditLimit: String(body.credit_limit) } : {}),
          ...(body.notes !== undefined ? { notes: String(body.notes) } : {}),
          version: contact.version + 1,
          syncSeq: Date.now(),
          updatedAt: new Date(),
        })
        .where(eq(contacts.id, contact.id))
        .returning();
      return ok(upd);
    }

    if (method === "DELETE" && !sub) {
      await requireOrgContext(req, "contacts.delete", { requireActiveSubscription: true });
      const nextVer = contact.version + 1;
      await db
        .update(contacts)
        .set({ deletedAt: new Date(), status: "ARCHIVED", version: nextVer, syncSeq: Date.now() })
        .where(eq(contacts.id, contact.id));
      await appendSyncChangeLog(db, {
        organizationId: ctx.organizationId,
        entityType: "contact",
        entityId: contact.id,
        operation: "TOMBSTONE",
        version: nextVer,
        payload: { id: contact.id, is_deleted: true },
      });
      return ok({ deleted_id: contact.id });
    }
  }

  throw new ApiError(404, "ROUTE_NOT_FOUND", "مسیر طرف‌حساب‌ها یافت نشد.");
}

export async function handleCatalogRoutes(
  req: NextRequest,
  method: string,
  segments: string[]
) {
  await ensureSeeded();
  const root = segments[0]; // products | categories | brands | units
  const id = segments[1];
  const sub = segments[2];

  // /api/v1/categories
  if (root === "categories") {
    if (method === "GET") {
      const ctx = await requireOrgContext(req, "catalog.view");
      const list = await db.select().from(categories).where(eq(categories.organizationId, ctx.organizationId));
      return ok(list);
    }
    if (method === "POST") {
      const ctx = await requireOrgContext(req, "catalog.create", { requireActiveSubscription: true });
      const body = z.object({ name: z.string().min(2), code: z.string().optional(), parent_id: z.string().uuid().nullable().optional() }).parse(await req.json());
      const [c] = await db
        .insert(categories)
        .values({ organizationId: ctx.organizationId, name: body.name, code: body.code ?? null, parentId: body.parent_id ?? null })
        .returning();
      return ok(c, 201);
    }
    if (method === "PATCH" && id) {
      const ctx = await requireOrgContext(req, "catalog.update", { requireActiveSubscription: true });
      const body = (await req.json()) as { name?: string; code?: string };
      const [c] = await db
        .update(categories)
        .set({ ...(body.name ? { name: body.name } : {}), ...(body.code ? { code: body.code } : {}) })
        .where(and(eq(categories.id, id), eq(categories.organizationId, ctx.organizationId)))
        .returning();
      return ok(c);
    }
    if (method === "DELETE" && id) {
      const ctx = await requireOrgContext(req, "catalog.delete", { requireActiveSubscription: true });
      await db.delete(categories).where(and(eq(categories.id, id), eq(categories.organizationId, ctx.organizationId)));
      return ok({ deleted_id: id });
    }
  }

  // /api/v1/brands
  if (root === "brands") {
    if (method === "GET") {
      const ctx = await requireOrgContext(req, "catalog.view");
      return ok(await db.select().from(brands).where(eq(brands.organizationId, ctx.organizationId)));
    }
    if (method === "POST") {
      const ctx = await requireOrgContext(req, "catalog.create", { requireActiveSubscription: true });
      const body = z.object({ name: z.string().min(2) }).parse(await req.json());
      const [b] = await db.insert(brands).values({ organizationId: ctx.organizationId, name: body.name }).returning();
      return ok(b, 201);
    }
  }

  // /api/v1/units
  if (root === "units") {
    if (method === "GET") {
      const ctx = await requireOrgContext(req, "catalog.view");
      return ok(await db.select().from(units).where(eq(units.organizationId, ctx.organizationId)));
    }
    if (method === "POST") {
      const ctx = await requireOrgContext(req, "catalog.create", { requireActiveSubscription: true });
      const body = z.object({ name: z.string().min(1), symbol: z.string().min(1) }).parse(await req.json());
      const [u] = await db.insert(units).values({ organizationId: ctx.organizationId, name: body.name, symbol: body.symbol }).returning();
      return ok(u, 201);
    }
  }

  // GET /api/v1/products/barcode/{barcode}
  if (root === "products" && method === "GET" && id === "barcode" && sub) {
    const ctx = await requireOrgContext(req, "catalog.view");
    const [bc] = await db
      .select()
      .from(barcodes)
      .where(and(eq(barcodes.organizationId, ctx.organizationId), eq(barcodes.barcode, sub)))
      .limit(1);
    if (!bc) throw new ApiError(404, "BARCODE_NOT_FOUND", "کالایی با این بارکد یافت نشد.");
    const [prod] = await db.select().from(products).where(eq(products.id, bc.productId)).limit(1);
    return ok({ ...prod, barcode: bc.barcode, code: prod?.sku });
  }

  // /api/v1/products
  if (root === "products" && method === "GET" && !id) {
    const ctx = await requireOrgContext(req, "catalog.view");
    const q = parseListQuery(req);
    const [allProds, allCats, allBrands, allUnits, allBcs, stock] = await Promise.all([
      db
        .select()
        .from(products)
        .where(and(eq(products.organizationId, ctx.organizationId), isNull(products.deletedAt)))
        .orderBy(desc(products.createdAt)),
      db.select().from(categories).where(eq(categories.organizationId, ctx.organizationId)),
      db.select().from(brands).where(eq(brands.organizationId, ctx.organizationId)),
      db.select().from(units).where(eq(units.organizationId, ctx.organizationId)),
      db.select().from(barcodes).where(eq(barcodes.organizationId, ctx.organizationId)),
      getLiveStockBalances(ctx.organizationId),
    ]);

    const enriched = allProds.map((p) => {
      let totalQty = BigInt(0);
      for (const s of stock.balances.filter((b) => b.productId === p.id)) {
        totalQty = addDec(totalQty, s.onHandQty);
      }
      const primaryBc = allBcs.find((b) => b.productId === p.id)?.barcode ?? null;
      return {
        id: p.id,
        organization_id: p.organizationId,
        code: p.sku,
        sku: p.sku,
        name: p.name,
        description: p.description,
        item_type: p.productType,
        category_id: p.categoryId,
        category_name: allCats.find((c) => c.id === p.categoryId)?.name ?? null,
        brand_id: p.brandId,
        brand_name: allBrands.find((b) => b.id === p.brandId)?.name ?? null,
        barcode: primaryBc,
        base_unit_id: p.baseUnitId,
        unit_name: allUnits.find((u) => u.id === p.baseUnitId)?.name ?? "عدد",
        purchase_price: p.defaultPurchasePrice,
        sale_price: p.defaultSalePrice,
        tax_rate: p.taxRate,
        minimum_stock: p.minStockLevel,
        maximum_stock: p.maxStockLevel,
        track_inventory: p.trackInventory,
        allow_negative_stock: p.allowNegativeStock,
        costing_method: p.costingMethod,
        total_on_hand_qty: formatDecimal(totalQty, 4),
        is_active: p.isActive,
        attributes: p.attributes,
        version: p.version,
        created_at: p.createdAt,
        updated_at: p.updatedAt,
      };
    });

    const { items, total } = applyListFilterAndPaginate(enriched, q, ["name", "code", "barcode"]);
    return okList(items, { page: q.page, perPage: q.perPage, total });
  }

  if (root === "products" && method === "POST" && !id) {
    const ctx = await requireOrgContext(req, "catalog.create", { requireActiveSubscription: true });
    const body = createProductSchema.parse(await req.json());
    const sku = (body.code || body.sku || "").trim();
    if (sku.length < 2) {
      throw new ApiError(422, "VALIDATION_ERROR", "کد کالا (code/sku) الزامی است.");
    }

    const created = await db.transaction(async (tx) => {
      const [prod] = await tx
        .insert(products)
        .values({
          organizationId: ctx.organizationId,
          sku,
          name: body.name.trim(),
          description: body.description ?? null,
          productType: body.item_type,
          categoryId: body.category_id ?? null,
          brandId: body.brand_id ?? null,
          baseUnitId: body.base_unit_id,
          defaultPurchasePrice: body.purchase_price,
          defaultSalePrice: body.sale_price,
          taxRate: body.tax_rate,
          minStockLevel: body.minimum_stock,
          maxStockLevel: body.maximum_stock,
          trackInventory: body.track_inventory,
          allowNegativeStock: body.allow_negative_stock,
          costingMethod: body.costing_method,
          attributes: body.attributes,
          syncSeq: Date.now(),
        })
        .returning();

      if (body.barcode?.trim()) {
        await tx.insert(barcodes).values({
          organizationId: ctx.organizationId,
          productId: prod.id,
          barcode: body.barcode.trim(),
          isPrimary: true,
        });
      }
      return prod;
    });

    return ok({ ...created, code: created.sku }, 201);
  }

  if (root === "products" && id) {
    const ctx = await requireOrgContext(req, "catalog.view");
    const [prod] = await db
      .select()
      .from(products)
      .where(and(eq(products.id, id), eq(products.organizationId, ctx.organizationId)))
      .limit(1);
    if (!prod) throw new ApiError(404, "PRODUCT_NOT_FOUND", "کالا یافت نشد.");

    if (method === "GET" && !sub) return ok({ ...prod, code: prod.sku });

    if (method === "GET" && sub === "stock") {
      const stock = await getLiveStockBalances(ctx.organizationId);
      return ok(stock.balances.filter((b) => b.productId === prod.id));
    }

    if (method === "GET" && sub === "movements") {
      const rows = await db
        .select()
        .from(stockLedger)
        .where(and(eq(stockLedger.organizationId, ctx.organizationId), eq(stockLedger.productId, prod.id)))
        .orderBy(desc(stockLedger.createdAt))
        .limit(100);
      return ok(rows);
    }

    if (sub === "prices") {
      if (method === "GET") {
        return ok(
          await db
            .select()
            .from(productPrices)
            .where(and(eq(productPrices.organizationId, ctx.organizationId), eq(productPrices.productId, prod.id)))
        );
      }
      if (method === "POST") {
        await requireOrgContext(req, "catalog.update", { requireActiveSubscription: true });
        const body = z
          .object({
            price_list_name: z.string().default("عمده"),
            price: z.string().regex(/^\d+(\.\d{1,2})?$/),
            currency: z.string().default("IRR"),
          })
          .parse(await req.json());
        const [p] = await db
          .insert(productPrices)
          .values({
            organizationId: ctx.organizationId,
            productId: prod.id,
            priceListName: body.price_list_name,
            price: body.price,
            currency: body.currency,
          })
          .returning();
        return ok(p, 201);
      }
    }

    if (method === "PATCH" && !sub) {
      await requireOrgContext(req, "catalog.update", { requireActiveSubscription: true });
      const body = (await req.json()) as Record<string, unknown>;
      const [upd] = await db
        .update(products)
        .set({
          ...(body.name ? { name: String(body.name) } : {}),
          ...(body.sale_price ? { defaultSalePrice: String(body.sale_price) } : {}),
          ...(body.purchase_price ? { defaultPurchasePrice: String(body.purchase_price) } : {}),
          version: prod.version + 1,
          syncSeq: Date.now(),
          updatedAt: new Date(),
        })
        .where(eq(products.id, prod.id))
        .returning();
      return ok(upd);
    }

    if (method === "DELETE" && !sub) {
      await requireOrgContext(req, "catalog.delete", { requireActiveSubscription: true });
      await db
        .update(products)
        .set({ deletedAt: new Date(), isActive: false, syncSeq: Date.now() })
        .where(eq(products.id, prod.id));
      return ok({ deleted_id: prod.id });
    }
  }

  throw new ApiError(404, "ROUTE_NOT_FOUND", "مسیر کاتالوگ یافت نشد.");
}

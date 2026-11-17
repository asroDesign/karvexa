import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  accounts,
  consignmentDocuments,
  consignmentItems,
  consignmentLedger,
  contacts,
  contactTransactions,
  products,
  warehouses,
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
import { createJournalEntryTx } from "@/modules/accounting/service";
import { appendSyncChangeLog } from "@/modules/sync/changelog";

export type ConsignmentDocType =
  | "CONSIGNMENT_IN"
  | "CONSIGNMENT_OUT"
  | "CONSIGNMENT_SALE"
  | "CONSIGNMENT_RETURN";

/**
 * Computes current consignment balance per (rootAgreementId, productId, variantId) strictly from `consignment_ledger`.
 */
async function getConsignmentAvailableTx(
  tx: Parameters<Parameters<typeof withTenantTransaction>[1]>[0],
  organizationId: string,
  rootAgreementId: string,
  productId: string,
  variantId?: string | null
) {
  const rows = await tx
    .select()
    .from(consignmentLedger)
    .where(
      and(
        eq(consignmentLedger.organizationId, organizationId),
        eq(consignmentLedger.rootAgreementId, rootAgreementId),
        eq(consignmentLedger.productId, productId)
      )
    );

  let bal = BigInt(0);
  for (const r of rows) {
    if ((r.variantId ?? null) === (variantId ?? null)) {
      bal = addDec(bal, r.quantityDelta);
    }
  }
  return bal;
}

export async function createConsignmentDocument(params: {
  organizationId: string;
  documentType: ConsignmentDocType;
  contactId: string;
  warehouseId: string;
  relatedDocumentId?: string | null;
  documentDate: string;
  commissionRate?: string;
  receiptUrl?: string | null;
  notes?: string;
  actorUserId: string;
  actorEmail: string;
  ipAddress?: string | null;
  items: Array<{
    product_id: string;
    product_variant_id?: string | null;
    warehouse_id?: string | null;
    quantity: string;
    agreed_unit_price: string;
  }>;
}) {
  if (
    (params.documentType === "CONSIGNMENT_SALE" || params.documentType === "CONSIGNMENT_RETURN") &&
    !params.relatedDocumentId
  ) {
    throw new ApiError(
      422,
      "RELATED_CONSIGNMENT_REQUIRED",
      `برای ثبت ${params.documentType} ارسال شناسه سند امانی مرجع (related_document_id) الزامی است.`
    );
  }

  const created = await withTenantTransaction(params.organizationId, async (tx) => {
    let ownershipScope: "THIRD_PARTY_HELD" | "OWNED_AT_AGENT" =
      params.documentType === "CONSIGNMENT_OUT" ? "OWNED_AT_AGENT" : "THIRD_PARTY_HELD";
    let direction: "IN" | "OUT" = params.documentType === "CONSIGNMENT_OUT" ? "OUT" : "IN";
    let inheritedCommission = params.commissionRate ?? "10.00";

    if (params.relatedDocumentId) {
      const [rel] = await tx
        .select()
        .from(consignmentDocuments)
        .where(
          and(
            eq(consignmentDocuments.id, params.relatedDocumentId),
            eq(consignmentDocuments.organizationId, params.organizationId)
          )
        )
        .limit(1);
      if (!rel) {
        throw new ApiError(404, "RELATED_CONSIGNMENT_NOT_FOUND", "سند امانی مرجع یافت نشد.");
      }
      ownershipScope = (rel.ownershipScope as "THIRD_PARTY_HELD" | "OWNED_AT_AGENT") || "THIRD_PARTY_HELD";
      direction = (rel.direction as "IN" | "OUT") || "IN";
      if (!params.commissionRate) inheritedCommission = rel.commissionRate;
    }

    let totalVal = BigInt(0);
    for (const it of params.items) {
      if (!isPositiveDec(parseDecimal(it.quantity))) {
        throw new ApiError(422, "QUANTITY_INVALID", "مقدار ردیف امانی باید بزرگ‌تر از صفر باشد.");
      }
      totalVal = addDec(totalVal, mulDec(it.quantity, it.agreed_unit_price));
    }

    const prefixMap: Record<ConsignmentDocType, string> = {
      CONSIGNMENT_IN: "CN-IN",
      CONSIGNMENT_OUT: "CN-OUT",
      CONSIGNMENT_SALE: "CN-SL",
      CONSIGNMENT_RETURN: "CN-RT",
    };

    const [doc] = await tx
      .insert(consignmentDocuments)
      .values({
        organizationId: params.organizationId,
        contactId: params.contactId,
        warehouseId: params.warehouseId,
        documentNumber: `${prefixMap[params.documentType]}-${Date.now().toString().slice(-6)}`,
        documentType: params.documentType,
        direction,
        ownershipScope,
        relatedDocumentId: params.relatedDocumentId ?? null,
        relatedDocumentType: params.relatedDocumentId ? "CONSIGNMENT" : null,
        documentDate: params.documentDate,
        commissionRate: inheritedCommission,
        totalValue: formatDecimal(totalVal, 2),
        status: "DRAFT",
        receiptUrl: params.receiptUrl ?? null,
        notes: params.notes ?? null,
        createdBy: params.actorUserId,
      })
      .returning();

    const savedItems = await tx
      .insert(consignmentItems)
      .values(
        params.items.map((it) => ({
          organizationId: params.organizationId,
          consignmentDocumentId: doc.id,
          productId: it.product_id,
          variantId: it.product_variant_id ?? null,
          warehouseId: it.warehouse_id ?? params.warehouseId,
          quantityReceived: it.quantity,
          agreedUnitPrice: it.agreed_unit_price,
        }))
      )
      .returning();

    await appendSyncChangeLog(tx, {
      organizationId: params.organizationId,
      entityType: "consignment_document",
      entityId: doc.id,
      operation: "UPSERT",
      version: doc.version,
      payload: {
        id: doc.id,
        document_number: doc.documentNumber,
        document_type: doc.documentType,
        ownership_scope: doc.ownershipScope,
        status: doc.status,
        total_value: doc.totalValue,
      },
    });

    return { document: doc, items: savedItems };
  });

  await recordAuditLog({
    organizationId: params.organizationId,
    actorUserId: params.actorUserId,
    actorEmail: params.actorEmail,
    scope: "ORGANIZATION",
    action: "CONSIGNMENT_CREATED",
    entityType: "CONSIGNMENT_DOCUMENT",
    entityId: created.document.id,
    ipAddress: params.ipAddress,
    metadata: { documentType: params.documentType, totalValue: created.document.totalValue },
  });

  return created;
}

/**
 * Master Prompt 07 §5.3 — Confirm Consignment Document with Strict Ownership & Balance Rules:
 * - CONSIGNMENT_IN: adds +qty to `consignment_ledger` (`THIRD_PARTY_HELD`), NEVER touches owned Inventory or Revenue!
 * - CONSIGNMENT_OUT: adds +qty to `consignment_ledger` (`OWNED_AT_AGENT`).
 * - CONSIGNMENT_SALE: verifies remaining balance in `consignment_ledger`, deducts -qty, posts ownership-accurate journal
 *   (for THIRD_PARTY_HELD: DR AR/Cash gross, CR Service/Commission Revenue (commission), CR AP Consignor (net payable)!).
 * - CONSIGNMENT_RETURN: verifies remaining balance in `consignment_ledger`, deducts -qty, ZERO fake sales/cost!
 */
export async function confirmConsignmentDocument(params: {
  organizationId: string;
  documentId: string;
  actorUserId: string;
  actorEmail: string;
  ipAddress?: string | null;
}) {
  const result = await withTenantTransaction(params.organizationId, async (tx) => {
    const [doc] = await tx
      .select()
      .from(consignmentDocuments)
      .where(
        and(
          eq(consignmentDocuments.id, params.documentId),
          eq(consignmentDocuments.organizationId, params.organizationId)
        )
      )
      .limit(1);

    if (!doc) throw new ApiError(404, "CONSIGNMENT_NOT_FOUND", "سند امانی یافت نشد.");
    if (doc.status === "CONFIRMED" || doc.status === "SETTLED") {
      throw new ApiError(
        409,
        "CONSIGNMENT_ALREADY_CONFIRMED",
        "این سند امانی قبلاً تأیید شده است و امکان تأیید مجدد وجود ندارد."
      );
    }

    const items = await tx
      .select()
      .from(consignmentItems)
      .where(eq(consignmentItems.consignmentDocumentId, doc.id));

    const rootAgreementId = doc.relatedDocumentId ?? doc.id;
    const isReduction =
      doc.documentType === "CONSIGNMENT_SALE" || doc.documentType === "CONSIGNMENT_RETURN";

    const ledgerEntries = [];
    for (const it of items) {
      const qtyDec = parseDecimal(it.quantityReceived);
      if (isReduction) {
        const availableConsign = await getConsignmentAvailableTx(
          tx,
          params.organizationId,
          rootAgreementId,
          it.productId,
          it.variantId
        );
        if (gtDec(qtyDec, availableConsign)) {
          throw new ApiError(
            409,
            "CONSIGNMENT_INSUFFICIENT_BALANCE",
            `موجودی امانی کافی نیست (مانده امانی مجاز: ${formatDecimal(availableConsign, 4)}، درخواستی: ${it.quantityReceived}).`
          );
        }

        // Update root consignment item sold/returned counters if present
        const [rootItem] = await tx
          .select()
          .from(consignmentItems)
          .where(
            and(
              eq(consignmentItems.consignmentDocumentId, rootAgreementId),
              eq(consignmentItems.productId, it.productId)
            )
          )
          .limit(1);
        if (rootItem) {
          await tx
            .update(consignmentItems)
            .set(
              doc.documentType === "CONSIGNMENT_SALE"
                ? { quantitySold: formatDecimal(addDec(rootItem.quantitySold, qtyDec), 4) }
                : { quantityReturned: formatDecimal(addDec(rootItem.quantityReturned, qtyDec), 4) }
            )
            .where(eq(consignmentItems.id, rootItem.id));
        }
      }

      const delta = isReduction ? -qtyDec : qtyDec;
      const [led] = await tx
        .insert(consignmentLedger)
        .values({
          organizationId: params.organizationId,
          consignmentDocumentId: doc.id,
          rootAgreementId,
          contactId: doc.contactId,
          warehouseId: it.warehouseId ?? doc.warehouseId,
          productId: it.productId,
          variantId: it.variantId ?? null,
          ownershipScope: doc.ownershipScope,
          eventType: doc.documentType,
          quantityDelta: formatDecimal(delta, 4),
          agreedUnitPrice: it.agreedUnitPrice,
          eventDate: doc.documentDate,
        })
        .returning();
      ledgerEntries.push(led);
    }

    // Ownership-Accurate Accounting Impact:
    // - CONSIGNMENT_IN / CONSIGNMENT_OUT / CONSIGNMENT_RETURN -> NO owned Inventory/Revenue distortion!
    // - CONSIGNMENT_SALE -> Posts real ownership-respecting journal!
    let journalEntry = null;
    if (doc.documentType === "CONSIGNMENT_SALE" && isPositiveDec(parseDecimal(doc.totalValue))) {
      const orgAccs = await tx.select().from(accounts).where(eq(accounts.organizationId, params.organizationId));
      const byRole = new Map(orgAccs.filter((a) => a.systemRole).map((a) => [a.systemRole!, a]));
      const arAcc = byRole.get("AR");
      const apAcc = byRole.get("AP");
      const commRevAcc = byRole.get("SERVICE_REVENUE") ?? byRole.get("SALES_REVENUE");
      const salesRevAcc = byRole.get("SALES_REVENUE");

      if (doc.ownershipScope === "THIRD_PARTY_HELD" && arAcc && apAcc && commRevAcc) {
        // Selling someone else's consignment goods -> we earn ONLY Commission Revenue, and owe Consignor the Net Payable!
        const rateFrac = mulDec(doc.commissionRate, "0.01");
        const commissionDec = mulDec(doc.totalValue, rateFrac);
        const netPayableDec = subDec(doc.totalValue, commissionDec);

        const jr = await createJournalEntryTx(tx, {
          organizationId: params.organizationId,
          actorUserId: params.actorUserId,
          actorEmail: params.actorEmail,
          entryDate: doc.documentDate,
          description: `فروش کالای امانی دریافتی (${doc.documentNumber}) — شناسایی کارمزد و بدهی امانت‌گذار`,
          referenceType: "CONSIGNMENT_SALE",
          referenceId: doc.id,
          postImmediately: true,
          lines: [
            { accountId: arAcc.id, debit: doc.totalValue, credit: "0.00", description: "مطالبه/وجه فروش کالای امانی" },
            ...(isPositiveDec(commissionDec)
              ? [
                  {
                    accountId: commRevAcc.id,
                    debit: "0.00",
                    credit: formatDecimal(commissionDec, 2),
                    description: `درآمد کارمزد امانی (${doc.commissionRate}٪)`,
                  },
                ]
              : []),
            {
              accountId: apAcc.id,
              contactId: doc.contactId,
              debit: "0.00",
              credit: formatDecimal(netPayableDec, 2),
              description: "بستانکاری امانت‌گذار بابت فروش کالای امانی",
            },
          ],
        });
        journalEntry = jr.entry;

        await tx.insert(contactTransactions).values({
          organizationId: params.organizationId,
          contactId: doc.contactId,
          referenceType: "CONSIGNMENT_SALE",
          referenceId: doc.id,
          txDate: doc.documentDate,
          debit: "0.00",
          credit: formatDecimal(netPayableDec, 2),
          description: `بستانکاری امانت‌گذار بابت فروش ${doc.documentNumber}`,
        });
      } else if (doc.ownershipScope === "OWNED_AT_AGENT" && arAcc && salesRevAcc) {
        const jr = await createJournalEntryTx(tx, {
          organizationId: params.organizationId,
          actorUserId: params.actorUserId,
          actorEmail: params.actorEmail,
          entryDate: doc.documentDate,
          description: `تحقق فروش کالای امانی تحویلی نزد نماینده (${doc.documentNumber})`,
          referenceType: "CONSIGNMENT_SALE",
          referenceId: doc.id,
          postImmediately: true,
          lines: [
            { accountId: arAcc.id, contactId: doc.contactId, debit: doc.totalValue, credit: "0.00", description: "بدهکاری نماینده امانی" },
            { accountId: salesRevAcc.id, debit: "0.00", credit: doc.totalValue, description: "درآمد فروش کالای امانی تحویلی" },
          ],
        });
        journalEntry = jr.entry;
      }
    }

    const [confirmed] = await tx
      .update(consignmentDocuments)
      .set({
        status: "CONFIRMED",
        journalEntryId: journalEntry?.id ?? null,
        version: doc.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(consignmentDocuments.id, doc.id))
      .returning();

    await appendSyncChangeLog(tx, {
      organizationId: params.organizationId,
      entityType: "consignment_document",
      entityId: confirmed.id,
      operation: "UPSERT",
      version: confirmed.version,
      payload: {
        id: confirmed.id,
        document_number: confirmed.documentNumber,
        document_type: confirmed.documentType,
        ownership_scope: confirmed.ownershipScope,
        status: confirmed.status,
      },
    });

    return { document: confirmed, ledger_entries: ledgerEntries, journal_entry: journalEntry };
  });

  await recordAuditLog({
    organizationId: params.organizationId,
    actorUserId: params.actorUserId,
    actorEmail: params.actorEmail,
    scope: "ORGANIZATION",
    action: "CONSIGNMENT_CONFIRMED",
    entityType: "CONSIGNMENT_DOCUMENT",
    entityId: params.documentId,
    ipAddress: params.ipAddress,
    metadata: { documentType: result.document.documentType, journalEntryId: result.journal_entry?.id ?? null },
  });

  return result;
}

/**
 * Report: Consignment Inventory Balances strictly separated by ownership:
 * - third_party_held_by_us (goods owned by consignors held in our warehouses)
 * - owned_by_us_at_agents (goods owned by us held at external agents)
 */
export async function getConsignmentBalancesReport(organizationId: string) {
  const [rows, orgContacts, orgProducts, orgWarehouses] = await Promise.all([
    db.select().from(consignmentLedger).where(eq(consignmentLedger.organizationId, organizationId)),
    db.select().from(contacts).where(eq(contacts.organizationId, organizationId)),
    db.select().from(products).where(eq(products.organizationId, organizationId)),
    db.select().from(warehouses).where(eq(warehouses.organizationId, organizationId)),
  ]);

  const cMap = new Map(orgContacts.map((c) => [c.id, c.name]));
  const pMap = new Map(orgProducts.map((p) => [p.id, p]));
  const wMap = new Map(orgWarehouses.map((w) => [w.id, w.name]));

  const agg = new Map<
    string,
    {
      root_agreement_id: string;
      ownership_scope: string;
      contact_id: string;
      contact_name: string;
      warehouse_id: string;
      warehouse_name: string;
      product_id: string;
      product_name: string;
      variant_id: string | null;
      qty: bigint;
      unit_price: string;
    }
  >();

  for (const r of rows) {
    const key = `${r.rootAgreementId}:${r.productId}:${r.variantId ?? "BASE"}`;
    const cur = agg.get(key) ?? {
      root_agreement_id: r.rootAgreementId,
      ownership_scope: r.ownershipScope,
      contact_id: r.contactId,
      contact_name: cMap.get(r.contactId) ?? "",
      warehouse_id: r.warehouseId,
      warehouse_name: wMap.get(r.warehouseId) ?? "",
      product_id: r.productId,
      product_name: pMap.get(r.productId)?.name ?? "",
      variant_id: r.variantId ?? null,
      qty: BigInt(0),
      unit_price: r.agreedUnitPrice,
    };
    cur.qty = addDec(cur.qty, r.quantityDelta);
    agg.set(key, cur);
  }

  const all = Array.from(agg.values()).map(({ qty, ...rest }) => ({
    ...rest,
    remaining_qty: formatDecimal(qty, 4),
    estimated_value: formatDecimal(mulDec(qty, rest.unit_price), 2),
  }));

  return {
    third_party_held_by_us: all.filter((x) => x.ownership_scope === "THIRD_PARTY_HELD"),
    owned_by_us_at_agents: all.filter((x) => x.ownership_scope === "OWNED_AT_AGENT"),
  };
}

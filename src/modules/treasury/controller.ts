import { NextRequest } from "next/server";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  accounts,
  chequeEvents,
  cheques,
  contacts,
  financialAccounts,
  financialTransactions,
  invoicePaymentAllocations,
} from "@/db/schema";
import { ensureSeeded } from "@/db/seed";
import { ensurePrompt05OrgDefaults } from "@/db/seed-prompt05";
import { recordAuditLog } from "@/lib/audit";
import { addDec, formatDecimal, isNegativeDec, isPositiveDec, parseDecimal, subDec } from "@/lib/decimal";
import {
  ApiError,
  applyListFilterAndPaginate,
  ok,
  okList,
  parseListQuery,
} from "@/lib/errors";
import { gregorianIsoToJalali, resolveCanonicalDate } from "@/lib/jalali";
import { requireOrgContext, withTenantTransaction } from "@/lib/tenant";
import { createJournalEntryTx } from "@/modules/accounting/service";

const createFinAccountSchema = z.object({
  name: z.string().min(2),
  account_type: z.enum(["CASH", "CASHBOX", "BANK", "CARD_TERMINAL", "POS", "WALLET", "OTHER_TREASURY"]).default("BANK"),
  bank_name: z.string().optional(),
  account_number: z.string().optional(),
  iban: z.string().optional(),
  currency: z.string().default("IRR"),
  opening_balance: z.string().regex(/^\d+(\.\d{1,2})?$/).default("0.00"),
});

const treasuryTxSchema = z.object({
  account_id: z.string().uuid(),
  destination_account_id: z.string().uuid().optional(),
  contact_id: z.string().uuid().nullable().optional(),
  amount: z.string().regex(/^\d+(\.\d{1,2})?$/),
  currency: z.string().default("IRR"),
  transaction_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  payment_method: z.enum(["CASH", "BANK_TRANSFER", "CARD", "CHEQUE", "OTHER"]).default("BANK_TRANSFER"),
  reference_number: z.string().optional(),
  related_document_type: z.string().optional(),
  related_document_id: z.string().uuid().optional(),
  description: z.string().min(2),
});

const createChequeSchema = z.object({
  cheque_number: z.string().min(3),
  serial_number: z.string().min(2),
  bank_name: z.string().min(2),
  branch_name: z.string().optional(),
  account_number: z.string().optional(),
  drawer_name: z.string().optional(),
  recipient_name: z.string().optional(),
  amount: z.string().regex(/^\d+(\.\d{1,2})?$/),
  issue_date: z.string().optional(),
  issue_date_jalali: z.string().optional(),
  due_date: z.string().optional(),
  due_date_jalali: z.string().optional(),
  contact_id: z.string().uuid().nullable().optional(),
  direction: z.enum(["RECEIVABLE", "PAYABLE"]).default("RECEIVABLE"),
  related_document_type: z.string().optional(),
  related_document_id: z.string().uuid().optional(),
  as_draft: z.boolean().default(false),
  notes: z.string().optional(),
});

export async function handleTreasuryRoutes(
  req: NextRequest,
  method: string,
  segments: string[]
) {
  await ensureSeeded();
  const sub = segments[1]; // accounts | transactions | receipts | payments | transfers | expenses | incomes
  const id = segments[2];
  const action = segments[3];

  // /api/v1/treasury/accounts (Prompt 08 §2.10: Add, Edit metadata, Transaction History, Deletion Guard!)
  if (sub === "accounts") {
    if (method === "GET" && !id) {
      const ctx = await requireOrgContext(req, "treasury.view");
      return ok(
        await db
          .select()
          .from(financialAccounts)
          .where(eq(financialAccounts.organizationId, ctx.organizationId))
      );
    }
    if (method === "POST" && !id) {
      const ctx = await requireOrgContext(req, "treasury.accounts.manage", { requireActiveSubscription: true });
      const body = createFinAccountSchema.parse(await req.json());
      const normType =
        body.account_type === "CASH"
          ? "CASHBOX"
          : body.account_type === "CARD_TERMINAL"
            ? "POS"
            : body.account_type;

      const created = await withTenantTransaction(ctx.organizationId, async (tx) => {
        const orgAccs = await tx.select().from(accounts).where(eq(accounts.organizationId, ctx.organizationId));
        const glAcc = orgAccs.find((a) => a.systemRole === (normType === "CASHBOX" ? "CASH" : "BANK"));
        const capAcc = orgAccs.find((a) => a.systemRole === "CAPITAL");

        const [finAcc] = await tx
          .insert(financialAccounts)
          .values({
            organizationId: ctx.organizationId,
            accountId: glAcc?.id ?? null,
            name: body.name.trim(),
            accountType: normType,
            bankName: body.bank_name ?? null,
            accountNumber: body.account_number ?? null,
            iban: body.iban ?? null,
            currency: body.currency,
            openingBalance: body.opening_balance,
            balance: body.opening_balance,
          })
          .returning();

        // If opening_balance > 0, record formal Opening Journal!
        if (isPositiveDec(parseDecimal(body.opening_balance)) && glAcc && capAcc) {
          await createJournalEntryTx(tx, {
            organizationId: ctx.organizationId,
            actorUserId: ctx.userId,
            actorEmail: ctx.email,
            entryDate: new Date().toISOString().slice(0, 10),
            description: `مانده اول دوره حساب خزانه (${finAcc.name})`,
            referenceType: "OPENING",
            referenceId: finAcc.id,
            postImmediately: true,
            lines: [
              { accountId: glAcc.id, debit: body.opening_balance, credit: "0.00", description: `افتتاحیه ${finAcc.name}` },
              { accountId: capAcc.id, debit: "0.00", credit: body.opening_balance, description: `تعدیل سرمایه بابت افتتاحیه ${finAcc.name}` },
            ],
          });
        }

        return finAcc;
      });

      await recordAuditLog({
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorEmail: ctx.email,
        scope: "ORGANIZATION",
        action: "TREASURY_ACCOUNT_CREATED",
        entityType: "FINANCIAL_ACCOUNT",
        entityId: created.id,
        ipAddress: ctx.ipAddress,
        metadata: { name: created.name, accountType: created.accountType, openingBalance: created.openingBalance },
      });

      return ok(created, 201);
    }
    if (id) {
      const ctx = await requireOrgContext(req, "treasury.view");
      const [acc] = await db
        .select()
        .from(financialAccounts)
        .where(and(eq(financialAccounts.id, id), eq(financialAccounts.organizationId, ctx.organizationId)))
        .limit(1);
      if (!acc) throw new ApiError(404, "TREASURY_ACCOUNT_NOT_FOUND", "حساب خزانه یافت نشد.");

      // GET /api/v1/treasury/accounts/{id}/transactions?date_from=&date_to=&tx_type=
      if (method === "GET" && action === "transactions") {
        await requireOrgContext(req, "treasury.transactions.view");
        const sp = req.nextUrl.searchParams;
        const dateFrom = sp.get("date_from");
        const dateTo = sp.get("date_to");
        const txType = sp.get("tx_type");

        const conds = [
          eq(financialTransactions.organizationId, ctx.organizationId),
          eq(financialTransactions.financialAccountId, acc.id),
        ];
        if (dateFrom) conds.push(gte(financialTransactions.txDate, resolveCanonicalDate(dateFrom)));
        if (dateTo) conds.push(lte(financialTransactions.txDate, resolveCanonicalDate(dateTo)));
        if (txType) conds.push(eq(financialTransactions.txType, txType.toUpperCase()));

        const txs = await db
          .select()
          .from(financialTransactions)
          .where(and(...conds))
          .orderBy(desc(financialTransactions.txDate), desc(financialTransactions.createdAt));

        return ok({
          account: acc,
          opening_balance: acc.openingBalance,
          current_balance: acc.balance,
          transactions: txs.map((t) => ({
            ...t,
            tx_date_jalali: gregorianIsoToJalali(t.txDate),
          })),
        });
      }

      if (method === "GET" && !action) return ok(acc);

      // PUT/PATCH metadata ONLY (NEVER overwrites balance or historical transactions!)
      if ((method === "PATCH" || method === "PUT") && !action) {
        await requireOrgContext(req, "treasury.accounts.manage", { requireActiveSubscription: true });
        const body = z
          .object({
            name: z.string().min(2).optional(),
            bank_name: z.string().nullable().optional(),
            account_number: z.string().nullable().optional(),
            iban: z.string().nullable().optional(),
            is_active: z.boolean().optional(),
          })
          .parse(await req.json());

        const [upd] = await db
          .update(financialAccounts)
          .set({
            ...(body.name ? { name: body.name.trim() } : {}),
            ...(body.bank_name !== undefined ? { bankName: body.bank_name } : {}),
            ...(body.account_number !== undefined ? { accountNumber: body.account_number } : {}),
            ...(body.iban !== undefined ? { iban: body.iban } : {}),
            ...(body.is_active !== undefined ? { isActive: body.is_active } : {}),
            version: acc.version + 1,
            updatedAt: new Date(),
          })
          .where(eq(financialAccounts.id, acc.id))
          .returning();

        await recordAuditLog({
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          actorEmail: ctx.email,
          scope: "ORGANIZATION",
          action: "TREASURY_ACCOUNT_METADATA_UPDATED",
          entityType: "FINANCIAL_ACCOUNT",
          entityId: acc.id,
          ipAddress: ctx.ipAddress,
          metadata: { before: { name: acc.name, iban: acc.iban }, after: { name: upd.name, iban: upd.iban } },
        });
        return ok(upd);
      }

      // DELETE guard: MUST NOT delete treasury account if it has ANY financial history!
      if (method === "DELETE" && !action) {
        await requireOrgContext(req, "treasury.accounts.manage", { requireActiveSubscription: true });
        const [hasFinTx, hasAlloc] = await Promise.all([
          db
            .select({ id: financialTransactions.id })
            .from(financialTransactions)
            .where(eq(financialTransactions.financialAccountId, acc.id))
            .limit(1),
          db
            .select({ id: invoicePaymentAllocations.id })
            .from(invoicePaymentAllocations)
            .where(eq(invoicePaymentAllocations.financialAccountId, acc.id))
            .limit(1),
        ]);
        if (hasFinTx.length > 0 || hasAlloc.length > 0) {
          throw new ApiError(
            409,
            "TREASURY_ACCOUNT_HAS_HISTORY",
            "حساب خزانه‌ای که دارای گردش مالی است قابل حذف نیست؛ می‌توانید آن را غیرفعال (is_active=false) کنید."
          );
        }
        await db.delete(financialAccounts).where(eq(financialAccounts.id, acc.id));
        return ok({ deleted_id: acc.id });
      }
    }
  }

  // /api/v1/treasury/transactions
  if (sub === "transactions") {
    const ctx = await requireOrgContext(req, "treasury.view");
    if (method === "GET" && !id) {
      const q = parseListQuery(req);
      const [txs, accs, allContacts] = await Promise.all([
        db
          .select()
          .from(financialTransactions)
          .where(eq(financialTransactions.organizationId, ctx.organizationId))
          .orderBy(desc(financialTransactions.createdAt)),
        db.select().from(financialAccounts).where(eq(financialAccounts.organizationId, ctx.organizationId)),
        db.select().from(contacts).where(eq(contacts.organizationId, ctx.organizationId)),
      ]);
      const aMap = new Map(accs.map((a) => [a.id, a.name]));
      const cMap = new Map(allContacts.map((c) => [c.id, c.name]));
      const enriched = txs.map((t) => ({
        id: t.id,
        organization_id: t.organizationId,
        transaction_type: t.txType,
        account_id: t.financialAccountId,
        account_name: aMap.get(t.financialAccountId) ?? "",
        destination_account_id: t.destinationAccountId,
        contact_id: t.contactId,
        contact_name: t.contactId ? cMap.get(t.contactId) ?? "" : null,
        amount: t.amount,
        currency: t.currency,
        transaction_date: t.txDate,
        payment_method: t.paymentMethod,
        reference_number: t.trackingNumber,
        related_document_type: t.relatedDocumentType,
        related_document_id: t.relatedDocumentId,
        description: t.description,
        status: t.status,
        created_at: t.createdAt,
      }));
      const { items, total } = applyListFilterAndPaginate(enriched, q, ["description", "reference_number", "account_name"]);
      return okList(items, { page: q.page, perPage: q.perPage, total });
    }
    if (method === "GET" && id && !action) {
      const [tx] = await db
        .select()
        .from(financialTransactions)
        .where(and(eq(financialTransactions.id, id), eq(financialTransactions.organizationId, ctx.organizationId)))
        .limit(1);
      if (!tx) throw new ApiError(404, "TRANSACTION_NOT_FOUND", "تراکنش خزانه یافت نشد.");
      return ok(tx);
    }
    if (method === "POST" && id && action === "cancel") {
      await requireOrgContext(req, "treasury.create", { requireActiveSubscription: true });
      const [cancelled] = await db
        .update(financialTransactions)
        .set({ status: "CANCELLED" })
        .where(and(eq(financialTransactions.id, id), eq(financialTransactions.organizationId, ctx.organizationId)))
        .returning();
      return ok(cancelled);
    }
  }

  // POST /api/v1/treasury/{receipts|payments|transfers|expenses|incomes}
  const txTypeMap: Record<string, { type: string; sign: "IN" | "OUT" | "TRANSFER" }> = {
    receipts: { type: "RECEIPT", sign: "IN" },
    incomes: { type: "INCOME", sign: "IN" },
    payments: { type: "PAYMENT", sign: "OUT" },
    expenses: { type: "EXPENSE", sign: "OUT" },
    transfers: { type: "TRANSFER", sign: "TRANSFER" },
  };
  if (method === "POST" && sub && txTypeMap[sub]) {
    const ctx = await requireOrgContext(req, "treasury.create", { requireActiveSubscription: true });
    const body = treasuryTxSchema.parse(await req.json());
    const meta = txTypeMap[sub];

    const created = await withTenantTransaction(ctx.organizationId, async (tx) => {
      const [src] = await tx
        .select()
        .from(financialAccounts)
        .where(and(eq(financialAccounts.id, body.account_id), eq(financialAccounts.organizationId, ctx.organizationId)))
        .limit(1);
      if (!src) throw new ApiError(404, "TREASURY_ACCOUNT_NOT_FOUND", "حساب خزانه مبدأ یافت نشد.");

      if (meta.sign === "TRANSFER") {
        if (!body.destination_account_id) {
          throw new ApiError(422, "VALIDATION_ERROR", "شناسه حساب مقصد (destination_account_id) الزامی است.");
        }
        const [dst] = await tx
          .select()
          .from(financialAccounts)
          .where(and(eq(financialAccounts.id, body.destination_account_id), eq(financialAccounts.organizationId, ctx.organizationId)))
          .limit(1);
        if (!dst) throw new ApiError(404, "DEST_ACCOUNT_NOT_FOUND", "حساب مقصد یافت نشد.");
        await tx
          .update(financialAccounts)
          .set({ balance: formatDecimal(subDec(src.balance, body.amount), 2) })
          .where(eq(financialAccounts.id, src.id));
        await tx
          .update(financialAccounts)
          .set({ balance: formatDecimal(addDec(dst.balance, body.amount), 2) })
          .where(eq(financialAccounts.id, dst.id));
      } else {
        const nextBal =
          meta.sign === "IN" ? addDec(src.balance, body.amount) : subDec(src.balance, body.amount);
        await tx
          .update(financialAccounts)
          .set({ balance: formatDecimal(nextBal, 2) })
          .where(eq(financialAccounts.id, src.id));
      }

      const [ftx] = await tx
        .insert(financialTransactions)
        .values({
          organizationId: ctx.organizationId,
          financialAccountId: src.id,
          destinationAccountId: body.destination_account_id ?? null,
          contactId: body.contact_id ?? null,
          txType: meta.type,
          paymentMethod: body.payment_method,
          currency: body.currency,
          amount: body.amount,
          txDate: body.transaction_date,
          trackingNumber: body.reference_number ?? null,
          relatedDocumentType: body.related_document_type ?? null,
          relatedDocumentId: body.related_document_id ?? null,
          description: body.description,
          status: "CONFIRMED",
          createdBy: ctx.userId,
        })
        .returning();
      return ftx;
    });

    await recordAuditLog({
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      actorEmail: ctx.email,
      scope: "ORGANIZATION",
      action: `TREASURY_${meta.type}`,
      entityType: "FINANCIAL_TRANSACTION",
      entityId: created.id,
    });

    return ok(created, 201);
  }

  throw new ApiError(404, "ROUTE_NOT_FOUND", "مسیر خزانه‌داری یافت نشد.");
}

const RECEIVED_VALID_TRANSITIONS: Record<string, string[]> = {
  REGISTERED: ["IN_CUSTODY", "DEPOSITED", "IN_COLLECTION", "ENDORSED", "CLEARED", "RETURNED", "CANCELLED"],
  RECEIVED: ["IN_CUSTODY", "DEPOSITED", "IN_COLLECTION", "ENDORSED", "CLEARED", "RETURNED", "CANCELLED"],
  IN_CUSTODY: ["DEPOSITED", "IN_COLLECTION", "ENDORSED", "CANCELLED"],
  DEPOSITED: ["IN_COLLECTION", "CLEARED", "RETURNED"],
  IN_COLLECTION: ["CLEARED", "RETURNED"],
  RETURNED: ["REISSUED", "DEPOSITED"],
  BOUNCED: ["REISSUED", "DEPOSITED"],
  CLEARED: [],
  CASHED: [],
  CANCELLED: [],
};

const ISSUED_VALID_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ["ISSUED", "CANCELLED"],
  ISSUED: ["DELIVERED", "PRESENTED", "DEPOSITED", "CLEARED", "RETURNED", "CANCELLED"],
  DELIVERED: ["PRESENTED", "CLEARED", "RETURNED"],
  DEPOSITED: ["PRESENTED", "CLEARED", "RETURNED"],
  PRESENTED: ["CLEARED", "RETURNED"],
  CLEARED: [],
  CASHED: [],
  RETURNED: ["CANCELLED"],
  CANCELLED: [],
};

export async function handleChequeRoutes(
  req: NextRequest,
  method: string,
  segments: string[]
) {
  await ensureSeeded();
  const id = segments[1];
  const action = segments[2];

  // GET /api/v1/cheques/dashboard (§10.1 Summary Cards)
  if (method === "GET" && id === "dashboard") {
    const ctx = await requireOrgContext(req, "cheques.view");
    const list = await db
      .select()
      .from(cheques)
      .where(eq(cheques.organizationId, ctx.organizationId))
      .orderBy(cheques.dueDate);

    const today = new Date().toISOString().slice(0, 10);
    const weekLater = new Date(Date.now() + 7 * 86400 * 1000).toISOString().slice(0, 10);

    let totalReceivables = BigInt(0);
    let totalPayables = BigInt(0);
    let overdueReceivables = BigInt(0);
    let overduePayables = BigInt(0);
    let dueThisWeekCount = 0;
    let awaitingCollectionCount = 0;
    let awaitingPaymentCount = 0;
    let returnedCount = 0;
    let inCollectionCount = 0;
    let issuedCount = 0;

    for (const c of list) {
      const isClosed = ["CLEARED", "CASHED", "CANCELLED"].includes(c.status);
      const isRec = c.chequeType === "RECEIVABLE";
      if (!isClosed && c.dueDate >= today && c.dueDate <= weekLater) dueThisWeekCount += 1;
      if (["RETURNED", "BOUNCED"].includes(c.status)) returnedCount += 1;
      if (c.status === "IN_COLLECTION" || c.status === "DEPOSITED") inCollectionCount += 1;
      if (!isRec) issuedCount += 1;

      if (isRec && !isClosed) {
        totalReceivables = addDec(totalReceivables, c.amount);
        awaitingCollectionCount += 1;
        if (c.dueDate < today) overdueReceivables = addDec(overdueReceivables, c.amount);
      }
      if (!isRec && !isClosed) {
        totalPayables = addDec(totalPayables, c.amount);
        awaitingPaymentCount += 1;
        if (c.dueDate < today) overduePayables = addDec(overduePayables, c.amount);
      }
    }

    return ok({
      summary: {
        due_this_week_count: dueThisWeekCount,
        awaiting_collection_count: awaitingCollectionCount,
        awaiting_payment_count: awaitingPaymentCount,
        returned_count: returnedCount,
        in_collection_count: inCollectionCount,
        issued_count: issuedCount,
        total_receivables: formatDecimal(totalReceivables, 2),
        total_payables: formatDecimal(totalPayables, 2),
        overdue_receivables: formatDecimal(overdueReceivables, 2),
        overdue_payables: formatDecimal(overduePayables, 2),
      },
      cheques: list,
    });
  }

  // GET /api/v1/cheques/analytics?month=YYYY-MM (§10.5 Daily Bar Chart Series)
  if (method === "GET" && id === "analytics") {
    const ctx = await requireOrgContext(req, "cheques.view");
    const monthParam =
      req.nextUrl.searchParams.get("month") || new Date().toISOString().slice(0, 7);
    const [yearStr, monStr] = monthParam.split("-");
    const year = Number(yearStr) || new Date().getUTCFullYear();
    const mon = Number(monStr) || new Date().getUTCMonth() + 1;
    const daysInMonth = new Date(Date.UTC(year, mon, 0)).getUTCDate();

    const list = await db
      .select()
      .from(cheques)
      .where(eq(cheques.organizationId, ctx.organizationId));

    const dailyMap = new Map<string, { rec: bigint; iss: bigint }>();
    for (let d = 1; d <= daysInMonth; d++) {
      const iso = `${year}-${String(mon).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      dailyMap.set(iso, { rec: BigInt(0), iss: BigInt(0) });
    }

    for (const c of list) {
      const bucket = dailyMap.get(c.dueDate);
      if (!bucket) continue;
      if (c.chequeType === "RECEIVABLE") bucket.rec = addDec(bucket.rec, c.amount);
      else bucket.iss = addDec(bucket.iss, c.amount);
    }

    const daily_series = Array.from(dailyMap.entries()).map(([dateStr, vals]) => ({
      date: dateStr,
      day: Number(dateStr.slice(8, 10)),
      received_amount: formatDecimal(vals.rec, 2),
      issued_amount: formatDecimal(vals.iss, 2),
    }));

    return ok({ month: `${year}-${String(mon).padStart(2, "0")}`, daily_series });
  }

  // GET /api/v1/cheques/due
  if (method === "GET" && id === "due") {
    const ctx = await requireOrgContext(req, "cheques.view");
    const horizon = new Date(Date.now() + 30 * 86400 * 1000).toISOString().slice(0, 10);
    const list = await db
      .select()
      .from(cheques)
      .where(and(eq(cheques.organizationId, ctx.organizationId), lte(cheques.dueDate, horizon)))
      .orderBy(cheques.dueDate);
    return ok(list);
  }

  // GET /api/v1/cheques
  if (method === "GET" && !id) {
    const ctx = await requireOrgContext(req, "cheques.view");
    const q = parseListQuery(req);
    const [list, events, orgContacts] = await Promise.all([
      db.select().from(cheques).where(eq(cheques.organizationId, ctx.organizationId)).orderBy(cheques.dueDate),
      db.select().from(chequeEvents).where(eq(chequeEvents.organizationId, ctx.organizationId)).orderBy(desc(chequeEvents.createdAt)),
      db.select().from(contacts).where(eq(contacts.organizationId, ctx.organizationId)),
    ]);
    const cMap = new Map(orgContacts.map((c) => [c.id, c.name]));
    const enriched = list.map((ch) => ({
      id: ch.id,
      organization_id: ch.organizationId,
      cheque_number: ch.sayadId,
      serial_number: ch.serialNumber,
      bank_name: ch.bankName,
      branch_name: ch.branchName,
      account_number: ch.accountNumber,
      amount: ch.amount,
      issue_date: ch.issueDate,
      due_date: ch.dueDate,
      contact_id: ch.contactId,
      contact_name: ch.contactId ? cMap.get(ch.contactId) ?? "" : null,
      direction: ch.chequeType,
      status: ch.status === "REGISTERED" ? "RECEIVED" : ch.status === "PASSED" ? "CASHED" : ch.status,
      related_document_type: ch.relatedDocumentType,
      related_document_id: ch.relatedDocumentId,
      notes: ch.notes,
      events: events.filter((e) => e.chequeId === ch.id),
    }));
    const { items, total } = applyListFilterAndPaginate(enriched, q, ["cheque_number", "serial_number", "bank_name"]);
    return okList(items, { page: q.page, perPage: q.perPage, total });
  }

  // POST /api/v1/cheques (supports Jalali issue/due dates + DRAFT vs posted journal!)
  if (method === "POST" && !id) {
    const ctx = await requireOrgContext(req, "cheques.manage", { requireActiveSubscription: true });
    await ensurePrompt05OrgDefaults(ctx.organizationId);
    const body = createChequeSchema.parse(await req.json());
    const issueDateIso = resolveCanonicalDate(body.issue_date, body.issue_date_jalali);
    const dueDateIso = resolveCanonicalDate(body.due_date, body.due_date_jalali);
    const initialStatus = body.as_draft
      ? "DRAFT"
      : body.direction === "RECEIVABLE"
        ? "RECEIVED"
        : "ISSUED";

    const created = await withTenantTransaction(ctx.organizationId, async (tx) => {
      const [ch] = await tx
        .insert(cheques)
        .values({
          organizationId: ctx.organizationId,
          contactId: body.contact_id ?? null,
          chequeType: body.direction,
          sayadId: body.cheque_number,
          serialNumber: body.serial_number,
          bankName: body.bank_name,
          branchName: body.branch_name ?? null,
          accountNumber: body.account_number ?? null,
          drawerName: body.drawer_name ?? null,
          recipientName: body.recipient_name ?? null,
          amount: body.amount,
          issueDate: issueDateIso,
          dueDate: dueDateIso,
          relatedDocumentType: body.related_document_type ?? null,
          relatedDocumentId: body.related_document_id ?? null,
          status: initialStatus,
          notes: body.notes ?? null,
        })
        .returning();

      await tx.insert(chequeEvents).values({
        organizationId: ctx.organizationId,
        chequeId: ch.id,
        fromStatus: null,
        toStatus: initialStatus,
        eventDate: issueDateIso,
        note: `ثبت چک در سامانه (سررسید شمسی: ${gregorianIsoToJalali(dueDateIso)})`,
        actorUserId: ctx.userId,
      });

      let journalEntry = null;
      if (!body.as_draft) {
        const orgAccs = await tx.select().from(accounts).where(eq(accounts.organizationId, ctx.organizationId));
        const byRole = new Map(orgAccs.filter((a) => a.systemRole).map((a) => [a.systemRole!, a]));
        const recChq = byRole.get("RECEIVABLE_CHEQUE");
        const payChq = byRole.get("PAYABLE_CHEQUE");
        const ar = byRole.get("AR");
        const ap = byRole.get("AP");

        if (body.direction === "RECEIVABLE" && recChq && ar) {
          const jr = await createJournalEntryTx(tx, {
            organizationId: ctx.organizationId,
            actorUserId: ctx.userId,
            actorEmail: ctx.email,
            entryDate: issueDateIso,
            description: `دریافت چک صیادی ${body.cheque_number} (${body.bank_name})`,
            referenceType: "CHEQUE",
            referenceId: ch.id,
            postImmediately: true,
            lines: [
              { accountId: recChq.id, debit: body.amount, credit: "0.00", description: `اسناد دریافتنی چک ${body.cheque_number}` },
              { accountId: ar.id, contactId: body.contact_id ?? null, debit: "0.00", credit: body.amount, description: `کاهش حساب دریافتنی بابت چک ${body.cheque_number}` },
            ],
          });
          journalEntry = jr.entry;
        } else if (body.direction === "PAYABLE" && payChq && ap) {
          const jr = await createJournalEntryTx(tx, {
            organizationId: ctx.organizationId,
            actorUserId: ctx.userId,
            actorEmail: ctx.email,
            entryDate: issueDateIso,
            description: `صدور چک پرداختنی ${body.cheque_number} (${body.bank_name})`,
            referenceType: "CHEQUE",
            referenceId: ch.id,
            postImmediately: true,
            lines: [
              { accountId: ap.id, contactId: body.contact_id ?? null, debit: body.amount, credit: "0.00", description: `کاهش بدهی بابت صدور چک ${body.cheque_number}` },
              { accountId: payChq.id, debit: "0.00", credit: body.amount, description: `اسناد پرداختنی چک ${body.cheque_number}` },
            ],
          });
          journalEntry = jr.entry;
        }
        if (journalEntry) {
          await tx.update(cheques).set({ journalEntryId: journalEntry.id }).where(eq(cheques.id, ch.id));
        }
      }

      return {
        ...ch,
        cheque_number: ch.sayadId,
        direction: ch.chequeType,
        issue_date_jalali: gregorianIsoToJalali(issueDateIso),
        due_date_jalali: gregorianIsoToJalali(dueDateIso),
        journal_entry: journalEntry,
      };
    });
    return ok(created, 201);
  }

  if (id) {
    const ctx = await requireOrgContext(req, "cheques.view");
    const [ch] = await db
      .select()
      .from(cheques)
      .where(and(eq(cheques.id, id), eq(cheques.organizationId, ctx.organizationId)))
      .limit(1);
    if (!ch) throw new ApiError(404, "CHEQUE_NOT_FOUND", "چک یافت نشد.");

    if (method === "GET" && !action) return ok(ch);
    if (method === "GET" && action === "history") {
      return ok(
        await db
          .select()
          .from(chequeEvents)
          .where(eq(chequeEvents.chequeId, ch.id))
          .orderBy(desc(chequeEvents.createdAt))
      );
    }
    // Prompt 08 §2.8 — Controlled Cheque Editing respecting Financial Immutability & Audit Diffs!
    if (method === "PATCH" && !action) {
      await requireOrgContext(req, "cheques.update", { requireActiveSubscription: true });
      const body = z
        .object({
          amount: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
          cheque_number: z.string().min(3).optional(),
          serial_number: z.string().min(2).optional(),
          bank_name: z.string().min(2).optional(),
          branch_name: z.string().nullable().optional(),
          drawer_name: z.string().nullable().optional(),
          recipient_name: z.string().nullable().optional(),
          issue_date: z.string().optional(),
          issue_date_jalali: z.string().optional(),
          due_date: z.string().optional(),
          due_date_jalali: z.string().optional(),
          contact_id: z.string().uuid().nullable().optional(),
          notes: z.string().nullable().optional(),
          correction_reason: z.string().optional(),
          version: z.number().int().positive().optional(),
        })
        .parse(await req.json());

      // Optimistic Version Conflict Check (Master Prompt 09A §7)
      if (body.version !== undefined && body.version !== ch.version) {
        throw new ApiError(
          409,
          "VERSION_CONFLICT",
          `نسخه چک در سرور (v${ch.version}) با نسخه ارسالی (v${body.version}) مطابقت ندارد. لطفاً ابتدا چک را بازخوانی کنید.`
        );
      }

      const isSettled = ["CLEARED", "CASHED", "CANCELLED"].includes(ch.status);
      const isPosted = ch.status !== "DRAFT";
      const touchesFinancialFields =
        (body.amount !== undefined && body.amount !== ch.amount) ||
        (body.cheque_number !== undefined && body.cheque_number !== ch.sayadId) ||
        body.due_date !== undefined ||
        body.due_date_jalali !== undefined ||
        body.issue_date !== undefined ||
        body.issue_date_jalali !== undefined ||
        (body.bank_name !== undefined && body.bank_name !== ch.bankName);

      if (isSettled && touchesFinancialFields) {
        throw new ApiError(
          409,
          "CHEQUE_FINANCIALLY_SETTLED",
          `چک با وضعیت ${ch.status} تسویه/مختومه شده است و ویرایش فیلدهای مالی آن مجاز نیست.`
        );
      }
      if (isPosted && touchesFinancialFields && (!body.correction_reason || body.correction_reason.trim().length < 5)) {
        throw new ApiError(
          422,
          "CORRECTION_REASON_REQUIRED",
          "برای اصلاح فیلدهای مالی چک ثبت‌شده (مبلغ، سررسید، شماره یا بانک)، ذکر دلیل رسمی اصلاح (correction_reason حداقل ۵ کاراکتر) الزامی است."
        );
      }

      const nextIssue =
        body.issue_date || body.issue_date_jalali
          ? resolveCanonicalDate(body.issue_date, body.issue_date_jalali)
          : ch.issueDate;
      const nextDue =
        body.due_date || body.due_date_jalali
          ? resolveCanonicalDate(body.due_date, body.due_date_jalali)
          : ch.dueDate;

      const beforeSnap = {
        amount: ch.amount,
        cheque_number: ch.sayadId,
        bank_name: ch.bankName,
        issue_date: ch.issueDate,
        due_date: ch.dueDate,
        drawer_name: ch.drawerName,
        notes: ch.notes,
      };

      const edited = await withTenantTransaction(ctx.organizationId, async (tx) => {
        let adjustmentJournal = null;
        // If posted cheque amount changed, post a formal delta adjustment journal!
        if (isPosted && body.amount !== undefined && body.amount !== ch.amount) {
          const delta = subDec(body.amount, ch.amount);
          const absDelta = isNegativeDec(delta) ? -delta : delta;
          const absStr = formatDecimal(absDelta, 2);
          const orgAccs = await tx.select().from(accounts).where(eq(accounts.organizationId, ctx.organizationId));
          const byRole = new Map(orgAccs.filter((a) => a.systemRole).map((a) => [a.systemRole!, a]));
          const chqAcc = ch.chequeType === "RECEIVABLE" ? byRole.get("RECEIVABLE_CHEQUE") : byRole.get("PAYABLE_CHEQUE");
          const counterAcc = ch.chequeType === "RECEIVABLE" ? byRole.get("AR") : byRole.get("AP");

          if (chqAcc && counterAcc && isPositiveDec(absDelta)) {
            const increasing = isPositiveDec(delta);
            const lines =
              ch.chequeType === "RECEIVABLE"
                ? increasing
                  ? [
                      { accountId: chqAcc.id, debit: absStr, credit: "0.00", description: `تعدیل افزایش مبلغ چک ${ch.sayadId}` },
                      { accountId: counterAcc.id, contactId: ch.contactId, debit: "0.00", credit: absStr, description: `تعدیل حساب دریافتنی بابت اصلاح چک ${ch.sayadId}` },
                    ]
                  : [
                      { accountId: counterAcc.id, contactId: ch.contactId, debit: absStr, credit: "0.00", description: `تعدیل کاهش مبلغ چک ${ch.sayadId}` },
                      { accountId: chqAcc.id, debit: "0.00", credit: absStr, description: `کاهش اسناد دریافتنی بابت اصلاح چک ${ch.sayadId}` },
                    ]
                : increasing
                  ? [
                      { accountId: counterAcc.id, contactId: ch.contactId, debit: absStr, credit: "0.00", description: `تعدیل افزایش چک پرداختنی ${ch.sayadId}` },
                      { accountId: chqAcc.id, debit: "0.00", credit: absStr, description: `افزایش اسناد پرداختنی چک ${ch.sayadId}` },
                    ]
                  : [
                      { accountId: chqAcc.id, debit: absStr, credit: "0.00", description: `کاهش اسناد پرداختنی چک ${ch.sayadId}` },
                      { accountId: counterAcc.id, contactId: ch.contactId, debit: "0.00", credit: absStr, description: `تعدیل بدهی تأمین‌کننده بابت اصلاح چک ${ch.sayadId}` },
                    ];

            const jr = await createJournalEntryTx(tx, {
              organizationId: ctx.organizationId,
              actorUserId: ctx.userId,
              actorEmail: ctx.email,
              entryDate: new Date().toISOString().slice(0, 10),
              description: `سند اصلاحی مبلغ چک ${ch.sayadId}: ${body.correction_reason}`,
              referenceType: "CHEQUE_AMENDMENT",
              referenceId: ch.id,
              postImmediately: true,
              lines,
            });
            adjustmentJournal = jr.entry;
          }
        }

        const [upd] = await tx
          .update(cheques)
          .set({
            ...(body.amount !== undefined ? { amount: body.amount } : {}),
            ...(body.cheque_number ? { sayadId: body.cheque_number } : {}),
            ...(body.serial_number ? { serialNumber: body.serial_number } : {}),
            ...(body.bank_name ? { bankName: body.bank_name } : {}),
            ...(body.branch_name !== undefined ? { branchName: body.branch_name } : {}),
            ...(body.drawer_name !== undefined ? { drawerName: body.drawer_name } : {}),
            ...(body.recipient_name !== undefined ? { recipientName: body.recipient_name } : {}),
            ...(body.contact_id !== undefined ? { contactId: body.contact_id } : {}),
            ...(body.notes !== undefined ? { notes: body.notes } : {}),
            issueDate: nextIssue,
            dueDate: nextDue,
            version: ch.version + 1,
            updatedAt: new Date(),
          })
          .where(eq(cheques.id, ch.id))
          .returning();

        await tx.insert(chequeEvents).values({
          organizationId: ctx.organizationId,
          chequeId: ch.id,
          fromStatus: ch.status,
          toStatus: ch.status,
          eventDate: new Date().toISOString().slice(0, 10),
          note: `اصلاح کنترل‌شده چک: ${body.correction_reason || "ویرایش مشخصات"}`,
          actorUserId: ctx.userId,
        });

        return {
          cheque: {
            ...upd,
            cheque_number: upd.sayadId,
            issue_date_jalali: gregorianIsoToJalali(upd.issueDate),
            due_date_jalali: gregorianIsoToJalali(upd.dueDate),
          },
          adjustment_journal: adjustmentJournal,
        };
      });

      await recordAuditLog({
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorEmail: ctx.email,
        scope: "ORGANIZATION",
        action: "CHEQUE_AMENDED",
        entityType: "CHEQUE",
        entityId: ch.id,
        ipAddress: ctx.ipAddress,
        metadata: {
          reason: body.correction_reason ?? null,
          before: beforeSnap,
          after: {
            amount: edited.cheque.amount,
            cheque_number: edited.cheque.sayadId,
            due_date: edited.cheque.dueDate,
            bank_name: edited.cheque.bankName,
          },
          adjustmentJournalId: edited.adjustment_journal?.id ?? null,
        },
      });

      return ok(edited);
    }

    // Full Prompt 05 §10.4 State Machine Transitions + Double-Entry Accounting Entries!
    const transitionMap: Record<string, string> = {
      "in-custody": "IN_CUSTODY",
      endorse: "ENDORSED",
      deposit: "DEPOSITED",
      "in-collection": "IN_COLLECTION",
      clear: "CLEARED",
      cash: "CLEARED",
      return: "RETURNED",
      bounce: "RETURNED",
      reissue: "REISSUED",
      deliver: "DELIVERED",
      present: "PRESENTED",
      cancel: "CANCELLED",
    };
    if (method === "POST" && action && transitionMap[action]) {
      await requireOrgContext(req, "cheques.manage", { requireActiveSubscription: true });
      await ensurePrompt05OrgDefaults(ctx.organizationId);
      const body = (await req.json().catch(() => ({}))) as {
        note?: string;
        financial_account_id?: string;
      };
      const toStatus = transitionMap[action];
      const validMap =
        ch.chequeType === "RECEIVABLE"
          ? RECEIVED_VALID_TRANSITIONS
          : ISSUED_VALID_TRANSITIONS;
      const allowedNext = validMap[ch.status] ?? [];
      if (!allowedNext.includes(toStatus)) {
        throw new ApiError(
          409,
          "INVALID_CHEQUE_TRANSITION",
          `انتقال وضعیت چک از ${ch.status} به ${toStatus} مجاز نیست.`
        );
      }

      const result = await withTenantTransaction(ctx.organizationId, async (tx) => {
        const eventDate = new Date().toISOString().slice(0, 10);
        const [ev] = await tx
          .insert(chequeEvents)
          .values({
            organizationId: ctx.organizationId,
            chequeId: ch.id,
            fromStatus: ch.status,
            toStatus,
            eventDate,
            note: body.note ?? `تغییر وضعیت چک از ${ch.status} به ${toStatus}`,
            actorUserId: ctx.userId,
          })
          .returning();

        const [upd] = await tx
          .update(cheques)
          .set({ status: toStatus, updatedAt: new Date() })
          .where(eq(cheques.id, ch.id))
          .returning();

        // Double-Entry Accounting Impact on Cheque Transitions
        const orgAccs = await tx.select().from(accounts).where(eq(accounts.organizationId, ctx.organizationId));
        const byRole = new Map(orgAccs.filter((a) => a.systemRole).map((a) => [a.systemRole!, a]));
        const recChq = byRole.get("RECEIVABLE_CHEQUE");
        const collChq = byRole.get("CHEQUE_IN_COLLECTION");
        const payChq = byRole.get("PAYABLE_CHEQUE");
        const bankAcc = byRole.get("BANK");
        const arAcc = byRole.get("AR");

        let journalEntry = null;
        if (ch.chequeType === "RECEIVABLE") {
          if ((toStatus === "DEPOSITED" || toStatus === "IN_COLLECTION") && ch.status !== "DEPOSITED" && recChq && collChq) {
            const jr = await createJournalEntryTx(tx, {
              organizationId: ctx.organizationId,
              actorUserId: ctx.userId,
              actorEmail: ctx.email,
              entryDate: eventDate,
              description: `واگذاری چک ${ch.sayadId} به بانک جهت وصول`,
              referenceType: "CHEQUE",
              referenceId: ch.id,
              postImmediately: true,
              lines: [
                { accountId: collChq.id, debit: ch.amount, credit: "0.00", description: "اسناد در جریان وصول" },
                { accountId: recChq.id, debit: "0.00", credit: ch.amount, description: "خروج چک از صندوق اسناد دریافتنی" },
              ],
            });
            journalEntry = jr.entry;
          } else if (toStatus === "CLEARED" && bankAcc && (collChq || recChq)) {
            const creditAcc = ch.status === "IN_COLLECTION" || ch.status === "DEPOSITED" ? (collChq ?? recChq!) : recChq!;
            const jr = await createJournalEntryTx(tx, {
              organizationId: ctx.organizationId,
              actorUserId: ctx.userId,
              actorEmail: ctx.email,
              entryDate: eventDate,
              description: `وصول قطعی چک صیادی ${ch.sayadId}`,
              referenceType: "CHEQUE",
              referenceId: ch.id,
              postImmediately: true,
              lines: [
                { accountId: bankAcc.id, debit: ch.amount, credit: "0.00", description: "واریز وجه چک به حساب بانکی" },
                { accountId: creditAcc.id, debit: "0.00", credit: ch.amount, description: "تسویه چک دریافتنی" },
              ],
            });
            journalEntry = jr.entry;

            // Increase Bank treasury balance
            const [bankFin] = await tx
              .select()
              .from(financialAccounts)
              .where(
                and(
                  eq(financialAccounts.organizationId, ctx.organizationId),
                  body.financial_account_id
                    ? eq(financialAccounts.id, body.financial_account_id)
                    : eq(financialAccounts.accountType, "BANK")
                )
              )
              .limit(1);
            if (bankFin) {
              await tx
                .update(financialAccounts)
                .set({ balance: formatDecimal(addDec(bankFin.balance, ch.amount), 2) })
                .where(eq(financialAccounts.id, bankFin.id));
            }
          } else if (toStatus === "RETURNED" && arAcc && (collChq || recChq)) {
            const creditAcc = ch.status === "IN_COLLECTION" || ch.status === "DEPOSITED" ? (collChq ?? recChq!) : recChq!;
            const jr = await createJournalEntryTx(tx, {
              organizationId: ctx.organizationId,
              actorUserId: ctx.userId,
              actorEmail: ctx.email,
              entryDate: eventDate,
              description: `برگشت چک دریافتنی ${ch.sayadId}`,
              referenceType: "CHEQUE",
              referenceId: ch.id,
              postImmediately: true,
              lines: [
                { accountId: arAcc.id, contactId: ch.contactId, debit: ch.amount, credit: "0.00", description: "برگشت بدهی به حساب مشتری" },
                { accountId: creditAcc.id, debit: "0.00", credit: ch.amount, description: "حذف از اسناد در جریان وصول" },
              ],
            });
            journalEntry = jr.entry;
          }
        } else if (toStatus === "CLEARED" && payChq && bankAcc) {
          const jr = await createJournalEntryTx(tx, {
            organizationId: ctx.organizationId,
            actorUserId: ctx.userId,
            actorEmail: ctx.email,
            entryDate: eventDate,
            description: `پاس شدن چک پرداختنی ${ch.sayadId}`,
            referenceType: "CHEQUE",
            referenceId: ch.id,
            postImmediately: true,
            lines: [
              { accountId: payChq.id, debit: ch.amount, credit: "0.00", description: "تسویه سند پرداختنی" },
              { accountId: bankAcc.id, debit: "0.00", credit: ch.amount, description: "برداشت از حساب بانکی بابت چک" },
            ],
          });
          journalEntry = jr.entry;
        }

        return { cheque: upd, event: ev, journal_entry: journalEntry };
      });

      await recordAuditLog({
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorEmail: ctx.email,
        scope: "ORGANIZATION",
        action: `CHEQUE_${toStatus}`,
        entityType: "CHEQUE",
        entityId: ch.id,
      });
      return ok(result);
    }
  }

  throw new ApiError(404, "ROUTE_NOT_FOUND", "مسیر چک‌ها یافت نشد.");
}

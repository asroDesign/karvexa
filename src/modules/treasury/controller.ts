import { NextRequest } from "next/server";
import { and, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  accounts,
  accountingCategories,
  categoryAccountMappings,
  chequeEvents,
  cheques,
  contacts,
  contactTransactions,
  financialAccounts,
  financialTransactions,
  idempotencyKeys,
  invoicePaymentAllocations,
  organizations,
  users,
} from "@/db/schema";
import { ensureSeeded } from "@/db/seed";
import { ensurePrompt05OrgDefaults } from "@/db/seed-prompt05";
import { recordAuditLog } from "@/lib/audit";
import { sha256 } from "@/lib/auth";
import { addDec, formatDecimal, gtDec, isNegativeDec, isPositiveDec, parseDecimal, subDec } from "@/lib/decimal";
import {
  ApiError,
  applyListFilterAndPaginate,
  ok,
  okList,
  parseListQuery,
} from "@/lib/errors";
import { gregorianIsoToJalali, jalaliToGregorianIso, normalizePersianDigits, resolveCanonicalDate } from "@/lib/jalali";
import { requireOrgContext, withTenantTransaction } from "@/lib/tenant";
import { createJournalEntryTx, reverseJournalEntryTx } from "@/modules/accounting/service";
import { sendSmsViaGateway } from "@/modules/sms/service";

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
  transaction_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  transaction_date_jalali: z.string().optional(),
  payment_method: z.enum(["CASH", "BANK_TRANSFER", "CARD", "CHEQUE", "OTHER"]).default("BANK_TRANSFER"),
  reference_number: z.string().optional(),
  related_document_type: z.string().optional(),
  related_document_id: z.string().uuid().optional(),
  category_id: z.string().uuid().optional(),
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

      await ensurePrompt05OrgDefaults(ctx.organizationId);
      const created = await withTenantTransaction(ctx.organizationId, async (tx) => {
        const [org] = await tx.select({ baseCurrency: organizations.baseCurrency }).from(organizations).where(eq(organizations.id, ctx.organizationId)).limit(1);
        if (!org) throw new ApiError(404, "ORG_NOT_FOUND", "سازمان یافت نشد.");
        if (isPositiveDec(parseDecimal(body.opening_balance)) && body.currency !== org.baseCurrency) {
          throw new ApiError(422, "FOREIGN_CURRENCY_OPENING_BALANCE_UNSUPPORTED", `مانده افتتاحیه باید به ارز پایه ${org.baseCurrency} ثبت شود؛ تسعیر حساب ارزی هنوز فعال نیست.`);
        }
        const orgAccs = await tx.select().from(accounts).where(eq(accounts.organizationId, ctx.organizationId));
        const glAcc = orgAccs.find((a) => a.systemRole === (normType === "CASHBOX" ? "CASH" : "BANK"));
        const capAcc = orgAccs.find((a) => a.systemRole === "CAPITAL");

        if (isPositiveDec(parseDecimal(body.opening_balance)) && (!glAcc || !capAcc)) {
          throw new ApiError(422, "OPENING_BALANCE_ACCOUNTS_MISSING", "برای افتتاح حساب با مانده اولیه، حساب خزانه و سرمایه باید در کدینگ فعال باشند.");
        }

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
      const cancelCtx = await requireOrgContext(req, "treasury.create", { requireActiveSubscription: true });
      const body = z.object({
        reason: z.string().min(3).max(500).optional(),
        reversal_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        reversal_date_jalali: z.string().optional(),
        accounting_period_id: z.string().uuid().optional(),
      }).parse(await req.json().catch(() => ({})));
      const result = await withTenantTransaction(cancelCtx.organizationId, async (tx) => {
        await tx.execute(sql`
          SELECT id FROM financial_transactions
          WHERE id = ${id} AND organization_id = ${cancelCtx.organizationId}
          FOR UPDATE
        `);
        const [transaction] = await tx.select().from(financialTransactions).where(and(
          eq(financialTransactions.id, id),
          eq(financialTransactions.organizationId, cancelCtx.organizationId)
        )).limit(1);
        if (!transaction) throw new ApiError(404, "TRANSACTION_NOT_FOUND", "تراکنش خزانه یافت نشد.");
        if (transaction.status === "CANCELLED") return { transaction, reversalJournalEntryId: null, replayed: true };
        if (transaction.status !== "CONFIRMED") throw new ApiError(409, "TRANSACTION_NOT_CANCELLABLE", "وضعیت این تراکنش اجازه ابطال نمی‌دهد.");
        if (["SALES_INVOICE", "PURCHASE_INVOICE", "SUPPLIER_SETTLEMENT", "WAREHOUSE_RECEIPT"].includes((transaction.relatedDocumentType ?? "").toUpperCase())) {
          throw new ApiError(409, "DOCUMENT_SETTLEMENT_CANNOT_CANCEL_HERE", "این تراکنش به سند فروش/خرید متصل است؛ اصلاح را از همان فاکتور یا گردش چک انجام دهید.");
        }
        if (!transaction.journalEntryId) {
          throw new ApiError(409, "UNJOURNALED_TREASURY_TRANSACTION", "برای این تراکنش سند حسابداری وجود ندارد؛ ابتدا گردش تاریخی را تطبیق و اصلاح کنید.");
        }

        const accountIds = [...new Set([transaction.financialAccountId, transaction.destinationAccountId].filter((v): v is string => Boolean(v)))].sort();
        for (const accountId of accountIds) {
          await tx.execute(sql`
            SELECT id FROM financial_accounts
            WHERE id = ${accountId} AND organization_id = ${cancelCtx.organizationId}
            FOR UPDATE
          `);
        }
        const [source] = await tx.select().from(financialAccounts).where(and(
          eq(financialAccounts.id, transaction.financialAccountId),
          eq(financialAccounts.organizationId, cancelCtx.organizationId)
        )).limit(1);
        if (!source) throw new ApiError(409, "TREASURY_ACCOUNT_MISSING", "حساب مبدأ تراکنش دیگر در دسترس نیست.");
        let destination: typeof financialAccounts.$inferSelect | null = null;
        if (transaction.txType === "TRANSFER") {
          if (!transaction.destinationAccountId) throw new ApiError(409, "TRANSFER_DESTINATION_MISSING", "حساب مقصد انتقال ثبت نشده است.");
          const [found] = await tx.select().from(financialAccounts).where(and(
            eq(financialAccounts.id, transaction.destinationAccountId),
            eq(financialAccounts.organizationId, cancelCtx.organizationId)
          )).limit(1);
          if (!found) throw new ApiError(409, "TRANSFER_DESTINATION_MISSING", "حساب مقصد انتقال دیگر در دسترس نیست.");
          destination = found;
        }

        const reversal = await reverseJournalEntryTx(tx, {
          organizationId: cancelCtx.organizationId,
          journalEntryId: transaction.journalEntryId,
          reason: body.reason ?? `ابطال تراکنش خزانه ${transaction.id}`,
          reversalDate: body.reversal_date || body.reversal_date_jalali
            ? resolveCanonicalDate(body.reversal_date, body.reversal_date_jalali)
            : undefined,
          accountingPeriodId: body.accounting_period_id,
          actorUserId: cancelCtx.userId,
          actorEmail: cancelCtx.email,
        });

        const amount = parseDecimal(transaction.amount);
        let sourceBalance = parseDecimal(source.balance);
        let destinationBalance = destination ? parseDecimal(destination.balance) : null;
        if (transaction.txType === "RECEIPT" || transaction.txType === "INCOME") sourceBalance = subDec(sourceBalance, amount);
        else if (transaction.txType === "PAYMENT" || transaction.txType === "EXPENSE") sourceBalance = addDec(sourceBalance, amount);
        else if (transaction.txType === "TRANSFER" && destinationBalance !== null) {
          sourceBalance = addDec(sourceBalance, amount);
          destinationBalance = subDec(destinationBalance, amount);
        } else throw new ApiError(409, "TRANSACTION_TYPE_UNSUPPORTED", "نوع تراکنش قابل ابطال نیست.");

        await tx.update(financialAccounts).set({
          balance: formatDecimal(sourceBalance, 2), version: source.version + 1, updatedAt: new Date(),
        }).where(and(eq(financialAccounts.id, source.id), eq(financialAccounts.version, source.version)));
        if (destination && destinationBalance !== null) {
          await tx.update(financialAccounts).set({
            balance: formatDecimal(destinationBalance, 2), version: destination.version + 1, updatedAt: new Date(),
          }).where(and(eq(financialAccounts.id, destination.id), eq(financialAccounts.version, destination.version)));
        }
        if (transaction.contactId && (transaction.txType === "RECEIPT" || transaction.txType === "PAYMENT")) {
          await tx.insert(contactTransactions).values({
            organizationId: cancelCtx.organizationId,
            contactId: transaction.contactId,
            referenceType: "TREASURY_REVERSAL",
            referenceId: transaction.id,
            txDate: reversal.reversal.entryDate,
            debit: transaction.txType === "RECEIPT" ? transaction.amount : "0.00",
            credit: transaction.txType === "PAYMENT" ? transaction.amount : "0.00",
            description: `ابطال تراکنش خزانه ${transaction.id}`,
          });
        }
        const [cancelled] = await tx.update(financialTransactions).set({
          status: "CANCELLED", version: transaction.version + 1, updatedAt: new Date(),
        }).where(and(
          eq(financialTransactions.id, transaction.id),
          eq(financialTransactions.status, "CONFIRMED"),
          eq(financialTransactions.version, transaction.version)
        )).returning();
        if (!cancelled) throw new ApiError(409, "TRANSACTION_CHANGED", "تراکنش هم‌زمان تغییر کرده است؛ دوباره بارگیری کنید.");
        return { transaction: cancelled, reversalJournalEntryId: reversal.reversal.id, replayed: false };
      });
      if (!result.replayed) {
        await recordAuditLog({
          organizationId: cancelCtx.organizationId,
          actorUserId: cancelCtx.userId,
          actorEmail: cancelCtx.email,
          scope: "ORGANIZATION",
          action: "TREASURY_TRANSACTION_CANCELLED",
          entityType: "FINANCIAL_TRANSACTION",
          entityId: result.transaction.id,
          ipAddress: cancelCtx.ipAddress,
          metadata: { reversalJournalEntryId: result.reversalJournalEntryId, reason: body.reason ?? null },
        });
      }
      return ok(result.transaction, 200, result.replayed ? { replayed: true } : undefined);
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
    if (body.payment_method === "CHEQUE") {
      throw new ApiError(422, "USE_CHEQUE_WORKFLOW", "برای ثبت چک از گردش چک‌ها یا تسویه فاکتور با اطلاعات چک استفاده کنید.");
    }
    const transactionDate = resolveCanonicalDate(body.transaction_date, body.transaction_date_jalali);
    const meta = txTypeMap[sub];
    if (!isPositiveDec(parseDecimal(body.amount))) {
      throw new ApiError(422, "AMOUNT_INVALID", "مبلغ تراکنش باید بزرگ‌تر از صفر باشد.");
    }
    const idemKey = req.headers.get("idempotency-key");
    if (idemKey && idemKey.length > 160) throw new ApiError(400, "IDEMPOTENCY_KEY_TOO_LONG", "طول کلید تکرار مجاز نیست.");
    const endpoint = `/api/v1/treasury/${sub}`;
    const requestHash = sha256(JSON.stringify(body));
    await ensurePrompt05OrgDefaults(ctx.organizationId);

    const result = await withTenantTransaction(ctx.organizationId, async (tx) => {
      if (idemKey) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${ctx.organizationId}:${idemKey}`}))`);
        const [existing] = await tx
          .select()
          .from(idempotencyKeys)
          .where(and(eq(idempotencyKeys.organizationId, ctx.organizationId), eq(idempotencyKeys.key, idemKey)))
          .limit(1);
        if (existing && existing.expiresAt > new Date()) {
          if (existing.requestHash !== requestHash || existing.endpoint !== endpoint) {
            throw new ApiError(409, "IDEMPOTENCY_PAYLOAD_MISMATCH", "کلید تکرار قبلاً برای درخواست دیگری استفاده شده است.");
          }
          return { transaction: existing.responseBody, replayed: true };
        }
        if (existing) {
          await tx.delete(idempotencyKeys).where(eq(idempotencyKeys.id, existing.id));
        }
      }

      if (meta.sign === "TRANSFER" && !body.destination_account_id) {
        throw new ApiError(422, "DESTINATION_ACCOUNT_REQUIRED", "شناسه حساب مقصد برای انتقال الزامی است.");
      }
      if (meta.sign !== "TRANSFER" && body.destination_account_id) {
        throw new ApiError(422, "DESTINATION_ACCOUNT_NOT_ALLOWED", "حساب مقصد فقط برای انتقال بین حساب‌ها استفاده می‌شود.");
      }
      if (meta.sign === "TRANSFER" && body.destination_account_id === body.account_id) {
        throw new ApiError(422, "SAME_TRANSFER_ACCOUNT", "حساب مبدأ و مقصد انتقال باید متفاوت باشند.");
      }

      const lockedAccountIds = [...new Set([body.account_id, body.destination_account_id].filter((v): v is string => Boolean(v)))].sort();
      for (const accountId of lockedAccountIds) {
        await tx.execute(sql`
          SELECT id FROM financial_accounts
          WHERE id = ${accountId} AND organization_id = ${ctx.organizationId}
          FOR UPDATE
        `);
      }
      const [src] = await tx
        .select()
        .from(financialAccounts)
        .where(and(eq(financialAccounts.id, body.account_id), eq(financialAccounts.organizationId, ctx.organizationId)))
        .limit(1);
      if (!src) throw new ApiError(404, "TREASURY_ACCOUNT_NOT_FOUND", "حساب خزانه مبدأ یافت نشد.");
      if (!src.isActive) throw new ApiError(409, "TREASURY_ACCOUNT_INACTIVE", "حساب خزانه مبدأ غیرفعال است.");
      if (src.currency !== body.currency) throw new ApiError(422, "CURRENCY_MISMATCH", "ارز تراکنش با ارز حساب خزانه مبدأ یکسان نیست.");
      const [organization] = await tx.select({ baseCurrency: organizations.baseCurrency }).from(organizations).where(eq(organizations.id, ctx.organizationId)).limit(1);
      if (!organization) throw new ApiError(404, "ORG_NOT_FOUND", "سازمان یافت نشد.");
      if (body.currency !== organization.baseCurrency || src.currency !== organization.baseCurrency) {
        throw new ApiError(422, "FOREIGN_CURRENCY_POSTING_UNSUPPORTED", `ثبت خزانه فقط با ارز پایه ${organization.baseCurrency} ممکن است؛ تسعیر چندارزی هنوز پیاده‌سازی نشده است.`);
      }

      let dst: typeof financialAccounts.$inferSelect | null = null;
      if (body.destination_account_id) {
        const [destination] = await tx
          .select()
          .from(financialAccounts)
          .where(and(eq(financialAccounts.id, body.destination_account_id), eq(financialAccounts.organizationId, ctx.organizationId)))
          .limit(1);
        if (!destination) throw new ApiError(404, "DEST_ACCOUNT_NOT_FOUND", "حساب خزانه مقصد یافت نشد.");
        if (!destination.isActive) throw new ApiError(409, "DEST_ACCOUNT_INACTIVE", "حساب خزانه مقصد غیرفعال است.");
        if (destination.currency !== src.currency || body.currency !== src.currency) {
          throw new ApiError(422, "TRANSFER_CURRENCY_MISMATCH", "انتقال ارزی بین حساب‌های با ارز متفاوت مجاز نیست.");
        }
        dst = destination;
      }

      const amount = parseDecimal(body.amount);
      const sourceOutflow = meta.sign === "OUT" || meta.sign === "TRANSFER";
      if (sourceOutflow && (src.accountType === "CASHBOX" || src.accountType === "CASH") && gtDec(amount, parseDecimal(src.balance))) {
        throw new ApiError(422, "INSUFFICIENT_CASH_BALANCE", "موجودی صندوق برای این پرداخت کافی نیست.");
      }

      let contact = null;
      if (body.contact_id) {
        const [found] = await tx
          .select()
          .from(contacts)
          .where(and(eq(contacts.id, body.contact_id), eq(contacts.organizationId, ctx.organizationId)))
          .limit(1);
        if (!found) throw new ApiError(404, "CONTACT_NOT_FOUND", "طرف‌حساب متعلق به این کسب‌وکار نیست.");
        contact = found;
      }
      if (body.category_id && contact && (meta.type === "RECEIPT" || meta.type === "PAYMENT")) {
        throw new ApiError(422, "CATEGORY_NOT_ALLOWED_WITH_CONTACT", "برای دریافت یا پرداخت طرف‌حساب‌محور، دسته‌بندی هزینه/درآمد تعیین نکنید.");
      }
      if (meta.type === "TRANSFER" && (body.contact_id || body.category_id)) {
        throw new ApiError(422, "TRANSFER_DIMENSIONS_NOT_ALLOWED", "برای انتقال بین حساب‌ها طرف‌حساب یا دسته‌بندی ثبت نکنید.");
      }

      const allAccounts = await tx.select().from(accounts).where(eq(accounts.organizationId, ctx.organizationId));
      const byRole = new Map(allAccounts.filter((a) => a.systemRole).map((a) => [a.systemRole!, a]));
      const sourceGlId = src.accountId ?? byRole.get(src.accountType === "CASHBOX" || src.accountType === "CASH" ? "CASH" : "BANK")?.id;
      const destinationGlId = dst?.accountId ?? byRole.get(dst?.accountType === "CASHBOX" || dst?.accountType === "CASH" ? "CASH" : "BANK")?.id;
      if (!sourceGlId) throw new ApiError(422, "TREASURY_GL_MAPPING_MISSING", "حساب دفتر کل متناظر با حساب خزانه مبدأ تنظیم نشده است.");

      let mappedCategoryAccount: string | null = null;
      if (body.category_id) {
        const expectedKind = meta.type === "INCOME" || meta.type === "RECEIPT" ? "INCOME" : "EXPENSE";
        const [category] = await tx
          .select()
          .from(accountingCategories)
          .where(and(eq(accountingCategories.id, body.category_id), eq(accountingCategories.organizationId, ctx.organizationId)))
          .limit(1);
        if (!category || !category.isActive || category.kind !== expectedKind) {
          throw new ApiError(422, "TREASURY_CATEGORY_INVALID", `دسته‌بندی انتخاب‌شده از نوع ${expectedKind === "INCOME" ? "درآمد" : "هزینه"} فعال نیست.`);
        }
        const [mapping] = await tx
          .select()
          .from(categoryAccountMappings)
          .where(and(
            eq(categoryAccountMappings.organizationId, ctx.organizationId),
            eq(categoryAccountMappings.categoryId, category.id),
            eq(categoryAccountMappings.isActive, true)
          ))
          .limit(1);
        if (!mapping) throw new ApiError(422, "CATEGORY_ACCOUNT_MAPPING_MISSING", "برای این دسته‌بندی نگاشت حسابداری تعریف نشده است.");
        mappedCategoryAccount = expectedKind === "INCOME" ? mapping.creditAccountId : mapping.debitAccountId;
      }

      const journalLines = [] as Array<{ accountId: string; contactId?: string | null; debit: string; credit: string; description: string }>;
      if (meta.type === "TRANSFER") {
        if (!dst || !destinationGlId) throw new ApiError(422, "TREASURY_GL_MAPPING_MISSING", "حساب دفتر کل متناظر با حساب خزانه مقصد تنظیم نشده است.");
        journalLines.push(
          { accountId: destinationGlId, debit: body.amount, credit: "0.00", description: `انتقال به ${dst.name}` },
          { accountId: sourceGlId, debit: "0.00", credit: body.amount, description: `انتقال از ${src.name}` }
        );
      } else if (meta.type === "RECEIPT") {
        const counter = contact ? byRole.get("AR") : (mappedCategoryAccount ? allAccounts.find((a) => a.id === mappedCategoryAccount) : byRole.get("OTHER_INCOME"));
        if (!counter) throw new ApiError(422, "TREASURY_COUNTER_ACCOUNT_MISSING", "حساب دریافت وجه در کدینگ تنظیم نشده است.");
        journalLines.push(
          { accountId: sourceGlId, debit: body.amount, credit: "0.00", description: `دریافت در ${src.name}` },
          { accountId: counter.id, contactId: contact ? contact.id : null, debit: "0.00", credit: body.amount, description: contact ? `وصول از ${contact.name}` : body.description }
        );
      } else if (meta.type === "PAYMENT") {
        const counter = contact ? byRole.get("AP") : (mappedCategoryAccount ? allAccounts.find((a) => a.id === mappedCategoryAccount) : byRole.get("OPEX"));
        if (!counter) throw new ApiError(422, "TREASURY_COUNTER_ACCOUNT_MISSING", "حساب پرداخت در کدینگ تنظیم نشده است.");
        journalLines.push(
          { accountId: counter.id, contactId: contact ? contact.id : null, debit: body.amount, credit: "0.00", description: contact ? `پرداخت به ${contact.name}` : body.description },
          { accountId: sourceGlId, debit: "0.00", credit: body.amount, description: `پرداخت از ${src.name}` }
        );
      } else if (meta.type === "EXPENSE") {
        const expense = mappedCategoryAccount ? allAccounts.find((a) => a.id === mappedCategoryAccount) : byRole.get("OPEX");
        if (!expense) throw new ApiError(422, "TREASURY_COUNTER_ACCOUNT_MISSING", "حساب هزینه در کدینگ تنظیم نشده است.");
        journalLines.push(
          { accountId: expense.id, contactId: contact?.id ?? null, debit: body.amount, credit: "0.00", description: body.description },
          { accountId: sourceGlId, debit: "0.00", credit: body.amount, description: `پرداخت از ${src.name}` }
        );
      } else {
        const income = mappedCategoryAccount ? allAccounts.find((a) => a.id === mappedCategoryAccount) : byRole.get("OTHER_INCOME");
        if (!income) throw new ApiError(422, "TREASURY_COUNTER_ACCOUNT_MISSING", "حساب درآمد در کدینگ تنظیم نشده است.");
        journalLines.push(
          { accountId: sourceGlId, debit: body.amount, credit: "0.00", description: `دریافت در ${src.name}` },
          { accountId: income.id, contactId: contact?.id ?? null, debit: "0.00", credit: body.amount, description: body.description }
        );
      }

      const nextSrcBalance = meta.sign === "IN" ? addDec(src.balance, amount) : subDec(src.balance, amount);
      const [updatedSrc] = await tx.update(financialAccounts).set({
        balance: formatDecimal(nextSrcBalance, 2), version: src.version + 1, updatedAt: new Date(),
      }).where(and(eq(financialAccounts.id, src.id), eq(financialAccounts.version, src.version))).returning({ id: financialAccounts.id });
      if (!updatedSrc) throw new ApiError(409, "TREASURY_ACCOUNT_CHANGED", "حساب خزانه هم‌زمان تغییر کرده است؛ درخواست را دوباره ارسال کنید.");
      if (dst) {
        const [updatedDst] = await tx.update(financialAccounts).set({
          balance: formatDecimal(addDec(dst.balance, amount), 2), version: dst.version + 1, updatedAt: new Date(),
        }).where(and(eq(financialAccounts.id, dst.id), eq(financialAccounts.version, dst.version))).returning({ id: financialAccounts.id });
        if (!updatedDst) throw new ApiError(409, "TREASURY_ACCOUNT_CHANGED", "حساب خزانه مقصد هم‌زمان تغییر کرده است؛ درخواست را دوباره ارسال کنید.");
      }

      const [ftx] = await tx.insert(financialTransactions).values({
        organizationId: ctx.organizationId,
        financialAccountId: src.id,
        destinationAccountId: dst?.id ?? null,
        contactId: contact?.id ?? null,
        txType: meta.type,
        paymentMethod: body.payment_method,
        currency: body.currency,
        amount: formatDecimal(amount, 2),
        txDate: transactionDate,
        trackingNumber: body.reference_number ?? null,
        relatedDocumentType: body.related_document_type ?? null,
        relatedDocumentId: body.related_document_id ?? null,
        description: body.description,
        status: "CONFIRMED",
        createdBy: ctx.userId,
      }).returning();
      const journal = await createJournalEntryTx(tx, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorEmail: ctx.email,
        entryDate: transactionDate,
        description: body.description,
        referenceType: "TREASURY_TRANSACTION",
        referenceId: ftx.id,
        postImmediately: true,
        lines: journalLines,
      });
      const [linkedTx] = await tx.update(financialTransactions).set({ journalEntryId: journal.entry.id, version: ftx.version + 1, updatedAt: new Date() }).where(eq(financialTransactions.id, ftx.id)).returning();

      if (contact && (meta.type === "RECEIPT" || meta.type === "PAYMENT")) {
        await tx.insert(contactTransactions).values({
          organizationId: ctx.organizationId,
          contactId: contact.id,
          referenceType: "TREASURY",
          referenceId: ftx.id,
          txDate: transactionDate,
          debit: meta.type === "PAYMENT" ? formatDecimal(amount, 2) : "0.00",
          credit: meta.type === "RECEIPT" ? formatDecimal(amount, 2) : "0.00",
          description: body.description,
        });
      }

      if (idemKey) {
        await tx.insert(idempotencyKeys).values({
          organizationId: ctx.organizationId,
          key: idemKey,
          endpoint,
          requestHash,
          statusCode: 201,
          responseBody: linkedTx as unknown as Record<string, unknown>,
          expiresAt: new Date(Date.now() + 7 * 86400 * 1000),
        });
      }
      return { transaction: linkedTx, replayed: false };
    });

    if (!result.replayed) {
      await recordAuditLog({
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorEmail: ctx.email,
        scope: "ORGANIZATION",
        action: `TREASURY_${meta.type}`,
        entityType: "FINANCIAL_TRANSACTION",
        entityId: String((result.transaction as { id: string }).id),
        ipAddress: ctx.ipAddress,
      });
    }

    return ok(result.transaction, result.replayed ? 200 : 201, result.replayed ? { replayed: true } : undefined);
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

  // POST /api/v1/cheques/:id/reminder — send one idempotent due-date SMS to the authenticated user.
  if (method === "POST" && action === "reminder" && id) {
    const ctx = await requireOrgContext(req, "cheques.manage");
    const body = z.object({ days_before: z.number().int().min(1).max(30) }).parse(await req.json());
    const [cheque] = await db
      .select()
      .from(cheques)
      .where(and(eq(cheques.id, id), eq(cheques.organizationId, ctx.organizationId), isNull(cheques.deletedAt)))
      .limit(1);
    if (!cheque) throw new ApiError(404, "CHEQUE_NOT_FOUND", "چک متعلق به این کسب‌وکار پیدا نشد.");
    if (!["RECEIVED", "ISSUED", "IN_COLLECTION", "DEPOSITED"].includes(cheque.status)) {
      throw new ApiError(409, "CHEQUE_NOT_REMINDABLE", "برای چک تسویه‌شده یا برگشتی یادآور ارسال نمی‌شود.");
    }
    const timezone = ctx.organization.timezone || "Asia/Tehran";
    const todayParts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date());
    const part = (name: string) => todayParts.find((item) => item.type === name)?.value ?? "";
    const today = `${part("year")}-${part("month")}-${part("day")}`;
    const daysUntilDue = Math.floor((Date.parse(`${cheque.dueDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
    if (daysUntilDue < 0 || daysUntilDue > body.days_before) {
      throw new ApiError(422, "CHEQUE_REMINDER_OUTSIDE_WINDOW", "ارسال پیامک فقط در بازهٔ تنظیم‌شده تا سررسید مجاز است.");
    }
    const [recipient] = await db.select({ phone: users.phone, mobileVerified: users.mobileVerified })
      .from(users).where(eq(users.id, ctx.userId)).limit(1);
    if (!recipient?.phone || !recipient.mobileVerified) {
      throw new ApiError(422, "VERIFIED_MOBILE_REQUIRED", "برای ارسال یادآور، شماره موبایل تأییدشدهٔ حساب کاربری لازم است.");
    }
    const idemKey = req.headers.get("idempotency-key")?.trim() || "";
    if (!idemKey || idemKey.length > 160) throw new ApiError(400, "IDEMPOTENCY_KEY_REQUIRED", "کلید یکتای ارسال یادآور معتبر نیست.");
    const endpoint = `/api/v1/cheques/${id}/reminder`;
    const requestHash = sha256(JSON.stringify({ cheque_id: cheque.id, due_date: cheque.dueDate, days_before: body.days_before }));
    const reservation = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${ctx.organizationId}:${idemKey}`}))`);
      const [existing] = await tx.select().from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.organizationId, ctx.organizationId), eq(idempotencyKeys.key, idemKey))).limit(1);
      if (existing && existing.expiresAt > new Date()) {
        if (existing.requestHash !== requestHash || existing.endpoint !== endpoint) {
          throw new ApiError(409, "IDEMPOTENCY_PAYLOAD_MISMATCH", "کلید یکتا قبلاً برای یادآور دیگری استفاده شده است.");
        }
        if (existing.statusCode === 200 && existing.responseBody.sent === true) return "sent" as const;
        if (existing.statusCode === 202 && Date.now() - existing.createdAt.getTime() < 5 * 60_000) return "pending" as const;
        await tx.delete(idempotencyKeys).where(eq(idempotencyKeys.id, existing.id));
      }
      await tx.insert(idempotencyKeys).values({
        organizationId: ctx.organizationId, key: idemKey, endpoint, requestHash, statusCode: 202,
        responseBody: { pending: true }, expiresAt: new Date(Date.now() + 365 * 86_400_000),
      });
      return "reserved" as const;
    });
    if (reservation === "sent") return ok({ sent: true, already_sent: true });
    if (reservation === "pending") return ok({ sent: false, pending: true });

    const message = `یادآوری سررسید چک ${cheque.chequeType === "RECEIVABLE" ? "دریافتی" : "صادره"}؛ شماره ${cheque.sayadId}، بانک ${cheque.bankName}، مبلغ ${formatDecimal(parseDecimal(cheque.amount), 2)}، تاریخ سررسید ${gregorianIsoToJalali(cheque.dueDate)}.`;
    try {
      const sent = await sendSmsViaGateway({
        mobile: recipient.phone, purpose: "NOTIFICATION", message, organizationId: ctx.organizationId,
      });
      const responseBody = { sent: true, already_sent: false, days_before: body.days_before, message_id: sent.message_id };
      await db.update(idempotencyKeys).set({ statusCode: 200, responseBody })
        .where(and(eq(idempotencyKeys.organizationId, ctx.organizationId), eq(idempotencyKeys.key, idemKey)));
      return ok(responseBody);
    } catch (error) {
      await db.update(idempotencyKeys).set({ statusCode: 502, responseBody: { sent: false, failed: true } })
        .where(and(eq(idempotencyKeys.organizationId, ctx.organizationId), eq(idempotencyKeys.key, idemKey)));
      throw error;
    }
  }

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

  // GET /api/v1/cheques/analytics?month_jalali=YYYY/MM (§10.5 Daily Bar Chart Series)
  if (method === "GET" && id === "analytics") {
    const ctx = await requireOrgContext(req, "cheques.view");
    const jalaliMonthRaw = req.nextUrl.searchParams.get("month_jalali");
    const monthParam = req.nextUrl.searchParams.get("month") || new Date().toISOString().slice(0, 7);
    let startIso: string;
    let endIso: string;
    let monthLabel: string;
    let jalaliMode = false;

    if (jalaliMonthRaw) {
      const normalized = normalizePersianDigits(jalaliMonthRaw.trim()).replace(/-/g, "/");
      const match = /^(\d{4})\/(\d{1,2})$/.exec(normalized);
      if (!match) throw new ApiError(422, "INVALID_JALALI_MONTH", "ماه شمسی معتبر نیست.");
      const jalaliYear = Number(match[1]);
      const jalaliMonth = Number(match[2]);
      if (jalaliYear < 1200 || jalaliYear > 1599 || jalaliMonth < 1 || jalaliMonth > 12) {
        throw new ApiError(422, "INVALID_JALALI_MONTH", "ماه شمسی خارج از بازهٔ مجاز است.");
      }
      startIso = jalaliToGregorianIso(`${jalaliYear}/${String(jalaliMonth).padStart(2, "0")}/01`);
      const nextYear = jalaliMonth === 12 ? jalaliYear + 1 : jalaliYear;
      const nextMonth = jalaliMonth === 12 ? 1 : jalaliMonth + 1;
      const nextStart = jalaliToGregorianIso(`${nextYear}/${String(nextMonth).padStart(2, "0")}/01`);
      endIso = new Date(Date.parse(`${nextStart}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
      monthLabel = `${jalaliYear}/${String(jalaliMonth).padStart(2, "0")}`;
      jalaliMode = true;
    } else {
      const [yearStr, monStr] = monthParam.split("-");
      const year = Number(yearStr) || new Date().getUTCFullYear();
      const mon = Number(monStr) || new Date().getUTCMonth() + 1;
      const daysInMonth = new Date(Date.UTC(year, mon, 0)).getUTCDate();
      startIso = `${year}-${String(mon).padStart(2, "0")}-01`;
      endIso = `${year}-${String(mon).padStart(2, "0")}-${String(daysInMonth).padStart(2, "0")}`;
      monthLabel = `${year}-${String(mon).padStart(2, "0")}`;
    }

    const endTimestamp = Date.parse(`${endIso}T00:00:00Z`);
    const startTimestamp = Date.parse(`${startIso}T00:00:00Z`);
    const dayCount = Math.floor((endTimestamp - startTimestamp) / 86_400_000) + 1;
    const dailyMap = new Map<string, { day: number; rec: bigint; iss: bigint }>();
    for (let index = 0; index < dayCount; index++) {
      const iso = new Date(startTimestamp + index * 86_400_000).toISOString().slice(0, 10);
      const jalaliDay = Number(gregorianIsoToJalali(iso).split("/")[2]);
      dailyMap.set(iso, { day: jalaliMode ? jalaliDay : Number(iso.slice(8, 10)), rec: BigInt(0), iss: BigInt(0) });
    }

    const list = await db
      .select()
      .from(cheques)
      .where(eq(cheques.organizationId, ctx.organizationId));

    for (const cheque of list) {
      const bucket = dailyMap.get(cheque.dueDate);
      if (!bucket) continue;
      if (cheque.chequeType === "RECEIVABLE") bucket.rec = addDec(bucket.rec, cheque.amount);
      else bucket.iss = addDec(bucket.iss, cheque.amount);
    }

    const daily_series = Array.from(dailyMap.entries()).map(([dateStr, vals]) => ({
      date: dateStr,
      jalali_date: gregorianIsoToJalali(dateStr),
      day: vals.day,
      received_amount: formatDecimal(vals.rec, 2),
      issued_amount: formatDecimal(vals.iss, 2),
    }));

    return ok({ month: monthLabel, daily_series });
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

import { NextRequest, NextResponse } from "next/server";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import * as XLSX from "xlsx";
import { db } from "@/db";
import {
  accountGroups,
  accountingPeriods,
  accountingPolicies,
  accounts,
  cheques,
  contacts,
  contactTransactions,
  costCenters,
  devices,
  financialAccounts,
  financialTransactions,
  fiscalYears,
  journalEntries,
  journalEntryLines,
  products,
  purchaseInvoices,
  quickTransactions,
  reportExportJobs,
  salesInvoices,
  stockLedger,
  syncConflicts,
} from "@/db/schema";
import { ensurePrompt05OrgDefaults } from "@/db/seed-prompt05";
import { appendSyncChangeLog } from "@/modules/sync/changelog";
import { isNegativeDec, parseDecimal } from "@/lib/decimal";
import { gregorianIsoToJalali, resolveCanonicalDate } from "@/lib/jalali";
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
import { checkIdempotency, saveIdempotency } from "@/lib/idempotency";
import { requireOrgContext } from "@/lib/tenant";
import {
  buildAccountingReports,
  createJournalEntry,
  postJournalEntry,
  reverseJournalEntry,
} from "@/modules/accounting/service";
import { getLiveStockBalances } from "@/modules/inventory/service";

const createAccountSchema = z.object({
  group_id: z.string().uuid(),
  code: z.string().min(2),
  name: z.string().min(2),
  account_type: z.enum(["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"]),
  normal_balance: z.enum(["DEBIT", "CREDIT"]),
  is_postable: z.boolean().default(true),
});

const createJournalSchema = z.object({
  client_document_id: z.string().uuid().optional(),
  fiscal_year_id: z.string().uuid().optional(),
  accounting_period_id: z.string().uuid().optional(),
  document_date: z.string().optional(),
  document_date_jalali: z.string().optional(),
  entry_date: z.string().optional(),
  description: z.string().min(3),
  post_immediately: z.boolean().default(false),
  confirm_immediately: z.boolean().default(false),
  lines: z
    .array(
      z.object({
        account_id: z.string().uuid(),
        contact_id: z.string().uuid().nullable().optional(),
        cost_center_id: z.string().uuid().nullable().optional(),
        description: z.string().optional(),
        debit: z.string().regex(/^\d+(\.\d{1,2})?$/),
        credit: z.string().regex(/^\d+(\.\d{1,2})?$/),
      })
    )
    .min(2),
});

export async function handleAccountingRoutes(
  req: NextRequest,
  method: string,
  segments: string[]
) {
  await ensureSeeded();
  const sub = segments[1];
  const id = segments[2];
  const action = segments[3];

  // /api/v1/accounting/accounts
  if (sub === "accounts") {
    if (method === "GET" && !id) {
      const ctx = await requireOrgContext(req, "accounting.view");
      const [groups, accs] = await Promise.all([
        db.select().from(accountGroups).where(eq(accountGroups.organizationId, ctx.organizationId)).orderBy(accountGroups.code),
        db.select().from(accounts).where(eq(accounts.organizationId, ctx.organizationId)).orderBy(accounts.code),
      ]);
      return ok({ groups, accounts: accs });
    }
    if (method === "POST" && !id) {
      const ctx = await requireOrgContext(req, "accounting.journal.create", { requireActiveSubscription: true });
      const body = createAccountSchema.parse(await req.json());
      const [created] = await db
        .insert(accounts)
        .values({
          organizationId: ctx.organizationId,
          groupId: body.group_id,
          code: body.code.trim(),
          name: body.name.trim(),
          accountType: body.account_type,
          normalBalance: body.normal_balance,
          isPostable: body.is_postable,
        })
        .returning();
      return ok(created, 201);
    }
    if (id) {
      const ctx = await requireOrgContext(req, "accounting.view");
      const [acc] = await db
        .select()
        .from(accounts)
        .where(and(eq(accounts.id, id), eq(accounts.organizationId, ctx.organizationId)))
        .limit(1);
      if (!acc) throw new ApiError(404, "ACCOUNT_NOT_FOUND", "حساب یافت نشد.");
      if (method === "GET") return ok(acc);
      if (method === "PATCH") {
        await requireOrgContext(req, "accounting.journal.create", { requireActiveSubscription: true });
        const body = (await req.json()) as { name?: string; is_active?: boolean };
        const [upd] = await db
          .update(accounts)
          .set({ ...(body.name ? { name: body.name } : {}), ...(body.is_active !== undefined ? { isActive: body.is_active } : {}) })
          .where(eq(accounts.id, acc.id))
          .returning();
        return ok(upd);
      }
    }
  }

  // /api/v1/accounting/fiscal-years & periods toggle
  if (sub === "fiscal-years") {
    const ctx = await requireOrgContext(req, "accounting.view");
    const [fys, periods, centers] = await Promise.all([
      db.select().from(fiscalYears).where(eq(fiscalYears.organizationId, ctx.organizationId)),
      db.select().from(accountingPeriods).where(eq(accountingPeriods.organizationId, ctx.organizationId)).orderBy(accountingPeriods.periodNumber),
      db.select().from(costCenters).where(eq(costCenters.organizationId, ctx.organizationId)),
    ]);
    return ok({ fiscal_years: fys, periods, cost_centers: centers });
  }

  // GET/PUT /api/v1/accounting/policy (Master Prompt 07 §6.2 & §9 — Non-retroactive organization tax & invoice policy)
  if (sub === "policy") {
    if (method === "GET") {
      const ctx = await requireOrgContext(req, "accounting.policy.view");
      await ensurePrompt05OrgDefaults(ctx.organizationId);
      const [pol] = await db
        .select()
        .from(accountingPolicies)
        .where(eq(accountingPolicies.organizationId, ctx.organizationId))
        .limit(1);
      return ok(pol);
    }
    if (method === "PUT" || method === "PATCH") {
      const ctx = await requireOrgContext(req, "accounting.policy.update", { requireActiveSubscription: true });
      const body = z
        .object({
          default_tax_rate: z.string().regex(/^\d+(\.\d{1,2})?$/, "نرخ مالیات باید عدد اعشاری معتبر باشد."),
          is_tax_inclusive: z.boolean(),
          invoice_prefix: z.string().min(1).max(24),
          low_stock_alert_enabled: z.boolean(),
        })
        .parse(await req.json());

      const taxNum = parseDecimal(body.default_tax_rate);
      if (isNegativeDec(taxNum) || taxNum > parseDecimal("100.00")) {
        throw new ApiError(422, "TAX_RATE_OUT_OF_RANGE", "نرخ مالیات باید بین ۰ تا ۱۰۰ درصد باشد.");
      }

      const [saved] = await db
        .insert(accountingPolicies)
        .values({
          organizationId: ctx.organizationId,
          defaultTaxRate: body.default_tax_rate,
          isTaxInclusive: body.is_tax_inclusive,
          invoicePrefix: body.invoice_prefix.trim(),
          lowStockAlertEnabled: body.low_stock_alert_enabled,
          updatedBy: ctx.userId,
        })
        .onConflictDoUpdate({
          target: [accountingPolicies.organizationId],
          set: {
            defaultTaxRate: body.default_tax_rate,
            isTaxInclusive: body.is_tax_inclusive,
            invoicePrefix: body.invoice_prefix.trim(),
            lowStockAlertEnabled: body.low_stock_alert_enabled,
            updatedBy: ctx.userId,
            updatedAt: new Date(),
          },
        })
        .returning();

      await recordAuditLog({
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorEmail: ctx.email,
        scope: "ORGANIZATION",
        action: "ACCOUNTING_POLICY_UPDATED",
        entityType: "ACCOUNTING_POLICY",
        entityId: saved.id,
        ipAddress: ctx.ipAddress,
        metadata: {
          defaultTaxRate: saved.defaultTaxRate,
          isTaxInclusive: saved.isTaxInclusive,
          invoicePrefix: saved.invoicePrefix,
          nonRetroactive: true,
        },
      });
      return ok(saved);
    }
  }

  // GET/POST/PATCH/DELETE /api/v1/accounting/cost-centers (Master Prompt 07 §6.3)
  if (sub === "cost-centers") {
    if (method === "GET" && !id) {
      const ctx = await requireOrgContext(req, "accounting.cost_centers.view");
      const list = await db
        .select()
        .from(costCenters)
        .where(eq(costCenters.organizationId, ctx.organizationId))
        .orderBy(asc(costCenters.code));
      return ok(list);
    }
    if (method === "POST" && !id) {
      const ctx = await requireOrgContext(req, "accounting.cost_centers.create", { requireActiveSubscription: true });
      const body = z
        .object({
          code: z.string().min(2).max(32),
          name: z.string().min(2).max(120),
          type: z.enum(["DEPARTMENT", "BRANCH", "PROJECT", "PRODUCT_LINE", "GENERAL"]).default("DEPARTMENT"),
          is_active: z.boolean().default(true),
        })
        .parse(await req.json());

      const [created] = await db
        .insert(costCenters)
        .values({
          organizationId: ctx.organizationId, // Always from verified Auth Context!
          code: body.code.trim(),
          name: body.name.trim(),
          type: body.type,
          isActive: body.is_active,
          version: 1,
        })
        .returning();

      await appendSyncChangeLog(db, {
        organizationId: ctx.organizationId,
        entityType: "cost_center",
        entityId: created.id,
        operation: "UPSERT",
        version: created.version,
        payload: { id: created.id, code: created.code, name: created.name, type: created.type, is_active: created.isActive },
      });

      await recordAuditLog({
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorEmail: ctx.email,
        scope: "ORGANIZATION",
        action: "COST_CENTER_CREATED",
        entityType: "COST_CENTER",
        entityId: created.id,
        ipAddress: ctx.ipAddress,
        metadata: { code: created.code, name: created.name, type: created.type },
      });
      return ok(created, 201);
    }
    if (id && action === "profit-loss" && method === "GET") {
      const ctx = await requireOrgContext(req, "reports.profit.view");
      const lines = await db
        .select({
          accountType: accounts.accountType,
          debit: journalEntryLines.debit,
          credit: journalEntryLines.credit,
        })
        .from(journalEntryLines)
        .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
        .innerJoin(accounts, eq(journalEntryLines.accountId, accounts.id))
        .where(
          and(
            eq(journalEntries.organizationId, ctx.organizationId),
            eq(journalEntryLines.costCenterId, id),
            inArray(journalEntries.status, ["POSTED", "REVERSED"])
          )
        );
      let revenue = BigInt(0);
      let expense = BigInt(0);
      for (const l of lines) {
        if (l.accountType === "REVENUE") revenue = addDec(revenue, subDec(l.credit, l.debit));
        if (l.accountType === "EXPENSE") expense = addDec(expense, subDec(l.debit, l.credit));
      }
      return ok({
        cost_center_id: id,
        total_revenue: formatDecimal(revenue, 2),
        total_expense: formatDecimal(expense, 2),
        net_profit: formatDecimal(subDec(revenue, expense), 2),
      });
    }
    if (id && method === "PATCH") {
      const ctx = await requireOrgContext(req, "accounting.cost_centers.update", { requireActiveSubscription: true });
      const body = z
        .object({
          name: z.string().min(2).max(120).optional(),
          type: z.enum(["DEPARTMENT", "BRANCH", "PROJECT", "PRODUCT_LINE", "GENERAL"]).optional(),
          is_active: z.boolean().optional(),
        })
        .parse(await req.json());
      const [existing] = await db
        .select()
        .from(costCenters)
        .where(and(eq(costCenters.id, id), eq(costCenters.organizationId, ctx.organizationId)))
        .limit(1);
      if (!existing) throw new ApiError(404, "COST_CENTER_NOT_FOUND", "مرکز هزینه یافت نشد.");

      const [upd] = await db
        .update(costCenters)
        .set({
          ...(body.name ? { name: body.name.trim() } : {}),
          ...(body.type ? { type: body.type } : {}),
          ...(body.is_active !== undefined ? { isActive: body.is_active } : {}),
          version: existing.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(costCenters.id, existing.id))
        .returning();

      await appendSyncChangeLog(db, {
        organizationId: ctx.organizationId,
        entityType: "cost_center",
        entityId: upd.id,
        operation: "UPSERT",
        version: upd.version,
        payload: { id: upd.id, code: upd.code, name: upd.name, type: upd.type, is_active: upd.isActive },
      });
      return ok(upd);
    }
    if (id && method === "DELETE") {
      const ctx = await requireOrgContext(req, "accounting.cost_centers.update", { requireActiveSubscription: true });
      const [existing] = await db
        .select()
        .from(costCenters)
        .where(and(eq(costCenters.id, id), eq(costCenters.organizationId, ctx.organizationId)))
        .limit(1);
      if (!existing) throw new ApiError(404, "COST_CENTER_NOT_FOUND", "مرکز هزینه یافت نشد.");

      // Forbid physical delete if used in any journal line or quick transaction!
      const [usedInJournal, usedInQuick] = await Promise.all([
        db.select({ id: journalEntryLines.id }).from(journalEntryLines).where(eq(journalEntryLines.costCenterId, id)).limit(1),
        db.select({ id: quickTransactions.id }).from(quickTransactions).where(eq(quickTransactions.costCenterId, id)).limit(1),
      ]);
      if (usedInJournal.length > 0 || usedInQuick.length > 0) {
        const [deactivated] = await db
          .update(costCenters)
          .set({ isActive: false, version: existing.version + 1, updatedAt: new Date() })
          .where(eq(costCenters.id, id))
          .returning();
        return ok({ deactivated: true, physically_deleted: false, cost_center: deactivated });
      }
      const [tomb] = await db
        .update(costCenters)
        .set({ isActive: false, deletedAt: new Date(), version: existing.version + 1, updatedAt: new Date() })
        .where(eq(costCenters.id, id))
        .returning();
      await appendSyncChangeLog(db, {
        organizationId: ctx.organizationId,
        entityType: "cost_center",
        entityId: tomb.id,
        operation: "TOMBSTONE",
        version: tomb.version,
        payload: { id: tomb.id, is_deleted: true },
      });
      return ok({ deleted_id: tomb.id });
    }
  }

  // POST /api/v1/accounting/periods/lock & /periods/{id}/unlock (Master Prompt 07 §6.4 — Distinct from FY Closing!)
  if (sub === "periods" && id === "lock" && method === "POST") {
    const ctx = await requireOrgContext(req, "accounting.periods.lock", { requireActiveSubscription: true });
    const body = z
      .object({
        fiscal_year_id: z.string().uuid(),
        period_title: z.string().min(2),
        locked_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
      .parse(await req.json());

    const [fy] = await db
      .select()
      .from(fiscalYears)
      .where(and(eq(fiscalYears.id, body.fiscal_year_id), eq(fiscalYears.organizationId, ctx.organizationId)))
      .limit(1);
    if (!fy) throw new ApiError(404, "FISCAL_YEAR_NOT_FOUND", "سال مالی یافت نشد.");
    if (body.locked_until < fy.startDate || body.locked_until > fy.endDate) {
      throw new ApiError(
        422,
        "LOCK_DATE_OUT_OF_RANGE",
        `تاریخ قفل (${body.locked_until}) باید در محدوده سال مالی (${fy.startDate} تا ${fy.endDate}) باشد.`
      );
    }

    const fyPeriods = await db
      .select()
      .from(accountingPeriods)
      .where(and(eq(accountingPeriods.organizationId, ctx.organizationId), eq(accountingPeriods.fiscalYearId, fy.id)))
      .orderBy(asc(accountingPeriods.periodNumber));

    const targetPeriod =
      fyPeriods.find((p) => p.name === body.period_title) ||
      fyPeriods.find((p) => body.locked_until >= p.startDate && body.locked_until <= p.endDate) ||
      fyPeriods[0];

    if (!targetPeriod) throw new ApiError(404, "ACCOUNTING_PERIOD_NOT_FOUND", "دوره مالی منطبق یافت نشد.");

    const draftsInPeriod = await db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.organizationId, ctx.organizationId),
          eq(journalEntries.accountingPeriodId, targetPeriod.id),
          eq(journalEntries.status, "DRAFT")
        )
      );

    const [locked] = await db
      .update(accountingPeriods)
      .set({
        status: "LOCKED",
        lockedUntil: body.locked_until,
        lockedBy: ctx.userId,
        lockedAt: new Date(),
      })
      .where(eq(accountingPeriods.id, targetPeriod.id))
      .returning();

    await recordAuditLog({
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      actorEmail: ctx.email,
      scope: "ORGANIZATION",
      action: "ACCOUNTING_PERIOD_LOCKED",
      entityType: "ACCOUNTING_PERIOD",
      entityId: locked.id,
      ipAddress: ctx.ipAddress,
      metadata: {
        fiscalYearId: fy.id,
        periodTitle: body.period_title,
        lockedUntil: body.locked_until,
        draftsWarningCount: draftsInPeriod.length,
      },
    });

    return ok({
      period: locked,
      warnings:
        draftsInPeriod.length > 0
          ? [`تعداد ${draftsInPeriod.length} سند پیش‌نویس در این دوره وجود دارد.`]
          : [],
    });
  }

  if (sub === "periods" && id && action === "unlock" && method === "POST") {
    const ctx = await requireOrgContext(req, "accounting.periods.unlock", { requireActiveSubscription: true });
    const body = z
      .object({ reason: z.string().min(5, "ذکر دلیل رسمی (حداقل ۵ کاراکتر) برای بازگشایی دوره قفل‌شده الزامی است.") })
      .parse(await req.json());

    const [upd] = await db
      .update(accountingPeriods)
      .set({
        status: "OPEN",
        lockedUntil: null,
        unlockReason: body.reason,
      })
      .where(and(eq(accountingPeriods.id, id), eq(accountingPeriods.organizationId, ctx.organizationId)))
      .returning();
    if (!upd) throw new ApiError(404, "ACCOUNTING_PERIOD_NOT_FOUND", "دوره مالی یافت نشد.");

    await recordAuditLog({
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      actorEmail: ctx.email,
      scope: "SECURITY",
      action: "ACCOUNTING_PERIOD_UNLOCKED",
      entityType: "ACCOUNTING_PERIOD",
      entityId: upd.id,
      ipAddress: ctx.ipAddress,
      severity: "WARN",
      metadata: { reason: body.reason },
    });
    return ok(upd);
  }

  if (sub === "periods" && id && method === "PATCH") {
    const ctx = await requireOrgContext(req, "accounting.period.manage", { requireActiveSubscription: true });
    const body = z.object({ status: z.enum(["OPEN", "LOCKED", "CLOSED"]) }).parse(await req.json());
    const [upd] = await db
      .update(accountingPeriods)
      .set({
        status: body.status,
        closedAt: body.status === "CLOSED" ? new Date() : null,
        closedBy: body.status === "CLOSED" ? ctx.userId : null,
        ...(body.status === "OPEN" ? { lockedUntil: null } : {}),
      })
      .where(and(eq(accountingPeriods.id, id), eq(accountingPeriods.organizationId, ctx.organizationId)))
      .returning();
    if (!upd) throw new ApiError(404, "ACCOUNTING_PERIOD_NOT_FOUND", "دوره مالی یافت نشد.");
    return ok(upd);
  }

  // /api/v1/accounting/journal-entries
  if (sub === "journal-entries") {
    if (method === "GET" && !id) {
      const ctx = await requireOrgContext(req, "accounting.view");
      const q = parseListQuery(req);
      const [entries, lines, accs] = await Promise.all([
        db
          .select()
          .from(journalEntries)
          .where(eq(journalEntries.organizationId, ctx.organizationId))
          .orderBy(desc(journalEntries.entryNumber)),
        db
          .select()
          .from(journalEntryLines)
          .where(eq(journalEntryLines.organizationId, ctx.organizationId))
          .orderBy(journalEntryLines.lineOrder),
        db.select().from(accounts).where(eq(accounts.organizationId, ctx.organizationId)),
      ]);
      const accMap = new Map(accs.map((a) => [a.id, a]));

      const enriched = entries.map((e) => ({
        id: e.id,
        organization_id: e.organizationId,
        fiscal_year_id: e.fiscalYearId,
        accounting_period_id: e.accountingPeriodId,
        document_number: e.entryNumber,
        document_date: e.entryDate,
        description: e.description,
        source_type: e.referenceType,
        source_id: e.referenceId,
        reversed_entry_id: e.reversedEntryId,
        status: e.status === "POSTED" ? "CONFIRMED" : e.status,
        total_debit: e.totalDebit,
        total_credit: e.totalCredit,
        lines: lines
          .filter((l) => l.journalEntryId === e.id)
          .map((l) => ({
            id: l.id,
            account_id: l.accountId,
            account_code: accMap.get(l.accountId)?.code ?? "",
            account_name: accMap.get(l.accountId)?.name ?? "",
            contact_id: l.contactId,
            cost_center_id: l.costCenterId,
            description: l.description,
            debit: l.debit,
            credit: l.credit,
          })),
        created_at: e.createdAt,
      }));
      const { items, total } = applyListFilterAndPaginate(enriched, q, ["description"]);
      return okList(items, { page: q.page, perPage: q.perPage, total });
    }

    if (method === "POST" && !id) {
      const parsed = createJournalSchema.parse(await req.json());
      const shouldConfirm = parsed.confirm_immediately || parsed.post_immediately;
      const ctx = await requireOrgContext(
        req,
        shouldConfirm ? "accounting.journal.confirm" : "accounting.journal.create",
        { requireActiveSubscription: true }
      );
      const idemKey = req.headers.get("idempotency-key");
      const cached = await checkIdempotency({
        organizationId: ctx.organizationId,
        key: idemKey,
        endpoint: "/api/v1/accounting/journal-entries",
        payload: parsed,
      });
      if (cached) return ok(cached.responseBody, cached.statusCode, { replayed: true });

      const canonicalEntryDate = resolveCanonicalDate(
        parsed.document_date || parsed.entry_date,
        parsed.document_date_jalali
      );
      const result = await createJournalEntry({
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorEmail: ctx.email,
        ipAddress: ctx.ipAddress,
        fiscalYearId: parsed.fiscal_year_id,
        accountingPeriodId: parsed.accounting_period_id,
        entryDate: canonicalEntryDate,
        description: parsed.description,
        postImmediately: shouldConfirm,
        lines: parsed.lines.map((l) => ({
          accountId: l.account_id,
          debit: l.debit,
          credit: l.credit,
          description: l.description,
          costCenterId: l.cost_center_id,
          contactId: l.contact_id,
        })),
      });

      const payload = {
        ...result.entry,
        document_number: result.entry.entryNumber,
        document_date: result.entry.entryDate,
        document_date_jalali: gregorianIsoToJalali(result.entry.entryDate),
        status: result.entry.status === "POSTED" ? "CONFIRMED" : result.entry.status,
        lines: result.lines,
      };
      await saveIdempotency({
        organizationId: ctx.organizationId,
        key: idemKey,
        endpoint: "/api/v1/accounting/journal-entries",
        payload: parsed,
        statusCode: 201,
        responseBody: payload as unknown as Record<string, unknown>,
      });
      return ok(payload, 201);
    }

    if (id) {
      const ctx = await requireOrgContext(req, "accounting.view");
      const [entry] = await db
        .select()
        .from(journalEntries)
        .where(and(eq(journalEntries.id, id), eq(journalEntries.organizationId, ctx.organizationId)))
        .limit(1);
      if (!entry) throw new ApiError(404, "JOURNAL_NOT_FOUND", "سند حسابداری یافت نشد.");

      if (method === "GET" && !action) {
        const lines = await db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, entry.id));
        return ok({ ...entry, status: entry.status === "POSTED" ? "CONFIRMED" : entry.status, lines });
      }
      if (method === "PATCH" && !action) {
        await requireOrgContext(req, "accounting.journal.create", { requireActiveSubscription: true });
        if (entry.status !== "DRAFT") {
          throw new ApiError(409, "ACCOUNTING_ENTRY_IMMUTABLE", "سند قطعی قابل ویرایش مستقیم نیست! از سند معکوس استفاده کنید.");
        }
        const body = (await req.json()) as { description?: string };
        const [upd] = await db
          .update(journalEntries)
          .set({ ...(body.description ? { description: body.description } : {}), updatedAt: new Date() })
          .where(eq(journalEntries.id, entry.id))
          .returning();
        return ok(upd);
      }
      if (method === "DELETE" && !action) {
        await requireOrgContext(req, "accounting.journal.create", { requireActiveSubscription: true });
        if (entry.status !== "DRAFT") {
          throw new ApiError(409, "ACCOUNTING_ENTRY_IMMUTABLE", "سند قطعی قابل حذف مستقیم نیست! از سند معکوس استفاده کنید.");
        }
        await db.delete(journalEntries).where(eq(journalEntries.id, entry.id));
        return ok({ deleted_id: entry.id });
      }
      if (method === "POST" && (action === "confirm" || action === "post")) {
        await requireOrgContext(req, "accounting.journal.confirm", { requireActiveSubscription: true });
        const posted = await postJournalEntry({
          organizationId: ctx.organizationId,
          journalEntryId: entry.id,
          actorUserId: ctx.userId,
          actorEmail: ctx.email,
          ipAddress: ctx.ipAddress,
        });
        return ok({ ...posted, status: "CONFIRMED" });
      }
      if (method === "POST" && action === "reverse") {
        await requireOrgContext(req, "accounting.journal_entries.reverse", { requireActiveSubscription: true });
        const body = z
          .object({ reason: z.string().min(2, "ذکر دلیل برگشت سند حسابداری الزامی است.").optional() })
          .parse(await req.json().catch(() => ({})));
        const idemKey = req.headers.get("idempotency-key");
        const cached = await checkIdempotency({
          organizationId: ctx.organizationId,
          key: idemKey,
          endpoint: `/api/v1/accounting/journal-entries/${entry.id}/reverse`,
          payload: { id: entry.id, reason: body.reason ?? "" },
        });
        if (cached) return ok(cached.responseBody, cached.statusCode, { replayed: true });

        const res = await reverseJournalEntry({
          organizationId: ctx.organizationId,
          journalEntryId: entry.id,
          reason: body.reason ?? "سند معکوس اصلاحی",
          actorUserId: ctx.userId,
          actorEmail: ctx.email,
          ipAddress: ctx.ipAddress,
        });
        await saveIdempotency({
          organizationId: ctx.organizationId,
          key: idemKey,
          endpoint: `/api/v1/accounting/journal-entries/${entry.id}/reverse`,
          payload: { id: entry.id, reason: body.reason ?? "" },
          statusCode: 201,
          responseBody: res as unknown as Record<string, unknown>,
        });
        return ok(res, 201);
      }
    }
  }

  // GET /api/v1/accounting/journal-book & /api/v1/accounting/journal-book/export (Real XLSX!)
  if (method === "GET" && sub === "journal-book") {
    const ctx = await requireOrgContext(req, "reports.financial.view");
    const [postedEntries, lines, accs, orgContacts] = await Promise.all([
      db
        .select()
        .from(journalEntries)
        .where(
          and(
            eq(journalEntries.organizationId, ctx.organizationId),
            inArray(journalEntries.status, ["POSTED", "REVERSED"])
          )
        )
        .orderBy(asc(journalEntries.entryNumber)),
      db
        .select()
        .from(journalEntryLines)
        .where(eq(journalEntryLines.organizationId, ctx.organizationId))
        .orderBy(asc(journalEntryLines.lineOrder)),
      db.select().from(accounts).where(eq(accounts.organizationId, ctx.organizationId)),
      db.select().from(contacts).where(eq(contacts.organizationId, ctx.organizationId)),
    ]);

    const accMap = new Map(accs.map((a) => [a.id, a]));
    const contactMap = new Map(orgContacts.map((c) => [c.id, c.name]));

    let totalDebit = BigInt(0);
    let totalCredit = BigInt(0);
    const rows: Array<{
      document_number: number;
      document_date: string;
      source_type: string;
      status: string;
      account_code: string;
      account_name: string;
      contact_name: string;
      description: string;
      debit: string;
      credit: string;
    }> = [];

    for (const e of postedEntries) {
      const eLines = lines.filter((l) => l.journalEntryId === e.id);
      for (const l of eLines) {
        totalDebit = addDec(totalDebit, l.debit);
        totalCredit = addDec(totalCredit, l.credit);
        const acc = accMap.get(l.accountId);
        rows.push({
          document_number: e.entryNumber,
          document_date: e.entryDate,
          source_type: e.referenceType,
          status: e.status === "POSTED" ? "CONFIRMED" : e.status,
          account_code: acc?.code ?? "",
          account_name: acc?.name ?? "",
          contact_name: l.contactId ? contactMap.get(l.contactId) ?? "" : "",
          description: l.description || e.description,
          debit: l.debit,
          credit: l.credit,
        });
      }
    }

    // Real Excel XLSX Binary Export (Scenario H!)
    if (id === "export") {
      const sheetRows = rows.map((r) => ({
        "شماره سند": r.document_number,
        "تاریخ سند": r.document_date,
        "منبع": r.source_type,
        "کد حساب": r.account_code,
        "عنوان حساب": r.account_name,
        "تفصیلی / شخص": r.contact_name,
        "شرح آرتیکل": r.description,
        "بدهکار": r.debit,
        "بستانکار": r.credit,
      }));
      sheetRows.push({
        "شماره سند": 0,
        "تاریخ سند": "جمع کل",
        "منبع": "",
        "کد حساب": "",
        "عنوان حساب": "TOTAL",
        "تفصیلی / شخص": "",
        "شرح آرتیکل": totalDebit === totalCredit ? "BALANCED" : "UNBALANCED",
        "بدهکار": formatDecimal(totalDebit, 2),
        "بستانکار": formatDecimal(totalCredit, 2),
      });

      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.json_to_sheet(sheetRows);
      XLSX.utils.book_append_sheet(wb, ws, "JournalBook");
      const xlsxBuffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
      const fileName = `journal-book-${ctx.organization.id.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.xlsx`;

      await db.insert(reportExportJobs).values({
        organizationId: ctx.organizationId,
        requestedBy: ctx.userId,
        reportType: "JOURNAL_BOOK",
        format: "XLSX",
        fileName,
        rowCount: rows.length,
        status: "COMPLETED",
      });

      await recordAuditLog({
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorEmail: ctx.email,
        scope: "ORGANIZATION",
        action: "JOURNAL_BOOK_XLSX_EXPORTED",
        entityType: "REPORT_EXPORT",
        ipAddress: ctx.ipAddress,
        metadata: { rowCount: rows.length, totalDebit: formatDecimal(totalDebit, 2) },
      });

      return new NextResponse(new Uint8Array(xlsxBuffer), {
        status: 200,
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="${fileName}"`,
          "X-Total-Debit": formatDecimal(totalDebit, 2),
          "X-Total-Credit": formatDecimal(totalCredit, 2),
        },
      });
    }

    return ok({
      is_balanced: totalDebit === totalCredit,
      total_debit: formatDecimal(totalDebit, 2),
      total_credit: formatDecimal(totalCredit, 2),
      rows_count: rows.length,
      rows,
    });
  }

  // Ledger & Financial Statement Endpoints under /api/v1/accounting/*
  if (
    method === "GET" &&
    [
      "ledger",
      "general-ledger",
      "subsidiary-ledger",
      "detail-ledger",
      "trial-balance",
      "profit-loss",
      "balance-sheet",
      "account-statement",
    ].includes(sub ?? "")
  ) {
    // Scenario I: Strict RBAC — Profit & Loss requires `reports.profit.view`!
    const perm = sub === "profit-loss" ? "reports.profit.view" : "reports.financial.view";
    const ctx = await requireOrgContext(req, perm);
    const reports = await buildAccountingReports(ctx.organizationId);
    if (sub === "trial-balance") {
      return ok({
        is_balanced: reports.isTrialBalanced,
        grand_total_debit: reports.grandTotalDebit,
        grand_total_credit: reports.grandTotalCredit,
        rows: reports.trialBalance,
      });
    }
    if (sub === "profit-loss") {
      return ok({
        ...reports.profitAndLoss,
        revenue_accounts: reports.trialBalance.filter((a) => a.accountType === "REVENUE"),
        expense_accounts: reports.trialBalance.filter((a) => a.accountType === "EXPENSE"),
      });
    }
    if (sub === "balance-sheet") {
      return ok({
        ...reports.balanceSheetSummary,
        assets: reports.trialBalance.filter((a) => a.accountType === "ASSET"),
        liabilities: reports.trialBalance.filter((a) => a.accountType === "LIABILITY"),
        equity: reports.trialBalance.filter((a) => a.accountType === "EQUITY"),
      });
    }
    if (sub === "subsidiary-ledger" || sub === "detail-ledger") {
      const contactId = req.nextUrl.searchParams.get("contact_id");
      const [allContacts, txs] = await Promise.all([
        db.select().from(contacts).where(eq(contacts.organizationId, ctx.organizationId)),
        db.select().from(contactTransactions).where(eq(contactTransactions.organizationId, ctx.organizationId)),
      ]);
      const filteredContacts = contactId ? allContacts.filter((c) => c.id === contactId) : allContacts;
      const ledgers = filteredContacts.map((c) => {
        const cTxs = txs.filter((t) => t.contactId === c.id);
        let deb = BigInt(0);
        let cred = BigInt(0);
        for (const t of cTxs) {
          deb = addDec(deb, t.debit);
          cred = addDec(cred, t.credit);
        }
        return {
          contact_id: c.id,
          code: c.code,
          display_name: c.name,
          total_debit: formatDecimal(deb, 2),
          total_credit: formatDecimal(cred, 2),
          closing_balance: formatDecimal(subDec(deb, cred), 2),
          movements_count: cTxs.length,
        };
      });
      return ok({ ledger_type: sub, accounts: reports.trialBalance, detail_accounts: ledgers });
    }
    if (sub === "account-statement") {
      const accId = req.nextUrl.searchParams.get("account_id");
      const filtered = accId
        ? reports.recentLedgerMovements.filter((m) => m.accountId === accId)
        : reports.recentLedgerMovements;
      return ok({ account_id: accId, movements: filtered });
    }
    return ok({
      accounts: reports.trialBalance,
      movements: reports.recentLedgerMovements,
    });
  }

  throw new ApiError(404, "ROUTE_NOT_FOUND", "مسیر حسابداری یافت نشد.");
}

export async function handleReportRoutes(
  req: NextRequest,
  method: string,
  segments: string[]
) {
  await ensureSeeded();
  if (method !== "GET") throw new ApiError(405, "METHOD_NOT_ALLOWED", "فقط متد GET مجاز است.");
  const sub = segments[1] ?? "dashboard";
  const neededPerm = sub === "profit-loss" ? "reports.profit.view" : "reports.financial.view";
  const ctx = await requireOrgContext(req, neededPerm);
  const orgId = ctx.organizationId;

  if (sub === "dashboard") {
    const [reports, stock, finAccs, orgCheques, recentJournals, recentSales, orgDevices, openConflicts, orgContacts, orgProducts] =
      await Promise.all([
        buildAccountingReports(orgId),
        getLiveStockBalances(orgId),
        db.select().from(financialAccounts).where(eq(financialAccounts.organizationId, orgId)),
        db.select().from(cheques).where(eq(cheques.organizationId, orgId)).orderBy(cheques.dueDate).limit(6),
        db.select().from(journalEntries).where(eq(journalEntries.organizationId, orgId)).orderBy(desc(journalEntries.entryNumber)).limit(6),
        db.select().from(salesInvoices).where(eq(salesInvoices.organizationId, orgId)).orderBy(desc(salesInvoices.createdAt)).limit(6),
        db.select().from(devices).where(eq(devices.organizationId, orgId)),
        db.select().from(syncConflicts).where(and(eq(syncConflicts.organizationId, orgId), eq(syncConflicts.status, "OPEN"))),
        db.select({ id: contacts.id }).from(contacts).where(eq(contacts.organizationId, orgId)),
        db.select({ id: products.id }).from(products).where(eq(products.organizationId, orgId)),
      ]);

    let cashTotal = BigInt(0);
    for (const fa of finAccs) cashTotal = addDec(cashTotal, fa.balance);

    return ok({
      organization: ctx.organization,
      subscription_status: ctx.subscriptionStatus,
      plan_code: ctx.planCode,
      kpis: {
        total_revenue: reports.profitAndLoss.totalRevenue,
        total_expense: reports.profitAndLoss.totalExpense,
        net_profit: reports.profitAndLoss.netProfit,
        total_assets: reports.balanceSheetSummary.totalAssets,
        inventory_valuation: stock.totalValuation,
        cash_and_bank_total: formatDecimal(cashTotal, 2),
        is_trial_balanced: reports.isTrialBalanced,
        contacts_count: orgContacts.length,
        products_count: orgProducts.length,
        devices_count: orgDevices.length,
        open_conflicts_count: openConflicts.length,
      },
      financial_accounts: finAccs,
      pending_cheques: orgCheques,
      recent_journals: recentJournals,
      recent_sales: recentSales,
    });
  }

  if (sub === "trial-balance" || sub === "profit-loss" || sub === "balance-sheet") {
    const reports = await buildAccountingReports(orgId);
    return ok(reports);
  }

  if (sub === "inventory" || sub === "stock-card") {
    const [stock, movements] = await Promise.all([
      getLiveStockBalances(orgId),
      db.select().from(stockLedger).where(eq(stockLedger.organizationId, orgId)).orderBy(desc(stockLedger.createdAt)).limit(100),
    ]);
    return ok({ ...stock, movements });
  }

  if (sub === "sales") {
    const invs = await db.select().from(salesInvoices).where(eq(salesInvoices.organizationId, orgId));
    let total = BigInt(0);
    for (const i of invs.filter((x) => x.status !== "CANCELLED")) total = addDec(total, i.totalAmount);
    return ok({ invoices_count: invs.length, total_sales: formatDecimal(total, 2), invoices: invs });
  }

  if (sub === "purchases") {
    const invs = await db.select().from(purchaseInvoices).where(eq(purchaseInvoices.organizationId, orgId));
    let total = BigInt(0);
    for (const i of invs.filter((x) => x.status !== "CANCELLED")) total = addDec(total, i.totalAmount);
    return ok({ invoices_count: invs.length, total_purchases: formatDecimal(total, 2), invoices: invs });
  }

  if (sub === "contacts-balances" || sub === "receivables" || sub === "payables") {
    const [allContacts, txs] = await Promise.all([
      db.select().from(contacts).where(eq(contacts.organizationId, orgId)),
      db.select().from(contactTransactions).where(eq(contactTransactions.organizationId, orgId)),
    ]);
    const rows = allContacts.map((c) => {
      let bal = addDec(c.openingBalance, "0");
      for (const t of txs.filter((x) => x.contactId === c.id)) {
        bal = subDec(addDec(bal, t.debit), t.credit);
      }
      return { contact_id: c.id, code: c.code, display_name: c.name, balance: formatDecimal(bal, 2), rawBal: bal };
    });
    const filtered =
      sub === "receivables"
        ? rows.filter((r) => r.rawBal > BigInt(0))
        : sub === "payables"
          ? rows.filter((r) => r.rawBal < BigInt(0))
          : rows;
    return ok(filtered.map(({ rawBal: _r, ...rest }) => rest));
  }

  if (sub === "cash-flow") {
    const txs = await db.select().from(financialTransactions).where(eq(financialTransactions.organizationId, orgId));
    let inflow = BigInt(0);
    let outflow = BigInt(0);
    for (const t of txs) {
      if (t.txType === "RECEIPT" || t.txType === "INCOME") inflow = addDec(inflow, t.amount);
      if (t.txType === "PAYMENT" || t.txType === "EXPENSE") outflow = addDec(outflow, t.amount);
    }
    return ok({
      total_inflow: formatDecimal(inflow, 2),
      total_outflow: formatDecimal(outflow, 2),
      net_cash_flow: formatDecimal(subDec(inflow, outflow), 2),
    });
  }

  if (sub === "cheques") {
    const list = await db.select().from(cheques).where(eq(cheques.organizationId, orgId));
    return ok({ total_count: list.length, cheques: list });
  }

  throw new ApiError(404, "REPORT_NOT_FOUND", `گزارش ${sub} یافت نشد.`);
}

export async function handleExportRoute(req: NextRequest) {
  await ensureSeeded();
  // Policy Guarantee: Data Export is ALWAYS allowed even on expired subscriptions!
  const ctx = await requireOrgContext(req, "reports.export", {
    requireActiveSubscription: false,
  });
  const orgId = ctx.organizationId;
  const [orgContacts, orgProducts, orgAccounts, orgJournals, orgLedger, orgSales] =
    await Promise.all([
      db.select().from(contacts).where(eq(contacts.organizationId, orgId)),
      db.select().from(products).where(eq(products.organizationId, orgId)),
      db.select().from(accounts).where(eq(accounts.organizationId, orgId)),
      db.select().from(journalEntries).where(eq(journalEntries.organizationId, orgId)),
      db.select().from(stockLedger).where(eq(stockLedger.organizationId, orgId)),
      db.select().from(salesInvoices).where(eq(salesInvoices.organizationId, orgId)),
    ]);

  await recordAuditLog({
    organizationId: orgId,
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    scope: "ORGANIZATION",
    action: "ORG_DATA_EXPORTED",
    entityType: "EXPORT",
    ipAddress: ctx.ipAddress,
    metadata: { subscription_status: ctx.subscriptionStatus },
  });

  return ok({
    exported_at: new Date().toISOString(),
    organization: {
      id: ctx.organization.id,
      name: ctx.organization.name,
      subscription_status: ctx.subscriptionStatus,
    },
    summary: {
      contacts: orgContacts.length,
      products: orgProducts.length,
      accounts: orgAccounts.length,
      journal_entries: orgJournals.length,
      stock_ledger_rows: orgLedger.length,
      sales_invoices: orgSales.length,
    },
    records: {
      contacts: orgContacts,
      products: orgProducts,
      accounts: orgAccounts,
      journal_entries: orgJournals,
      stock_ledger: orgLedger,
      sales_invoices: orgSales,
    },
  });
}

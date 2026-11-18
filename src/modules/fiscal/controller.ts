import { NextRequest } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { accountingPeriods, accounts, fiscalYearClosings, fiscalYears } from "@/db/schema";
import { ensureSeeded } from "@/db/seed";
import { ensurePrompt05OrgDefaults } from "@/db/seed-prompt05";
import { ApiError, ok } from "@/lib/errors";
import { recordAuditLog } from "@/lib/audit";
import { checkIdempotency, saveIdempotency } from "@/lib/idempotency";
import { requireOrgContext } from "@/lib/tenant";
import {
  buildFiscalYearClosingPreview,
  closeAccountControlled,
  compareFiscalYears,
  createFiscalYearWithPeriods,
  executeFiscalYearClosing,
  getAccountClosurePreview,
  listAccountsWithBalances,
  postOpeningBalances,
  prepareAndOpenNextFiscalYear,
  reopenClosedFiscalYear,
  runPreClosingChecklist,
} from "./service";
import { createOrganizationAccount } from "@/modules/accounting/service";

/**
 * Master Prompt 06 §7–§10 — Chart of Accounts, Opening Balances, Account Closure & Fiscal Year Lifecycle
 * Mounted at /api/v1/fiscal/*
 */
export async function handleFiscalRoutes(
  req: NextRequest,
  method: string,
  segments: string[]
) {
  await ensureSeeded();
  const sub = segments[1]; // accounts | opening-balances | years | comparison
  const id = segments[2];
  const action = segments[3];

  // ============================================================================
  // 1. CHART OF ACCOUNTS MANAGEMENT (/api/v1/fiscal/accounts)
  // ============================================================================
  if (sub === "accounts") {
    if (method === "GET" && !id) {
      const ctx = await requireOrgContext(req, "accounting.view");
      await ensurePrompt05OrgDefaults(ctx.organizationId);
      return ok(await listAccountsWithBalances(ctx.organizationId));
    }

    if (method === "POST" && !id) {
      const ctx = await requireOrgContext(req, "accounting.coa.manage", { requireActiveSubscription: true });
      const body = z
        .object({
          group_id: z.string().uuid().optional(),
          parent_id: z.string().uuid().nullable().optional(),
          account_level: z.number().int().min(2).max(4).optional(),
          code: z.string().min(2).max(32),
          name: z.string().min(2).max(160),
          description: z.string().optional(),
          account_type: z.enum(["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"]),
          normal_balance: z.enum(["DEBIT", "CREDIT"]),
          is_postable: z.boolean().default(true),
        })
        .parse(await req.json());
      const created = await createOrganizationAccount({
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorEmail: ctx.email,
        ipAddress: ctx.ipAddress,
        groupId: body.group_id,
        parentId: body.parent_id,
        accountLevel: body.account_level,
        code: body.code,
        name: body.name,
        description: body.description,
        accountType: body.account_type,
        normalBalance: body.normal_balance,
        isPostable: body.is_postable,
      });

      return ok(created, 201);
    }

    if (id && action === "closure-preview" && method === "GET") {
      const ctx = await requireOrgContext(req, "accounting.coa.manage");
      return ok(await getAccountClosurePreview(ctx.organizationId, id));
    }

    if (id && action === "close" && method === "POST") {
      const ctx = await requireOrgContext(req, "accounting.coa.manage", { requireActiveSubscription: true });
      const body = z
        .object({
          action_type: z.enum(["CLOSE_ONLY", "TRANSFER", "SETTLE", "ADJUST"]).default("CLOSE_ONLY"),
          destination_account_id: z.string().uuid().nullable().optional(),
          reason: z.string().min(3, "ذکر دلیل بستن حساب الزامی است."),
        })
        .parse(await req.json());

      const res = await closeAccountControlled({
        organizationId: ctx.organizationId,
        accountId: id,
        actionType: body.action_type,
        destinationAccountId: body.destination_account_id ?? null,
        reason: body.reason,
        actorUserId: ctx.userId,
        actorEmail: ctx.email,
        ipAddress: ctx.ipAddress,
      });
      return ok(res);
    }

    if (id && action === "activate" && method === "POST") {
      const ctx = await requireOrgContext(req, "accounting.coa.manage", { requireActiveSubscription: true });
      const body = z.object({ reason: z.string().min(5, "ذکر دلیل فعال‌سازی حساب الزامی است.") }).parse(await req.json());
      const [current] = await db
        .select()
        .from(accounts)
        .where(and(eq(accounts.id, id), eq(accounts.organizationId, ctx.organizationId)))
        .limit(1);
      if (!current) throw new ApiError(404, "ACCOUNT_NOT_FOUND", "حساب یافت نشد.");
      if (current.isActive && current.accountStatus === "ACTIVE") {
        throw new ApiError(409, "ACCOUNT_ALREADY_ACTIVE", "این حساب از قبل فعال است.");
      }
      if (current.parentId) {
        const [parent] = await db
          .select({ id: accounts.id, isActive: accounts.isActive, accountStatus: accounts.accountStatus })
          .from(accounts)
          .where(and(eq(accounts.id, current.parentId), eq(accounts.organizationId, ctx.organizationId)))
          .limit(1);
        if (!parent || !parent.isActive || parent.accountStatus !== "ACTIVE") {
          throw new ApiError(409, "PARENT_ACCOUNT_INACTIVE", "ابتدا حساب والد را فعال کنید.");
        }
      }
      const [upd] = await db
        .update(accounts)
        .set({
          accountStatus: "ACTIVE",
          isActive: true,
          closedAt: null,
          closedBy: null,
          closureReason: null,
          version: current.version + 1,
          updatedAt: new Date(),
        })
        .where(and(eq(accounts.id, id), eq(accounts.organizationId, ctx.organizationId)))
        .returning();
      await recordAuditLog({
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorEmail: ctx.email,
        scope: "SECURITY",
        action: "ACCOUNT_REACTIVATED",
        entityType: "ACCOUNT",
        entityId: upd.id,
        ipAddress: ctx.ipAddress,
        severity: "WARN",
        metadata: { reason: body.reason, previousStatus: current.accountStatus },
      });
      return ok(upd);
    }
  }

  // ============================================================================
  // 2. OPENING BALANCES (/api/v1/fiscal/opening-balances — Idempotent!)
  // ============================================================================
  if (sub === "opening-balances" && method === "POST") {
    const ctx = await requireOrgContext(req, "accounting.fiscal.open", { requireActiveSubscription: true });
    const body = z
      .object({
        fiscal_year_id: z.string().uuid(),
        effective_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        description: z.string().optional(),
        lines: z
          .array(
            z.object({
              account_id: z.string().uuid(),
              debit: z.string().regex(/^\d+(\.\d{1,2})?$/),
              credit: z.string().regex(/^\d+(\.\d{1,2})?$/),
              contact_id: z.string().uuid().nullable().optional(),
              cost_center_id: z.string().uuid().nullable().optional(),
              description: z.string().optional(),
            })
          )
          .min(2),
      })
      .parse(await req.json());

    const idemKey = req.headers.get("idempotency-key");
    const cached = await checkIdempotency({
      organizationId: ctx.organizationId,
      key: idemKey,
      endpoint: "/api/v1/fiscal/opening-balances",
      payload: body,
    });
    if (cached) return ok(cached.responseBody, cached.statusCode, { replayed: true });

    const res = await postOpeningBalances({
      organizationId: ctx.organizationId,
      fiscalYearId: body.fiscal_year_id,
      effectiveDate: body.effective_date,
      description: body.description,
      lines: body.lines.map((l) => ({
        accountId: l.account_id,
        debit: l.debit,
        credit: l.credit,
        contactId: l.contact_id ?? null,
        costCenterId: l.cost_center_id ?? null,
        description: l.description,
      })),
      actorUserId: ctx.userId,
      actorEmail: ctx.email,
      ipAddress: ctx.ipAddress,
    });

    await saveIdempotency({
      organizationId: ctx.organizationId,
      key: idemKey,
      endpoint: "/api/v1/fiscal/opening-balances",
      payload: body,
      statusCode: 201,
      responseBody: res as unknown as Record<string, unknown>,
    });

    return ok(res, 201);
  }

  // ============================================================================
  // 3. FISCAL YEAR LIFECYCLE (/api/v1/fiscal/years/*)
  // ============================================================================
  if (sub === "years") {
    if (method === "GET" && !id) {
      const ctx = await requireOrgContext(req, "accounting.view");
      await ensurePrompt05OrgDefaults(ctx.organizationId);
      const [fys, periods, closings] = await Promise.all([
        db
          .select()
          .from(fiscalYears)
          .where(eq(fiscalYears.organizationId, ctx.organizationId))
          .orderBy(desc(fiscalYears.startDate)),
        db
          .select()
          .from(accountingPeriods)
          .where(eq(accountingPeriods.organizationId, ctx.organizationId))
          .orderBy(accountingPeriods.periodNumber),
        db
          .select()
          .from(fiscalYearClosings)
          .where(eq(fiscalYearClosings.organizationId, ctx.organizationId))
          .orderBy(desc(fiscalYearClosings.createdAt)),
      ]);
      return ok(
        fys.map((fy) => ({
          ...fy,
          periods: periods.filter((p) => p.fiscalYearId === fy.id),
          latest_closing: closings.find((c) => c.fiscalYearId === fy.id) ?? null,
        }))
      );
    }

    if (method === "POST" && !id) {
      const ctx = await requireOrgContext(req, "accounting.fiscal.open", { requireActiveSubscription: true });
      const body = z
        .object({
          name: z.string().min(2),
          start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          calendar_system: z.enum(["PERSIAN", "GREGORIAN"]).default("PERSIAN"),
          currency: z.string().default("IRR"),
          status: z.enum(["DRAFT", "PREPARING", "OPEN"]).default("OPEN"),
        })
        .parse(await req.json());

      const res = await createFiscalYearWithPeriods({
        organizationId: ctx.organizationId,
        name: body.name,
        startDate: body.start_date,
        endDate: body.end_date,
        calendarSystem: body.calendar_system,
        currency: body.currency,
        status: body.status,
        actorUserId: ctx.userId,
        actorEmail: ctx.email,
        ipAddress: ctx.ipAddress,
      });
      return ok(res, 201);
    }

    if (id && action === "closing-checklist" && method === "GET") {
      const ctx = await requireOrgContext(req, "accounting.view");
      return ok(await runPreClosingChecklist(ctx.organizationId, id));
    }

    if (id && action === "closing-preview" && method === "GET") {
      const ctx = await requireOrgContext(req, "accounting.fiscal.close");
      return ok(await buildFiscalYearClosingPreview(ctx.organizationId, id));
    }

    if (id && action === "close" && method === "POST") {
      const ctx = await requireOrgContext(req, "accounting.fiscal.close", { requireActiveSubscription: true });
      const body = z
        .object({
          acknowledge_warnings: z.boolean().default(true),
        })
        .parse(await req.json().catch(() => ({})));

      const idemKey = req.headers.get("idempotency-key");
      const cached = await checkIdempotency({
        organizationId: ctx.organizationId,
        key: idemKey,
        endpoint: `/api/v1/fiscal/years/${id}/close`,
        payload: { id, ...body },
      });
      if (cached) return ok(cached.responseBody, cached.statusCode, { replayed: true });

      const res = await executeFiscalYearClosing({
        organizationId: ctx.organizationId,
        fiscalYearId: id,
        acknowledgeWarnings: body.acknowledge_warnings,
        actorUserId: ctx.userId,
        actorEmail: ctx.email,
        ipAddress: ctx.ipAddress,
      });

      await saveIdempotency({
        organizationId: ctx.organizationId,
        key: idemKey,
        endpoint: `/api/v1/fiscal/years/${id}/close`,
        payload: { id, ...body },
        statusCode: 200,
        responseBody: res as unknown as Record<string, unknown>,
      });
      return ok(res);
    }

    if (id && action === "prepare-next" && method === "POST") {
      const ctx = await requireOrgContext(req, "accounting.fiscal.open", { requireActiveSubscription: true });
      const body = z
        .object({
          name: z.string().min(2),
          start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        })
        .parse(await req.json());

      const res = await prepareAndOpenNextFiscalYear({
        organizationId: ctx.organizationId,
        previousFiscalYearId: id,
        nextName: body.name,
        nextStartDate: body.start_date,
        nextEndDate: body.end_date,
        actorUserId: ctx.userId,
        actorEmail: ctx.email,
        ipAddress: ctx.ipAddress,
      });
      return ok(res, 201);
    }

    if (id && action === "reopen" && method === "POST") {
      const ctx = await requireOrgContext(req, "accounting.fiscal.reopen", { requireActiveSubscription: true });
      const body = z
        .object({
          reason: z.string().min(5, "ذکر دلیل رسمی بازگشایی سال مالی الزامی است."),
        })
        .parse(await req.json());

      const res = await reopenClosedFiscalYear({
        organizationId: ctx.organizationId,
        fiscalYearId: id,
        reason: body.reason,
        actorUserId: ctx.userId,
        actorEmail: ctx.email,
        ipAddress: ctx.ipAddress,
      });
      return ok(res);
    }
  }

  // GET /api/v1/fiscal/comparison
  if (sub === "comparison" && method === "GET") {
    const ctx = await requireOrgContext(req, "reports.financial.view");
    return ok(await compareFiscalYears(ctx.organizationId));
  }

  throw new ApiError(404, "ROUTE_NOT_FOUND", "مسیر سال مالی و کدینگ یافت نشد.");
}

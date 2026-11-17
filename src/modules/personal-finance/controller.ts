import { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  personalExpenseCategories,
  personalRecurringTransactions,
  personalTransactions,
} from "@/db/schema";
import { ensureSeeded } from "@/db/seed";
import { ApiError, ok } from "@/lib/errors";
import { checkIdempotency, saveIdempotency } from "@/lib/idempotency";
import { requireOrgContext } from "@/lib/tenant";
import {
  buildPersonalFinanceDashboard,
  createOwnerContribution,
  createOwnerWithdrawal,
  createPersonalTransaction,
  executePersonalTransfer,
  getOrCreatePersonalProfile,
} from "./service";

function addRecurrenceInterval(isoDate: string, freq: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (freq === "DAILY") d.setUTCDate(d.getUTCDate() + 1);
  else if (freq === "WEEKLY") d.setUTCDate(d.getUTCDate() + 7);
  else if (freq === "QUARTERLY") d.setUTCMonth(d.getUTCMonth() + 3);
  else if (freq === "ANNUALLY") d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
}

export async function handlePersonalFinanceRoutes(
  req: NextRequest,
  method: string,
  segments: string[]
) {
  await ensureSeeded();
  const sub = segments[1] ?? "dashboard";
  const id = segments[2];
  const action = segments[3];

  // Strict RBAC: Sales / Warehouse employees NEVER have personal_finance.view or manage!
  const neededPerm = method === "GET" ? "personal_finance.view" : "personal_finance.manage";
  const ctx = await requireOrgContext(req, neededPerm, {
    requireActiveSubscription: method !== "GET",
  });

  // GET /api/v1/personal-finance/dashboard
  if (method === "GET" && (sub === "dashboard" || sub === "")) {
    return ok(await buildPersonalFinanceDashboard(ctx.organizationId, ctx.userId));
  }

  // POST /api/v1/personal/transfers & /api/v1/personal-finance/transfers (Master Prompt 07 §7)
  if (method === "POST" && sub === "transfers") {
    const body = z
      .object({
        from_account_id: z.string().uuid(),
        to_account_id: z.string().uuid(),
        amount: z.string().regex(/^\d+(\.\d{1,2})?$/),
        description: z.string().optional(),
      })
      .parse(await req.json());

    const idemKey = req.headers.get("idempotency-key");
    const cached = await checkIdempotency({
      organizationId: ctx.organizationId,
      key: idemKey,
      endpoint: "/api/v1/personal/transfers",
      payload: body,
    });
    if (cached) return ok(cached.responseBody, cached.statusCode, { replayed: true });

    const res = await executePersonalTransfer({
      organizationId: ctx.organizationId,
      ownerUserId: ctx.userId,
      actorEmail: ctx.email,
      ipAddress: ctx.ipAddress,
      deviceId: req.headers.get("x-device-id"),
      fromAccountId: body.from_account_id,
      toAccountId: body.to_account_id,
      amount: body.amount,
      description: body.description,
      idempotencyKey: idemKey,
    });

    await saveIdempotency({
      organizationId: ctx.organizationId,
      key: idemKey,
      endpoint: "/api/v1/personal/transfers",
      payload: body,
      statusCode: 201,
      responseBody: res as unknown as Record<string, unknown>,
    });

    return ok(res, 201);
  }

  // POST /api/v1/personal-finance/profile
  if (method === "POST" && sub === "profile") {
    return ok(await getOrCreatePersonalProfile(ctx.organizationId, ctx.userId), 201);
  }

  // /api/v1/personal-finance/categories
  if (sub === "categories") {
    if (method === "GET") {
      await getOrCreatePersonalProfile(ctx.organizationId, ctx.userId);
      const cats = await db
        .select()
        .from(personalExpenseCategories)
        .where(eq(personalExpenseCategories.organizationId, ctx.organizationId));
      return ok(cats);
    }
    if (method === "POST") {
      const body = z
        .object({
          code: z.string().min(2),
          name_fa: z.string().min(2),
          icon: z.string().default("wallet"),
          color: z.string().default("#4f46e5"),
          monthly_budget_limit: z.string().regex(/^\d+(\.\d{1,2})?$/).default("0.00"),
          parent_id: z.string().uuid().nullable().optional(),
        })
        .parse(await req.json());
      const [created] = await db
        .insert(personalExpenseCategories)
        .values({
          organizationId: ctx.organizationId,
          code: body.code.toUpperCase(),
          nameFa: body.name_fa,
          icon: body.icon,
          color: body.color,
          monthlyBudgetLimit: body.monthly_budget_limit,
          parentId: body.parent_id ?? null,
        })
        .returning();
      return ok(created, 201);
    }
  }

  // POST /api/v1/personal-finance/withdrawals
  if (sub === "withdrawals" && method === "POST") {
    const body = z
      .object({
        business_financial_account_id: z.string().uuid(),
        personal_account_id: z.string().uuid().nullable().optional(),
        amount: z.string().regex(/^\d+(\.\d{1,2})?$/),
        withdrawal_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        notes: z.string().optional(),
        create_personal_tx: z.boolean().default(true),
      })
      .parse(await req.json());

    const idemKey = req.headers.get("idempotency-key");
    const cached = await checkIdempotency({
      organizationId: ctx.organizationId,
      key: idemKey,
      endpoint: "/api/v1/personal-finance/withdrawals",
      payload: body,
    });
    if (cached) return ok(cached.responseBody, cached.statusCode, { replayed: true });

    const res = await createOwnerWithdrawal({
      organizationId: ctx.organizationId,
      ownerUserId: ctx.userId,
      actorEmail: ctx.email,
      ipAddress: ctx.ipAddress,
      businessFinancialAccountId: body.business_financial_account_id,
      personalAccountId: body.personal_account_id,
      amount: body.amount,
      withdrawalDate: body.withdrawal_date || new Date().toISOString().slice(0, 10),
      notes: body.notes,
      createPersonalTx: body.create_personal_tx,
      idempotencyKey: idemKey,
    });

    await saveIdempotency({
      organizationId: ctx.organizationId,
      key: idemKey,
      endpoint: "/api/v1/personal-finance/withdrawals",
      payload: body,
      statusCode: 201,
      responseBody: res as unknown as Record<string, unknown>,
    });

    return ok(res, 201);
  }

  // POST /api/v1/personal-finance/contributions
  if (sub === "contributions" && method === "POST") {
    const body = z
      .object({
        business_financial_account_id: z.string().uuid(),
        amount: z.string().regex(/^\d+(\.\d{1,2})?$/),
        contribution_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        notes: z.string().optional(),
      })
      .parse(await req.json());
    const res = await createOwnerContribution({
      organizationId: ctx.organizationId,
      ownerUserId: ctx.userId,
      actorEmail: ctx.email,
      ipAddress: ctx.ipAddress,
      businessFinancialAccountId: body.business_financial_account_id,
      amount: body.amount,
      contributionDate: body.contribution_date || new Date().toISOString().slice(0, 10),
      notes: body.notes,
    });
    return ok(res, 201);
  }

  // /api/v1/personal-finance/transactions
  if (sub === "transactions") {
    if (method === "GET") {
      const dash = await buildPersonalFinanceDashboard(ctx.organizationId, ctx.userId);
      return ok(dash.transactions);
    }
    if (method === "POST" && !id) {
      const body = z
        .object({
          tx_type: z
            .enum([
              "PERSONAL_EXPENSE",
              "PERSONAL_INCOME",
              "WITHDRAWAL_FROM_BUSINESS",
              "OWNER_CONTRIBUTION",
              "PERSONAL_TRANSFER",
              "LOAN_PAYMENT",
              "LOAN_RECEIPT",
              "SAVINGS",
              "DEBT_SETTLEMENT",
              "RECURRING_PAYMENT",
              "REFUND",
            ])
            .default("PERSONAL_EXPENSE"),
          payment_source: z
            .enum(["PERSONAL_CASH", "PERSONAL_BANK", "BUSINESS_CASH", "BUSINESS_BANK", "CREDIT", "OTHER"])
            .default("PERSONAL_CASH"),
          title: z.string().min(2),
          amount: z.string().regex(/^\d+(\.\d{1,2})?$/),
          tx_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          category_id: z.string().uuid().nullable().optional(),
          personal_account_id: z.string().uuid().nullable().optional(),
          linked_withdrawal_id: z.string().uuid().nullable().optional(),
          business_financial_account_id: z.string().uuid().nullable().optional(),
          notes: z.string().optional(),
        })
        .parse(await req.json());

      const idemKey = req.headers.get("idempotency-key");
      const cached = await checkIdempotency({
        organizationId: ctx.organizationId,
        key: idemKey,
        endpoint: "/api/v1/personal-finance/transactions",
        payload: body,
      });
      if (cached) return ok(cached.responseBody, cached.statusCode, { replayed: true });

      const saved = await createPersonalTransaction({
        organizationId: ctx.organizationId,
        ownerUserId: ctx.userId,
        actorEmail: ctx.email,
        ipAddress: ctx.ipAddress,
        txType: body.tx_type,
        paymentSource: body.payment_source,
        title: body.title,
        amount: body.amount,
        txDate: body.tx_date || new Date().toISOString().slice(0, 10),
        categoryId: body.category_id,
        personalAccountId: body.personal_account_id,
        linkedWithdrawalId: body.linked_withdrawal_id,
        businessFinancialAccountId: body.business_financial_account_id,
        notes: body.notes,
        idempotencyKey: idemKey,
      });

      await saveIdempotency({
        organizationId: ctx.organizationId,
        key: idemKey,
        endpoint: "/api/v1/personal-finance/transactions",
        payload: body,
        statusCode: 201,
        responseBody: saved as unknown as Record<string, unknown>,
      });
      return ok(saved, 201);
    }

    if (method === "POST" && id && action === "reverse") {
      const [orig] = await db
        .select()
        .from(personalTransactions)
        .where(
          and(
            eq(personalTransactions.id, id),
            eq(personalTransactions.organizationId, ctx.organizationId),
            eq(personalTransactions.ownerUserId, ctx.userId)
          )
        )
        .limit(1);
      if (!orig) throw new ApiError(404, "PERSONAL_TX_NOT_FOUND", "تراکنش شخصی یافت نشد.");
      const [upd] = await db
        .update(personalTransactions)
        .set({ status: "REVERSED" })
        .where(eq(personalTransactions.id, orig.id))
        .returning();
      return ok(upd);
    }
  }

  // /api/v1/personal-finance/recurring (Scenario F!)
  if (sub === "recurring") {
    if (method === "GET") {
      const dash = await buildPersonalFinanceDashboard(ctx.organizationId, ctx.userId);
      return ok(dash.recurring_obligations);
    }
    if (method === "POST" && !id) {
      const body = z
        .object({
          title: z.string().min(2),
          category_id: z.string().uuid().nullable().optional(),
          amount: z.string().regex(/^\d+(\.\d{1,2})?$/),
          frequency: z.enum(["DAILY", "WEEKLY", "MONTHLY", "QUARTERLY", "ANNUALLY", "CUSTOM"]).default("MONTHLY"),
          start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
          next_due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          payment_source: z
            .enum(["PERSONAL_CASH", "PERSONAL_BANK", "BUSINESS_CASH", "BUSINESS_BANK", "CREDIT", "OTHER"])
            .default("BUSINESS_BANK"),
          reminder_days_before: z.number().int().min(0).max(30).default(3),
          auto_generate: z.boolean().default(false),
        })
        .parse(await req.json());

      // §3.7: Creating recurring obligation NEVER automatically posts payment or accounting entry!
      const [rec] = await db
        .insert(personalRecurringTransactions)
        .values({
          organizationId: ctx.organizationId,
          ownerUserId: ctx.userId,
          categoryId: body.category_id ?? null,
          title: body.title,
          amount: body.amount,
          frequency: body.frequency,
          startDate: body.start_date,
          endDate: body.end_date ?? null,
          nextDueDate: body.next_due_date || body.start_date,
          paymentSource: body.payment_source,
          reminderDaysBefore: body.reminder_days_before,
          autoGenerate: body.auto_generate,
          obligationStatus: "DUE",
          isActive: true,
        })
        .returning();

      return ok(rec, 201);
    }

    // POST /api/v1/personal-finance/recurring/{id}/pay (Idempotent payment!)
    if (method === "POST" && id && action === "pay") {
      const body = z
        .object({
          payment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          business_financial_account_id: z.string().uuid().nullable().optional(),
          personal_account_id: z.string().uuid().nullable().optional(),
        })
        .parse(await req.json().catch(() => ({})));

      const idemKey = req.headers.get("idempotency-key");
      const cached = await checkIdempotency({
        organizationId: ctx.organizationId,
        key: idemKey,
        endpoint: `/api/v1/personal-finance/recurring/${id}/pay`,
        payload: { id, ...body },
      });
      if (cached) return ok(cached.responseBody, cached.statusCode, { replayed: true });

      const [rec] = await db
        .select()
        .from(personalRecurringTransactions)
        .where(
          and(
            eq(personalRecurringTransactions.id, id),
            eq(personalRecurringTransactions.organizationId, ctx.organizationId),
            eq(personalRecurringTransactions.ownerUserId, ctx.userId)
          )
        )
        .limit(1);
      if (!rec) throw new ApiError(404, "RECURRING_OBLIGATION_NOT_FOUND", "تعهد تکرارشونده یافت نشد.");

      const payDate = body.payment_date || new Date().toISOString().slice(0, 10);
      const tx = await createPersonalTransaction({
        organizationId: ctx.organizationId,
        ownerUserId: ctx.userId,
        actorEmail: ctx.email,
        ipAddress: ctx.ipAddress,
        txType: "RECURRING_PAYMENT",
        paymentSource: rec.paymentSource,
        title: `پرداخت تعهد تکرارشونده: ${rec.title}`,
        amount: rec.amount,
        txDate: payDate,
        categoryId: rec.categoryId,
        personalAccountId: body.personal_account_id,
        businessFinancialAccountId: body.business_financial_account_id,
        idempotencyKey: idemKey,
      });

      const nextDue = addRecurrenceInterval(rec.nextDueDate, rec.frequency);
      const [updatedRec] = await db
        .update(personalRecurringTransactions)
        .set({
          obligationStatus: "PAID",
          lastPaidAt: new Date(),
          lastTransactionId: tx.id,
          nextDueDate: nextDue,
        })
        .where(eq(personalRecurringTransactions.id, rec.id))
        .returning();

      const resp = { recurring: updatedRec, transaction: tx };
      await saveIdempotency({
        organizationId: ctx.organizationId,
        key: idemKey,
        endpoint: `/api/v1/personal-finance/recurring/${id}/pay`,
        payload: { id, ...body },
        statusCode: 200,
        responseBody: resp as unknown as Record<string, unknown>,
      });

      return ok(resp);
    }
  }

  throw new ApiError(404, "ROUTE_NOT_FOUND", "مسیر مالی شخصی یافت نشد.");
}

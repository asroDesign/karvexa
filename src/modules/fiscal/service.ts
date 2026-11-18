import { and, desc, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  accountClosures,
  accountGroups,
  accountingPeriods,
  accounts,
  fiscalYearClosings,
  fiscalYears,
  journalEntries,
  journalEntryLines,
  openingBalances,
  purchaseInvoices,
  salesInvoices,
} from "@/db/schema";
import { ensurePrompt05OrgDefaults } from "@/db/seed-prompt05";
import { recordAuditLog } from "@/lib/audit";
import {
  addDec,
  eqDec,
  formatDecimal,
  isNegativeDec,
  isPositiveDec,
  isZeroDec,
  parseDecimal,
  subDec,
} from "@/lib/decimal";
import { ApiError } from "@/lib/errors";
import { withTenantTransaction } from "@/lib/tenant";
import {
  assertAccountingDateWritableTx,
  buildAccountingReports,
  createJournalEntryTx,
  JournalLineInput,
  reverseJournalEntryTx,
} from "@/modules/accounting/service";
import { getLiveStockBalances } from "@/modules/inventory/service";

export async function getAccountLiveBalance(
  organizationId: string,
  accountId: string,
  fiscalYearId?: string | null
) {
  const [acc] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.organizationId, organizationId)))
    .limit(1);
  if (!acc) throw new ApiError(404, "ACCOUNT_NOT_FOUND", "حساب یافت نشد.");

  const conds = [
    eq(journalEntries.organizationId, organizationId),
    eq(journalEntryLines.accountId, accountId),
    inArray(journalEntries.status, ["POSTED", "REVERSED"]),
  ];
  if (fiscalYearId) conds.push(eq(journalEntries.fiscalYearId, fiscalYearId));

  const lines = await db
    .select({
      debit: journalEntryLines.debit,
      credit: journalEntryLines.credit,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(and(...conds));

  let deb = BigInt(0);
  let cred = BigInt(0);
  for (const l of lines) {
    deb = addDec(deb, l.debit);
    cred = addDec(cred, l.credit);
  }
  const net = acc.normalBalance === "DEBIT" ? subDec(deb, cred) : subDec(cred, deb);

  const draftCountRows = await db
    .select({ id: journalEntryLines.id })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(
      and(
        eq(journalEntries.organizationId, organizationId),
        eq(journalEntryLines.accountId, accountId),
        eq(journalEntries.status, "DRAFT")
      )
    );

  return {
    account: acc,
    totalDebit: deb,
    totalCredit: cred,
    netBalance: net,
    postedLinesCount: lines.length,
    draftLinesCount: draftCountRows.length,
  };
}

/**
 * Master Prompt 06 §7.3 & Test E — Post Opening Balances via Official Opening Journal
 */
export async function postOpeningBalances(params: {
  organizationId: string;
  fiscalYearId: string;
  effectiveDate: string;
  description?: string;
  lines: Array<{
    accountId: string;
    debit: string;
    credit: string;
    contactId?: string | null;
    costCenterId?: string | null;
    description?: string;
  }>;
  actorUserId: string;
  actorEmail: string;
  ipAddress?: string | null;
}) {
  const result = await withTenantTransaction(params.organizationId, async (tx) => {
    const [fy] = await tx
      .select()
      .from(fiscalYears)
      .where(
        and(
          eq(fiscalYears.id, params.fiscalYearId),
          eq(fiscalYears.organizationId, params.organizationId)
        )
      )
      .limit(1);
    if (!fy) throw new ApiError(404, "FISCAL_YEAR_NOT_FOUND", "سال مالی یافت نشد.");
    if (fy.status === "CLOSED") {
      throw new ApiError(409, "FISCAL_YEAR_CLOSED", "امکان ثبت سند افتتاحیه در سال مالی بسته وجود ندارد.");
    }

    const jRes = await createJournalEntryTx(tx, {
      organizationId: params.organizationId,
      actorUserId: params.actorUserId,
      actorEmail: params.actorEmail,
      fiscalYearId: fy.id,
      entryDate: params.effectiveDate,
      description: params.description || `سند افتتاحیه مانده حساب‌های ${fy.name}`,
      referenceType: "OPENING",
      postImmediately: true,
      lines: params.lines,
    });

    // Save/upsert opening_balances per account for reconciliation reporting
    for (const l of params.lines) {
      await tx
        .insert(openingBalances)
        .values({
          organizationId: params.organizationId,
          fiscalYearId: fy.id,
          accountId: l.accountId,
          debit: formatDecimal(parseDecimal(l.debit || "0"), 2),
          credit: formatDecimal(parseDecimal(l.credit || "0"), 2),
        })
        .onConflictDoUpdate({
          target: [openingBalances.fiscalYearId, openingBalances.accountId],
          set: {
            debit: formatDecimal(parseDecimal(l.debit || "0"), 2),
            credit: formatDecimal(parseDecimal(l.credit || "0"), 2),
          },
        });
    }

    const [updatedFy] = await tx
      .update(fiscalYears)
      .set({
        openingJournalId: fy.openingJournalId ?? jRes.entry.id,
        status: fy.status === "DRAFT" || fy.status === "PREPARING" ? "OPEN" : fy.status,
      })
      .where(eq(fiscalYears.id, fy.id))
      .returning();

    return { fiscalYear: updatedFy, openingJournal: jRes.entry, lines: jRes.lines };
  });

  await recordAuditLog({
    organizationId: params.organizationId,
    actorUserId: params.actorUserId,
    actorEmail: params.actorEmail,
    scope: "ORGANIZATION",
    action: "OPENING_BALANCES_POSTED",
    entityType: "FISCAL_YEAR",
    entityId: params.fiscalYearId,
    ipAddress: params.ipAddress,
    metadata: {
      openingJournalId: result.openingJournal.id,
      totalDebit: result.openingJournal.totalDebit,
    },
  });

  return result;
}

/**
 * Master Prompt 06 §7.6 & Test F — Account Closure Preview & Controlled Closure
 */
export async function getAccountClosurePreview(organizationId: string, accountId: string) {
  const [bal, activeChildren] = await Promise.all([
    getAccountLiveBalance(organizationId, accountId),
    db
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(
          eq(accounts.organizationId, organizationId),
          eq(accounts.parentId, accountId),
          eq(accounts.isActive, true)
        )
      ),
  ]);
  const nonZero = !isZeroDec(bal.netBalance);
  const hasDrafts = bal.draftLinesCount > 0;
  const isSystem = Boolean(bal.account.systemRole);

  const blockers: string[] = [];
  if (hasDrafts) {
    blockers.push(`این حساب دارای ${bal.draftLinesCount} آرتیکل پیش‌نویس قطعی‌نشده است.`);
  }
  if (isSystem) {
    blockers.push(`حساب سیستمی (${bal.account.systemRole}) برای عملیات خودکار سیستم نیاز است و قابل بستن مستقیم نیست.`);
  }
  if (activeChildren.length > 0) {
    blockers.push(`${activeChildren.length} زیرحساب فعال به این حساب متصل است؛ ابتدا زیرحساب‌ها را تعیین تکلیف کنید.`);
  }

  return {
    account: bal.account,
    total_debit: formatDecimal(bal.totalDebit, 2),
    total_credit: formatDecimal(bal.totalCredit, 2),
    net_balance: formatDecimal(bal.netBalance, 2),
    has_non_zero_balance: nonZero,
    posted_lines_count: bal.postedLinesCount,
    draft_lines_count: bal.draftLinesCount,
    active_children_count: activeChildren.length,
    can_close_directly: !nonZero && !hasDrafts && !isSystem && activeChildren.length === 0,
    requires_balance_resolution: nonZero,
    recommended_actions: nonZero
      ? ["TRANSFER", "SETTLE", "ADJUST"]
      : ["CLOSE_ONLY"],
    blockers,
  };
}

export async function closeAccountControlled(params: {
  organizationId: string;
  accountId: string;
  actionType: "CLOSE_ONLY" | "TRANSFER" | "SETTLE" | "ADJUST";
  destinationAccountId?: string | null;
  reason: string;
  actorUserId: string;
  actorEmail: string;
  ipAddress?: string | null;
}) {
  const closingDate = new Date().toISOString().slice(0, 10);
  const result = await withTenantTransaction(params.organizationId, async (tx) => {
    const dateContext = await assertAccountingDateWritableTx(tx, params.organizationId, closingDate);
    await tx.execute(sql`
      SELECT id FROM accounts
      WHERE id = ${params.accountId}
        AND organization_id = ${params.organizationId}
      FOR UPDATE
    `);
    const preview = await getAccountClosurePreview(params.organizationId, params.accountId);
    if (preview.account.accountStatus === "CLOSED" || !preview.account.isActive) {
      throw new ApiError(409, "ACCOUNT_ALREADY_CLOSED", "این حساب قبلاً بسته شده است.");
    }
    if (preview.draft_lines_count > 0) {
      throw new ApiError(409, "ACCOUNT_HAS_DRAFT_POSTINGS", "ابتدا اسناد پیش‌نویس مرتبط با این حساب را قطعی یا حذف کنید.");
    }
    if (preview.account.systemRole) {
      throw new ApiError(409, "SYSTEM_ACCOUNT_PROTECTED", "حساب‌های سیستمی بدون مجوز ویژه قابل بستن مستقیم نیستند.");
    }
    if (preview.active_children_count > 0) {
      throw new ApiError(409, "ACCOUNT_HAS_ACTIVE_CHILDREN", "ابتدا زیرحساب‌های فعال را تعیین تکلیف کنید.");
    }
    const netDec = parseDecimal(preview.net_balance);
    const hasBalance = !isZeroDec(netDec);
    if (hasBalance && params.actionType === "CLOSE_ONLY") {
      throw new ApiError(
        409,
        "ACCOUNT_BALANCE_NON_ZERO",
        `امکان بستن حساب «${preview.account.name}» با مانده غیرصفر (${preview.net_balance}) بدون تسویه یا انتقال مانده وجود ندارد.`
      );
    }
    if (hasBalance && !params.destinationAccountId) {
      throw new ApiError(422, "DESTINATION_ACCOUNT_REQUIRED", "برای انتقال مانده، انتخاب حساب مقصد الزامی است.");
    }

    let transferJournal = null;

    if (hasBalance && params.destinationAccountId) {
      if (params.destinationAccountId === params.accountId) {
        throw new ApiError(422, "SAME_ACCOUNT_TRANSFER", "حساب مقصد نمی‌تواند همان حساب در حال بستن باشد.");
      }

      const absBal = isNegativeDec(netDec) ? -netDec : netDec;
      const absStr = formatDecimal(absBal, 2);
      // Determine side that zeroes out the closing account:
      // If account has normal DEBIT and positive balance (net > 0), we CREDIT it to zero it out!
      const isDebitBalance =
        (preview.account.normalBalance === "DEBIT" && isPositiveDec(netDec)) ||
        (preview.account.normalBalance === "CREDIT" && isNegativeDec(netDec));

      const lines: JournalLineInput[] = isDebitBalance
        ? [
            {
              accountId: params.destinationAccountId,
              debit: absStr,
              credit: "0.00",
              description: `انتقال مانده بابت بستن حساب ${preview.account.code} — ${preview.account.name}`,
            },
            {
              accountId: params.accountId,
              debit: "0.00",
              credit: absStr,
              description: `صفر کردن مانده جهت بستن حساب ${preview.account.code}`,
            },
          ]
        : [
            {
              accountId: params.accountId,
              debit: absStr,
              credit: "0.00",
              description: `صفر کردن مانده جهت بستن حساب ${preview.account.code}`,
            },
            {
              accountId: params.destinationAccountId,
              debit: "0.00",
              credit: absStr,
              description: `انتقال مانده بابت بستن حساب ${preview.account.code} — ${preview.account.name}`,
            },
          ];

      const jr = await createJournalEntryTx(tx, {
        organizationId: params.organizationId,
        actorUserId: params.actorUserId,
        actorEmail: params.actorEmail,
        fiscalYearId: dateContext.fiscalYear.id,
        accountingPeriodId: dateContext.period.id,
        entryDate: closingDate,
        description: `سند انتقال مانده و بستن حساب ${preview.account.code} (${preview.account.name}) — ${params.reason}`,
        referenceType: "ACCOUNT_CLOSURE",
        referenceId: params.accountId,
        postImmediately: true,
        lines,
      });
      transferJournal = jr.entry;
    }

    const now = new Date();
    const [closedAcc] = await tx
      .update(accounts)
      .set({
        accountStatus: "CLOSED",
        isActive: false,
        closedAt: now,
        closedBy: params.actorUserId,
        closureReason: params.reason,
        version: preview.account.version + 1,
        updatedAt: now,
      })
      .where(and(eq(accounts.id, params.accountId), eq(accounts.organizationId, params.organizationId)))
      .returning();

    const [closureRecord] = await tx
      .insert(accountClosures)
      .values({
        organizationId: params.organizationId,
        accountId: params.accountId,
        actionType: params.actionType,
        destinationAccountId: params.destinationAccountId ?? null,
        closingBalance: preview.net_balance,
        transferJournalId: transferJournal?.id ?? null,
        reason: params.reason,
        closedBy: params.actorUserId,
        closedAt: now,
      })
      .returning();

    return { account: closedAcc, closure: closureRecord, transferJournal, closingBalance: preview.net_balance };
  });

  await recordAuditLog({
    organizationId: params.organizationId,
    actorUserId: params.actorUserId,
    actorEmail: params.actorEmail,
    scope: "ORGANIZATION",
    action: "ACCOUNT_CLOSED",
    entityType: "ACCOUNT",
    entityId: params.accountId,
    ipAddress: params.ipAddress,
    metadata: {
      actionType: params.actionType,
      closingBalance: result.closingBalance,
      transferJournalId: result.transferJournal?.id ?? null,
      reason: params.reason,
    },
  });

  return result;
}

// ============================================================================
// FISCAL YEAR LIFECYCLE (§8 & §9 — Tests G, H, I, J)
// ============================================================================

type CreateFiscalYearParams = {
  organizationId: string;
  name: string;
  startDate: string;
  endDate: string;
  calendarSystem?: "PERSIAN" | "GREGORIAN";
  currency?: string;
  previousFiscalYearId?: string | null;
  status?: "DRAFT" | "PREPARING" | "OPEN";
  actorUserId: string;
  actorEmail: string;
  ipAddress?: string | null;
};

async function createFiscalYearWithPeriodsTx(
  tx: Parameters<Parameters<typeof withTenantTransaction>[1]>[0],
  params: CreateFiscalYearParams
) {
  const [fy] = await tx
    .insert(fiscalYears)
    .values({
      organizationId: params.organizationId,
      name: params.name.trim(),
      startDate: params.startDate,
      endDate: params.endDate,
      calendarSystem: params.calendarSystem ?? "PERSIAN",
      currency: params.currency ?? "IRR",
      status: params.status ?? "OPEN",
      isDefault: false,
      previousFiscalYearId: params.previousFiscalYearId ?? null,
    })
    .returning();

  const startMs = Date.parse(`${params.startDate}T00:00:00Z`);
  const endMs = Date.parse(`${params.endDate}T00:00:00Z`);
  const qSpan = Math.floor((endMs - startMs) / 4);
  const periodNames = ["فصل اول (بهار)", "فصل دوم (تابستان)", "فصل سوم (پاییز)", "فصل چهارم (زمستان)"];
  const periodRows = periodNames.map((pName, idx) => {
    const pStart = new Date(startMs + idx * qSpan + (idx === 0 ? 0 : 86400_000));
    const pEnd = idx === 3 ? new Date(endMs) : new Date(startMs + (idx + 1) * qSpan);
    return {
      organizationId: params.organizationId,
      fiscalYearId: fy.id,
      name: `${pName} — ${fy.name}`,
      periodNumber: idx + 1,
      startDate: pStart.toISOString().slice(0, 10),
      endDate: pEnd.toISOString().slice(0, 10),
      status: "OPEN",
    };
  });
  const createdPeriods = await tx.insert(accountingPeriods).values(periodRows).returning();

  if (params.previousFiscalYearId) {
    const [previous] = await tx
      .update(fiscalYears)
      .set({ nextFiscalYearId: fy.id })
      .where(and(
        eq(fiscalYears.id, params.previousFiscalYearId),
        eq(fiscalYears.organizationId, params.organizationId),
        sql`next_fiscal_year_id IS NULL`
      ))
      .returning({ id: fiscalYears.id });
    if (!previous) throw new ApiError(409, "NEXT_FISCAL_YEAR_ALREADY_EXISTS", "سال مالی بعدی قبلاً از این سال مالی ایجاد شده است.");
  }

  return { fiscalYear: fy, periods: createdPeriods };
}

export async function createFiscalYearWithPeriods(params: CreateFiscalYearParams) {
  if (params.startDate >= params.endDate) {
    throw new ApiError(422, "FISCAL_DATE_RANGE_INVALID", "تاریخ شروع سال مالی باید قبل از تاریخ پایان باشد.");
  }

  const created = await withTenantTransaction(params.organizationId, (tx) => createFiscalYearWithPeriodsTx(tx, params));

  await recordAuditLog({
    organizationId: params.organizationId,
    actorUserId: params.actorUserId,
    actorEmail: params.actorEmail,
    scope: "ORGANIZATION",
    action: "FISCAL_YEAR_CREATED",
    entityType: "FISCAL_YEAR",
    entityId: created.fiscalYear.id,
    ipAddress: params.ipAddress,
    metadata: { name: created.fiscalYear.name, startDate: params.startDate, endDate: params.endDate },
  });

  return created;
}

/**
 * Master Prompt 06 §9.2 — Pre-Closing Checklist Engine
 */
export async function runPreClosingChecklist(organizationId: string, fiscalYearId: string) {
  await ensurePrompt05OrgDefaults(organizationId);

  const [fy] = await db
    .select()
    .from(fiscalYears)
    .where(and(eq(fiscalYears.id, fiscalYearId), eq(fiscalYears.organizationId, organizationId)))
    .limit(1);
  if (!fy) throw new ApiError(404, "FISCAL_YEAR_NOT_FOUND", "سال مالی یافت نشد.");

  const [reports, draftJournals, draftSales, draftPurchases, retEarningsAcc, stock] =
    await Promise.all([
      buildAccountingReports(organizationId, fy.id),
      db
        .select()
        .from(journalEntries)
        .where(
          and(
            eq(journalEntries.organizationId, organizationId),
            eq(journalEntries.fiscalYearId, fy.id),
            eq(journalEntries.status, "DRAFT")
          )
        ),
      db
        .select()
        .from(salesInvoices)
        .where(
          and(
            eq(salesInvoices.organizationId, organizationId),
            eq(salesInvoices.status, "DRAFT"),
            gte(salesInvoices.invoiceDate, fy.startDate),
            lte(salesInvoices.invoiceDate, fy.endDate)
          )
        ),
      db
        .select()
        .from(purchaseInvoices)
        .where(
          and(
            eq(purchaseInvoices.organizationId, organizationId),
            eq(purchaseInvoices.status, "DRAFT"),
            gte(purchaseInvoices.invoiceDate, fy.startDate),
            lte(purchaseInvoices.invoiceDate, fy.endDate)
          )
        ),
      db
        .select()
        .from(accounts)
        .where(and(eq(accounts.organizationId, organizationId), eq(accounts.systemRole, "RETAINED_EARNINGS")))
        .limit(1),
      getLiveStockBalances(organizationId, fy.endDate),
    ]);

  const items: Array<{
    code: string;
    title: string;
    status: "PASSED" | "WARNING" | "FAILED" | "NOT_APPLICABLE";
    critical: boolean;
    details: string;
  }> = [
    {
      code: "TRIAL_BALANCE_EQUALITY",
      title: "تراز آزمایشی (برابری جمع بدهکار و بستانکار)",
      status: reports.isTrialBalanced ? "PASSED" : "FAILED",
      critical: true,
      details: `جمع بدهکار: ${reports.grandTotalDebit} | جمع بستانکار: ${reports.grandTotalCredit}`,
    },
    {
      code: "RETAINED_EARNINGS_CONFIGURED",
      title: "پیکربندی حساب سود و زیان انباشته (خلاصه سود و زیان)",
      status: retEarningsAcc.length > 0 ? "PASSED" : "FAILED",
      critical: true,
      details:
        retEarningsAcc.length > 0
          ? `حساب مقصد: ${retEarningsAcc[0].code} — ${retEarningsAcc[0].name}`
          : "حساب سیستمی RETAINED_EARNINGS یافت نشد.",
    },
    {
      code: "UNPOSTED_DRAFT_JOURNALS",
      title: "اسناد حسابداری پیش‌نویس قطعی‌نشده در این سال مالی",
      status: draftJournals.length === 0 ? "PASSED" : "WARNING",
      critical: false,
      details:
        draftJournals.length === 0
          ? "تمام اسناد این سال مالی قطعی شده‌اند."
          : `${draftJournals.length} سند پیش‌نویس وجود دارد که در بستن سال لحاظ نمی‌شوند.`,
    },
    {
      code: "UNFINALIZED_INVOICES",
      title: "فاکتورهای فروش و خرید پیش‌نویس",
      status: draftSales.length + draftPurchases.length === 0 ? "PASSED" : "WARNING",
      critical: false,
      details: `فروش پیش‌نویس: ${draftSales.length} | خرید پیش‌نویس: ${draftPurchases.length}`,
    },
    {
      code: "INVENTORY_VALUATION",
      title: "ارزیابی موجودی انبار (Stock Ledger)",
      status:
        stock.balances.some((balance) => isNegativeDec(parseDecimal(balance.onHandQty)) || isNegativeDec(parseDecimal(balance.totalValue)))
          ? "FAILED"
          : stock.balances.some(
                (balance) =>
                  isPositiveDec(parseDecimal(balance.onHandQty)) &&
                  isZeroDec(parseDecimal(balance.totalValue))
              )
            ? "WARNING"
            : "PASSED",
      critical: stock.balances.some(
        (balance) =>
          isNegativeDec(parseDecimal(balance.onHandQty)) ||
          isNegativeDec(parseDecimal(balance.totalValue))
      ),
      details: `ارزش کل موجودی: ${stock.totalValuation} | موجودی منفی: ${stock.balances.filter((balance) => isNegativeDec(parseDecimal(balance.onHandQty))).length} | موجودی بدون ارزش‌گذاری: ${stock.balances.filter((balance) => isPositiveDec(parseDecimal(balance.onHandQty)) && isZeroDec(parseDecimal(balance.totalValue))).length}`,
    },
    {
      code: "FIXED_ASSETS_DEPRECIATION",
      title: "استهلاک دارایی‌های ثابت",
      status: "NOT_APPLICABLE",
      critical: false,
      details: "ماژول دارایی ثابت در این دوره فعال نیست.",
    },
  ];

  const criticalFailures = items.filter((i) => i.critical && i.status === "FAILED").length;
  const warningsCount = items.filter((i) => i.status === "WARNING").length;

  return {
    fiscal_year: fy,
    can_close: criticalFailures === 0 && fy.status !== "CLOSED",
    critical_failures: criticalFailures,
    warnings_count: warningsCount,
    items,
  };
}

/**
 * Master Prompt 06 §9.3 & §9.4 — Closing Preview & Closing Journal Line Generator
 */
export async function buildFiscalYearClosingPreview(organizationId: string, fiscalYearId: string) {
  await ensurePrompt05OrgDefaults(organizationId);
  const [fy] = await db
    .select()
    .from(fiscalYears)
    .where(and(eq(fiscalYears.id, fiscalYearId), eq(fiscalYears.organizationId, organizationId)))
    .limit(1);
  if (!fy) throw new ApiError(404, "FISCAL_YEAR_NOT_FOUND", "سال مالی یافت نشد.");

  const [retAcc] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.organizationId, organizationId), eq(accounts.systemRole, "RETAINED_EARNINGS")))
    .limit(1);
  if (!retAcc) {
    throw new ApiError(422, "RETAINED_EARNINGS_MISSING", "حساب سود و زیان انباشته تعریف نشده است.");
  }

  const reports = await buildAccountingReports(organizationId, fy.id);
  const nominalAccounts = reports.trialBalance.filter(
    (a) => a.accountType === "REVENUE" || a.accountType === "EXPENSE"
  );

  const closingLines: Array<JournalLineInput & { account_code: string; account_name: string; account_type: string }> = [];
  let totalRevenue = BigInt(0);
  let totalExpense = BigInt(0);
  let totalDebit = BigInt(0);
  let totalCredit = BigInt(0);

  for (const acc of nominalAccounts) {
    const net = parseDecimal(acc.netBalance);
    if (isZeroDec(net)) continue;

    if (acc.accountType === "REVENUE") {
      totalRevenue = addDec(totalRevenue, net);
      // Normal CREDIT balance -> DEBIT it to close to zero (or CREDIT if negative contra-revenue)
      const amt = isNegativeDec(net) ? -net : net;
      const amtStr = formatDecimal(amt, 2);
      if (isPositiveDec(net)) {
        closingLines.push({
          accountId: acc.accountId,
          account_code: acc.code,
          account_name: acc.name,
          account_type: acc.accountType,
          debit: amtStr,
          credit: "0.00",
          description: `بستن حساب موقت درآمد ${acc.name}`,
        });
        totalDebit = addDec(totalDebit, amt);
      } else {
        closingLines.push({
          accountId: acc.accountId,
          account_code: acc.code,
          account_name: acc.name,
          account_type: acc.accountType,
          debit: "0.00",
          credit: amtStr,
          description: `بستن حساب کاهنده درآمد ${acc.name}`,
        });
        totalCredit = addDec(totalCredit, amt);
      }
    } else if (acc.accountType === "EXPENSE") {
      totalExpense = addDec(totalExpense, net);
      // Normal DEBIT balance -> CREDIT it to close to zero
      const amt = isNegativeDec(net) ? -net : net;
      const amtStr = formatDecimal(amt, 2);
      if (isPositiveDec(net)) {
        closingLines.push({
          accountId: acc.accountId,
          account_code: acc.code,
          account_name: acc.name,
          account_type: acc.accountType,
          debit: "0.00",
          credit: amtStr,
          description: `بستن حساب موقت هزینه ${acc.name}`,
        });
        totalCredit = addDec(totalCredit, amt);
      } else {
        closingLines.push({
          accountId: acc.accountId,
          account_code: acc.code,
          account_name: acc.name,
          account_type: acc.accountType,
          debit: amtStr,
          credit: "0.00",
          description: `بستن حساب کاهنده هزینه ${acc.name}`,
        });
        totalDebit = addDec(totalDebit, amt);
      }
    }
  }

  // Net Profit = Total Revenue - Total Expense -> Transfer to RETAINED_EARNINGS!
  const netProfit = subDec(totalRevenue, totalExpense);
  if (!isZeroDec(netProfit)) {
    const absProfit = isNegativeDec(netProfit) ? -netProfit : netProfit;
    const absStr = formatDecimal(absProfit, 2);
    if (isPositiveDec(netProfit)) {
      // Profit -> CREDIT Retained Earnings
      closingLines.push({
        accountId: retAcc.id,
        account_code: retAcc.code,
        account_name: retAcc.name,
        account_type: retAcc.accountType,
        debit: "0.00",
        credit: absStr,
        description: `انتقال سود خالص ${fy.name} به سود و زیان انباشته`,
      });
      totalCredit = addDec(totalCredit, absProfit);
    } else {
      // Loss -> DEBIT Retained Earnings
      closingLines.push({
        accountId: retAcc.id,
        account_code: retAcc.code,
        account_name: retAcc.name,
        account_type: retAcc.accountType,
        debit: absStr,
        credit: "0.00",
        description: `انتقال زیان خالص ${fy.name} به سود و زیان انباشته`,
      });
      totalDebit = addDec(totalDebit, absProfit);
    }
  }

  return {
    fiscal_year: fy,
    closing_date: fy.endDate,
    retained_earnings_account: { id: retAcc.id, code: retAcc.code, name: retAcc.name },
    total_revenue: formatDecimal(totalRevenue, 2),
    total_expense: formatDecimal(totalExpense, 2),
    net_profit_or_loss: formatDecimal(netProfit, 2),
    total_debit: formatDecimal(totalDebit, 2),
    total_credit: formatDecimal(totalCredit, 2),
    is_balanced: eqDec(totalDebit, totalCredit),
    closing_lines: closingLines,
  };
}

/**
 * Master Prompt 06 §9.4–§9.7 & Test H — Execute Atomic Fiscal Year Closure + Closing Journal
 */
export async function executeFiscalYearClosing(params: {
  organizationId: string;
  fiscalYearId: string;
  acknowledgeWarnings?: boolean;
  actorUserId: string;
  actorEmail: string;
  ipAddress?: string | null;
}) {
  const result = await withTenantTransaction(params.organizationId, async (tx) => {
    // Keep the fiscal year locked while re-running the checklist and preview.
    // Journal writers acquire this same lock before inserting, so a posting
    // cannot slip between the financial snapshot and the closing journal.
    await tx.execute(sql`
      SELECT id FROM fiscal_years
      WHERE id = ${params.fiscalYearId}
        AND organization_id = ${params.organizationId}
      FOR UPDATE
    `);
    const [fy] = await tx
      .select()
      .from(fiscalYears)
      .where(
        and(
          eq(fiscalYears.id, params.fiscalYearId),
          eq(fiscalYears.organizationId, params.organizationId)
        )
      )
      .limit(1);
    if (!fy) throw new ApiError(404, "FISCAL_YEAR_NOT_FOUND", "سال مالی یافت نشد.");
    if (fy.status === "CLOSED") {
      throw new ApiError(409, "FISCAL_YEAR_ALREADY_CLOSED", "این سال مالی قبلاً بسته شده است.");
    }
    if (!["OPEN", "REOPENED"].includes(fy.status)) {
      throw new ApiError(409, "FISCAL_YEAR_NOT_OPEN", "سال مالی در وضعیت قابل بستن قرار ندارد.");
    }

    const checklist = await runPreClosingChecklist(params.organizationId, params.fiscalYearId);
    if (checklist.critical_failures > 0) {
      throw new ApiError(
        409,
        "PRE_CLOSING_CHECKLIST_FAILED",
        "خطاهای بحرانی در چک‌لیست پیش از بستن سال مالی وجود دارد و بستن سال مسدود است."
      );
    }
    if (checklist.warnings_count > 0 && !params.acknowledgeWarnings) {
      throw new ApiError(
        422,
        "WARNINGS_ACKNOWLEDGMENT_REQUIRED",
        `تعداد ${checklist.warnings_count} هشدار در چک‌لیست وجود دارد؛ برای ادامه باید acknowledge_warnings = true تایید شود.`
      );
    }

    const preview = await buildFiscalYearClosingPreview(params.organizationId, params.fiscalYearId);
    if (!preview.is_balanced) {
      throw new ApiError(409, "CLOSING_JOURNAL_UNBALANCED", "سند اختتامیه محاسبه‌شده تراز نیست.");
    }

    let closingJournal = null;

    if (preview.closing_lines.length >= 2) {
      const jr = await createJournalEntryTx(tx, {
        organizationId: params.organizationId,
        actorUserId: params.actorUserId,
        actorEmail: params.actorEmail,
        fiscalYearId: params.fiscalYearId,
        entryDate: preview.closing_date,
        description: `سند اختتامیه بستن حساب‌های موقت (سود و زیانی) ${preview.fiscal_year.name}`,
        referenceType: "CLOSING",
        postImmediately: true,
        allowClosedPeriod: true,
        allowInactiveAccounts: true,
        lines: preview.closing_lines.map((l) => ({
          accountId: l.accountId,
          debit: l.debit,
          credit: l.credit,
          description: l.description,
        })),
      });
      closingJournal = jr.entry;
    }

    // Recompute permanent account closing balances AFTER posting closing journal (inside same tx)
    const orgAccs = await tx
      .select()
      .from(accounts)
      .where(eq(accounts.organizationId, params.organizationId));
    const fyLines = await tx
      .select({
        accountId: journalEntryLines.accountId,
        debit: journalEntryLines.debit,
        credit: journalEntryLines.credit,
      })
      .from(journalEntryLines)
      .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
      .where(
        and(
          eq(journalEntries.organizationId, params.organizationId),
          eq(journalEntries.fiscalYearId, params.fiscalYearId),
          inArray(journalEntries.status, ["POSTED", "REVERSED"])
        )
      );

    const aggMap = new Map<string, { d: bigint; c: bigint }>();
    for (const l of fyLines) {
      const cur = aggMap.get(l.accountId) ?? { d: BigInt(0), c: BigInt(0) };
      cur.d = addDec(cur.d, l.debit);
      cur.c = addDec(cur.c, l.credit);
      aggMap.set(l.accountId, cur);
    }

    // Permanent accounts ONLY (ASSET, LIABILITY, EQUITY) for carry-forward!
    const carryForwardSnapshot: Array<Record<string, unknown>> = [];
    for (const acc of orgAccs) {
      if (!["ASSET", "LIABILITY", "EQUITY"].includes(acc.accountType)) continue;
      const ag = aggMap.get(acc.id);
      if (!ag) continue;
      const diff = subDec(ag.d, ag.c); // positive => net debit, negative => net credit
      if (isZeroDec(diff)) continue;
      carryForwardSnapshot.push({
        account_id: acc.id,
        account_code: acc.code,
        account_name: acc.name,
        account_type: acc.accountType,
        debit: isPositiveDec(diff) ? formatDecimal(diff, 2) : "0.00",
        credit: isNegativeDec(diff) ? formatDecimal(-diff, 2) : "0.00",
      });
    }

    const now = new Date();
    // Lock all accounting periods in this FY
    await tx
      .update(accountingPeriods)
      .set({ status: "CLOSED", closedAt: now, closedBy: params.actorUserId })
      .where(eq(accountingPeriods.fiscalYearId, params.fiscalYearId));

    // Mark Fiscal Year CLOSED
    const [closedFy] = await tx
      .update(fiscalYears)
      .set({
        status: "CLOSED",
        closingJournalId: closingJournal?.id ?? null,
        closedAt: now,
        closedBy: params.actorUserId,
      })
      .where(eq(fiscalYears.id, params.fiscalYearId))
      .returning();

    const [closingRec] = await tx
      .insert(fiscalYearClosings)
      .values({
        organizationId: params.organizationId,
        fiscalYearId: closedFy.id,
        retainedEarningsAccountId: preview.retained_earnings_account.id,
        closingJournalId: closingJournal?.id ?? null,
        netProfitOrLoss: preview.net_profit_or_loss,
        checklistSnapshot: checklist as unknown as Record<string, unknown>,
        carryForwardSnapshot,
        status: "POSTED",
        approvedBy: params.actorUserId,
        postedAt: now,
        createdBy: params.actorUserId,
      })
      .returning();

    return {
      fiscalYear: closedFy,
      closingRecord: closingRec,
      closingJournal,
      netProfitOrLoss: preview.net_profit_or_loss,
      carryForwardCount: carryForwardSnapshot.length,
      carryForwardSnapshot,
    };
  });

  await recordAuditLog({
    organizationId: params.organizationId,
    actorUserId: params.actorUserId,
    actorEmail: params.actorEmail,
    scope: "ORGANIZATION",
    action: "FISCAL_YEAR_CLOSED",
    entityType: "FISCAL_YEAR",
    entityId: params.fiscalYearId,
    ipAddress: params.ipAddress,
    metadata: {
      closingJournalId: result.closingJournal?.id ?? null,
      netProfitOrLoss: result.netProfitOrLoss,
      carryForwardAccounts: result.carryForwardCount,
    },
  });

  return result;
}

/**
 * Master Prompt 06 §8.4, §9.8 & Test I — Create & Open Next Fiscal Year with Permanent Carry-Forward Opening Journal
 */
export async function prepareAndOpenNextFiscalYear(params: {
  organizationId: string;
  previousFiscalYearId: string;
  nextName: string;
  nextStartDate: string;
  nextEndDate: string;
  actorUserId: string;
  actorEmail: string;
  ipAddress?: string | null;
}) {
  const opened = await withTenantTransaction(params.organizationId, async (tx) => {
    await tx.execute(sql`
      SELECT id FROM fiscal_years
      WHERE id = ${params.previousFiscalYearId} AND organization_id = ${params.organizationId}
      FOR UPDATE
    `);
    const [prevFy] = await tx.select().from(fiscalYears).where(and(
      eq(fiscalYears.id, params.previousFiscalYearId),
      eq(fiscalYears.organizationId, params.organizationId)
    )).limit(1);
    if (!prevFy) throw new ApiError(404, "FISCAL_YEAR_NOT_FOUND", "سال مالی قبلی یافت نشد.");
    if (prevFy.status !== "CLOSED") throw new ApiError(409, "PREVIOUS_FISCAL_YEAR_NOT_CLOSED", "برای انتقال مانده و افتتاح سال مالی جدید، ابتدا باید سال مالی قبلی را ببندید.");

    const expectedNextStart = new Date(`${prevFy.endDate}T00:00:00.000Z`);
    expectedNextStart.setUTCDate(expectedNextStart.getUTCDate() + 1);
    const expectedNextStartDate = expectedNextStart.toISOString().slice(0, 10);
    if (params.nextStartDate !== expectedNextStartDate || params.nextEndDate < params.nextStartDate) {
      throw new ApiError(422, "NEXT_FISCAL_YEAR_DATES_INVALID", `سال مالی بعدی باید از ${expectedNextStartDate} آغاز شود و تاریخ پایان آن نیز از تاریخ آغاز جلوتر باشد.`);
    }

    const [closingRec] = await tx.select().from(fiscalYearClosings).where(and(
      eq(fiscalYearClosings.organizationId, params.organizationId),
      eq(fiscalYearClosings.fiscalYearId, prevFy.id),
      eq(fiscalYearClosings.status, "POSTED")
    )).orderBy(desc(fiscalYearClosings.createdAt)).limit(1);
    if (!closingRec) throw new ApiError(422, "FISCAL_YEAR_CLOSING_RECORD_MISSING", "سابقهٔ قطعی بستن سال مالی برای انتقال مانده یافت نشد.");

    const openingLines: JournalLineInput[] = closingRec.carryForwardSnapshot.map((row) => ({
      accountId: String(row.account_id),
      debit: String(row.debit),
      credit: String(row.credit),
      description: `انتقال مانده دائمی از ${prevFy.name} (${String(row.account_code)} — ${String(row.account_name)})`,
    }));
    if (openingLines.length === 1) throw new ApiError(409, "CARRY_FORWARD_UNBALANCED", "ماندهٔ انتقالی برای ساخت سند افتتاحیه تراز نیست.");
    const openingDebit = openingLines.reduce((sum, line) => addDec(sum, line.debit), BigInt(0));
    const openingCredit = openingLines.reduce((sum, line) => addDec(sum, line.credit), BigInt(0));
    if (!eqDec(openingDebit, openingCredit)) throw new ApiError(409, "CARRY_FORWARD_UNBALANCED", "ماندهٔ انتقالی برای ساخت سند افتتاحیه تراز نیست.");

    let nextFy: typeof fiscalYears.$inferSelect;
    let periods: Array<typeof accountingPeriods.$inferSelect>;
    let createdNextFiscalYear = false;
    if (prevFy.nextFiscalYearId) {
      await tx.execute(sql`
        SELECT id FROM fiscal_years
        WHERE id = ${prevFy.nextFiscalYearId} AND organization_id = ${params.organizationId}
        FOR UPDATE
      `);
      const [existingNext] = await tx.select().from(fiscalYears).where(and(
        eq(fiscalYears.id, prevFy.nextFiscalYearId),
        eq(fiscalYears.organizationId, params.organizationId)
      )).limit(1);
      if (!existingNext || existingNext.status !== "OPEN" || existingNext.openingJournalId) {
        throw new ApiError(409, "NEXT_FISCAL_YEAR_ALREADY_OPENED", "سال مالی بعدی قبلاً افتتاح شده یا در وضعیت نامعتبر است.");
      }
      const existingEntries = await tx.select({ id: journalEntries.id }).from(journalEntries).where(and(
        eq(journalEntries.organizationId, params.organizationId),
        eq(journalEntries.fiscalYearId, existingNext.id),
        inArray(journalEntries.status, ["POSTED", "DRAFT"])
      )).limit(1);
      if (existingEntries.length > 0) throw new ApiError(409, "NEXT_FISCAL_YEAR_HAS_ACTIVITY", "سال مالی بعدی دارای سند حسابداری است؛ مانده افتتاحیه را نمی‌توان بدون بازسازی دفترها تغییر داد.");
      if (existingNext.startDate !== params.nextStartDate || existingNext.endDate !== params.nextEndDate) {
        throw new ApiError(409, "NEXT_FISCAL_YEAR_DATES_MISMATCH", "تاریخ‌های سال مالی بعدی با سالی که قبلاً ایجاد شده یکسان نیست.");
      }
      nextFy = existingNext;
      periods = await tx.select().from(accountingPeriods).where(eq(accountingPeriods.fiscalYearId, existingNext.id)).orderBy(accountingPeriods.periodNumber);
      if (periods.length === 0) throw new ApiError(409, "NEXT_FISCAL_YEAR_PERIODS_MISSING", "دوره‌های سال مالی بعدی ایجاد نشده‌اند.");
    } else {
      const created = await createFiscalYearWithPeriodsTx(tx, {
        organizationId: params.organizationId,
        name: params.nextName,
        startDate: params.nextStartDate,
        endDate: params.nextEndDate,
        calendarSystem: prevFy.calendarSystem as "PERSIAN" | "GREGORIAN",
        currency: prevFy.currency,
        previousFiscalYearId: prevFy.id,
        status: "OPEN",
        actorUserId: params.actorUserId,
        actorEmail: params.actorEmail,
        ipAddress: params.ipAddress,
      });
      nextFy = created.fiscalYear;
      periods = created.periods;
      createdNextFiscalYear = true;
    }

    const jRes = openingLines.length >= 2
      ? await createJournalEntryTx(tx, {
          organizationId: params.organizationId,
          actorUserId: params.actorUserId,
          actorEmail: params.actorEmail,
          fiscalYearId: nextFy.id,
          accountingPeriodId: periods[0].id,
          entryDate: nextFy.startDate,
          description: `سند افتتاحیه ${nextFy.name} — انتقال مانده حساب‌های دائمی از سند اختتامیه ${prevFy.name}`,
          referenceType: "OPENING",
          referenceId: prevFy.closingJournalId ?? closingRec.id,
          postImmediately: true,
          allowInactiveAccounts: true,
          lines: openingLines,
        })
      : null;

    for (const line of openingLines) {
      await tx.insert(openingBalances).values({
        organizationId: params.organizationId,
        fiscalYearId: nextFy.id,
        accountId: line.accountId,
        debit: line.debit,
        credit: line.credit,
      }).onConflictDoUpdate({
        target: [openingBalances.fiscalYearId, openingBalances.accountId],
        set: { debit: line.debit, credit: line.credit },
      });
    }
    const [updatedNext] = await tx.update(fiscalYears).set({ openingJournalId: jRes?.entry.id ?? null }).where(eq(fiscalYears.id, nextFy.id)).returning();
    return { nextFiscalYear: updatedNext, periods, openingJournal: jRes?.entry ?? null, carriedAccounts: closingRec.carryForwardSnapshot, previousFiscalYear: prevFy, createdNextFiscalYear };
  });

  if (opened.createdNextFiscalYear) {
    await recordAuditLog({
      organizationId: params.organizationId,
      actorUserId: params.actorUserId,
      actorEmail: params.actorEmail,
      scope: "ORGANIZATION",
      action: "FISCAL_YEAR_CREATED",
      entityType: "FISCAL_YEAR",
      entityId: opened.nextFiscalYear.id,
      ipAddress: params.ipAddress,
      metadata: { name: opened.nextFiscalYear.name, startDate: params.nextStartDate, endDate: params.nextEndDate, previousFiscalYearId: opened.previousFiscalYear.id },
    });
  }

  await recordAuditLog({
    organizationId: params.organizationId,
    actorUserId: params.actorUserId,
    actorEmail: params.actorEmail,
    scope: "ORGANIZATION",
    action: "NEXT_FISCAL_YEAR_OPENED",
    entityType: "FISCAL_YEAR",
    entityId: opened.nextFiscalYear.id,
    ipAddress: params.ipAddress,
    metadata: {
      previousFiscalYearId: opened.previousFiscalYear.id,
      previousClosingJournalId: opened.previousFiscalYear.closingJournalId,
      openingJournalId: opened.openingJournal?.id ?? null,
      carriedCount: opened.carriedAccounts.length,
    },
  });

  return opened;
}

/**
 * Master Prompt 06 §9.9 & Test J — Controlled & Auditable Reopening of a Closed Fiscal Year
 * NEVER deletes closing journal; reverses it cleanly via immutable reversal voucher!
 */
export async function reopenClosedFiscalYear(params: {
  organizationId: string;
  fiscalYearId: string;
  reason: string;
  actorUserId: string;
  actorEmail: string;
  ipAddress?: string | null;
}) {
  if (!params.reason || params.reason.trim().length < 5) {
    throw new ApiError(422, "REOPEN_REASON_REQUIRED", "ذکر دلیل رسمی (حداقل ۵ کاراکتر) برای بازگشایی سال مالی الزامی است.");
  }

  const reopened = await withTenantTransaction(params.organizationId, async (tx) => {
    await tx.execute(sql`
      SELECT id FROM fiscal_years
      WHERE id = ${params.fiscalYearId} AND organization_id = ${params.organizationId}
      FOR UPDATE
    `);
    const [fy] = await tx.select().from(fiscalYears).where(and(
      eq(fiscalYears.id, params.fiscalYearId),
      eq(fiscalYears.organizationId, params.organizationId)
    )).limit(1);
    if (!fy) throw new ApiError(404, "FISCAL_YEAR_NOT_FOUND", "سال مالی یافت نشد.");
    if (fy.status !== "CLOSED") throw new ApiError(409, "FISCAL_YEAR_NOT_CLOSED", "این سال مالی در وضعیت بسته قرار ندارد.");

    if (fy.nextFiscalYearId) {
      await tx.execute(sql`
        SELECT id FROM fiscal_years
        WHERE id = ${fy.nextFiscalYearId} AND organization_id = ${params.organizationId}
        FOR UPDATE
      `);
      const [nextFy] = await tx.select().from(fiscalYears).where(and(
        eq(fiscalYears.id, fy.nextFiscalYearId),
        eq(fiscalYears.organizationId, params.organizationId)
      )).limit(1);
      if (nextFy?.openingJournalId) {
        throw new ApiError(409, "NEXT_FISCAL_YEAR_OPENING_DEPENDS_ON_CLOSED_YEAR", "سال بعد سند افتتاحیهٔ قطعی دارد؛ بازگشایی این سال باعث کهنه شدن مانده‌های انتقالی می‌شود. ابتدا مانده‌های سال بعد را از مسیر اصلاح رسمی حسابداری بازسازی کنید.");
      }
      const nextOps = await tx.select({ id: journalEntries.id }).from(journalEntries).where(and(
        eq(journalEntries.organizationId, params.organizationId),
        eq(journalEntries.fiscalYearId, fy.nextFiscalYearId),
        ne(journalEntries.referenceType, "OPENING"),
        eq(journalEntries.status, "POSTED")
      )).limit(1);
      if (nextOps.length > 0) throw new ApiError(409, "NEXT_FISCAL_YEAR_HAS_ACTIVITY", "سال مالی بعدی دارای اسناد عملیاتی قطعی است؛ بازگشایی مستقیم مسدود است.");
    }

    const periods = await tx.select().from(accountingPeriods).where(eq(accountingPeriods.fiscalYearId, fy.id)).orderBy(desc(accountingPeriods.periodNumber));
    let closingPeriodId: string | null = periods[0]?.id ?? null;
    if (fy.closingJournalId) {
      const [closingJournal] = await tx.select({ accountingPeriodId: journalEntries.accountingPeriodId }).from(journalEntries).where(and(
        eq(journalEntries.id, fy.closingJournalId),
        eq(journalEntries.organizationId, params.organizationId)
      )).limit(1);
      if (closingJournal?.accountingPeriodId) closingPeriodId = closingJournal.accountingPeriodId;
    }
    if (!closingPeriodId && fy.closingJournalId) throw new ApiError(409, "CLOSING_PERIOD_MISSING", "دورهٔ سند اختتامیه برای بازگشایی یافت نشد.");

    const now = new Date();
    const [reopenedFy] = await tx.update(fiscalYears).set({
      status: "REOPENED",
      reopenedAt: now,
      reopenedBy: params.actorUserId,
      reopenReason: params.reason,
    }).where(and(
      eq(fiscalYears.id, fy.id),
      eq(fiscalYears.organizationId, params.organizationId),
      eq(fiscalYears.status, "CLOSED")
    )).returning();
    if (!reopenedFy) throw new ApiError(409, "FISCAL_YEAR_CHANGED", "وضعیت سال مالی هم‌زمان تغییر کرد؛ دوباره تلاش کنید.");
    if (closingPeriodId) {
      await tx.update(accountingPeriods).set({ status: "OPEN", closedAt: null, closedBy: null }).where(eq(accountingPeriods.id, closingPeriodId));
    }

    const reversalResult = fy.closingJournalId
      ? await reverseJournalEntryTx(tx, {
          organizationId: params.organizationId,
          journalEntryId: fy.closingJournalId,
          reason: `بازگشایی مجاز سال مالی ${fy.name}: ${params.reason}`,
          actorUserId: params.actorUserId,
          actorEmail: params.actorEmail,
        })
      : null;
    await tx.update(fiscalYearClosings).set({ status: "REVERSED" }).where(and(
      eq(fiscalYearClosings.organizationId, params.organizationId),
      eq(fiscalYearClosings.fiscalYearId, fy.id),
      eq(fiscalYearClosings.status, "POSTED")
    ));
    return { fiscalYear: reopenedFy, reversal: reversalResult?.reversal ?? null, originalFiscalYear: fy };
  });

  await recordAuditLog({
    organizationId: params.organizationId,
    actorUserId: params.actorUserId,
    actorEmail: params.actorEmail,
    scope: "SECURITY",
    action: "FISCAL_YEAR_REOPENED",
    entityType: "FISCAL_YEAR",
    entityId: reopened.fiscalYear.id,
    ipAddress: params.ipAddress,
    severity: "WARN",
    metadata: {
      reason: params.reason,
      reversedClosingJournalId: reopened.originalFiscalYear.closingJournalId,
      reversalVoucherId: reopened.reversal?.id ?? null,
    },
  });

  return {
    fiscalYear: reopened.fiscalYear,
    reversal: reopened.reversal,
    historicalJournalPreserved: true,
  };
}

export async function compareFiscalYears(organizationId: string) {
  const fys = await db
    .select()
    .from(fiscalYears)
    .where(eq(fiscalYears.organizationId, organizationId))
    .orderBy(fiscalYears.startDate);

  const results = await Promise.all(
    fys.map(async (fy) => {
      const rep = await buildAccountingReports(organizationId, fy.id);
      return {
        fiscal_year_id: fy.id,
        name: fy.name,
        start_date: fy.startDate,
        end_date: fy.endDate,
        status: fy.status,
        revenue: rep.profitAndLoss.totalRevenue,
        expenses: rep.profitAndLoss.totalExpense,
        net_profit: rep.profitAndLoss.netProfit,
        assets: rep.balanceSheetSummary.totalAssets,
        liabilities: rep.balanceSheetSummary.totalLiabilities,
        equity: rep.balanceSheetSummary.totalEquity,
        is_balanced: rep.isTrialBalanced,
      };
    })
  );

  return results;
}

export async function listAccountsWithBalances(organizationId: string) {
  const [groups, accs, reports, closures] = await Promise.all([
    db.select().from(accountGroups).where(eq(accountGroups.organizationId, organizationId)).orderBy(accountGroups.code),
    db.select().from(accounts).where(eq(accounts.organizationId, organizationId)).orderBy(accounts.code),
    buildAccountingReports(organizationId),
    db.select().from(accountClosures).where(eq(accountClosures.organizationId, organizationId)).orderBy(desc(accountClosures.closedAt)),
  ]);

  const tbMap = new Map(reports.trialBalance.map((r) => [r.accountId, r]));
  return {
    groups,
    closures,
    accounts: accs.map((a) => {
      const tb = tbMap.get(a.id);
      return {
        ...a,
        total_debit: tb?.totalDebit ?? "0.00",
        total_credit: tb?.totalCredit ?? "0.00",
        net_balance: tb?.netBalance ?? "0.00",
        entries_count: tb?.entriesCount ?? 0,
      };
    }),
  };
}

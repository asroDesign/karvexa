import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  accountingPeriods,
  accounts,
  fiscalYears,
  journalEntries,
  journalEntryLines,
} from "@/db/schema";
import {
  addDec,
  eqDec,
  formatDecimal,
  isNegativeDec,
  isPositiveDec,
  parseDecimal,
  subDec,
} from "@/lib/decimal";
import { ApiError } from "@/lib/errors";
import { recordAuditLog } from "@/lib/audit";
import { withTenantTransaction } from "@/lib/tenant";

export interface JournalLineInput {
  accountId: string;
  debit: string;
  credit: string;
  description?: string | null;
  costCenterId?: string | null;
  contactId?: string | null;
}

export interface CreateJournalEntryInput {
  organizationId: string;
  actorUserId: string;
  actorEmail: string;
  ipAddress?: string | null;
  fiscalYearId?: string;
  accountingPeriodId?: string;
  entryDate: string;
  description: string;
  referenceType?: string;
  referenceId?: string | null;
  postImmediately?: boolean;
  allowClosedPeriod?: boolean;
  allowInactiveAccounts?: boolean;
  lines: JournalLineInput[];
}

export function validateJournalLines(lines: JournalLineInput[]) {
  if (!lines || lines.length < 2) {
    throw new ApiError(
      422,
      "ACCOUNTING_MIN_LINES",
      "هر سند حسابداری دوبل باید حداقل ۲ آرتیکل (سطر) داشته باشد."
    );
  }

  let totalDebit = BigInt(0);
  let totalCredit = BigInt(0);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const debit = parseDecimal(line.debit || "0");
    const credit = parseDecimal(line.credit || "0");

    if (isNegativeDec(debit) || isNegativeDec(credit)) {
      throw new ApiError(
        422,
        "AMOUNT_NEGATIVE",
        `مبلغ بدهکار یا بستانکار در سطر ${i + 1} نمی‌تواند منفی باشد.`
      );
    }
    if (isPositiveDec(debit) && isPositiveDec(credit)) {
      throw new ApiError(
        422,
        "LINE_BOTH_SIDES",
        `در سطر ${i + 1} نمی‌توان هم‌زمان بدهکار و بستانکار ثبت کرد.`
      );
    }
    if (!isPositiveDec(debit) && !isPositiveDec(credit)) {
      throw new ApiError(
        422,
        "LINE_ZERO_AMOUNT",
        `سطر ${i + 1} باید دارای مبلغ بدهکار یا بستانکار غیرصفر باشد.`
      );
    }

    totalDebit += debit;
    totalCredit += credit;
  }

  return {
    totalDebit,
    totalCredit,
    isBalanced: eqDec(totalDebit, totalCredit) && isPositiveDec(totalDebit),
  };
}

export async function createJournalEntryTx(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  input: CreateJournalEntryInput
) {
  const { totalDebit, totalCredit, isBalanced } = validateJournalLines(input.lines);

  if (input.postImmediately && !isBalanced) {
    throw new ApiError(
      409,
      "ACCOUNTING_UNBALANCED",
      `سند تراز نیست! جمع بدهکار (${formatDecimal(totalDebit, 2)}) با جمع بستانکار (${formatDecimal(totalCredit, 2)}) برابر نیست.`
    );
  }

  // Resolve Fiscal Year
  let fy;
  if (input.fiscalYearId) {
    [fy] = await tx
      .select()
      .from(fiscalYears)
      .where(
        and(
          eq(fiscalYears.id, input.fiscalYearId),
          eq(fiscalYears.organizationId, input.organizationId)
        )
      )
      .limit(1);
  } else {
    [fy] = await tx
      .select()
      .from(fiscalYears)
      .where(
        and(
          eq(fiscalYears.organizationId, input.organizationId),
          eq(fiscalYears.isDefault, true)
        )
      )
      .limit(1);
  }
  if (!fy) {
    throw new ApiError(404, "FISCAL_YEAR_NOT_FOUND", "سال مالی فعال برای سازمان یافت نشد.");
  }
  if (fy.status === "CLOSED" && !input.allowClosedPeriod) {
    throw new ApiError(409, "FISCAL_YEAR_CLOSED", "سال مالی بسته شده است و امکان ثبت سند جدید وجود ندارد.");
  }

  // Resolve Accounting Period
  let period;
  if (input.accountingPeriodId) {
    [period] = await tx
      .select()
      .from(accountingPeriods)
      .where(
        and(
          eq(accountingPeriods.id, input.accountingPeriodId),
          eq(accountingPeriods.organizationId, input.organizationId),
          eq(accountingPeriods.fiscalYearId, fy.id)
        )
      )
      .limit(1);
  } else {
    const periods = await tx
      .select()
      .from(accountingPeriods)
      .where(
        and(
          eq(accountingPeriods.organizationId, input.organizationId),
          eq(accountingPeriods.fiscalYearId, fy.id)
        )
      )
      .orderBy(accountingPeriods.periodNumber);
    period =
      periods.find(
        (p) => input.entryDate >= p.startDate && input.entryDate <= p.endDate
      ) || periods.find((p) => p.status === "OPEN") || periods[0];
  }

  if (!period) {
    throw new ApiError(404, "ACCOUNTING_PERIOD_NOT_FOUND", "دوره مالی معتبر یافت نشد.");
  }
  if (period.status === "CLOSED" && !input.allowClosedPeriod) {
    throw new ApiError(
      409,
      "ACCOUNTING_PERIOD_CLOSED",
      `دوره مالی «${period.name}» بسته شده است و پذیرش سند جدید مسدود است.`
    );
  }
  if (
    !input.allowClosedPeriod &&
    (period.status === "LOCKED" || (period.lockedUntil && input.entryDate <= period.lockedUntil))
  ) {
    throw new ApiError(
      409,
      "ACCOUNTING_PERIOD_LOCKED",
      `دوره مالی «${period.name}» تا تاریخ ${period.lockedUntil ?? period.endDate} قفل شده است و ثبت یا تغییر سند در این بازه مجاز نیست.`
    );
  }

  // Verify every account belongs strictly to this organization and is postable
  const uniqueAccIds = [...new Set(input.lines.map((l) => l.accountId))];
  const validAccounts = await tx
    .select()
    .from(accounts)
    .where(
      and(
        eq(accounts.organizationId, input.organizationId),
        inArray(accounts.id, uniqueAccIds)
      )
    );

  if (validAccounts.length !== uniqueAccIds.length) {
    throw new ApiError(
      403,
      "ACCOUNT_NOT_FOUND",
      "یکی یا چند حساب انتخاب‌شده متعلق به این سازمان نیستند."
    );
  }
  const nonPostable = validAccounts.find((a) => !a.isPostable);
  if (nonPostable) {
    throw new ApiError(
      422,
      "ACCOUNT_NOT_POSTABLE",
      `حساب «${nonPostable.name}» از نوع گروه/کل است و مستقیم قابل ثبت سند نیست.`
    );
  }
  if (!input.allowInactiveAccounts) {
    const closedAcc = validAccounts.find(
      (a) => !a.isActive || a.accountStatus === "CLOSED" || a.accountStatus === "TEMPORARILY_SUSPENDED"
    );
    if (closedAcc) {
      throw new ApiError(
        409,
        "ACCOUNT_CLOSED",
        `حساب «${closedAcc.name}» (${closedAcc.code}) بسته یا غیرفعال است و پذیرش آرتیکل جدید در آن مجاز نیست.`
      );
    }
  }

  // Lock fiscal year row for race-free sequential entry_number
  await tx.execute(
    sql`SELECT id FROM fiscal_years WHERE id = ${fy.id} FOR UPDATE`
  );
  const [maxRes] = await tx
    .select({
      maxNum: sql<number>`COALESCE(MAX(${journalEntries.entryNumber}), 0)`,
    })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.organizationId, input.organizationId),
        eq(journalEntries.fiscalYearId, fy.id)
      )
    );

  const nextEntryNumber = Number(maxRes?.maxNum ?? 0) + 1;
  const now = new Date();
  const status = input.postImmediately ? "POSTED" : "DRAFT";

  const [entry] = await tx
    .insert(journalEntries)
    .values({
      organizationId: input.organizationId,
      fiscalYearId: fy.id,
      accountingPeriodId: period.id,
      entryNumber: nextEntryNumber,
      entryDate: input.entryDate,
      description: input.description,
      referenceType: input.referenceType ?? "MANUAL",
      referenceId: input.referenceId ?? null,
      status,
      totalDebit: formatDecimal(totalDebit, 2),
      totalCredit: formatDecimal(totalCredit, 2),
      createdBy: input.actorUserId,
      postedBy: status === "POSTED" ? input.actorUserId : null,
      postedAt: status === "POSTED" ? now : null,
      syncSeq: Date.now(),
    })
    .returning();

  const insertedLines = await tx
    .insert(journalEntryLines)
    .values(
      input.lines.map((l, idx) => ({
        organizationId: input.organizationId,
        journalEntryId: entry.id,
        accountId: l.accountId,
        costCenterId: l.costCenterId ?? null,
        contactId: l.contactId ?? null,
        lineOrder: idx + 1,
        description: l.description ?? input.description,
        debit: formatDecimal(parseDecimal(l.debit || "0"), 2),
        credit: formatDecimal(parseDecimal(l.credit || "0"), 2),
      }))
    )
    .returning();

  return { entry, lines: insertedLines };
}

export async function createJournalEntry(input: CreateJournalEntryInput) {
  const result = await withTenantTransaction(input.organizationId, async (tx) => {
    return createJournalEntryTx(tx, input);
  });

  await recordAuditLog({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    actorEmail: input.actorEmail,
    scope: "ORGANIZATION",
    action: result.entry.status === "POSTED" ? "JOURNAL_POSTED" : "JOURNAL_DRAFT_CREATED",
    entityType: "JOURNAL_ENTRY",
    entityId: result.entry.id,
    ipAddress: input.ipAddress,
    metadata: {
      entryNumber: result.entry.entryNumber,
      totalDebit: result.entry.totalDebit,
      totalCredit: result.entry.totalCredit,
      status: result.entry.status,
    },
  });

  return result;
}

export async function postJournalEntry(params: {
  organizationId: string;
  journalEntryId: string;
  actorUserId: string;
  actorEmail: string;
  ipAddress?: string | null;
}) {
  const updated = await withTenantTransaction(params.organizationId, async (tx) => {
    const [entry] = await tx
      .select()
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.id, params.journalEntryId),
          eq(journalEntries.organizationId, params.organizationId)
        )
      )
      .limit(1);

    if (!entry) {
      throw new ApiError(404, "JOURNAL_NOT_FOUND", "سند حسابداری یافت نشد.");
    }
    if (entry.status !== "DRAFT") {
      throw new ApiError(
        409,
        "ACCOUNTING_ENTRY_IMMUTABLE",
        "این سند قبلاً قطعی یا معکوس شده است و قابل تغییر نیست."
      );
    }

    const [period] = await tx
      .select()
      .from(accountingPeriods)
      .where(eq(accountingPeriods.id, entry.accountingPeriodId))
      .limit(1);
    if (!period || period.status === "CLOSED") {
      throw new ApiError(
        409,
        "ACCOUNTING_PERIOD_CLOSED",
        "دوره مالی مربوط به این سند بسته شده است."
      );
    }

    const lines = await tx
      .select()
      .from(journalEntryLines)
      .where(eq(journalEntryLines.journalEntryId, entry.id));

    const { totalDebit, totalCredit, isBalanced } = validateJournalLines(
      lines.map((l) => ({
        accountId: l.accountId,
        debit: l.debit,
        credit: l.credit,
      }))
    );

    if (!isBalanced) {
      throw new ApiError(
        409,
        "ACCOUNTING_UNBALANCED",
        `سند تراز نیست (بدهکار: ${formatDecimal(totalDebit, 2)} / بستانکار: ${formatDecimal(totalCredit, 2)}) و نمی‌تواند قطعی شود.`
      );
    }

    const [posted] = await tx
      .update(journalEntries)
      .set({
        status: "POSTED",
        totalDebit: formatDecimal(totalDebit, 2),
        totalCredit: formatDecimal(totalCredit, 2),
        postedBy: params.actorUserId,
        postedAt: new Date(),
        version: entry.version + 1,
        syncSeq: Date.now(),
        updatedAt: new Date(),
      })
      .where(eq(journalEntries.id, entry.id))
      .returning();

    return posted;
  });

  await recordAuditLog({
    organizationId: params.organizationId,
    actorUserId: params.actorUserId,
    actorEmail: params.actorEmail,
    scope: "ORGANIZATION",
    action: "JOURNAL_POSTED",
    entityType: "JOURNAL_ENTRY",
    entityId: updated.id,
    ipAddress: params.ipAddress,
    metadata: { entryNumber: updated.entryNumber, totalDebit: updated.totalDebit },
  });

  return updated;
}

/**
 * Posted vouchers are strictly immutable. Corrections occur ONLY by issuing a linked Reversal Entry.
 */
export async function reverseJournalEntry(params: {
  organizationId: string;
  journalEntryId: string;
  reason?: string;
  actorUserId: string;
  actorEmail: string;
  ipAddress?: string | null;
}) {
  const result = await withTenantTransaction(params.organizationId, async (tx) => {
    const [original] = await tx
      .select()
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.id, params.journalEntryId),
          eq(journalEntries.organizationId, params.organizationId)
        )
      )
      .limit(1);

    if (!original) {
      throw new ApiError(404, "JOURNAL_NOT_FOUND", "سند حسابداری یافت نشد.");
    }
    if (original.status !== "POSTED") {
      throw new ApiError(
        409,
        "ONLY_POSTED_REVERSIBLE",
        "فقط اسناد قطعی (POSTED) قابل صدور سند معکوس هستند."
      );
    }

    const origLines = await tx
      .select()
      .from(journalEntryLines)
      .where(eq(journalEntryLines.journalEntryId, original.id));

    const reversedLines: JournalLineInput[] = origLines.map((l) => ({
      accountId: l.accountId,
      costCenterId: l.costCenterId,
      contactId: l.contactId,
      debit: l.credit, // swap!
      credit: l.debit, // swap!
      description: `معکوس سند #${original.entryNumber}: ${l.description ?? ""}`,
    }));

    const reversal = await createJournalEntryTx(tx, {
      organizationId: params.organizationId,
      actorUserId: params.actorUserId,
      actorEmail: params.actorEmail,
      fiscalYearId: original.fiscalYearId,
      entryDate: new Date().toISOString().slice(0, 10),
      description: `سند معکوس بابت اصلاح سند شماره ${original.entryNumber}${params.reason ? ` — ${params.reason}` : ""}`,
      referenceType: "REVERSAL",
      referenceId: original.id,
      postImmediately: true,
      lines: reversedLines,
    });

    await tx
      .update(journalEntries)
      .set({
        reversedEntryId: original.id,
      })
      .where(eq(journalEntries.id, reversal.entry.id));

    const [markedOrig] = await tx
      .update(journalEntries)
      .set({
        status: "REVERSED",
        version: original.version + 1,
        syncSeq: Date.now(),
        updatedAt: new Date(),
      })
      .where(eq(journalEntries.id, original.id))
      .returning();

    return { original: markedOrig, reversal: reversal.entry, lines: reversal.lines };
  });

  await recordAuditLog({
    organizationId: params.organizationId,
    actorUserId: params.actorUserId,
    actorEmail: params.actorEmail,
    scope: "ORGANIZATION",
    action: "JOURNAL_REVERSED",
    entityType: "JOURNAL_ENTRY",
    entityId: result.original.id,
    ipAddress: params.ipAddress,
    metadata: {
      originalEntryNumber: result.original.entryNumber,
      reversalEntryId: result.reversal.id,
      reversalEntryNumber: result.reversal.entryNumber,
      reason: params.reason ?? null,
    },
  });

  return result;
}

/**
 * Reconstructs Trial Balance, Account Balances, and Profit & Loss strictly from Ledger lines.
 */
export async function buildAccountingReports(
  organizationId: string,
  fiscalYearId?: string | null
) {
  const orgAccounts = await db
    .select()
    .from(accounts)
    .where(eq(accounts.organizationId, organizationId))
    .orderBy(accounts.code);

  const whereConds = [
    eq(journalEntries.organizationId, organizationId),
    inArray(journalEntries.status, ["POSTED", "REVERSED"]),
  ];
  if (fiscalYearId) {
    whereConds.push(eq(journalEntries.fiscalYearId, fiscalYearId));
  }

  const postedLines = await db
    .select({
      accountId: journalEntryLines.accountId,
      debit: journalEntryLines.debit,
      credit: journalEntryLines.credit,
      entryNumber: journalEntries.entryNumber,
      entryDate: journalEntries.entryDate,
      entryDescription: journalEntries.description,
      lineDescription: journalEntryLines.description,
      status: journalEntries.status,
      referenceType: journalEntries.referenceType,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(and(...whereConds))
    .orderBy(desc(journalEntries.entryDate), desc(journalEntries.entryNumber));

  const totalsByAccount = new Map<string, { debit: bigint; credit: bigint; count: number }>();

  for (const line of postedLines) {
    const cur = totalsByAccount.get(line.accountId) ?? {
      debit: BigInt(0),
      credit: BigInt(0),
      count: 0,
    };
    cur.debit = addDec(cur.debit, line.debit);
    cur.credit = addDec(cur.credit, line.credit);
    cur.count += 1;
    totalsByAccount.set(line.accountId, cur);
  }

  let grandDebit = BigInt(0);
  let grandCredit = BigInt(0);
  let totalRevenue = BigInt(0);
  let totalExpense = BigInt(0);
  let totalAssets = BigInt(0);
  let totalLiabilities = BigInt(0);
  let totalEquity = BigInt(0);

  const trialBalance = orgAccounts.map((acc) => {
    const agg = totalsByAccount.get(acc.id) ?? {
      debit: BigInt(0),
      credit: BigInt(0),
      count: 0,
    };
    grandDebit += agg.debit;
    grandCredit += agg.credit;

    const net =
      acc.normalBalance === "DEBIT"
        ? subDec(agg.debit, agg.credit)
        : subDec(agg.credit, agg.debit);

    if (acc.accountType === "REVENUE") totalRevenue += net;
    if (acc.accountType === "EXPENSE") totalExpense += net;
    if (acc.accountType === "ASSET") totalAssets += net;
    if (acc.accountType === "LIABILITY") totalLiabilities += net;
    if (acc.accountType === "EQUITY") totalEquity += net;

    return {
      accountId: acc.id,
      code: acc.code,
      name: acc.name,
      accountType: acc.accountType,
      normalBalance: acc.normalBalance,
      systemRole: acc.systemRole,
      totalDebit: formatDecimal(agg.debit, 2),
      totalCredit: formatDecimal(agg.credit, 2),
      netBalance: formatDecimal(net, 2),
      entriesCount: agg.count,
    };
  });

  const netProfit = subDec(totalRevenue, totalExpense);

  return {
    isTrialBalanced: eqDec(grandDebit, grandCredit),
    grandTotalDebit: formatDecimal(grandDebit, 2),
    grandTotalCredit: formatDecimal(grandCredit, 2),
    trialBalance,
    profitAndLoss: {
      totalRevenue: formatDecimal(totalRevenue, 2),
      totalExpense: formatDecimal(totalExpense, 2),
      netProfit: formatDecimal(netProfit, 2),
    },
    balanceSheetSummary: {
      totalAssets: formatDecimal(totalAssets, 2),
      totalLiabilities: formatDecimal(totalLiabilities, 2),
      totalEquity: formatDecimal(addDec(totalEquity, netProfit), 2),
    },
    recentLedgerMovements: postedLines.slice(0, 40),
  };
}

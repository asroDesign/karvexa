import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  accountGroups,
  accountingPeriods,
  accounts,
  contacts,
  costCenters,
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

function assertCanonicalDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ApiError(422, "INVALID_ENTRY_DATE", "تاریخ سند باید به قالب میلادی YYYY-MM-DD باشد.");
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ApiError(422, "INVALID_ENTRY_DATE", "تاریخ سند معتبر نیست.");
  }
}

async function lockAccountingPeriod(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  organizationId: string,
  fiscalYearId: string,
  accountingPeriodId: string
) {
  await tx.execute(sql`
    SELECT id FROM accounting_periods
    WHERE id = ${accountingPeriodId}
      AND organization_id = ${organizationId}
      AND fiscal_year_id = ${fiscalYearId}
    FOR UPDATE
  `);
  const [period] = await tx
    .select()
    .from(accountingPeriods)
    .where(
      and(
        eq(accountingPeriods.id, accountingPeriodId),
        eq(accountingPeriods.organizationId, organizationId),
        eq(accountingPeriods.fiscalYearId, fiscalYearId)
      )
    )
    .limit(1);
  return period;
}

async function lockOrganizationAccounts(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  organizationId: string,
  accountIds: string[]
) {
  for (const accountId of [...new Set(accountIds)].sort()) {
    await tx.execute(sql`
      SELECT id FROM accounts
      WHERE id = ${accountId} AND organization_id = ${organizationId}
      FOR UPDATE
    `);
  }
}

async function assertPostingPeriodOpen(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  params: {
    organizationId: string;
    fiscalYearId: string;
    accountingPeriodId: string;
    entryDate: string;
    allowClosedPeriod?: boolean;
  }
) {
  const period = await lockAccountingPeriod(
    tx,
    params.organizationId,
    params.fiscalYearId,
    params.accountingPeriodId
  );
  if (!period) {
    throw new ApiError(404, "ACCOUNTING_PERIOD_NOT_FOUND", "دوره مالی معتبر یافت نشد.");
  }
  if (params.entryDate < period.startDate || params.entryDate > period.endDate) {
    throw new ApiError(
      422,
      "ENTRY_DATE_OUTSIDE_PERIOD",
      `تاریخ سند باید در محدوده دوره «${period.name}» (${period.startDate} تا ${period.endDate}) باشد.`
    );
  }
  if (params.allowClosedPeriod) return period;

  if (period.status === "CLOSED") {
    throw new ApiError(409, "ACCOUNTING_PERIOD_CLOSED", `دوره مالی «${period.name}» بسته شده است.`);
  }
  if (period.status === "LOCKED" && !period.lockedUntil) {
    throw new ApiError(409, "ACCOUNTING_PERIOD_LOCKED", `دوره مالی «${period.name}» قفل شده است.`);
  }

  // A lock date is a cutoff for the organization, matching the Android guard.
  // This prevents posting old dated entries through a different still-open period.
  const [cutoff] = await tx
    .select({ lockedUntil: sql<string | null>`MAX(${accountingPeriods.lockedUntil})` })
    .from(accountingPeriods)
    .where(
      and(
        eq(accountingPeriods.organizationId, params.organizationId),
        sql`${accountingPeriods.lockedUntil} IS NOT NULL`
      )
    );
  if (cutoff?.lockedUntil && params.entryDate <= cutoff.lockedUntil) {
    throw new ApiError(
      409,
      "ACCOUNTING_PERIOD_LOCKED",
      `ثبت سند تا تاریخ ${cutoff.lockedUntil} قفل شده است.`
    );
  }
  return period;
}

/** Shared guard for inventory movements that do not create a journal themselves. */
export async function assertAccountingDateWritableTx(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  organizationId: string,
  entryDate: string
) {
  assertCanonicalDate(entryDate);
  const [candidate] = await tx
    .select()
    .from(fiscalYears)
    .where(
      and(
        eq(fiscalYears.organizationId, organizationId),
        lte(fiscalYears.startDate, entryDate),
        gte(fiscalYears.endDate, entryDate)
      )
    )
    .orderBy(desc(fiscalYears.startDate))
    .limit(1);
  if (!candidate) {
    throw new ApiError(409, "FISCAL_YEAR_NOT_FOUND_FOR_DATE", `برای تاریخ ${entryDate} سال مالی تعریف نشده است.`);
  }

  await tx.execute(sql`
    SELECT id FROM fiscal_years
    WHERE id = ${candidate.id} AND organization_id = ${organizationId}
    FOR UPDATE
  `);
  const [fy] = await tx
    .select()
    .from(fiscalYears)
    .where(and(eq(fiscalYears.id, candidate.id), eq(fiscalYears.organizationId, organizationId)))
    .limit(1);
  if (!fy || !["OPEN", "REOPENED"].includes(fy.status)) {
    throw new ApiError(409, "FISCAL_YEAR_NOT_OPEN", "سال مالی این تاریخ بسته یا در وضعیت ثبت‌ناپذیر است.");
  }

  const periods = await tx
    .select()
    .from(accountingPeriods)
    .where(
      and(
        eq(accountingPeriods.organizationId, organizationId),
        eq(accountingPeriods.fiscalYearId, fy.id),
        lte(accountingPeriods.startDate, entryDate),
        gte(accountingPeriods.endDate, entryDate)
      )
    )
    .orderBy(accountingPeriods.periodNumber);
  const period = periods[0];
  if (!period) {
    throw new ApiError(409, "ACCOUNTING_PERIOD_NOT_FOUND_FOR_DATE", `برای تاریخ ${entryDate} دورهٔ حسابداری تعریف نشده است.`);
  }
  await assertPostingPeriodOpen(tx, {
    organizationId,
    fiscalYearId: fy.id,
    accountingPeriodId: period.id,
    entryDate,
  });
  return { fiscalYear: fy, period };
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

export async function createOrganizationAccount(params: {
  organizationId: string;
  actorUserId: string;
  actorEmail: string;
  ipAddress?: string | null;
  groupId?: string;
  parentId?: string | null;
  accountLevel?: number;
  code: string;
  name: string;
  description?: string | null;
  accountType: string;
  normalBalance: string;
  isPostable: boolean;
}) {
  const created = await withTenantTransaction(params.organizationId, async (tx) => {
    let groupId = params.groupId;
    let accountLevel = params.accountLevel;
    if (params.parentId) {
      const [parent] = await tx
        .select()
        .from(accounts)
        .where(
          and(
            eq(accounts.id, params.parentId),
            eq(accounts.organizationId, params.organizationId)
          )
        )
        .limit(1);
      if (!parent) throw new ApiError(404, "PARENT_ACCOUNT_NOT_FOUND", "حساب والد متعلق به این سازمان یافت نشد.");
      if (!parent.isActive || parent.accountStatus !== "ACTIVE") {
        throw new ApiError(409, "PARENT_ACCOUNT_INACTIVE", "زیرحساب را نمی‌توان زیر حساب غیرفعال یا بسته ایجاد کرد.");
      }
      if (parent.isPostable || parent.accountLevel >= 4) {
        throw new ApiError(409, "PARENT_ACCOUNT_NOT_GROUP", "حساب انتخاب‌شده اجازهٔ داشتن زیرحساب ندارد.");
      }
      if (params.accountType !== parent.accountType || params.normalBalance !== parent.normalBalance) {
        throw new ApiError(422, "ACCOUNT_PARENT_TYPE_MISMATCH", "نوع و ماهیت حساب باید با حساب والد یکسان باشد.");
      }
      if (groupId && groupId !== parent.groupId) {
        throw new ApiError(422, "ACCOUNT_GROUP_PARENT_MISMATCH", "گروه حساب باید با گروه حساب والد یکسان باشد.");
      }
      groupId = parent.groupId;
      const expectedLevel = parent.accountLevel + 1;
      if (accountLevel !== undefined && accountLevel !== expectedLevel) {
        throw new ApiError(422, "ACCOUNT_LEVEL_PARENT_MISMATCH", `سطح حساب باید ${expectedLevel} باشد.`);
      }
      accountLevel = expectedLevel;
      if (!params.code.trim().startsWith(parent.code) || params.code.trim().length <= parent.code.length) {
        throw new ApiError(422, "ACCOUNT_CODE_PARENT_MISMATCH", "کد زیرحساب باید با کد حساب والد آغاز شود و ادامه داشته باشد.");
      }
    } else {
      accountLevel ??= 2;
      if (accountLevel !== 2) {
        throw new ApiError(422, "ACCOUNT_PARENT_REQUIRED", "برای ساخت حساب سطح ۳ یا ۴، انتخاب حساب والد الزامی است.");
      }
      if (!groupId) throw new ApiError(422, "ACCOUNT_GROUP_REQUIRED", "گروه حساب برای حساب سطح کل الزامی است.");
    }

    const [group] = await tx
      .select()
      .from(accountGroups)
      .where(
        and(
          eq(accountGroups.id, groupId!),
          eq(accountGroups.organizationId, params.organizationId)
        )
      )
      .limit(1);
    if (!group) throw new ApiError(404, "ACCOUNT_GROUP_NOT_FOUND", "گروه حساب متعلق به این سازمان یافت نشد.");
    if (group.nature !== params.accountType) {
      throw new ApiError(422, "ACCOUNT_GROUP_TYPE_MISMATCH", "نوع حساب با ماهیت گروه حساب انتخاب‌شده سازگار نیست.");
    }

    const [account] = await tx
      .insert(accounts)
      .values({
        organizationId: params.organizationId,
        groupId: group.id,
        parentId: params.parentId ?? null,
        accountLevel,
        code: params.code.trim(),
        name: params.name.trim(),
        description: params.description ?? null,
        accountType: params.accountType,
        normalBalance: params.normalBalance,
        isPostable: params.isPostable,
        accountStatus: "ACTIVE",
        isActive: true,
      })
      .returning();
    return account;
  });

  await recordAuditLog({
    organizationId: params.organizationId,
    actorUserId: params.actorUserId,
    actorEmail: params.actorEmail,
    scope: "ORGANIZATION",
    action: "ACCOUNT_CREATED",
    entityType: "ACCOUNT",
    entityId: created.id,
    ipAddress: params.ipAddress,
    metadata: {
      code: created.code,
      accountLevel: created.accountLevel,
      parentId: created.parentId,
      groupId: created.groupId,
      isPostable: created.isPostable,
    },
  });
  return created;
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

  // Serialize journal creation with fiscal close/reopen and re-read the year after waiting.
  await tx.execute(sql`
    SELECT id FROM fiscal_years
    WHERE id = ${fy.id} AND organization_id = ${input.organizationId}
    FOR UPDATE
  `);
  [fy] = await tx
    .select()
    .from(fiscalYears)
    .where(
      and(
        eq(fiscalYears.id, fy.id),
        eq(fiscalYears.organizationId, input.organizationId)
      )
    )
    .limit(1);
  if (!fy) {
    throw new ApiError(404, "FISCAL_YEAR_NOT_FOUND", "سال مالی برای سازمان یافت نشد.");
  }
  assertCanonicalDate(input.entryDate);
  if (input.entryDate < fy.startDate || input.entryDate > fy.endDate) {
    throw new ApiError(
      422,
      "ENTRY_DATE_OUTSIDE_FISCAL_YEAR",
      `تاریخ سند باید در محدوده سال مالی «${fy.name}» (${fy.startDate} تا ${fy.endDate}) باشد.`
    );
  }
  if (!input.allowClosedPeriod && !["OPEN", "REOPENED"].includes(fy.status)) {
    throw new ApiError(
      409,
      "FISCAL_YEAR_NOT_OPEN",
      `سال مالی «${fy.name}» در وضعیت ${fy.status} است و امکان ثبت سند ندارد.`
    );
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
    period = periods.find(
      (p) => input.entryDate >= p.startDate && input.entryDate <= p.endDate
    );
  }

  if (!period) {
    throw new ApiError(404, "ACCOUNTING_PERIOD_NOT_FOUND", "دوره مالی معتبر یافت نشد.");
  }
  await assertPostingPeriodOpen(tx, {
    organizationId: input.organizationId,
    fiscalYearId: fy.id,
    accountingPeriodId: period.id,
    entryDate: input.entryDate,
    allowClosedPeriod: input.allowClosedPeriod,
  });
  // Verify every account belongs strictly to this organization and is postable
  const uniqueAccIds = [...new Set(input.lines.map((l) => l.accountId))];
  await lockOrganizationAccounts(tx, input.organizationId, uniqueAccIds);
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
      (a) =>
        !a.isActive ||
        a.accountStatus === "CLOSED" ||
        a.accountStatus === "PENDING_CLOSURE" ||
        a.accountStatus === "TEMPORARILY_SUSPENDED"
    );
    if (closedAcc) {
      throw new ApiError(
        409,
        "ACCOUNT_CLOSED",
        `حساب «${closedAcc.name}» (${closedAcc.code}) بسته یا غیرفعال است و پذیرش آرتیکل جدید در آن مجاز نیست.`
      );
    }
  }

  const uniqueCostCenterIds = [...new Set(input.lines.map((line) => line.costCenterId).filter((id): id is string => Boolean(id)))];
  if (uniqueCostCenterIds.length > 0) {
    const validCostCenters = await tx
      .select({ id: costCenters.id })
      .from(costCenters)
      .where(
        and(
          eq(costCenters.organizationId, input.organizationId),
          inArray(costCenters.id, uniqueCostCenterIds)
        )
      );
    if (validCostCenters.length !== uniqueCostCenterIds.length) {
      throw new ApiError(403, "COST_CENTER_NOT_FOUND", "یکی یا چند مرکز هزینه متعلق به این سازمان نیستند.");
    }
  }

  const uniqueContactIds = [...new Set(input.lines.map((line) => line.contactId).filter((id): id is string => Boolean(id)))];
  if (uniqueContactIds.length > 0) {
    const validContacts = await tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        and(
          eq(contacts.organizationId, input.organizationId),
          inArray(contacts.id, uniqueContactIds)
        )
      );
    if (validContacts.length !== uniqueContactIds.length) {
      throw new ApiError(403, "CONTACT_NOT_FOUND", "یکی یا چند شخص/طرف حساب متعلق به این سازمان نیستند.");
    }
  }

  // The fiscal year row is already locked above; use it to allocate a race-free sequence.
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
    await tx.execute(sql`
      SELECT id FROM journal_entries
      WHERE id = ${params.journalEntryId}
        AND organization_id = ${params.organizationId}
      FOR UPDATE
    `);
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

    await tx.execute(sql`
      SELECT id FROM fiscal_years
      WHERE id = ${entry.fiscalYearId}
        AND organization_id = ${params.organizationId}
      FOR UPDATE
    `);
    const [fy] = await tx
      .select()
      .from(fiscalYears)
      .where(
        and(
          eq(fiscalYears.id, entry.fiscalYearId),
          eq(fiscalYears.organizationId, params.organizationId)
        )
      )
      .limit(1);
    if (!fy || !["OPEN", "REOPENED"].includes(fy.status)) {
      throw new ApiError(
        409,
        "FISCAL_YEAR_NOT_OPEN",
        "سال مالی مربوط به این سند باز نیست و امکان قطعی‌کردن آن وجود ندارد."
      );
    }
    assertCanonicalDate(entry.entryDate);
    if (entry.entryDate < fy.startDate || entry.entryDate > fy.endDate) {
      throw new ApiError(409, "ENTRY_DATE_OUTSIDE_FISCAL_YEAR", "تاریخ سند خارج از محدوده سال مالی آن است.");
    }
    await assertPostingPeriodOpen(tx, {
      organizationId: params.organizationId,
      fiscalYearId: fy.id,
      accountingPeriodId: entry.accountingPeriodId,
      entryDate: entry.entryDate,
    });

    const lines = await tx
      .select()
      .from(journalEntryLines)
      .where(
        and(
          eq(journalEntryLines.journalEntryId, entry.id),
          eq(journalEntryLines.organizationId, params.organizationId)
        )
      );

    const lineAccountIds = [...new Set(lines.map((line) => line.accountId))];
    await lockOrganizationAccounts(tx, params.organizationId, lineAccountIds);
    const postingAccounts = await tx
      .select()
      .from(accounts)
      .where(
        and(
          eq(accounts.organizationId, params.organizationId),
          inArray(accounts.id, lineAccountIds)
        )
      );
    if (postingAccounts.length !== lineAccountIds.length) {
      throw new ApiError(403, "ACCOUNT_NOT_FOUND", "حساب یکی از سطرهای سند دیگر متعلق به این سازمان نیست.");
    }
    const invalidAccount = postingAccounts.find(
      (account) =>
        !account.isPostable ||
        !account.isActive ||
        ["CLOSED", "PENDING_CLOSURE", "TEMPORARILY_SUSPENDED"].includes(account.accountStatus)
    );
    if (invalidAccount) {
      throw new ApiError(
        409,
        "ACCOUNT_NOT_POSTABLE",
        `حساب «${invalidAccount.name}» (${invalidAccount.code}) دیگر برای ثبت سند فعال و قابل آرتیکل‌گذاری نیست.`
      );
    }

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
      .where(
        and(
          eq(journalEntries.id, entry.id),
          eq(journalEntries.status, "DRAFT"),
          eq(journalEntries.version, entry.version)
        )
      )
      .returning();
    if (!posted) {
      throw new ApiError(409, "ACCOUNTING_ENTRY_CHANGED", "سند هم‌زمان توسط کاربر دیگری تغییر کرده است؛ دوباره بارگذاری کنید.");
    }

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
export async function reverseJournalEntryTx(
  tx: Parameters<Parameters<typeof withTenantTransaction>[1]>[0],
  params: {
  organizationId: string;
  journalEntryId: string;
  reason?: string;
  reversalDate?: string;
  accountingPeriodId?: string;
  actorUserId: string;
  actorEmail: string;
  }
) {
  await tx.execute(sql`
    SELECT id FROM journal_entries
    WHERE id = ${params.journalEntryId}
      AND organization_id = ${params.organizationId}
    FOR UPDATE
  `);
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
    debit: l.credit,
    credit: l.debit,
    description: `معکوس سند #${original.entryNumber}: ${l.description ?? ""}`,
  }));

  const reversal = await createJournalEntryTx(tx, {
    organizationId: params.organizationId,
    actorUserId: params.actorUserId,
    actorEmail: params.actorEmail,
    fiscalYearId: original.fiscalYearId,
    accountingPeriodId: params.accountingPeriodId ?? original.accountingPeriodId,
    entryDate: params.reversalDate ?? original.entryDate,
    description: `سند معکوس بابت اصلاح سند شماره ${original.entryNumber}${params.reason ? ` — ${params.reason}` : ""}`,
    referenceType: "REVERSAL",
    referenceId: original.id,
    postImmediately: true,
    allowInactiveAccounts: true,
    lines: reversedLines,
  });

  const [markedOrig] = await tx
    .update(journalEntries)
    .set({
      reversedEntryId: reversal.entry.id,
      status: "REVERSED",
      version: original.version + 1,
      syncSeq: Date.now(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(journalEntries.id, original.id),
        eq(journalEntries.organizationId, params.organizationId),
        eq(journalEntries.status, "POSTED"),
        eq(journalEntries.version, original.version)
      )
    )
    .returning();
  if (!markedOrig) {
    throw new ApiError(409, "ACCOUNTING_ENTRY_CHANGED", "سند هم‌زمان تغییر کرده است و برگشت انجام نشد.");
  }

  return { original: markedOrig, reversal: reversal.entry, lines: reversal.lines };
}

export async function reverseJournalEntry(params: {
  organizationId: string;
  journalEntryId: string;
  reason?: string;
  reversalDate?: string;
  accountingPeriodId?: string;
  actorUserId: string;
  actorEmail: string;
  ipAddress?: string | null;
}) {
  const result = await withTenantTransaction(params.organizationId, (tx) => reverseJournalEntryTx(tx, params));

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

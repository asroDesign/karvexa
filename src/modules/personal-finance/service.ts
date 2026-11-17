import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  accounts,
  financialAccounts,
  ownerContributions,
  ownerWithdrawals,
  personalAccounts,
  personalExpenseCategories,
  personalFinanceProfiles,
  personalRecurringTransactions,
  personalTransactions,
} from "@/db/schema";
import { ensurePrompt05OrgDefaults } from "@/db/seed-prompt05";
import { recordAuditLog } from "@/lib/audit";
import { addDec, formatDecimal, isPositiveDec, parseDecimal, subDec } from "@/lib/decimal";
import { ApiError } from "@/lib/errors";
import { withTenantTransaction } from "@/lib/tenant";
import { createJournalEntryTx } from "@/modules/accounting/service";

export async function getOrCreatePersonalProfile(
  organizationId: string,
  ownerUserId: string
) {
  await ensurePrompt05OrgDefaults(organizationId);
  let [profile] = await db
    .select()
    .from(personalFinanceProfiles)
    .where(
      and(
        eq(personalFinanceProfiles.organizationId, organizationId),
        eq(personalFinanceProfiles.ownerUserId, ownerUserId)
      )
    )
    .limit(1);

  if (!profile) {
    [profile] = await db
      .insert(personalFinanceProfiles)
      .values({
        organizationId,
        ownerUserId,
        currency: "IRR",
        monthlyBudgetLimit: "50000000.00",
      })
      .returning();

    await db.insert(personalAccounts).values([
      {
        organizationId,
        profileId: profile.id,
        ownerUserId,
        name: "کیف پول نقدی شخصی",
        accountType: "CASH",
        balance: "0.00",
      },
      {
        organizationId,
        profileId: profile.id,
        ownerUserId,
        name: "حساب بانکی شخصی",
        accountType: "BANK",
        bankName: "بانک سامان",
        balance: "0.00",
      },
    ]);
  }
  return profile;
}

async function resolveOwnerDrawingsAccountTx(
  tx: Parameters<Parameters<typeof withTenantTransaction>[1]>[0],
  organizationId: string
) {
  const [acc] = await tx
    .select()
    .from(accounts)
    .where(
      and(
        eq(accounts.organizationId, organizationId),
        eq(accounts.systemRole, "OWNER_DRAWINGS")
      )
    )
    .limit(1);
  if (!acc) {
    throw new ApiError(
      422,
      "OWNER_DRAWINGS_ACCOUNT_MISSING",
      "حساب سیستمی «برداشت مالک / جاری شرکا» (کد 3201) یافت نشد."
    );
  }
  return acc;
}

async function resolveBusinessFinGlAccountTx(
  tx: Parameters<Parameters<typeof withTenantTransaction>[1]>[0],
  organizationId: string,
  finAcc: typeof financialAccounts.$inferSelect
) {
  if (finAcc.accountId) return finAcc.accountId;
  const role = finAcc.accountType === "CASHBOX" ? "CASH" : "BANK";
  const [acc] = await tx
    .select()
    .from(accounts)
    .where(and(eq(accounts.organizationId, organizationId), eq(accounts.systemRole, role)))
    .limit(1);
  if (!acc) throw new ApiError(422, "SYSTEM_ACCOUNT_MISSING", `حساب سیستمی ${role} یافت نشد.`);
  return acc.id;
}

/**
 * Master Prompt 05 §3.5 & Scenario A:
 * Owner withdraws money from business cash/bank.
 * Journal: DR Owner Withdrawals (Equity/Drawings 3201) / CR Business Cash or Bank
 * NEVER creates a business operating expense!
 */
export async function createOwnerWithdrawal(params: {
  organizationId: string;
  ownerUserId: string;
  actorEmail: string;
  ipAddress?: string | null;
  businessFinancialAccountId: string;
  personalAccountId?: string | null;
  amount: string;
  withdrawalDate: string;
  notes?: string;
  createPersonalTx?: boolean;
  idempotencyKey?: string | null;
}) {
  if (!isPositiveDec(parseDecimal(params.amount))) {
    throw new ApiError(422, "AMOUNT_INVALID", "مبلغ برداشت مالک باید بزرگ‌تر از صفر باشد.");
  }

  const profile = await getOrCreatePersonalProfile(params.organizationId, params.ownerUserId);

  const result = await withTenantTransaction(params.organizationId, async (tx) => {
    const [bizAcc] = await tx
      .select()
      .from(financialAccounts)
      .where(
        and(
          eq(financialAccounts.id, params.businessFinancialAccountId),
          eq(financialAccounts.organizationId, params.organizationId)
        )
      )
      .limit(1);
    if (!bizAcc) {
      throw new ApiError(404, "TREASURY_ACCOUNT_NOT_FOUND", "حساب خزانه کسب‌وکار یافت نشد.");
    }

    const drawingsAcc = await resolveOwnerDrawingsAccountTx(tx, params.organizationId);
    const bizGlAccId = await resolveBusinessFinGlAccountTx(tx, params.organizationId, bizAcc);

    // 1. Reduce business cash/bank balance
    const nextBizBalance = subDec(bizAcc.balance, params.amount);
    await tx
      .update(financialAccounts)
      .set({ balance: formatDecimal(nextBizBalance, 2) })
      .where(eq(financialAccounts.id, bizAcc.id));

    // 2. Post balanced Double-Entry Journal: DR Owner Drawings / CR Cash or Bank
    const journalRes = await createJournalEntryTx(tx, {
      organizationId: params.organizationId,
      actorUserId: params.ownerUserId,
      actorEmail: params.actorEmail,
      entryDate: params.withdrawalDate,
      description: `برداشت شخصی مالک از ${bizAcc.name}${params.notes ? ` — ${params.notes}` : ""}`,
      referenceType: "OWNER_WITHDRAWAL",
      postImmediately: true,
      lines: [
        {
          accountId: drawingsAcc.id,
          debit: params.amount,
          credit: "0.00",
          description: "افزایش حساب برداشت مالک (خارج از هزینه‌های عملیاتی)",
        },
        {
          accountId: bizGlAccId,
          debit: "0.00",
          credit: params.amount,
          description: `کاهش موجودی ${bizAcc.name} بابت برداشت مالک`,
        },
      ],
    });

    // 3. Create OwnerWithdrawal record
    const [withdrawal] = await tx
      .insert(ownerWithdrawals)
      .values({
        organizationId: params.organizationId,
        ownerUserId: params.ownerUserId,
        businessFinancialAccountId: bizAcc.id,
        amount: params.amount,
        currency: bizAcc.currency,
        withdrawalDate: params.withdrawalDate,
        journalEntryId: journalRes.entry.id,
        idempotencyKey: params.idempotencyKey ?? null,
        status: "CONFIRMED",
        notes: params.notes ?? null,
        createdBy: params.ownerUserId,
      })
      .returning();

    // 4. Credit personal account & optionally create linked personal ledger entry
    let personalTx = null;
    if (params.createPersonalTx !== false) {
      let targetPersonalAcc = null;
      if (params.personalAccountId) {
        [targetPersonalAcc] = await tx
          .select()
          .from(personalAccounts)
          .where(
            and(
              eq(personalAccounts.id, params.personalAccountId),
              eq(personalAccounts.organizationId, params.organizationId),
              eq(personalAccounts.ownerUserId, params.ownerUserId)
            )
          )
          .limit(1);
      } else {
        [targetPersonalAcc] = await tx
          .select()
          .from(personalAccounts)
          .where(
            and(
              eq(personalAccounts.organizationId, params.organizationId),
              eq(personalAccounts.ownerUserId, params.ownerUserId)
            )
          )
          .orderBy(personalAccounts.createdAt, personalAccounts.id)
          .limit(1);
      }

      if (targetPersonalAcc) {
        await tx
          .update(personalAccounts)
          .set({ balance: formatDecimal(addDec(targetPersonalAcc.balance, params.amount), 2) })
          .where(eq(personalAccounts.id, targetPersonalAcc.id));
      }

      [personalTx] = await tx
        .insert(personalTransactions)
        .values({
          organizationId: params.organizationId,
          ownerUserId: params.ownerUserId,
          profileId: profile.id,
          personalAccountId: targetPersonalAcc?.id ?? null,
          linkedWithdrawalId: withdrawal.id,
          txType: "WITHDRAWAL_FROM_BUSINESS",
          paymentSource: bizAcc.accountType === "CASHBOX" ? "BUSINESS_CASH" : "BUSINESS_BANK",
          title: `برداشت از کسب‌وکار (${bizAcc.name})`,
          amount: params.amount,
          currency: bizAcc.currency,
          txDate: params.withdrawalDate,
          notes: params.notes ?? null,
          status: "CONFIRMED",
        })
        .returning();
    }

    return {
      withdrawal,
      journalEntry: journalRes.entry,
      personalTransaction: personalTx,
      businessAccountNewBalance: formatDecimal(nextBizBalance, 2),
    };
  });

  await recordAuditLog({
    organizationId: params.organizationId,
    actorUserId: params.ownerUserId,
    actorEmail: params.actorEmail,
    scope: "ORGANIZATION",
    action: "OWNER_WITHDRAWAL_POSTED",
    entityType: "OWNER_WITHDRAWAL",
    entityId: result.withdrawal.id,
    ipAddress: params.ipAddress,
    metadata: {
      amount: params.amount,
      journalEntryId: result.journalEntry.id,
    },
  });

  return result;
}

/**
 * Master Prompt 07 §7 — Unified Personal Transfer Endpoint (`POST /api/v1/personal/transfers`)
 * Automatically classifies transfer direction without creating duplicate records:
 * 1. Business -> Personal: Owner Withdrawal (`DR Drawings 3201 / CR Cash-Bank`, zero OpEx)
 * 2. Personal -> Business: Owner Contribution (`DR Cash-Bank / CR Drawings 3201`, zero Sales Revenue)
 * 3. Personal -> Personal: Personal Ledger internal transfer (zero business journal)
 */
export async function executePersonalTransfer(params: {
  organizationId: string;
  ownerUserId: string;
  actorEmail: string;
  ipAddress?: string | null;
  deviceId?: string | null;
  fromAccountId: string;
  toAccountId: string;
  amount: string;
  description?: string;
  idempotencyKey?: string | null;
}) {
  if (params.fromAccountId === params.toAccountId) {
    throw new ApiError(422, "SAME_ACCOUNT_TRANSFER", "حساب مبدأ و حساب مقصد نمی‌توانند یکسان باشند.");
  }
  const amountDec = parseDecimal(params.amount);
  if (!isPositiveDec(amountDec)) {
    throw new ApiError(422, "AMOUNT_INVALID", "مبلغ انتقال باید بزرگ‌تر از صفر باشد.");
  }

  const profile = await getOrCreatePersonalProfile(params.organizationId, params.ownerUserId);

  const [fromBiz, toBiz, fromPersonal, toPersonal] = await Promise.all([
    db
      .select()
      .from(financialAccounts)
      .where(and(eq(financialAccounts.id, params.fromAccountId), eq(financialAccounts.organizationId, params.organizationId)))
      .limit(1)
      .then((r) => r[0] ?? null),
    db
      .select()
      .from(financialAccounts)
      .where(and(eq(financialAccounts.id, params.toAccountId), eq(financialAccounts.organizationId, params.organizationId)))
      .limit(1)
      .then((r) => r[0] ?? null),
    db
      .select()
      .from(personalAccounts)
      .where(
        and(
          eq(personalAccounts.id, params.fromAccountId),
          eq(personalAccounts.organizationId, params.organizationId),
          eq(personalAccounts.ownerUserId, params.ownerUserId)
        )
      )
      .limit(1)
      .then((r) => r[0] ?? null),
    db
      .select()
      .from(personalAccounts)
      .where(
        and(
          eq(personalAccounts.id, params.toAccountId),
          eq(personalAccounts.organizationId, params.organizationId),
          eq(personalAccounts.ownerUserId, params.ownerUserId)
        )
      )
      .limit(1)
      .then((r) => r[0] ?? null),
  ]);

  const today = new Date().toISOString().slice(0, 10);

  // Case 1: Business -> Personal (Owner Withdrawal)
  if (fromBiz && toPersonal) {
    if (parseDecimal(fromBiz.balance) < amountDec) {
      throw new ApiError(
        409,
        "INSUFFICIENT_SOURCE_BALANCE",
        `موجودی حساب مبدأ (${fromBiz.name}: ${fromBiz.balance}) برای انتقال مبلغ ${params.amount} کافی نیست.`
      );
    }
    const wd = await createOwnerWithdrawal({
      organizationId: params.organizationId,
      ownerUserId: params.ownerUserId,
      actorEmail: params.actorEmail,
      ipAddress: params.ipAddress,
      businessFinancialAccountId: fromBiz.id,
      personalAccountId: toPersonal.id,
      amount: params.amount,
      withdrawalDate: today,
      notes: params.description || `انتقال از ${fromBiz.name} به ${toPersonal.name}`,
      createPersonalTx: true,
      idempotencyKey: params.idempotencyKey,
    });
    return {
      transfer_type: "BUSINESS_TO_PERSONAL",
      from_account_id: fromBiz.id,
      to_account_id: toPersonal.id,
      amount: params.amount,
      withdrawal: wd.withdrawal,
      journal_entry: wd.journalEntry,
      personal_transaction: wd.personalTransaction,
    };
  }

  // Case 2: Personal -> Business (Owner Contribution / Capital Injection — NOT Sales Revenue!)
  if (fromPersonal && toBiz) {
    if (parseDecimal(fromPersonal.balance) < amountDec) {
      throw new ApiError(
        409,
        "INSUFFICIENT_SOURCE_BALANCE",
        `موجودی حساب شخصی مبدأ (${fromPersonal.name}: ${fromPersonal.balance}) کافی نیست.`
      );
    }
    await db
      .update(personalAccounts)
      .set({ balance: formatDecimal(subDec(fromPersonal.balance, amountDec), 2) })
      .where(eq(personalAccounts.id, fromPersonal.id));

    const contrib = await createOwnerContribution({
      organizationId: params.organizationId,
      ownerUserId: params.ownerUserId,
      actorEmail: params.actorEmail,
      ipAddress: params.ipAddress,
      businessFinancialAccountId: toBiz.id,
      amount: params.amount,
      contributionDate: today,
      notes: params.description || `واریز از ${fromPersonal.name} به ${toBiz.name}`,
    });
    return {
      transfer_type: "PERSONAL_TO_BUSINESS",
      from_account_id: fromPersonal.id,
      to_account_id: toBiz.id,
      amount: params.amount,
      contribution: contrib.contribution,
      journal_entry: contrib.journalEntry,
    };
  }

  // Case 3: Personal -> Personal (Personal Ledger ONLY — zero business journal!)
  if (fromPersonal && toPersonal) {
    if (parseDecimal(fromPersonal.balance) < amountDec) {
      throw new ApiError(
        409,
        "INSUFFICIENT_SOURCE_BALANCE",
        `موجودی حساب شخصی مبدأ (${fromPersonal.name}: ${fromPersonal.balance}) کافی نیست.`
      );
    }
    const txRow = await withTenantTransaction(params.organizationId, async (tx) => {
      await tx
        .update(personalAccounts)
        .set({ balance: formatDecimal(subDec(fromPersonal.balance, amountDec), 2) })
        .where(eq(personalAccounts.id, fromPersonal.id));
      await tx
        .update(personalAccounts)
        .set({ balance: formatDecimal(addDec(toPersonal.balance, amountDec), 2) })
        .where(eq(personalAccounts.id, toPersonal.id));

      const [saved] = await tx
        .insert(personalTransactions)
        .values({
          organizationId: params.organizationId,
          ownerUserId: params.ownerUserId,
          profileId: profile.id,
          personalAccountId: fromPersonal.id,
          txType: "PERSONAL_TRANSFER",
          paymentSource: fromPersonal.accountType === "BANK" ? "PERSONAL_BANK" : "PERSONAL_CASH",
          title: params.description || `انتقال شخصی از ${fromPersonal.name} به ${toPersonal.name}`,
          amount: params.amount,
          currency: profile.currency,
          txDate: today,
          notes: `مقصد: ${toPersonal.name}`,
          idempotencyKey: params.idempotencyKey ?? null,
          status: "CONFIRMED",
        })
        .returning();
      return saved;
    });

    await recordAuditLog({
      organizationId: params.organizationId,
      actorUserId: params.ownerUserId,
      actorEmail: params.actorEmail,
      scope: "ORGANIZATION",
      action: "PERSONAL_INTERNAL_TRANSFER",
      entityType: "PERSONAL_TRANSACTION",
      entityId: txRow.id,
      ipAddress: params.ipAddress,
      metadata: { deviceId: params.deviceId ?? null, from: fromPersonal.id, to: toPersonal.id, amount: params.amount },
    });

    return {
      transfer_type: "PERSONAL_TO_PERSONAL",
      from_account_id: fromPersonal.id,
      to_account_id: toPersonal.id,
      amount: params.amount,
      personal_transaction: txRow,
      journal_entry: null,
    };
  }

  if (fromBiz && toBiz) {
    throw new ApiError(
      422,
      "USE_TREASURY_TRANSFER",
      "برای انتقال بین دو حساب کسب‌وکار از مسیر /api/v1/treasury/transfers استفاده کنید."
    );
  }

  throw new ApiError(404, "TRANSFER_ACCOUNT_NOT_FOUND", "حساب مبدأ یا مقصد یافت نشد یا به شما تعلق ندارد.");
}

export async function createOwnerContribution(params: {
  organizationId: string;
  ownerUserId: string;
  actorEmail: string;
  ipAddress?: string | null;
  businessFinancialAccountId: string;
  amount: string;
  contributionDate: string;
  notes?: string;
}) {
  const profile = await getOrCreatePersonalProfile(params.organizationId, params.ownerUserId);

  const result = await withTenantTransaction(params.organizationId, async (tx) => {
    const [bizAcc] = await tx
      .select()
      .from(financialAccounts)
      .where(
        and(
          eq(financialAccounts.id, params.businessFinancialAccountId),
          eq(financialAccounts.organizationId, params.organizationId)
        )
      )
      .limit(1);
    if (!bizAcc) throw new ApiError(404, "TREASURY_ACCOUNT_NOT_FOUND", "حساب خزانه یافت نشد.");

    const drawingsAcc = await resolveOwnerDrawingsAccountTx(tx, params.organizationId);
    const bizGlAccId = await resolveBusinessFinGlAccountTx(tx, params.organizationId, bizAcc);

    const nextBizBalance = addDec(bizAcc.balance, params.amount);
    await tx
      .update(financialAccounts)
      .set({ balance: formatDecimal(nextBizBalance, 2) })
      .where(eq(financialAccounts.id, bizAcc.id));

    const journalRes = await createJournalEntryTx(tx, {
      organizationId: params.organizationId,
      actorUserId: params.ownerUserId,
      actorEmail: params.actorEmail,
      entryDate: params.contributionDate,
      description: `آورده نقدی / تسویه برداشت مالک به ${bizAcc.name}`,
      referenceType: "OWNER_CONTRIBUTION",
      postImmediately: true,
      lines: [
        { accountId: bizGlAccId, debit: params.amount, credit: "0.00", description: `واریز مالک به ${bizAcc.name}` },
        { accountId: drawingsAcc.id, debit: "0.00", credit: params.amount, description: "کاهش برداشت / افزایش آورده مالک" },
      ],
    });

    const [contribution] = await tx
      .insert(ownerContributions)
      .values({
        organizationId: params.organizationId,
        ownerUserId: params.ownerUserId,
        businessFinancialAccountId: bizAcc.id,
        amount: params.amount,
        currency: bizAcc.currency,
        contributionDate: params.contributionDate,
        journalEntryId: journalRes.entry.id,
        notes: params.notes ?? null,
      })
      .returning();

    await tx.insert(personalTransactions).values({
      organizationId: params.organizationId,
      ownerUserId: params.ownerUserId,
      profileId: profile.id,
      txType: "OWNER_CONTRIBUTION",
      paymentSource: "PERSONAL_CASH",
      title: `آورده مالک به کسب‌وکار (${bizAcc.name})`,
      amount: params.amount,
      currency: bizAcc.currency,
      txDate: params.contributionDate,
      notes: params.notes ?? null,
      status: "CONFIRMED",
    });

    return { contribution, journalEntry: journalRes.entry };
  });

  await recordAuditLog({
    organizationId: params.organizationId,
    actorUserId: params.ownerUserId,
    actorEmail: params.actorEmail,
    scope: "ORGANIZATION",
    action: "OWNER_CONTRIBUTION_POSTED",
    entityType: "OWNER_CONTRIBUTION",
    entityId: result.contribution.id,
    ipAddress: params.ipAddress,
    metadata: { amount: params.amount },
  });

  return result;
}

/**
 * Records a Personal Expense, Personal Income, Loan Payment, or Savings entry.
 * Completely isolated from business P&L!
 */
export async function createPersonalTransaction(params: {
  organizationId: string;
  ownerUserId: string;
  actorEmail: string;
  ipAddress?: string | null;
  txType: string;
  paymentSource: string;
  title: string;
  amount: string;
  txDate: string;
  categoryId?: string | null;
  personalAccountId?: string | null;
  linkedWithdrawalId?: string | null;
  businessFinancialAccountId?: string | null;
  notes?: string;
  idempotencyKey?: string | null;
}) {
  const profile = await getOrCreatePersonalProfile(params.organizationId, params.ownerUserId);

  // If paid directly from BUSINESS_CASH/BANK without an already-linked withdrawal, create linked OwnerWithdrawal first!
  let resolvedWithdrawalId = params.linkedWithdrawalId ?? null;
  if (
    !resolvedWithdrawalId &&
    (params.paymentSource === "BUSINESS_CASH" || params.paymentSource === "BUSINESS_BANK") &&
    params.businessFinancialAccountId &&
    ["PERSONAL_EXPENSE", "LOAN_PAYMENT", "RECURRING_PAYMENT", "DEBT_SETTLEMENT"].includes(params.txType)
  ) {
    const wd = await createOwnerWithdrawal({
      organizationId: params.organizationId,
      ownerUserId: params.ownerUserId,
      actorEmail: params.actorEmail,
      ipAddress: params.ipAddress,
      businessFinancialAccountId: params.businessFinancialAccountId,
      amount: params.amount,
      withdrawalDate: params.txDate,
      notes: `برداشت مستقیم بابت: ${params.title}`,
      createPersonalTx: false, // avoids double counting!
    });
    resolvedWithdrawalId = wd.withdrawal.id;
  }

  const created = await withTenantTransaction(params.organizationId, async (tx) => {
    let pAccId = params.personalAccountId ?? null;
    if (!pAccId) {
      const [firstAcc] = await tx
        .select()
        .from(personalAccounts)
        .where(
          and(
            eq(personalAccounts.organizationId, params.organizationId),
            eq(personalAccounts.ownerUserId, params.ownerUserId)
          )
        )
        .orderBy(personalAccounts.createdAt, personalAccounts.id)
        .limit(1);
      pAccId = firstAcc?.id ?? null;
    }

    if (pAccId) {
      const [pAcc] = await tx
        .select()
        .from(personalAccounts)
        .where(eq(personalAccounts.id, pAccId))
        .limit(1);
      if (pAcc) {
        const isInflow = ["PERSONAL_INCOME", "LOAN_RECEIPT", "REFUND"].includes(params.txType);
        const isOutflow = [
          "PERSONAL_EXPENSE",
          "LOAN_PAYMENT",
          "DEBT_SETTLEMENT",
          "RECURRING_PAYMENT",
        ].includes(params.txType);
        if (isInflow || (isOutflow && params.paymentSource.startsWith("PERSONAL_"))) {
          const nextBal = isInflow
            ? addDec(pAcc.balance, params.amount)
            : subDec(pAcc.balance, params.amount);
          await tx
            .update(personalAccounts)
            .set({ balance: formatDecimal(nextBal, 2) })
            .where(eq(personalAccounts.id, pAcc.id));
        }
      }
    }

    const [saved] = await tx
      .insert(personalTransactions)
      .values({
        organizationId: params.organizationId,
        ownerUserId: params.ownerUserId,
        profileId: profile.id,
        personalAccountId: pAccId,
        categoryId: params.categoryId ?? null,
        linkedWithdrawalId: resolvedWithdrawalId,
        txType: params.txType,
        paymentSource: params.paymentSource,
        title: params.title,
        amount: params.amount,
        currency: profile.currency,
        txDate: params.txDate,
        notes: params.notes ?? null,
        idempotencyKey: params.idempotencyKey ?? null,
        status: "CONFIRMED",
      })
      .returning();

    return saved;
  });

  await recordAuditLog({
    organizationId: params.organizationId,
    actorUserId: params.ownerUserId,
    actorEmail: params.actorEmail,
    scope: "ORGANIZATION",
    action: "PERSONAL_TRANSACTION_CREATED",
    entityType: "PERSONAL_TRANSACTION",
    entityId: created.id,
    ipAddress: params.ipAddress,
    metadata: { txType: params.txType, linkedWithdrawalId: resolvedWithdrawalId },
  });

  return created;
}

export async function buildPersonalFinanceDashboard(
  organizationId: string,
  ownerUserId: string
) {
  const profile = await getOrCreatePersonalProfile(organizationId, ownerUserId);

  const [pAccounts, categories, withdrawals, contributions, txs, recurrings] =
    await Promise.all([
      db
        .select()
        .from(personalAccounts)
        .where(
          and(
            eq(personalAccounts.organizationId, organizationId),
            eq(personalAccounts.ownerUserId, ownerUserId)
          )
        )
        .orderBy(personalAccounts.createdAt, personalAccounts.id),
      db
        .select()
        .from(personalExpenseCategories)
        .where(eq(personalExpenseCategories.organizationId, organizationId)),
      db
        .select()
        .from(ownerWithdrawals)
        .where(
          and(
            eq(ownerWithdrawals.organizationId, organizationId),
            eq(ownerWithdrawals.ownerUserId, ownerUserId)
          )
        )
        .orderBy(desc(ownerWithdrawals.withdrawalDate)),
      db
        .select()
        .from(ownerContributions)
        .where(
          and(
            eq(ownerContributions.organizationId, organizationId),
            eq(ownerContributions.ownerUserId, ownerUserId)
          )
        ),
      db
        .select()
        .from(personalTransactions)
        .where(
          and(
            eq(personalTransactions.organizationId, organizationId),
            eq(personalTransactions.ownerUserId, ownerUserId)
          )
        )
        .orderBy(desc(personalTransactions.txDate), desc(personalTransactions.createdAt)),
      db
        .select()
        .from(personalRecurringTransactions)
        .where(
          and(
            eq(personalRecurringTransactions.organizationId, organizationId),
            eq(personalRecurringTransactions.ownerUserId, ownerUserId)
          )
        )
        .orderBy(personalRecurringTransactions.nextDueDate),
    ]);

  let totalWithdrawals = BigInt(0);
  for (const w of withdrawals.filter((x) => x.status === "CONFIRMED")) {
    totalWithdrawals = addDec(totalWithdrawals, w.amount);
  }
  let totalContributions = BigInt(0);
  for (const c of contributions) {
    totalContributions = addDec(totalContributions, c.amount);
  }

  let totalPersonalExpenses = BigInt(0);
  let totalPersonalIncome = BigInt(0);
  let totalSavings = BigInt(0);
  const byCategory = new Map<string, bigint>();

  for (const t of txs.filter((x) => x.status === "CONFIRMED")) {
    if (["PERSONAL_EXPENSE", "LOAN_PAYMENT", "DEBT_SETTLEMENT", "RECURRING_PAYMENT"].includes(t.txType)) {
      totalPersonalExpenses = addDec(totalPersonalExpenses, t.amount);
      const cid = t.categoryId ?? "UNCATEGORIZED";
      byCategory.set(cid, addDec(byCategory.get(cid) ?? BigInt(0), t.amount));
    } else if (["PERSONAL_INCOME", "LOAN_RECEIPT"].includes(t.txType)) {
      totalPersonalIncome = addDec(totalPersonalIncome, t.amount);
    } else if (t.txType === "SAVINGS") {
      totalSavings = addDec(totalSavings, t.amount);
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const enrichedRecurrings = recurrings.map((r) => {
    const computedStatus =
      r.obligationStatus === "PAID" || r.obligationStatus === "CANCELLED"
        ? r.obligationStatus
        : r.nextDueDate < today
          ? "OVERDUE"
          : "DUE";
    return {
      ...r,
      computed_status: computedStatus,
      category_name: categories.find((c) => c.id === r.categoryId)?.nameFa ?? null,
    };
  });

  const catMap = new Map(categories.map((c) => [c.id, c]));
  const categoryBreakdown = Array.from(byCategory.entries()).map(([cid, amt]) => {
    const cat = catMap.get(cid);
    return {
      category_id: cid === "UNCATEGORIZED" ? null : cid,
      category_name: cat?.nameFa ?? "سایر هزینه‌های شخصی",
      color: cat?.color ?? "#64748b",
      budget_limit: cat?.monthlyBudgetLimit ?? "0.00",
      spent: formatDecimal(amt, 2),
    };
  });

  let personalCashBalance = BigInt(0);
  let personalBankBalance = BigInt(0);
  for (const acc of pAccounts) {
    if (acc.accountType === "CASH") personalCashBalance = addDec(personalCashBalance, acc.balance);
    if (acc.accountType === "BANK") personalBankBalance = addDec(personalBankBalance, acc.balance);
  }

  return {
    profile,
    kpis: {
      total_owner_withdrawals: formatDecimal(totalWithdrawals, 2),
      total_owner_contributions: formatDecimal(totalContributions, 2),
      net_owner_drawings: formatDecimal(subDec(totalWithdrawals, totalContributions), 2),
      total_personal_expenses: formatDecimal(totalPersonalExpenses, 2),
      total_personal_income: formatDecimal(totalPersonalIncome, 2),
      personal_cash_balance: formatDecimal(personalCashBalance, 2),
      personal_bank_balance: formatDecimal(personalBankBalance, 2),
      personal_savings: formatDecimal(totalSavings, 2),
      monthly_budget_limit: profile.monthlyBudgetLimit,
      upcoming_payments_count: enrichedRecurrings.filter((r) => r.computed_status === "DUE").length,
      overdue_payments_count: enrichedRecurrings.filter((r) => r.computed_status === "OVERDUE").length,
    },
    accounts: pAccounts,
    categories,
    category_breakdown: categoryBreakdown,
    withdrawals,
    transactions: txs.map((t) => ({
      ...t,
      category_name: t.categoryId ? catMap.get(t.categoryId)?.nameFa ?? null : null,
    })),
    recurring_obligations: enrichedRecurrings,
  };
}

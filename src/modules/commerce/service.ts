import { and, eq, inArray, sql } from "drizzle-orm";
import {
  accounts,
  chequeEvents,
  cheques,
  contactTransactions,
  financialAccounts,
  financialTransactions,
  invoicePaymentAllocations,
  journalEntries,
  journalEntryLines,
  loyaltyAccounts,
  loyaltyTransactions,
  organizations,
  purchaseInvoiceItems,
  purchaseInvoices,
  salesInvoiceItems,
  salesInvoices,
} from "@/db/schema";
import { gregorianIsoToJalali, resolveCanonicalDate } from "@/lib/jalali";
import { ensurePrompt05OrgDefaults } from "@/db/seed-prompt05";
import {
  addDec,
  eqDec,
  formatDecimal,
  divDec,
  gtDec,
  isPositiveDec,
  mulDec,
  parseDecimal,
  subDec,
} from "@/lib/decimal";
import { ApiError } from "@/lib/errors";
import { recordAuditLog } from "@/lib/audit";
import { withTenantTransaction } from "@/lib/tenant";
import { createJournalEntryTx, JournalLineInput } from "@/modules/accounting/service";
import { postStockDocumentTx } from "@/modules/inventory/service";

export interface PaymentAllocationInput {
  financialAccountId?: string | null;
  paymentMethod:
    | "CASH"
    | "BANK"
    | "BANK_TRANSFER"
    | "CARD_TERMINAL"
    | "POS"
    | "WALLET"
    | "CHEQUE"
    | "CREDIT"
    | "ACCOUNT_BALANCE"
    | "OTHER";
  amount: string;
  referenceNumber?: string | null;
  cheque?: {
    chequeNumber: string;
    serialNumber?: string;
    bankName: string;
    branchName?: string;
    drawerName?: string;
    issueDate?: string;
    issueDateJalali?: string;
    dueDate?: string;
    dueDateJalali?: string;
    notes?: string;
  } | null;
}

async function findSystemAccount(
  tx: Parameters<Parameters<typeof withTenantTransaction>[1]>[0],
  organizationId: string,
  systemRole: string,
  optional = false
) {
  const [acc] = await tx
    .select()
    .from(accounts)
    .where(
      and(
        eq(accounts.organizationId, organizationId),
        eq(accounts.systemRole, systemRole)
      )
    )
    .limit(1);
  if (!acc && !optional) {
    throw new ApiError(
      422,
      "SYSTEM_ACCOUNT_MISSING",
      `حساب سیستمی (${systemRole}) برای این سازمان پیکربندی نشده است.`
    );
  }
  return acc ?? null;
}

/**
 * Atomically finalizes a Sales Invoice (Prompt 05 §4.5–4.7 + Scenarios B & D):
 * - Supports Mixed Payment Allocations (Cash + POS + Bank + Unpaid Credit)
 * - Enforces exact Decimal sum(payments) <= grand_total
 * - Deducts Stock Ledger at Product OR Product Variant granularity
 * - Posts strictly balanced Double-Entry Journal (Cash/Bank/POS + AR + Discount + Revenue + Tax + COGS/Inventory)
 * - Records Customer Receivable transactions & immutable Loyalty Points
 */
export async function finalizeSalesInvoice(params: {
  organizationId: string;
  invoiceId: string;
  actorUserId: string;
  actorEmail: string;
  ipAddress?: string | null;
  paymentAllocations?: PaymentAllocationInput[];
}) {
  await ensurePrompt05OrgDefaults(params.organizationId);

  const result = await withTenantTransaction(params.organizationId, async (tx) => {
    await tx.execute(sql`
      SELECT id FROM sales_invoices
      WHERE id = ${params.invoiceId} AND organization_id = ${params.organizationId}
      FOR UPDATE
    `);
    const [inv] = await tx
      .select()
      .from(salesInvoices)
      .where(
        and(
          eq(salesInvoices.id, params.invoiceId),
          eq(salesInvoices.organizationId, params.organizationId)
        )
      )
      .limit(1);

    if (!inv) throw new ApiError(404, "INVOICE_NOT_FOUND", "فاکتور فروش یافت نشد.");
    if (inv.status !== "DRAFT") {
      throw new ApiError(409, "INVOICE_ALREADY_FINALIZED", "این فاکتور قبلاً نهایی یا باطل شده است.");
    }
    const [organization] = await tx.select({ baseCurrency: organizations.baseCurrency }).from(organizations).where(eq(organizations.id, params.organizationId)).limit(1);
    if (!organization) throw new ApiError(404, "ORG_NOT_FOUND", "سازمان یافت نشد.");
    if (inv.currency !== organization.baseCurrency || !eqDec(inv.exchangeRate, "1.0000")) {
      throw new ApiError(422, "FOREIGN_CURRENCY_POSTING_UNSUPPORTED", `ثبت قطعی فاکتور با ارز ${inv.currency} در دفتر ${organization.baseCurrency} به نرخ تسعیر و حساب‌های ارزی نیاز دارد؛ تا پشتیبانی کامل تسعیر، فاکتور را با ارز پایه و نرخ ۱ ثبت کنید.`);
    }

    const items = await tx
      .select()
      .from(salesInvoiceItems)
      .where(eq(salesInvoiceItems.salesInvoiceId, inv.id));

    if (items.length === 0) {
      throw new ApiError(422, "INVOICE_NO_ITEMS", "فاکتور فاقد ردیف کالا است.");
    }

    // Validate mixed payment allocations (Prompt 08 §2.1: CASH, BANK, CARD_TERMINAL, CHEQUE, CREDIT, ACCOUNT_BALANCE)
    const rawAllocations = (params.paymentAllocations ?? []).filter((a) =>
      isPositiveDec(parseDecimal(a.amount))
    );
    const immediateAllocations = rawAllocations.filter(
      (a) => a.paymentMethod !== "CREDIT" && a.paymentMethod !== "ACCOUNT_BALANCE"
    );
    const creditAllocations = rawAllocations.filter(
      (a) => a.paymentMethod === "CREDIT" || a.paymentMethod === "ACCOUNT_BALANCE"
    );

    let totalAllocated = BigInt(0);
    for (const a of immediateAllocations) {
      totalAllocated = addDec(totalAllocated, a.amount);
    }
    let explicitCreditSum = BigInt(0);
    for (const c of creditAllocations) {
      explicitCreditSum = addDec(explicitCreditSum, c.amount);
    }

    const grandTotalDec = parseDecimal(inv.totalAmount);
    if (gtDec(addDec(totalAllocated, explicitCreditSum), grandTotalDec)) {
      throw new ApiError(
        422,
        "OVERPAYMENT_NOT_ALLOWED",
        `مجموع تسویه‌های ثبت‌شده (${formatDecimal(addDec(totalAllocated, explicitCreditSum), 2)}) نمی‌تواند از مبلغ قابل پرداخت فاکتور (${inv.totalAmount}) بیشتر باشد.`
      );
    }
    const unpaidDec = subDec(grandTotalDec, totalAllocated);
    const allocations = immediateAllocations;

    // 1. Variant-aware Stock Issue
    const stockRes = await postStockDocumentTx(tx, {
      organizationId: params.organizationId,
      warehouseId: inv.warehouseId,
      documentType: "ISSUE",
      documentDate: inv.invoiceDate,
      reason: `حواله خروج بابت فاکتور فروش ${inv.invoiceNumber}`,
      referenceType: "SALES_INVOICE",
      referenceId: inv.id,
      actorUserId: params.actorUserId,
      items: items.map((it) => ({
        productId: it.productId,
        variantId: it.variantId ?? null,
        direction: "OUT",
        quantity: it.quantity,
      })),
    });

    // 2. Resolve GL accounts
    const arAcc = (await findSystemAccount(tx, params.organizationId, "AR"))!;
    const revAcc = (await findSystemAccount(tx, params.organizationId, "SALES_REVENUE"))!;
    const cogsAcc = (await findSystemAccount(tx, params.organizationId, "COGS"))!;
    const invAcc = (await findSystemAccount(tx, params.organizationId, "INVENTORY"))!;
    const cashAcc = (await findSystemAccount(tx, params.organizationId, "CASH"))!;
    const bankAcc = (await findSystemAccount(tx, params.organizationId, "BANK"))!;
    const taxAcc = await findSystemAccount(tx, params.organizationId, "TAX_PAYABLE", true);
    const discAcc = await findSystemAccount(tx, params.organizationId, "SALES_DISCOUNT", true);
    if (isPositiveDec(parseDecimal(inv.taxAmount)) && !taxAcc) {
      throw new ApiError(422, "TAX_PAYABLE_ACCOUNT_MISSING", "برای فاکتور دارای مالیات، حساب مالیات پرداختنی باید در کدینگ تعریف شود.");
    }
    if (isPositiveDec(parseDecimal(inv.discountAmount)) && !discAcc) {
      throw new ApiError(422, "SALES_DISCOUNT_ACCOUNT_MISSING", "برای ثبت فاکتور دارای تخفیف، حساب تخفیف فروش باید در کدینگ تعریف شود.");
    }

    let orgFinAccs = await tx
      .select()
      .from(financialAccounts)
      .where(eq(financialAccounts.organizationId, params.organizationId));

    const resolveTargetFin = (alloc: PaymentAllocationInput) => {
      if (alloc.financialAccountId) return orgFinAccs.find((f) => f.id === alloc.financialAccountId);
      if (alloc.paymentMethod === "CASH") return orgFinAccs.find((f) => f.accountType === "CASHBOX" || f.accountType === "CASH");
      if (alloc.paymentMethod === "POS" || alloc.paymentMethod === "CARD_TERMINAL") return orgFinAccs.find((f) => f.accountType === "POS" || f.accountType === "CARD_TERMINAL");
      return orgFinAccs.find((f) => f.accountType === "BANK");
    };
    const plannedFinIds = new Set<string>();
    for (const alloc of allocations) {
      if (alloc.paymentMethod === "CHEQUE") continue;
      const target = resolveTargetFin(alloc);
      if (!target) throw new ApiError(422, "TREASURY_ACCOUNT_REQUIRED", `برای روش پرداخت ${alloc.paymentMethod} حساب خزانه فعال تعریف نشده است.`);
      if (!target.isActive) throw new ApiError(409, "TREASURY_ACCOUNT_INACTIVE", `حساب خزانه «${target.name}» غیرفعال است.`);
      if (target.currency !== organization.baseCurrency) throw new ApiError(422, "FOREIGN_CURRENCY_TREASURY_UNSUPPORTED", `حساب «${target.name}» ارز ${target.currency} دارد؛ دریافت چندارزی تا پیاده‌سازی کامل تسعیر مجاز نیست.`);
      plannedFinIds.add(target.id);
    }
    for (const accountId of [...plannedFinIds].sort()) {
      await tx.execute(sql`SELECT id FROM financial_accounts WHERE id = ${accountId} AND organization_id = ${params.organizationId} FOR UPDATE`);
    }
    if (plannedFinIds.size > 0) {
      orgFinAccs = await tx.select().from(financialAccounts).where(eq(financialAccounts.organizationId, params.organizationId));
    }

    const jLines: JournalLineInput[] = [];
    const savedAllocations = [];
    const savedFinancialTransactionIds: string[] = [];
    const paymentLedgerRefs: Array<{ referenceId: string; amount: string }> = [];

    const recChqAcc = await findSystemAccount(tx, params.organizationId, "RECEIVABLE_CHEQUE", true);
    const createdCheques = [];

    // 2a. Debit Treasury accounts (or Receivable Cheques for CHEQUE) for each payment allocation
    for (const alloc of allocations) {
      if (alloc.paymentMethod === "CHEQUE") {
        const chData = alloc.cheque;
        const chNumber = chData?.chequeNumber || alloc.referenceNumber || `CHQ-${Date.now().toString().slice(-8)}`;
        const chIssueDate = resolveCanonicalDate(chData?.issueDate || inv.invoiceDate, chData?.issueDateJalali);
        const chDueDate = resolveCanonicalDate(chData?.dueDate, chData?.dueDateJalali);

        const [createdChq] = await tx
          .insert(cheques)
          .values({
            organizationId: params.organizationId,
            contactId: inv.contactId,
            chequeType: "RECEIVABLE",
            sayadId: chNumber,
            serialNumber: chData?.serialNumber || chNumber.slice(-6),
            bankName: chData?.bankName || "بانک طرف‌حساب",
            branchName: chData?.branchName ?? null,
            drawerName: chData?.drawerName ?? null,
            amount: alloc.amount,
            issueDate: chIssueDate,
            dueDate: chDueDate,
            relatedDocumentType: "SALES_INVOICE",
            relatedDocumentId: inv.id,
            status: "RECEIVED",
            notes: chData?.notes ?? `چک دریافتی بابت فاکتور فروش ${inv.invoiceNumber}`,
          })
          .returning();

        await tx.insert(chequeEvents).values({
          organizationId: params.organizationId,
          chequeId: createdChq.id,
          fromStatus: null,
          toStatus: "RECEIVED",
          eventDate: inv.invoiceDate,
          note: `ثبت چک در تسویه فاکتور ${inv.invoiceNumber} (سررسید شمسی: ${gregorianIsoToJalali(chDueDate)})`,
          actorUserId: params.actorUserId,
        });
        createdCheques.push({
          ...createdChq,
          due_date_jalali: gregorianIsoToJalali(chDueDate),
          issue_date_jalali: gregorianIsoToJalali(chIssueDate),
        });
        paymentLedgerRefs.push({ referenceId: createdChq.id, amount: alloc.amount });

        jLines.push({
          accountId: recChqAcc?.id ?? arAcc.id,
          contactId: inv.contactId,
          debit: alloc.amount,
          credit: "0.00",
          description: `دریافت چک ${chNumber} بابت فاکتور ${inv.invoiceNumber}`,
        });

        const [savedAlloc] = await tx
          .insert(invoicePaymentAllocations)
          .values({
            organizationId: params.organizationId,
            salesInvoiceId: inv.id,
            financialAccountId: null,
            contactId: inv.contactId,
            chequeId: createdChq.id,
            paymentMethod: "CHEQUE",
            amount: alloc.amount,
            paidAt: inv.invoiceDate,
            referenceNumber: chNumber,
            status: "CONFIRMED",
            createdBy: params.actorUserId,
          })
          .returning();
        savedAllocations.push(savedAlloc);
        continue;
      }

      let targetFin = alloc.financialAccountId
        ? orgFinAccs.find((f) => f.id === alloc.financialAccountId)
        : undefined;
      if (alloc.financialAccountId && !targetFin) throw new ApiError(404, "TREASURY_ACCOUNT_NOT_FOUND", "حساب خزانه انتخاب‌شده متعلق به این سازمان نیست.");
      if (!targetFin) targetFin = resolveTargetFin(alloc);
      if (!targetFin) throw new ApiError(422, "TREASURY_ACCOUNT_REQUIRED", `برای روش پرداخت ${alloc.paymentMethod} حساب خزانه تعریف نشده است.`);
      if (!targetFin.isActive) throw new ApiError(409, "TREASURY_ACCOUNT_INACTIVE", `حساب خزانه «${targetFin.name}» غیرفعال است.`);
      if (targetFin.currency !== organization.baseCurrency) throw new ApiError(422, "FOREIGN_CURRENCY_TREASURY_UNSUPPORTED", `حساب «${targetFin.name}» ارز ${targetFin.currency} دارد؛ دریافت چندارزی تا پیاده‌سازی کامل تسعیر مجاز نیست.`);
      const nextBal = addDec(targetFin.balance, alloc.amount);
      const [updatedFin] = await tx.update(financialAccounts).set({
        balance: formatDecimal(nextBal, 2), version: targetFin.version + 1, updatedAt: new Date(),
      }).where(and(eq(financialAccounts.id, targetFin.id), eq(financialAccounts.version, targetFin.version))).returning({ id: financialAccounts.id });
      if (!updatedFin) throw new ApiError(409, "TREASURY_ACCOUNT_CHANGED", "حساب خزانه هم‌زمان تغییر کرده است؛ درخواست را دوباره ارسال کنید.");
      targetFin.balance = formatDecimal(nextBal, 2);
      const glId = targetFin.accountId ?? (targetFin.accountType === "CASHBOX" || targetFin.accountType === "CASH" ? cashAcc.id : bankAcc.id);
      const [finTx] = await tx.insert(financialTransactions).values({
        organizationId: params.organizationId,
        financialAccountId: targetFin.id,
        contactId: inv.contactId,
        txType: "RECEIPT",
        paymentMethod: alloc.paymentMethod,
        currency: inv.currency,
        amount: alloc.amount,
        txDate: inv.invoiceDate,
        trackingNumber: alloc.referenceNumber ?? null,
        relatedDocumentType: "SALES_INVOICE",
        relatedDocumentId: inv.id,
        description: `دریافت (${alloc.paymentMethod}) بابت فاکتور فروش ${inv.invoiceNumber}`,
        createdBy: params.actorUserId,
      }).returning({ id: financialTransactions.id });
      savedFinancialTransactionIds.push(finTx.id);
      paymentLedgerRefs.push({ referenceId: finTx.id, amount: alloc.amount });

      jLines.push({
        accountId: glId,
        debit: alloc.amount,
        credit: "0.00",
        description: `دریافت ${alloc.paymentMethod} بابت فاکتور ${inv.invoiceNumber}`,
      });

      const [savedAlloc] = await tx
        .insert(invoicePaymentAllocations)
        .values({
          organizationId: params.organizationId,
          salesInvoiceId: inv.id,
          financialAccountId: targetFin?.id ?? null,
          contactId: inv.contactId,
          chequeId: null,
          paymentMethod: alloc.paymentMethod,
          amount: alloc.amount,
          paidAt: inv.invoiceDate,
          referenceNumber: alloc.referenceNumber ?? null,
          status: "CONFIRMED",
          createdBy: params.actorUserId,
        })
        .returning();
      savedAllocations.push(savedAlloc);
    }

    // 2b. Debit AR for unpaid credit portion + persist CREDIT/ACCOUNT_BALANCE settlement allocation row
    if (isPositiveDec(unpaidDec)) {
      jLines.push({
        accountId: arAcc.id,
        contactId: inv.contactId,
        debit: formatDecimal(unpaidDec, 2),
        credit: "0.00",
        description: `مانده بدهکاری مشتری بابت فاکتور فروش ${inv.invoiceNumber}`,
      });

      const creditMethod = creditAllocations[0]?.paymentMethod ?? "CREDIT";
      const [creditAlloc] = await tx
        .insert(invoicePaymentAllocations)
        .values({
          organizationId: params.organizationId,
          salesInvoiceId: inv.id,
          financialAccountId: null,
          contactId: inv.contactId,
          chequeId: null,
          paymentMethod: creditMethod,
          amount: formatDecimal(unpaidDec, 2),
          paidAt: inv.invoiceDate,
          referenceNumber: creditAllocations[0]?.referenceNumber ?? inv.invoiceNumber,
          status: "CONFIRMED",
          createdBy: params.actorUserId,
        })
        .returning();
      savedAllocations.push(creditAlloc);
    }

    // 2c. Discount & Tax & Revenue exact double-entry balancing
    const discountDec = parseDecimal(inv.discountAmount);
    const taxDec = parseDecimal(inv.taxAmount);

    if (isPositiveDec(discountDec) && discAcc) {
      jLines.push({
        accountId: discAcc.id,
        debit: formatDecimal(discountDec, 2),
        credit: "0.00",
        description: `تخفیف فاکتور فروش ${inv.invoiceNumber}`,
      });
    }

    // Revenue credit = grandTotal + discount(if posted) - tax(if posted)
    let revenueCredit = grandTotalDec;
    if (isPositiveDec(discountDec) && discAcc) {
      revenueCredit = addDec(revenueCredit, discountDec);
    }
    if (isPositiveDec(taxDec) && taxAcc) {
      revenueCredit = subDec(revenueCredit, taxDec);
      jLines.push({
        accountId: taxAcc.id,
        debit: "0.00",
        credit: formatDecimal(taxDec, 2),
        description: `مالیات بر ارزش افزوده فاکتور ${inv.invoiceNumber}`,
      });
    }

    jLines.push({
      accountId: revAcc.id,
      debit: "0.00",
      credit: formatDecimal(revenueCredit, 2),
      description: `درآمد فروش کالا بابت فاکتور ${inv.invoiceNumber}`,
    });

    // 2d. COGS & Inventory reduction
    if (isPositiveDec(parseDecimal(stockRes.totalCostValue))) {
      jLines.push(
        {
          accountId: cogsAcc.id,
          debit: stockRes.totalCostValue,
          credit: "0.00",
          description: `بهای تمام‌شده کالای فروش‌رفته فاکتور ${inv.invoiceNumber}`,
        },
        {
          accountId: invAcc.id,
          debit: "0.00",
          credit: stockRes.totalCostValue,
          description: `کاهش موجودی کالا بابت فاکتور ${inv.invoiceNumber}`,
        }
      );
    }

    const journalRes = await createJournalEntryTx(tx, {
      organizationId: params.organizationId,
      actorUserId: params.actorUserId,
      actorEmail: params.actorEmail,
      entryDate: inv.invoiceDate,
      description: `سند اتوماتیک فاکتور فروش شماره ${inv.invoiceNumber}`,
      referenceType: "SALES_INVOICE",
      referenceId: inv.id,
      postImmediately: true,
      lines: jLines,
    });

    // Link journal to payment allocations & created cheques
    for (const sa of savedAllocations) {
      await tx
        .update(invoicePaymentAllocations)
        .set({ journalEntryId: journalRes.entry.id })
        .where(eq(invoicePaymentAllocations.id, sa.id));
    }
    for (const ch of createdCheques) {
      await tx
        .update(cheques)
        .set({ journalEntryId: journalRes.entry.id })
        .where(eq(cheques.id, ch.id));
    }
    for (const financialTransactionId of savedFinancialTransactionIds) {
      await tx.update(financialTransactions).set({ journalEntryId: journalRes.entry.id, version: 2, updatedAt: new Date() }).where(eq(financialTransactions.id, financialTransactionId));
    }

    // 3. Contact ledger: invoice debit + immediate payment credit
    await tx.insert(contactTransactions).values({
      organizationId: params.organizationId,
      contactId: inv.contactId,
      referenceType: "SALES_INVOICE",
      referenceId: inv.id,
      txDate: inv.invoiceDate,
      debit: inv.totalAmount,
      credit: "0.00",
      description: `فاکتور فروش ${inv.invoiceNumber}`,
    });
    for (const payment of paymentLedgerRefs) {
      await tx.insert(contactTransactions).values({
        organizationId: params.organizationId,
        contactId: inv.contactId,
        referenceType: "TREASURY",
        referenceId: payment.referenceId,
        txDate: inv.invoiceDate,
        debit: "0.00",
        credit: formatDecimal(parseDecimal(payment.amount), 2),
        description: `پرداخت هم‌زمان فاکتور فروش ${inv.invoiceNumber}`,
      });
    }

    // 4. Immutable Loyalty Points earning (1 point per 1,000,000 IRR)
    const earnedPoints = Math.floor(Number(inv.totalAmount) / 1_000_000);
    if (earnedPoints > 0) {
      let [la] = await tx
        .select()
        .from(loyaltyAccounts)
        .where(
          and(
            eq(loyaltyAccounts.organizationId, params.organizationId),
            eq(loyaltyAccounts.contactId, inv.contactId)
          )
        )
        .limit(1);
      if (!la) {
        [la] = await tx
          .insert(loyaltyAccounts)
          .values({ organizationId: params.organizationId, contactId: inv.contactId, tier: "BRONZE" })
          .returning();
      }
      await tx.insert(loyaltyTransactions).values({
        organizationId: params.organizationId,
        loyaltyAccountId: la.id,
        contactId: inv.contactId,
        txType: "EARN",
        pointsDelta: earnedPoints,
        referenceType: "SALES_INVOICE",
        referenceId: inv.id,
        description: `امتیاز وفاداری بابت فاکتور ${inv.invoiceNumber}`,
        createdBy: params.actorUserId,
      });
    }

    // 5. Update multi-dimensional statuses on Sales Invoice (§4.7)
    const paymentStatus = !isPositiveDec(totalAllocated)
      ? "UNPAID"
      : !isPositiveDec(unpaidDec)
        ? "PAID"
        : "PARTIALLY_PAID";

    const [finalized] = await tx
      .update(salesInvoices)
      .set({
        status: "CONFIRMED",
        paymentStatus,
        accountingStatus: "POSTED",
        stockStatus: "ISSUED",
        paidAmount: formatDecimal(totalAllocated, 2),
        remainingAmount: formatDecimal(unpaidDec, 2),
        stockDocumentId: stockRes.document.id,
        journalEntryId: journalRes.entry.id,
        version: inv.version + 1,
        syncSeq: Date.now(),
        updatedAt: new Date(),
      })
      .where(eq(salesInvoices.id, inv.id))
      .returning();

    return {
      invoice: finalized,
      paymentAllocations: savedAllocations,
      cheques: createdCheques,
      stockDocument: stockRes.document,
      journalEntry: journalRes.entry,
      warnings: stockRes.warnings,
    };
  });

  await recordAuditLog({
    organizationId: params.organizationId,
    actorUserId: params.actorUserId,
    actorEmail: params.actorEmail,
    scope: "ORGANIZATION",
    action: "SALES_INVOICE_CONFIRMED",
    entityType: "SALES_INVOICE",
    entityId: result.invoice.id,
    ipAddress: params.ipAddress,
    metadata: {
      invoiceNumber: result.invoice.invoiceNumber,
      totalAmount: result.invoice.totalAmount,
      paidAmount: result.invoice.paidAmount,
      remainingAmount: result.invoice.remainingAmount,
      paymentStatus: result.invoice.paymentStatus,
      journalEntryId: result.journalEntry.id,
    },
  });

  return result;
}

/**
 * Scenario C — Subsequent Customer Debt Payment (with strict Idempotency & Accounting Journal DR Cash/Bank / CR AR)
 */
export async function recordSubsequentInvoicePayment(params: {
  organizationId: string;
  invoiceId: string;
  financialAccountId?: string | null;
  paymentMethod: "CASH" | "POS" | "BANK_TRANSFER" | "WALLET" | "CHEQUE" | "OTHER";
  amount: string;
  paidAt: string;
  referenceNumber?: string | null;
  cheque?: {
    chequeNumber: string;
    serialNumber?: string;
    bankName: string;
    branchName?: string | null;
    drawerName?: string | null;
    issueDate?: string;
    issueDateJalali?: string;
    dueDate?: string;
    dueDateJalali?: string;
    notes?: string | null;
  } | null;
  idempotencyKey?: string | null;
  actorUserId: string;
  actorEmail: string;
  ipAddress?: string | null;
}) {
  if (!isPositiveDec(parseDecimal(params.amount))) {
    throw new ApiError(422, "AMOUNT_INVALID", "مبلغ پرداخت باید بزرگ‌تر از صفر باشد.");
  }
  const paidAt = resolveCanonicalDate(params.paidAt);
  if (params.paymentMethod === "CHEQUE" && !params.cheque) {
    throw new ApiError(422, "CHEQUE_DETAILS_REQUIRED", "برای ثبت چک، اطلاعات کامل چک الزامی است.");
  }
  if (params.paymentMethod !== "CHEQUE" && !params.financialAccountId) {
    throw new ApiError(422, "TREASURY_ACCOUNT_REQUIRED", "انتخاب حساب خزانه برای دریافت وجه الزامی است.");
  }

  const result = await withTenantTransaction(params.organizationId, async (tx) => {
    if (params.idempotencyKey) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${params.organizationId}:${params.idempotencyKey}`}))`);
    }
    // Per-payment idempotency guard
    if (params.idempotencyKey) {
      const [dup] = await tx
        .select()
        .from(invoicePaymentAllocations)
        .where(
          and(
            eq(invoicePaymentAllocations.organizationId, params.organizationId),
            eq(invoicePaymentAllocations.idempotencyKey, params.idempotencyKey)
          )
        )
        .limit(1);
      if (dup) {
        const payloadMatches =
          dup.salesInvoiceId === params.invoiceId &&
          dup.amount === formatDecimal(parseDecimal(params.amount), 2) &&
          dup.paymentMethod === params.paymentMethod &&
          dup.financialAccountId === (params.paymentMethod === "CHEQUE" ? null : params.financialAccountId) &&
          dup.paidAt === paidAt &&
          (dup.referenceNumber ?? null) === (params.referenceNumber ?? params.cheque?.chequeNumber ?? null);
        if (!payloadMatches) {
          throw new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "کلید تکرار با اطلاعات پرداخت دیگری استفاده شده است.");
        }
        const [invRow] = await tx
          .select()
          .from(salesInvoices)
          .where(eq(salesInvoices.id, dup.salesInvoiceId))
          .limit(1);
        return { allocation: dup, invoice: invRow, replayed: true };
      }
    }

    await tx.execute(sql`
      SELECT id FROM sales_invoices
      WHERE id = ${params.invoiceId} AND organization_id = ${params.organizationId}
      FOR UPDATE
    `);
    const [inv] = await tx
      .select()
      .from(salesInvoices)
      .where(
        and(
          eq(salesInvoices.id, params.invoiceId),
          eq(salesInvoices.organizationId, params.organizationId)
        )
      )
      .limit(1);
    if (!inv) throw new ApiError(404, "SALES_INVOICE_NOT_FOUND", "فاکتور فروش یافت نشد.");
    if (inv.status !== "CONFIRMED") {
      throw new ApiError(409, "SALES_INVOICE_NOT_PAYABLE", "فقط فاکتور فروش نهایی‌شده قابل تسویه است.");
    }
    const [organization] = await tx.select({ baseCurrency: organizations.baseCurrency }).from(organizations).where(eq(organizations.id, params.organizationId)).limit(1);
    if (!organization) throw new ApiError(404, "ORG_NOT_FOUND", "سازمان یافت نشد.");
    if (inv.currency !== organization.baseCurrency || !eqDec(inv.exchangeRate, "1.0000")) {
      throw new ApiError(422, "FOREIGN_CURRENCY_POSTING_UNSUPPORTED", `ثبت تسویه فاکتور با ارز ${inv.currency} در دفتر ${organization.baseCurrency} تا پیاده‌سازی کامل تسعیر مجاز نیست.`);
    }

    // Another request may have completed this idempotency key while this request waited on the invoice row.
    if (params.idempotencyKey) {
      const [dup] = await tx
        .select()
        .from(invoicePaymentAllocations)
        .where(
          and(
            eq(invoicePaymentAllocations.organizationId, params.organizationId),
            eq(invoicePaymentAllocations.idempotencyKey, params.idempotencyKey)
          )
        )
        .limit(1);
      if (dup) {
        const payloadMatches =
          dup.salesInvoiceId === params.invoiceId &&
          dup.amount === formatDecimal(parseDecimal(params.amount), 2) &&
          dup.paymentMethod === params.paymentMethod &&
          dup.financialAccountId === (params.paymentMethod === "CHEQUE" ? null : params.financialAccountId) &&
          dup.paidAt === paidAt &&
          (dup.referenceNumber ?? null) === (params.referenceNumber ?? params.cheque?.chequeNumber ?? null);
        if (!payloadMatches) {
          throw new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "کلید تکرار با اطلاعات پرداخت دیگری استفاده شده است.");
        }
        return { allocation: dup, invoice: inv, replayed: true };
      }
    }

    const currentRem =
      inv.remainingAmount === "0.00" && inv.paidAmount === "0.00"
        ? parseDecimal(inv.totalAmount)
        : parseDecimal(inv.remainingAmount);

    if (gtDec(parseDecimal(params.amount), currentRem)) {
      throw new ApiError(
        422,
        "OVERPAYMENT_NOT_ALLOWED",
        `مبلغ پرداخت (${params.amount}) از مانده بدهی فاکتور (${formatDecimal(currentRem, 2)}) بیشتر است.`
      );
    }

    const arAcc = (await findSystemAccount(tx, params.organizationId, "AR"))!;
    const journalLines: JournalLineInput[] = [];
    let fa: typeof financialAccounts.$inferSelect | null = null;
    let createdCheque: typeof cheques.$inferSelect | null = null;
    if (params.paymentMethod === "CHEQUE") {
      const chequeData = params.cheque!;
      const receivableChequeAcc = (await findSystemAccount(tx, params.organizationId, "RECEIVABLE_CHEQUE"))!;
      const issueDate = resolveCanonicalDate(chequeData.issueDate || paidAt, chequeData.issueDateJalali);
      const dueDate = resolveCanonicalDate(chequeData.dueDate, chequeData.dueDateJalali);
      const chequeNumber = chequeData.chequeNumber.trim();
      [createdCheque] = await tx
        .insert(cheques)
        .values({
          organizationId: params.organizationId,
          contactId: inv.contactId,
          chequeType: "RECEIVABLE",
          sayadId: chequeNumber,
          serialNumber: chequeData.serialNumber?.trim() || chequeNumber.slice(-6),
          bankName: chequeData.bankName.trim(),
          branchName: chequeData.branchName ?? null,
          drawerName: chequeData.drawerName ?? null,
          amount: formatDecimal(parseDecimal(params.amount), 2),
          issueDate,
          dueDate,
          relatedDocumentType: "SALES_INVOICE",
          relatedDocumentId: inv.id,
          status: "RECEIVED",
          notes: chequeData.notes ?? `چک دریافتی بابت تسویه فاکتور ${inv.invoiceNumber}`,
        })
        .returning();
      await tx.insert(chequeEvents).values({
        organizationId: params.organizationId,
        chequeId: createdCheque.id,
        fromStatus: null,
        toStatus: "RECEIVED",
        eventDate: paidAt,
        note: `ثبت چک بابت تسویه فاکتور ${inv.invoiceNumber}`,
        actorUserId: params.actorUserId,
      });
      journalLines.push({
        accountId: receivableChequeAcc.id,
        contactId: inv.contactId,
        debit: params.amount,
        credit: "0.00",
        description: `دریافت چک ${chequeNumber} بابت فاکتور ${inv.invoiceNumber}`,
      });
    } else {
      await tx.execute(sql`
        SELECT id FROM financial_accounts
        WHERE id = ${params.financialAccountId!} AND organization_id = ${params.organizationId}
        FOR UPDATE
      `);
      const [lockedFa] = await tx
        .select()
        .from(financialAccounts)
        .where(
          and(
            eq(financialAccounts.id, params.financialAccountId!),
            eq(financialAccounts.organizationId, params.organizationId)
          )
        )
        .limit(1);
      if (!lockedFa) throw new ApiError(404, "TREASURY_ACCOUNT_NOT_FOUND", "حساب خزانه یافت نشد.");
      if (!lockedFa.isActive) throw new ApiError(409, "TREASURY_ACCOUNT_INACTIVE", "حساب خزانه غیرفعال است.");
      if (lockedFa.currency !== organization.baseCurrency) throw new ApiError(422, "FOREIGN_CURRENCY_TREASURY_UNSUPPORTED", "حساب خزانه با ارز پایه دفتر کل یکسان نیست.");
      fa = lockedFa;
      const cashAcc = (await findSystemAccount(tx, params.organizationId, "CASH"))!;
      const bankAcc = (await findSystemAccount(tx, params.organizationId, "BANK"))!;
      const glId = fa.accountId ?? (fa.accountType === "CASHBOX" || fa.accountType === "CASH" ? cashAcc.id : bankAcc.id);
      const nextFaBal = addDec(fa.balance, params.amount);
      await tx
        .update(financialAccounts)
        .set({ balance: formatDecimal(nextFaBal, 2), version: fa.version + 1, updatedAt: new Date() })
        .where(and(eq(financialAccounts.id, fa.id), eq(financialAccounts.version, fa.version)));
      journalLines.push({ accountId: glId, debit: params.amount, credit: "0.00", description: `واریز به ${fa.name}` });
    }
    journalLines.push({
      accountId: arAcc.id,
      contactId: inv.contactId,
      debit: "0.00",
      credit: params.amount,
      description: `کاهش مانده بدهی مشتری بابت ${inv.invoiceNumber}`,
    });

    // 2. Post balanced Double-Entry Journal: DR Cash/Bank / CR AR
    const jRes = await createJournalEntryTx(tx, {
      organizationId: params.organizationId,
      actorUserId: params.actorUserId,
      actorEmail: params.actorEmail,
      entryDate: paidAt,
      description: `دریافت مطالبات مشتری بابت فاکتور فروش ${inv.invoiceNumber}`,
      referenceType: "TREASURY",
      referenceId: inv.id,
      postImmediately: true,
      lines: journalLines,
    });

    // 3. Record Treasury Transaction + Contact Ledger Credit + Payment Allocation
    let financialTransactionId: string | null = null;
    if (fa) {
      const [financialTx] = await tx.insert(financialTransactions).values({
        organizationId: params.organizationId,
        financialAccountId: fa.id,
        contactId: inv.contactId,
        txType: "RECEIPT",
        paymentMethod: params.paymentMethod,
        amount: formatDecimal(parseDecimal(params.amount), 2),
        currency: inv.currency,
        txDate: paidAt,
        trackingNumber: params.referenceNumber ?? null,
        relatedDocumentType: "SALES_INVOICE",
        relatedDocumentId: inv.id,
        journalEntryId: jRes.entry.id,
        description: `تسویه بدهی فاکتور ${inv.invoiceNumber}`,
        createdBy: params.actorUserId,
      }).returning({ id: financialTransactions.id });
      financialTransactionId = financialTx.id;
      await tx.update(financialTransactions).set({ version: 2, updatedAt: new Date() }).where(eq(financialTransactions.id, financialTx.id));
    }

    await tx.insert(contactTransactions).values({
      organizationId: params.organizationId,
      contactId: inv.contactId,
      referenceType: "TREASURY",
      referenceId: financialTransactionId ?? createdCheque!.id,
      txDate: paidAt,
      debit: "0.00",
      credit: params.amount,
      description: `دریافت وجه بابت فاکتور ${inv.invoiceNumber}`,
    });

    const [alloc] = await tx
      .insert(invoicePaymentAllocations)
      .values({
        organizationId: params.organizationId,
        salesInvoiceId: inv.id,
        financialAccountId: fa?.id ?? null,
        chequeId: createdCheque?.id ?? null,
        paymentMethod: params.paymentMethod,
        amount: formatDecimal(parseDecimal(params.amount), 2),
        paidAt,
        referenceNumber: params.referenceNumber ?? createdCheque?.sayadId ?? null,
        journalEntryId: jRes.entry.id,
        idempotencyKey: params.idempotencyKey ?? null,
        status: "CONFIRMED",
        createdBy: params.actorUserId,
      })
      .returning();

    const nextPaid = addDec(inv.paidAmount, params.amount);
    const nextRem = subDec(currentRem, params.amount);
    const paymentStatus = !isPositiveDec(nextRem) ? "PAID" : "PARTIALLY_PAID";

    const [updatedInv] = await tx
      .update(salesInvoices)
      .set({
        paidAmount: formatDecimal(nextPaid, 2),
        remainingAmount: formatDecimal(nextRem, 2),
        paymentStatus,
        version: inv.version + 1,
        syncSeq: Date.now(),
        updatedAt: new Date(),
      })
      .where(eq(salesInvoices.id, inv.id))
      .returning();

    return { allocation: alloc, invoice: updatedInv, journalEntry: jRes.entry, cheque: createdCheque, replayed: false };
  });

  if (!result.replayed) {
    await recordAuditLog({
      organizationId: params.organizationId,
      actorUserId: params.actorUserId,
      actorEmail: params.actorEmail,
      scope: "ORGANIZATION",
      action: "SALES_INVOICE_PAYMENT_RECORDED",
      entityType: "INVOICE_PAYMENT",
      entityId: result.allocation.id,
      ipAddress: params.ipAddress,
      metadata: { amount: params.amount, invoiceId: params.invoiceId },
    });
  }

  return result;
}

/**
 * Atomically finalizes a Purchase Invoice (Stock Receipt + DR Inventory / CR AP)
 */
export async function finalizePurchaseInvoice(params: {
  organizationId: string;
  invoiceId: string;
  actorUserId: string;
  actorEmail: string;
  ipAddress?: string | null;
  paymentAllocations?: PaymentAllocationInput[];
}) {
  await ensurePrompt05OrgDefaults(params.organizationId);
  const result = await withTenantTransaction(params.organizationId, async (tx) => {
    await tx.execute(sql`
      SELECT id FROM purchase_invoices
      WHERE id = ${params.invoiceId} AND organization_id = ${params.organizationId}
      FOR UPDATE
    `);
    const [inv] = await tx
      .select()
      .from(purchaseInvoices)
      .where(
        and(
          eq(purchaseInvoices.id, params.invoiceId),
          eq(purchaseInvoices.organizationId, params.organizationId)
        )
      )
      .limit(1);

    if (!inv) throw new ApiError(404, "INVOICE_NOT_FOUND", "فاکتور خرید یافت نشد.");
    if (inv.status !== "DRAFT") {
      throw new ApiError(409, "INVOICE_ALREADY_FINALIZED", "این فاکتور خرید قبلاً نهایی شده است.");
    }

    const items = await tx
      .select()
      .from(purchaseInvoiceItems)
      .where(eq(purchaseInvoiceItems.purchaseInvoiceId, inv.id));

    if (items.length === 0) {
      throw new ApiError(422, "INVOICE_NO_ITEMS", "فاکتور خرید فاقد ردیف کالا است.");
    }

    const itemsSubtotal = items.reduce((sum, item) => addDec(sum, parseDecimal(item.lineTotal)), BigInt(0));
    if (!eqDec(itemsSubtotal, inv.subtotal)) {
      throw new ApiError(409, "PURCHASE_SUBTOTAL_MISMATCH", "جمع ردیف‌های فاکتور خرید با جمع ثبت‌شده در سربرگ یکسان نیست.");
    }
    const itemDiscountTotal = items.reduce((sum, item) => addDec(sum, parseDecimal(item.discountAmount)), BigInt(0));
    const itemTaxTotal = items.reduce((sum, item) => addDec(sum, parseDecimal(item.taxAmount)), BigInt(0));
    if (gtDec(itemDiscountTotal, parseDecimal(inv.discountAmount))) {
      throw new ApiError(409, "PURCHASE_DISCOUNT_MISMATCH", "جمع تخفیف ردیف‌های فاکتور خرید از تخفیف سربرگ بیشتر است.");
    }
    if (isPositiveDec(itemTaxTotal) && !eqDec(itemTaxTotal, parseDecimal(inv.taxAmount))) {
      throw new ApiError(409, "PURCHASE_TAX_MISMATCH", "جمع مالیات ردیف‌های فاکتور خرید با مالیات سربرگ برابر نیست.");
    }
    const taxAmount = parseDecimal(inv.taxAmount);
    const purchaseCost = addDec(
      subDec(itemsSubtotal, parseDecimal(inv.discountAmount)),
      addDec(parseDecimal(inv.shippingCost), parseDecimal(inv.otherCosts))
    );
    const expectedInvoiceTotal = addDec(purchaseCost, taxAmount);
    if (!isPositiveDec(purchaseCost) || !eqDec(expectedInvoiceTotal, inv.totalAmount)) {
      throw new ApiError(422, "PURCHASE_TOTAL_INVALID", "مبلغ نهایی فاکتور خرید با جمع کالا، تخفیف، مالیات و هزینه‌های جانبی سازگار نیست.");
    }
    const [organization] = await tx.select({ baseCurrency: organizations.baseCurrency }).from(organizations).where(eq(organizations.id, params.organizationId)).limit(1);
    if (!organization) throw new ApiError(404, "ORG_NOT_FOUND", "سازمان یافت نشد.");
    if (inv.currency !== organization.baseCurrency || !eqDec(inv.exchangeRate, "1.0000")) {
      throw new ApiError(422, "FOREIGN_CURRENCY_POSTING_UNSUPPORTED", `ثبت قطعی خرید با ارز ${inv.currency} در دفتر ${organization.baseCurrency} تا پیاده‌سازی کامل تسعیر مجاز نیست.`);
    }

    const allocations = (params.paymentAllocations ?? []).filter((a) => isPositiveDec(parseDecimal(a.amount)));
    const totalAllocated = allocations.reduce((sum, allocation) => addDec(sum, allocation.amount), BigInt(0));
    if (gtDec(totalAllocated, parseDecimal(inv.totalAmount))) {
      throw new ApiError(422, "OVERPAYMENT_NOT_ALLOWED", "جمع تسویه‌های خرید نمی‌تواند از مبلغ فاکتور بیشتر باشد.");
    }
    const immediateAllocations = allocations.filter((a) => !["CREDIT", "ACCOUNT_BALANCE", "CHEQUE"].includes(a.paymentMethod));
    const chequeAllocations = allocations.filter((a) => a.paymentMethod === "CHEQUE");
    const immediateTotal = immediateAllocations.reduce((sum, allocation) => addDec(sum, allocation.amount), BigInt(0));
    const chequeTotal = chequeAllocations.reduce((sum, allocation) => addDec(sum, allocation.amount), BigInt(0));

    let allocatedPurchaseCost = BigInt(0);
    const valuedItems = items.map((item, index) => {
      const lineCost = index === items.length - 1
        ? subDec(purchaseCost, allocatedPurchaseCost)
        : mulDec(purchaseCost, divDec(parseDecimal(item.lineTotal), itemsSubtotal));
      allocatedPurchaseCost = addDec(allocatedPurchaseCost, lineCost);
      return {
        productId: item.productId,
        variantId: item.variantId ?? null,
        direction: "IN" as const,
        quantity: item.quantity,
        totalCost: formatDecimal(lineCost, 2),
      };
    });

    const stockRes = await postStockDocumentTx(tx, {
      organizationId: params.organizationId,
      warehouseId: inv.warehouseId,
      documentType: "RECEIPT",
      documentDate: inv.invoiceDate,
      reason: `رسید ورود کالا بابت فاکتور خرید ${inv.invoiceNumber}`,
      referenceType: "PURCHASE_INVOICE",
      referenceId: inv.id,
      actorUserId: params.actorUserId,
      items: valuedItems,
    });
    if (!eqDec(stockRes.totalCostValue, purchaseCost)) {
      throw new ApiError(409, "PURCHASE_STOCK_VALUE_MISMATCH", "ارزش رسید انبار با مبلغ نهایی فاکتور خرید برابر نشد.");
    }

    const invAcc = (await findSystemAccount(tx, params.organizationId, "INVENTORY"))!;
    const apAcc = (await findSystemAccount(tx, params.organizationId, "AP"))!;
    const taxReceivableAcc = isPositiveDec(taxAmount)
      ? (await findSystemAccount(tx, params.organizationId, "TAX_RECEIVABLE"))!
      : null;
    const supplierLedger = await tx.select({ debit: contactTransactions.debit, credit: contactTransactions.credit }).from(contactTransactions).where(and(
      eq(contactTransactions.organizationId, params.organizationId),
      eq(contactTransactions.contactId, inv.contactId)
    ));
    let supplierDebitBalance = BigInt(0);
    for (const row of supplierLedger) supplierDebitBalance = addDec(supplierDebitBalance, subDec(row.debit, row.credit));
    const supplierAdvanceAcc = await findSystemAccount(tx, params.organizationId, "SUPPLIER_ADVANCE", true);
    let supplierAdvanceBalance = BigInt(0);
    if (supplierAdvanceAcc) {
      const advanceLines = await tx.select({ debit: journalEntryLines.debit, credit: journalEntryLines.credit })
        .from(journalEntryLines)
        .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
        .where(and(
          eq(journalEntries.organizationId, params.organizationId),
          eq(journalEntryLines.accountId, supplierAdvanceAcc.id),
          eq(journalEntryLines.contactId, inv.contactId),
          inArray(journalEntries.status, ["POSTED", "REVERSED"])
        ));
      for (const line of advanceLines) supplierAdvanceBalance = addDec(supplierAdvanceBalance, subDec(line.debit, line.credit));
    }
    const directPaid = addDec(immediateTotal, chequeTotal);
    const payableBeforeAdvance = subDec(parseDecimal(inv.totalAmount), directPaid);
    const advanceApplied = supplierDebitBalance > BigInt(0) && supplierAdvanceBalance > BigInt(0)
      ? [supplierDebitBalance, supplierAdvanceBalance, payableBeforeAdvance].reduce((min, value) => value < min ? value : min)
      : BigInt(0);
    const advanceAssetApplied = advanceApplied;
    const remainingPayable = subDec(payableBeforeAdvance, advanceApplied);

    const cashAcc = await findSystemAccount(tx, params.organizationId, "CASH", true);
    const bankAcc = await findSystemAccount(tx, params.organizationId, "BANK", true);
    let orgFinAccs = await tx
      .select()
      .from(financialAccounts)
      .where(eq(financialAccounts.organizationId, params.organizationId));
    const resolveTargetFin = (allocation: PaymentAllocationInput) => {
      if (allocation.financialAccountId) return orgFinAccs.find((account) => account.id === allocation.financialAccountId);
      if (allocation.paymentMethod === "CASH") return orgFinAccs.find((account) => account.accountType === "CASHBOX" || account.accountType === "CASH");
      if (allocation.paymentMethod === "POS" || allocation.paymentMethod === "CARD_TERMINAL") {
        return orgFinAccs.find((account) => account.accountType === "POS" || account.accountType === "CARD_TERMINAL");
      }
      return orgFinAccs.find((account) => account.accountType === "BANK");
    };
    const targetFinByAllocation = new Map<PaymentAllocationInput, (typeof orgFinAccs)[number]>();
    for (const allocation of immediateAllocations) {
      const target = resolveTargetFin(allocation);
      if (!target) throw new ApiError(422, "TREASURY_ACCOUNT_REQUIRED", `برای روش پرداخت ${allocation.paymentMethod} حساب خزانه فعال تعریف نشده است.`);
      if (!target.isActive) throw new ApiError(409, "TREASURY_ACCOUNT_INACTIVE", `حساب خزانه «${target.name}» غیرفعال است.`);
      if (target.currency !== organization.baseCurrency) throw new ApiError(422, "FOREIGN_CURRENCY_TREASURY_UNSUPPORTED", `حساب «${target.name}» ارز ${target.currency} دارد؛ تسویه چندارزی پشتیبانی نمی‌شود.`);
      targetFinByAllocation.set(allocation, target);
    }
    for (const accountId of [...new Set([...targetFinByAllocation.values()].map((account) => account.id))].sort()) {
      await tx.execute(sql`SELECT id FROM financial_accounts WHERE id = ${accountId} AND organization_id = ${params.organizationId} FOR UPDATE`);
    }
    if (targetFinByAllocation.size > 0) {
      orgFinAccs = await tx.select().from(financialAccounts).where(eq(financialAccounts.organizationId, params.organizationId));
      for (const allocation of immediateAllocations) {
        const prior = targetFinByAllocation.get(allocation);
        const current = orgFinAccs.find((account) => account.id === prior?.id);
        if (current) targetFinByAllocation.set(allocation, current);
      }
    }
    const immediateTotalsByAccount = new Map<string, bigint>();
    for (const allocation of immediateAllocations) {
      const target = targetFinByAllocation.get(allocation)!;
      immediateTotalsByAccount.set(
        target.id,
        addDec(immediateTotalsByAccount.get(target.id) ?? BigInt(0), allocation.amount),
      );
    }
    for (const [accountId, amount] of immediateTotalsByAccount) {
      const target = orgFinAccs.find((account) => account.id === accountId)!;
      const [updated] = await tx.update(financialAccounts).set({
        balance: formatDecimal(subDec(target.balance, formatDecimal(amount, 2)), 2),
        version: target.version + 1,
        updatedAt: new Date(),
      }).where(and(eq(financialAccounts.id, target.id), eq(financialAccounts.version, target.version))).returning({ id: financialAccounts.id });
      if (!updated) throw new ApiError(409, "TREASURY_ACCOUNT_CHANGED", "حساب خزانه هم‌زمان تغییر کرده است؛ درخواست را دوباره ارسال کنید.");
    }

    const payableChequeAcc = chequeAllocations.length > 0
      ? await findSystemAccount(tx, params.organizationId, "PAYABLE_CHEQUE", true)
      : null;
    if (chequeAllocations.length > 0 && !payableChequeAcc) {
      throw new ApiError(422, "PAYABLE_CHEQUE_ACCOUNT_MISSING", "برای تسویه خرید با چک، حساب اسناد پرداختنی باید در کدینگ تعریف شود.");
    }
    const issuedCheques: Array<{ id: string; amount: string }> = [];
    const paymentFinancialTransactionIds: string[] = [];
    const paymentJournalLines: JournalLineInput[] = [];
    const paymentLedgerRefs: Array<{ referenceType: string; referenceId: string; amount: string }> = [];
    for (const allocation of immediateAllocations) {
      const target = targetFinByAllocation.get(allocation)!;
      const accountId = target.accountId ?? ((target.accountType === "CASHBOX" || target.accountType === "CASH") ? cashAcc?.id : bankAcc?.id);
      if (!accountId) throw new ApiError(422, "TREASURY_GL_ACCOUNT_MISSING", `حساب معین برای خزانه «${target.name}» مشخص نشده است.`);
      const [txRow] = await tx.insert(financialTransactions).values({
        organizationId: params.organizationId,
        financialAccountId: target.id,
        contactId: inv.contactId,
        txType: "PAYMENT",
        paymentMethod: allocation.paymentMethod,
        currency: inv.currency,
        amount: allocation.amount,
        txDate: inv.invoiceDate,
        trackingNumber: allocation.referenceNumber ?? null,
        relatedDocumentType: "PURCHASE_INVOICE",
        relatedDocumentId: inv.id,
        description: `پرداخت بابت فاکتور خرید ${inv.invoiceNumber}`,
        createdBy: params.actorUserId,
      }).returning({ id: financialTransactions.id });
      paymentFinancialTransactionIds.push(txRow.id);
      paymentJournalLines.push({
        accountId,
        debit: "0.00",
        credit: allocation.amount,
        description: `پرداخت ${allocation.paymentMethod} بابت فاکتور خرید ${inv.invoiceNumber}`,
      });
      paymentLedgerRefs.push({ referenceType: "TREASURY", referenceId: txRow.id, amount: allocation.amount });
    }
    for (const allocation of chequeAllocations) {
      const chequeNumber = allocation.cheque?.chequeNumber || allocation.referenceNumber || `CHQ-${Date.now().toString().slice(-8)}`;
      const issueDate = allocation.cheque?.issueDate || inv.invoiceDate;
      const dueDate = allocation.cheque?.dueDate || issueDate;
      const [cheque] = await tx.insert(cheques).values({
        organizationId: params.organizationId,
        contactId: inv.contactId,
        chequeType: "PAYABLE",
        sayadId: chequeNumber,
        serialNumber: allocation.cheque?.serialNumber || chequeNumber.slice(-6),
        bankName: allocation.cheque?.bankName || "بانک طرف‌حساب",
        branchName: allocation.cheque?.branchName ?? null,
        drawerName: null,
        recipientName: null,
        amount: allocation.amount,
        issueDate,
        dueDate,
        relatedDocumentType: "PURCHASE_INVOICE",
        relatedDocumentId: inv.id,
        status: "ISSUED",
        notes: allocation.cheque?.notes || `چک پرداختنی بابت فاکتور خرید ${inv.invoiceNumber}`,
      }).returning({ id: cheques.id });
      await tx.insert(chequeEvents).values({
        organizationId: params.organizationId,
        chequeId: cheque.id,
        fromStatus: null,
        toStatus: "ISSUED",
        eventDate: issueDate,
        note: `صدور چک بابت فاکتور خرید ${inv.invoiceNumber}`,
        actorUserId: params.actorUserId,
      });
      issuedCheques.push({ id: cheque.id, amount: allocation.amount });
      paymentJournalLines.push({
        accountId: payableChequeAcc!.id,
        debit: "0.00",
        credit: allocation.amount,
        description: `چک پرداختنی ${chequeNumber} بابت فاکتور خرید ${inv.invoiceNumber}`,
      });
      paymentLedgerRefs.push({ referenceType: "CHEQUE", referenceId: cheque.id, amount: allocation.amount });
    }

    const purchaseJournalLines: JournalLineInput[] = [
      {
        accountId: invAcc.id,
        debit: formatDecimal(purchaseCost, 2),
        credit: "0.00",
        description: `بهای تحصیل خالص کالا و هزینه‌های مستقیم فاکتور خرید ${inv.invoiceNumber}`,
      },
      ...(taxReceivableAcc ? [{
        accountId: taxReceivableAcc.id,
        debit: formatDecimal(taxAmount, 2),
        credit: "0.00",
        description: `اعتبار مالیات بر ارزش افزوده خرید ${inv.invoiceNumber}`,
      }] : []),
      ...(isPositiveDec(remainingPayable) ? [{
        accountId: apAcc.id,
        contactId: inv.contactId,
        debit: "0.00",
        credit: formatDecimal(remainingPayable, 2),
        description: `مانده بستانکاری تأمین‌کننده بابت فاکتور خرید ${inv.invoiceNumber}`,
      }] : []),
      ...(isPositiveDec(advanceAssetApplied) && supplierAdvanceAcc ? [{
        accountId: supplierAdvanceAcc.id,
        contactId: inv.contactId,
        debit: "0.00",
        credit: formatDecimal(advanceAssetApplied, 2),
        description: `اعمال پیش‌پرداخت تأمین‌کننده روی فاکتور خرید ${inv.invoiceNumber}`,
      }] : []),
      ...paymentJournalLines,
    ];

    const journalRes = await createJournalEntryTx(tx, {
      organizationId: params.organizationId,
      actorUserId: params.actorUserId,
      actorEmail: params.actorEmail,
      entryDate: inv.invoiceDate,
      description: `سند اتوماتیک فاکتور خرید شماره ${inv.invoiceNumber}`,
      referenceType: "PURCHASE_INVOICE",
      referenceId: inv.id,
      postImmediately: true,
      lines: purchaseJournalLines,
    });

    for (const financialTransactionId of paymentFinancialTransactionIds) {
      await tx.update(financialTransactions)
        .set({ journalEntryId: journalRes.entry.id, version: 2, updatedAt: new Date() })
        .where(eq(financialTransactions.id, financialTransactionId));
    }
    for (const cheque of issuedCheques) {
      await tx.update(cheques).set({ journalEntryId: journalRes.entry.id }).where(eq(cheques.id, cheque.id));
    }

    await tx.insert(contactTransactions).values({
      organizationId: params.organizationId,
      contactId: inv.contactId,
      referenceType: "PURCHASE_INVOICE",
      referenceId: inv.id,
      txDate: inv.invoiceDate,
      debit: "0.00",
      credit: inv.totalAmount,
      description: `فاکتور خرید ${inv.invoiceNumber}`,
    });
    if (paymentLedgerRefs.length > 0) {
      await tx.insert(contactTransactions).values(paymentLedgerRefs.map((payment) => ({
        organizationId: params.organizationId,
        contactId: inv.contactId,
        referenceType: payment.referenceType,
        referenceId: payment.referenceId,
        txDate: inv.invoiceDate,
        debit: payment.amount,
        credit: "0.00",
        description: `تسویه فاکتور خرید ${inv.invoiceNumber}`,
      })));
    }
    if (isPositiveDec(advanceApplied)) {
      await tx.insert(contactTransactions).values({
        organizationId: params.organizationId,
        contactId: inv.contactId,
        referenceType: "SUPPLIER_ADVANCE_APPLIED",
        referenceId: inv.id,
        txDate: inv.invoiceDate,
        debit: formatDecimal(advanceApplied, 2),
        credit: "0.00",
        description: `اعمال پیش‌پرداخت روی فاکتور خرید ${inv.invoiceNumber}`,
      });
    }

    const [finalized] = await tx
      .update(purchaseInvoices)
      .set({
        status: "CONFIRMED",
        paidAmount: formatDecimal(addDec(directPaid, advanceApplied), 2),
        remainingAmount: formatDecimal(remainingPayable, 2),
        stockDocumentId: stockRes.document.id,
        journalEntryId: journalRes.entry.id,
        version: inv.version + 1,
        syncSeq: Date.now(),
        updatedAt: new Date(),
      })
      .where(eq(purchaseInvoices.id, inv.id))
      .returning();

    return {
      invoice: finalized,
      supplierAdvanceApplied: formatDecimal(advanceApplied, 2),
      stockDocument: stockRes.document,
      journalEntry: journalRes.entry,
    };
  });

  await recordAuditLog({
    organizationId: params.organizationId,
    actorUserId: params.actorUserId,
    actorEmail: params.actorEmail,
    scope: "ORGANIZATION",
    action: "PURCHASE_INVOICE_FINALIZED",
    entityType: "PURCHASE_INVOICE",
    entityId: result.invoice.id,
    ipAddress: params.ipAddress,
    metadata: {
      invoiceNumber: result.invoice.invoiceNumber,
      totalAmount: result.invoice.totalAmount,
      journalEntryId: result.journalEntry.id,
    },
  });

  return result;
}

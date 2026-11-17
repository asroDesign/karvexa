import { and, eq } from "drizzle-orm";
import {
  accounts,
  chequeEvents,
  cheques,
  contactTransactions,
  financialAccounts,
  financialTransactions,
  invoicePaymentAllocations,
  loyaltyAccounts,
  loyaltyTransactions,
  purchaseInvoiceItems,
  purchaseInvoices,
  salesInvoiceItems,
  salesInvoices,
} from "@/db/schema";
import { gregorianIsoToJalali, resolveCanonicalDate } from "@/lib/jalali";
import { ensurePrompt05OrgDefaults } from "@/db/seed-prompt05";
import {
  addDec,
  formatDecimal,
  gtDec,
  isPositiveDec,
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

    const orgFinAccs = await tx
      .select()
      .from(financialAccounts)
      .where(eq(financialAccounts.organizationId, params.organizationId));

    const jLines: JournalLineInput[] = [];
    const savedAllocations = [];

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
      if (!targetFin) {
        if (alloc.paymentMethod === "CASH") {
          targetFin = orgFinAccs.find((f) => f.accountType === "CASHBOX" || f.accountType === "CASH") ?? orgFinAccs[0];
        } else if (alloc.paymentMethod === "POS" || alloc.paymentMethod === "CARD_TERMINAL") {
          targetFin = orgFinAccs.find((f) => f.accountType === "POS" || f.accountType === "CARD_TERMINAL") ?? orgFinAccs.find((f) => f.accountType === "BANK");
        } else {
          targetFin = orgFinAccs.find((f) => f.accountType === "BANK") ?? orgFinAccs[0];
        }
      }

      if (targetFin) {
        const nextBal = addDec(targetFin.balance, alloc.amount);
        await tx
          .update(financialAccounts)
          .set({ balance: formatDecimal(nextBal, 2) })
          .where(eq(financialAccounts.id, targetFin.id));
        targetFin.balance = formatDecimal(nextBal, 2);

        await tx.insert(financialTransactions).values({
          organizationId: params.organizationId,
          financialAccountId: targetFin.id,
          contactId: inv.contactId,
          txType: "RECEIPT",
          paymentMethod: alloc.paymentMethod,
          amount: alloc.amount,
          txDate: inv.invoiceDate,
          trackingNumber: alloc.referenceNumber ?? null,
          relatedDocumentType: "SALES_INVOICE",
          relatedDocumentId: inv.id,
          description: `دریافت (${alloc.paymentMethod}) بابت فاکتور فروش ${inv.invoiceNumber}`,
          createdBy: params.actorUserId,
        });
      }

      const glId =
        targetFin?.accountId ??
        (alloc.paymentMethod === "CASH" ? cashAcc.id : bankAcc.id);

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
    if (isPositiveDec(totalAllocated)) {
      await tx.insert(contactTransactions).values({
        organizationId: params.organizationId,
        contactId: inv.contactId,
        referenceType: "TREASURY",
        referenceId: inv.id,
        txDate: inv.invoiceDate,
        debit: "0.00",
        credit: formatDecimal(totalAllocated, 2),
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
  financialAccountId: string;
  paymentMethod: "CASH" | "POS" | "BANK_TRANSFER" | "WALLET" | "CHEQUE" | "OTHER";
  amount: string;
  paidAt: string;
  referenceNumber?: string | null;
  idempotencyKey?: string | null;
  actorUserId: string;
  actorEmail: string;
  ipAddress?: string | null;
}) {
  if (!isPositiveDec(parseDecimal(params.amount))) {
    throw new ApiError(422, "AMOUNT_INVALID", "مبلغ پرداخت باید بزرگ‌تر از صفر باشد.");
  }

  const result = await withTenantTransaction(params.organizationId, async (tx) => {
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
        const [invRow] = await tx
          .select()
          .from(salesInvoices)
          .where(eq(salesInvoices.id, dup.salesInvoiceId))
          .limit(1);
        return { allocation: dup, invoice: invRow, replayed: true };
      }
    }

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

    const [fa] = await tx
      .select()
      .from(financialAccounts)
      .where(
        and(
          eq(financialAccounts.id, params.financialAccountId),
          eq(financialAccounts.organizationId, params.organizationId)
        )
      )
      .limit(1);
    if (!fa) throw new ApiError(404, "TREASURY_ACCOUNT_NOT_FOUND", "حساب خزانه یافت نشد.");

    const arAcc = (await findSystemAccount(tx, params.organizationId, "AR"))!;
    const cashAcc = (await findSystemAccount(tx, params.organizationId, "CASH"))!;
    const bankAcc = (await findSystemAccount(tx, params.organizationId, "BANK"))!;
    const glId = fa.accountId ?? (fa.accountType === "CASHBOX" ? cashAcc.id : bankAcc.id);

    // 1. Update Treasury Account Balance
    const nextFaBal = addDec(fa.balance, params.amount);
    await tx
      .update(financialAccounts)
      .set({ balance: formatDecimal(nextFaBal, 2) })
      .where(eq(financialAccounts.id, fa.id));

    // 2. Post balanced Double-Entry Journal: DR Cash/Bank / CR AR
    const jRes = await createJournalEntryTx(tx, {
      organizationId: params.organizationId,
      actorUserId: params.actorUserId,
      actorEmail: params.actorEmail,
      entryDate: params.paidAt,
      description: `دریافت مطالبات مشتری بابت فاکتور فروش ${inv.invoiceNumber}`,
      referenceType: "TREASURY",
      referenceId: inv.id,
      postImmediately: true,
      lines: [
        { accountId: glId, debit: params.amount, credit: "0.00", description: `واریز به ${fa.name}` },
        { accountId: arAcc.id, contactId: inv.contactId, debit: "0.00", credit: params.amount, description: `کاهش مانده بدهی مشتری بابت ${inv.invoiceNumber}` },
      ],
    });

    // 3. Record Treasury Transaction + Contact Ledger Credit + Payment Allocation
    await tx.insert(financialTransactions).values({
      organizationId: params.organizationId,
      financialAccountId: fa.id,
      contactId: inv.contactId,
      txType: "RECEIPT",
      paymentMethod: params.paymentMethod,
      amount: params.amount,
      txDate: params.paidAt,
      trackingNumber: params.referenceNumber ?? null,
      relatedDocumentType: "SALES_INVOICE",
      relatedDocumentId: inv.id,
      journalEntryId: jRes.entry.id,
      description: `تسویه بدهی فاکتور ${inv.invoiceNumber}`,
      createdBy: params.actorUserId,
    });

    await tx.insert(contactTransactions).values({
      organizationId: params.organizationId,
      contactId: inv.contactId,
      referenceType: "TREASURY",
      referenceId: inv.id,
      txDate: params.paidAt,
      debit: "0.00",
      credit: params.amount,
      description: `دریافت وجه بابت فاکتور ${inv.invoiceNumber}`,
    });

    const [alloc] = await tx
      .insert(invoicePaymentAllocations)
      .values({
        organizationId: params.organizationId,
        salesInvoiceId: inv.id,
        financialAccountId: fa.id,
        paymentMethod: params.paymentMethod,
        amount: params.amount,
        paidAt: params.paidAt,
        referenceNumber: params.referenceNumber ?? null,
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
        updatedAt: new Date(),
      })
      .where(eq(salesInvoices.id, inv.id))
      .returning();

    return { allocation: alloc, invoice: updatedInv, journalEntry: jRes.entry, replayed: false };
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
}) {
  const result = await withTenantTransaction(params.organizationId, async (tx) => {
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

    const stockRes = await postStockDocumentTx(tx, {
      organizationId: params.organizationId,
      warehouseId: inv.warehouseId,
      documentType: "RECEIPT",
      documentDate: inv.invoiceDate,
      reason: `رسید ورود کالا بابت فاکتور خرید ${inv.invoiceNumber}`,
      referenceType: "PURCHASE_INVOICE",
      referenceId: inv.id,
      actorUserId: params.actorUserId,
      items: items.map((it) => ({
        productId: it.productId,
        direction: "IN",
        quantity: it.quantity,
        unitCost: it.unitPrice,
      })),
    });

    const invAcc = (await findSystemAccount(tx, params.organizationId, "INVENTORY"))!;
    const apAcc = (await findSystemAccount(tx, params.organizationId, "AP"))!;

    const journalRes = await createJournalEntryTx(tx, {
      organizationId: params.organizationId,
      actorUserId: params.actorUserId,
      actorEmail: params.actorEmail,
      entryDate: inv.invoiceDate,
      description: `سند اتوماتیک فاکتور خرید شماره ${inv.invoiceNumber}`,
      referenceType: "PURCHASE_INVOICE",
      referenceId: inv.id,
      postImmediately: true,
      lines: [
        {
          accountId: invAcc.id,
          debit: inv.totalAmount,
          credit: "0.00",
          description: `افزایش موجودی کالا بابت فاکتور خرید ${inv.invoiceNumber}`,
        },
        {
          accountId: apAcc.id,
          contactId: inv.contactId,
          debit: "0.00",
          credit: inv.totalAmount,
          description: `بستانکار تأمین‌کننده بابت فاکتور خرید ${inv.invoiceNumber}`,
        },
      ],
    });

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

    const [finalized] = await tx
      .update(purchaseInvoices)
      .set({
        status: "CONFIRMED",
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

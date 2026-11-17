import { NextRequest } from "next/server";
import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { db } from "@/db";
import {
  accounts,
  cheques,
  contacts,
  financialAccounts,
  financialTransactions,
  journalEntries,
  journalEntryLines,
  ownerWithdrawals,
  personalTransactions,
  products,
  salesInvoices,
  salesReturns,
  syncConflicts,
} from "@/db/schema";
import { ensureSeeded } from "@/db/seed";
import { addDec, divDec, formatDecimal, isPositiveDec, parseDecimal, subDec } from "@/lib/decimal";
import { ApiError, ok } from "@/lib/errors";
import { hasOrgPermission, requireOrgContext } from "@/lib/tenant";
import { buildAccountingReports } from "@/modules/accounting/service";
import { getLiveStockBalances } from "@/modules/inventory/service";

function resolveDateRange(req: NextRequest): { from: string; to: string; days: string[]; rangeKey: string } {
  const sp = req.nextUrl.searchParams;
  const rangeKey = sp.get("range") || "30d";
  const today = new Date();
  const toIso = sp.get("to") || today.toISOString().slice(0, 10);
  let fromIso = sp.get("from");

  if (!fromIso) {
    const end = new Date(`${toIso}T00:00:00Z`);
    const start = new Date(end);
    if (rangeKey === "today") {
      // same day
    } else if (rangeKey === "7d") {
      start.setUTCDate(end.getUTCDate() - 6);
    } else if (rangeKey === "month") {
      start.setUTCDate(1);
    } else if (rangeKey === "prev_month") {
      start.setUTCMonth(end.getUTCMonth() - 1, 1);
      end.setUTCDate(0);
    } else {
      // default 30d
      start.setUTCDate(end.getUTCDate() - 29);
    }
    fromIso = start.toISOString().slice(0, 10);
  }

  // Generate every single calendar day between fromIso and toIso (cap 92 days)
  const days: string[] = [];
  const cur = new Date(`${fromIso}T00:00:00Z`);
  const endD = new Date(`${toIso}T00:00:00Z`);
  let guard = 0;
  while (cur <= endD && guard < 92) {
    days.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
    guard += 1;
  }

  return { from: fromIso, to: toIso, days, rangeKey };
}

export async function handleDashboardRoutes(
  req: NextRequest,
  method: string,
  segments: string[]
) {
  await ensureSeeded();
  if (method !== "GET") throw new ApiError(405, "METHOD_NOT_ALLOWED", "فقط متد GET مجاز است.");

  const sub = segments[1] ?? "overview"; // overview | charts
  const chartType = segments[2]; // revenue | sales | expenses | drilldown

  const ctx = await requireOrgContext(req, "org.dashboard.read");
  const orgId = ctx.organizationId;
  const canViewProfit = hasOrgPermission(ctx.permissions, "reports.profit.view");
  const canViewPersonal = hasOrgPermission(ctx.permissions, "personal_finance.view");

  // ============================================================================
  // GET /api/v1/dashboard/overview
  // ============================================================================
  if (sub === "overview") {
    const todayIso = new Date().toISOString().slice(0, 10);
    const [
      reports,
      stock,
      finAccs,
      orgSales,
      orgCheques,
      orgConflicts,
      orgProducts,
      orgWithdrawals,
      postedTodayLines,
    ] = await Promise.all([
      buildAccountingReports(orgId),
      getLiveStockBalances(orgId),
      db.select().from(financialAccounts).where(eq(financialAccounts.organizationId, orgId)),
      db.select().from(salesInvoices).where(eq(salesInvoices.organizationId, orgId)),
      db.select().from(cheques).where(eq(cheques.organizationId, orgId)),
      db
        .select()
        .from(syncConflicts)
        .where(and(eq(syncConflicts.organizationId, orgId), eq(syncConflicts.status, "OPEN"))),
      db.select().from(products).where(eq(products.organizationId, orgId)),
      canViewPersonal
        ? db.select().from(ownerWithdrawals).where(eq(ownerWithdrawals.organizationId, orgId))
        : Promise.resolve([]),
      db
        .select({
          accountType: accounts.accountType,
          systemRole: accounts.systemRole,
          debit: journalEntryLines.debit,
          credit: journalEntryLines.credit,
        })
        .from(journalEntryLines)
        .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
        .innerJoin(accounts, eq(journalEntryLines.accountId, accounts.id))
        .where(
          and(
            eq(journalEntries.organizationId, orgId),
            eq(journalEntries.entryDate, todayIso),
            inArray(journalEntries.status, ["POSTED", "REVERSED"])
          )
        ),
    ]);

    let todayRevenue = BigInt(0);
    let todayExpenses = BigInt(0);
    for (const l of postedTodayLines) {
      if (l.accountType === "REVENUE") {
        todayRevenue = addDec(todayRevenue, subDec(l.credit, l.debit));
      } else if (l.accountType === "EXPENSE" && l.systemRole !== "COGS") {
        todayExpenses = addDec(todayExpenses, subDec(l.debit, l.credit));
      }
    }

    let todaySales = BigInt(0);
    let unpaidInvoicesCount = 0;
    for (const s of orgSales) {
      if ((s.status === "CONFIRMED" || s.status === "FINALIZED") && s.invoiceDate === todayIso) {
        todaySales = addDec(todaySales, s.totalAmount);
      }
      if (
        (s.status === "CONFIRMED" || s.status === "FINALIZED") &&
        isPositiveDec(parseDecimal(s.remainingAmount))
      ) {
        unpaidInvoicesCount += 1;
      }
    }

    let cashBalance = BigInt(0);
    let bankBalance = BigInt(0);
    for (const fa of finAccs) {
      if (fa.accountType === "CASHBOX") cashBalance = addDec(cashBalance, fa.balance);
      else bankBalance = addDec(bankBalance, fa.balance);
    }

    const arRow = reports.trialBalance.find((r) => r.systemRole === "AR");
    const apRow = reports.trialBalance.find((r) => r.systemRole === "AP");
    const cogsRow = reports.trialBalance.find((r) => r.systemRole === "COGS");
    const grossProfit = subDec(reports.profitAndLoss.totalRevenue, cogsRow?.netBalance ?? "0.00");

    let ownerWithdrawalsTotal = BigInt(0);
    for (const w of orgWithdrawals) {
      if (w.status === "CONFIRMED") ownerWithdrawalsTotal = addDec(ownerWithdrawalsTotal, w.amount);
    }

    // Operational Alerts (role-aware!)
    const lowStockCount = orgProducts.filter((p) => {
      const stockSum = stock.balances
        .filter((b) => b.productId === p.id)
        .reduce((acc, b) => addDec(acc, b.onHandQty), BigInt(0));
      return isPositiveDec(parseDecimal(p.minStockLevel)) && stockSum <= parseDecimal(p.minStockLevel);
    }).length;

    const weekAhead = new Date(Date.now() + 7 * 86400 * 1000).toISOString().slice(0, 10);
    const upcomingChequesCount = orgCheques.filter(
      (c) => !["CLEARED", "CASHED", "CANCELLED"].includes(c.status) && c.dueDate <= weekAhead
    ).length;

    const alerts: Array<{ code: string; severity: "info" | "warn" | "critical"; title: string; count: number }> = [];
    if (lowStockCount > 0) {
      alerts.push({ code: "LOW_STOCK", severity: "warn", title: "کالاهای در آستانه اتمام موجودی", count: lowStockCount });
    }
    if (upcomingChequesCount > 0) {
      alerts.push({ code: "UPCOMING_CHEQUES", severity: "warn", title: "چک‌های با سررسید نزدیک / معوق", count: upcomingChequesCount });
    }
    if (unpaidInvoicesCount > 0) {
      alerts.push({ code: "UNPAID_INVOICES", severity: "info", title: "فاکتورهای فروش با مانده پرداخت‌نشده", count: unpaidInvoicesCount });
    }
    if (orgConflicts.length > 0) {
      alerts.push({ code: "SYNC_CONFLICTS", severity: "critical", title: "تعارض‌های همگام‌سازی آفلاین باز", count: orgConflicts.length });
    }
    if (ctx.subscriptionStatus === "EXPIRED") {
      alerts.push({ code: "SUBSCRIPTION_EXPIRED", severity: "critical", title: "اشتراک سازمان منقضی شده است", count: 1 });
    }

    return ok({
      organization: {
        id: ctx.organization.id,
        name: ctx.organization.name,
        currency: ctx.organization.baseCurrency,
        timezone: ctx.organization.timezone,
      },
      as_of_utc: new Date().toISOString(),
      data_freshness: "AUTHORITATIVE_LIVE",
      permissions: {
        can_view_profit: canViewProfit,
        can_view_personal_finance: canViewPersonal,
      },
      summary: {
        today_revenue: formatDecimal(todayRevenue, 2),
        today_sales: formatDecimal(todaySales, 2),
        today_expenses: formatDecimal(todayExpenses, 2),
        total_revenue: reports.profitAndLoss.totalRevenue,
        total_expenses: reports.profitAndLoss.totalExpense,
        gross_profit: canViewProfit ? formatDecimal(grossProfit, 2) : null,
        net_profit: canViewProfit ? reports.profitAndLoss.netProfit : null,
        cash_balance: formatDecimal(cashBalance, 2),
        bank_balance: formatDecimal(bankBalance, 2),
        customer_receivables: arRow?.netBalance ?? "0.00",
        supplier_payables: apRow?.netBalance ?? "0.00",
        inventory_value: stock.totalValuation,
        owner_withdrawals: canViewPersonal ? formatDecimal(ownerWithdrawalsTotal, 2) : null,
        is_trial_balanced: reports.isTrialBalanced,
      },
      alerts,
    });
  }

  // ============================================================================
  // GET /api/v1/dashboard/charts/{revenue|sales|expenses|drilldown}
  // ============================================================================
  if (sub === "charts") {
    const { from, to, days, rangeKey } = resolveDateRange(req);

    // 1. Daily Revenue Chart (§5.2 — Recognized Accounting Revenue vs Cash Received, NEVER counting AR settlement as new revenue!)
    if (chartType === "revenue") {
      const metricMode = req.nextUrl.searchParams.get("metric") || "recognized_revenue";

      const [postedRevLines, cashReceipts] = await Promise.all([
        db
          .select({
            entryDate: journalEntries.entryDate,
            debit: journalEntryLines.debit,
            credit: journalEntryLines.credit,
            referenceType: journalEntries.referenceType,
          })
          .from(journalEntryLines)
          .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
          .innerJoin(accounts, eq(journalEntryLines.accountId, accounts.id))
          .where(
            and(
              eq(journalEntries.organizationId, orgId),
              inArray(journalEntries.status, ["POSTED", "REVERSED"]),
              eq(accounts.accountType, "REVENUE"),
              gte(journalEntries.entryDate, from),
              lte(journalEntries.entryDate, to)
            )
          ),
        db
          .select()
          .from(financialTransactions)
          .where(
            and(
              eq(financialTransactions.organizationId, orgId),
              inArray(financialTransactions.txType, ["RECEIPT", "INCOME"]),
              gte(financialTransactions.txDate, from),
              lte(financialTransactions.txDate, to)
            )
          ),
      ]);

      const revByDay = new Map<string, bigint>();
      const cashByDay = new Map<string, bigint>();
      for (const d of days) {
        revByDay.set(d, BigInt(0));
        cashByDay.set(d, BigInt(0));
      }

      for (const l of postedRevLines) {
        if (l.referenceType === "CLOSING") continue; // exclude year-end closing entry!
        const net = subDec(l.credit, l.debit);
        revByDay.set(l.entryDate, addDec(revByDay.get(l.entryDate) ?? BigInt(0), net));
      }
      for (const tx of cashReceipts) {
        if (tx.status === "CANCELLED") continue;
        cashByDay.set(tx.txDate, addDec(cashByDay.get(tx.txDate) ?? BigInt(0), tx.amount));
      }

      let totalRecognized = BigInt(0);
      let totalCash = BigInt(0);
      const series = days.map((d) => {
        const rec = revByDay.get(d) ?? BigInt(0);
        const cash = cashByDay.get(d) ?? BigInt(0);
        totalRecognized = addDec(totalRecognized, rec);
        totalCash = addDec(totalCash, cash);
        return {
          date: d,
          recognized_revenue: formatDecimal(rec, 2),
          cash_received: formatDecimal(cash, 2),
          value: metricMode === "cash_received" ? formatDecimal(cash, 2) : formatDecimal(rec, 2),
        };
      });

      return ok({
        metric: metricMode,
        range: rangeKey,
        from,
        to,
        currency: ctx.organization.baseCurrency,
        totals: {
          recognized_revenue: formatDecimal(totalRecognized, 2),
          cash_received: formatDecimal(totalCash, 2),
        },
        series,
      });
    }

    // 2. Daily Sales Chart (§5.3 — Confirmed Sales only: gross, discount, returns, net, count, avg)
    if (chartType === "sales") {
      const [invs, rets] = await Promise.all([
        db
          .select()
          .from(salesInvoices)
          .where(
            and(
              eq(salesInvoices.organizationId, orgId),
              inArray(salesInvoices.status, ["CONFIRMED", "FINALIZED"]),
              gte(salesInvoices.invoiceDate, from),
              lte(salesInvoices.invoiceDate, to)
            )
          ),
        db
          .select()
          .from(salesReturns)
          .where(
            and(
              eq(salesReturns.organizationId, orgId),
              gte(salesReturns.returnDate, from),
              lte(salesReturns.returnDate, to)
            )
          ),
      ]);

      const bucketMap = new Map<
        string,
        { count: number; gross: bigint; discounts: bigint; returns: bigint }
      >();
      for (const d of days) {
        bucketMap.set(d, { count: 0, gross: BigInt(0), discounts: BigInt(0), returns: BigInt(0) });
      }

      for (const inv of invs) {
        const b = bucketMap.get(inv.invoiceDate);
        if (!b) continue;
        b.count += 1;
        b.gross = addDec(b.gross, inv.totalAmount);
        b.discounts = addDec(b.discounts, inv.discountAmount);
      }
      for (const r of rets) {
        const b = bucketMap.get(r.returnDate);
        if (!b) continue;
        b.returns = addDec(b.returns, r.totalAmount);
      }

      let totalInvoices = 0;
      let totalGross = BigInt(0);
      let totalDiscounts = BigInt(0);
      let totalReturns = BigInt(0);

      const series = days.map((d) => {
        const b = bucketMap.get(d)!;
        const net = subDec(b.gross, b.returns);
        const avg = b.count > 0 ? divDec(net, `${b.count}.0000`) : BigInt(0);
        totalInvoices += b.count;
        totalGross = addDec(totalGross, b.gross);
        totalDiscounts = addDec(totalDiscounts, b.discounts);
        totalReturns = addDec(totalReturns, b.returns);
        return {
          date: d,
          invoices_count: b.count,
          gross_sales: formatDecimal(b.gross, 2),
          discounts: formatDecimal(b.discounts, 2),
          returns: formatDecimal(b.returns, 2),
          net_sales: formatDecimal(net, 2),
          avg_invoice_value: formatDecimal(avg, 2),
        };
      });

      const totalNet = subDec(totalGross, totalReturns);
      return ok({
        range: rangeKey,
        from,
        to,
        currency: ctx.organization.baseCurrency,
        totals: {
          invoices_count: totalInvoices,
          gross_sales: formatDecimal(totalGross, 2),
          discounts: formatDecimal(totalDiscounts, 2),
          returns: formatDecimal(totalReturns, 2),
          net_sales: formatDecimal(totalNet, 2),
          avg_invoice_value:
            totalInvoices > 0 ? formatDecimal(divDec(totalNet, `${totalInvoices}.0000`), 2) : "0.00",
        },
        series,
      });
    }

    // 3. Daily Business Expense Chart (§5.4 — STRICTLY excludes Personal Finance expenses!)
    if (chartType === "expenses") {
      const includePersonal =
        req.nextUrl.searchParams.get("include_personal") === "true" && canViewPersonal;

      const [postedExpLines, personalExpRows] = await Promise.all([
        db
          .select({
            entryDate: journalEntries.entryDate,
            accountName: accounts.name,
            systemRole: accounts.systemRole,
            debit: journalEntryLines.debit,
            credit: journalEntryLines.credit,
            referenceType: journalEntries.referenceType,
          })
          .from(journalEntryLines)
          .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
          .innerJoin(accounts, eq(journalEntryLines.accountId, accounts.id))
          .where(
            and(
              eq(journalEntries.organizationId, orgId),
              inArray(journalEntries.status, ["POSTED", "REVERSED"]),
              eq(accounts.accountType, "EXPENSE"),
              gte(journalEntries.entryDate, from),
              lte(journalEntries.entryDate, to)
            )
          ),
        includePersonal
          ? db
              .select()
              .from(personalTransactions)
              .where(
                and(
                  eq(personalTransactions.organizationId, orgId),
                  eq(personalTransactions.ownerUserId, ctx.userId),
                  inArray(personalTransactions.txType, [
                    "PERSONAL_EXPENSE",
                    "LOAN_PAYMENT",
                    "RECURRING_PAYMENT",
                  ]),
                  gte(personalTransactions.txDate, from),
                  lte(personalTransactions.txDate, to)
                )
              )
          : Promise.resolve([]),
      ]);

      const bizByDay = new Map<string, { total: bigint; count: number }>();
      const perByDay = new Map<string, bigint>();
      const byCategory = new Map<string, bigint>();

      for (const d of days) {
        bizByDay.set(d, { total: BigInt(0), count: 0 });
        perByDay.set(d, BigInt(0));
      }

      for (const l of postedExpLines) {
        if (l.referenceType === "CLOSING" || l.systemRole === "COGS") continue;
        const net = subDec(l.debit, l.credit);
        const cur = bizByDay.get(l.entryDate);
        if (cur) {
          cur.total = addDec(cur.total, net);
          cur.count += 1;
        }
        byCategory.set(l.accountName, addDec(byCategory.get(l.accountName) ?? BigInt(0), net));
      }

      for (const p of personalExpRows) {
        if (p.status !== "CONFIRMED") continue;
        perByDay.set(p.txDate, addDec(perByDay.get(p.txDate) ?? BigInt(0), p.amount));
      }

      let totalBizExp = BigInt(0);
      let totalExpCount = 0;
      let totalPersonalExp = BigInt(0);

      const series = days.map((d) => {
        const b = bizByDay.get(d)!;
        const p = perByDay.get(d) ?? BigInt(0);
        totalBizExp = addDec(totalBizExp, b.total);
        totalExpCount += b.count;
        totalPersonalExp = addDec(totalPersonalExp, p);
        return {
          date: d,
          business_expenses: formatDecimal(b.total, 2),
          expense_count: b.count,
          ...(includePersonal ? { personal_expenses: formatDecimal(p, 2) } : {}),
        };
      });

      return ok({
        range: rangeKey,
        from,
        to,
        currency: ctx.organization.baseCurrency,
        personal_included: includePersonal,
        totals: {
          business_expenses: formatDecimal(totalBizExp, 2),
          expense_count: totalExpCount,
          ...(includePersonal ? { personal_expenses: formatDecimal(totalPersonalExp, 2) } : {}),
        },
        category_breakdown: Array.from(byCategory.entries()).map(([name, amt]) => ({
          category: name,
          amount: formatDecimal(amt, 2),
        })),
        series,
      });
    }

    // 4. Interactive Chart Drill-Down (§5.6 — exact underlying records for clicked date!)
    if (chartType === "drilldown") {
      const metric = req.nextUrl.searchParams.get("metric") || "sales";
      const dateStr = req.nextUrl.searchParams.get("date");
      if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        throw new ApiError(422, "DATE_INVALID", "پارامتر date با فرمت YYYY-MM-DD الزامی است.");
      }

      if (metric === "sales") {
        const [invs, allContacts] = await Promise.all([
          db
            .select()
            .from(salesInvoices)
            .where(
              and(
                eq(salesInvoices.organizationId, orgId),
                inArray(salesInvoices.status, ["CONFIRMED", "FINALIZED"]),
                eq(salesInvoices.invoiceDate, dateStr)
              )
            )
            .orderBy(desc(salesInvoices.createdAt)),
          db.select().from(contacts).where(eq(contacts.organizationId, orgId)),
        ]);
        const cMap = new Map(allContacts.map((c) => [c.id, c.name]));
        return ok({
          metric: "sales",
          date: dateStr,
          records: invs.map((i) => ({
            id: i.id,
            document_number: i.invoiceNumber,
            customer_name: cMap.get(i.contactId) ?? "",
            amount: i.totalAmount,
            paid_amount: i.paidAmount,
            status: i.status,
            payment_status: i.paymentStatus,
          })),
        });
      }

      const targetAccType = metric === "expenses" ? "EXPENSE" : "REVENUE";
      const lines = await db
        .select({
          journalId: journalEntries.id,
          entryNumber: journalEntries.entryNumber,
          entryDate: journalEntries.entryDate,
          referenceType: journalEntries.referenceType,
          accountCode: accounts.code,
          accountName: accounts.name,
          systemRole: accounts.systemRole,
          description: journalEntryLines.description,
          debit: journalEntryLines.debit,
          credit: journalEntryLines.credit,
        })
        .from(journalEntryLines)
        .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
        .innerJoin(accounts, eq(journalEntryLines.accountId, accounts.id))
        .where(
          and(
            eq(journalEntries.organizationId, orgId),
            eq(journalEntries.entryDate, dateStr),
            inArray(journalEntries.status, ["POSTED", "REVERSED"]),
            eq(accounts.accountType, targetAccType)
          )
        );

      const filtered = lines.filter(
        (l) => l.referenceType !== "CLOSING" && !(metric === "expenses" && l.systemRole === "COGS")
      );

      return ok({
        metric,
        date: dateStr,
        records: filtered.map((l) => ({
          id: l.journalId,
          document_number: `سند #${l.entryNumber}`,
          account: `${l.accountCode} — ${l.accountName}`,
          description: l.description,
          amount:
            metric === "expenses"
              ? formatDecimal(subDec(l.debit, l.credit), 2)
              : formatDecimal(subDec(l.credit, l.debit), 2),
          source_type: l.referenceType,
        })),
      });
    }
  }

  throw new ApiError(404, "ROUTE_NOT_FOUND", "مسیر داشبورد یافت نشد.");
}

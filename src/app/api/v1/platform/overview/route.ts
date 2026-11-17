import { NextRequest } from "next/server";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  auditLogs,
  devices,
  organizations,
  paymentTransactions,
  subscriptions,
  supportTickets,
  syncBatches,
  syncConflicts,
  systemErrorLogs,
  users,
} from "@/db/schema";
import { handleApiError, ok } from "@/lib/errors";
import { requirePlatformAdmin } from "@/lib/tenant";

export async function GET(req: NextRequest) {
  try {
    await requirePlatformAdmin(req, "platform.dashboard.read");

    const [
      [orgStats],
      [userStats],
      [deviceStats],
      [conflictStats],
      [errorStats],
      [ticketStats],
      [paymentStats],
      recentAudits,
      recentBatches,
      activeSubs,
    ] = await Promise.all([
      db.select({ total: sql<number>`count(*)::int` }).from(organizations),
      db.select({ total: sql<number>`count(*)::int` }).from(users),
      db.select({ total: sql<number>`count(*)::int` }).from(devices),
      db
        .select({ total: sql<number>`count(*)::int` })
        .from(syncConflicts)
        .where(eq(syncConflicts.status, "OPEN")),
      db
        .select({ total: sql<number>`count(*)::int` })
        .from(systemErrorLogs)
        .where(eq(systemErrorLogs.status, "OPEN")),
      db
        .select({ total: sql<number>`count(*)::int` })
        .from(supportTickets)
        .where(eq(supportTickets.status, "OPEN")),
      db
        .select({
          totalCount: sql<number>`count(*)::int`,
          totalRevenue: sql<string>`COALESCE(SUM(${paymentTransactions.amountIrr}), 0)::text`,
        })
        .from(paymentTransactions)
        .where(eq(paymentTransactions.status, "VERIFIED")),
      db.select().from(auditLogs).orderBy(desc(auditLogs.createdAt)).limit(8),
      db.select().from(syncBatches).orderBy(desc(syncBatches.createdAt)).limit(6),
      db.select().from(subscriptions),
    ]);

    const activeSubsCount = activeSubs.filter(
      (s) => s.status === "ACTIVE" && s.expiresAt.getTime() > Date.now()
    ).length;
    const expiredSubsCount = activeSubs.filter(
      (s) => s.status === "EXPIRED" || s.expiresAt.getTime() <= Date.now()
    ).length;

    return ok({
      kpis: {
        organizationsCount: orgStats?.total ?? 0,
        usersCount: userStats?.total ?? 0,
        devicesCount: deviceStats?.total ?? 0,
        openSyncConflicts: conflictStats?.total ?? 0,
        openErrorLogs: errorStats?.total ?? 0,
        openSupportTickets: ticketStats?.total ?? 0,
        verifiedPaymentsCount: paymentStats?.totalCount ?? 0,
        totalRevenueIrr: paymentStats?.totalRevenue ?? "0.00",
        activeSubscriptions: activeSubsCount,
        expiredSubscriptions: expiredSubsCount,
      },
      recentAudits,
      recentBatches,
    });
  } catch (err) {
    return handleApiError(err);
  }
}

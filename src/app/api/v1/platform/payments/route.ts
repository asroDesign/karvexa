import { NextRequest } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  organizations,
  paymentTransactions,
  plans,
  purchaseReceipts,
} from "@/db/schema";
import { handleApiError, ok } from "@/lib/errors";
import { requirePlatformAdmin } from "@/lib/tenant";

export async function GET(req: NextRequest) {
  try {
    await requirePlatformAdmin(req, "platform.payments.read");

    const [payments, receipts] = await Promise.all([
      db
        .select({
          payment: paymentTransactions,
          orgName: organizations.name,
          planNameFa: plans.nameFa,
        })
        .from(paymentTransactions)
        .innerJoin(organizations, eq(paymentTransactions.organizationId, organizations.id))
        .leftJoin(plans, eq(paymentTransactions.planId, plans.id))
        .orderBy(desc(paymentTransactions.createdAt))
        .limit(100),
      db
        .select({
          receipt: purchaseReceipts,
          orgName: organizations.name,
        })
        .from(purchaseReceipts)
        .innerJoin(organizations, eq(purchaseReceipts.organizationId, organizations.id))
        .orderBy(desc(purchaseReceipts.verifiedAt))
        .limit(100),
    ]);

    return ok({ payments, receipts });
  } catch (err) {
    return handleApiError(err);
  }
}

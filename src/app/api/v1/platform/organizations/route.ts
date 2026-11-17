import { NextRequest } from "next/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  organizationMembers,
  organizations,
  plans,
  subscriptions,
} from "@/db/schema";
import { bootstrapOrganizationDefaults } from "@/db/seed";
import { recordAuditLog } from "@/lib/audit";
import { ApiError, handleApiError, ok } from "@/lib/errors";
import { requirePlatformAdmin } from "@/lib/tenant";

const createOrgSchema = z.object({
  name: z.string().min(2, "نام کسب‌وکار حداقل ۲ کاراکتر باشد."),
  legalName: z.string().optional(),
  businessType: z
    .enum(["RETAIL", "WHOLESALE", "SERVICES", "MANUFACTURING", "DISTRIBUTION"])
    .default("RETAIL"),
  economicCode: z.string().optional(),
  nationalId: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional().or(z.literal("")),
  address: z.string().optional(),
  baseCurrency: z.enum(["IRR", "IRT", "USD", "EUR", "AED"]).default("IRR"),
  costingMethod: z.enum(["FIFO", "WEIGHTED_AVERAGE"]).default("WEIGHTED_AVERAGE"),
  negativeStockPolicy: z.enum(["ALLOW", "WARN", "BLOCK"]).default("BLOCK"),
  planCode: z.string().default("PRO"),
});

const patchOrgSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["ACTIVE", "SUSPENDED", "ARCHIVED"]).optional(),
  costingMethod: z.enum(["FIFO", "WEIGHTED_AVERAGE"]).optional(),
  negativeStockPolicy: z.enum(["ALLOW", "WARN", "BLOCK"]).optional(),
  name: z.string().min(2).optional(),
});

export async function GET(req: NextRequest) {
  try {
    await requirePlatformAdmin(req, "platform.organizations.read");

    const allOrgs = await db
      .select()
      .from(organizations)
      .orderBy(desc(organizations.createdAt));
    const allSubs = await db
      .select({
        sub: subscriptions,
        plan: plans,
      })
      .from(subscriptions)
      .innerJoin(plans, eq(subscriptions.planId, plans.id))
      .orderBy(desc(subscriptions.expiresAt));
    const allMembers = await db.select().from(organizationMembers);

    const enriched = allOrgs.map((org) => {
      const sub = allSubs.find((s) => s.sub.organizationId === org.id);
      const membersCount = allMembers.filter((m) => m.organizationId === org.id).length;
      const isExpired = sub
        ? sub.sub.status === "EXPIRED" || sub.sub.expiresAt.getTime() < Date.now()
        : true;
      return {
        ...org,
        membersCount,
        subscription: sub
          ? {
              planCode: sub.plan.code,
              planNameFa: sub.plan.nameFa,
              status: isExpired ? "EXPIRED" : sub.sub.status,
              expiresAt: sub.sub.expiresAt,
              source: sub.sub.source,
            }
          : null,
      };
    });

    return ok({ organizations: enriched });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requirePlatformAdmin(req, "platform.organizations.write");
    const body = createOrgSchema.parse(await req.json());

    const created = await db.transaction(async (tx) => {
      const [org] = await tx
        .insert(organizations)
        .values({
          name: body.name,
          legalName: body.legalName || null,
          businessType: body.businessType,
          economicCode: body.economicCode || null,
          nationalId: body.nationalId || null,
          phone: body.phone || null,
          email: body.email || null,
          address: body.address || null,
          baseCurrency: body.baseCurrency,
          costingMethod: body.costingMethod,
          negativeStockPolicy: body.negativeStockPolicy,
          status: "ACTIVE",
        })
        .returning();

      await bootstrapOrganizationDefaults(tx, org.id);

      // Assign Admin as owner so they can inspect or assign others
      await tx.insert(organizationMembers).values({
        organizationId: org.id,
        userId: admin.userId,
        isOwner: true,
        status: "ACTIVE",
      });

      const [plan] = await tx
        .select()
        .from(plans)
        .where(eq(plans.code, body.planCode))
        .limit(1);

      if (plan) {
        const now = new Date();
        await tx.insert(subscriptions).values({
          organizationId: org.id,
          planId: plan.id,
          status: "ACTIVE",
          startsAt: now,
          expiresAt: new Date(now.getTime() + plan.billingDays * 86400 * 1000),
          source: "ADMIN",
        });
      }

      return org;
    });

    await recordAuditLog({
      organizationId: created.id,
      actorUserId: admin.userId,
      actorEmail: admin.email,
      scope: "PLATFORM",
      action: "ORGANIZATION_CREATED",
      entityType: "ORGANIZATION",
      entityId: created.id,
      ipAddress: admin.ipAddress,
      metadata: { name: created.name, planCode: body.planCode },
    });

    return ok({ organization: created }, 201);
  } catch (err) {
    return handleApiError(err);
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const admin = await requirePlatformAdmin(req, "platform.organizations.write");
    const body = patchOrgSchema.parse(await req.json());

    const [updated] = await db
      .update(organizations)
      .set({
        ...(body.status ? { status: body.status } : {}),
        ...(body.costingMethod ? { costingMethod: body.costingMethod } : {}),
        ...(body.negativeStockPolicy ? { negativeStockPolicy: body.negativeStockPolicy } : {}),
        ...(body.name ? { name: body.name } : {}),
        updatedAt: new Date(),
      })
      .where(eq(organizations.id, body.id))
      .returning();

    if (!updated) {
      throw new ApiError(404, "ORG_NOT_FOUND", "سازمان یافت نشد.");
    }

    await recordAuditLog({
      organizationId: updated.id,
      actorUserId: admin.userId,
      actorEmail: admin.email,
      scope: "PLATFORM",
      action: "ORGANIZATION_UPDATED",
      entityType: "ORGANIZATION",
      entityId: updated.id,
      ipAddress: admin.ipAddress,
      metadata: { status: updated.status, costingMethod: updated.costingMethod },
    });

    return ok({ organization: updated });
  } catch (err) {
    return handleApiError(err);
  }
}

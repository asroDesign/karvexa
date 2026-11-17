import { NextRequest } from "next/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  entitlements,
  features,
  organizations,
  planFeatures,
  plans,
  subscriptions,
} from "@/db/schema";
import { recordAuditLog } from "@/lib/audit";
import { handleApiError, ok } from "@/lib/errors";
import { requirePlatformAdmin } from "@/lib/tenant";

const overrideEntitlementSchema = z.object({
  organizationId: z.string().uuid(),
  featureCode: z.string().min(2),
  enabled: z.boolean(),
  limitValue: z.number().int().nullable().optional(),
});

export async function GET(req: NextRequest) {
  try {
    await requirePlatformAdmin(req, "platform.plans.manage");

    const [allPlans, allFeatures, allPlanFeats, allSubs, allOrgEntitlements] =
      await Promise.all([
        db.select().from(plans),
        db.select().from(features),
        db.select().from(planFeatures),
        db
          .select({
            sub: subscriptions,
            orgName: organizations.name,
            planNameFa: plans.nameFa,
            planCode: plans.code,
          })
          .from(subscriptions)
          .innerJoin(organizations, eq(subscriptions.organizationId, organizations.id))
          .innerJoin(plans, eq(subscriptions.planId, plans.id))
          .orderBy(desc(subscriptions.createdAt)),
        db
          .select({
            entitlement: entitlements,
            orgName: organizations.name,
          })
          .from(entitlements)
          .innerJoin(organizations, eq(entitlements.organizationId, organizations.id)),
      ]);

    return ok({
      plans: allPlans.map((p) => ({
        ...p,
        features: allPlanFeats
          .filter((pf) => pf.planId === p.id)
          .map((pf) => ({
            ...pf,
            feature: allFeatures.find((f) => f.id === pf.featureId),
          })),
      })),
      features: allFeatures,
      subscriptions: allSubs,
      entitlements: allOrgEntitlements,
    });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requirePlatformAdmin(req, "platform.plans.manage");
    const body = overrideEntitlementSchema.parse(await req.json());

    const [saved] = await db
      .insert(entitlements)
      .values({
        organizationId: body.organizationId,
        featureCode: body.featureCode,
        enabled: body.enabled,
        limitValue: body.limitValue ?? null,
        source: "OVERRIDE",
      })
      .onConflictDoUpdate({
        target: [entitlements.organizationId, entitlements.featureCode],
        set: {
          enabled: body.enabled,
          limitValue: body.limitValue ?? null,
          source: "OVERRIDE",
          updatedAt: new Date(),
        },
      })
      .returning();

    await recordAuditLog({
      organizationId: body.organizationId,
      actorUserId: admin.userId,
      actorEmail: admin.email,
      scope: "PLATFORM",
      action: "ENTITLEMENT_OVERRIDDEN",
      entityType: "ENTITLEMENT",
      entityId: saved.id,
      ipAddress: admin.ipAddress,
      metadata: { featureCode: body.featureCode, enabled: body.enabled },
    });

    return ok({ entitlement: saved });
  } catch (err) {
    return handleApiError(err);
  }
}

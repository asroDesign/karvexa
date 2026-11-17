import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { platformSettings } from "@/db/schema";
import { recordAuditLog } from "@/lib/audit";
import { handleApiError, ok } from "@/lib/errors";
import { requirePlatformAdmin } from "@/lib/tenant";

const patchSettingSchema = z.object({
  key: z.string().min(2),
  value: z.unknown(),
});

export async function GET(req: NextRequest) {
  try {
    await requirePlatformAdmin(req, "platform.settings.manage");
    const settings = await db.select().from(platformSettings);
    return ok({ settings });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const admin = await requirePlatformAdmin(req, "platform.settings.manage");
    const body = patchSettingSchema.parse(await req.json());

    const [updated] = await db
      .update(platformSettings)
      .set({ value: body.value, updatedAt: new Date() })
      .where(eq(platformSettings.key, body.key))
      .returning();

    await recordAuditLog({
      actorUserId: admin.userId,
      actorEmail: admin.email,
      scope: "PLATFORM",
      action: "PLATFORM_SETTING_UPDATED",
      entityType: "SETTING",
      entityId: body.key,
      ipAddress: admin.ipAddress,
      metadata: { key: body.key, value: body.value },
    });

    return ok({ setting: updated });
  } catch (err) {
    return handleApiError(err);
  }
}

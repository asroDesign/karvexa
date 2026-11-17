import { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { permissions, rolePermissions, roles } from "@/db/schema";
import { recordAuditLog } from "@/lib/audit";
import { handleApiError, ok } from "@/lib/errors";
import { requirePlatformAdmin } from "@/lib/tenant";

const toggleSchema = z.object({
  roleId: z.string().uuid(),
  permissionId: z.string().uuid(),
  enabled: z.boolean(),
});

export async function GET(req: NextRequest) {
  try {
    await requirePlatformAdmin(req, "platform.roles.manage");

    const [allRoles, allPerms, allLinks] = await Promise.all([
      db.select().from(roles),
      db.select().from(permissions),
      db.select().from(rolePermissions),
    ]);

    return ok({
      roles: allRoles.map((r) => ({
        ...r,
        permissionIds: allLinks
          .filter((l) => l.roleId === r.id)
          .map((l) => l.permissionId),
      })),
      permissions: allPerms,
    });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const admin = await requirePlatformAdmin(req, "platform.roles.manage");
    const body = toggleSchema.parse(await req.json());

    if (body.enabled) {
      await db
        .insert(rolePermissions)
        .values({ roleId: body.roleId, permissionId: body.permissionId })
        .onConflictDoNothing();
    } else {
      await db
        .delete(rolePermissions)
        .where(
          and(
            eq(rolePermissions.roleId, body.roleId),
            eq(rolePermissions.permissionId, body.permissionId)
          )
        );
    }

    await recordAuditLog({
      actorUserId: admin.userId,
      actorEmail: admin.email,
      scope: "PLATFORM",
      action: body.enabled ? "ROLE_PERMISSION_GRANTED" : "ROLE_PERMISSION_REVOKED",
      entityType: "ROLE",
      entityId: body.roleId,
      ipAddress: admin.ipAddress,
      metadata: { permissionId: body.permissionId, enabled: body.enabled },
    });

    return ok({ updated: true });
  } catch (err) {
    return handleApiError(err);
  }
}

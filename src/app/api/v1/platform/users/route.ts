import { NextRequest } from "next/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  organizationMembers,
  organizations,
  roles,
  userRoles,
  users,
} from "@/db/schema";
import { hashPassword } from "@/lib/auth";
import { recordAuditLog } from "@/lib/audit";
import { handleApiError, ok } from "@/lib/errors";
import { requirePlatformAdmin } from "@/lib/tenant";

const createUserSchema = z.object({
  fullName: z.string().min(2),
  email: z.string().email(),
  phone: z.string().optional(),
  password: z.string().min(6),
  isPlatformAdmin: z.boolean().default(false),
  organizationId: z.string().uuid().optional(),
  roleId: z.string().uuid().optional(),
});

export async function GET(req: NextRequest) {
  try {
    await requirePlatformAdmin(req, "platform.users.read");

    const allUsers = await db
      .select({
        id: users.id,
        email: users.email,
        phone: users.phone,
        fullName: users.fullName,
        isPlatformAdmin: users.isPlatformAdmin,
        status: users.status,
        lastLoginAt: users.lastLoginAt,
        createdAt: users.createdAt,
      })
      .from(users)
      .orderBy(desc(users.createdAt));

    const allMembers = await db
      .select({
        userId: organizationMembers.userId,
        organizationId: organizationMembers.organizationId,
        orgName: organizations.name,
        isOwner: organizationMembers.isOwner,
        status: organizationMembers.status,
      })
      .from(organizationMembers)
      .innerJoin(organizations, eq(organizationMembers.organizationId, organizations.id));

    const allUserRoles = await db
      .select({
        userId: userRoles.userId,
        organizationId: userRoles.organizationId,
        roleCode: roles.code,
        roleName: roles.name,
        scope: roles.scope,
      })
      .from(userRoles)
      .innerJoin(roles, eq(userRoles.roleId, roles.id));

    return ok({
      users: allUsers.map((u) => ({
        ...u,
        memberships: allMembers.filter((m) => m.userId === u.id),
        roles: allUserRoles.filter((r) => r.userId === u.id),
      })),
    });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requirePlatformAdmin(req, "platform.users.write");
    const body = createUserSchema.parse(await req.json());
    const passwordHash = await hashPassword(body.password);

    const created = await db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({
          fullName: body.fullName,
          email: body.email.trim().toLowerCase(),
          phone: body.phone || null,
          passwordHash,
          isPlatformAdmin: body.isPlatformAdmin,
          status: "ACTIVE",
        })
        .returning({
          id: users.id,
          email: users.email,
          fullName: users.fullName,
          isPlatformAdmin: users.isPlatformAdmin,
          status: users.status,
        });

      if (body.organizationId) {
        await tx.insert(organizationMembers).values({
          organizationId: body.organizationId,
          userId: user.id,
          status: "ACTIVE",
          isOwner: false,
        });
      }

      if (body.roleId) {
        await tx.insert(userRoles).values({
          userId: user.id,
          roleId: body.roleId,
          organizationId: body.organizationId ?? null,
        });
      }

      return user;
    });

    await recordAuditLog({
      organizationId: body.organizationId ?? null,
      actorUserId: admin.userId,
      actorEmail: admin.email,
      scope: "PLATFORM",
      action: "USER_CREATED",
      entityType: "USER",
      entityId: created.id,
      ipAddress: admin.ipAddress,
      metadata: { email: created.email, isPlatformAdmin: created.isPlatformAdmin },
    });

    return ok({ user: created }, 201);
  } catch (err) {
    return handleApiError(err);
  }
}

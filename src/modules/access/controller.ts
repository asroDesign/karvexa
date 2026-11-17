import crypto from "crypto";
import { NextRequest } from "next/server";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  auditLogs,
  organizationMembers,
  roles,
  sessions,
  userInvitations,
  userRoles,
  users,
} from "@/db/schema";
import { ensureSeeded } from "@/db/seed";
import { hashPassword } from "@/lib/auth";
import { recordAuditLog } from "@/lib/audit";
import { ApiError, ok } from "@/lib/errors";
import { requireAuth, requireOrgContext } from "@/lib/tenant";

/**
 * Master Prompt 06 §6 — Settings: Users & Access Management
 * Routes under /api/v1/access/*
 */
export async function handleAccessManagementRoutes(
  req: NextRequest,
  method: string,
  segments: string[]
) {
  await ensureSeeded();
  const sub = segments[1]; // members | invitations | audit-logs
  const id = segments[2];
  const action = segments[3];

  // ============================================================================
  // PUBLIC/AUTH ACCEPT INVITATION: POST /api/v1/access/invitations/accept
  // Single-use expiring token -> creates or links user -> activates membership!
  // ============================================================================
  if (sub === "invitations" && id === "accept" && method === "POST") {
    const body = z
      .object({
        token: z.string().min(12),
        full_name: z.string().min(2).optional(),
        password: z.string().min(6).optional(),
      })
      .parse(await req.json());

    const [inv] = await db
      .select()
      .from(userInvitations)
      .where(eq(userInvitations.token, body.token))
      .limit(1);

    if (!inv) {
      throw new ApiError(404, "INVITATION_INVALID", "لینک یا توکن دعوت‌نامه نامعتبر است.");
    }
    if (inv.status !== "PENDING") {
      throw new ApiError(
        409,
        "INVITATION_NOT_PENDING",
        `این دعوت‌نامه دیگر قابل استفاده نیست (وضعیت فعلی: ${inv.status}).`
      );
    }
    if (inv.expiresAt.getTime() <= Date.now()) {
      await db
        .update(userInvitations)
        .set({ status: "EXPIRED" })
        .where(eq(userInvitations.id, inv.id));
      throw new ApiError(410, "INVITATION_EXPIRED", "مهلت اعتبار این دعوت‌نامه به پایان رسیده است.");
    }

    // Check if an existing authenticated user or matching email/mobile account exists
    let existingUser = null;
    try {
      const auth = await requireAuth(req);
      [existingUser] = await db.select().from(users).where(eq(users.id, auth.userId)).limit(1);
    } catch {
      const conds = [eq(users.email, inv.email.toLowerCase())];
      if (inv.mobile) conds.push(eq(users.phone, inv.mobile));
      [existingUser] = await db
        .select()
        .from(users)
        .where(or(...conds))
        .limit(1);
    }

    const accepted = await db.transaction(async (tx) => {
      let targetUser = existingUser;
      if (!targetUser) {
        if (!body.password) {
          throw new ApiError(
            422,
            "PASSWORD_REQUIRED_FOR_NEW_USER",
            "برای ایجاد حساب کاربری جدید تعیین رمز عبور الزامی است."
          );
        }
        const pwHash = await hashPassword(body.password);
        [targetUser] = await tx
          .insert(users)
          .values({
            fullName: body.full_name || inv.inviteeName || inv.email.split("@")[0],
            email: inv.email.toLowerCase(),
            phone: inv.mobile ?? null,
            passwordHash: pwHash,
            isPlatformAdmin: false,
            status: "ACTIVE",
          })
          .returning();
      }

      // Create or reactivate Organization Membership with scoped branch/warehouse access
      const [member] = await tx
        .insert(organizationMembers)
        .values({
          organizationId: inv.organizationId,
          userId: targetUser.id,
          status: "ACTIVE",
          isOwner: false,
          branchAccess: inv.branchAccess,
          warehouseAccess: inv.warehouseAccess,
        })
        .onConflictDoUpdate({
          target: [organizationMembers.organizationId, organizationMembers.userId],
          set: {
            status: "ACTIVE",
            branchAccess: inv.branchAccess,
            warehouseAccess: inv.warehouseAccess,
            suspendedAt: null,
          },
        })
        .returning();

      if (inv.roleId) {
        await tx
          .insert(userRoles)
          .values({
            userId: targetUser.id,
            roleId: inv.roleId,
            organizationId: inv.organizationId,
          })
          .onConflictDoNothing();
      }

      const [updInv] = await tx
        .update(userInvitations)
        .set({ status: "ACCEPTED", acceptedAt: new Date() })
        .where(eq(userInvitations.id, inv.id))
        .returning();

      return {
        invitation: updInv,
        membership: member,
        user: {
          id: targetUser.id,
          full_name: targetUser.fullName,
          email: targetUser.email,
          mobile: targetUser.phone,
        },
      };
    });

    await recordAuditLog({
      organizationId: inv.organizationId,
      actorUserId: accepted.user.id,
      actorEmail: accepted.user.email,
      scope: "SECURITY",
      action: "INVITATION_ACCEPTED",
      entityType: "USER_INVITATION",
      entityId: inv.id,
      metadata: { roleId: inv.roleId, branchAccess: inv.branchAccess, warehouseAccess: inv.warehouseAccess },
    });

    return ok(accepted, 200);
  }

  // All other routes require organization context + users.manage / users.invite
  const ctx = await requireOrgContext(req, "users.manage");
  const orgId = ctx.organizationId;

  // ============================================================================
  // /api/v1/access/invitations
  // ============================================================================
  if (sub === "invitations") {
    if (method === "GET" && !id) {
      const [invs, allRoles] = await Promise.all([
        db
          .select()
          .from(userInvitations)
          .where(eq(userInvitations.organizationId, orgId))
          .orderBy(desc(userInvitations.createdAt)),
        db.select().from(roles),
      ]);
      const rMap = new Map(allRoles.map((r) => [r.id, r]));
      return ok(
        invs.map((inv) => ({
          ...inv,
          role_code: inv.roleId ? rMap.get(inv.roleId)?.code ?? null : null,
          role_name: inv.roleId ? rMap.get(inv.roleId)?.name ?? null : null,
          is_expired: inv.status === "PENDING" && inv.expiresAt.getTime() <= Date.now(),
        }))
      );
    }

    if (method === "POST" && !id) {
      await requireOrgContext(req, "users.invite");
      const body = z
        .object({
          invitee_name: z.string().optional(),
          email: z.string().email().optional(),
          mobile: z.string().min(10).optional(),
          role_code: z.string().default("SALESPERSON"),
          role_id: z.string().uuid().optional(),
          branch_access: z.array(z.string()).default(["ALL"]),
          warehouse_access: z.array(z.string()).default(["ALL"]),
          expires_in_hours: z.number().int().min(1).max(720).default(72),
          message: z.string().optional(),
        })
        .parse(await req.json());

      if (!body.email && !body.mobile) {
        throw new ApiError(422, "VALIDATION_ERROR", "حداقل یکی از ایمیل یا شماره موبایل برای دعوت الزامی است.");
      }

      let roleId = body.role_id ?? null;
      if (!roleId) {
        const [role] = await db
          .select()
          .from(roles)
          .where(and(eq(roles.code, body.role_code.toUpperCase()), eq(roles.scope, "ORGANIZATION")))
          .limit(1);
        roleId = role?.id ?? null;
      }

      const token = `inv_${crypto.randomBytes(24).toString("base64url")}`;
      const emailNorm = (body.email || `${body.mobile!.replace(/\D/g, "")}@invite.businessos.ir`).toLowerCase();

      const [inv] = await db
        .insert(userInvitations)
        .values({
          organizationId: orgId,
          inviteeName: body.invitee_name ?? null,
          email: emailNorm,
          mobile: body.mobile ?? null,
          roleId,
          token,
          branchAccess: body.branch_access,
          warehouseAccess: body.warehouse_access,
          message: body.message ?? null,
          invitedBy: ctx.userId,
          status: "PENDING",
          expiresAt: new Date(Date.now() + body.expires_in_hours * 3600 * 1000),
        })
        .returning();

      await recordAuditLog({
        organizationId: orgId,
        actorUserId: ctx.userId,
        actorEmail: ctx.email,
        scope: "SECURITY",
        action: "INVITATION_CREATED",
        entityType: "USER_INVITATION",
        entityId: inv.id,
        ipAddress: ctx.ipAddress,
        metadata: { email: inv.email, mobile: inv.mobile, roleId },
      });

      return ok(inv, 201);
    }

    if (method === "POST" && id && action === "revoke") {
      const [revoked] = await db
        .update(userInvitations)
        .set({ status: "REVOKED", revokedAt: new Date() })
        .where(and(eq(userInvitations.id, id), eq(userInvitations.organizationId, orgId)))
        .returning();
      if (!revoked) throw new ApiError(404, "INVITATION_NOT_FOUND", "دعوت‌نامه یافت نشد.");
      await recordAuditLog({
        organizationId: orgId,
        actorUserId: ctx.userId,
        actorEmail: ctx.email,
        scope: "SECURITY",
        action: "INVITATION_REVOKED",
        entityType: "USER_INVITATION",
        entityId: id,
        ipAddress: ctx.ipAddress,
      });
      return ok(revoked);
    }

    if (method === "POST" && id && action === "resend") {
      const newToken = `inv_${crypto.randomBytes(24).toString("base64url")}`;
      const [upd] = await db
        .update(userInvitations)
        .set({
          token: newToken,
          status: "PENDING",
          expiresAt: new Date(Date.now() + 72 * 3600 * 1000),
        })
        .where(and(eq(userInvitations.id, id), eq(userInvitations.organizationId, orgId)))
        .returning();
      if (!upd) throw new ApiError(404, "INVITATION_NOT_FOUND", "دعوت‌نامه یافت نشد.");
      return ok(upd);
    }
  }

  // ============================================================================
  // /api/v1/access/members
  // ============================================================================
  if (sub === "members") {
    if (method === "GET" && !id) {
      const [members, allUserRoles, allRoles, activeSessions] = await Promise.all([
        db
          .select({
            id: organizationMembers.id,
            userId: users.id,
            fullName: users.fullName,
            email: users.email,
            mobile: users.phone,
            accountStatus: users.status,
            lastLoginAt: users.lastLoginAt,
            membershipStatus: organizationMembers.status,
            isOwner: organizationMembers.isOwner,
            branchAccess: organizationMembers.branchAccess,
            warehouseAccess: organizationMembers.warehouseAccess,
            joinedAt: organizationMembers.joinedAt,
            suspendedAt: organizationMembers.suspendedAt,
          })
          .from(organizationMembers)
          .innerJoin(users, eq(organizationMembers.userId, users.id))
          .where(eq(organizationMembers.organizationId, orgId))
          .orderBy(desc(organizationMembers.joinedAt)),
        db.select().from(userRoles).where(eq(userRoles.organizationId, orgId)),
        db.select().from(roles).where(eq(roles.scope, "ORGANIZATION")),
        db
          .select()
          .from(sessions)
          .where(and(eq(sessions.organizationId, orgId), isNull(sessions.revokedAt))),
      ]);

      const rMap = new Map(allRoles.map((r) => [r.id, r]));
      return ok({
        roles: allRoles,
        members: members.map((m) => ({
          ...m,
          roles: allUserRoles
            .filter((ur) => ur.userId === m.userId)
            .map((ur) => rMap.get(ur.roleId))
            .filter(Boolean),
          active_sessions_count: activeSessions.filter((s) => s.userId === m.userId).length,
        })),
      });
    }

    // PATCH /api/v1/access/members/{member_id} (Role, Branch, Warehouse, Suspend/Reactivate + Session Revocation!)
    if (method === "PATCH" && id && !action) {
      const body = z
        .object({
          status: z.enum(["ACTIVE", "SUSPENDED"]).optional(),
          role_code: z.string().optional(),
          role_id: z.string().uuid().optional(),
          branch_access: z.array(z.string()).optional(),
          warehouse_access: z.array(z.string()).optional(),
        })
        .parse(await req.json());

      const [member] = await db
        .select()
        .from(organizationMembers)
        .where(and(eq(organizationMembers.id, id), eq(organizationMembers.organizationId, orgId)))
        .limit(1);
      if (!member) throw new ApiError(404, "MEMBER_NOT_FOUND", "عضویت سازمانی یافت نشد.");
      if (member.isOwner && body.status === "SUSPENDED") {
        throw new ApiError(409, "CANNOT_SUSPEND_OWNER", "امکان تعلیق مالک اصلی سازمان وجود ندارد.");
      }

      const updated = await db.transaction(async (tx) => {
        const [upd] = await tx
          .update(organizationMembers)
          .set({
            ...(body.status ? { status: body.status, suspendedAt: body.status === "SUSPENDED" ? new Date() : null } : {}),
            ...(body.branch_access ? { branchAccess: body.branch_access } : {}),
            ...(body.warehouse_access ? { warehouseAccess: body.warehouse_access } : {}),
          })
          .where(eq(organizationMembers.id, member.id))
          .returning();

        // Update Role if requested
        if (body.role_id || body.role_code) {
          let targetRoleId = body.role_id ?? null;
          if (!targetRoleId && body.role_code) {
            const [r] = await tx
              .select()
              .from(roles)
              .where(and(eq(roles.code, body.role_code.toUpperCase()), eq(roles.scope, "ORGANIZATION")))
              .limit(1);
            targetRoleId = r?.id ?? null;
          }
          if (targetRoleId) {
            await tx
              .delete(userRoles)
              .where(and(eq(userRoles.userId, member.userId), eq(userRoles.organizationId, orgId)));
            await tx.insert(userRoles).values({
              userId: member.userId,
              roleId: targetRoleId,
              organizationId: orgId,
            });
          }
        }

        // Immediately revoke active org sessions when suspended! (§6.9)
        if (body.status === "SUSPENDED") {
          await tx
            .update(sessions)
            .set({ revokedAt: new Date() })
            .where(and(eq(sessions.userId, member.userId), isNull(sessions.revokedAt)));
        }

        return upd;
      });

      await recordAuditLog({
        organizationId: orgId,
        actorUserId: ctx.userId,
        actorEmail: ctx.email,
        scope: "SECURITY",
        action:
          body.status === "SUSPENDED"
            ? "MEMBER_SUSPENDED"
            : body.status === "ACTIVE"
              ? "MEMBER_REACTIVATED"
              : "MEMBER_ACCESS_UPDATED",
        entityType: "ORGANIZATION_MEMBER",
        entityId: member.id,
        ipAddress: ctx.ipAddress,
        metadata: { userId: member.userId, roleCode: body.role_code, status: body.status },
      });

      return ok(updated);
    }

    // POST /api/v1/access/members/{member_id}/revoke-sessions
    if (method === "POST" && id && action === "revoke-sessions") {
      const [member] = await db
        .select()
        .from(organizationMembers)
        .where(and(eq(organizationMembers.id, id), eq(organizationMembers.organizationId, orgId)))
        .limit(1);
      if (!member) throw new ApiError(404, "MEMBER_NOT_FOUND", "عضویت یافت نشد.");

      await db
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(sessions.userId, member.userId), isNull(sessions.revokedAt)));

      await recordAuditLog({
        organizationId: orgId,
        actorUserId: ctx.userId,
        actorEmail: ctx.email,
        scope: "SECURITY",
        action: "MEMBER_SESSIONS_REVOKED",
        entityType: "SESSION",
        entityId: member.userId,
        ipAddress: ctx.ipAddress,
      });

      return ok({ revoked: true, user_id: member.userId });
    }

    // DELETE /api/v1/access/members/{member_id} (Removes membership WITHOUT deleting global user account!)
    if (method === "DELETE" && id && !action) {
      const [member] = await db
        .select()
        .from(organizationMembers)
        .where(and(eq(organizationMembers.id, id), eq(organizationMembers.organizationId, orgId)))
        .limit(1);
      if (!member) throw new ApiError(404, "MEMBER_NOT_FOUND", "عضویت یافت نشد.");
      if (member.isOwner) {
        throw new ApiError(409, "CANNOT_REMOVE_OWNER", "حذف عضویت مالک اصلی سازمان مجاز نیست.");
      }

      await db.transaction(async (tx) => {
        await tx.delete(organizationMembers).where(eq(organizationMembers.id, member.id));
        await tx
          .delete(userRoles)
          .where(and(eq(userRoles.userId, member.userId), eq(userRoles.organizationId, orgId)));
        await tx
          .update(sessions)
          .set({ revokedAt: new Date() })
          .where(and(eq(sessions.userId, member.userId), isNull(sessions.revokedAt)));
      });

      await recordAuditLog({
        organizationId: orgId,
        actorUserId: ctx.userId,
        actorEmail: ctx.email,
        scope: "SECURITY",
        action: "MEMBERSHIP_REMOVED",
        entityType: "ORGANIZATION_MEMBER",
        entityId: member.id,
        ipAddress: ctx.ipAddress,
        metadata: { userId: member.userId, globalAccountPreserved: true },
      });

      return ok({ removed_member_id: member.id, global_account_preserved: true });
    }
  }

  // GET /api/v1/access/audit-logs (Org-scoped security & access audit trail)
  if (sub === "audit-logs" && method === "GET") {
    const logs = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.organizationId, orgId))
      .orderBy(desc(auditLogs.createdAt))
      .limit(80);
    return ok(logs);
  }

  throw new ApiError(404, "ROUTE_NOT_FOUND", "مسیر مدیریت دسترسی کاربران یافت نشد.");
}

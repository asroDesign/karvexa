import { NextRequest } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  accountingPeriods,
  fiscalYears,
  organizationMembers,
  organizations,
  permissions,
  plans,
  rolePermissions,
  roles,
  subscriptions,
  userInvitations,
  userRoles,
  users,
} from "@/db/schema";
import { bootstrapOrganizationDefaults, ensureSeeded } from "@/db/seed";
import { ensurePrompt05OrgDefaults } from "@/db/seed-prompt05";
import { recordAuditLog } from "@/lib/audit";
import {
  ApiError,
  applyListFilterAndPaginate,
  ok,
  okList,
  parseListQuery,
} from "@/lib/errors";
import { getUserOrganizations, requireAuth, requireOrgContext } from "@/lib/tenant";

export const ALLOWED_ORGANIZATION_ADDONS = [
  "RETAIL_POS",
  "DISTRIBUTION",
  "SERVICE_REPAIR",
  "LIGHT_MANUFACTURING",
] as const;

const addonEnum = z.enum(ALLOWED_ORGANIZATION_ADDONS);
const uiModeEnum = z.enum(["SIMPLE_OWNER", "ADVANCED_ACCOUNTING"]);

const createOrgSchema = z.object({
  name: z.string().min(2),
  legal_name: z.string().optional(),
  business_type: z.string().default("RETAIL"),
  economic_code: z.string().optional(),
  national_id: z.string().optional(),
  mobile: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional().or(z.literal("")),
  address: z.string().optional(),
  postal_code: z.string().optional(),
  base_currency: z.string().default("IRR"),
  currency_scale: z.number().int().min(0).max(4).default(2),
  timezone: z.string().default("Asia/Tehran"),
  fiscal_year_start: z.string().default("01-01"),
  enabled_addons: z.array(addonEnum).default([]),
  ui_mode_default: uiModeEnum.default("SIMPLE_OWNER"),
});

const patchOrgSchema = z.object({
  name: z.string().min(2).optional(),
  legal_name: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  mobile: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  postal_code: z.string().nullable().optional(),
  enabled_addons: z.array(addonEnum).optional(),
  ui_mode_default: uiModeEnum.optional(),
});

export async function handleOrganizationRoutes(
  req: NextRequest,
  method: string,
  segments: string[]
) {
  await ensureSeeded();
  const orgIdParam = segments[1];
  const sub = segments[2];
  const subId = segments[3];
  const subAction = segments[4];

  // GET /api/v1/organizations (user's verified organizations)
  if (method === "GET" && !orgIdParam) {
    const auth = await requireAuth(req);
    const q = parseListQuery(req);
    const myOrgs = await getUserOrganizations(auth.userId);
    const { items, total } = applyListFilterAndPaginate(myOrgs, q, ["name"]);
    return okList(items, { page: q.page, perPage: q.perPage, total });
  }

  // POST /api/v1/organizations
  if (method === "POST" && !orgIdParam) {
    const auth = await requireAuth(req);
    const body = createOrgSchema.parse(await req.json());
    const created = await db.transaction(async (tx) => {
      const [org] = await tx
        .insert(organizations)
        .values({
          name: body.name,
          legalName: body.legal_name ?? null,
          businessType: body.business_type,
          economicCode: body.economic_code ?? null,
          nationalId: body.national_id ?? null,
          mobile: body.mobile ?? null,
          phone: body.phone ?? null,
          email: body.email || null,
          address: body.address ?? null,
          postalCode: body.postal_code ?? null,
          baseCurrency: body.base_currency,
          currencyScale: body.currency_scale,
          timezone: body.timezone,
          fiscalYearStart: body.fiscal_year_start,
          enabledAddons: [...new Set(body.enabled_addons)],
          uiModeDefault: body.ui_mode_default,
        })
        .returning();
      await bootstrapOrganizationDefaults(tx, org.id);
      await tx.insert(organizationMembers).values({
        organizationId: org.id,
        userId: auth.userId,
        isOwner: true,
        status: "ACTIVE",
      });
      const [ownerRole] = await tx
        .select()
        .from(roles)
        .where(and(eq(roles.code, "ORG_OWNER"), eq(roles.scope, "ORGANIZATION")))
        .limit(1);
      if (ownerRole) {
        await tx
          .insert(userRoles)
          .values({ userId: auth.userId, roleId: ownerRole.id, organizationId: org.id })
          .onConflictDoNothing();
      }
      const [proPlan] = await tx.select().from(plans).where(eq(plans.code, "PRO")).limit(1);
      if (proPlan) {
        const now = new Date();
        await tx.insert(subscriptions).values({
          organizationId: org.id,
          planId: proPlan.id,
          status: "TRIAL",
          startsAt: now,
          expiresAt: new Date(now.getTime() + 14 * 86400 * 1000),
          source: "TRIAL",
        });
      }
      return org;
    });
    await ensurePrompt05OrgDefaults(created.id);
    return ok(created, 201);
  }

  // All /{id}/* routes MUST verify user membership in THAT exact orgIdParam!
  const ctx = await requireOrgContext(req, "org.dashboard.read", {
    explicitOrgId: orgIdParam,
  });

  // GET /api/v1/organizations/{id}
  if (method === "GET" && orgIdParam && !sub) {
    return ok(ctx.organization);
  }

  // PATCH /api/v1/organizations/{id}
  if (method === "PATCH" && orgIdParam && !sub) {
    await requireOrgContext(req, "org.settings.write", { explicitOrgId: orgIdParam });
    const body = patchOrgSchema.parse(await req.json());
    const [updated] = await db
      .update(organizations)
      .set({
        ...(body.name ? { name: body.name } : {}),
        ...(body.legal_name !== undefined ? { legalName: body.legal_name } : {}),
        ...(body.phone !== undefined ? { phone: body.phone } : {}),
        ...(body.mobile !== undefined ? { mobile: body.mobile } : {}),
        ...(body.address !== undefined ? { address: body.address } : {}),
        ...(body.postal_code !== undefined ? { postalCode: body.postal_code } : {}),
        ...(body.enabled_addons !== undefined ? { enabledAddons: [...new Set(body.enabled_addons)] } : {}),
        ...(body.ui_mode_default !== undefined ? { uiModeDefault: body.ui_mode_default } : {}),
        updatedAt: new Date(),
      })
      .where(eq(organizations.id, ctx.organizationId))
      .returning();
    return ok(updated);
  }

  // GET / PATCH /api/v1/organizations/{id}/settings
  if (sub === "settings") {
    if (method === "GET") {
      return ok({
        organization_id: ctx.organizationId,
        base_currency: ctx.organization.baseCurrency,
        currency_scale: ctx.organization.currencyScale,
        timezone: ctx.organization.timezone,
        fiscal_year_start: ctx.organization.fiscalYearStart,
        costing_method: ctx.organization.costingMethod,
        negative_stock_policy: ctx.organization.negativeStockPolicy,
        enabled_addons: ctx.organization.enabledAddons,
        ui_mode_default: ctx.organization.uiModeDefault,
        settings: ctx.organization.settings,
      });
    }
    if (method === "PATCH") {
      await requireOrgContext(req, "org.settings.write", { explicitOrgId: orgIdParam });
      const body = z
        .object({
          costing_method: z.enum(["FIFO", "WEIGHTED_AVERAGE"]).optional(),
          negative_stock_policy: z.enum(["ALLOW", "WARN", "BLOCK"]).optional(),
          enabled_addons: z.array(addonEnum).optional(),
          ui_mode_default: uiModeEnum.optional(),
          settings: z.record(z.string(), z.unknown()).optional(),
        })
        .parse(await req.json());

      const [updated] = await db
        .update(organizations)
        .set({
          ...(body.costing_method ? { costingMethod: body.costing_method } : {}),
          ...(body.negative_stock_policy ? { negativeStockPolicy: body.negative_stock_policy } : {}),
          ...(body.enabled_addons !== undefined ? { enabledAddons: [...new Set(body.enabled_addons)] } : {}),
          ...(body.ui_mode_default !== undefined ? { uiModeDefault: body.ui_mode_default } : {}),
          ...(body.settings
            ? { settings: { ...ctx.organization.settings, ...body.settings } }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(organizations.id, ctx.organizationId))
        .returning();
      return ok(updated);
    }
  }

  // /api/v1/organizations/{id}/members
  if (sub === "members") {
    if (method === "GET") {
      const members = await db
        .select({
          id: organizationMembers.id,
          userId: users.id,
          fullName: users.fullName,
          email: users.email,
          mobile: users.phone,
          isOwner: organizationMembers.isOwner,
          status: organizationMembers.status,
          joinedAt: organizationMembers.joinedAt,
        })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .where(eq(organizationMembers.organizationId, ctx.organizationId));
      return ok(members);
    }
    if (method === "POST") {
      await requireOrgContext(req, "org.settings.write", { explicitOrgId: orgIdParam });
      const body = z
        .object({ user_id: z.string().uuid(), is_owner: z.boolean().default(false) })
        .parse(await req.json());
      const [member] = await db
        .insert(organizationMembers)
        .values({
          organizationId: ctx.organizationId,
          userId: body.user_id,
          isOwner: body.is_owner,
          status: "ACTIVE",
        })
        .returning();
      return ok(member, 201);
    }
    if (method === "PATCH" && subId) {
      await requireOrgContext(req, "org.settings.write", { explicitOrgId: orgIdParam });
      const body = (await req.json()) as { status?: string; is_owner?: boolean };
      const [upd] = await db
        .update(organizationMembers)
        .set({
          ...(body.status ? { status: body.status } : {}),
          ...(body.is_owner !== undefined ? { isOwner: body.is_owner } : {}),
        })
        .where(
          and(
            eq(organizationMembers.id, subId),
            eq(organizationMembers.organizationId, ctx.organizationId)
          )
        )
        .returning();
      return ok(upd);
    }
    if (method === "DELETE" && subId) {
      await requireOrgContext(req, "org.settings.write", { explicitOrgId: orgIdParam });
      await db
        .update(organizationMembers)
        .set({ status: "SUSPENDED" })
        .where(
          and(
            eq(organizationMembers.id, subId),
            eq(organizationMembers.organizationId, ctx.organizationId)
          )
        );
      return ok({ deleted_member_id: subId });
    }
  }

  // /api/v1/organizations/{id}/fiscal-years
  if (sub === "fiscal-years") {
    if (method === "GET") {
      const [fys, periods] = await Promise.all([
        db.select().from(fiscalYears).where(eq(fiscalYears.organizationId, ctx.organizationId)),
        db.select().from(accountingPeriods).where(eq(accountingPeriods.organizationId, ctx.organizationId)),
      ]);
      return ok(
        fys.map((fy) => ({
          ...fy,
          periods: periods.filter((p) => p.fiscalYearId === fy.id),
        }))
      );
    }
    if (method === "POST" && !subId) {
      await requireOrgContext(req, "accounting.period.manage", { explicitOrgId: orgIdParam });
      const body = z
        .object({
          name: z.string().min(2),
          start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        })
        .parse(await req.json());
      const [fy] = await db
        .insert(fiscalYears)
        .values({
          organizationId: ctx.organizationId,
          name: body.name,
          startDate: body.start_date,
          endDate: body.end_date,
          status: "OPEN",
        })
        .returning();
      return ok(fy, 201);
    }
    if (method === "POST" && subId && subAction === "close") {
      await requireOrgContext(req, "accounting.period.manage", { explicitOrgId: orgIdParam });
      const [closed] = await db
        .update(fiscalYears)
        .set({ status: "CLOSED" })
        .where(and(eq(fiscalYears.id, subId), eq(fiscalYears.organizationId, ctx.organizationId)))
        .returning();
      await db
        .update(accountingPeriods)
        .set({ status: "CLOSED", closedAt: new Date(), closedBy: ctx.userId })
        .where(eq(accountingPeriods.fiscalYearId, subId));
      return ok(closed);
    }
  }

  throw new ApiError(404, "ROUTE_NOT_FOUND", "مسیر سازمان یافت نشد.");
}

export async function handleRbacRoutes(
  req: NextRequest,
  method: string,
  segments: string[]
) {
  await ensureSeeded();
  const root = segments[0];
  const id = segments[1];
  const sub = segments[2];

  const ctx = await requireOrgContext(req, "org.dashboard.read");

  // GET /api/v1/permissions
  if (root === "permissions" && method === "GET") {
    const list = await db.select().from(permissions);
    return ok(list);
  }

  // /api/v1/roles
  if (root === "roles") {
    if (method === "GET" && !id) {
      const [allRoles, allLinks] = await Promise.all([
        db.select().from(roles),
        db.select().from(rolePermissions),
      ]);
      return ok(
        allRoles.map((r) => ({
          ...r,
          permission_ids: allLinks.filter((l) => l.roleId === r.id).map((l) => l.permissionId),
        }))
      );
    }
    if (method === "POST" && !id) {
      await requireOrgContext(req, "org.settings.write");
      const body = z
        .object({
          code: z.string().min(2),
          name: z.string().min(2),
          description: z.string().optional(),
          permission_ids: z.array(z.string().uuid()).default([]),
        })
        .parse(await req.json());
      const [role] = await db
        .insert(roles)
        .values({
          organizationId: ctx.organizationId,
          scope: "ORGANIZATION",
          code: body.code.toUpperCase(),
          name: body.name,
          description: body.description ?? null,
        })
        .returning();
      if (body.permission_ids.length > 0) {
        await db.insert(rolePermissions).values(
          body.permission_ids.map((pid) => ({ roleId: role.id, permissionId: pid }))
        );
      }
      return ok(role, 201);
    }
    if (method === "GET" && id) {
      const [role] = await db.select().from(roles).where(eq(roles.id, id)).limit(1);
      if (!role) throw new ApiError(404, "ROLE_NOT_FOUND", "نقش یافت نشد.");
      const links = await db.select().from(rolePermissions).where(eq(rolePermissions.roleId, role.id));
      return ok({ ...role, permission_ids: links.map((l) => l.permissionId) });
    }
    if (method === "PATCH" && id) {
      await requireOrgContext(req, "org.settings.write");
      const body = (await req.json()) as { name?: string; description?: string; permission_ids?: string[] };
      const [updated] = await db
        .update(roles)
        .set({
          ...(body.name ? { name: body.name } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
        })
        .where(eq(roles.id, id))
        .returning();
      if (body.permission_ids) {
        await db.delete(rolePermissions).where(eq(rolePermissions.roleId, id));
        if (body.permission_ids.length > 0) {
          await db.insert(rolePermissions).values(
            body.permission_ids.map((pid) => ({ roleId: id, permissionId: pid }))
          );
        }
      }
      return ok(updated);
    }
    if (method === "DELETE" && id) {
      await requireOrgContext(req, "org.settings.write");
      await db.delete(roles).where(and(eq(roles.id, id), eq(roles.organizationId, ctx.organizationId)));
      return ok({ deleted_role_id: id });
    }
  }

  // /api/v1/users
  if (root === "users") {
    // POST /api/v1/users/invitations
    if (id === "invitations") {
      if (method === "POST" && !sub) {
        const body = z
          .object({
            email: z.string().email(),
            mobile: z.string().optional(),
            role_id: z.string().uuid().optional(),
          })
          .parse(await req.json());
        const [inv] = await db
          .insert(userInvitations)
          .values({
            organizationId: ctx.organizationId,
            email: body.email.toLowerCase(),
            mobile: body.mobile ?? null,
            roleId: body.role_id ?? null,
            invitedBy: ctx.userId,
            expiresAt: new Date(Date.now() + 7 * 86400 * 1000),
          })
          .returning();
        return ok(inv, 201);
      }
      // POST /api/v1/users/invitations/{inv_id}/accept
      if (method === "POST" && sub && segments[3] === "accept") {
        const [inv] = await db
          .update(userInvitations)
          .set({ status: "ACCEPTED" })
          .where(eq(userInvitations.id, sub))
          .returning();
        if (!inv) throw new ApiError(404, "INVITATION_NOT_FOUND", "دعوت‌نامه یافت نشد.");
        return ok(inv);
      }
    }

    // GET /api/v1/users (org members)
    if (method === "GET" && !id) {
      const q = parseListQuery(req);
      const list = await db
        .select({
          id: users.id,
          fullName: users.fullName,
          email: users.email,
          mobile: users.phone,
          status: users.status,
          isOwner: organizationMembers.isOwner,
          createdAt: users.createdAt,
        })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .where(eq(organizationMembers.organizationId, ctx.organizationId))
        .orderBy(desc(users.createdAt));
      const { items, total } = applyListFilterAndPaginate(list, q, ["fullName", "email", "mobile"]);
      return okList(items, { page: q.page, perPage: q.perPage, total });
    }

    // GET /api/v1/users/{id}
    if (method === "GET" && id && !sub) {
      const [u] = await db
        .select({
          id: users.id,
          fullName: users.fullName,
          email: users.email,
          mobile: users.phone,
          status: users.status,
        })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .where(
          and(
            eq(organizationMembers.organizationId, ctx.organizationId),
            eq(users.id, id)
          )
        )
        .limit(1);
      if (!u) throw new ApiError(404, "USER_NOT_FOUND", "کاربر در این سازمان یافت نشد.");
      return ok(u);
    }

    // PATCH /api/v1/users/{id}/roles
    if (method === "PATCH" && id && sub === "roles") {
      await requireOrgContext(req, "org.settings.write");
      const body = z.object({ role_ids: z.array(z.string().uuid()) }).parse(await req.json());
      await db
        .delete(userRoles)
        .where(and(eq(userRoles.userId, id), eq(userRoles.organizationId, ctx.organizationId)));
      if (body.role_ids.length > 0) {
        await db.insert(userRoles).values(
          body.role_ids.map((rid) => ({
            userId: id,
            roleId: rid,
            organizationId: ctx.organizationId,
          }))
        );
      }
      await recordAuditLog({
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorEmail: ctx.email,
        scope: "ORGANIZATION",
        action: "USER_ROLES_UPDATED",
        entityType: "USER",
        entityId: id,
      });
      return ok({ user_id: id, role_ids: body.role_ids });
    }
  }

  throw new ApiError(404, "ROUTE_NOT_FOUND", "مسیر نقش‌ها یا کاربران یافت نشد.");
}

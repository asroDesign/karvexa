import { NextRequest } from "next/server";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  entitlements,
  organizationMembers,
  organizations,
  permissions,
  planFeatures,
  plans,
  rolePermissions,
  roles,
  sessions,
  subscriptions,
  userRoles,
  users,
  features,
} from "@/db/schema";
import {
  extractAccessToken,
  getClientIp,
  ORG_COOKIE_NAME,
  verifyAccessToken,
} from "./auth";
import { ApiError, checkClientVersion } from "./errors";
import { recordAuditLog } from "./audit";

const PERMISSION_ALIASES: Record<string, string[]> = {
  "contacts.view": ["contacts.read"],
  "contacts.create": ["contacts.write"],
  "contacts.update": ["contacts.write"],
  "contacts.delete": ["contacts.write"],
  "catalog.view": ["catalog.read"],
  "catalog.create": ["catalog.write"],
  "catalog.update": ["catalog.write"],
  "catalog.delete": ["catalog.write"],
  "sales.view": ["sales.read"],
  "sales.create": ["sales.write"],
  "sales.update": ["sales.write"],
  "sales.confirm": ["sales.write"],
  "sales.cancel": ["sales.write"],
  "purchases.view": ["purchasing.read"],
  "purchases.create": ["purchasing.write"],
  "purchases.confirm": ["purchasing.write"],
  "purchases.cancel": ["purchasing.write"],
  "inventory.view": ["inventory.read"],
  "inventory.transfer": ["inventory.write"],
  "inventory.confirm": ["inventory.write"],
  "inventory.count.confirm": ["inventory.count.approve"],
  "accounting.view": ["accounting.read"],
  "accounting.journal.create": ["accounting.write"],
  "accounting.journal.confirm": ["accounting.post"],
  "accounting.journal.reverse": ["accounting.reverse"],
  "treasury.view": ["treasury.read"],
  "treasury.create": ["treasury.write"],
  "cheques.view": ["cheques.read"],
  "cheques.manage": ["cheques.write"],
  "consignments.view": ["consignment.read"],
  "consignments.manage": ["consignment.write"],
  "reports.financial.view": ["reports.read"],
  "reports.view": ["reports.read"],
  "sales.update_draft": ["sales.write"],
  "sales.return": ["sales.write"],
  "inventory.adjust": ["inventory.write", "inventory.count.approve"],
  "products.create": ["catalog.write"],
  "products.update": ["catalog.write"],
  "accounting.post": ["accounting.journal.confirm"],
  "accounting.reverse": ["accounting.journal.reverse"],
  "accounting.journal_entries.reverse": ["accounting.reverse", "accounting.journal.reverse"],
  "purchases.return": ["purchasing.write"],
  "consignments.create": ["consignment.write"],
  "consignments.confirm": ["consignment.write"],
  "consignments.return": ["consignment.write"],
  "accounting.policy.view": ["accounting.read"],
  "accounting.policy.update": ["accounting.period.manage", "org.settings.write"],
  "accounting.cost_centers.view": ["accounting.read"],
  "accounting.cost_centers.create": ["accounting.write"],
  "accounting.cost_centers.update": ["accounting.write"],
  "accounting.periods.lock": ["accounting.period.manage"],
  "accounting.periods.unlock": ["accounting.period.manage"],
  "employees.view": ["employees.manage", "org.settings.write"],
  "sync.push": ["sync.execute"],
  "sync.pull": ["sync.execute"],
  "personal_finance.create": ["personal_finance.manage"],
  "sales.settlement.manage": ["sales.write"],
  "inventory.receipts.create": ["inventory.write"],
  "inventory.transfers.create": ["inventory.write"],
  "inventory.transfers.receive": ["inventory.write"],
  "inventory.exports": ["inventory.read", "reports.read"],
  "suppliers.view": ["contacts.read", "purchasing.read"],
  "suppliers.settle": ["treasury.write", "purchasing.write"],
  "cheques.update": ["cheques.write"],
  "treasury.accounts.manage": ["treasury.write"],
  "treasury.transactions.view": ["treasury.read"],
  "subscriptions.upgrade": ["subscription.manage"],
  "settings.offline_mode.manage": ["org.settings.write", "sync.execute"],
  // Note: reports.profit.view, personal_finance.view, personal_finance.manage, employees.manage
  // are NEVER aliased to generic sales/inventory permissions!
};

export function hasOrgPermission(permSet: Set<string>, required: string): boolean {
  if (permSet.has(required) || permSet.has("org.owner")) return true;
  const aliases = PERMISSION_ALIASES[required] ?? [];
  return aliases.some((a) => permSet.has(a));
}

export interface AuthUserContext {
  userId: string;
  sessionId: string;
  email: string;
  fullName: string;
  isPlatformAdmin: boolean;
  ipAddress: string;
}

export interface OrgContext extends AuthUserContext {
  organizationId: string;
  organization: typeof organizations.$inferSelect;
  permissions: Set<string>;
  subscriptionStatus: "ACTIVE" | "TRIAL" | "EXPIRED" | "NONE";
  planCode: string;
  entitlements: Record<string, { enabled: boolean; limitValue: number | null }>;
}

export interface PlatformContext extends AuthUserContext {
  permissions: Set<string>;
}

/**
 * Verifies JWT signature + active non-revoked session in PostgreSQL.
 */
export async function requireAuth(req: NextRequest): Promise<AuthUserContext> {
  checkClientVersion(req);
  const token = extractAccessToken(req);
  if (!token) {
    throw new ApiError(401, "AUTH_REQUIRED", "لطفاً وارد حساب کاربری خود شوید.");
  }
  const payload = verifyAccessToken(token);

  const [session] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, payload.sid), isNull(sessions.revokedAt)))
    .limit(1);

  if (!session || session.expiresAt.getTime() <= Date.now()) {
    throw new ApiError(401, "SESSION_REVOKED", "نشست کاربری معتبر نیست یا منقضی شده است.");
  }

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, payload.sub))
    .limit(1);

  if (!user || user.status !== "ACTIVE") {
    throw new ApiError(401, "USER_INACTIVE", "کاربر غیرفعال است.");
  }

  return {
    userId: user.id,
    sessionId: session.id,
    email: user.email,
    fullName: user.fullName,
    isPlatformAdmin: user.isPlatformAdmin,
    ipAddress: getClientIp(req),
  };
}

/**
 * Strictly enforces Platform Admin realm access & platform-scoped permissions.
 */
export async function requirePlatformAdmin(
  req: NextRequest,
  requiredPermission?: string
): Promise<PlatformContext> {
  const auth = await requireAuth(req);
  if (!auth.isPlatformAdmin) {
    await recordAuditLog({
      actorUserId: auth.userId,
      actorEmail: auth.email,
      scope: "SECURITY",
      action: "UNAUTHORIZED_PLATFORM_ACCESS",
      entityType: "PLATFORM",
      ipAddress: auth.ipAddress,
      severity: "CRITICAL",
      metadata: { path: req.nextUrl.pathname, requiredPermission },
    });
    throw new ApiError(
      403,
      "PLATFORM_ADMIN_REQUIRED",
      "دسترسی به پنل مدیریت پلتفرم فقط برای مدیران پلتفرم مجاز است."
    );
  }

  const perms = await loadUserPermissions(auth.userId, null, "PLATFORM");
  if (requiredPermission && !perms.has(requiredPermission) && !perms.has("*")) {
    throw new ApiError(
      403,
      "PERMISSION_DENIED",
      `مجوز پلتفرمی مورد نیاز (${requiredPermission}) را ندارید.`
    );
  }

  return {
    ...auth,
    permissions: perms,
  };
}

/**
 * Strictly enforces Multi-Tenant Organization Isolation!
 * NEVER trusts client-supplied organization_id without verifying active membership in `organization_members`.
 */
export async function requireOrgContext(
  req: NextRequest,
  requiredPermission?: string,
  options?: {
    requireActiveSubscription?: boolean;
    requiredFeature?: string;
    explicitOrgId?: string | null;
  }
): Promise<OrgContext> {
  const auth = await requireAuth(req);

  const requestedOrgId =
    options?.explicitOrgId ||
    req.headers.get("x-organization-id") ||
    req.cookies.get(ORG_COOKIE_NAME)?.value ||
    null;

  // Fetch all active memberships for this user
  const memberships = await db
    .select()
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.userId, auth.userId),
        eq(organizationMembers.status, "ACTIVE")
      )
    );

  if (memberships.length === 0) {
    throw new ApiError(
      403,
      "NO_ORGANIZATION_MEMBERSHIP",
      "شما عضو فعال هیچ سازمانی نیستید."
    );
  }

  let activeMembership = memberships[0];
  if (requestedOrgId) {
    const matched = memberships.find((m) => m.organizationId === requestedOrgId);
    if (!matched) {
      // Security critical: cross-tenant access attempt!
      await recordAuditLog({
        organizationId: null,
        actorUserId: auth.userId,
        actorEmail: auth.email,
        scope: "SECURITY",
        action: "CROSS_TENANT_ACCESS_BLOCKED",
        entityType: "ORGANIZATION",
        entityId: requestedOrgId,
        ipAddress: auth.ipAddress,
        severity: "CRITICAL",
        metadata: {
          path: req.nextUrl.pathname,
          requestedOrgId,
          allowedOrgs: memberships.map((m) => m.organizationId),
        },
      });
      throw new ApiError(
        403,
        "TENANT_ACCESS_DENIED",
        "دسترسی غیرمجاز به داده‌های سازمان دیگر مسدود و ثبت شد."
      );
    }
    activeMembership = matched;
  }

  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, activeMembership.organizationId))
    .limit(1);

  if (!org || org.status !== "ACTIVE") {
    throw new ApiError(403, "ORGANIZATION_SUSPENDED", "این سازمان در وضعیت غیرفعال یا تعلیق قرار دارد.");
  }

  const permSet = await loadUserPermissions(auth.userId, org.id, "ORGANIZATION");
  if (activeMembership.isOwner) {
    permSet.add("org.owner");
  }

  if (requiredPermission && !hasOrgPermission(permSet, requiredPermission) && !activeMembership.isOwner) {
    await recordAuditLog({
      organizationId: org.id,
      actorUserId: auth.userId,
      actorEmail: auth.email,
      scope: "SECURITY",
      action: "PERMISSION_DENIED",
      entityType: "AUTHORIZATION",
      entityId: requiredPermission,
      ipAddress: auth.ipAddress,
      severity: "WARN",
      metadata: {
        path: req.nextUrl.pathname,
        requiredPermission,
        userPermissions: Array.from(permSet),
      },
    });
    throw new ApiError(
      403,
      "PERMISSION_DENIED",
      `مجوز سازمانی مورد نیاز (${requiredPermission}) برای شما فعال نیست.`
    );
  }

  // Resolve Server-Side Subscription & Entitlements
  const subState = await resolveOrganizationEntitlements(org.id);

  // Never block data export or read-only inspection on expiry!
  if (options?.requireActiveSubscription && subState.subscriptionStatus === "EXPIRED") {
    throw new ApiError(
      402,
      "SUBSCRIPTION_ENTITLEMENT_REQUIRED",
      "اشتراک سازمان منقضی شده است. اطلاعات شما محفوظ است و امکان مشاهده و خروجی داده دارید؛ برای ثبت عملیات جدید اشتراک را تمدید کنید."
    );
  }

  if (options?.requiredFeature) {
    const feat = subState.entitlements[options.requiredFeature];
    if (!feat || !feat.enabled) {
      throw new ApiError(
        402,
        "SUBSCRIPTION_ENTITLEMENT_REQUIRED",
        `قابلیت «${options.requiredFeature}» در پلن فعلی سازمان فعال نیست.`
      );
    }
  }

  return {
    ...auth,
    organizationId: org.id,
    organization: org,
    permissions: permSet,
    subscriptionStatus: subState.subscriptionStatus,
    planCode: subState.planCode,
    entitlements: subState.entitlements,
  };
}

export async function loadUserPermissions(
  userId: string,
  organizationId: string | null,
  scope: "PLATFORM" | "ORGANIZATION"
): Promise<Set<string>> {
  const rows = await db
    .select({
      permCode: permissions.code,
      roleCode: roles.code,
    })
    .from(userRoles)
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .innerJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
    .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
    .where(
      scope === "PLATFORM"
        ? and(eq(userRoles.userId, userId), eq(roles.scope, "PLATFORM"))
        : and(
            eq(userRoles.userId, userId),
            eq(roles.scope, "ORGANIZATION"),
            eq(userRoles.organizationId, organizationId!)
          )
    );

  const set = new Set<string>();
  for (const r of rows) {
    set.add(r.permCode);
    if (scope === "PLATFORM" && r.roleCode === "SUPER_ADMIN") {
      set.add("*");
    }
  }
  return set;
}

export async function resolveOrganizationEntitlements(organizationId: string) {
  const [latestSub] = await db
    .select({
      sub: subscriptions,
      plan: plans,
    })
    .from(subscriptions)
    .innerJoin(plans, eq(subscriptions.planId, plans.id))
    .where(eq(subscriptions.organizationId, organizationId))
    .orderBy(desc(subscriptions.expiresAt))
    .limit(1);

  let status: "ACTIVE" | "TRIAL" | "EXPIRED" | "NONE" = "NONE";
  let planCode = "FREE";
  const entMap: Record<string, { enabled: boolean; limitValue: number | null }> = {};

  if (latestSub) {
    planCode = latestSub.plan.code;
    const isExpired =
      latestSub.sub.status === "EXPIRED" ||
      latestSub.sub.expiresAt.getTime() < Date.now();
    status = isExpired
      ? "EXPIRED"
      : latestSub.sub.status === "TRIAL"
        ? "TRIAL"
        : "ACTIVE";

    // Load plan features
    const pFeats = await db
      .select({
        code: features.code,
        enabled: planFeatures.enabled,
        limitValue: planFeatures.limitValue,
      })
      .from(planFeatures)
      .innerJoin(features, eq(planFeatures.featureId, features.id))
      .where(eq(planFeatures.planId, latestSub.plan.id));

    for (const pf of pFeats) {
      entMap[pf.code] = {
        enabled: isExpired ? false : pf.enabled,
        limitValue: pf.limitValue,
      };
    }
  }

  // Apply explicit org entitlement overrides
  const orgOverrides = await db
    .select()
    .from(entitlements)
    .where(eq(entitlements.organizationId, organizationId));

  for (const ov of orgOverrides) {
    if (ov.source === "OVERRIDE" || status !== "EXPIRED") {
      entMap[ov.featureCode] = {
        enabled: ov.enabled,
        limitValue: ov.limitValue,
      };
    }
  }

  // Data export is ALWAYS enabled regardless of expiry!
  entMap["data_export"] = { enabled: true, limitValue: null };

  return {
    subscriptionStatus: status,
    planCode,
    subscription: latestSub?.sub ?? null,
    plan: latestSub?.plan ?? null,
    entitlements: entMap,
  };
}

/**
 * Execute a callback inside a PostgreSQL transaction with RLS `app.current_org_id` bound.
 */
export async function withTenantTransaction<T>(
  organizationId: string,
  fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_org_id', ${organizationId}, true)`);
    return fn(tx);
  });
}

/**
 * Helper to fetch all user organizations with their roles for `/auth/me` & switcher.
 */
export async function getUserOrganizations(userId: string) {
  const rows = await db
    .select({
      organizationId: organizations.id,
      name: organizations.name,
      legalName: organizations.legalName,
      businessType: organizations.businessType,
      baseCurrency: organizations.baseCurrency,
      status: organizations.status,
      isOwner: organizationMembers.isOwner,
      memberStatus: organizationMembers.status,
    })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizationMembers.organizationId, organizations.id))
    .where(
      and(
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.status, "ACTIVE")
      )
    );

  if (rows.length === 0) return [];
  const orgIds = rows.map((r) => r.organizationId);
  const roleRows = await db
    .select({
      organizationId: userRoles.organizationId,
      roleCode: roles.code,
      roleName: roles.name,
    })
    .from(userRoles)
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .where(and(eq(userRoles.userId, userId), inArray(userRoles.organizationId, orgIds)));

  return rows.map((org) => ({
    ...org,
    roles: roleRows
      .filter((r) => r.organizationId === org.organizationId)
      .map((r) => ({ code: r.roleCode, name: r.roleName })),
  }));
}

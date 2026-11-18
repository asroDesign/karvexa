import { NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  accountingPolicies,
  branches,
  devices,
  fiscalYears,
  idempotencyKeys,
  organizationMembers,
  organizations,
  plans,
  roles,
  sessions,
  subscriptions,
  syncCheckpoints,
  userRoles,
  users,
} from "@/db/schema";
import { sha256 } from "@/lib/auth";
import { encodeSyncCursor } from "@/modules/sync/changelog";
import { bootstrapOrganizationDefaults, ensureSeeded } from "@/db/seed";
import { ensurePrompt05OrgDefaults } from "@/db/seed-prompt05";
import { issueOtpCode, normalizeIranMobile, verifyAndConsumeOtpCode } from "@/modules/sms/service";
import {
  attachAuthCookies,
  checkRateLimit,
  clearAuthCookies,
  createSessionTokens,
  extractRefreshToken,
  getClientIp,
  hashPassword,
  ORG_COOKIE_NAME,
  rotateRefreshToken,
  verifyPassword,
} from "@/lib/auth";
import { recordAuditLog } from "@/lib/audit";
import {
  ApiError,
  applyListFilterAndPaginate,
  checkClientVersion,
  ok,
  okList,
  parseListQuery,
} from "@/lib/errors";
import {
  getUserOrganizations,
  loadUserPermissions,
  requireAuth,
  requireOrgContext,
  resolveOrganizationEntitlements,
} from "@/lib/tenant";

const deviceRegistrationSchema = z.object({
  device_id: z.string().min(3),
  platform: z.string().default("android"),
  app_version: z.string().optional(),
  device_name: z.string().default("Android Device"),
  os_version: z.string().optional(),
});

const registerSchema = z.object({
  full_name: z.string().min(2, "نام کامل حداقل ۲ کاراکتر است."),
  mobile: z.string().min(10).max(20),
  email: z.string().email().optional(),
  password: z.string().min(6, "رمز عبور حداقل ۶ کاراکتر باشد.").optional(),
  organization_name: z.string().min(2, "نام سازمان الزامی است.").default("کسب‌وکار جدید"),
  otp_code: z.string().min(4).max(8),
  device: deviceRegistrationSchema.optional(),
});

const loginSchema = z.object({
  mobile: z.string().optional(),
  email: z.string().optional(),
  password: z.string().min(4),
  device: deviceRegistrationSchema.optional(),
});

const registerDeviceSchema = z.object({
  device_id: z.string().min(3),
  platform: z.string().default("android"),
  device_name: z.string().min(2),
  os_version: z.string().optional(),
  app_version: z.string().optional(),
});

async function getDefaultOrganizationContext(organizationId: string | null) {
  if (!organizationId) return { fiscalYearId: null, branchId: null };
  const [[fiscalYear], [branch]] = await Promise.all([
    db.select({ id: fiscalYears.id })
      .from(fiscalYears)
      .where(and(eq(fiscalYears.organizationId, organizationId), eq(fiscalYears.isDefault, true)))
      .orderBy(desc(fiscalYears.createdAt))
      .limit(1),
    db.select({ id: branches.id })
      .from(branches)
      .where(and(eq(branches.organizationId, organizationId), eq(branches.isDefault, true), eq(branches.isActive, true)))
      .limit(1),
  ]);
  return { fiscalYearId: fiscalYear?.id ?? null, branchId: branch?.id ?? null };
}

export async function handleAuthRoutes(
  req: NextRequest,
  method: string,
  segments: string[]
) {
  await ensureSeeded();
  checkClientVersion(req);
  const sub = segments[1] ?? "";
  const id = segments[2];

  // Request an OTP before creating a new account.
  if (method === "POST" && sub === "register-otp") {
    const ip = getClientIp(req);
    checkRateLimit(`register-otp:${ip}`, 10, 60_000);
    const body = z.object({ mobile: z.string().min(10).max(20) }).parse(await req.json());
    const mobile = normalizeIranMobile(body.mobile);
    if (!/^09\d{9}$/.test(mobile)) {
      throw new ApiError(422, "INVALID_MOBILE", "شماره موبایل باید با فرمت صحیح 09XXXXXXXXX وارد شود.");
    }
    checkRateLimit(`register-otp-mobile:${mobile}`, 5, 5 * 60_000);
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.phone, mobile)).limit(1);
    if (existing) throw new ApiError(409, "MOBILE_ALREADY_REGISTERED", "این شماره موبایل قبلاً ثبت‌نام کرده است.");
    const otpRes = await issueOtpCode({ mobile, purpose: "VERIFY_MOBILE" });
    return ok({ action: "register-otp", status: "OTP_SENT", ...otpRes });
  }

  // Request a passwordless login OTP. The response intentionally does not disclose whether the mobile is registered.
  if (method === "POST" && sub === "request-login-otp") {
    const ip = getClientIp(req);
    checkRateLimit(`login-otp:${ip}`, 10, 60_000);
    const body = z.object({ mobile: z.string().min(10).max(20) }).parse(await req.json());
    const mobile = normalizeIranMobile(body.mobile);
    if (!/^09\d{9}$/.test(mobile)) {
      throw new ApiError(422, "INVALID_MOBILE", "شماره موبایل باید با فرمت صحیح 09XXXXXXXXX وارد شود.");
    }
    checkRateLimit(`login-otp-mobile:${mobile}`, 5, 5 * 60_000);
    const [user] = await db.select({ id: users.id, status: users.status })
      .from(users).where(eq(users.phone, mobile)).limit(1);
    if (user?.status === "ACTIVE") {
      const otpRes = await issueOtpCode({ mobile, purpose: "LOGIN_OTP" });
      return ok({ action: "request-login-otp", status: "OTP_SENT", ...otpRes });
    }
    return ok({ action: "request-login-otp", status: "OTP_SENT", expires_in_seconds: 300 });
  }

  // Verify a passwordless login OTP and establish the same session/device context as password login.
  if (method === "POST" && sub === "login-otp") {
    const ip = getClientIp(req);
    checkRateLimit(`login-otp-verify:${ip}`, 20, 60_000);
    const body = z.object({
      mobile: z.string().min(10).max(20),
      otp_code: z.string().min(4).max(8),
      device: deviceRegistrationSchema.optional(),
    }).parse(await req.json());
    const mobile = normalizeIranMobile(body.mobile);
    if (!/^09\d{9}$/.test(mobile)) {
      throw new ApiError(422, "INVALID_MOBILE", "شماره موبایل باید با فرمت صحیح 09XXXXXXXXX وارد شود.");
    }
    await verifyAndConsumeOtpCode({ mobile, purpose: "LOGIN_OTP", code: body.otp_code });
    const [user] = await db.select().from(users).where(eq(users.phone, mobile)).limit(1);
    if (!user || user.status !== "ACTIVE") {
      throw new ApiError(401, "INVALID_OTP", "کد تایید یا شماره موبایل معتبر نیست.");
    }
    if (!user.mobileVerified) {
      await db.update(users).set({ mobileVerified: true, updatedAt: new Date() }).where(eq(users.id, user.id));
    }
    const memberships = await getUserOrganizations(user.id);
    const defaultOrgId = memberships[0]?.organizationId ?? null;

    let registeredDevice = null;
    if (body.device && defaultOrgId) {
      const [existingDev] = await db.select().from(devices)
        .where(and(eq(devices.organizationId, defaultOrgId), eq(devices.deviceUuid, body.device.device_id)))
        .limit(1);
      if (existingDev) {
        [registeredDevice] = await db.update(devices).set({
          deviceName: body.device.device_name,
          appVersion: body.device.app_version ?? existingDev.appVersion,
          osVersion: body.device.os_version ?? existingDev.osVersion,
          status: "ACTIVE",
          updatedAt: new Date(),
        }).where(eq(devices.id, existingDev.id)).returning();
      } else {
        [registeredDevice] = await db.insert(devices).values({
          organizationId: defaultOrgId,
          userId: user.id,
          deviceUuid: body.device.device_id,
          deviceName: body.device.device_name,
          platform: body.device.platform.toUpperCase(),
          osVersion: body.device.os_version ?? null,
          appVersion: body.device.app_version ?? null,
          status: "ACTIVE",
        }).returning();
      }
    }

    const tokens = await createSessionTokens({
      user,
      organizationId: defaultOrgId,
      ipAddress: ip,
      userAgent: req.headers.get("user-agent"),
    });
    const { fiscalYearId, branchId } = await getDefaultOrganizationContext(defaultOrgId);
    await db.update(users).set({ lastLoginAt: new Date(), mobileVerified: true }).where(eq(users.id, user.id));
    await recordAuditLog({
      organizationId: defaultOrgId,
      actorUserId: user.id,
      actorEmail: user.email,
      scope: user.isPlatformAdmin ? "PLATFORM" : "ORGANIZATION",
      action: "LOGIN_OTP_SUCCESS",
      entityType: "SESSION",
      entityId: tokens.session.id,
      ipAddress: ip,
    });

    const res = ok({
      user: { id: user.id, full_name: user.fullName, email: user.email, mobile: user.phone, is_platform_admin: user.isPlatformAdmin },
      organizations: memberships,
      active_organization_id: defaultOrgId,
      active_fiscal_year_id: fiscalYearId,
      active_branch_id: branchId,
      device: registeredDevice,
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      expires_in: tokens.expiresIn,
      token_type: "Bearer",
    });
    attachAuthCookies(res, { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, activeOrgId: defaultOrgId });
    return res;
  }

  // POST /api/v1/auth/register (Master Prompt 07 §3 — Atomic User + Org + Owner RBAC + Device + Policy + Sync Init + Idempotency)
  if (method === "POST" && sub === "register") {
    const ip = getClientIp(req);
    checkRateLimit(`register:${ip}`, 20, 60_000);
    const body = registerSchema.parse(await req.json());
    const normMobile = normalizeIranMobile(body.mobile);
    if (!/^09\d{9}$/.test(normMobile)) {
      throw new ApiError(422, "INVALID_MOBILE", "شماره موبایل باید با فرمت صحیح 09XXXXXXXXX وارد شود.", [
        { field: "mobile", code: "INVALID_FORMAT", message: "Expected 09XXXXXXXXX" },
      ]);
    }

    // Request-level Idempotency check (prevents duplicate account/org creation on network retry!)
    const idemKey = req.headers.get("idempotency-key");
    const reqHash = sha256(JSON.stringify({ mobile: normMobile, organization_name: body.organization_name, full_name: body.full_name }));
    if (idemKey) {
      const [prevIdem] = await db
        .select()
        .from(idempotencyKeys)
        .where(and(isNull(idempotencyKeys.organizationId), eq(idempotencyKeys.key, `reg:${idemKey}`)))
        .limit(1);
      if (prevIdem) {
        if (prevIdem.requestHash !== reqHash) {
          throw new ApiError(409, "IDEMPOTENCY_PAYLOAD_MISMATCH", "کلید یکتاسازی ثبت‌نام قبلاً با اطلاعات متفاوتی استفاده شده است.");
        }
        return ok(prevIdem.responseBody, prevIdem.statusCode, { replayed: true });
      }
    }

    const email = (body.email || `${normMobile}@businessos.ir`).toLowerCase();

    // Prevent duplicate normalized mobile or email registration
    const [existingUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(or(eq(users.phone, normMobile), eq(users.email, email)))
      .limit(1);
    if (existingUser) {
      throw new ApiError(409, "MOBILE_ALREADY_REGISTERED", "این شماره موبایل یا ایمیل قبلاً ثبت‌نام کرده است.");
    }

    await verifyAndConsumeOtpCode({
      mobile: normMobile,
      purpose: "VERIFY_MOBILE",
      code: body.otp_code,
    });

    // OTP is the primary sign-in credential. Keep password registration backward-compatible,
    // but create an unguessable secret when the client uses the passwordless registration flow.
    const passwordHash = await hashPassword(body.password ?? randomBytes(32).toString("base64url"));

    const created = await db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({
          fullName: body.full_name.trim(),
          email,
          phone: normMobile,
          passwordHash,
          mobileVerified: true,
          isPlatformAdmin: false,
          status: "ACTIVE",
        })
        .returning();

      const [org] = await tx
        .insert(organizations)
        .values({
          name: body.organization_name.trim(),
          mobile: normMobile,
          email,
          baseCurrency: "IRR",
          currencyScale: 2,
          enabledAddons: [],
          uiModeDefault: "SIMPLE_OWNER",
        })
        .returning();

      // Standard COA, fiscal year, periods, default unit & warehouse (ZERO fake financial entries!)
      await bootstrapOrganizationDefaults(tx, org.id);

      // Accounting Policy & Default Branch inside same atomic tx
      await tx.insert(accountingPolicies).values({
        organizationId: org.id,
        defaultTaxRate: "10.00",
        isTaxInclusive: false,
        invoicePrefix: "SI-",
        lowStockAlertEnabled: true,
        updatedBy: user.id,
      });

      await tx.insert(branches).values({
        organizationId: org.id,
        code: "BR-MAIN",
        name: "شعبه مرکزی",
        isDefault: true,
        isActive: true,
      });

      await tx.insert(organizationMembers).values({
        organizationId: org.id,
        userId: user.id,
        isOwner: true,
        status: "ACTIVE",
      });

      const [ownerRole] = await tx
        .select()
        .from(roles)
        .where(and(eq(roles.code, "ORG_OWNER"), eq(roles.scope, "ORGANIZATION")))
        .limit(1);
      if (ownerRole) {
        await tx.insert(userRoles).values({
          userId: user.id,
          roleId: ownerRole.id,
          organizationId: org.id,
        });
      }

      const [trialPlan] = await tx.select().from(plans).where(eq(plans.code, "PRO")).limit(1);
      if (trialPlan) {
        const now = new Date();
        await tx.insert(subscriptions).values({
          organizationId: org.id,
          planId: trialPlan.id,
          status: "TRIAL",
          startsAt: now,
          expiresAt: new Date(now.getTime() + 14 * 86400 * 1000),
          source: "TRIAL",
        });
      }

      // Register initial Android/Web device & Sync Checkpoint atomically
      let registeredDevice = null;
      if (body.device) {
        const [dev] = await tx
          .insert(devices)
          .values({
            organizationId: org.id,
            userId: user.id,
            deviceUuid: body.device.device_id,
            deviceName: body.device.device_name,
            platform: body.device.platform.toUpperCase(),
            osVersion: body.device.os_version ?? null,
            appVersion: body.device.app_version ?? null,
            status: "ACTIVE",
          })
          .returning();
        registeredDevice = dev;

        await tx.insert(syncCheckpoints).values({
          organizationId: org.id,
          deviceId: dev.id,
          checkpointSeq: 0,
          cursor: encodeSyncCursor({ seq: 0, orgId: org.id }),
        });
      }

      return { user, org, device: registeredDevice };
    });

    await ensurePrompt05OrgDefaults(created.org.id);
    const { fiscalYearId: activeFiscalYearId, branchId: activeBranchId } =
      await getDefaultOrganizationContext(created.org.id);

    const tokens = await createSessionTokens({
      user: created.user,
      organizationId: created.org.id,
      ipAddress: ip,
      userAgent: req.headers.get("user-agent"),
    });

    await recordAuditLog({
      organizationId: created.org.id,
      actorUserId: created.user.id,
      actorEmail: created.user.email,
      scope: "ORGANIZATION",
      action: "USER_REGISTERED_WITH_ORG",
      entityType: "ORGANIZATION",
      entityId: created.org.id,
      ipAddress: ip,
      metadata: { mobile: normMobile, deviceRegistered: Boolean(created.device) },
    });

    const responseData = {
      user: {
        id: created.user.id,
        full_name: created.user.fullName,
        email: created.user.email,
        mobile: created.user.phone,
        mobile_verified: created.user.mobileVerified,
        is_platform_admin: created.user.isPlatformAdmin,
      },
      organization: created.org,
      active_organization_id: created.org.id,
      active_fiscal_year_id: activeFiscalYearId,
      active_branch_id: activeBranchId,
      device: created.device,
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      expires_in: tokens.expiresIn,
      token_type: "Bearer",
    };

    if (idemKey) {
      await db
        .insert(idempotencyKeys)
        .values({
          organizationId: null,
          key: `reg:${idemKey}`,
          endpoint: "/api/v1/auth/register",
          requestHash: reqHash,
          statusCode: 201,
          responseBody: responseData as unknown as Record<string, unknown>,
          expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
        })
        .onConflictDoNothing();
    }

    const res = ok(responseData, 201);
    attachAuthCookies(res, {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      activeOrgId: created.org.id,
    });
    return res;
  }

  // POST /api/v1/auth/login (supports both `mobile` per Prompt 03 §6 AND `email`)
  if (method === "POST" && sub === "login") {
    const ip = getClientIp(req);
    checkRateLimit(`login:${ip}`, 40, 60_000);
    const body = loginSchema.parse(await req.json());
    const identifier = (body.mobile || body.email || "").trim();
    if (!identifier) {
      throw new ApiError(422, "VALIDATION_ERROR", "شماره موبایل یا ایمیل الزامی است.", [
        { field: "mobile", code: "REQUIRED", message: "mobile or email is required" },
      ]);
    }

    const [user] = await db
      .select()
      .from(users)
      .where(or(eq(users.phone, identifier), eq(users.email, identifier.toLowerCase())))
      .limit(1);

    if (!user || !(await verifyPassword(body.password, user.passwordHash))) {
      await recordAuditLog({
        actorEmail: identifier,
        scope: "SECURITY",
        action: "LOGIN_FAILED",
        entityType: "AUTH",
        ipAddress: ip,
        severity: "WARN",
      });
      throw new ApiError(401, "INVALID_CREDENTIALS", "نام کاربری/موبایل یا رمز عبور اشتباه است.");
    }
    if (user.status !== "ACTIVE") {
      throw new ApiError(403, "USER_SUSPENDED", "حساب کاربری غیرفعال است.");
    }

    const memberships = await getUserOrganizations(user.id);
    const defaultOrgId = memberships[0]?.organizationId ?? null;

    let registeredDevice = null;
    if (body.device && defaultOrgId) {
      const [existingDev] = await db
        .select()
        .from(devices)
        .where(
          and(
            eq(devices.organizationId, defaultOrgId),
            eq(devices.deviceUuid, body.device.device_id)
          )
        )
        .limit(1);
      if (existingDev) {
        [registeredDevice] = await db
          .update(devices)
          .set({
            deviceName: body.device.device_name,
            appVersion: body.device.app_version ?? existingDev.appVersion,
            osVersion: body.device.os_version ?? existingDev.osVersion,
            status: "ACTIVE",
            updatedAt: new Date(),
          })
          .where(eq(devices.id, existingDev.id))
          .returning();
      } else {
        [registeredDevice] = await db
          .insert(devices)
          .values({
            organizationId: defaultOrgId,
            userId: user.id,
            deviceUuid: body.device.device_id,
            deviceName: body.device.device_name,
            platform: body.device.platform.toUpperCase(),
            appVersion: body.device.app_version ?? null,
            osVersion: body.device.os_version ?? null,
          })
          .returning();
      }
    }

    const tokens = await createSessionTokens({
      user,
      organizationId: defaultOrgId,
      ipAddress: ip,
      userAgent: req.headers.get("user-agent"),
    });
    const { fiscalYearId: activeFiscalYearId, branchId: activeBranchId } =
      await getDefaultOrganizationContext(defaultOrgId);

    await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
    await recordAuditLog({
      organizationId: defaultOrgId,
      actorUserId: user.id,
      actorEmail: user.email,
      scope: user.isPlatformAdmin ? "PLATFORM" : "ORGANIZATION",
      action: "LOGIN_SUCCESS",
      entityType: "SESSION",
      entityId: tokens.session.id,
      ipAddress: ip,
    });

    const res = ok({
      user: {
        id: user.id,
        full_name: user.fullName,
        email: user.email,
        mobile: user.phone,
        is_platform_admin: user.isPlatformAdmin,
      },
      organizations: memberships,
      active_organization_id: defaultOrgId,
      active_fiscal_year_id: activeFiscalYearId,
      active_branch_id: activeBranchId,
      device: registeredDevice,
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      expires_in: tokens.expiresIn,
      token_type: "Bearer",
    });

    attachAuthCookies(res, {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      activeOrgId: defaultOrgId,
    });
    return res;
  }

  // POST /api/v1/auth/refresh
  if (method === "POST" && sub === "refresh") {
    const body = (await req.json().catch(() => ({}))) as {
      refresh_token?: string;
      refreshToken?: string;
    };
    const rawRefresh = extractRefreshToken(req, body.refresh_token ?? body.refreshToken);
    if (!rawRefresh) {
      throw new ApiError(401, "REFRESH_TOKEN_MISSING", "توکن بازیابی ارسال نشده است.");
    }
    const rotated = await rotateRefreshToken({
      refreshToken: rawRefresh,
      ipAddress: getClientIp(req),
      userAgent: req.headers.get("user-agent"),
    });
    const res = ok({
      access_token: rotated.accessToken,
      refresh_token: rotated.refreshToken,
      expires_in: rotated.expiresIn,
      token_type: "Bearer",
    });
    attachAuthCookies(res, {
      accessToken: rotated.accessToken,
      refreshToken: rotated.refreshToken,
      activeOrgId: rotated.session.organizationId,
    });
    return res;
  }

  // POST /api/v1/auth/logout
  if (method === "POST" && sub === "logout") {
    try {
      const auth = await requireAuth(req);
      await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, auth.sessionId));
    } catch {
      // ok even if already expired
    }
    const res = ok({ logged_out: true });
    clearAuthCookies(res);
    return res;
  }

  // POST /api/v1/auth/logout-all
  if (method === "POST" && sub === "logout-all") {
    const auth = await requireAuth(req);
    await db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.userId, auth.userId), isNull(sessions.revokedAt)));
    const res = ok({ logged_out_all: true });
    clearAuthCookies(res);
    return res;
  }

  // POST /api/v1/auth/forgot-password — Issues real 6-digit OTP via SMS.ir / Kavenegar
  if (method === "POST" && sub === "forgot-password") {
    const ip = getClientIp(req);
    checkRateLimit(`otp:${ip}`, 10, 60_000);
    const body = z.object({ mobile: z.string().min(10) }).parse(await req.json());
    const norm = normalizeIranMobile(body.mobile);
    const otpRes = await issueOtpCode({ mobile: norm, purpose: "RESET_PASSWORD" });
    return ok({ action: "forgot-password", status: "OTP_SENT", ...otpRes });
  }

  // POST /api/v1/auth/reset-password — SECURITY FIX: Strictly requires valid single-use OTP + revokes sessions!
  if (method === "POST" && sub === "reset-password") {
    const body = z
      .object({
        mobile: z.string().min(10),
        otp_code: z.string().min(4).max(8),
        new_password: z.string().min(6, "رمز عبور جدید حداقل ۶ کاراکتر باشد."),
      })
      .parse(await req.json());

    const norm = normalizeIranMobile(body.mobile);
    await verifyAndConsumeOtpCode({
      mobile: norm,
      purpose: "RESET_PASSWORD",
      code: body.otp_code,
    });

    const [targetUser] = await db
      .select()
      .from(users)
      .where(eq(users.phone, norm))
      .limit(1);
    if (!targetUser) {
      throw new ApiError(404, "USER_NOT_FOUND", "کاربری با این شماره موبایل یافت نشد.");
    }

    const hash = await hashPassword(body.new_password);
    await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ passwordHash: hash, updatedAt: new Date() })
        .where(eq(users.id, targetUser.id));
      // Revoke all previous sessions after password reset
      await tx
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(sessions.userId, targetUser.id), isNull(sessions.revokedAt)));
    });

    await recordAuditLog({
      actorUserId: targetUser.id,
      actorEmail: targetUser.email,
      scope: "SECURITY",
      action: "PASSWORD_RESET_OTP_VERIFIED",
      entityType: "USER",
      entityId: targetUser.id,
      ipAddress: getClientIp(req),
    });

    return ok({ action: "reset-password", status: "PASSWORD_UPDATED", sessions_revoked: true });
  }

  // POST /api/v1/auth/resend-verification — Issues mobile verification OTP via SMS.ir / Kavenegar
  if (method === "POST" && sub === "resend-verification") {
    const ip = getClientIp(req);
    checkRateLimit(`otp:${ip}`, 10, 60_000);
    const body = z.object({ mobile: z.string().min(10) }).parse(await req.json());
    const otpRes = await issueOtpCode({ mobile: body.mobile, purpose: "VERIFY_MOBILE" });
    return ok({ action: "resend-verification", status: "OTP_SENT", ...otpRes });
  }

  // POST /api/v1/auth/verify-mobile — Verifies mobile OTP code
  if (method === "POST" && sub === "verify-mobile") {
    const body = z
      .object({
        mobile: z.string().min(10),
        otp_code: z.string().min(4).max(8),
      })
      .parse(await req.json());
    const verified = await verifyAndConsumeOtpCode({
      mobile: body.mobile,
      purpose: "VERIFY_MOBILE",
      code: body.otp_code,
    });
    await db
      .update(users)
      .set({ mobileVerified: true, updatedAt: new Date() })
      .where(eq(users.phone, verified.mobile));
    return ok({ action: "verify-mobile", mobile_verified: true, ...verified });
  }

  // GET /api/v1/auth/me
  if (method === "GET" && sub === "me") {
    const auth = await requireAuth(req);
    const orgs = await getUserOrganizations(auth.userId);
    const requestedOrgId =
      req.headers.get("x-organization-id") ||
      req.cookies.get(ORG_COOKIE_NAME)?.value ||
      orgs[0]?.organizationId ||
      null;
    const activeOrg = orgs.find((o) => o.organizationId === requestedOrgId) ?? orgs[0] ?? null;
    const [platformPerms, orgPerms, subState, [uRow]] = await Promise.all([
      auth.isPlatformAdmin ? loadUserPermissions(auth.userId, null, "PLATFORM") : Promise.resolve(new Set<string>()),
      activeOrg ? loadUserPermissions(auth.userId, activeOrg.organizationId, "ORGANIZATION") : Promise.resolve(new Set<string>()),
      activeOrg ? resolveOrganizationEntitlements(activeOrg.organizationId) : Promise.resolve(null),
      db.select().from(users).where(eq(users.id, auth.userId)).limit(1),
    ]);

    return ok({
      user: {
        id: auth.userId,
        email: auth.email,
        mobile: uRow?.phone ?? null,
        full_name: auth.fullName,
        is_platform_admin: auth.isPlatformAdmin,
      },
      platform_permissions: Array.from(platformPerms),
      organizations: orgs,
      active_organization: activeOrg,
      organization_permissions: Array.from(orgPerms),
      subscription: subState
        ? {
            status: subState.subscriptionStatus,
            plan_code: subState.planCode,
            plan_name_fa: subState.plan?.nameFa ?? "رایگان",
            expires_at: subState.subscription?.expiresAt ?? null,
            entitlements: subState.entitlements,
          }
        : null,
    });
  }

  // PATCH /api/v1/auth/me (update profile OR switch active organization cookie)
  if (method === "PATCH" && sub === "me") {
    const auth = await requireAuth(req);
    const body = (await req.json()) as {
      full_name?: string;
      mobile?: string;
      organization_id?: string;
    };

    if (body.full_name || body.mobile) {
      await db
        .update(users)
        .set({
          ...(body.full_name ? { fullName: body.full_name } : {}),
          ...(body.mobile ? { phone: body.mobile } : {}),
          updatedAt: new Date(),
        })
        .where(eq(users.id, auth.userId));
    }

    if (body.organization_id) {
      const orgs = await getUserOrganizations(auth.userId);
      const matched = orgs.find((o) => o.organizationId === body.organization_id);
      if (!matched) {
        throw new ApiError(403, "TENANT_ACCESS_DENIED", "شما عضو فعال این سازمان نیستید.");
      }
      const res = ok({ active_organization: matched });
      res.cookies.set(ORG_COOKIE_NAME, matched.organizationId, {
        httpOnly: false,
        sameSite: "lax",
        path: "/",
        maxAge: 14 * 86400,
      });
      return res;
    }

    return ok({ updated: true });
  }

  // GET /api/v1/auth/sessions | DELETE /api/v1/auth/sessions/{id}
  if (sub === "sessions") {
    const auth = await requireAuth(req);
    if (method === "GET") {
      const list = await db
        .select({
          id: sessions.id,
          organizationId: sessions.organizationId,
          ipAddress: sessions.ipAddress,
          userAgent: sessions.userAgent,
          expiresAt: sessions.expiresAt,
          revokedAt: sessions.revokedAt,
          createdAt: sessions.createdAt,
        })
        .from(sessions)
        .where(eq(sessions.userId, auth.userId))
        .orderBy(desc(sessions.createdAt));
      return ok(list);
    }
    if (method === "DELETE" && id) {
      await db
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(sessions.id, id), eq(sessions.userId, auth.userId)));
      return ok({ revoked_session_id: id });
    }
  }

  throw new ApiError(404, "ROUTE_NOT_FOUND", `مسیر /api/v1/auth/${sub} یافت نشد.`);
}

export async function handleDeviceRoutes(
  req: NextRequest,
  method: string,
  segments: string[]
) {
  await ensureSeeded();
  const ctx = await requireOrgContext(req, "org.dashboard.read");
  const seg1 = segments[1];
  const seg2 = segments[2];

  // POST /api/v1/devices/register
  if (method === "POST" && seg1 === "register") {
    const body = registerDeviceSchema.parse(await req.json());
    const [existing] = await db
      .select()
      .from(devices)
      .where(
        and(
          eq(devices.organizationId, ctx.organizationId),
          eq(devices.deviceUuid, body.device_id)
        )
      )
      .limit(1);

    if (existing) {
      const [updated] = await db
        .update(devices)
        .set({
          deviceName: body.device_name,
          platform: body.platform.toUpperCase(),
          osVersion: body.os_version ?? existing.osVersion,
          appVersion: body.app_version ?? existing.appVersion,
          status: "ACTIVE",
          updatedAt: new Date(),
        })
        .where(eq(devices.id, existing.id))
        .returning();
      return ok(updated);
    }

    const [created] = await db
      .insert(devices)
      .values({
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        deviceUuid: body.device_id,
        deviceName: body.device_name,
        platform: body.platform.toUpperCase(),
        osVersion: body.os_version ?? null,
        appVersion: body.app_version ?? null,
      })
      .returning();
    return ok(created, 201);
  }

  // GET /api/v1/devices
  if (method === "GET" && !seg1) {
    const q = parseListQuery(req);
    const list = await db
      .select()
      .from(devices)
      .where(eq(devices.organizationId, ctx.organizationId))
      .orderBy(desc(devices.lastSyncAt));
    const { items, total } = applyListFilterAndPaginate(list, q, ["deviceName", "deviceUuid"]);
    return okList(items, { page: q.page, perPage: q.perPage, total });
  }

  // GET /api/v1/devices/{id}
  if (method === "GET" && seg1 && !seg2) {
    const [dev] = await db
      .select()
      .from(devices)
      .where(and(eq(devices.id, seg1), eq(devices.organizationId, ctx.organizationId)))
      .limit(1);
    if (!dev) throw new ApiError(404, "DEVICE_NOT_FOUND", "دستگاه یافت نشد.");
    return ok(dev);
  }

  // POST /api/v1/devices/{id}/revoke
  if (method === "POST" && seg1 && seg2 === "revoke") {
    const [revoked] = await db
      .update(devices)
      .set({ status: "BLOCKED", updatedAt: new Date() })
      .where(and(eq(devices.id, seg1), eq(devices.organizationId, ctx.organizationId)))
      .returning();
    if (!revoked) throw new ApiError(404, "DEVICE_NOT_FOUND", "دستگاه یافت نشد.");
    return ok(revoked);
  }

  throw new ApiError(404, "ROUTE_NOT_FOUND", "مسیر دستگاه‌ها یافت نشد.");
}

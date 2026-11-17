import crypto from "crypto";
import bcrypt from "bcryptjs";
import { NextRequest, NextResponse } from "next/server";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "@/db";
import { sessions, users } from "@/db/schema";
import { ApiError } from "./errors";

export const ACCESS_COOKIE_NAME = "bos_access_token";
export const REFRESH_COOKIE_NAME = "bos_refresh_token";
export const ORG_COOKIE_NAME = "bos_active_org";

const JWT_SECRET =
  process.env.JWT_SECRET || "business-os-modular-monolith-dev-secret-key-2026";
const ACCESS_TTL_SECONDS = 60 * 60 * 2; // 2 hours
const REFRESH_TTL_DAYS = 14;

export interface AccessTokenPayload {
  sub: string; // userId
  sid: string; // sessionId
  email: string;
  isPlatformAdmin: boolean;
  orgId?: string | null;
  iat: number;
  exp: number;
}

// ============================================================================
// Password & Token Hashing
// ============================================================================

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function generateRefreshToken(): string {
  return crypto.randomBytes(48).toString("base64url");
}

// ============================================================================
// Minimal Standards-Compliant HS256 JWT Implementation (Zero External Secret Drift)
// ============================================================================

function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

function base64UrlDecode(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}

export function signAccessToken(
  payload: Omit<AccessTokenPayload, "iat" | "exp">
): string {
  const now = Math.floor(Date.now() / 1000);
  const fullPayload: AccessTokenPayload = {
    ...payload,
    iat: now,
    exp: now + ACCESS_TTL_SECONDS,
  };
  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64UrlEncode(JSON.stringify(fullPayload));
  const signature = crypto
    .createHmac("sha256", JWT_SECRET)
    .update(`${header}.${body}`)
    .digest("base64url");
  return `${header}.${body}.${signature}`;
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new ApiError(401, "TOKEN_INVALID", "توکن احراز هویت نامعتبر است.");
  }
  const [header, body, sig] = parts;
  const expected = crypto
    .createHmac("sha256", JWT_SECRET)
    .update(`${header}.${body}`)
    .digest("base64url");
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    throw new ApiError(401, "TOKEN_INVALID", "امضای توکن احراز هویت نامعتبر است.");
  }
  const payload = JSON.parse(base64UrlDecode(body)) as AccessTokenPayload;
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp <= now) {
    throw new ApiError(401, "TOKEN_EXPIRED", "اعتبار نشست شما به پایان رسیده است.");
  }
  return payload;
}

// ============================================================================
// Session Creation & Refresh Token Rotation (with Reuse Attack Protection)
// ============================================================================

export async function createSessionTokens(params: {
  user: { id: string; email: string; isPlatformAdmin: boolean };
  organizationId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  tokenFamily?: string;
}) {
  const rawRefresh = generateRefreshToken();
  const refreshHash = sha256(rawRefresh);
  const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 86400 * 1000);

  const [session] = await db
    .insert(sessions)
    .values({
      userId: params.user.id,
      organizationId: params.organizationId ?? null,
      ...(params.tokenFamily ? { tokenFamily: params.tokenFamily } : {}),
      refreshTokenHash: refreshHash,
      ipAddress: params.ipAddress ?? null,
      userAgent: params.userAgent ?? null,
      expiresAt,
    })
    .returning();

  const accessToken = signAccessToken({
    sub: params.user.id,
    sid: session.id,
    email: params.user.email,
    isPlatformAdmin: params.user.isPlatformAdmin,
    orgId: params.organizationId ?? null,
  });

  return {
    session,
    accessToken,
    refreshToken: rawRefresh,
    expiresIn: ACCESS_TTL_SECONDS,
  };
}

export async function rotateRefreshToken(params: {
  refreshToken: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  const hash = sha256(params.refreshToken);
  const [existing] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.refreshTokenHash, hash))
    .limit(1);

  if (!existing) {
    throw new ApiError(401, "REFRESH_TOKEN_INVALID", "توکن بازیابی نامعتبر است.");
  }

  // Reuse attack detection: if already revoked, revoke ENTIRE token family immediately!
  if (existing.revokedAt) {
    await db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.tokenFamily, existing.tokenFamily), isNull(sessions.revokedAt)));
    throw new ApiError(
      401,
      "REFRESH_TOKEN_REUSED",
      "استفاده مجدد از توکن منقضی شناسایی شد؛ تمام نشست‌های مرتبط مسدود شدند."
    );
  }

  if (existing.expiresAt.getTime() <= Date.now()) {
    throw new ApiError(401, "REFRESH_TOKEN_EXPIRED", "توکن بازیابی منقضی شده است.");
  }

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, existing.userId))
    .limit(1);

  if (!user || user.status !== "ACTIVE") {
    throw new ApiError(401, "USER_INACTIVE", "حساب کاربری غیرفعال است.");
  }

  // Revoke old session and rotate inside same family
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(eq(sessions.id, existing.id));

  return createSessionTokens({
    user,
    organizationId: existing.organizationId,
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
    tokenFamily: existing.tokenFamily,
  });
}

// ============================================================================
// Cookie & Request Extraction Helpers
// ============================================================================

export function extractAccessToken(req: NextRequest): string | null {
  const authHeader = req.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7).trim();
  }
  return req.cookies.get(ACCESS_COOKIE_NAME)?.value ?? null;
}

export function extractRefreshToken(req: NextRequest, bodyToken?: string): string | null {
  if (bodyToken) return bodyToken;
  return req.cookies.get(REFRESH_COOKIE_NAME)?.value ?? null;
}

export function attachAuthCookies(
  res: NextResponse,
  tokens: { accessToken: string; refreshToken: string; activeOrgId?: string | null }
) {
  const isProd = process.env.NODE_ENV === "production";
  res.cookies.set(ACCESS_COOKIE_NAME, tokens.accessToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: isProd && process.env.COOKIE_SECURE === "true",
    path: "/",
    maxAge: ACCESS_TTL_SECONDS,
  });
  res.cookies.set(REFRESH_COOKIE_NAME, tokens.refreshToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: isProd && process.env.COOKIE_SECURE === "true",
    path: "/",
    maxAge: REFRESH_TTL_DAYS * 86400,
  });
  if (tokens.activeOrgId) {
    res.cookies.set(ORG_COOKIE_NAME, tokens.activeOrgId, {
      httpOnly: false,
      sameSite: "lax",
      path: "/",
      maxAge: REFRESH_TTL_DAYS * 86400,
    });
  }
}

export function clearAuthCookies(res: NextResponse) {
  res.cookies.set(ACCESS_COOKIE_NAME, "", { path: "/", maxAge: 0 });
  res.cookies.set(REFRESH_COOKIE_NAME, "", { path: "/", maxAge: 0 });
  res.cookies.set(ORG_COOKIE_NAME, "", { path: "/", maxAge: 0 });
}

export function getClientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "127.0.0.1"
  );
}

// ============================================================================
// Lightweight Sliding-Window Rate Limiter (Per IP + Bucket)
// ============================================================================

const rateBuckets = new Map<string, { count: number; resetAt: number }>();

export function checkRateLimit(key: string, maxRequests = 60, windowMs = 60_000) {
  const now = Date.now();
  const entry = rateBuckets.get(key);
  if (!entry || entry.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  entry.count += 1;
  if (entry.count > maxRequests) {
    throw new ApiError(
      429,
      "RATE_LIMIT_EXCEEDED",
      "تعداد درخواست‌ها از حد مجاز فراتر رفت. لطفاً کمی بعد تلاش کنید."
    );
  }
}

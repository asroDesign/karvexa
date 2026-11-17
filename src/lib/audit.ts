import { db } from "@/db";
import { auditLogs, systemErrorLogs } from "@/db/schema";

const SENSITIVE_KEYS = new Set([
  "password",
  "passwordHash",
  "refreshToken",
  "refreshTokenHash",
  "accessToken",
  "secret",
  "token",
  "authorization",
  "cookie",
  "purchaseToken",
  "apiKey",
  "api_key",
  "otp",
  "otpCode",
  "otp_code",
  "verificationCode",
  "verification_code",
]);

export function sanitizeForLog(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object") return {};
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(input as Record<string, unknown>)) {
    const low = key.toLowerCase();
    if (
      SENSITIVE_KEYS.has(key) ||
      low.includes("password") ||
      low.includes("secret") ||
      low.includes("apikey") ||
      low.includes("api_key") ||
      low.includes("otp")
    ) {
      result[key] = "[REDACTED]";
    } else if (val && typeof val === "object" && !Array.isArray(val)) {
      result[key] = sanitizeForLog(val);
    } else {
      result[key] = val;
    }
  }
  return result;
}

export async function recordAuditLog(params: {
  organizationId?: string | null;
  actorUserId?: string | null;
  actorEmail?: string | null;
  scope: "PLATFORM" | "ORGANIZATION" | "SECURITY";
  action: string;
  entityType: string;
  entityId?: string | null;
  ipAddress?: string | null;
  severity?: "INFO" | "WARN" | "CRITICAL";
  metadata?: Record<string, unknown>;
}) {
  try {
    await db.insert(auditLogs).values({
      organizationId: params.organizationId ?? null,
      actorUserId: params.actorUserId ?? null,
      actorEmail: params.actorEmail ?? null,
      scope: params.scope,
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId ?? null,
      ipAddress: params.ipAddress ?? null,
      severity: params.severity ?? "INFO",
      metadata: sanitizeForLog(params.metadata ?? {}),
    });
  } catch (e) {
    console.error("[AUDIT_LOG_WRITE_ERROR]", e);
  }
}

export async function recordSystemError(params: {
  organizationId?: string | null;
  source: "API" | "SYNC" | "PAYMENT" | "ACCOUNTING";
  errorCode: string;
  message: string;
  endpoint?: string;
  stackTrace?: string;
}) {
  try {
    await db.insert(systemErrorLogs).values({
      organizationId: params.organizationId ?? null,
      source: params.source,
      errorCode: params.errorCode,
      message: params.message,
      endpoint: params.endpoint ?? null,
      stackTrace: params.stackTrace?.slice(0, 2000) ?? null,
      status: "OPEN",
    });
  } catch (e) {
    console.error("[ERROR_LOG_WRITE_ERROR]", e);
  }
}

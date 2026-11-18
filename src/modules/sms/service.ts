import crypto from "crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { otpCodes, smsLogs, smsSettings } from "@/db/schema";
import { ensureSaasSeeded } from "@/db/seed-saas";
import { sha256 } from "@/lib/auth";
import { ApiError } from "@/lib/errors";

export type SmsProviderCode = "SMS_IR" | "KAVENEGAR";

export function normalizeIranMobile(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.startsWith("98") && digits.length === 12) return `0${digits.slice(2)}`;
  if (digits.startsWith("9") && digits.length === 10) return `0${digits}`;
  return digits;
}

export function maskSecretKey(key: string): string {
  if (!key || key.trim().length === 0) return "";
  if (key.length <= 8) return "••••••••";
  return `${key.slice(0, 4)}••••••••${key.slice(-4)}`;
}

async function resolveProviderConfig(preferred?: SmsProviderCode) {
  await ensureSaasSeeded();
  const rows = await db.select().from(smsSettings);
  if (preferred) {
    const matched = rows.find((r) => r.provider === preferred);
    if (matched) return matched;
  }
  const activeDefault = rows.find((r) => r.isDefault && r.isActive);
  if (activeDefault) return activeDefault;
  const anyActive = rows.find((r) => r.isActive);
  if (anyActive) return anyActive;
  return rows[0] ?? null;
}

/**
 * Unified SMS Gateway dispatcher supporting official SMS.ir REST v1 & Kavenegar REST v1 APIs.
 * Automatically operates safely in sandbox mode when `sandboxMode = true` or API key is blank.
 */
export async function sendSmsViaGateway(params: {
  mobile: string;
  purpose: "OTP" | "PASSWORD_RESET" | "TEST" | "INVITATION" | "NOTIFICATION";
  message: string;
  otpCode?: string;
  provider?: SmsProviderCode;
  organizationId?: string | null;
}) {
  const normalizedMobile = normalizeIranMobile(params.mobile);
  if (!/^09\d{9}$/.test(normalizedMobile)) {
    throw new ApiError(422, "INVALID_MOBILE", "شماره موبایل باید با فرمت صحیح 09XXXXXXXXX وارد شود.");
  }

  const config = await resolveProviderConfig(params.provider);
  if (!config) {
    throw new ApiError(500, "SMS_NOT_CONFIGURED", "پیکربندی سامانه پیامکی یافت نشد.");
  }

  const previewText = params.otpCode
    ? params.message.replace(params.otpCode, "******")
    : params.message.slice(0, 220);

  // Sandbox delivery is a development aid only. Production must never claim that an OTP
  // was sent to a customer when it was only generated locally.
  if (config.sandboxMode || !config.apiKey.trim()) {
    if (process.env.NODE_ENV === "production") {
      throw new ApiError(503, "SMS_PROVIDER_NOT_CONFIGURED", "ارسال پیامک واقعی پیکربندی نشده است؛ کلید API و حالت عملیاتی سرویس پیامک را تنظیم کنید.");
    }
    const fakeRef = `SBX-${config.provider}-${Date.now().toString().slice(-6)}`;
    const [logRow] = await db
      .insert(smsLogs)
      .values({
        organizationId: params.organizationId ?? null,
        provider: config.provider,
        purpose: params.purpose,
        recipientMobile: normalizedMobile,
        messagePreview: `[SANDBOX] ${previewText}`,
        status: "SANDBOX_SENT",
        providerMessageId: fakeRef,
      })
      .returning();

    return {
      sent: true,
      sandbox: true,
      provider: config.provider,
      message_id: fakeRef,
      log_id: logRow.id,
    };
  }

  // LIVE HTTP DISPATCH (SMS.ir v1 OR Kavenegar v1)
  try {
    let providerMessageId = "";

    if (config.provider === "SMS_IR") {
      const extra = (config.extraConfig ?? {}) as Record<string, unknown>;
      const baseUrl = String(extra.base_url || "https://api.sms.ir/v1").replace(/\/$/, "");
      const paramName = String(extra.otp_param_name || "CODE");

      if (params.otpCode && config.otpTemplateId) {
        // Official SMS.ir Verify API
        const res = await fetch(`${baseUrl}/send/verify`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/plain",
            "X-API-KEY": config.apiKey,
          },
          body: JSON.stringify({
            mobile: normalizedMobile,
            templateId: Number(config.otpTemplateId) || config.otpTemplateId,
            parameters: [{ name: paramName, value: params.otpCode }],
          }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          status?: number;
          message?: string;
          data?: { messageId?: number | string };
        };
        if (!res.ok || (data.status !== undefined && data.status !== 1)) {
          throw new Error(data.message || `SMS.ir HTTP ${res.status}`);
        }
        providerMessageId = String(data.data?.messageId ?? `smsir-${Date.now()}`);
      } else {
        // Official SMS.ir Bulk/Single Send API
        const res = await fetch(`${baseUrl}/send/bulk`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/plain",
            "X-API-KEY": config.apiKey,
          },
          body: JSON.stringify({
            lineNumber: Number(config.lineNumber) || config.lineNumber,
            messageText: params.message,
            mobiles: [normalizedMobile],
          }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          status?: number;
          message?: string;
          data?: { packId?: string };
        };
        if (!res.ok || (data.status !== undefined && data.status !== 1)) {
          throw new Error(data.message || `SMS.ir HTTP ${res.status}`);
        }
        providerMessageId = String(data.data?.packId ?? `smsir-${Date.now()}`);
      }
    } else if (config.provider === "KAVENEGAR") {
      const extra = (config.extraConfig ?? {}) as Record<string, unknown>;
      const baseUrl = String(extra.base_url || "https://api.kavenegar.com/v1").replace(/\/$/, "");

      if (params.otpCode && config.otpTemplateId) {
        // Official Kavenegar Verify Lookup API
        const form = new URLSearchParams({
          receptor: normalizedMobile,
          token: params.otpCode,
          template: config.otpTemplateId,
          type: String(extra.lookup_type || "sms"),
        });
        const res = await fetch(`${baseUrl}/${encodeURIComponent(config.apiKey)}/verify/lookup.json`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form.toString(),
        });
        const data = (await res.json().catch(() => ({}))) as {
          return?: { status?: number; message?: string };
          entries?: Array<{ messageid?: number | string }>;
        };
        if (!res.ok || (data.return?.status && data.return.status !== 200)) {
          throw new Error(data.return?.message || `Kavenegar HTTP ${res.status}`);
        }
        providerMessageId = String(data.entries?.[0]?.messageid ?? `kav-${Date.now()}`);
      } else {
        // Official Kavenegar Simple Send API
        const form = new URLSearchParams({
          receptor: normalizedMobile,
          message: params.message,
          ...(config.lineNumber ? { sender: config.lineNumber } : {}),
        });
        const res = await fetch(`${baseUrl}/${encodeURIComponent(config.apiKey)}/sms/send.json`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form.toString(),
        });
        const data = (await res.json().catch(() => ({}))) as {
          return?: { status?: number; message?: string };
          entries?: Array<{ messageid?: number | string }>;
        };
        if (!res.ok || (data.return?.status && data.return.status !== 200)) {
          throw new Error(data.return?.message || `Kavenegar HTTP ${res.status}`);
        }
        providerMessageId = String(data.entries?.[0]?.messageid ?? `kav-${Date.now()}`);
      }
    }

    const [logRow] = await db
      .insert(smsLogs)
      .values({
        organizationId: params.organizationId ?? null,
        provider: config.provider,
        purpose: params.purpose,
        recipientMobile: normalizedMobile,
        messagePreview: previewText,
        status: "SENT",
        providerMessageId,
      })
      .returning();

    return {
      sent: true,
      sandbox: false,
      provider: config.provider,
      message_id: providerMessageId,
      log_id: logRow.id,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "خطا در ارسال پیامک";
    await db.insert(smsLogs).values({
      organizationId: params.organizationId ?? null,
      provider: config.provider,
      purpose: params.purpose,
      recipientMobile: normalizedMobile,
      messagePreview: previewText,
      status: "FAILED",
      errorMessage: errMsg,
    });
    throw new ApiError(502, "SMS_DELIVERY_FAILED", `ارسال پیامک از طریق ${config.provider} ناموفق بود: ${errMsg}`);
  }
}

/**
 * Generates a secure 6-digit OTP, stores SHA-256 hash in `otp_codes` (5-min TTL), and dispatches via SMS.ir / Kavenegar.
 */
export async function issueOtpCode(params: {
  mobile: string;
  purpose: "VERIFY_MOBILE" | "RESET_PASSWORD" | "LOGIN_OTP";
}) {
  const normalizedMobile = normalizeIranMobile(params.mobile);
  const code = String(crypto.randomInt(100000, 999999));
  const codeHash = sha256(`${normalizedMobile}:${params.purpose}:${code}`);
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

  // Invalidate any previous unconsumed OTPs for same mobile+purpose
  await db
    .update(otpCodes)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(otpCodes.mobile, normalizedMobile),
        eq(otpCodes.purpose, params.purpose),
        isNull(otpCodes.consumedAt)
      )
    );

  await db.insert(otpCodes).values({
    mobile: normalizedMobile,
    purpose: params.purpose,
    codeHash,
    expiresAt,
  });

  const dispatch = await sendSmsViaGateway({
    mobile: normalizedMobile,
    purpose: params.purpose === "RESET_PASSWORD" ? "PASSWORD_RESET" : "OTP",
    otpCode: code,
    message: `کد تایید Business OS شما: ${code} (اعتبار ۵ دقیقه)`,
  });

  return {
    mobile: normalizedMobile,
    purpose: params.purpose,
    expires_in_seconds: 300,
    provider: dispatch.provider,
    sandbox: dispatch.sandbox,
    // Only expose test code in sandbox mode so automated E2E/Android dev testing can verify OTP!
    ...(dispatch.sandbox ? { sandbox_otp_code: code } : {}),
  };
}

/**
 * Verifies & consumes a single-use OTP code with brute-force attempt locking.
 */
export async function verifyAndConsumeOtpCode(params: {
  mobile: string;
  purpose: "VERIFY_MOBILE" | "RESET_PASSWORD" | "LOGIN_OTP";
  code: string;
}) {
  const normalizedMobile = normalizeIranMobile(params.mobile);
  const [latest] = await db
    .select()
    .from(otpCodes)
    .where(
      and(
        eq(otpCodes.mobile, normalizedMobile),
        eq(otpCodes.purpose, params.purpose),
        isNull(otpCodes.consumedAt)
      )
    )
    .orderBy(desc(otpCodes.createdAt))
    .limit(1);

  if (!latest) {
    throw new ApiError(400, "OTP_NOT_FOUND", "کد تایید فعالی برای این شماره یافت نشد. لطفاً مجدداً درخواست کد دهید.");
  }
  if (latest.expiresAt.getTime() <= Date.now()) {
    throw new ApiError(400, "OTP_EXPIRED", "اعتبار کد تایید به پایان رسیده است.");
  }
  if (latest.attempts >= latest.maxAttempts) {
    throw new ApiError(429, "OTP_MAX_ATTEMPTS", "تعداد تلاش‌های اشتباه بیش از حد مجاز است. کد جدید درخواست دهید.");
  }

  const candidateHash = sha256(`${normalizedMobile}:${params.purpose}:${params.code.trim()}`);
  if (candidateHash !== latest.codeHash) {
    await db
      .update(otpCodes)
      .set({ attempts: latest.attempts + 1 })
      .where(eq(otpCodes.id, latest.id));
    throw new ApiError(400, "OTP_INVALID", "کد تایید واردشده اشتباه است.");
  }

  await db
    .update(otpCodes)
    .set({ consumedAt: new Date() })
    .where(eq(otpCodes.id, latest.id));

  return { verified: true, mobile: normalizedMobile };
}

import crypto from "crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { otpCodes, smsLogs, smsSettings } from "@/db/schema";
import { ensureSaasSeeded } from "@/db/seed-saas";
import { sha256 } from "@/lib/auth";
import { ApiError } from "@/lib/errors";

export type SmsProviderCode = "SMS_IR" | "KAVENEGAR";

export function normalizeIranDigits(raw: string): string {
  return Array.from(raw, (character) => {
    const code = character.codePointAt(0) ?? 0;
    if (code >= 0x06f0 && code <= 0x06f9) return String(code - 0x06f0);
    if (code >= 0x0660 && code <= 0x0669) return String(code - 0x0660);
    return character;
  }).join("");
}

export function normalizeIranMobile(raw: string): string {
  const digits = normalizeIranDigits(raw).replace(/\D/g, "");
  if (digits.startsWith("0098") && digits.length === 14) return `0${digits.slice(4)}`;
  if (digits.startsWith("98") && digits.length === 12) return `0${digits.slice(2)}`;
  if (digits.startsWith("9") && digits.length === 10) return `0${digits}`;
  return digits;
}

export function maskSecretKey(key: string): string {
  if (!key || key.trim().length === 0) return "";
  if (key.length <= 8) return "••••••••";
  return `${key.slice(0, 4)}••••••••${key.slice(-4)}`;
}

export function normalizeSmsIrLineNumber(raw: string): string {
  const digits = normalizeIranDigits(raw).replace(/[\s,٬]/g, "");
  if (!/^\d+$/.test(digits)) {
    throw new ApiError(422, "SMS_IR_LINE_NUMBER_INVALID", "شناسهٔ خط SMS.ir باید فقط عدد باشد؛ از «دریافت خطوط مجاز» خط حساب را انتخاب کنید.");
  }
  const lineNumber = BigInt(digits);
  if (lineNumber <= BigInt(0) || lineNumber > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ApiError(422, "SMS_IR_LINE_NUMBER_INVALID", "شناسهٔ خط SMS.ir معتبر نیست؛ خط مجاز حساب را از تنظیمات دریافت و انتخاب کنید.");
  }
  return lineNumber.toString();
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
 * Reads the SMS.ir account's sender lines using the official GET /v1/line endpoint.
 * This is a read-only diagnostic and never sends a message.
 */
export async function getSmsIrLineNumbers() {
  const config = await resolveProviderConfig("SMS_IR");
  if (!config) throw new ApiError(500, "SMS_NOT_CONFIGURED", "پیکربندی SMS.ir یافت نشد.");
  if (!config.apiKey.trim()) throw new ApiError(503, "SMS_IR_API_KEY_MISSING", "کلید API برای دریافت خطوط SMS.ir ثبت نشده است.");
  if (config.sandboxMode) throw new ApiError(409, "SMS_IR_SANDBOX_ACTIVE", "برای بررسی خطوط واقعی، حالت Sandbox در تنظیمات SMS.ir را خاموش کنید.");

  const extra = (config.extraConfig ?? {}) as Record<string, unknown>;
  const baseUrl = String(extra.base_url || "https://api.sms.ir/v1").replace(/\/$/, "");
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/line`, {
      method: "GET",
      headers: { Accept: "application/json", "X-API-KEY": config.apiKey },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "ارتباط با SMS.ir برقرار نشد.";
    throw new ApiError(502, "SMS_IR_LINE_LOOKUP_FAILED", `دریافت خطوط از SMS.ir ناموفق بود: ${message}`);
  }

  const data = (await response.json().catch(() => ({}))) as { status?: number; message?: string; data?: unknown };
  if (!response.ok || (data.status !== undefined && ![1, 200].includes(data.status))) {
    throw new ApiError(502, "SMS_IR_LINE_LOOKUP_FAILED", `SMS.ir خطوط حساب را برنگرداند (HTTP ${response.status}${data.status !== undefined ? `، کد ${data.status}` : ""}): ${data.message || "خطای نامشخص"}`);
  }
  if (!Array.isArray(data.data)) {
    throw new ApiError(502, "SMS_IR_LINE_RESPONSE_INVALID", "پاسخ فهرست خطوط SMS.ir قالب معتبر ندارد.");
  }

  const lines = [...new Set(data.data.map((line) => normalizeSmsIrLineNumber(String(line))))];
  let configuredLineNumber: string | null = null;
  try {
    configuredLineNumber = normalizeSmsIrLineNumber(config.lineNumber);
  } catch {
    configuredLineNumber = null;
  }
  return {
    provider: "SMS_IR" as const,
    line_numbers: lines,
    configured_line_number: configuredLineNumber,
    configured_line_matches: configuredLineNumber !== null && lines.includes(configuredLineNumber),
  };
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

      if (params.purpose === "TEST" && !params.otpCode) {
        throw new Error("آزمون SMS.ir باید از قالب Verify ارسال شود؛ کد آزمایشی در درخواست وجود ندارد.");
      }
      if (params.otpCode && !/^\d+$/.test(config.otpTemplateId)) {
        throw new Error("برای ارسال Verify در SMS.ir یک شناسه عددی قالب OTP در تنظیمات ثبت کنید.");
      }

      if (params.otpCode) {
        // Match Organo: SMS.ir Verify endpoint, X-API-KEY and {mobile, templateId, parameters}.
        const res = await fetch("https://api.sms.ir/v1/send/verify", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/plain",
            "x-api-key": config.apiKey,
          },
          body: JSON.stringify({
            mobile: normalizedMobile,
            templateId: Number(config.otpTemplateId),
            parameters: [{ name: paramName, value: params.otpCode }],
          }),
          signal: AbortSignal.timeout(8_000),
          cache: "no-store",
        });
        const rawResponse = (await res.text()).slice(0, 500);
        const data = (() => {
          try {
            return JSON.parse(rawResponse) as { status?: number; message?: string; data?: { messageId?: number | string } };
          } catch {
            return null;
          }
        })();
        if (!res.ok || (data?.status !== undefined && Number(data.status) !== 1)) {
          throw new Error(data?.message || rawResponse || "SMS.ir Verify HTTP " + res.status);
        }
        providerMessageId = String(data?.data?.messageId ?? "smsir-" + Date.now());
      } else {
        // Match Organо's working direct-message method: POST /v1/send.
        // SMS.ir accepts the sender line as a number; keep the same default line
        // used by Organо when no sender line is configured.
        const lineDigits = normalizeIranDigits(config.lineNumber).replace(/\D/g, "");
        const lineNumber = Number(lineDigits) || 30007732000000;
        const res = await fetch(`${baseUrl}/send`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-KEY": config.apiKey,
          },
          body: JSON.stringify({ lineNumber, messageText: params.message, mobiles: [normalizedMobile] }),
        });
        const rawResponse = await res.text();
        const response = rawResponse.slice(0, 500);
        const data = (() => {
          try {
            return JSON.parse(rawResponse) as {
              status?: number;
              message?: string;
              data?: { messageId?: number | string; packId?: string };
            };
          } catch {
            return null;
          }
        })();
        if (!res.ok || ![1, 2].includes(Number(data?.status))) {
          const providerMessage = data?.message || response || "خطای نامشخص";
          const invalidLine = /(?:خط|line).{0,40}(?:نامعتبر|invalid)|(?:نامعتبر|invalid).{0,40}(?:خط|line)/i.test(providerMessage);
          const lineHint = invalidLine ? " خط ارسال ذخیره‌شده را در تنظیمات SMS.ir بررسی کنید." : "";
          throw new Error(`SMS.ir ارسال مستقیم را نپذیرفت (HTTP ${res.status}${data?.status !== undefined ? `، کد ${data.status}` : ""}): ${providerMessage}.${lineHint}`);
        }
        providerMessageId = String(data?.data?.messageId ?? data?.data?.packId ?? `smsir-${Date.now()}`);
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

  const normalizedCode = normalizeIranDigits(params.code).trim();
  const candidateHash = sha256(`${normalizedMobile}:${params.purpose}:${normalizedCode}`);
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

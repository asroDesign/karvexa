import { NextRequest } from "next/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { smsLogs, smsSettings } from "@/db/schema";
import { ensureSeeded } from "@/db/seed";
import { recordAuditLog } from "@/lib/audit";
import { handleApiError, ok } from "@/lib/errors";
import { requirePlatformAdmin } from "@/lib/tenant";
import { getSmsIrLineNumbers, maskSecretKey, sendSmsViaGateway } from "@/modules/sms/service";

const updateSmsSchema = z.object({
  provider: z.enum(["SMS_IR", "KAVENEGAR"]),
  is_active: z.boolean().optional(),
  is_default: z.boolean().optional(),
  sandbox_mode: z.boolean().optional(),
  api_key: z.string().optional(),
  line_number: z.string().max(48).optional(),
  otp_template_id: z.string().max(80).optional(),
  invoice_template_id: z.string().max(80).optional(),
  cheque_template_id: z.string().max(80).optional(),
  extra_config: z.record(z.string(), z.unknown()).optional(),
});

const testSmsSchema = z.object({
  provider: z.enum(["SMS_IR", "KAVENEGAR"]).optional(),
  mobile: z.string().min(10),
  message: z.string().min(3).default("پیامک تست اتصال درگاه Business OS با موفقیت ارسال شد."),
});

export async function GET(req: NextRequest) {
  try {
    await ensureSeeded();
    await requirePlatformAdmin(req, "platform.settings.manage");

    if (req.nextUrl.searchParams.get("action") === "lines") {
      z.enum(["SMS_IR"]).parse(req.nextUrl.searchParams.get("provider") || "SMS_IR");
      return ok(await getSmsIrLineNumbers());
    }

    const [providers, logs] = await Promise.all([
      db.select().from(smsSettings),
      db.select().from(smsLogs).orderBy(desc(smsLogs.createdAt)).limit(40),
    ]);

    return ok({
      providers: providers.map((p) => ({
        id: p.id,
        provider: p.provider,
        is_active: p.isActive,
        is_default: p.isDefault,
        sandbox_mode: p.sandboxMode,
        has_api_key: p.apiKey.trim().length > 0,
        api_key_masked: maskSecretKey(p.apiKey),
        line_number: p.lineNumber,
        otp_template_id: p.otpTemplateId,
        invoice_template_id: p.invoiceTemplateId,
        cheque_template_id: p.chequeTemplateId,
        extra_config: p.extraConfig,
        updated_at: p.updatedAt,
      })),
      logs,
    });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function PATCH(req: NextRequest) {
  try {
    await ensureSeeded();
    const admin = await requirePlatformAdmin(req, "platform.settings.manage");
    const body = updateSmsSchema.parse(await req.json());

    const [existing] = await db
      .select()
      .from(smsSettings)
      .where(eq(smsSettings.provider, body.provider))
      .limit(1);

    // If setting this provider as default, unset default on the other provider
    if (body.is_default === true) {
      await db.update(smsSettings).set({ isDefault: false });
    }

    const updateFields: Partial<typeof smsSettings.$inferInsert> = {
      ...(body.is_active !== undefined ? { isActive: body.is_active } : {}),
      ...(body.is_default !== undefined ? { isDefault: body.is_default } : {}),
      ...(body.sandbox_mode !== undefined ? { sandboxMode: body.sandbox_mode } : {}),
      // Only overwrite api_key when a new non-masked value is supplied!
      ...(body.api_key !== undefined && !body.api_key.includes("••••")
        ? { apiKey: body.api_key.trim() }
        : {}),
      ...(body.line_number !== undefined ? { lineNumber: body.line_number.trim() } : {}),
      ...(body.otp_template_id !== undefined ? { otpTemplateId: body.otp_template_id.trim() } : {}),
      ...(body.invoice_template_id !== undefined ? { invoiceTemplateId: body.invoice_template_id.trim() } : {}),
      ...(body.cheque_template_id !== undefined ? { chequeTemplateId: body.cheque_template_id.trim() } : {}),
      ...(body.extra_config !== undefined ? { extraConfig: body.extra_config } : {}),
      updatedBy: admin.userId,
      updatedAt: new Date(),
    };

    let saved;
    if (existing) {
      [saved] = await db
        .update(smsSettings)
        .set(updateFields)
        .where(eq(smsSettings.id, existing.id))
        .returning();
    } else {
      [saved] = await db
        .insert(smsSettings)
        .values({
          provider: body.provider,
          isActive: body.is_active ?? true,
          isDefault: body.is_default ?? false,
          sandboxMode: body.sandbox_mode ?? true,
          apiKey: body.api_key?.trim() ?? "",
          lineNumber: body.line_number?.trim() ?? "",
          otpTemplateId: body.otp_template_id?.trim() ?? "",
          invoiceTemplateId: body.invoice_template_id?.trim() ?? "",
          chequeTemplateId: body.cheque_template_id?.trim() ?? "",
          extraConfig: body.extra_config ?? {},
          updatedBy: admin.userId,
        })
        .returning();
    }

    await recordAuditLog({
      actorUserId: admin.userId,
      actorEmail: admin.email,
      scope: "PLATFORM",
      action: "SMS_PROVIDER_CONFIG_UPDATED",
      entityType: "SMS_SETTINGS",
      entityId: body.provider,
      ipAddress: admin.ipAddress,
      metadata: {
        provider: body.provider,
        isActive: saved.isActive,
        isDefault: saved.isDefault,
        sandboxMode: saved.sandboxMode,
        lineNumber: saved.lineNumber,
      },
    });

    return ok({
      provider: {
        ...saved,
        apiKey: undefined,
        has_api_key: saved.apiKey.trim().length > 0,
        api_key_masked: maskSecretKey(saved.apiKey),
      },
    });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    await ensureSeeded();
    const admin = await requirePlatformAdmin(req, "platform.settings.manage");
    const body = testSmsSchema.parse(await req.json());

    const result = await sendSmsViaGateway({
      mobile: body.mobile,
      purpose: "TEST",
      message: body.message,
      provider: body.provider,
    });

    await recordAuditLog({
      actorUserId: admin.userId,
      actorEmail: admin.email,
      scope: "PLATFORM",
      action: "SMS_TEST_DISPATCHED",
      entityType: "SMS_GATEWAY",
      entityId: result.provider,
      ipAddress: admin.ipAddress,
      metadata: { provider: result.provider, sandbox: result.sandbox },
    });

    return ok(result);
  } catch (err) {
    return handleApiError(err);
  }
}

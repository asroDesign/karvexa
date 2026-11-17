import { NextRequest } from "next/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { paymentGatewaySettings, paymentOrders } from "@/db/schema";
import { ensureSeeded } from "@/db/seed";
import { recordAuditLog } from "@/lib/audit";
import { handleApiError, ok } from "@/lib/errors";
import { requirePlatformAdmin } from "@/lib/tenant";
import { maskSecretKey } from "@/modules/sms/service";

const updateGatewaySchema = z.object({
  gateway: z.enum(["ZARINPAL", "ZIBAL", "BALLEH_PAY", "SAMAN"]),
  is_active: z.boolean().optional(),
  is_default: z.boolean().optional(),
  priority: z.number().int().min(1).max(100).optional(),
  sandbox_mode: z.boolean().optional(),
  merchant_id: z.string().optional(),
  secret_token: z.string().optional(),
  callback_base_url: z.string().max(240).optional(),
  extra_config: z.record(z.string(), z.unknown()).optional(),
});

export async function GET(req: NextRequest) {
  try {
    await ensureSeeded();
    await requirePlatformAdmin(req, "platform.settings.manage");
    const [gateways, orders] = await Promise.all([
      db.select().from(paymentGatewaySettings),
      db.select().from(paymentOrders).orderBy(desc(paymentOrders.createdAt)).limit(40),
    ]);

    return ok({
      gateways: gateways.map((g) => ({
        id: g.id,
        gateway: g.gateway,
        display_name_fa: g.displayNameFa,
        is_active: g.isActive,
        is_default: g.isDefault,
        priority: g.priority,
        sandbox_mode: g.sandboxMode,
        has_merchant_id: g.merchantId.trim().length > 0,
        merchant_id_masked: maskSecretKey(g.merchantId),
        has_secret_token: g.secretToken.trim().length > 0,
        secret_token_masked: maskSecretKey(g.secretToken),
        callback_base_url: g.callbackBaseUrl,
        extra_config: g.extraConfig,
        updated_at: g.updatedAt,
      })),
      recent_orders: orders,
    });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function PATCH(req: NextRequest) {
  try {
    await ensureSeeded();
    const admin = await requirePlatformAdmin(req, "platform.settings.manage");
    const body = updateGatewaySchema.parse(await req.json());

    if (body.is_default === true) {
      await db.update(paymentGatewaySettings).set({ isDefault: false });
    }

    const [saved] = await db
      .update(paymentGatewaySettings)
      .set({
        ...(body.is_active !== undefined ? { isActive: body.is_active } : {}),
        ...(body.is_default !== undefined ? { isDefault: body.is_default } : {}),
        ...(body.priority !== undefined ? { priority: body.priority } : {}),
        ...(body.sandbox_mode !== undefined ? { sandboxMode: body.sandbox_mode } : {}),
        ...(body.merchant_id !== undefined && !body.merchant_id.includes("••••")
          ? { merchantId: body.merchant_id.trim() }
          : {}),
        ...(body.secret_token !== undefined && !body.secret_token.includes("••••")
          ? { secretToken: body.secret_token.trim() }
          : {}),
        ...(body.callback_base_url !== undefined ? { callbackBaseUrl: body.callback_base_url.trim() } : {}),
        ...(body.extra_config !== undefined ? { extraConfig: body.extra_config } : {}),
        updatedBy: admin.userId,
        updatedAt: new Date(),
      })
      .where(eq(paymentGatewaySettings.gateway, body.gateway))
      .returning();

    await recordAuditLog({
      actorUserId: admin.userId,
      actorEmail: admin.email,
      scope: "PLATFORM",
      action: "PAYMENT_GATEWAY_UPDATED",
      entityType: "PAYMENT_GATEWAY",
      entityId: body.gateway,
      ipAddress: admin.ipAddress,
      metadata: {
        gateway: body.gateway,
        isActive: saved?.isActive,
        isDefault: saved?.isDefault,
        sandboxMode: saved?.sandboxMode,
      },
    });

    return ok({
      gateway: saved
        ? {
            ...saved,
            merchantId: undefined,
            secretToken: undefined,
            merchant_id_masked: maskSecretKey(saved.merchantId),
            secret_token_masked: maskSecretKey(saved.secretToken),
          }
        : null,
    });
  } catch (err) {
    return handleApiError(err);
  }
}

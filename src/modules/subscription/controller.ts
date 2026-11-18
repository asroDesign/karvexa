import { NextRequest } from "next/server";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { NextResponse } from "next/server";
import {
  devices,
  features,
  organizations,
  files,
  paymentGatewaySettings,
  paymentOrders,
  paymentTransactions,
  planFeatures,
  plans,
  purchaseReceipts,
  subscriptions,
  syncBatches,
  syncConflicts,
} from "@/db/schema";
import {
  buildSignedEntitlementSnapshot,
  initiateSubscriptionUpgrade,
  PaymentGatewayCode,
  processPaymentGatewayCallback,
} from "@/modules/payments/gateways";
import { handleCloudMigrationRoutes } from "@/modules/offline-mode/controller";
import { getClientIp } from "@/lib/auth";
import { ensureSeeded } from "@/db/seed";
import { ApiError, ok } from "@/lib/errors";
import { checkIdempotency, saveIdempotency } from "@/lib/idempotency";
import {
  requireAuth,
  requireOrgContext,
  requirePlatformAdmin,
  resolveOrganizationEntitlements,
} from "@/lib/tenant";
import {
  restoreOrganizationPurchases,
  verifyCafeBazaarPurchase,
} from "@/modules/subscription/service";
import {
  acknowledgeSyncCursor,
  getAllowedResolutions,
  getOrganizationSyncStatus,
  pullSyncDelta,
  pushSyncBatch,
  resetSyncCheckpoint,
  resolveSyncConflict,
} from "@/modules/sync/service";
import { syncCheckpoints } from "@/db/schema";

export async function handleSubscriptionRoutes(
  req: NextRequest,
  method: string,
  segments: string[]
) {
  await ensureSeeded();
  const sub = segments[1];
  const sub2 = segments[2];

  // Android's authoritative offline-entitlement contract.
  if (method === "GET" && sub === "me" && sub2 === "changes") {
    const ctx = await requireOrgContext(req, "org.dashboard.read");
    const sinceVersion = Number.parseInt(req.nextUrl.searchParams.get("since_version") ?? "0", 10) || 0;
    const snapshot = await buildSignedEntitlementSnapshot(ctx.organizationId);
    const hasChanges = sinceVersion < snapshot.entitlement_version;
    return ok({
      has_changes: hasChanges,
      current_version: snapshot.entitlement_version,
      server_time_ms: snapshot.server_time_ms,
      changes: hasChanges
        ? [{
            version: snapshot.entitlement_version,
            change_type: "ENTITLEMENT_SNAPSHOT",
            summary_fa: "وضعیت اشتراک و مجوزهای سازمان به‌روز شد.",
            changed_keys: ["subscription", "entitlements"],
          }]
        : [],
      latest_snapshot: hasChanges ? snapshot : null,
    });
  }

  if (method === "GET" && sub === "me") {
    const ctx = await requireOrgContext(req, "org.dashboard.read");
    return ok(await buildSignedEntitlementSnapshot(ctx.organizationId));
  }

  // GET /api/v1/subscription/plans
  if (method === "GET" && sub === "plans") {
    await requireAuth(req);
    const [allPlans, allFeatures, allPlanFeats, activeGateways] = await Promise.all([
      db.select().from(plans).where(eq(plans.isActive, true)),
      db.select().from(features),
      db.select().from(planFeatures),
      db.select().from(paymentGatewaySettings).where(eq(paymentGatewaySettings.isActive, true)),
    ]);
    const featureById = new Map(allFeatures.map((feature) => [feature.id, feature]));
    return ok({
      currency_code: "IRT",
      available_gateways: activeGateways
        .sort((a, b) => a.priority - b.priority)
        .map((gateway) => ({ code: gateway.gateway, display_name_fa: gateway.displayNameFa, is_recommended: gateway.isDefault })),
      plans: allPlans.map((plan) => {
        type AssignedPlanFeature =
          | { kind: "limit"; key: string; title: string; value: number | null; unit: string }
          | { kind: "feature"; key: string; title: string; enabled: boolean };
        const assigned: AssignedPlanFeature[] = allPlanFeats.filter((row) => row.planId === plan.id).flatMap((row): AssignedPlanFeature[] => {
          const feature = featureById.get(row.featureId);
          if (!feature) return [];
          if (feature.valueType === "LIMIT") {
            const unit = feature.code.includes("warehouse") ? "warehouse"
              : feature.code.includes("user") ? "user"
                : feature.code.includes("document") ? "document" : "count";
            return [{ kind: "limit" as const, key: feature.code, title: feature.nameFa, value: row.limitValue, unit }];
          }
          return [{ kind: "feature" as const, key: feature.code, title: feature.nameFa, enabled: row.enabled }];
        });
        return {
          code: plan.code,
          display_name_fa: plan.nameFa,
          description_fa: plan.description ?? "",
          billing_cycle: plan.billingDays >= 360 ? "ANNUAL" : "MONTHLY",
          price_amount: plan.priceIrr,
          discount_percent: "0",
          currency_code: "IRT",
          is_popular: false,
          is_active: plan.isActive,
          features: assigned.filter((item) => item.kind === "feature").map((item) => ({
            key: item.key, title_fa: item.title, is_enabled: item.enabled,
          })),
          limits: assigned.filter((item) => item.kind === "limit").map((item) => ({
            key: item.key, title_fa: item.title, limit_value: item.value, limit_unit: item.unit,
          })),
        };
      }),
    });
  }

  // GET /api/v1/subscription/current
  if (method === "GET" && sub === "current") {
    const ctx = await requireOrgContext(req, "org.dashboard.read");
    const subState = await resolveOrganizationEntitlements(ctx.organizationId);
    const receipts = await db
      .select()
      .from(purchaseReceipts)
      .where(eq(purchaseReceipts.organizationId, ctx.organizationId))
      .orderBy(desc(purchaseReceipts.verifiedAt));
    return ok({
      status: subState.subscriptionStatus,
      plan_code: subState.planCode,
      plan: subState.plan,
      subscription: subState.subscription,
      entitlements: subState.entitlements,
      data_export_always_allowed: true,
      receipts: receipts.map((r) => ({
        id: r.id,
        provider: r.provider,
        sku: r.sku,
        verification_status: r.verificationStatus,
        verified_at: r.verifiedAt,
      })),
    });
  }

  // GET /api/v1/subscriptions/entitlements/version (Pull-fallback entitlement version discovery!)
  if (method === "GET" && sub === "entitlements" && sub2 === "version") {
    const ctx = await requireOrgContext(req, "org.dashboard.read");
    const snapshot = await buildSignedEntitlementSnapshot(ctx.organizationId);
    return ok({
      entitlement_version: snapshot.entitlement_version,
      subscription_status: snapshot.status,
      expires_at: snapshot.expires_at,
      server_time: snapshot.server_time,
    });
  }

  // GET /api/v1/subscriptions/entitlements (Prompt 08 §2.13 + Prompt 09A §11)
  if (method === "GET" && sub === "entitlements") {
    const ctx = await requireOrgContext(req, "org.dashboard.read");
    const snapshot = await buildSignedEntitlementSnapshot(ctx.organizationId);
    return ok({
      ...snapshot,
      entitlements: snapshot.features, // backward-compatible alias
    });
  }

  // GET /api/v1/subscription/gateways (List active configured payment gateways for Android/Web checkout)
  if (method === "GET" && sub === "gateways") {
    await requireAuth(req);
    const list = await db
      .select({
        gateway: paymentGatewaySettings.gateway,
        displayNameFa: paymentGatewaySettings.displayNameFa,
        isDefault: paymentGatewaySettings.isDefault,
        sandboxMode: paymentGatewaySettings.sandboxMode,
      })
      .from(paymentGatewaySettings)
      .where(eq(paymentGatewaySettings.isActive, true));
    return ok(list);
  }

  // POST /api/v1/subscription/upgrade (Prompt 08 §2.14 — Create Gateway Checkout Order)
  if (method === "POST" && sub === "upgrade") {
    const ctx = await requireOrgContext(req, "subscriptions.upgrade");
    const body = z
      .object({
        plan_code: z.string().min(2).optional(),
        target_plan_code: z.string().min(2).optional(),
        gateway: z.enum(["ZARINPAL", "ZIBAL", "BALLEH_PAY", "SAMAN"]).optional(),
        preferred_gateway: z.enum(["ZARINPAL", "ZIBAL", "BALLEH_PAY", "SAMAN"]).optional(),
        return_scheme: z.string().optional(),
        return_deep_link: z.string().optional(),
      })
      .refine((value) => Boolean(value.plan_code ?? value.target_plan_code), "plan_code is required")
      .parse(await req.json());
    const planCode = body.plan_code ?? body.target_plan_code!;
    const gateway = body.gateway ?? body.preferred_gateway;
    const returnDeepLink = body.return_scheme ?? body.return_deep_link;

    const idemKey = req.headers.get("idempotency-key");
    const cached = await checkIdempotency({
      organizationId: ctx.organizationId,
      key: idemKey,
      endpoint: "/api/v1/subscription/upgrade",
      payload: body,
    });
    if (cached) return ok(cached.responseBody, cached.statusCode, { replayed: true });

    const originUrl = req.nextUrl.origin || "http://127.0.0.1:3000";
    const orderRes = await initiateSubscriptionUpgrade({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      userEmail: ctx.email,
      ipAddress: ctx.ipAddress,
      planCode,
      gateway: gateway as PaymentGatewayCode | undefined,
      returnDeepLink,
      originUrl,
      idempotencyKey: idemKey,
    });
    const responseBody = {
      ...orderRes,
      outcome: "PAYMENT_REQUIRED",
      invoice: null,
      payment: {
        payment_id: orderRes.payment_reference,
        invoice_id: orderRes.order_id,
        gateway: orderRes.gateway,
        amount: orderRes.amount_irr,
        currency_code: "IRR",
        status: "REDIRECTED",
        payment_url: orderRes.payment_url,
        expires_at_ms: orderRes.expires_at.getTime(),
      },
      latest_snapshot: null,
    };

    await saveIdempotency({
      organizationId: ctx.organizationId,
      key: idemKey,
      endpoint: "/api/v1/subscription/upgrade",
      payload: body,
      statusCode: 201,
      responseBody: responseBody as unknown as Record<string, unknown>,
    });

    return ok(responseBody, 201);
  }

  if (method === "POST" && sub === "renew") {
    const ctx = await requireOrgContext(req, "subscriptions.upgrade");
    const body = z.object({
      billing_cycle: z.enum(["MONTHLY", "ANNUAL"]).optional(),
      preferred_gateway: z.enum(["ZARINPAL", "ZIBAL", "BALLEH_PAY", "SAMAN"]).optional(),
      return_deep_link: z.string().optional(),
    }).parse(await req.json());
    const idemKey = req.headers.get("idempotency-key");
    const cached = await checkIdempotency({
      organizationId: ctx.organizationId,
      key: idemKey,
      endpoint: "/api/v1/subscription/renew",
      payload: body,
    });
    if (cached) return ok(cached.responseBody, cached.statusCode, { replayed: true });

    const state = await resolveOrganizationEntitlements(ctx.organizationId);
    const originUrl = req.nextUrl.origin || "http://127.0.0.1:3000";
    const orderRes = await initiateSubscriptionUpgrade({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      userEmail: ctx.email,
      ipAddress: ctx.ipAddress,
      planCode: state.planCode,
      gateway: body.preferred_gateway as PaymentGatewayCode | undefined,
      returnDeepLink: body.return_deep_link,
      originUrl,
      idempotencyKey: idemKey,
    });
    const responseBody = {
      ...orderRes,
      outcome: "PAYMENT_REQUIRED",
      invoice: null,
      payment: {
        payment_id: orderRes.payment_reference,
        invoice_id: orderRes.order_id,
        gateway: orderRes.gateway,
        amount: orderRes.amount_irr,
        currency_code: "IRR",
        status: "REDIRECTED",
        payment_url: orderRes.payment_url,
        expires_at_ms: orderRes.expires_at.getTime(),
      },
      latest_snapshot: null,
    };
    await saveIdempotency({
      organizationId: ctx.organizationId,
      key: idemKey,
      endpoint: "/api/v1/subscription/renew",
      payload: body,
      statusCode: 201,
      responseBody: responseBody as unknown as Record<string, unknown>,
    });
    return ok(responseBody, 201);
  }

  if (method === "POST" && sub === "cancel") {
    const ctx = await requireOrgContext(req, "subscriptions.upgrade");
    const body = z.object({
      reason: z.string().max(500).optional(),
      effective_at: z.enum(["END_OF_CYCLE", "NOW"]).default("END_OF_CYCLE"),
    }).parse(await req.json());
    const idemKey = req.headers.get("idempotency-key");
    const cached = await checkIdempotency({
      organizationId: ctx.organizationId,
      key: idemKey,
      endpoint: "/api/v1/subscription/cancel",
      payload: body,
    });
    if (cached) return ok(cached.responseBody, cached.statusCode, { replayed: true });

    const [latest] = await db.select().from(subscriptions)
      .where(eq(subscriptions.organizationId, ctx.organizationId))
      .orderBy(desc(subscriptions.expiresAt)).limit(1);
    if (!latest) throw new ApiError(404, "SUBSCRIPTION_NOT_FOUND", "اشتراک فعالی برای لغو تمدید یافت نشد.");
    await db.update(subscriptions).set({ autoRenew: false, updatedAt: new Date() }).where(eq(subscriptions.id, latest.id));
    const [org] = await db.select({ entitlementVersion: organizations.entitlementVersion })
      .from(organizations).where(eq(organizations.id, ctx.organizationId)).limit(1);
    await db.update(organizations).set({ entitlementVersion: (org?.entitlementVersion ?? 1) + 1, updatedAt: new Date() })
      .where(eq(organizations.id, ctx.organizationId));
    const snapshot = await buildSignedEntitlementSnapshot(ctx.organizationId);
    await saveIdempotency({
      organizationId: ctx.organizationId,
      key: idemKey,
      endpoint: "/api/v1/subscription/cancel",
      payload: body,
      statusCode: 200,
      responseBody: snapshot as unknown as Record<string, unknown>,
    });
    return ok(snapshot);
  }

  if (method === "GET" && sub === "invoices") {
    const ctx = await requireOrgContext(req, "org.dashboard.read");
    const rows = await db.select({ order: paymentOrders, plan: plans })
      .from(paymentOrders)
      .innerJoin(plans, eq(paymentOrders.planId, plans.id))
      .where(and(eq(paymentOrders.organizationId, ctx.organizationId), ...(sub2 ? [eq(paymentOrders.id, sub2)] : [])))
      .orderBy(desc(paymentOrders.createdAt));
    const mapped = rows.map(({ order, plan }) => ({
      invoice_id: order.id,
      invoice_number: order.paymentReference,
      plan_code: plan.code,
      plan_name_fa: plan.nameFa,
      billing_cycle: plan.billingDays >= 360 ? "ANNUAL" : "MONTHLY",
      subtotal: order.amountIrr,
      discount_amount: "0.00",
      tax_amount: "0.00",
      total_amount: order.amountIrr,
      currency_code: order.currency === "IRR" ? "IRT" : order.currency,
      status: order.status === "VERIFIED" ? "PAID" : order.status,
      issued_at_ms: order.createdAt.getTime(),
      due_at_ms: order.expiresAt.getTime(),
      paid_at_ms: order.verifiedAt?.getTime() ?? null,
      items: [{ title_fa: plan.nameFa, item_code: plan.code, quantity: 1, unit_amount: order.amountIrr, total_amount: order.amountIrr }],
    }));
    if (sub2) {
      const invoice = mapped[0];
      if (!invoice) throw new ApiError(404, "SUBSCRIPTION_INVOICE_NOT_FOUND", "فاکتور اشتراک یافت نشد.");
      return ok(invoice);
    }
    return ok(mapped);
  }

  // GET /api/v1/subscription/orders/{reference} (Authoritative post-deep-link status check!)
  if (method === "GET" && sub === "orders" && sub2) {
    const ctx = await requireOrgContext(req, "org.dashboard.read");
    const [order] = await db
      .select()
      .from(paymentOrders)
      .where(and(eq(paymentOrders.paymentReference, sub2), eq(paymentOrders.organizationId, ctx.organizationId)))
      .limit(1);
    if (!order) throw new ApiError(404, "PAYMENT_ORDER_NOT_FOUND", "سفارش پرداخت یافت نشد.");
    const snapshot = await buildSignedEntitlementSnapshot(ctx.organizationId);
    return ok({
      order,
      entitlements: snapshot,
    });
  }

  // POST /api/v1/subscription/market/verify (CafeBazaar official verification)
  if (method === "POST" && sub === "market" && sub2 === "verify") {
    const ctx = await requireOrgContext(req, "subscription.manage");
    const idemKey = req.headers.get("idempotency-key");
    if (!idemKey || idemKey.trim().length < 8) {
      throw new ApiError(
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "ارسال هدر Idempotency-Key (حداقل ۸ کاراکتر) برای تایید خرید الزامی است."
      );
    }
    const body = z
      .object({
        package_name: z.string().default("ir.businessos.app"),
        sku: z.string().min(2),
        purchase_token: z.string().min(10),
      })
      .parse(await req.json());

    const replayed = await checkIdempotency({
      organizationId: ctx.organizationId,
      key: idemKey,
      endpoint: "/api/v1/subscription/market/verify",
      payload: body,
    });
    if (replayed) return ok(replayed.responseBody, replayed.statusCode, { replayed: true });

    const activated = await verifyCafeBazaarPurchase({
      organizationId: ctx.organizationId,
      packageName: body.package_name,
      sku: body.sku,
      purchaseToken: body.purchase_token,
      idempotencyKey: idemKey,
      actorUserId: ctx.userId,
      actorEmail: ctx.email,
      ipAddress: ctx.ipAddress,
    });

    const responsePayload = {
      verified: true,
      subscription: activated.subscription,
      payment: activated.payment,
      plan: activated.plan,
    };
    await saveIdempotency({
      organizationId: ctx.organizationId,
      key: idemKey,
      endpoint: "/api/v1/subscription/market/verify",
      payload: body,
      statusCode: 200,
      responseBody: responsePayload as unknown as Record<string, unknown>,
    });
    return ok(responsePayload);
  }

  // POST /api/v1/subscription/market/restore
  if (method === "POST" && sub === "market" && sub2 === "restore") {
    const ctx = await requireOrgContext(req, "subscription.manage");
    return ok(await restoreOrganizationPurchases(ctx.organizationId));
  }

  // GET /api/v1/subscriptions/payments & /api/v1/subscriptions/payments/{id_or_reference}
  if (method === "GET" && sub === "payments") {
    const ctx = await requireOrgContext(req, "org.dashboard.read");
    if (sub2) {
      if (segments[3] === "status") {
        const [order] = await db.select().from(paymentOrders)
          .where(and(eq(paymentOrders.organizationId, ctx.organizationId), eq(paymentOrders.paymentReference, sub2)))
          .limit(1);
        if (!order) throw new ApiError(404, "PAYMENT_NOT_FOUND", "سفارش پرداخت یافت نشد.");
        const snapshot = await buildSignedEntitlementSnapshot(ctx.organizationId);
        const normalizedStatus = order.status === "VERIFIED" ? "PAID" : order.status;
        return ok({
          payment_id: order.paymentReference,
          invoice_id: order.id,
          organization_id: order.organizationId,
          gateway: order.gateway,
          amount: order.amountIrr,
          currency_code: order.currency === "IRR" ? "IRT" : order.currency,
          status: normalizedStatus,
          reference_code: order.gatewayRefId,
          failure_reason: normalizedStatus === "FAILED" ? String(order.callbackPayload?.message ?? "") : null,
          verified_at_ms: order.verifiedAt?.getTime() ?? null,
          subscription_activated: Boolean(order.subscriptionId && normalizedStatus === "PAID"),
          entitlement_version: snapshot.entitlement_version,
          latest_snapshot: normalizedStatus === "PAID" ? snapshot : null,
        });
      }
      const isUuidParam = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sub2);
      if (isUuidParam) {
        const [pay] = await db
          .select()
          .from(paymentTransactions)
          .where(and(eq(paymentTransactions.id, sub2), eq(paymentTransactions.organizationId, ctx.organizationId)))
          .limit(1);
        if (pay) return ok(pay);

        const [orderById] = await db
          .select()
          .from(paymentOrders)
          .where(and(eq(paymentOrders.id, sub2), eq(paymentOrders.organizationId, ctx.organizationId)))
          .limit(1);
        if (orderById) {
          const ent = await buildSignedEntitlementSnapshot(ctx.organizationId);
          return ok({ order: orderById, entitlements: ent });
        }
      }

      const [orderByRef] = await db
        .select()
        .from(paymentOrders)
        .where(and(eq(paymentOrders.paymentReference, sub2), eq(paymentOrders.organizationId, ctx.organizationId)))
        .limit(1);
      if (orderByRef) {
        const ent = await buildSignedEntitlementSnapshot(ctx.organizationId);
        return ok({ order: orderByRef, entitlements: ent });
      }
      throw new ApiError(404, "PAYMENT_NOT_FOUND", "تراکنش یا سفارش پرداخت یافت نشد.");
    }
    const list = await db
      .select()
      .from(paymentTransactions)
      .where(eq(paymentTransactions.organizationId, ctx.organizationId))
      .orderBy(desc(paymentTransactions.createdAt));
    return ok(list);
  }

  throw new ApiError(404, "ROUTE_NOT_FOUND", "مسیر اشتراک یافت نشد.");
}

const ALLOWED_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
  "text/csv",
  "application/json",
]);
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10MB

export async function handleFileRoutes(
  req: NextRequest,
  method: string,
  segments: string[]
) {
  await ensureSeeded();
  const id = segments[1];
  const action = segments[2];
  const ctx = await requireOrgContext(req, "org.dashboard.read");

  // POST /api/v1/files (initiate secure S3-compatible upload)
  if (method === "POST" && !id) {
    const body = z
      .object({
        file_name: z.string().min(1).max(200),
        mime_type: z.string().min(3),
        size_bytes: z.number().int().positive(),
        entity_type: z.string().optional(),
        entity_id: z.string().uuid().optional(),
      })
      .parse(await req.json());

    if (!ALLOWED_MIMES.has(body.mime_type)) {
      throw new ApiError(422, "FILE_TYPE_NOT_ALLOWED", `نوع فایل (${body.mime_type}) مجاز نیست.`);
    }
    if (body.size_bytes > MAX_FILE_BYTES) {
      throw new ApiError(422, "FILE_TOO_LARGE", "حداکثر حجم مجاز فایل ۱۰ مگابایت است.");
    }

    const storageKey = `org/${ctx.organizationId}/${Date.now()}-${body.file_name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    const [fileRow] = await db
      .insert(files)
      .values({
        organizationId: ctx.organizationId,
        uploadedBy: ctx.userId,
        entityType: body.entity_type ?? null,
        entityId: body.entity_id ?? null,
        fileName: body.file_name,
        mimeType: body.mime_type,
        sizeBytes: body.size_bytes,
        storageKey,
        uploadStatus: "PENDING",
      })
      .returning();

    return ok(
      {
        ...fileRow,
        presigned_upload_url: `/storage/s3-upload/${encodeURIComponent(storageKey)}`,
      },
      201
    );
  }

  if (id) {
    const [fileRow] = await db
      .select()
      .from(files)
      .where(
        and(
          eq(files.id, id),
          eq(files.organizationId, ctx.organizationId),
          isNull(files.deletedAt)
        )
      )
      .limit(1);
    if (!fileRow) throw new ApiError(404, "FILE_NOT_FOUND", "فایل یافت نشد.");

    if (method === "GET" && !action) return ok(fileRow);
    if (method === "POST" && action === "complete-upload") {
      const [completed] = await db
        .update(files)
        .set({ uploadStatus: "COMPLETED" })
        .where(eq(files.id, fileRow.id))
        .returning();
      return ok(completed);
    }
    if (method === "DELETE" && !action) {
      await db.update(files).set({ deletedAt: new Date() }).where(eq(files.id, fileRow.id));
      return ok({ deleted_id: fileRow.id });
    }
  }

  throw new ApiError(404, "ROUTE_NOT_FOUND", "مسیر فایل‌ها یافت نشد.");
}

function formatConflictRecord(
  c: typeof syncConflicts.$inferSelect,
  deviceName?: string
) {
  return {
    id: c.id,
    organization_id: c.organizationId,
    device_id: c.deviceId,
    device_name: deviceName ?? "",
    entity_type: c.entityType,
    entity_id: c.entityId,
    conflict_type: c.conflictType,
    local_version: c.clientVersion,
    server_version: c.serverVersion,
    local_payload: c.clientPayload,
    server_payload: c.serverPayload,
    conflicting_fields: c.conflictingFields,
    created_at: c.createdAt,
    resolution_status: c.status,
    resolution: c.resolutionStrategy,
    allowed_resolutions: getAllowedResolutions(c.entityType, c.conflictType),
    resolved_at: c.resolvedAt,
  };
}

export async function handleSyncRoutes(
  req: NextRequest,
  method: string,
  segments: string[]
) {
  await ensureSeeded();
  const sub = segments[1];
  const id = segments[2];
  const action = segments[3];

  // /api/v1/sync/cloud-migration/* & /api/v1/sync/initial-migration/* (Prompt 08 §2.12 + Prompt 09A §10)
  if (sub === "cloud-migration" || sub === "initial-migration") {
    return handleCloudMigrationRoutes(req, method, segments.slice(2));
  }

  // GET /api/v1/sync/status
  if (method === "GET" && sub === "status") {
    const ctx = await requireOrgContext(req, "sync.execute");
    return ok(await getOrganizationSyncStatus(ctx.organizationId));
  }

  // POST /api/v1/sync/push (Prompt 04 §8 & §9)
  if (method === "POST" && sub === "push") {
    const ctx = await requireOrgContext(req, "sync.execute", { requireActiveSubscription: true });
    const batchIdemKey = req.headers.get("idempotency-key");
    if (!batchIdemKey || batchIdemKey.trim().length < 6) {
      throw new ApiError(400, "IDEMPOTENCY_KEY_REQUIRED", "ارسال هدر Idempotency-Key برای Sync الزامی است.");
    }

    const body = z
      .object({
        device_id: z.string().uuid(),
        batch_id: z.string().min(3).optional(),
        client_batch_id: z.string().min(3).optional(),
        events: z
          .array(
            z.object({
              event_id: z.string().min(2).optional(),
              client_event_id: z.string().min(2).optional(),
              idempotency_key: z.string().min(2).optional(),
              entity_type: z.string().min(2),
              entity_id: z.string().uuid().nullable().optional(),
              operation: z.string().min(2),
              base_version: z.number().int().min(0).nullable().optional(),
              dependencies: z.array(z.string()).optional(),
              payload: z.record(z.string(), z.unknown()),
            })
          )
          .min(1),
      })
      .parse(await req.json());

    const batchId = body.batch_id || body.client_batch_id;
    if (!batchId) {
      throw new ApiError(422, "VALIDATION_ERROR", "فیلد batch_id الزامی است.");
    }

    const replayed = await checkIdempotency({
      organizationId: ctx.organizationId,
      key: batchIdemKey,
      endpoint: "/api/v1/sync/push",
      payload: body,
    });
    if (replayed) return ok(replayed.responseBody, replayed.statusCode, { replayed: true });

    const result = await pushSyncBatch({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      userEmail: ctx.email,
      ipAddress: ctx.ipAddress,
      deviceId: body.device_id,
      batchId,
      events: body.events.map((e, idx) => {
        const eid = e.event_id || e.client_event_id || `evt-${batchId}-${idx}`;
        return {
          event_id: eid,
          idempotency_key: e.idempotency_key || `${batchId}:${eid}`,
          entity_type: e.entity_type,
          entity_id: e.entity_id ?? null,
          operation: e.operation,
          base_version: e.base_version ?? 0,
          dependencies: e.dependencies ?? [],
          payload: e.payload,
        };
      }),
    });

    await saveIdempotency({
      organizationId: ctx.organizationId,
      key: batchIdemKey,
      endpoint: "/api/v1/sync/push",
      payload: body,
      statusCode: 200,
      responseBody: result as unknown as Record<string, unknown>,
    });

    return ok(result);
  }

  // GET /api/v1/sync/pull (Prompt 04 §10 — Opaque Cursor + entity_types + limit)
  if (method === "GET" && sub === "pull") {
    const ctx = await requireOrgContext(req, "sync.execute");
    const sp = req.nextUrl.searchParams;
    const deviceId = sp.get("device_id") || req.headers.get("x-device-id");
    if (!deviceId) throw new ApiError(400, "DEVICE_ID_REQUIRED", "شناسه دستگاه (device_id) الزامی است.");

    const cursor = sp.get("cursor") ?? sp.get("since_checkpoint") ?? null;
    const limit = Number(sp.get("limit") ?? 50) || 50;
    const entityTypesParam = sp.get("entity_types");
    const entityTypes = entityTypesParam
      ? entityTypesParam.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;

    return ok(
      await pullSyncDelta({
        organizationId: ctx.organizationId,
        deviceId,
        cursor,
        limit,
        entityTypes,
      })
    );
  }

  // POST /api/v1/sync/acknowledge (Prompt 04 §15)
  if (method === "POST" && sub === "acknowledge") {
    const ctx = await requireOrgContext(req, "sync.execute");
    const body = z
      .object({
        device_id: z.string().uuid(),
        cursor: z.string().min(1),
      })
      .parse(await req.json());
    return ok(
      await acknowledgeSyncCursor({
        organizationId: ctx.organizationId,
        deviceId: body.device_id,
        cursor: body.cursor,
      })
    );
  }

  // GET /api/v1/sync/checkpoints (Prompt 04 §15)
  if (method === "GET" && sub === "checkpoints") {
    const ctx = await requireOrgContext(req, "sync.execute");
    const [cps, orgDevices] = await Promise.all([
      db.select().from(syncCheckpoints).where(eq(syncCheckpoints.organizationId, ctx.organizationId)),
      db.select().from(devices).where(eq(devices.organizationId, ctx.organizationId)),
    ]);
    const devMap = new Map(orgDevices.map((d) => [d.id, d.deviceName]));
    return ok(
      cps.map((cp) => ({
        ...cp,
        device_name: devMap.get(cp.deviceId) ?? "",
      }))
    );
  }

  // POST /api/v1/sync/reset-checkpoint (Prompt 04 §15 — protected, non-destructive)
  if (method === "POST" && sub === "reset-checkpoint") {
    const ctx = await requireOrgContext(req, "sync.execute");
    const body = z
      .object({
        device_id: z.string().uuid(),
        reason: z.string().optional(),
      })
      .parse(await req.json());
    return ok(
      await resetSyncCheckpoint({
        organizationId: ctx.organizationId,
        deviceId: body.device_id,
        actorUserId: ctx.userId,
        actorEmail: ctx.email,
        ipAddress: ctx.ipAddress,
        reason: body.reason,
      })
    );
  }

  // GET /api/v1/sync/conflicts & GET /api/v1/sync/conflicts/{id}
  if (method === "GET" && sub === "conflicts") {
    const ctx = await requireOrgContext(req, "sync.execute");
    if (id) {
      const [c] = await db
        .select()
        .from(syncConflicts)
        .where(and(eq(syncConflicts.id, id), eq(syncConflicts.organizationId, ctx.organizationId)))
        .limit(1);
      if (!c) throw new ApiError(404, "CONFLICT_NOT_FOUND", "تعارض یافت نشد.");
      const [dev] = await db.select().from(devices).where(eq(devices.id, c.deviceId)).limit(1);
      return ok(formatConflictRecord(c, dev?.deviceName));
    }

    const [orgDevices, orgBatches, orgConflicts] = await Promise.all([
      db.select().from(devices).where(eq(devices.organizationId, ctx.organizationId)).orderBy(desc(devices.lastSyncAt)),
      db.select().from(syncBatches).where(eq(syncBatches.organizationId, ctx.organizationId)).orderBy(desc(syncBatches.createdAt)).limit(30),
      db.select().from(syncConflicts).where(eq(syncConflicts.organizationId, ctx.organizationId)).orderBy(desc(syncConflicts.createdAt)).limit(50),
    ]);
    const devMap = new Map(orgDevices.map((d) => [d.id, d.deviceName]));
    return ok({
      devices: orgDevices,
      batches: orgBatches.map((b) => ({ ...b, device_name: devMap.get(b.deviceId) ?? "" })),
      conflicts: orgConflicts.map((c) => formatConflictRecord(c, devMap.get(c.deviceId))),
    });
  }

  // POST /api/v1/sync/conflicts/{id}/resolve (Prompt 04 §16)
  if (method === "POST" && sub === "conflicts" && id && action === "resolve") {
    const raw = (await req.json()) as {
      resolution?: string;
      strategy?: string;
      merged_payload?: Record<string, unknown> | null;
    };
    const rawRes = raw.resolution ?? raw.strategy ?? "";
    const aliasMap: Record<string, "USE_SERVER" | "USE_LOCAL" | "MERGE" | "RECREATE_AS_NEW"> = {
      USE_SERVER: "USE_SERVER",
      SERVER_WINS: "USE_SERVER",
      USE_LOCAL: "USE_LOCAL",
      CLIENT_WINS: "USE_LOCAL",
      MERGE: "MERGE",
      MANUAL_MERGE: "MERGE",
      RECREATE_AS_NEW: "RECREATE_AS_NEW",
    };
    const resolution = aliasMap[rawRes.toUpperCase()];
    if (!resolution) {
      throw new ApiError(
        422,
        "INVALID_CONFLICT_RESOLUTION",
        "مقدار resolution باید یکی از USE_SERVER, USE_LOCAL, MERGE, RECREATE_AS_NEW باشد."
      );
    }

    const auth = await requireAuth(req);
    let targetOrgId: string;
    if (req.nextUrl.searchParams.get("realm") === "platform" && auth.isPlatformAdmin) {
      await requirePlatformAdmin(req, "platform.sync.resolve");
      const [c] = await db.select().from(syncConflicts).where(eq(syncConflicts.id, id)).limit(1);
      if (!c) throw new ApiError(404, "CONFLICT_NOT_FOUND", "تعارض یافت نشد.");
      targetOrgId = c.organizationId;
    } else {
      const ctx = await requireOrgContext(req, "sync.execute");
      targetOrgId = ctx.organizationId;
    }

    const resolved = await resolveSyncConflict({
      organizationId: targetOrgId,
      conflictId: id,
      resolution,
      mergedPayload: raw.merged_payload ?? null,
      actorUserId: auth.userId,
      actorEmail: auth.email,
      ipAddress: auth.ipAddress,
    });
    return ok(resolved);
  }

  throw new ApiError(404, "ROUTE_NOT_FOUND", "مسیر همگام‌سازی یافت نشد.");
}

/**
 * Public Gateway Callback Endpoint: GET/POST /api/v1/payments/callback/{gateway}
 * Performs authoritative server-side verification, idempotently activates subscription,
 * and either returns JSON (when `format=json` or `Accept: application/json`) OR redirects
 * the browser to `/payments/result/{reference}` with verified "بازگشت به اپلیکیشن" App Link!
 */
export async function handlePaymentCallbackRoutes(
  req: NextRequest,
  method: string,
  segments: string[]
) {
  await ensureSeeded();

  // Android payment-status contract: the path parameter is the opaque payment reference.
  if (method === "GET" && segments[1] && segments[1] !== "callback" && segments[2] === "status") {
    const ctx = await requireOrgContext(req, "org.dashboard.read");
    const lookupKey = segments[1];
    let order: typeof paymentOrders.$inferSelect | undefined;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(lookupKey)) {
      [order] = await db
        .select()
        .from(paymentOrders)
        .where(and(eq(paymentOrders.id, lookupKey), eq(paymentOrders.organizationId, ctx.organizationId)))
        .limit(1);
    }
    if (!order) {
      [order] = await db
        .select()
        .from(paymentOrders)
        .where(and(eq(paymentOrders.paymentReference, lookupKey), eq(paymentOrders.organizationId, ctx.organizationId)))
        .limit(1);
    }
    if (!order) throw new ApiError(404, "PAYMENT_ORDER_NOT_FOUND", "سفارش پرداخت یافت نشد.");
    const snapshot = await buildSignedEntitlementSnapshot(ctx.organizationId);
    return ok({
      payment_id: order.paymentReference,
      invoice_id: order.id,
      organization_id: order.organizationId,
      gateway: order.gateway,
      amount: order.amountIrr,
      currency_code: order.currency,
      status: order.status === "VERIFIED" ? "PAID" : order.status,
      reference_code: order.gatewayRefId,
      failure_reason: null,
      verified_at_ms: order.verifiedAt?.getTime() ?? null,
      subscription_activated: order.status === "VERIFIED",
      entitlement_version: snapshot.entitlement_version,
    });
  }

  if (segments[1] !== "callback" || !segments[2]) {
    throw new ApiError(404, "ROUTE_NOT_FOUND", "مسیر بازگشت درگاه پرداخت یافت نشد.");
  }

  const gatewayCode = segments[2];
  const callbackParams: Record<string, string> = {};
  req.nextUrl.searchParams.forEach((v, k) => {
    if (k !== "__v1_path") callbackParams[k] = v;
  });

  if (method === "POST") {
    const contentType = req.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const jsonBody = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      for (const [k, v] of Object.entries(jsonBody)) callbackParams[k] = String(v ?? "");
    } else if (contentType.includes("application/x-www-form-urlencoded")) {
      const form = await req.formData().catch(() => null);
      form?.forEach((v, k) => {
        callbackParams[k] = String(v);
      });
    }
  }

  const res = await processPaymentGatewayCallback({
    gatewayParam: gatewayCode,
    callbackParams,
    ipAddress: getClientIp(req),
  });

  const wantsJson =
    callbackParams.format === "json" ||
    (req.headers.get("accept") || "").includes("application/json");
  if (wantsJson) {
    return ok(res);
  }

  const redirectUrl = new URL(
    `/payments/result/${encodeURIComponent(res.order.paymentReference)}`,
    req.nextUrl.origin
  );
  return NextResponse.redirect(redirectUrl, 302);
}

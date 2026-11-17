import { NextRequest } from "next/server";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { NextResponse } from "next/server";
import {
  devices,
  features,
  files,
  paymentGatewaySettings,
  paymentOrders,
  paymentTransactions,
  planFeatures,
  plans,
  purchaseReceipts,
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

  // GET /api/v1/subscription/plans
  if (method === "GET" && sub === "plans") {
    await requireAuth(req);
    const [allPlans, allFeatures, allPlanFeats] = await Promise.all([
      db.select().from(plans).where(eq(plans.isActive, true)),
      db.select().from(features),
      db.select().from(planFeatures),
    ]);
    return ok(
      allPlans.map((p) => ({
        ...p,
        features: allPlanFeats
          .filter((pf) => pf.planId === p.id)
          .map((pf) => ({
            ...pf,
            feature: allFeatures.find((f) => f.id === pf.featureId),
          })),
      }))
    );
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
        plan_code: z.string().min(2),
        gateway: z.enum(["ZARINPAL", "ZIBAL", "BALLEH_PAY", "SAMAN"]).optional(),
        return_scheme: z.string().optional(),
      })
      .parse(await req.json());

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
      planCode: body.plan_code,
      gateway: body.gateway as PaymentGatewayCode | undefined,
      returnDeepLink: body.return_scheme,
      originUrl,
      idempotencyKey: idemKey,
    });

    await saveIdempotency({
      organizationId: ctx.organizationId,
      key: idemKey,
      endpoint: "/api/v1/subscription/upgrade",
      payload: body,
      statusCode: 201,
      responseBody: orderRes as unknown as Record<string, unknown>,
    });

    return ok(orderRes, 201);
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

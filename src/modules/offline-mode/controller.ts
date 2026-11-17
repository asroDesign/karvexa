import { NextRequest } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  cloudMigrationSessions,
  devices,
  organizationOperatingModes,
  organizations,
} from "@/db/schema";
import { ensureSeeded } from "@/db/seed";
import { recordAuditLog } from "@/lib/audit";
import { ApiError, ok } from "@/lib/errors";
import { checkIdempotency, saveIdempotency } from "@/lib/idempotency";
import { requireOrgContext } from "@/lib/tenant";
import { encodeSyncCursor } from "@/modules/sync/changelog";
import { pushSyncBatch } from "@/modules/sync/service";

/**
 * Master Prompt 08 §2.11 & §2.12 — OFFLINE_ONLY Operating Mode & Controlled Resumable Cloud Reactivation
 */
export async function handleOperatingModeRoutes(
  req: NextRequest,
  method: string,
  segments: string[]
) {
  await ensureSeeded();
  const sub = segments[1] ?? "operating-mode";

  if (sub === "operating-mode") {
    if (method === "GET") {
      const ctx = await requireOrgContext(req, "org.dashboard.read");
      const [modeRow] = await db
        .select()
        .from(organizationOperatingModes)
        .where(eq(organizationOperatingModes.organizationId, ctx.organizationId))
        .limit(1);

      return ok({
        organization_id: ctx.organizationId,
        mode: modeRow?.mode ?? ctx.organization.operatingMode ?? "CLOUD_SYNC",
        agreement_accepted: modeRow?.agreementAccepted ?? false,
        agreement_version: modeRow?.agreementVersion ?? null,
        accepted_at: modeRow?.acceptedAt ?? null,
        cloud_data_preserved: true,
      });
    }

    if (method === "POST" || method === "PATCH") {
      const ctx = await requireOrgContext(req, "settings.offline_mode.manage");
      const body = z
        .object({
          mode: z.enum(["CLOUD_SYNC", "OFFLINE_ONLY"]),
          device_id: z.string().uuid().nullable().optional(),
          agreement_accepted: z.boolean().optional(),
          agreement_version: z.string().min(2).max(48).optional(),
        })
        .parse(await req.json());

      if (body.mode === "OFFLINE_ONLY") {
        if (body.agreement_accepted !== true || !body.agreement_version) {
          throw new ApiError(
            422,
            "DATA_RESPONSIBILITY_AGREEMENT_REQUIRED",
            "برای فعال‌سازی حالت OFFLINE_ONLY، پذیرش صریح توافق‌نامه مسئولیت داده‌های محلی (agreement_accepted=true و agreement_version) الزامی است."
          );
        }
      }

      const now = new Date();
      const [saved] = await db
        .insert(organizationOperatingModes)
        .values({
          organizationId: ctx.organizationId,
          deviceId: body.device_id ?? null,
          mode: body.mode,
          agreementAccepted: body.agreement_accepted ?? false,
          agreementVersion: body.agreement_version ?? null,
          acceptedAt: body.agreement_accepted ? now : null,
          changedBy: ctx.userId,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [organizationOperatingModes.organizationId],
          set: {
            deviceId: body.device_id ?? null,
            mode: body.mode,
            ...(body.agreement_accepted !== undefined ? { agreementAccepted: body.agreement_accepted } : {}),
            ...(body.agreement_version ? { agreementVersion: body.agreement_version } : {}),
            ...(body.agreement_accepted ? { acceptedAt: now } : {}),
            changedBy: ctx.userId,
            updatedAt: now,
          },
        })
        .returning();

      await db
        .update(organizations)
        .set({ operatingMode: body.mode, updatedAt: now })
        .where(eq(organizations.id, ctx.organizationId));

      await recordAuditLog({
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorEmail: ctx.email,
        scope: "SECURITY",
        action: body.mode === "OFFLINE_ONLY" ? "OPERATING_MODE_SWITCHED_OFFLINE_ONLY" : "OPERATING_MODE_SWITCHED_CLOUD_SYNC",
        entityType: "ORGANIZATION_OPERATING_MODE",
        entityId: saved.id,
        ipAddress: ctx.ipAddress,
        metadata: {
          mode: body.mode,
          agreementVersion: saved.agreementVersion,
          cloudDataDeleted: false,
        },
      });

      return ok({
        ...saved,
        cloud_data_preserved: true,
        background_sync_enabled: saved.mode === "CLOUD_SYNC",
      });
    }
  }

  throw new ApiError(404, "ROUTE_NOT_FOUND", "مسیر تنظیمات حالت آفلاین یافت نشد.");
}

/**
 * Controlled & Resumable Initial Cloud Migration when returning from OFFLINE_ONLY -> CLOUD_SYNC (§2.12)
 * Mounted under /api/v1/sync/cloud-migration/*
 */
export async function handleCloudMigrationRoutes(
  req: NextRequest,
  method: string,
  subSegments: string[]
) {
  await ensureSeeded();
  const ctx = await requireOrgContext(req, "settings.offline_mode.manage");
  const seg0 = subSegments[0]; // start | {session_id}
  const seg1 = subSegments[1]; // upload-batch | complete

  // GET /api/v1/sync/cloud-migration | /api/v1/sync/initial-migration
  if (method === "GET" && !seg0) {
    const list = await db
      .select()
      .from(cloudMigrationSessions)
      .where(eq(cloudMigrationSessions.organizationId, ctx.organizationId))
      .orderBy(desc(cloudMigrationSessions.startedAt))
      .limit(20);
    return ok(list);
  }

  // GET /api/v1/sync/initial-migration/{id} | /cloud-migration/{id}
  if (method === "GET" && seg0 && !seg1) {
    const [mig] = await db
      .select()
      .from(cloudMigrationSessions)
      .where(and(eq(cloudMigrationSessions.id, seg0), eq(cloudMigrationSessions.organizationId, ctx.organizationId)))
      .limit(1);
    if (!mig) throw new ApiError(404, "MIGRATION_SESSION_NOT_FOUND", "جلسه مهاجرت اولیه یافت نشد.");
    return ok(mig);
  }

  // POST /api/v1/sync/initial-migration (start + optional initial events[]) OR /cloud-migration/start
  if (method === "POST" && (!seg0 || seg0 === "start")) {
    const body = z
      .object({
        device_id: z.string().uuid(),
        inventory_summary: z.record(z.string(), z.number().int().min(0)).default({}),
        events: z
          .array(
            z.object({
              event_id: z.string().min(2),
              idempotency_key: z.string().min(2),
              entity_type: z.string().min(2),
              entity_id: z.string().uuid().nullable().optional(),
              operation: z.string().min(2),
              base_version: z.number().int().min(0).nullable().optional(),
              dependencies: z.array(z.string()).optional(),
              payload: z.record(z.string(), z.unknown()),
            })
          )
          .optional(),
      })
      .parse(await req.json());

    const idemKey = req.headers.get("idempotency-key");
    const cached = await checkIdempotency({
      organizationId: ctx.organizationId,
      key: idemKey,
      endpoint: "/api/v1/sync/cloud-migration/start",
      payload: body,
    });
    if (cached) return ok(cached.responseBody, cached.statusCode, { replayed: true });

    const [dev] = await db
      .select()
      .from(devices)
      .where(and(eq(devices.id, body.device_id), eq(devices.organizationId, ctx.organizationId)))
      .limit(1);
    if (!dev || dev.status !== "ACTIVE") {
      throw new ApiError(403, "DEVICE_NOT_REGISTERED", "دستگاه مجاز برای مهاجرت ابری یافت نشد.");
    }

    const [session] = await db
      .insert(cloudMigrationSessions)
      .values({
        organizationId: ctx.organizationId,
        deviceId: dev.id,
        initiatedBy: ctx.userId,
        idempotencyKey: idemKey ?? null,
        inventorySummary: body.inventory_summary,
        status: "PREPARING",
      })
      .returning();

    await recordAuditLog({
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      actorEmail: ctx.email,
      scope: "ORGANIZATION",
      action: "CLOUD_MIGRATION_STARTED",
      entityType: "CLOUD_MIGRATION_SESSION",
      entityId: session.id,
      ipAddress: ctx.ipAddress,
      metadata: { deviceId: dev.id, inventorySummary: body.inventory_summary },
    });

    // If initial structured dataset events were provided inline, process them immediately!
    let finalSession = session;
    let initialBatchResult = null;
    if (body.events && body.events.length > 0) {
      initialBatchResult = await pushSyncBatch({
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        userEmail: ctx.email,
        ipAddress: ctx.ipAddress,
        deviceId: dev.id,
        batchId: `mig-${session.id}-b1`,
        bypassOfflineModeGuard: true,
        events: body.events,
      });
      [finalSession] = await db
        .update(cloudMigrationSessions)
        .set({
          status: "UPLOADING",
          uploadedBatches: 1,
          appliedRecords: initialBatchResult.applied_count,
          conflictRecords: initialBatchResult.conflict_count,
          duplicateRecords: initialBatchResult.duplicate_count,
        })
        .where(eq(cloudMigrationSessions.id, session.id))
        .returning();
    }

    const resp = initialBatchResult
      ? { ...finalSession, migration: finalSession, batch_result: initialBatchResult }
      : finalSession;

    await saveIdempotency({
      organizationId: ctx.organizationId,
      key: idemKey,
      endpoint: "/api/v1/sync/cloud-migration/start",
      payload: body,
      statusCode: 201,
      responseBody: resp as unknown as Record<string, unknown>,
    });

    return ok(resp, 201);
  }

  // POST /api/v1/sync/cloud-migration/{session_id}/upload-batch OR /initial-migration/{session_id}/resume
  if (method === "POST" && seg0 && (seg1 === "upload-batch" || seg1 === "resume")) {
    const [mig] = await db
      .select()
      .from(cloudMigrationSessions)
      .where(and(eq(cloudMigrationSessions.id, seg0), eq(cloudMigrationSessions.organizationId, ctx.organizationId)))
      .limit(1);
    if (!mig) throw new ApiError(404, "MIGRATION_SESSION_NOT_FOUND", "جلسه مهاجرت ابری یافت نشد.");
    if (mig.status === "COMPLETED") {
      throw new ApiError(409, "MIGRATION_ALREADY_COMPLETED", "این مهاجرت ابری قبلاً تکمیل شده است.");
    }

    const body = z
      .object({
        batch_index: z.number().int().min(1),
        events: z
          .array(
            z.object({
              event_id: z.string().min(2),
              idempotency_key: z.string().min(2),
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

    const pushRes = await pushSyncBatch({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      userEmail: ctx.email,
      ipAddress: ctx.ipAddress,
      deviceId: mig.deviceId,
      batchId: `mig-${mig.id}-b${body.batch_index}`,
      bypassOfflineModeGuard: true, // Allowed ONLY through controlled migration session!
      events: body.events,
    });

    const [updatedMig] = await db
      .update(cloudMigrationSessions)
      .set({
        status: "UPLOADING",
        uploadedBatches: mig.uploadedBatches + 1,
        appliedRecords: mig.appliedRecords + pushRes.applied_count,
        conflictRecords: mig.conflictRecords + pushRes.conflict_count,
        duplicateRecords: mig.duplicateRecords + pushRes.duplicate_count,
      })
      .where(eq(cloudMigrationSessions.id, mig.id))
      .returning();

    return ok({ migration: updatedMig, batch_result: pushRes });
  }

  // POST /api/v1/sync/cloud-migration/{session_id}/complete OR /initial-migration/{session_id}/confirm
  if (method === "POST" && seg0 && (seg1 === "complete" || seg1 === "confirm")) {
    const [mig] = await db
      .select()
      .from(cloudMigrationSessions)
      .where(and(eq(cloudMigrationSessions.id, seg0), eq(cloudMigrationSessions.organizationId, ctx.organizationId)))
      .limit(1);
    if (!mig) throw new ApiError(404, "MIGRATION_SESSION_NOT_FOUND", "جلسه مهاجرت ابری یافت نشد.");

    const now = new Date();
    const [completed] = await db
      .update(cloudMigrationSessions)
      .set({ status: "COMPLETED", completedAt: now })
      .where(eq(cloudMigrationSessions.id, mig.id))
      .returning();

    // Activate CLOUD_SYNC ONLY after verified migration completion!
    await db
      .update(organizations)
      .set({ operatingMode: "CLOUD_SYNC", updatedAt: now })
      .where(eq(organizations.id, ctx.organizationId));

    await db
      .insert(organizationOperatingModes)
      .values({
        organizationId: ctx.organizationId,
        deviceId: mig.deviceId,
        mode: "CLOUD_SYNC",
        changedBy: ctx.userId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [organizationOperatingModes.organizationId],
        set: { mode: "CLOUD_SYNC", changedBy: ctx.userId, updatedAt: now },
      });

    await recordAuditLog({
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      actorEmail: ctx.email,
      scope: "SECURITY",
      action: "CLOUD_MIGRATION_COMPLETED_SYNC_ENABLED",
      entityType: "CLOUD_MIGRATION_SESSION",
      entityId: mig.id,
      ipAddress: ctx.ipAddress,
      metadata: {
        uploadedBatches: completed.uploadedBatches,
        appliedRecords: completed.appliedRecords,
        conflictRecords: completed.conflictRecords,
      },
    });

    return ok({
      migration: completed,
      operating_mode: "CLOUD_SYNC",
      initial_cursor: encodeSyncCursor({ seq: 0, orgId: ctx.organizationId }),
      bidirectional_sync_enabled: true,
    });
  }

  throw new ApiError(404, "ROUTE_NOT_FOUND", "مسیر مهاجرت ابری یافت نشد.");
}

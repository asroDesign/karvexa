import { NextRequest } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  devices,
  organizations,
  syncBatches,
  syncConflicts,
  syncLogs,
  users,
} from "@/db/schema";
import { handleApiError, ok } from "@/lib/errors";
import { requirePlatformAdmin } from "@/lib/tenant";

export async function GET(req: NextRequest) {
  try {
    await requirePlatformAdmin(req, "platform.sync.read");

    const [allDevices, recentBatches, conflicts, recentSyncLogs] = await Promise.all([
      db
        .select({
          device: devices,
          orgName: organizations.name,
          userFullName: users.fullName,
        })
        .from(devices)
        .innerJoin(organizations, eq(devices.organizationId, organizations.id))
        .innerJoin(users, eq(devices.userId, users.id))
        .orderBy(desc(devices.lastSyncAt)),
      db
        .select({
          batch: syncBatches,
          orgName: organizations.name,
          deviceName: devices.deviceName,
        })
        .from(syncBatches)
        .innerJoin(organizations, eq(syncBatches.organizationId, organizations.id))
        .innerJoin(devices, eq(syncBatches.deviceId, devices.id))
        .orderBy(desc(syncBatches.createdAt))
        .limit(50),
      db
        .select({
          conflict: syncConflicts,
          orgName: organizations.name,
          deviceName: devices.deviceName,
        })
        .from(syncConflicts)
        .innerJoin(organizations, eq(syncConflicts.organizationId, organizations.id))
        .innerJoin(devices, eq(syncConflicts.deviceId, devices.id))
        .orderBy(desc(syncConflicts.createdAt))
        .limit(50),
      db
        .select({
          log: syncLogs,
          orgName: organizations.name,
          deviceName: devices.deviceName,
        })
        .from(syncLogs)
        .innerJoin(organizations, eq(syncLogs.organizationId, organizations.id))
        .innerJoin(devices, eq(syncLogs.deviceId, devices.id))
        .orderBy(desc(syncLogs.startedAt))
        .limit(40),
    ]);

    return ok({ devices: allDevices, batches: recentBatches, conflicts, syncLogs: recentSyncLogs });
  } catch (err) {
    return handleApiError(err);
  }
}

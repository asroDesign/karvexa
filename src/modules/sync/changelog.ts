import crypto from "crypto";
import { db } from "@/db";
import { syncChangeLog } from "@/db/schema";
import { ApiError, toSnakeCase } from "@/lib/errors";

const CURSOR_SECRET =
  process.env.SYNC_CURSOR_SECRET ||
  process.env.JWT_SECRET ||
  "business-os-sync-cursor-hmac-secret-2026";

export interface SyncCursorData {
  seq: number;
  orgId: string;
}

/**
 * Encodes a tamper-evident opaque cursor bound to (organization_id, monotonic seq).
 */
export function encodeSyncCursor(data: SyncCursorData): string {
  const payload = JSON.stringify({ s: data.seq, o: data.orgId });
  const encoded = Buffer.from(payload, "utf8").toString("base64url");
  const sig = crypto
    .createHmac("sha256", CURSOR_SECRET)
    .update(encoded)
    .digest("base64url")
    .slice(0, 16);
  return `bos_c1_${encoded}.${sig}`;
}

export function decodeSyncCursor(
  cursor: string | null | undefined,
  expectedOrgId: string
): number {
  if (!cursor || cursor.trim() === "" || cursor === "0") return 0;

  // Backward compatibility with numeric checkpoints
  if (/^\d+$/.test(cursor.trim())) {
    return Number(cursor.trim());
  }

  if (!cursor.startsWith("bos_c1_")) {
    throw new ApiError(
      400,
      "INVALID_SYNC_CURSOR",
      "مقدار Cursor همگام‌سازی نامعتبر یا منقضی است. لطفاً با reset-checkpoint بازیابی کنید."
    );
  }

  const body = cursor.slice(7);
  const parts = body.split(".");
  if (parts.length !== 2) {
    throw new ApiError(400, "INVALID_SYNC_CURSOR", "ساختار Cursor همگام‌سازی نامعتبر است.");
  }

  const [encoded, sig] = parts;
  const expectedSig = crypto
    .createHmac("sha256", CURSOR_SECRET)
    .update(encoded)
    .digest("base64url")
    .slice(0, 16);

  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new ApiError(400, "INVALID_SYNC_CURSOR", "امضای امنیتی Cursor همگام‌سازی نامعتبر است.");
  }

  let parsed: { s?: unknown; o?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new ApiError(400, "INVALID_SYNC_CURSOR", "محتوای Cursor قابل خواندن نیست.");
  }

  if (parsed.o !== expectedOrgId || typeof parsed.s !== "number" || parsed.s < 0) {
    throw new ApiError(
      403,
      "INVALID_SYNC_CURSOR",
      "Cursor ارسال‌شده متعلق به این سازمان نیست."
    );
  }

  return parsed.s;
}

/**
 * Appends a deterministic monotonic entry to `sync_change_log` (UPSERT or TOMBSTONE).
 */
export async function appendSyncChangeLog(
  executor: Pick<typeof db, "insert">,
  params: {
    organizationId: string;
    entityType: string;
    entityId: string;
    operation: "UPSERT" | "TOMBSTONE";
    version: number;
    sourceDeviceId?: string | null;
    payload: Record<string, unknown>;
  }
) {
  const [row] = await executor
    .insert(syncChangeLog)
    .values({
      organizationId: params.organizationId,
      entityType: params.entityType.toLowerCase(),
      entityId: params.entityId,
      operation: params.operation,
      version: params.version,
      sourceDeviceId: params.sourceDeviceId ?? null,
      payload: (toSnakeCase(params.payload) as Record<string, unknown>) ?? {},
      changedAt: new Date(),
    })
    .returning();
  return row;
}

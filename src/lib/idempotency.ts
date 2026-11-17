import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { idempotencyKeys } from "@/db/schema";
import { sha256 } from "./auth";
import { ApiError } from "./errors";

export async function checkIdempotency(params: {
  organizationId: string;
  key: string | null;
  endpoint: string;
  payload: unknown;
}) {
  if (!params.key) return null;
  const requestHash = sha256(JSON.stringify(params.payload ?? {}));
  const [existing] = await db
    .select()
    .from(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.organizationId, params.organizationId),
        eq(idempotencyKeys.key, params.key)
      )
    )
    .limit(1);

  if (!existing) return null;

  if (existing.requestHash !== requestHash) {
    throw new ApiError(
      409,
      "IDEMPOTENCY_PAYLOAD_MISMATCH",
      "کلید یکتاسازی (Idempotency-Key) قبلاً با داده متفاوتی استفاده شده است."
    );
  }

  return {
    statusCode: existing.statusCode,
    responseBody: existing.responseBody,
  };
}

export async function saveIdempotency(params: {
  organizationId: string;
  key: string | null;
  endpoint: string;
  payload: unknown;
  statusCode: number;
  responseBody: Record<string, unknown>;
}) {
  if (!params.key) return;
  const requestHash = sha256(JSON.stringify(params.payload ?? {}));
  const expiresAt = new Date(Date.now() + 7 * 86400 * 1000);
  await db
    .insert(idempotencyKeys)
    .values({
      organizationId: params.organizationId,
      key: params.key,
      endpoint: params.endpoint,
      requestHash,
      statusCode: params.statusCode,
      responseBody: params.responseBody,
      expiresAt,
    })
    .onConflictDoNothing();
}

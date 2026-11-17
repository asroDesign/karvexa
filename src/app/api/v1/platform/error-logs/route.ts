import { NextRequest } from "next/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { organizations, systemErrorLogs } from "@/db/schema";
import { handleApiError, ok } from "@/lib/errors";
import { requirePlatformAdmin } from "@/lib/tenant";

const patchErrorSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["OPEN", "INVESTIGATING", "RESOLVED"]),
});

export async function GET(req: NextRequest) {
  try {
    await requirePlatformAdmin(req, "platform.errors.read");

    const errors = await db
      .select({
        error: systemErrorLogs,
        orgName: organizations.name,
      })
      .from(systemErrorLogs)
      .leftJoin(organizations, eq(systemErrorLogs.organizationId, organizations.id))
      .orderBy(desc(systemErrorLogs.createdAt))
      .limit(100);

    return ok({ errors });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function PATCH(req: NextRequest) {
  try {
    await requirePlatformAdmin(req, "platform.errors.resolve");
    const body = patchErrorSchema.parse(await req.json());
    const [updated] = await db
      .update(systemErrorLogs)
      .set({ status: body.status })
      .where(eq(systemErrorLogs.id, body.id))
      .returning();
    return ok({ errorLog: updated });
  } catch (err) {
    return handleApiError(err);
  }
}

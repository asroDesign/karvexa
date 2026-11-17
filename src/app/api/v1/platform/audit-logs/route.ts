import { NextRequest } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs, organizations } from "@/db/schema";
import { handleApiError, ok } from "@/lib/errors";
import { requirePlatformAdmin } from "@/lib/tenant";

export async function GET(req: NextRequest) {
  try {
    await requirePlatformAdmin(req, "platform.audit.read");
    const scope = req.nextUrl.searchParams.get("scope");

    const logs = await db
      .select({
        log: auditLogs,
        orgName: organizations.name,
      })
      .from(auditLogs)
      .leftJoin(organizations, eq(auditLogs.organizationId, organizations.id))
      .where(scope ? eq(auditLogs.scope, scope) : undefined)
      .orderBy(desc(auditLogs.createdAt))
      .limit(120);

    return ok({ logs });
  } catch (err) {
    return handleApiError(err);
  }
}

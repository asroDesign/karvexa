import { NextRequest } from "next/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { contactInquiries } from "@/db/schema";
import { ensureSeeded } from "@/db/seed";
import { handleApiError, ok } from "@/lib/errors";
import { requirePlatformAdmin } from "@/lib/tenant";

const patchSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["NEW", "REVIEWED", "REPLIED", "ARCHIVED"]),
  admin_note: z.string().optional(),
});

export async function GET(req: NextRequest) {
  try {
    await ensureSeeded();
    await requirePlatformAdmin(req, "platform.tickets.manage");
    const inquiries = await db
      .select()
      .from(contactInquiries)
      .orderBy(desc(contactInquiries.createdAt))
      .limit(100);
    return ok({ inquiries });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function PATCH(req: NextRequest) {
  try {
    await ensureSeeded();
    await requirePlatformAdmin(req, "platform.tickets.manage");
    const body = patchSchema.parse(await req.json());
    const [updated] = await db
      .update(contactInquiries)
      .set({
        status: body.status,
        ...(body.admin_note !== undefined ? { adminNote: body.admin_note } : {}),
      })
      .where(eq(contactInquiries.id, body.id))
      .returning();
    return ok({ inquiry: updated });
  } catch (err) {
    return handleApiError(err);
  }
}

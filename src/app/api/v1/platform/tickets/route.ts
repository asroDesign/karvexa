import { NextRequest } from "next/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { organizations, supportTickets, users } from "@/db/schema";
import { recordAuditLog } from "@/lib/audit";
import { handleApiError, ok } from "@/lib/errors";
import { requirePlatformAdmin } from "@/lib/tenant";

const patchTicketSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"]),
  resolutionNote: z.string().optional(),
});

export async function GET(req: NextRequest) {
  try {
    await requirePlatformAdmin(req, "platform.tickets.manage");

    const tickets = await db
      .select({
        ticket: supportTickets,
        orgName: organizations.name,
        userFullName: users.fullName,
        userEmail: users.email,
      })
      .from(supportTickets)
      .leftJoin(organizations, eq(supportTickets.organizationId, organizations.id))
      .leftJoin(users, eq(supportTickets.userId, users.id))
      .orderBy(desc(supportTickets.createdAt));

    return ok({ tickets });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const admin = await requirePlatformAdmin(req, "platform.tickets.manage");
    const body = patchTicketSchema.parse(await req.json());

    const [updated] = await db
      .update(supportTickets)
      .set({
        status: body.status,
        ...(body.resolutionNote !== undefined ? { resolutionNote: body.resolutionNote } : {}),
        updatedAt: new Date(),
      })
      .where(eq(supportTickets.id, body.id))
      .returning();

    await recordAuditLog({
      organizationId: updated?.organizationId ?? null,
      actorUserId: admin.userId,
      actorEmail: admin.email,
      scope: "PLATFORM",
      action: "SUPPORT_TICKET_UPDATED",
      entityType: "SUPPORT_TICKET",
      entityId: body.id,
      ipAddress: admin.ipAddress,
      metadata: { status: body.status },
    });

    return ok({ ticket: updated });
  } catch (err) {
    return handleApiError(err);
  }
}

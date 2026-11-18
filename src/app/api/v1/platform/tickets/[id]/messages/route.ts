import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { supportTicketEvents, supportTicketMessages, supportTickets } from "@/db/schema";
import { recordAuditLog } from "@/lib/audit";
import { ApiError, handleApiError, ok } from "@/lib/errors";
import { requirePlatformAdmin, withPlatformTransaction } from "@/lib/tenant";

type RouteContext = { params: Promise<{ id: string }> };
const messageSchema = z.object({ body: z.string().trim().min(1).max(10000), internal: z.boolean().default(false) });

export async function POST(req: NextRequest, { params }: RouteContext) {
  try {
    const admin = await requirePlatformAdmin(req, "platform.tickets.manage");
    const { id } = await params;
    const body = messageSchema.parse(await req.json());
    const created = await withPlatformTransaction(async (tx) => {
      const [ticket] = await tx.select().from(supportTickets).where(eq(supportTickets.id, id)).for("update");
      if (!ticket) throw new ApiError(404, "TICKET_NOT_FOUND", "تیکت پیدا نشد.");
      const now = new Date();
      const [message] = await tx.insert(supportTicketMessages).values({
        organizationId: ticket.organizationId,
        ticketId: id,
        senderUserId: admin.userId,
        senderType: "ADMIN",
        senderName: admin.fullName,
        body: body.body,
        isInternal: body.internal,
        createdAt: now,
      }).returning();
      const nextStatus = !body.internal ? "WAITING_CUSTOMER" : ticket.status;
      await tx.update(supportTickets).set({
        status: nextStatus,
        closedAt: nextStatus === "CLOSED" ? ticket.closedAt : null,
        lastActivityAt: now,
        updatedAt: now,
      }).where(eq(supportTickets.id, id));
      await tx.insert(supportTicketEvents).values({
        organizationId: ticket.organizationId,
        ticketId: id,
        actorUserId: admin.userId,
        actorName: admin.fullName,
        eventType: body.internal ? "INTERNAL_NOTE" : "PUBLIC_REPLY",
        details: { messageId: message.id, status: nextStatus },
        createdAt: now,
      });
      return { message, organizationId: ticket.organizationId };
    });
    await recordAuditLog({
      organizationId: created.organizationId,
      actorUserId: admin.userId,
      actorEmail: admin.email,
      scope: "PLATFORM",
      action: body.internal ? "SUPPORT_TICKET_INTERNAL_NOTE" : "SUPPORT_TICKET_PUBLIC_REPLY",
      entityType: "SUPPORT_TICKET",
      entityId: id,
      ipAddress: admin.ipAddress,
      metadata: { messageId: created.message.id },
    });
    return ok({ message: created.message }, 201);
  } catch (err) {
    return handleApiError(err);
  }
}

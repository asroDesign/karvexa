import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { supportTicketEvents, supportTicketMessages, supportTickets } from "@/db/schema";
import { recordAuditLog } from "@/lib/audit";
import { ApiError, handleApiError, ok } from "@/lib/errors";
import { requireOrgContext, withTenantTransaction } from "@/lib/tenant";

type RouteContext = { params: Promise<{ id: string }> };
const replySchema = z.object({ body: z.string().trim().min(1).max(10000) });

export async function POST(req: NextRequest, { params }: RouteContext) {
  try {
    const ctx = await requireOrgContext(req);
    const { id } = await params;
    const body = replySchema.parse(await req.json());
    const created = await withTenantTransaction(ctx.organizationId, async (tx) => {
      const [ticket] = await tx.select().from(supportTickets)
        .where(and(eq(supportTickets.id, id), eq(supportTickets.organizationId, ctx.organizationId), eq(supportTickets.userId, ctx.userId)))
        .for("update");
      if (!ticket) throw new ApiError(404, "TICKET_NOT_FOUND", "تیکت پیدا نشد.");
      if (ticket.status === "CLOSED") throw new ApiError(409, "TICKET_CLOSED", "تیکت بسته شده است؛ برای پیگیری جدید تیکت تازه بسازید.");
      const now = new Date();
      const [message] = await tx.insert(supportTicketMessages).values({
        organizationId: ctx.organizationId,
        ticketId: id,
        senderUserId: ctx.userId,
        senderType: "CUSTOMER",
        senderName: ctx.fullName,
        body: body.body,
        isInternal: false,
        createdAt: now,
      }).returning();
      const nextStatus = ticket.status === "WAITING_CUSTOMER" || ticket.status === "RESOLVED" ? "OPEN" : ticket.status;
      await tx.update(supportTickets).set({ status: nextStatus, lastActivityAt: now, updatedAt: now, closedAt: null }).where(eq(supportTickets.id, id));
      await tx.insert(supportTicketEvents).values({
        organizationId: ctx.organizationId,
        ticketId: id,
        actorUserId: ctx.userId,
        actorName: ctx.fullName,
        eventType: "CUSTOMER_REPLY",
        details: { previousStatus: ticket.status, status: nextStatus },
        createdAt: now,
      });
      return message;
    });
    await recordAuditLog({
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      actorEmail: ctx.email,
      scope: "ORGANIZATION",
      action: "SUPPORT_TICKET_REPLIED",
      entityType: "SUPPORT_TICKET",
      entityId: id,
      ipAddress: ctx.ipAddress,
      metadata: { messageId: created.id },
    });
    return ok({ message: created }, 201);
  } catch (err) {
    return handleApiError(err);
  }
}

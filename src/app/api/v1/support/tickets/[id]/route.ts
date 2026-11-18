import { and, asc, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { supportTicketEvents, supportTicketMessages, supportTickets } from "@/db/schema";
import { ApiError, handleApiError, ok } from "@/lib/errors";
import { requireOrgContext, withTenantTransaction } from "@/lib/tenant";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: RouteContext) {
  try {
    const ctx = await requireOrgContext(req);
    const { id } = await params;
    const result = await withTenantTransaction(ctx.organizationId, async (tx) => {
      const [ticket] = await tx.select().from(supportTickets)
        .where(and(eq(supportTickets.id, id), eq(supportTickets.organizationId, ctx.organizationId), eq(supportTickets.userId, ctx.userId)))
        .limit(1);
      if (!ticket) throw new ApiError(404, "TICKET_NOT_FOUND", "تیکت پیدا نشد.");
      const [messages, events] = await Promise.all([
        tx.select().from(supportTicketMessages)
          .where(and(eq(supportTicketMessages.ticketId, id), eq(supportTicketMessages.organizationId, ctx.organizationId), eq(supportTicketMessages.isInternal, false)))
          .orderBy(asc(supportTicketMessages.createdAt)),
        tx.select({ id: supportTicketEvents.id, actorName: supportTicketEvents.actorName, eventType: supportTicketEvents.eventType, createdAt: supportTicketEvents.createdAt })
          .from(supportTicketEvents)
          .where(and(eq(supportTicketEvents.ticketId, id), eq(supportTicketEvents.organizationId, ctx.organizationId), eq(supportTicketEvents.eventType, "STATUS_CHANGED")))
          .orderBy(asc(supportTicketEvents.createdAt)),
      ]);
      return { ticket, messages, events };
    });
    return ok(result);
  } catch (err) {
    return handleApiError(err);
  }
}

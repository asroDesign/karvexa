import { and, asc, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { organizations, supportTicketDepartments, supportTicketEvents, supportTicketMessages, supportTickets, users } from "@/db/schema";
import { recordAuditLog } from "@/lib/audit";
import { ApiError, handleApiError, ok } from "@/lib/errors";
import { requirePlatformAdmin, withPlatformTransaction } from "@/lib/tenant";

type RouteContext = { params: Promise<{ id: string }> };
const updateSchema = z.object({
  status: z.enum(["OPEN", "IN_PROGRESS", "WAITING_CUSTOMER", "WAITING_AGENT", "RESOLVED", "CLOSED"]).optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
  departmentId: z.string().uuid().nullable().optional(),
  assignedToUserId: z.string().uuid().nullable().optional(),
  resolutionNote: z.string().max(5000).nullable().optional(),
}).refine((value) => Object.keys(value).length > 0, "دست‌کم یک فیلد برای تغییر لازم است.");

export async function GET(req: NextRequest, { params }: RouteContext) {
  try {
    await requirePlatformAdmin(req, "platform.tickets.manage");
    const { id } = await params;
    const result = await withPlatformTransaction(async (tx) => {
      const [row] = await tx.select({
        ticket: supportTickets,
        orgName: organizations.name,
        userFullName: users.fullName,
        userEmail: users.email,
        departmentName: supportTicketDepartments.name,
      })
        .from(supportTickets)
        .leftJoin(organizations, eq(supportTickets.organizationId, organizations.id))
        .leftJoin(users, eq(supportTickets.userId, users.id))
        .leftJoin(supportTicketDepartments, eq(supportTickets.departmentId, supportTicketDepartments.id))
        .where(eq(supportTickets.id, id))
        .limit(1);
      if (!row) throw new ApiError(404, "TICKET_NOT_FOUND", "تیکت پیدا نشد.");
      const [messages, events, assignedUser] = await Promise.all([
        tx.select().from(supportTicketMessages).where(eq(supportTicketMessages.ticketId, id)).orderBy(asc(supportTicketMessages.createdAt)),
        tx.select().from(supportTicketEvents).where(eq(supportTicketEvents.ticketId, id)).orderBy(asc(supportTicketEvents.createdAt)),
        row.ticket.assignedToUserId
          ? tx.select({ fullName: users.fullName }).from(users).where(eq(users.id, row.ticket.assignedToUserId)).limit(1).then((items) => items[0] ?? null)
          : Promise.resolve(null),
      ]);
      return { ...row, assignedToName: assignedUser?.fullName ?? null, messages, events };
    });
    return ok(result);
  } catch (err) {
    return handleApiError(err);
  }
}

export async function PATCH(req: NextRequest, { params }: RouteContext) {
  try {
    const admin = await requirePlatformAdmin(req, "platform.tickets.manage");
    const { id } = await params;
    const body = updateSchema.parse(await req.json());
    const now = new Date();
    const result = await withPlatformTransaction(async (tx) => {
      const [ticket] = await tx.select().from(supportTickets).where(eq(supportTickets.id, id)).for("update");
      if (!ticket) throw new ApiError(404, "TICKET_NOT_FOUND", "تیکت پیدا نشد.");
      if (body.departmentId) {
        const [department] = await tx.select({ id: supportTicketDepartments.id }).from(supportTicketDepartments)
          .where(and(eq(supportTicketDepartments.id, body.departmentId), eq(supportTicketDepartments.isActive, true))).limit(1);
        if (!department) throw new ApiError(422, "INVALID_TICKET_DEPARTMENT", "بخش انتخاب‌شده فعال نیست.");
      }
      if (body.assignedToUserId) {
        const [agent] = await tx.select({ id: users.id }).from(users)
          .where(and(eq(users.id, body.assignedToUserId), eq(users.isPlatformAdmin, true), eq(users.status, "ACTIVE"))).limit(1);
        if (!agent) throw new ApiError(422, "INVALID_TICKET_AGENT", "کارشناس انتخاب‌شده فعال نیست.");
      }
      const patch: Partial<typeof supportTickets.$inferInsert> = { updatedAt: now, lastActivityAt: now };
      const events: Array<{ eventType: string; details: Record<string, unknown> }> = [];
      if (body.status !== undefined && body.status !== ticket.status) {
        patch.status = body.status;
        patch.closedAt = body.status === "CLOSED" ? now : null;
        events.push({ eventType: "STATUS_CHANGED", details: { from: ticket.status, to: body.status } });
      }
      if (body.priority !== undefined && body.priority !== ticket.priority) {
        patch.priority = body.priority;
        events.push({ eventType: "PRIORITY_CHANGED", details: { from: ticket.priority, to: body.priority } });
      }
      if (body.departmentId !== undefined && body.departmentId !== ticket.departmentId) {
        patch.departmentId = body.departmentId;
        events.push({ eventType: "DEPARTMENT_CHANGED", details: { from: ticket.departmentId, to: body.departmentId } });
      }
      if (body.assignedToUserId !== undefined && body.assignedToUserId !== ticket.assignedToUserId) {
        patch.assignedToUserId = body.assignedToUserId;
        events.push({ eventType: "ASSIGNEE_CHANGED", details: { from: ticket.assignedToUserId, to: body.assignedToUserId } });
      }
      if (body.resolutionNote !== undefined) patch.resolutionNote = body.resolutionNote;
      const [updated] = await tx.update(supportTickets).set(patch).where(eq(supportTickets.id, id)).returning();
      if (events.length) await tx.insert(supportTicketEvents).values(events.map((event) => ({
        organizationId: ticket.organizationId,
        ticketId: id,
        actorUserId: admin.userId,
        actorName: admin.fullName,
        eventType: event.eventType,
        details: event.details,
        createdAt: now,
      })));
      return { ticket: updated, events };
    });
    await recordAuditLog({
      organizationId: result.ticket.organizationId,
      actorUserId: admin.userId,
      actorEmail: admin.email,
      scope: "PLATFORM",
      action: "SUPPORT_TICKET_UPDATED",
      entityType: "SUPPORT_TICKET",
      entityId: id,
      ipAddress: admin.ipAddress,
      metadata: { fields: Object.keys(body), changes: result.events },
    });
    return ok({ ticket: result.ticket });
  } catch (err) {
    return handleApiError(err);
  }
}

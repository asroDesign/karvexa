import { randomBytes } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { supportTicketDepartments, supportTicketEvents, supportTicketMessages, supportTickets } from "@/db/schema";
import { recordAuditLog } from "@/lib/audit";
import { ApiError, handleApiError, ok } from "@/lib/errors";
import { requireOrgContext, withTenantTransaction } from "@/lib/tenant";

const createSchema = z.object({
  subject: z.string().trim().min(4).max(200),
  message: z.string().trim().min(4).max(10000),
  departmentId: z.string().uuid().nullable().optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH"]).default("MEDIUM"),
});

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireOrgContext(req);
    const { rows, departments } = await withTenantTransaction(ctx.organizationId, async (tx) => {
      const [rows, departments] = await Promise.all([
      tx.select({ ticket: supportTickets, departmentName: supportTicketDepartments.name })
        .from(supportTickets)
        .leftJoin(supportTicketDepartments, eq(supportTickets.departmentId, supportTicketDepartments.id))
        .where(and(eq(supportTickets.organizationId, ctx.organizationId), eq(supportTickets.userId, ctx.userId)))
        .orderBy(desc(supportTickets.lastActivityAt)),
      tx.select({ id: supportTicketDepartments.id, code: supportTicketDepartments.code, name: supportTicketDepartments.name })
        .from(supportTicketDepartments)
        .where(eq(supportTicketDepartments.isActive, true))
        .orderBy(supportTicketDepartments.sortOrder, supportTicketDepartments.name),
      ]);
      return { rows, departments };
    });
    return ok({
      tickets: rows.map(({ ticket, departmentName }) => ({ ...ticket, departmentName })),
      departments,
    });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireOrgContext(req);
    const body = createSchema.parse(await req.json());
    let departmentName: string | null = null;
    if (body.departmentId) {
      const [department] = await db.select({ id: supportTicketDepartments.id, name: supportTicketDepartments.name })
        .from(supportTicketDepartments)
        .where(and(eq(supportTicketDepartments.id, body.departmentId), eq(supportTicketDepartments.isActive, true)))
        .limit(1);
      if (!department) throw new ApiError(422, "INVALID_TICKET_DEPARTMENT", "بخش انتخاب‌شده فعال نیست.");
      departmentName = department.name;
    }

    const now = new Date();
    const ticketNumber = `TK-${Date.now().toString().slice(-8)}-${randomBytes(2).toString("hex").toUpperCase()}`;
    const created = await withTenantTransaction(ctx.organizationId, async (tx) => {
      const [ticket] = await tx.insert(supportTickets).values({
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        ticketNumber,
        subject: body.subject,
        description: body.message,
        departmentId: body.departmentId ?? null,
        priority: body.priority,
        status: "OPEN",
        lastActivityAt: now,
        createdAt: now,
        updatedAt: now,
      }).returning();
      await tx.insert(supportTicketMessages).values({
        organizationId: ctx.organizationId,
        ticketId: ticket.id,
        senderUserId: ctx.userId,
        senderType: "CUSTOMER",
        senderName: ctx.fullName,
        body: body.message,
        isInternal: false,
        createdAt: now,
      });
      await tx.insert(supportTicketEvents).values({
        organizationId: ctx.organizationId,
        ticketId: ticket.id,
        actorUserId: ctx.userId,
        actorName: ctx.fullName,
        eventType: "CREATED",
        details: { departmentName, priority: body.priority },
        createdAt: now,
      });
      return ticket;
    });

    await recordAuditLog({
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      actorEmail: ctx.email,
      scope: "ORGANIZATION",
      action: "SUPPORT_TICKET_CREATED",
      entityType: "SUPPORT_TICKET",
      entityId: created.id,
      ipAddress: ctx.ipAddress,
      metadata: { ticketNumber: created.ticketNumber, departmentId: body.departmentId ?? null },
    });
    return ok({ ticket: created }, 201);
  } catch (err) {
    return handleApiError(err);
  }
}

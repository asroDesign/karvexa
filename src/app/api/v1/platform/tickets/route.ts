import { desc, eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { organizations, supportTicketDepartments, supportTickets, users } from "@/db/schema";
import { handleApiError, ok } from "@/lib/errors";
import { requirePlatformAdmin, withPlatformTransaction } from "@/lib/tenant";

export async function GET(req: NextRequest) {
  try {
    await requirePlatformAdmin(req, "platform.tickets.manage");
    const { rows, departments, agents } = await withPlatformTransaction(async (tx) => {
      const [rows, departments, agents] = await Promise.all([
      tx.select({
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
        .orderBy(desc(supportTickets.lastActivityAt))
        .limit(300),
      tx.select({ id: supportTicketDepartments.id, code: supportTicketDepartments.code, name: supportTicketDepartments.name })
        .from(supportTicketDepartments)
        .where(eq(supportTicketDepartments.isActive, true))
        .orderBy(supportTicketDepartments.sortOrder, supportTicketDepartments.name),
      tx.select({ id: users.id, fullName: users.fullName, email: users.email })
        .from(users)
        .where(sql`${users.isPlatformAdmin} = true AND ${users.status} = 'ACTIVE'`)
        .orderBy(users.fullName),
      ]);
      return { rows, departments, agents };
    });
    return ok({
      tickets: rows.map(({ ticket, orgName, userFullName, userEmail, departmentName }) => ({
        ticket,
        orgName,
        userFullName,
        userEmail,
        departmentName,
      })),
      departments,
      agents,
    });
  } catch (err) {
    return handleApiError(err);
  }
}

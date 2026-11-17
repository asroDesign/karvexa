import { NextRequest } from "next/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { academyArticles } from "@/db/schema";
import { ensureSeeded } from "@/db/seed";
import { recordAuditLog } from "@/lib/audit";
import { ApiError, handleApiError, ok } from "@/lib/errors";
import { sanitizeRichHtml } from "@/lib/sanitize-html";
import { requirePlatformAdmin } from "@/lib/tenant";

const createArticleSchema = z.object({
  slug: z
    .string()
    .min(3)
    .max(180)
    .regex(/^[a-z0-9-]+$/, "اسلاگ فقط می‌تواند شامل حروف کوچک انگلیسی، عدد و خط تیره (-) باشد."),
  title: z.string().min(3).max(240),
  excerpt: z.string().min(10).max(800),
  content_html: z.string().min(10),
  cover_image_url: z.string().optional().nullable(),
  category: z.string().min(2).max(64).default("حسابداری"),
  tags: z.array(z.string()).default([]),
  reading_minutes: z.number().int().min(1).max(120).default(5),
  is_featured: z.boolean().default(false),
  status: z.enum(["DRAFT", "PUBLISHED", "ARCHIVED"]).default("PUBLISHED"),
  author_name: z.string().min(2).max(120).default("تیم آموزش Business OS"),
});

const patchArticleSchema = createArticleSchema.partial().extend({
  id: z.string().uuid(),
});

export async function GET(req: NextRequest) {
  try {
    await ensureSeeded();
    await requirePlatformAdmin(req, "platform.settings.manage");
    const articles = await db
      .select()
      .from(academyArticles)
      .orderBy(desc(academyArticles.updatedAt));
    return ok({ articles });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    await ensureSeeded();
    const admin = await requirePlatformAdmin(req, "platform.settings.manage");
    const body = createArticleSchema.parse(await req.json());
    const cleanHtml = sanitizeRichHtml(body.content_html);

    const [created] = await db
      .insert(academyArticles)
      .values({
        slug: body.slug.trim().toLowerCase(),
        title: body.title.trim(),
        excerpt: body.excerpt.trim(),
        contentHtml: cleanHtml,
        coverImageUrl: body.cover_image_url?.trim() || null,
        category: body.category.trim(),
        tags: body.tags,
        readingMinutes: body.reading_minutes,
        isFeatured: body.is_featured,
        status: body.status,
        authorName: body.author_name.trim(),
        authorUserId: admin.userId,
        publishedAt: body.status === "PUBLISHED" ? new Date() : null,
      })
      .returning();

    await recordAuditLog({
      actorUserId: admin.userId,
      actorEmail: admin.email,
      scope: "PLATFORM",
      action: "ACADEMY_ARTICLE_CREATED",
      entityType: "ACADEMY_ARTICLE",
      entityId: created.id,
      ipAddress: admin.ipAddress,
      metadata: { slug: created.slug, status: created.status },
    });

    return ok({ article: created }, 201);
  } catch (err) {
    return handleApiError(err);
  }
}

export async function PATCH(req: NextRequest) {
  try {
    await ensureSeeded();
    const admin = await requirePlatformAdmin(req, "platform.settings.manage");
    const body = patchArticleSchema.parse(await req.json());

    const [updated] = await db
      .update(academyArticles)
      .set({
        ...(body.slug ? { slug: body.slug.trim().toLowerCase() } : {}),
        ...(body.title ? { title: body.title.trim() } : {}),
        ...(body.excerpt ? { excerpt: body.excerpt.trim() } : {}),
        ...(body.content_html !== undefined ? { contentHtml: sanitizeRichHtml(body.content_html) } : {}),
        ...(body.cover_image_url !== undefined ? { coverImageUrl: body.cover_image_url || null } : {}),
        ...(body.category ? { category: body.category.trim() } : {}),
        ...(body.tags ? { tags: body.tags } : {}),
        ...(body.reading_minutes ? { readingMinutes: body.reading_minutes } : {}),
        ...(body.is_featured !== undefined ? { isFeatured: body.is_featured } : {}),
        ...(body.status
          ? {
              status: body.status,
              ...(body.status === "PUBLISHED" ? { publishedAt: new Date() } : {}),
            }
          : {}),
        ...(body.author_name ? { authorName: body.author_name.trim() } : {}),
        updatedAt: new Date(),
      })
      .where(eq(academyArticles.id, body.id))
      .returning();

    if (!updated) throw new ApiError(404, "ARTICLE_NOT_FOUND", "مقاله آموزشی یافت نشد.");

    await recordAuditLog({
      actorUserId: admin.userId,
      actorEmail: admin.email,
      scope: "PLATFORM",
      action: "ACADEMY_ARTICLE_UPDATED",
      entityType: "ACADEMY_ARTICLE",
      entityId: updated.id,
      ipAddress: admin.ipAddress,
      metadata: { slug: updated.slug, status: updated.status },
    });

    return ok({ article: updated });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    await ensureSeeded();
    const admin = await requirePlatformAdmin(req, "platform.settings.manage");
    const id = req.nextUrl.searchParams.get("id");
    if (!id) throw new ApiError(400, "ID_REQUIRED", "شناسه مقاله الزامی است.");

    const [deleted] = await db
      .delete(academyArticles)
      .where(eq(academyArticles.id, id))
      .returning();
    if (!deleted) throw new ApiError(404, "ARTICLE_NOT_FOUND", "مقاله یافت نشد.");

    await recordAuditLog({
      actorUserId: admin.userId,
      actorEmail: admin.email,
      scope: "PLATFORM",
      action: "ACADEMY_ARTICLE_DELETED",
      entityType: "ACADEMY_ARTICLE",
      entityId: id,
      ipAddress: admin.ipAddress,
    });

    return ok({ deleted_id: id });
  } catch (err) {
    return handleApiError(err);
  }
}

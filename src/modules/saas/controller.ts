import { NextRequest } from "next/server";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  academyArticles,
  contactInquiries,
  features,
  organizations,
  planFeatures,
  plans,
  smsSettings,
  users,
} from "@/db/schema";
import { ensureSeeded } from "@/db/seed";
import { checkRateLimit, getClientIp } from "@/lib/auth";
import {
  ApiError,
  applyListFilterAndPaginate,
  ok,
  okList,
  parseListQuery,
} from "@/lib/errors";
import { sanitizeRichHtml } from "@/lib/sanitize-html";

/**
 * Public SaaS Website & Android Unauthenticated Discovery Endpoints (/api/v1/public/*)
 */
export async function handlePublicSaasRoutes(
  req: NextRequest,
  method: string,
  segments: string[]
) {
  await ensureSeeded();
  const sub = segments[1] ?? "";
  const slug = segments[2];

  // GET /api/v1/public/plans — Live pricing tiers & features from PostgreSQL
  if (method === "GET" && sub === "plans") {
    const [allPlans, allFeatures, allPlanFeats] = await Promise.all([
      db.select().from(plans).where(eq(plans.isActive, true)).orderBy(plans.priceIrr),
      db.select().from(features),
      db.select().from(planFeatures),
    ]);

    return ok(
      allPlans.map((p) => ({
        id: p.id,
        code: p.code,
        name_fa: p.nameFa,
        description: p.description,
        cafebazaar_sku: p.cafebazaarSku,
        price_irr: p.priceIrr,
        billing_days: p.billingDays,
        features: allPlanFeats
          .filter((pf) => pf.planId === p.id)
          .map((pf) => {
            const f = allFeatures.find((x) => x.id === pf.featureId);
            return {
              code: f?.code ?? "",
              name_fa: f?.nameFa ?? "",
              value_type: f?.valueType ?? "BOOLEAN",
              enabled: pf.enabled,
              limit_value: pf.limitValue,
            };
          }),
      }))
    );
  }

  // GET /api/v1/public/academy & GET /api/v1/public/academy/{slug}
  if (method === "GET" && sub === "academy") {
    if (slug) {
      const decodedSlug = decodeURIComponent(slug);
      const [article] = await db
        .select()
        .from(academyArticles)
        .where(
          and(
            eq(academyArticles.slug, decodedSlug),
            eq(academyArticles.status, "PUBLISHED")
          )
        )
        .limit(1);

      if (!article) {
        throw new ApiError(404, "ARTICLE_NOT_FOUND", "مقاله آموزشی مورد نظر یافت نشد.");
      }

      // Increment view counter
      await db
        .update(academyArticles)
        .set({ viewCount: article.viewCount + 1 })
        .where(eq(academyArticles.id, article.id));

      const related = await db
        .select({
          id: academyArticles.id,
          slug: academyArticles.slug,
          title: academyArticles.title,
          excerpt: academyArticles.excerpt,
          coverImageUrl: academyArticles.coverImageUrl,
          category: academyArticles.category,
          readingMinutes: academyArticles.readingMinutes,
          publishedAt: academyArticles.publishedAt,
        })
        .from(academyArticles)
        .where(
          and(
            eq(academyArticles.status, "PUBLISHED"),
            ne(academyArticles.id, article.id)
          )
        )
        .orderBy(desc(academyArticles.publishedAt))
        .limit(3);

      return ok({
        article: {
          ...article,
          contentHtml: sanitizeRichHtml(article.contentHtml),
          viewCount: article.viewCount + 1,
        },
        related,
      });
    }

    const q = parseListQuery(req);
    const categoryFilter = req.nextUrl.searchParams.get("category")?.trim();
    const published = await db
      .select({
        id: academyArticles.id,
        slug: academyArticles.slug,
        title: academyArticles.title,
        excerpt: academyArticles.excerpt,
        coverImageUrl: academyArticles.coverImageUrl,
        category: academyArticles.category,
        tags: academyArticles.tags,
        readingMinutes: academyArticles.readingMinutes,
        viewCount: academyArticles.viewCount,
        isFeatured: academyArticles.isFeatured,
        authorName: academyArticles.authorName,
        publishedAt: academyArticles.publishedAt,
        createdAt: academyArticles.createdAt,
      })
      .from(academyArticles)
      .where(
        categoryFilter
          ? and(
              eq(academyArticles.status, "PUBLISHED"),
              eq(academyArticles.category, categoryFilter)
            )
          : eq(academyArticles.status, "PUBLISHED")
      )
      .orderBy(desc(academyArticles.isFeatured), desc(academyArticles.publishedAt));

    const allCategories = [...new Set(published.map((a) => a.category))];
    const { items, total } = applyListFilterAndPaginate(published, q, [
      "title",
      "excerpt",
      "category",
    ]);

    return okList(items, { page: q.page, perPage: q.perPage, total }, { categories: allCategories });
  }

  // POST /api/v1/public/contact — Public Contact Form inquiry
  if (method === "POST" && sub === "contact") {
    const ip = getClientIp(req);
    checkRateLimit(`contact:${ip}`, 10, 60_000);

    const body = z
      .object({
        full_name: z.string().min(2, "نام و نام خانوادگی حداقل ۲ کاراکتر باشد."),
        email: z.string().email("فرمت ایمیل نامعتبر است.").optional().or(z.literal("")),
        mobile: z.string().min(10, "شماره تماس معتبر وارد کنید.").max(20),
        company_name: z.string().optional(),
        subject: z.string().min(3, "موضوع پیام حداقل ۳ کاراکتر باشد."),
        message: z.string().min(10, "متن پیام حداقل ۱۰ کاراکتر باشد.").max(3000),
      })
      .parse(await req.json());

    const [created] = await db
      .insert(contactInquiries)
      .values({
        fullName: body.full_name.trim(),
        email: body.email?.trim() || null,
        mobile: body.mobile.trim(),
        companyName: body.company_name?.trim() || null,
        subject: body.subject.trim(),
        message: body.message.trim(),
        status: "NEW",
      })
      .returning();

    return ok(
      {
        id: created.id,
        status: created.status,
        message: "پیام شما با موفقیت ثبت شد. تیم پشتیبانی Business OS در اسرع وقت با شما تماس می‌گیرد.",
      },
      201
    );
  }

  // GET /api/v1/public/app-config — Public SaaS stats & Android bootstrap config
  if (method === "GET" && sub === "app-config") {
    const [[orgCount], [userCount], [artCount], smsRows] = await Promise.all([
      db.select({ total: sql<number>`count(*)::int` }).from(organizations),
      db.select({ total: sql<number>`count(*)::int` }).from(users),
      db
        .select({ total: sql<number>`count(*)::int` })
        .from(academyArticles)
        .where(eq(academyArticles.status, "PUBLISHED")),
      db.select().from(smsSettings),
    ]);

    const activeProvider =
      smsRows.find((r) => r.isDefault && r.isActive) ?? smsRows.find((r) => r.isActive) ?? null;

    return ok({
      api_version: "1.2.0",
      min_android_version: "1.0.0",
      otp_enabled: Boolean(activeProvider),
      active_sms_provider: activeProvider?.provider ?? null,
      stats: {
        organizations_count: orgCount?.total ?? 0,
        users_count: userCount?.total ?? 0,
        academy_articles_count: artCount?.total ?? 0,
      },
    });
  }

  throw new ApiError(404, "ROUTE_NOT_FOUND", `مسیر عمومی /api/v1/public/${sub} یافت نشد.`);
}

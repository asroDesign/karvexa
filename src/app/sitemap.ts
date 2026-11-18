import { eq } from "drizzle-orm";
import type { MetadataRoute } from "next";
import { db } from "@/db";
import { academyArticles } from "@/db/schema";

export const dynamic = "force-dynamic";

const configuredSiteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ?? process.env.APP_URL ?? "https://honeykando.ir";
const siteOrigin = new URL(
  configuredSiteUrl.includes("://") ? configuredSiteUrl : `https://${configuredSiteUrl}`,
).origin;

const publicRoutes: MetadataRoute.Sitemap = [
  { url: siteOrigin, changeFrequency: "weekly", priority: 1 },
  { url: `${siteOrigin}/services`, changeFrequency: "monthly", priority: 0.8 },
  { url: `${siteOrigin}/pricing`, changeFrequency: "monthly", priority: 0.8 },
  { url: `${siteOrigin}/about`, changeFrequency: "monthly", priority: 0.6 },
  { url: `${siteOrigin}/contact`, changeFrequency: "monthly", priority: 0.6 },
  { url: `${siteOrigin}/academy`, changeFrequency: "weekly", priority: 0.7 },
];

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  let publishedArticles: Array<{ slug: string; updatedAt: Date; publishedAt: Date | null }> = [];

  try {
    publishedArticles = await db
      .select({
        slug: academyArticles.slug,
        updatedAt: academyArticles.updatedAt,
        publishedAt: academyArticles.publishedAt,
      })
      .from(academyArticles)
      .where(eq(academyArticles.status, "PUBLISHED"));
  } catch {
    // Keep the static marketing URLs available if the article database is offline.
  }

  return [
    ...publicRoutes,
    ...publishedArticles.map((article) => ({
      url: `${siteOrigin}/academy/${encodeURIComponent(article.slug)}`,
      lastModified: article.updatedAt ?? article.publishedAt ?? undefined,
      changeFrequency: "monthly" as const,
      priority: 0.5,
    })),
  ];
}

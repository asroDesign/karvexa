import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq, ne } from "drizzle-orm";
import { ArrowRight, Clock, Eye, Tag, User } from "lucide-react";
import { db } from "@/db";
import { academyArticles } from "@/db/schema";
import { ensureSeeded } from "@/db/seed";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { formatDateFa } from "@/lib/format";
import { sanitizeRichHtml } from "@/lib/sanitize-html";

export const dynamic = "force-dynamic";

export default async function AcademyArticleDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  await ensureSeeded();
  const { slug } = await params;
  const decodedSlug = decodeURIComponent(slug);

  const [article] = await db
    .select()
    .from(academyArticles)
    .where(and(eq(academyArticles.slug, decodedSlug), eq(academyArticles.status, "PUBLISHED")))
    .limit(1);

  if (!article) {
    notFound();
  }

  // Increment view count
  await db
    .update(academyArticles)
    .set({ viewCount: article.viewCount + 1 })
    .where(eq(academyArticles.id, article.id));

  const related = await db
    .select()
    .from(academyArticles)
    .where(and(eq(academyArticles.status, "PUBLISHED"), ne(academyArticles.id, article.id)))
    .orderBy(desc(academyArticles.publishedAt))
    .limit(3);

  const safeHtml = sanitizeRichHtml(article.contentHtml);

  return (
    <div className="min-h-screen flex flex-col">
      <SiteHeader />

      <main className="flex-1 max-w-4xl w-full mx-auto px-4 sm:px-6 py-10 space-y-8">
        <Link
          href="/academy"
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-violet-600 dark:text-violet-400 hover:underline"
        >
          <ArrowRight className="h-3.5 w-3.5" />
          <span>بازگشت به فهرست آموزش‌ها</span>
        </Link>

        <article className="glass-primary overflow-hidden">
          {article.coverImageUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={article.coverImageUrl}
              alt={article.title}
              className="w-full max-h-[380px] object-cover border-b border-slate-200/50 dark:border-slate-700/50"
            />
          )}

          <div className="p-6 sm:p-10 space-y-6">
            <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500">
              <span className="px-3 py-1 rounded-full bg-violet-500/15 text-violet-700 dark:text-violet-300 font-bold">
                {article.category}
              </span>
              <span className="inline-flex items-center gap-1">
                <User className="h-3.5 w-3.5" /> {article.authorName}
              </span>
              <span className="inline-flex items-center gap-1">
                <Clock className="h-3.5 w-3.5" /> {article.readingMinutes} دقیقه مطالعه
              </span>
              <span className="inline-flex items-center gap-1 tabular-nums">
                <Eye className="h-3.5 w-3.5" /> {article.viewCount + 1} بازدید
              </span>
              <span>{formatDateFa(article.publishedAt)}</span>
            </div>

            <h1 className="text-2xl sm:text-3xl font-extrabold leading-snug">
              {article.title}
            </h1>

            <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed glass-secondary p-4">
              {article.excerpt}
            </p>

            <div
              className="bos-prose pt-2"
              dangerouslySetInnerHTML={{ __html: safeHtml }}
            />

            {Array.isArray(article.tags) && article.tags.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 pt-6 border-t border-slate-200/60 dark:border-slate-700/60 text-xs">
                <Tag className="h-3.5 w-3.5 text-slate-400" />
                {article.tags.map((t) => (
                  <span
                    key={t}
                    className="px-2.5 py-1 rounded-lg glass-secondary text-[11px] font-medium"
                  >
                    #{t}
                  </span>
                ))}
              </div>
            )}
          </div>
        </article>

        {/* Related Tutorials */}
        {related.length > 0 && (
          <section className="space-y-4">
            <h2 className="text-lg font-bold">سایر آموزش‌های پیشنهادی</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {related.map((r) => (
                <Link key={r.id} href={`/academy/${r.slug}`} className="glass-primary p-4 space-y-2 hover:-translate-y-0.5">
                  <div className="text-[11px] font-semibold text-violet-600">{r.category}</div>
                  <div className="text-xs font-bold leading-snug">{r.title}</div>
                  <div className="text-[11px] text-slate-500 line-clamp-2">{r.excerpt}</div>
                </Link>
              ))}
            </div>
          </section>
        )}
      </main>

      <SiteFooter />
    </div>
  );
}

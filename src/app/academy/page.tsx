import Link from "next/link";
import { and, desc, eq } from "drizzle-orm";
import { BookOpen, Clock, Eye, Search } from "lucide-react";
import { db } from "@/db";
import { academyArticles } from "@/db/schema";
import { ensureSeeded } from "@/db/seed";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";

export const dynamic = "force-dynamic";

export default async function AcademyIndexPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string; q?: string }>;
}) {
  await ensureSeeded();
  const sp = await searchParams;
  const activeCat = sp.category?.trim() || "";
  const searchQuery = sp.q?.trim().toLowerCase() || "";

  const allPublished = await db
    .select()
    .from(academyArticles)
    .where(eq(academyArticles.status, "PUBLISHED"))
    .orderBy(desc(academyArticles.isFeatured), desc(academyArticles.publishedAt));

  const categories = [...new Set(allPublished.map((a) => a.category))];

  const filtered = allPublished.filter((a) => {
    if (activeCat && a.category !== activeCat) return false;
    if (
      searchQuery &&
      !a.title.toLowerCase().includes(searchQuery) &&
      !a.excerpt.toLowerCase().includes(searchQuery)
    ) {
      return false;
    }
    return true;
  });

  // Also ensure `and` is cleanly utilized when querying by specific category in future
  void and;

  return (
    <div className="min-h-screen flex flex-col">
      <SiteHeader />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-12 space-y-8">
        <div className="glass-primary p-7 sm:p-9 flex flex-wrap items-center justify-between gap-6">
          <div className="space-y-2 max-w-2xl">
            <div className="inline-flex items-center gap-1.5 text-xs font-bold text-violet-600 dark:text-violet-400">
              <BookOpen className="h-4 w-4" />
              <span>آکادمی جامع Business OS (محتوای داینامیک از پنل مدیریت)</span>
            </div>
            <h1 className="text-3xl font-extrabold">مرکز آموزش‌ها و راهنمای کاربردی</h1>
            <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
              آموزش‌های گام‌به‌گام حسابداری دوبل، بستن سال مالی، انبارداری، تنوع کالا، مالی شخصی و کار آفلاین با اپلیکیشن اندروید.
            </p>
          </div>

          <form method="GET" action="/academy" className="w-full sm:w-80 flex gap-2">
            {activeCat && <input type="hidden" name="category" value={activeCat} />}
            <div className="relative flex-1">
              <Search className="h-4 w-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2" />
              <input
                name="q"
                defaultValue={sp.q ?? ""}
                placeholder="جستجو در آموزش‌ها..."
                className="w-full glass-input pr-9 pl-3 py-2.5 text-xs"
              />
            </div>
            <button type="submit" className="rounded-xl bg-violet-600 text-white px-4 py-2 text-xs font-bold cursor-pointer">
              جستجو
            </button>
          </form>
        </div>

        {/* Category Pills */}
        <div className="flex flex-wrap gap-2 text-xs">
          <Link
            href="/academy"
            className={`px-3.5 py-1.5 rounded-xl font-medium ${
              !activeCat ? "bg-violet-600 text-white" : "glass-input hover:border-violet-400"
            }`}
          >
            همه آموزش‌ها ({allPublished.length})
          </Link>
          {categories.map((cat) => (
            <Link
              key={cat}
              href={`/academy?category=${encodeURIComponent(cat)}`}
              className={`px-3.5 py-1.5 rounded-xl font-medium ${
                activeCat === cat ? "bg-violet-600 text-white" : "glass-input hover:border-violet-400"
              }`}
            >
              {cat}
            </Link>
          ))}
        </div>

        {/* Articles Grid */}
        {filtered.length === 0 ? (
          <div className="glass-secondary p-12 text-center text-sm text-slate-500">
            مقاله آموزشی مطابق جستجوی شما یافت نشد.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filtered.map((art) => (
              <Link
                key={art.id}
                href={`/academy/${art.slug}`}
                className="glass-primary overflow-hidden flex flex-col hover:-translate-y-0.5 group"
              >
                {art.coverImageUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={art.coverImageUrl}
                    alt={art.title}
                    className="w-full h-48 object-cover border-b border-slate-200/50 dark:border-slate-700/50"
                  />
                )}
                <div className="p-5 flex-1 flex flex-col justify-between space-y-4">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="px-2.5 py-0.5 rounded-full bg-violet-500/15 text-violet-700 dark:text-violet-300 font-semibold">
                        {art.category}
                      </span>
                      <span className="text-slate-400 inline-flex items-center gap-2 tabular-nums">
                        <span className="inline-flex items-center gap-1">
                          <Clock className="h-3 w-3" /> {art.readingMinutes} دقیقه
                        </span>
                        <span className="inline-flex items-center gap-1">
                          <Eye className="h-3 w-3" /> {art.viewCount}
                        </span>
                      </span>
                    </div>
                    <h2 className="text-base font-bold group-hover:text-violet-600 transition-colors leading-snug">
                      {art.title}
                    </h2>
                    <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed line-clamp-3">
                      {art.excerpt}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 pt-3 border-t border-slate-200/50 dark:border-slate-700/50 text-[11px]">
                    <span className="text-slate-400">{art.authorName}</span>
                    <span className="font-bold text-emerald-600 dark:text-emerald-400">
                      مطالعه کامل ←
                    </span>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>

      <SiteFooter />
    </div>
  );
}

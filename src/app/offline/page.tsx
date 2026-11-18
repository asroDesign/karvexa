export default function OfflinePage() {
  return (
    <main dir="rtl" className="min-h-screen grid place-items-center bg-slate-50 px-5 py-10 text-slate-900">
      <section className="w-full max-w-lg rounded-3xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <div className="mx-auto mb-5 grid h-16 w-16 place-items-center rounded-2xl bg-emerald-700 text-2xl font-black text-white">K</div>
        <h1 className="text-xl font-bold">اتصال اینترنت در دسترس نیست</h1>
        <p className="mt-3 text-sm leading-7 text-slate-600">
          برای دیدن اطلاعات تازه دوباره متصل شوید. اطلاعات حسابداری و کسب‌وکار به‌صورت آفلاین در حافظه مرورگر ذخیره نمی‌شوند.
        </p>
        <a href="/app" className="mt-6 inline-flex rounded-xl bg-emerald-700 px-5 py-2.5 text-sm font-semibold text-white">تلاش دوباره</a>
      </section>
    </main>
  );
}

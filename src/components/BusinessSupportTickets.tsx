"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { LifeBuoy, Plus, RefreshCw, Send } from "lucide-react";
import { apiFetch, formatDateTimeFa } from "@/lib/format";

type Ticket = { id: string; ticketNumber: string; subject: string; description: string; status: string; priority: string; departmentId: string | null; departmentName: string | null; createdAt: string; lastActivityAt: string };
type Department = { id: string; code: string; name: string };
type Message = { id: string; senderType: string; senderName: string; body: string; createdAt: string };
type Event = { id: string; actorName: string; eventType: string; createdAt: string };
type Detail = { ticket: Ticket; messages: Message[]; events: Event[] };
type Toast = (message: string, type?: "success" | "error") => void;
const statusFa: Record<string, string> = { OPEN: "باز", IN_PROGRESS: "در حال بررسی", WAITING_CUSTOMER: "در انتظار پاسخ شما", WAITING_AGENT: "در انتظار کارشناس", RESOLVED: "حل‌شده", CLOSED: "بسته" };
const priorityFa: Record<string, string> = { LOW: "کم", MEDIUM: "عادی", HIGH: "بالا", URGENT: "فوری" };
const inputClass = "w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-xs text-slate-800 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100";

export function BusinessSupportTickets({ organizationId, refreshKey, onToast }: { organizationId: string | null; refreshKey: number; onToast: Toast }) {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [subject, setSubject] = useState("");
  const [newMessage, setNewMessage] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [priority, setPriority] = useState("MEDIUM");
  const [reply, setReply] = useState("");
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const loadTickets = useCallback(async () => {
    if (!organizationId) return;
    setLoading(true);
    try {
      const data = await apiFetch<{ tickets: Ticket[]; departments: Department[] }>("/api/v1/support/tickets", { organizationId });
      setTickets(data.tickets);
      setDepartments(data.departments);
      setDepartmentId((current) => current || data.departments[0]?.id || "");
      setSelectedId((current) => data.tickets.some((ticket) => ticket.id === current) ? current : data.tickets[0]?.id ?? "");
    } catch (error) {
      onToast(error instanceof Error ? error.message : "دریافت تیکت‌ها ناموفق بود", "error");
    } finally {
      setLoading(false);
    }
  }, [organizationId, onToast]);

  const loadDetail = useCallback(async (id: string) => {
    if (!organizationId || !id) { setDetail(null); return; }
    setDetailLoading(true);
    try {
      setDetail(await apiFetch<Detail>(`/api/v1/support/tickets/${encodeURIComponent(id)}`, { organizationId }));
    } catch (error) {
      onToast(error instanceof Error ? error.message : "دریافت گفتگو ناموفق بود", "error");
    } finally {
      setDetailLoading(false);
    }
  }, [organizationId, onToast]);

  useEffect(() => { void loadTickets(); }, [loadTickets, refreshKey]);
  useEffect(() => { void loadDetail(selectedId); }, [selectedId, loadDetail]);

  async function createTicket(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!organizationId) return;
    setBusy(true);
    try {
      const data = await apiFetch<{ ticket: Ticket }>("/api/v1/support/tickets", {
        method: "POST",
        organizationId,
        body: JSON.stringify({ subject: subject.trim(), message: newMessage.trim(), departmentId: departmentId || null, priority }),
      });
      onToast(`تیکت ${data.ticket.ticketNumber} ثبت شد.`);
      setSubject(""); setNewMessage(""); setShowCreate(false); setSelectedId(data.ticket.id);
      await loadTickets();
    } catch (error) {
      onToast(error instanceof Error ? error.message : "ثبت تیکت ناموفق بود", "error");
    } finally {
      setBusy(false);
    }
  }

  async function sendReply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!organizationId || !detail || !reply.trim()) return;
    setBusy(true);
    try {
      await apiFetch(`/api/v1/support/tickets/${encodeURIComponent(detail.ticket.id)}/messages`, {
        method: "POST", organizationId, body: JSON.stringify({ body: reply.trim() }),
      });
      setReply("");
      onToast("پاسخ شما به تیکت اضافه شد.");
      await Promise.all([loadTickets(), loadDetail(detail.ticket.id)]);
    } catch (error) {
      onToast(error instanceof Error ? error.message : "ارسال پاسخ ناموفق بود", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-emerald-100 bg-emerald-50/60 p-4">
        <div className="flex items-center gap-3"><span className="flex size-10 items-center justify-center rounded-xl bg-emerald-100 text-emerald-800"><LifeBuoy className="size-5"/></span><div><h3 className="text-sm font-bold">پشتیبانی کسب‌وکار</h3><p className="mt-1 text-xs text-slate-600">پیگیری درخواست‌ها و گفتگو با تیم Karvexa</p></div></div>
        <div className="flex gap-2"><button type="button" onClick={() => void loadTickets()} className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs"><RefreshCw className={`ml-1 inline size-3.5 ${loading ? "animate-spin" : ""}`}/>بروزرسانی</button><button type="button" onClick={() => setShowCreate((value) => !value)} className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-700 px-3 py-2 text-xs font-semibold text-white"><Plus className="size-4"/>تیکت جدید</button></div>
      </div>

      {showCreate && <form onSubmit={createTicket} className="grid grid-cols-1 gap-3 rounded-2xl border border-emerald-200 bg-white p-4 md:grid-cols-2">
        <label className="text-xs font-semibold md:col-span-2">موضوع<input required minLength={4} maxLength={200} className={`${inputClass} mt-1`} value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="مثلاً مشکل در همگام‌سازی فاکتورها"/></label>
        <label className="text-xs font-semibold">ارجاع اولیه به بخش<select className={`${inputClass} mt-1`} value={departmentId} onChange={(event) => setDepartmentId(event.target.value)}><option value="">انتخاب بخش پشتیبانی</option>{departments.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label className="text-xs font-semibold">اولویت<select className={`${inputClass} mt-1`} value={priority} onChange={(event) => setPriority(event.target.value)}><option value="LOW">کم</option><option value="MEDIUM">عادی</option><option value="HIGH">بالا</option></select></label>
        <label className="text-xs font-semibold md:col-span-2">شرح درخواست<textarea required minLength={4} maxLength={10000} rows={4} className={`${inputClass} mt-1`} value={newMessage} onChange={(event) => setNewMessage(event.target.value)} placeholder="شرح مسئله و مراحل لازم برای بازتولید آن را بنویسید…"/></label>
        <div className="flex justify-end gap-2 md:col-span-2"><button type="button" onClick={() => setShowCreate(false)} className="rounded-xl border px-4 py-2 text-xs">انصراف</button><button disabled={busy} className="rounded-xl bg-emerald-700 px-4 py-2 text-xs font-semibold text-white disabled:opacity-50">{busy ? "در حال ثبت…" : "ثبت تیکت"}</button></div>
      </form>}

      <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-[minmax(250px,0.75fr)_minmax(0,1.7fr)]">
        <aside className="space-y-2 rounded-2xl border border-slate-200 bg-white p-4">
          <h4 className="text-sm font-bold">تیکت‌های من ({tickets.length})</h4>
          <div className="max-h-[65vh] space-y-2 overflow-y-auto">{tickets.map((ticket) => <button key={ticket.id} type="button" onClick={() => setSelectedId(ticket.id)} className={`w-full rounded-xl border p-3 text-right ${selectedId === ticket.id ? "border-emerald-400 bg-emerald-50" : "border-slate-200 hover:bg-slate-50"}`}>
            <div className="flex justify-between gap-2"><span className="font-mono text-[10px] text-emerald-800">{ticket.ticketNumber}</span><span className="text-[10px]">{statusFa[ticket.status] ?? ticket.status}</span></div>
            <strong className="mt-2 block text-xs">{ticket.subject}</strong><span className="mt-1 block text-[10px] text-slate-500">{ticket.departmentName ?? "بدون بخش"} • اولویت {priorityFa[ticket.priority] ?? ticket.priority}</span><time className="mt-1 block text-[10px] text-slate-400">آخرین بروزرسانی {formatDateTimeFa(ticket.lastActivityAt)}</time>
          </button>)}{!loading && tickets.length === 0 && <p className="rounded-xl border border-dashed p-6 text-center text-xs text-slate-500">هنوز تیکتی ثبت نکرده‌اید.</p>}</div>
        </aside>

        <section className="min-w-0 space-y-3">{!detail && <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">یک تیکت را انتخاب کنید یا درخواست جدید بسازید.</div>}
          {detail && <>
            <header className="rounded-2xl border border-slate-200 bg-white p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><span className="font-mono text-xs font-bold text-emerald-800">{detail.ticket.ticketNumber}</span><h4 className="mt-1 text-sm font-bold">{detail.ticket.subject}</h4></div><span className="rounded-full bg-slate-100 px-3 py-1 text-[10px]">{statusFa[detail.ticket.status] ?? detail.ticket.status}</span></div><p className="mt-2 text-[11px] text-slate-500">بخش: {detail.ticket.departmentName ?? "در حال ارجاع"} • اولویت: {priorityFa[detail.ticket.priority] ?? detail.ticket.priority}</p></header>
            <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4">
              <h4 className="text-sm font-bold">گفتگو با پشتیبانی</h4>
              <div className="max-h-[55vh] space-y-3 overflow-y-auto rounded-xl bg-slate-50 p-3">
                {(detail.messages.length ? detail.messages : [{ id: `legacy-${detail.ticket.id}`, senderType: "CUSTOMER", senderName: "شما", body: detail.ticket.description, createdAt: detail.ticket.createdAt }]).map((message) => <article key={message.id} className={`rounded-xl border p-3 ${message.senderType === "ADMIN" ? "border-indigo-100 bg-white" : "border-emerald-100 bg-emerald-50/50"}`}><div className="flex justify-between gap-2"><strong className="text-xs">{message.senderType === "ADMIN" ? message.senderName : "شما"}</strong><time className="text-[10px] text-slate-400">{formatDateTimeFa(message.createdAt)}</time></div><p className="mt-2 whitespace-pre-wrap break-words text-xs leading-6 text-slate-700">{message.body}</p></article>)}
                {detailLoading && <p className="text-center text-[10px] text-slate-400">در حال بروزرسانی…</p>}
              </div>
              {detail.ticket.status !== "CLOSED" ? <form onSubmit={sendReply} className="space-y-2"><textarea required maxLength={10000} rows={3} className={inputClass} value={reply} onChange={(event) => setReply(event.target.value)} placeholder="پاسخ یا اطلاعات تکمیلی خود را بنویسید…"/><div className="flex justify-end"><button disabled={busy || !reply.trim()} className="inline-flex items-center gap-2 rounded-xl bg-emerald-700 px-4 py-2 text-xs font-semibold text-white disabled:opacity-50"><Send className="size-3.5"/>ارسال پاسخ</button></div></form> : <p className="rounded-xl bg-slate-100 p-3 text-xs text-slate-500">این تیکت بسته شده است. برای پیگیری تازه، تیکت جدید ثبت کنید.</p>}
            </div>
          </>}
        </section>
      </div>
    </div>
  );
}

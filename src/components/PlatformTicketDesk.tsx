"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { MessageSquare, RefreshCw, Send, ShieldCheck } from "lucide-react";
import { apiFetch, formatDateTimeFa } from "@/lib/format";

type Ticket = {
  id: string;
  ticketNumber: string;
  subject: string;
  description: string;
  status: string;
  priority: string;
  departmentId: string | null;
  assignedToUserId: string | null;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
};
type Summary = { ticket: Ticket; orgName: string | null; userFullName: string | null; userEmail: string | null; departmentName: string | null };
type Department = { id: string; code: string; name: string };
type Agent = { id: string; fullName: string; email: string };
type Message = { id: string; senderType: string; senderName: string; body: string; isInternal: boolean; createdAt: string };
type Event = { id: string; actorName: string; eventType: string; details: Record<string, unknown>; createdAt: string };
type Detail = Summary & { assignedToName: string | null; messages: Message[]; events: Event[] };
type Toast = (message: string, type?: "success" | "error") => void;

const statuses = [
  ["OPEN", "باز"], ["IN_PROGRESS", "در حال بررسی"], ["WAITING_CUSTOMER", "در انتظار مشتری"],
  ["WAITING_AGENT", "در انتظار کارشناس"], ["RESOLVED", "حل‌شده"], ["CLOSED", "بسته"],
] as const;
const priorities = [["LOW", "کم"], ["MEDIUM", "عادی"], ["HIGH", "بالا"], ["URGENT", "فوری"]] as const;
const statusLabel = (value: string) => statuses.find(([key]) => key === value)?.[1] ?? value;
const priorityLabel = (value: string) => priorities.find(([key]) => key === value)?.[1] ?? value;
const eventLabel: Record<string, string> = {
  CREATED: "تیکت ایجاد شد", STATUS_CHANGED: "وضعیت تغییر کرد", PRIORITY_CHANGED: "اولویت تغییر کرد",
  DEPARTMENT_CHANGED: "به بخش دیگری ارجاع شد", ASSIGNEE_CHANGED: "کارشناس تغییر کرد",
  PUBLIC_REPLY: "پاسخ برای کاربر ارسال شد", INTERNAL_NOTE: "یادداشت داخلی ثبت شد", CUSTOMER_REPLY: "کاربر پاسخ داد",
};
const inputClass = "w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-800 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100";

export function PlatformTicketDesk({ onToast }: { onToast: Toast }) {
  const [rows, setRows] = useState<Summary[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [status, setStatus] = useState("OPEN");
  const [priority, setPriority] = useState("MEDIUM");
  const [departmentId, setDepartmentId] = useState("");
  const [assignedToUserId, setAssignedToUserId] = useState("");
  const [message, setMessage] = useState("");
  const [internal, setInternal] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<{ tickets: Summary[]; departments: Department[]; agents: Agent[] }>("/api/v1/platform/tickets");
      setRows(data.tickets);
      setDepartments(data.departments);
      setAgents(data.agents);
      setSelectedId((current) => data.tickets.some(({ ticket }) => ticket.id === current) ? current : data.tickets[0]?.ticket.id ?? "");
    } catch (error) {
      onToast(error instanceof Error ? error.message : "بارگذاری تیکت‌ها ناموفق بود", "error");
    } finally {
      setLoading(false);
    }
  }, [onToast]);

  const loadDetail = useCallback(async (id: string) => {
    if (!id) { setDetail(null); return; }
    setDetailLoading(true);
    try {
      const data = await apiFetch<Detail>(`/api/v1/platform/tickets/${encodeURIComponent(id)}`);
      setDetail(data);
      setStatus(data.ticket.status);
      setPriority(data.ticket.priority);
      setDepartmentId(data.ticket.departmentId ?? "");
      setAssignedToUserId(data.ticket.assignedToUserId ?? "");
    } catch (error) {
      onToast(error instanceof Error ? error.message : "دریافت گفتگو ناموفق بود", "error");
    } finally {
      setDetailLoading(false);
    }
  }, [onToast]);

  useEffect(() => { void loadList(); }, [loadList]);
  useEffect(() => { void loadDetail(selectedId); }, [selectedId, loadDetail]);

  const shownRows = useMemo(() => rows.filter(({ ticket, orgName, userFullName }) =>
    (statusFilter === "ALL" || ticket.status === statusFilter) &&
    `${ticket.ticketNumber} ${ticket.subject} ${orgName ?? ""} ${userFullName ?? ""}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())
  ), [rows, search, statusFilter]);

  async function saveRouting(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!detail) return;
    setBusy(true);
    try {
      await apiFetch(`/api/v1/platform/tickets/${encodeURIComponent(detail.ticket.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ status, priority, departmentId: departmentId || null, assignedToUserId: assignedToUserId || null }),
      });
      onToast("وضعیت، اولویت و ارجاع تیکت ذخیره شد.");
      await Promise.all([loadList(), loadDetail(detail.ticket.id)]);
    } catch (error) {
      onToast(error instanceof Error ? error.message : "ذخیرهٔ ارجاع تیکت ناموفق بود", "error");
    } finally {
      setBusy(false);
    }
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!detail || !message.trim()) return;
    setBusy(true);
    try {
      await apiFetch(`/api/v1/platform/tickets/${encodeURIComponent(detail.ticket.id)}/messages`, {
        method: "POST",
        body: JSON.stringify({ body: message.trim(), internal }),
      });
      setMessage("");
      onToast(internal ? "یادداشت داخلی ثبت شد و برای کاربر نمایش داده نمی‌شود." : "پاسخ برای کاربر ارسال شد.");
      await Promise.all([loadList(), loadDetail(detail.ticket.id)]);
    } catch (error) {
      onToast(error instanceof Error ? error.message : "ارسال پیام ناموفق بود", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-[minmax(280px,0.8fr)_minmax(0,1.7fr)]">
      <aside className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4">
        <div className="flex items-center justify-between gap-2">
          <div><h3 className="text-sm font-bold">صف تیکت‌ها</h3><p className="mt-1 text-[11px] text-slate-500">{rows.length} درخواست ثبت‌شده</p></div>
          <button type="button" onClick={() => void loadList()} className="rounded-lg border px-2.5 py-2 text-slate-600" aria-label="بروزرسانی تیکت‌ها"><RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`}/></button>
        </div>
        <input className={inputClass} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="جست‌وجوی شماره، عنوان یا سازمان"/>
        <select className={inputClass} value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
          <option value="ALL">همهٔ وضعیت‌ها</option>{statuses.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <div className="max-h-[70vh] space-y-2 overflow-y-auto">
          {shownRows.map(({ ticket, orgName, userFullName, departmentName }) => (
            <button key={ticket.id} type="button" onClick={() => setSelectedId(ticket.id)} className={`w-full rounded-xl border p-3 text-right transition ${selectedId === ticket.id ? "border-indigo-400 bg-indigo-50 ring-1 ring-indigo-200" : "border-slate-200 hover:bg-slate-50"}`}>
              <div className="flex items-start justify-between gap-2"><span className="font-mono text-[10px] font-bold text-indigo-700">{ticket.ticketNumber}</span><span className="rounded-full bg-white px-2 py-0.5 text-[10px]">{statusLabel(ticket.status)}</span></div>
              <strong className="mt-2 block text-xs text-slate-900">{ticket.subject}</strong>
              <span className="mt-1 block truncate text-[10px] text-slate-500">{orgName ?? "بدون سازمان"} • {userFullName ?? "کاربر حذف‌شده"}</span>
              <span className="mt-2 block text-[10px] text-slate-400">{departmentName ?? "بدون ارجاع"} • اولویت {priorityLabel(ticket.priority)}</span>
            </button>
          ))}
          {!loading && shownRows.length === 0 && <p className="rounded-xl border border-dashed p-6 text-center text-xs text-slate-500">تیکتی با این فیلتر پیدا نشد.</p>}
        </div>
      </aside>

      <section className="min-w-0 space-y-4">
        {!detail && <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-12 text-center text-sm text-slate-500">برای مشاهدهٔ گفتگو، یک تیکت را انتخاب کنید.</div>}
        {detail && <>
          <header className="flex flex-wrap items-start justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4">
            <div><span className="font-mono text-xs font-bold text-indigo-700">{detail.ticket.ticketNumber}</span><h3 className="mt-1 text-base font-bold">{detail.ticket.subject}</h3><p className="mt-1 text-xs text-slate-500">{detail.orgName ?? "بدون سازمان"} • {detail.userFullName ?? "کاربر حذف‌شده"} • {detail.userEmail ?? "—"}</p></div>
            <span className="rounded-full bg-slate-100 px-3 py-1 text-[11px]">ایجاد {formatDateTimeFa(detail.ticket.createdAt)}</span>
          </header>

          <form onSubmit={saveRouting} className="grid grid-cols-1 gap-3 rounded-2xl border border-indigo-100 bg-indigo-50/50 p-4 md:grid-cols-2 xl:grid-cols-4">
            <label className="text-[11px] font-semibold">وضعیت<select className={`${inputClass} mt-1`} value={status} onChange={(event) => setStatus(event.target.value)}>{statuses.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label className="text-[11px] font-semibold">اولویت<select className={`${inputClass} mt-1`} value={priority} onChange={(event) => setPriority(event.target.value)}>{priorities.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label className="text-[11px] font-semibold">ارجاع به بخش<select className={`${inputClass} mt-1`} value={departmentId} onChange={(event) => setDepartmentId(event.target.value)}><option value="">بدون بخش</option>{departments.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <label className="text-[11px] font-semibold">کارشناس مسئول<select className={`${inputClass} mt-1`} value={assignedToUserId} onChange={(event) => setAssignedToUserId(event.target.value)}><option value="">بدون کارشناس</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.fullName} • {agent.email}</option>)}</select></label>
            <div className="md:col-span-2 xl:col-span-4"><button disabled={busy || detailLoading} className="rounded-xl bg-indigo-700 px-4 py-2 text-xs font-semibold text-white disabled:opacity-50">ذخیره و ارجاع</button></div>
          </form>

          <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4">
            <div className="flex items-center gap-2"><MessageSquare className="size-4 text-indigo-600"/><h4 className="text-sm font-bold">گفتگو و یادداشت‌های داخلی</h4></div>
            <div className="max-h-[55vh] space-y-3 overflow-y-auto rounded-xl bg-slate-50 p-3">
              {(detail.messages.length ? detail.messages : [{ id: `legacy-${detail.ticket.id}`, senderType: "CUSTOMER", senderName: detail.userFullName ?? "کاربر", body: detail.ticket.description, isInternal: false, createdAt: detail.ticket.createdAt }]).map((item) => (
                <article key={item.id} className={`rounded-xl border p-3 ${item.isInternal ? "border-amber-200 bg-amber-50" : item.senderType === "ADMIN" ? "border-indigo-100 bg-white" : "border-slate-200 bg-white"}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-2"><strong className="text-xs">{item.senderName}</strong>{item.senderType === "ADMIN" && <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[9px] text-indigo-700">پشتیبانی</span>}{item.isInternal && <span className="rounded-full bg-amber-200 px-2 py-0.5 text-[9px] text-amber-900">یادداشت داخلی</span>}</div><time className="text-[10px] text-slate-400">{formatDateTimeFa(item.createdAt)}</time></div>
                  <p className="mt-2 whitespace-pre-wrap break-words text-xs leading-6 text-slate-700">{item.body}</p>
                </article>
              ))}
              {detailLoading && <p className="text-center text-[11px] text-slate-400">در حال بروزرسانی گفتگو…</p>}
            </div>
            <form onSubmit={sendMessage} className="space-y-2">
              <textarea className={inputClass} rows={4} maxLength={10000} required value={message} onChange={(event) => setMessage(event.target.value)} placeholder={internal ? "یادداشت برای تیم پشتیبانی؛ مشتری این متن را نمی‌بیند" : "پاسخ قابل مشاهده برای کاربر"}/>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-amber-800"><input type="checkbox" checked={internal} onChange={(event) => setInternal(event.target.checked)}/><ShieldCheck className="size-4"/>یادداشت داخلی (برای مشتری نمایش داده نمی‌شود)</label>
                <button disabled={busy || !message.trim()} className="inline-flex items-center gap-2 rounded-xl bg-indigo-700 px-4 py-2 text-xs font-semibold text-white disabled:opacity-50"><Send className="size-3.5"/>{internal ? "ثبت یادداشت" : "ارسال پاسخ"}</button>
              </div>
            </form>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-4">
            <h4 className="text-sm font-bold">تاریخچه اقدامات</h4>
            <ol className="mt-3 space-y-2">{detail.events.map((event) => <li key={event.id} className="flex items-start gap-2 border-r-2 border-indigo-100 pr-3 text-xs"><span className="mt-1 size-1.5 rounded-full bg-indigo-500"/><div><strong>{eventLabel[event.eventType] ?? event.eventType}</strong><span className="mr-2 text-slate-500">توسط {event.actorName}</span><time className="mr-2 text-[10px] text-slate-400">{formatDateTimeFa(event.createdAt)}</time></div></li>)}</ol>
            {detail.events.length === 0 && <p className="mt-2 text-xs text-slate-400">تاریخچه‌ای ثبت نشده است.</p>}
          </div>
        </>}
      </section>
    </div>
  );
}

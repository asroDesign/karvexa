"use client";

import React, { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2,
  Copy,
  KeyRound,
  LogOut,
  Monitor,
  Moon,
  Palette,
  RefreshCw,
  ShieldAlert,
  Sun,
  Trash2,
  UserCheck,
  UserPlus,
  UserX,
} from "lucide-react";
import { apiFetch, formatDateTimeFa } from "@/lib/format";
import { ThemePreference, useTheme } from "./ThemeProvider";

interface UserAccessSettingsProps {
  orgId: string | null;
  onToast: (msg: string, type?: "success" | "error") => void;
}

export function UserAccessSettings({ orgId, onToast }: UserAccessSettingsProps) {
  const { theme, setTheme } = useTheme();
  const [loading, setLoading] = useState(false);
  const [members, setMembers] = useState<Array<Record<string, unknown>>>([]);
  const [rolesList, setRolesList] = useState<Array<Record<string, unknown>>>([]);
  const [invitations, setInvitations] = useState<Array<Record<string, unknown>>>([]);
  const [auditList, setAuditList] = useState<Array<Record<string, unknown>>>([]);

  const [invForm, setInvForm] = useState({
    invitee_name: "",
    mobile: "",
    email: "",
    role_code: "SALESPERSON",
    branch_access: "دفتر مرکزی",
    warehouse_access: "ALL",
    expires_in_hours: 72,
    message: "دعوت به همکاری در پنل Business OS سازمان",
  });

  const [acceptForm, setAcceptForm] = useState({
    token: "",
    full_name: "",
    password: "",
  });

  const loadData = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    try {
      const [mRes, iRes, aRes] = await Promise.all([
        apiFetch<{ members: Array<Record<string, unknown>>; roles: Array<Record<string, unknown>> }>(
          "/api/v1/access/members",
          { organizationId: orgId }
        ),
        apiFetch<Array<Record<string, unknown>>>("/api/v1/access/invitations", {
          organizationId: orgId,
        }),
        apiFetch<Array<Record<string, unknown>>>("/api/v1/access/audit-logs", {
          organizationId: orgId,
        }),
      ]);
      setMembers(mRes.members);
      setRolesList(mRes.roles);
      setInvitations(iRes);
      setAuditList(aRes);
    } catch (e) {
      onToast(e instanceof Error ? e.message : "خطا در بارگذاری تنظیمات دسترسی", "error");
    } finally {
      setLoading(false);
    }
  }, [orgId, onToast]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  async function handleCreateInvitation(e: React.FormEvent) {
    e.preventDefault();
    try {
      const created = await apiFetch<{ token: string }>("/api/v1/access/invitations", {
        method: "POST",
        organizationId: orgId,
        body: JSON.stringify({
          invitee_name: invForm.invitee_name || undefined,
          mobile: invForm.mobile || undefined,
          email: invForm.email || undefined,
          role_code: invForm.role_code,
          branch_access: invForm.branch_access.split(",").map((s) => s.trim()).filter(Boolean),
          warehouse_access: invForm.warehouse_access.split(",").map((s) => s.trim()).filter(Boolean),
          expires_in_hours: Number(invForm.expires_in_hours) || 72,
          message: invForm.message,
        }),
      });
      setAcceptForm((p) => ({ ...p, token: created.token }));
      onToast("دعوت‌نامه یک‌بارمصرف با انقضای زمانی ایجاد شد. تا زمان پذیرش، هیچ دسترسی فعال نمی‌شود.");
      setInvForm({ ...invForm, invitee_name: "", mobile: "", email: "" });
      loadData();
    } catch (err) {
      onToast(err instanceof Error ? err.message : "خطا در ارسال دعوت‌نامه", "error");
    }
  }

  async function handleAcceptInvitation(e: React.FormEvent) {
    e.preventDefault();
    try {
      await apiFetch("/api/v1/access/invitations/accept", {
        method: "POST",
        body: JSON.stringify({
          token: acceptForm.token.trim(),
          full_name: acceptForm.full_name || undefined,
          password: acceptForm.password || undefined,
        }),
      });
      onToast("دعوت‌نامه پذیرفته شد و عضویت سازمانی با نقش و محدودیت‌های تعیین‌شده فعال گردید.");
      setAcceptForm({ token: "", full_name: "", password: "" });
      loadData();
    } catch (err) {
      onToast(err instanceof Error ? err.message : "خطا در پذیرش دعوت‌نامه", "error");
    }
  }

  async function handleRevokeInvitation(id: string) {
    try {
      await apiFetch(`/api/v1/access/invitations/${id}/revoke`, {
        method: "POST",
        organizationId: orgId,
      });
      onToast("دعوت‌نامه باطل (REVOKED) شد.");
      loadData();
    } catch (err) {
      onToast(err instanceof Error ? err.message : "خطا در ابطال دعوت‌نامه", "error");
    }
  }

  async function handleUpdateMember(
    memberId: string,
    payload: { status?: "ACTIVE" | "SUSPENDED"; role_code?: string }
  ) {
    try {
      await apiFetch(`/api/v1/access/members/${memberId}`, {
        method: "PATCH",
        organizationId: orgId,
        body: JSON.stringify(payload),
      });
      onToast(
        payload.status === "SUSPENDED"
          ? "دسترسی عضو معلق و تمام نشست‌های فعال او فوراً ابطال شدند."
          : "دسترسی و نقش عضو به‌روزرسانی و در لاگ امنیتی ثبت شد."
      );
      loadData();
    } catch (err) {
      onToast(err instanceof Error ? err.message : "خطا در تغییر دسترسی عضو", "error");
    }
  }

  async function handleRevokeSessions(memberId: string) {
    try {
      await apiFetch(`/api/v1/access/members/${memberId}/revoke-sessions`, {
        method: "POST",
        organizationId: orgId,
      });
      onToast("تمام نشست‌های فعال این عضو با موفقیت ابطال شدند.");
      loadData();
    } catch (err) {
      onToast(err instanceof Error ? err.message : "خطا در ابطال نشست‌ها", "error");
    }
  }

  async function handleRemoveMember(memberId: string) {
    try {
      await apiFetch(`/api/v1/access/members/${memberId}`, {
        method: "DELETE",
        organizationId: orgId,
      });
      onToast("عضویت کاربر از سازمان حذف شد (حساب کاربری سراسری حفظ گردید).");
      loadData();
    } catch (err) {
      onToast(err instanceof Error ? err.message : "خطا در حذف عضویت", "error");
    }
  }

  return (
    <div className="space-y-6">
      {/* 1. Design & Theme Settings (§2.6 & §3 & §14.2) */}
      <div className="glass-primary p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold flex items-center gap-2">
              <Palette className="h-4 w-4 text-violet-500" />
              <span>تنظیمات ظاهر Glassmorphism و تایپوگرافی آسروتراول</span>
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              پشتیبانی از تم روشن شیشه‌ای، تم تاریک شیشه‌ای و هماهنگ با سیستم • فونت کشف‌شده از AsroTravel: <strong>Yekan Bakh (bakh) / IRANSansWeb</strong> با جایگزین قانونی <strong>Vazirmatn (OFL 1.1)</strong>
            </p>
          </div>
          <div className="inline-flex rounded-xl p-1 glass-secondary text-xs">
            {(
              [
                { id: "light", label: "روشن (Light Glass)", icon: Sun },
                { id: "dark", label: "تاریک (Dark Glass)", icon: Moon },
                { id: "system", label: "خودکار سیستم", icon: Monitor },
              ] as Array<{ id: ThemePreference; label: string; icon: React.ComponentType<{ className?: string }> }>
            ).map((opt) => {
              const Icon = opt.icon;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setTheme(opt.id)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium cursor-pointer transition-colors ${
                    theme === opt.id
                      ? "bg-violet-600 text-white shadow-xs"
                      : "text-slate-600 dark:text-slate-300 hover:bg-white/40 dark:hover:bg-slate-800/60"
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  <span>{opt.label}</span>
                </button>
              );
            })}
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
          <div className="glass-secondary p-3.5">
            <div className="text-[11px] text-slate-500">پیش‌نمایش تیتر و ارقام مالی (Tabular)</div>
            <div className="text-lg font-bold mt-1 tabular-nums">۱۲۵٬۴۵۰٬۰۰۰ ریال</div>
          </div>
          <div className="glass-secondary p-3.5">
            <div className="text-[11px] text-slate-500">مرجع تایپوگرافی کشف‌شده</div>
            <div className="font-mono text-[11px] mt-1">bakh (Yekan Bakh) → IRANSansWeb → Vazirmatn</div>
          </div>
          <div className="glass-secondary p-3.5">
            <div className="text-[11px] text-slate-500">وضعیت حریم خصوصی مالی شخصی</div>
            <div className="text-emerald-600 dark:text-emerald-400 font-semibold mt-1">
              جداسازی کامل پرسنل از دفتر مالی شخصی مالک ✓
            </div>
          </div>
        </div>
      </div>

      {/* 2. Invite User & Accept Single-Use Token Forms (§6.3) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <form onSubmit={handleCreateInvitation} className="glass-primary p-5 space-y-3 text-xs">
          <h3 className="text-sm font-bold flex items-center gap-2">
            <UserPlus className="h-4 w-4 text-emerald-500" />
            <span>دعوت کاربر جدید و اعطای دسترسی سازمانی</span>
          </h3>
          <div className="grid grid-cols-2 gap-2.5">
            <input
              placeholder="نام کاربر (اختیاری)"
              value={invForm.invitee_name}
              onChange={(e) => setInvForm({ ...invForm, invitee_name: e.target.value })}
              className="glass-input px-3 py-2"
            />
            <input
              dir="ltr"
              placeholder="شماره موبایل (0912...)"
              value={invForm.mobile}
              onChange={(e) => setInvForm({ ...invForm, mobile: e.target.value })}
              className="glass-input px-3 py-2 font-mono text-left"
            />
            <input
              dir="ltr"
              type="email"
              placeholder="ایمیل (user@company.ir)"
              value={invForm.email}
              onChange={(e) => setInvForm({ ...invForm, email: e.target.value })}
              className="glass-input px-3 py-2 font-mono text-left"
            />
            <select
              value={invForm.role_code}
              onChange={(e) => setInvForm({ ...invForm, role_code: e.target.value })}
              className="glass-input px-3 py-2"
            >
              {rolesList.length > 0 ? (
                rolesList.map((r) => (
                  <option key={String(r.id)} value={String(r.code)}>
                    {String(r.name)} ({String(r.code)})
                  </option>
                ))
              ) : (
                <>
                  <option value="SALESPERSON">کارشناس فروش (SALESPERSON)</option>
                  <option value="ACCOUNTANT">حسابدار ارشد (ACCOUNTANT)</option>
                  <option value="WAREHOUSE_MGR">مدیر انبار (WAREHOUSE_MGR)</option>
                </>
              )}
            </select>
            <input
              placeholder="دسترسی شعب (مثلاً ALL یا شعبه مرکزی)"
              value={invForm.branch_access}
              onChange={(e) => setInvForm({ ...invForm, branch_access: e.target.value })}
              className="glass-input px-3 py-2"
            />
            <input
              placeholder="دسترسی انبارها (ALL یا شناسه)"
              value={invForm.warehouse_access}
              onChange={(e) => setInvForm({ ...invForm, warehouse_access: e.target.value })}
              className="glass-input px-3 py-2"
            />
          </div>
          <button
            type="submit"
            className="w-full rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white py-2 font-semibold cursor-pointer"
          >
            ایجاد دعوت‌نامه یک‌بارمصرف (Pending)
          </button>
        </form>

        {/* Accept Invitation Verification Form */}
        <form onSubmit={handleAcceptInvitation} className="glass-primary p-5 space-y-3 text-xs">
          <h3 className="text-sm font-bold flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-violet-500" />
            <span>پذیرش دعوت‌نامه با توکن یک‌بارمصرف (تست فعال‌سازی عضویت)</span>
          </h3>
          <p className="text-slate-500 dark:text-slate-400">
            دعوت‌نامه تا پیش از پذیرش توسط کاربر دعوت‌شده هیچ دسترسی ایجاد نمی‌کند.
          </p>
          <input
            required
            dir="ltr"
            placeholder="توکن دعوت‌نامه (inv_...)"
            value={acceptForm.token}
            onChange={(e) => setAcceptForm({ ...acceptForm, token: e.target.value })}
            className="w-full glass-input px-3 py-2 font-mono text-left"
          />
          <div className="grid grid-cols-2 gap-2.5">
            <input
              placeholder="نام کامل کاربر جدید"
              value={acceptForm.full_name}
              onChange={(e) => setAcceptForm({ ...acceptForm, full_name: e.target.value })}
              className="glass-input px-3 py-2"
            />
            <input
              type="password"
              dir="ltr"
              placeholder="رمز عبور (کاربر جدید)"
              value={acceptForm.password}
              onChange={(e) => setAcceptForm({ ...acceptForm, password: e.target.value })}
              className="glass-input px-3 py-2 text-left"
            />
          </div>
          <button
            type="submit"
            className="w-full rounded-xl bg-violet-600 hover:bg-violet-700 text-white py-2 font-semibold cursor-pointer"
          >
            تایید و پذیرش دعوت‌نامه
          </button>
        </form>
      </div>

      {/* 3. Pending & Past Invitations */}
      <div className="glass-data p-5 space-y-3 overflow-x-auto">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold">دعوت‌نامه‌های ارسالی ({invitations.length})</h3>
          <button type="button" onClick={loadData} className="text-xs text-violet-600 inline-flex items-center gap-1 cursor-pointer">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            <span>بروزرسانی</span>
          </button>
        </div>
        <table className="w-full text-xs text-right">
          <thead className="border-b border-slate-200 dark:border-slate-700 text-slate-500">
            <tr>
              <th className="px-3 py-2">کاربر دعوت‌شده</th>
              <th className="px-3 py-2">نقش / شعب</th>
              <th className="px-3 py-2">توکن یک‌بارمصرف</th>
              <th className="px-3 py-2">وضعیت</th>
              <th className="px-3 py-2">عملیات</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200/50 dark:divide-slate-700/40">
            {invitations.map((inv) => (
              <tr key={String(inv.id)}>
                <td className="px-3 py-2.5">
                  <div className="font-semibold">{String(inv.invitee_name || "—")}</div>
                  <div className="font-mono text-[11px] text-slate-400">
                    {String(inv.mobile || inv.email)}
                  </div>
                </td>
                <td className="px-3 py-2.5">
                  <div>{String(inv.role_name || inv.role_code || "—")}</div>
                  <div className="text-[10px] text-slate-400">
                    شعبه: {Array.isArray(inv.branch_access) ? (inv.branch_access as string[]).join(", ") : "ALL"}
                  </div>
                </td>
                <td className="px-3 py-2.5 font-mono text-[11px]">
                  {inv.token ? (
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard?.writeText(String(inv.token));
                        setAcceptForm((p) => ({ ...p, token: String(inv.token) }));
                        onToast("توکن دعوت‌نامه کپی و در فرم پذیرش قرار گرفت.");
                      }}
                      className="inline-flex items-center gap-1 glass-input px-2 py-1 cursor-pointer"
                    >
                      <Copy className="h-3 w-3" />
                      <span>{String(inv.token).slice(0, 14)}...</span>
                    </button>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-3 py-2.5">
                  <span
                    className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                      inv.status === "ACCEPTED"
                        ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                        : inv.status === "PENDING"
                          ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                          : "bg-rose-500/15 text-rose-700 dark:text-rose-300"
                    }`}
                  >
                    {String(inv.status)}
                  </span>
                </td>
                <td className="px-3 py-2.5">
                  {inv.status === "PENDING" && (
                    <button
                      type="button"
                      onClick={() => handleRevokeInvitation(String(inv.id))}
                      className="rounded-lg border border-rose-300 text-rose-600 px-2.5 py-1 text-[11px] cursor-pointer"
                    >
                      ابطال
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 4. Active Organization Members & Session Control (§6.4–§6.9) */}
      <div className="glass-data p-5 space-y-3 overflow-x-auto">
        <h3 className="text-sm font-bold">اعضای سازمان، نقش‌ها، شعب و نشست‌ها ({members.length})</h3>
        <table className="w-full text-xs text-right">
          <thead className="border-b border-slate-200 dark:border-slate-700 text-slate-500">
            <tr>
              <th className="px-3 py-2">کاربر</th>
              <th className="px-3 py-2">نقش فعلی</th>
              <th className="px-3 py-2">شعب / انبار</th>
              <th className="px-3 py-2">وضعیت / نشست‌ها</th>
              <th className="px-3 py-2">عملیات امنیتی</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200/50 dark:divide-slate-700/40">
            {members.map((m) => {
              const mRoles = (m.roles as Array<{ code: string; name: string }>) ?? [];
              const curRoleCode = mRoles[0]?.code ?? "";
              return (
                <tr key={String(m.id)}>
                  <td className="px-3 py-2.5">
                    <div className="font-bold">
                      {String(m.full_name)} {m.is_owner ? <span className="text-violet-500">(مالک)</span> : ""}
                    </div>
                    <div className="font-mono text-[11px] text-slate-400">
                      {String(m.email)} • {String(m.mobile || "—")}
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    {!m.is_owner ? (
                      <select
                        value={curRoleCode}
                        onChange={(e) => handleUpdateMember(String(m.id), { role_code: e.target.value })}
                        className="glass-input px-2 py-1 text-[11px]"
                      >
                        {rolesList.map((r) => (
                          <option key={String(r.id)} value={String(r.code)}>
                            {String(r.name)}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="font-semibold text-violet-600">مالک کامل</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-[11px]">
                    <div>شعب: {Array.isArray(m.branch_access) ? (m.branch_access as string[]).join(", ") : "ALL"}</div>
                    <div className="text-slate-400">
                      انبار: {Array.isArray(m.warehouse_access) ? (m.warehouse_access as string[]).join(", ") : "ALL"}
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    <span
                      className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                        m.membership_status === "ACTIVE"
                          ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                          : "bg-rose-500/15 text-rose-700 dark:text-rose-300"
                      }`}
                    >
                      {String(m.membership_status)}
                    </span>
                    <div className="text-[10px] text-slate-400 mt-1">
                      نشست فعال: {String(m.active_sessions_count ?? 0)}
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    {!m.is_owner && (
                      <div className="flex flex-wrap gap-1.5">
                        <button
                          type="button"
                          onClick={() =>
                            handleUpdateMember(String(m.id), {
                              status: m.membership_status === "ACTIVE" ? "SUSPENDED" : "ACTIVE",
                            })
                          }
                          className="inline-flex items-center gap-1 rounded-lg glass-input px-2 py-1 text-[11px] cursor-pointer"
                        >
                          {m.membership_status === "ACTIVE" ? (
                            <>
                              <UserX className="h-3 w-3 text-amber-500" />
                              <span>تعلیق</span>
                            </>
                          ) : (
                            <>
                              <UserCheck className="h-3 w-3 text-emerald-500" />
                              <span>فعال‌سازی</span>
                            </>
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRevokeSessions(String(m.id))}
                          className="inline-flex items-center gap-1 rounded-lg glass-input px-2 py-1 text-[11px] cursor-pointer"
                        >
                          <LogOut className="h-3 w-3 text-sky-500" />
                          <span>ابطال نشست</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRemoveMember(String(m.id))}
                          className="inline-flex items-center gap-1 rounded-lg border border-rose-300 text-rose-600 px-2 py-1 text-[11px] cursor-pointer"
                        >
                          <Trash2 className="h-3 w-3" />
                          <span>حذف عضویت</span>
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 5. Security & Access Audit Trail (§6.10) */}
      <div className="glass-data p-5 space-y-3">
        <h3 className="text-sm font-bold flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-rose-500" />
          <span>لاگ ممیزی دسترسی و عملیات حساس سازمان (Audit Trail)</span>
        </h3>
        <div className="space-y-1.5 max-h-60 overflow-y-auto text-xs">
          {auditList.slice(0, 20).map((log) => (
            <div key={String(log.id)} className="glass-secondary px-3.5 py-2 flex items-center justify-between gap-2">
              <div>
                <span className="font-mono text-[11px] font-bold">{String(log.action)}</span>
                <span className="text-slate-500 mr-2">{String(log.actor_email || "system")}</span>
              </div>
              <span className="text-[11px] text-slate-400">{formatDateTimeFa(log.created_at as string)}</span>
            </div>
          ))}
        </div>
      </div>

      <span className="hidden"><CheckCircle2 /></span>
    </div>
  );
}

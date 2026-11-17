"use client";

import React, { useCallback, useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BookOpen,
  Building2,
  CheckCircle2,
  CreditCard,
  FileCode2,
  FileText,
  Key,
  LayoutDashboard,
  LifeBuoy,
  Mail,
  MessageSquare,
  Plus,
  RefreshCw,
  Settings,
  Shield,
  Smartphone,
  Users,
  XCircle,
} from "lucide-react";
import {
  apiFetch,
  formatDateFa,
  formatDateTimeFa,
  formatIrr,
} from "@/lib/format";
import { PlatformSaasAdmin } from "./PlatformSaasAdmin";

type PlatformTab =
  | "overview"
  | "organizations"
  | "users"
  | "roles"
  | "plans"
  | "payments"
  | "devices"
  | "academy"
  | "sms"
  | "inquiries"
  | "audit"
  | "errors"
  | "settings"
  | "tickets"
  | "contracts";

interface PlatformAdminPortalProps {
  onToast: (msg: string, type?: "success" | "error") => void;
}

const TABS: Array<{ id: PlatformTab; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: "overview", label: "داشبورد کل سیستم", icon: LayoutDashboard },
  { id: "organizations", label: "سازمان‌ها و کسب‌وکارها", icon: Building2 },
  { id: "users", label: "کاربران و عضویت‌ها", icon: Users },
  { id: "roles", label: "نقش‌ها و دسترسی‌ها", icon: Key },
  { id: "plans", label: "اشتراک‌ها و Entitlement", icon: Shield },
  { id: "payments", label: "پرداخت‌ها و کافه‌بازار", icon: CreditCard },
  { id: "devices", label: "دستگاه‌ها و Sync", icon: Smartphone },
  { id: "academy", label: "مدیریت آموزش‌ها (آکادمی)", icon: BookOpen },
  { id: "sms", label: "تنظیمات پیامک (SMS.ir / کاوه‌نگار)", icon: MessageSquare },
  { id: "inquiries", label: "پیام‌های تماس با ما", icon: Mail },
  { id: "audit", label: "لاگ‌ها و Audit", icon: FileText },
  { id: "errors", label: "گزارش خطاها", icon: AlertTriangle },
  { id: "settings", label: "تنظیمات عمومی پلتفرم", icon: Settings },
  { id: "tickets", label: "پشتیبانی و تیکت‌ها", icon: LifeBuoy },
  { id: "contracts", label: "قراردادها و OpenAPI", icon: FileCode2 },
];

export function PlatformAdminPortal({ onToast }: PlatformAdminPortalProps) {
  const [tab, setTab] = useState<PlatformTab>("overview");
  const [loading, setLoading] = useState(false);

  const [overview, setOverview] = useState<Record<string, unknown> | null>(null);
  const [orgs, setOrgs] = useState<Array<Record<string, unknown>>>([]);
  const [usersList, setUsersList] = useState<Array<Record<string, unknown>>>([]);
  const [rolesData, setRolesData] = useState<{
    roles: Array<{ id: string; scope: string; code: string; name: string; permission_ids: string[] }>;
    permissions: Array<{ id: string; scope: string; module: string; code: string; label_fa: string }>;
  } | null>(null);
  const [plansData, setPlansData] = useState<Record<string, unknown> | null>(null);
  const [paymentsData, setPaymentsData] = useState<Record<string, unknown> | null>(null);
  const [devicesData, setDevicesData] = useState<Record<string, unknown> | null>(null);
  const [auditLogs, setAuditLogs] = useState<Array<Record<string, unknown>>>([]);
  const [errorLogs, setErrorLogs] = useState<Array<Record<string, unknown>>>([]);
  const [settingsList, setSettingsList] = useState<Array<Record<string, unknown>>>([]);
  const [ticketsList, setTicketsList] = useState<Array<Record<string, unknown>>>([]);
  const [docsList, setDocsList] = useState<Array<{ key: string; title_fa: string; path: string; content: string }>>([]);
  const [selectedDocKey, setSelectedDocKey] = useState("openapi");

  const [showOrgForm, setShowOrgForm] = useState(false);
  const [orgForm, setOrgForm] = useState({
    name: "",
    legalName: "",
    businessType: "DISTRIBUTION",
    economicCode: "",
    baseCurrency: "IRR",
    costingMethod: "WEIGHTED_AVERAGE",
    negativeStockPolicy: "BLOCK",
    planCode: "PRO",
  });

  const [showUserForm, setShowUserForm] = useState(false);
  const [userForm, setUserForm] = useState({
    fullName: "",
    email: "",
    phone: "",
    password: "",
    isPlatformAdmin: false,
    organizationId: "",
  });

  const [auditScope, setAuditScope] = useState<string>("");

  const loadTab = useCallback(
    async (activeTab: PlatformTab) => {
      setLoading(true);
      try {
        if (activeTab === "overview") {
          setOverview(await apiFetch<Record<string, unknown>>("/api/v1/platform/overview"));
        } else if (activeTab === "organizations") {
          const data = await apiFetch<{ organizations: Array<Record<string, unknown>> }>("/api/v1/platform/organizations");
          setOrgs(data.organizations);
        } else if (activeTab === "users") {
          const [uData, oData] = await Promise.all([
            apiFetch<{ users: Array<Record<string, unknown>> }>("/api/v1/platform/users"),
            apiFetch<{ organizations: Array<Record<string, unknown>> }>("/api/v1/platform/organizations"),
          ]);
          setUsersList(uData.users);
          setOrgs(oData.organizations);
        } else if (activeTab === "roles") {
          setRolesData(
            await apiFetch<{
              roles: Array<{ id: string; scope: string; code: string; name: string; permission_ids: string[] }>;
              permissions: Array<{ id: string; scope: string; module: string; code: string; label_fa: string }>;
            }>("/api/v1/platform/roles")
          );
        } else if (activeTab === "plans") {
          const [pData, oData] = await Promise.all([
            apiFetch<Record<string, unknown>>("/api/v1/platform/plans"),
            apiFetch<{ organizations: Array<Record<string, unknown>> }>("/api/v1/platform/organizations"),
          ]);
          setPlansData(pData);
          setOrgs(oData.organizations);
        } else if (activeTab === "payments") {
          setPaymentsData(await apiFetch<Record<string, unknown>>("/api/v1/platform/payments"));
        } else if (activeTab === "devices") {
          setDevicesData(await apiFetch<Record<string, unknown>>("/api/v1/platform/devices"));
        } else if (activeTab === "audit") {
          const url = auditScope
            ? `/api/v1/platform/audit-logs?scope=${encodeURIComponent(auditScope)}`
            : "/api/v1/platform/audit-logs";
          const data = await apiFetch<{ logs: Array<Record<string, unknown>> }>(url);
          setAuditLogs(data.logs);
        } else if (activeTab === "errors") {
          const data = await apiFetch<{ errors: Array<Record<string, unknown>> }>("/api/v1/platform/error-logs");
          setErrorLogs(data.errors);
        } else if (activeTab === "settings") {
          const data = await apiFetch<{ settings: Array<Record<string, unknown>> }>("/api/v1/platform/settings");
          setSettingsList(data.settings);
        } else if (activeTab === "tickets") {
          const data = await apiFetch<{ tickets: Array<Record<string, unknown>> }>("/api/v1/platform/tickets");
          setTicketsList(data.tickets);
        } else if (activeTab === "contracts") {
          const data = await apiFetch<{ docs: Array<{ key: string; title_fa: string; path: string; content: string }> }>("/api/v1/docs");
          setDocsList(data.docs);
        }
      } catch (e) {
        onToast(e instanceof Error ? e.message : "خطا در بارگذاری اطلاعات پلتفرم", "error");
      } finally {
        setLoading(false);
      }
    },
    [auditScope, onToast]
  );

  useEffect(() => {
    loadTab(tab);
  }, [tab, loadTab]);

  async function handleCreateOrg(e: React.FormEvent) {
    e.preventDefault();
    try {
      await apiFetch("/api/v1/platform/organizations", {
        method: "POST",
        body: JSON.stringify(orgForm),
      });
      onToast("سازمان جدید به همراه کدینگ حسابداری، سال مالی و انبار پیش‌فرض ایجاد شد.");
      setShowOrgForm(false);
      setOrgForm({ ...orgForm, name: "", legalName: "", economicCode: "" });
      loadTab("organizations");
    } catch (err) {
      onToast(err instanceof Error ? err.message : "خطا در ایجاد سازمان", "error");
    }
  }

  async function toggleOrgStatus(id: string, currentStatus: string) {
    try {
      const nextStatus = currentStatus === "ACTIVE" ? "SUSPENDED" : "ACTIVE";
      await apiFetch("/api/v1/platform/organizations", {
        method: "PATCH",
        body: JSON.stringify({ id, status: nextStatus }),
      });
      onToast(`وضعیت سازمان به ${nextStatus === "ACTIVE" ? "فعال" : "تعلیق"} تغییر یافت.`);
      loadTab("organizations");
    } catch (err) {
      onToast(err instanceof Error ? err.message : "خطا در تغییر وضعیت", "error");
    }
  }

  async function handleCreateUser(e: React.FormEvent) {
    e.preventDefault();
    try {
      await apiFetch("/api/v1/platform/users", {
        method: "POST",
        body: JSON.stringify({
          ...userForm,
          organizationId: userForm.organizationId || undefined,
        }),
      });
      onToast("کاربر جدید ایجاد و عضویت سازمانی ثبت شد.");
      setShowUserForm(false);
      setUserForm({ fullName: "", email: "", phone: "", password: "", isPlatformAdmin: false, organizationId: "" });
      loadTab("users");
    } catch (err) {
      onToast(err instanceof Error ? err.message : "خطا در ایجاد کاربر", "error");
    }
  }

  async function toggleRolePermission(roleId: string, permissionId: string, currentlyEnabled: boolean) {
    try {
      await apiFetch("/api/v1/platform/roles", {
        method: "PATCH",
        body: JSON.stringify({ roleId, permissionId, enabled: !currentlyEnabled }),
      });
      onToast("ماتریس دسترسی‌ها به‌روزرسانی و در لاگ ممیزی ثبت شد.");
      loadTab("roles");
    } catch (err) {
      onToast(err instanceof Error ? err.message : "خطا در تغییر مجوز", "error");
    }
  }

  async function resolveConflict(
    conflictId: string,
    resolution: "USE_SERVER" | "USE_LOCAL" | "MERGE" | "RECREATE_AS_NEW"
  ) {
    try {
      await apiFetch(`/api/v1/sync/conflicts/${conflictId}/resolve?realm=platform`, {
        method: "POST",
        body: JSON.stringify({ resolution }),
      });
      onToast(`تعارض همگام‌سازی با استراتژی ${resolution} برطرف و در Change Log ثبت شد.`);
      loadTab("devices");
    } catch (err) {
      onToast(err instanceof Error ? err.message : "خطا در رفع تعارض", "error");
    }
  }

  async function updateErrorStatus(id: string, status: "RESOLVED" | "INVESTIGATING") {
    try {
      await apiFetch("/api/v1/platform/error-logs", {
        method: "PATCH",
        body: JSON.stringify({ id, status }),
      });
      onToast("وضعیت خطای سیستمی به‌روزرسانی شد.");
      loadTab("errors");
    } catch (err) {
      onToast(err instanceof Error ? err.message : "خطا در به‌روزرسانی", "error");
    }
  }

  async function updateTicketStatus(id: string, status: "IN_PROGRESS" | "RESOLVED") {
    try {
      await apiFetch("/api/v1/platform/tickets", {
        method: "PATCH",
        body: JSON.stringify({
          id,
          status,
          resolutionNote: status === "RESOLVED" ? "بررسی و توسط تیم پشتیبانی پلتفرم برطرف شد." : undefined,
        }),
      });
      onToast("وضعیت تیکت پشتیبانی به‌روزرسانی شد.");
      loadTab("tickets");
    } catch (err) {
      onToast(err instanceof Error ? err.message : "خطا در به‌روزرسانی تیکت", "error");
    }
  }

  const kpis = (overview?.kpis ?? {}) as Record<string, string | number>;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
      <aside className="lg:col-span-3 xl:col-span-2 bg-white rounded-2xl border border-slate-200 p-3 shadow-xs lg:sticky lg:top-20">
        <div className="px-3 py-2 mb-2 rounded-xl bg-indigo-50 border border-indigo-100">
          <div className="text-[11px] font-bold text-indigo-800 flex items-center gap-1.5">
            <Shield className="h-3.5 w-3.5" />
            <span>حوزه مدیریت پلتفرم</span>
          </div>
          <div className="text-[10px] text-indigo-600 mt-0.5">
            تفکیک کامل سطح دسترسی از مستاجرها
          </div>
        </div>
        <nav className="space-y-1">
          {TABS.map((item) => {
            const Icon = item.icon;
            const active = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-medium transition-colors cursor-pointer ${
                  active
                    ? "bg-indigo-600 text-white shadow-xs"
                    : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </nav>
      </aside>

      <section className="lg:col-span-9 xl:col-span-10 space-y-5 min-w-0">
        <div className="flex flex-wrap items-center justify-between gap-3 bg-white rounded-2xl border border-slate-200 px-5 py-4">
          <div>
            <h2 className="text-base font-bold text-slate-900">
              {TABS.find((t) => t.id === tab)?.label}
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              پایش متمرکز کل سیستم، چندمستاجری، امنیت، پرداخت کافه‌بازار و Sync اندروید
            </p>
          </div>
          <button
            type="button"
            onClick={() => loadTab(tab)}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 px-3 py-1.5 text-xs font-medium text-slate-700 cursor-pointer"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            <span>بروزرسانی</span>
          </button>
        </div>

        {/* 1. OVERVIEW */}
        {tab === "overview" && (
          <div className="space-y-5">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[
                { label: "سازمان‌های ثبت‌شده", val: kpis.organizations_count ?? 0, sub: `${kpis.active_subscriptions ?? 0} اشتراک فعال`, tone: "text-indigo-700 bg-indigo-50" },
                { label: "کل کاربران پلتفرم", val: kpis.users_count ?? 0, sub: "با جداسازی عضویت", tone: "text-slate-800 bg-slate-100" },
                { label: "درآمد تاییدشده کافه‌بازار", val: `${formatIrr(kpis.total_revenue_irr)} ریال`, sub: `${kpis.verified_payments_count ?? 0} تراکنش معتبر`, tone: "text-emerald-700 bg-emerald-50" },
                { label: "دستگاه‌های اندروید", val: kpis.devices_count ?? 0, sub: `${kpis.open_sync_conflicts ?? 0} تعارض باز`, tone: "text-amber-700 bg-amber-50" },
              ].map((card) => (
                <div key={card.label} className="bg-white rounded-2xl border border-slate-200 p-4">
                  <div className="text-xs text-slate-500">{card.label}</div>
                  <div className="text-xl font-bold text-slate-900 mt-2 tabular-nums">
                    {card.val}
                  </div>
                  <div className={`inline-block mt-2 text-[11px] font-medium px-2 py-0.5 rounded-full ${card.tone}`}>
                    {card.sub}
                  </div>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              <div className="bg-white rounded-2xl border border-slate-200 p-5">
                <h3 className="text-sm font-bold text-slate-900 mb-3 flex items-center gap-2">
                  <Activity className="h-4 w-4 text-indigo-600" />
                  <span>آخرین رخدادهای ممیزی و امنیتی (Audit Trail)</span>
                </h3>
                <div className="space-y-2.5">
                  {((overview?.recent_audits as Array<Record<string, unknown>>) ?? []).map((log) => (
                    <div
                      key={String(log.id)}
                      className="flex items-start justify-between gap-3 rounded-xl border border-slate-100 bg-slate-50/70 px-3.5 py-2.5 text-xs"
                    >
                      <div>
                        <div className="font-semibold text-slate-800 font-mono text-[11px]">
                          {String(log.action)}
                        </div>
                        <div className="text-slate-500 mt-0.5">
                          {String(log.actor_email || "system")} • {String(log.entity_type)}
                        </div>
                      </div>
                      <span
                        className={`shrink-0 px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                          log.severity === "CRITICAL"
                            ? "bg-rose-100 text-rose-700"
                            : log.severity === "WARN"
                              ? "bg-amber-100 text-amber-700"
                              : "bg-slate-200 text-slate-700"
                        }`}
                      >
                        {String(log.scope)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-white rounded-2xl border border-slate-200 p-5">
                <h3 className="text-sm font-bold text-slate-900 mb-3 flex items-center gap-2">
                  <Smartphone className="h-4 w-4 text-emerald-600" />
                  <span>آخرین دسته‌های همگام‌سازی آفلاین (Sync Batches)</span>
                </h3>
                <div className="space-y-2.5">
                  {((overview?.recent_batches as Array<Record<string, unknown>>) ?? []).map((b) => (
                    <div
                      key={String(b.id)}
                      className="flex items-center justify-between rounded-xl border border-slate-100 bg-slate-50/70 px-3.5 py-2.5 text-xs"
                    >
                      <div>
                        <div className="font-mono text-[11px] font-semibold text-slate-800">
                          {String(b.client_batch_id)}
                        </div>
                        <div className="text-slate-500 mt-0.5 tabular-nums">
                          اعمال: {String(b.applied_count)} | تعارض: {String(b.conflict_count)} | رد: {String(b.rejected_count)}
                        </div>
                      </div>
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-indigo-50 text-indigo-700">
                        {String(b.status)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* 2. ORGANIZATIONS */}
        {tab === "organizations" && (
          <div className="space-y-4">
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setShowOrgForm(!showOrgForm)}
                className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 text-xs font-medium cursor-pointer"
              >
                <Plus className="h-4 w-4" />
                <span>ایجاد سازمان جدید (با Provisioning خودکار)</span>
              </button>
            </div>

            {showOrgForm && (
              <form
                onSubmit={handleCreateOrg}
                className="bg-white rounded-2xl border border-indigo-200 p-5 grid grid-cols-1 md:grid-cols-3 gap-4"
              >
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">نام کسب‌وکار *</label>
                  <input
                    required
                    value={orgForm.name}
                    onChange={(e) => setOrgForm({ ...orgForm, name: e.target.value })}
                    placeholder="مثلاً: پخش مواد غذایی بهاران"
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">نام حقوقی</label>
                  <input
                    value={orgForm.legalName}
                    onChange={(e) => setOrgForm({ ...orgForm, legalName: e.target.value })}
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">نوع کسب‌وکار</label>
                  <select
                    value={orgForm.businessType}
                    onChange={(e) => setOrgForm({ ...orgForm, businessType: e.target.value })}
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs"
                  >
                    <option value="RETAIL">خرده‌فروشی (RETAIL)</option>
                    <option value="WHOLESALE">عمده‌فروشی (WHOLESALE)</option>
                    <option value="DISTRIBUTION">پخش و بازرگانی (DISTRIBUTION)</option>
                    <option value="SERVICES">خدماتی (SERVICES)</option>
                    <option value="MANUFACTURING">تولیدی (MANUFACTURING)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">روش ارزش‌گذاری انبار</label>
                  <select
                    value={orgForm.costingMethod}
                    onChange={(e) => setOrgForm({ ...orgForm, costingMethod: e.target.value })}
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs"
                  >
                    <option value="WEIGHTED_AVERAGE">میانگین موزون (WEIGHTED_AVERAGE)</option>
                    <option value="FIFO">اولین صادره از اولین وارده (FIFO)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">سیاست موجودی منفی</label>
                  <select
                    value={orgForm.negativeStockPolicy}
                    onChange={(e) => setOrgForm({ ...orgForm, negativeStockPolicy: e.target.value })}
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs"
                  >
                    <option value="BLOCK">مسدودسازی (BLOCK)</option>
                    <option value="WARN">هشدار (WARN)</option>
                    <option value="ALLOW">مجاز (ALLOW)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">پلن اشتراک اولیه</label>
                  <select
                    value={orgForm.planCode}
                    onChange={(e) => setOrgForm({ ...orgForm, planCode: e.target.value })}
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs"
                  >
                    <option value="FREE">رایگان پایه (FREE)</option>
                    <option value="PRO">حرفه‌ای (PRO)</option>
                    <option value="ENTERPRISE">سازمانی (ENTERPRISE)</option>
                  </select>
                </div>
                <div className="md:col-span-3 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setShowOrgForm(false)}
                    className="rounded-xl border border-slate-200 px-4 py-2 text-xs text-slate-600 cursor-pointer"
                  >
                    انصراف
                  </button>
                  <button
                    type="submit"
                    className="rounded-xl bg-indigo-600 text-white px-5 py-2 text-xs font-medium cursor-pointer"
                  >
                    ثبت و راه‌اندازی سازمان
                  </button>
                </div>
              </form>
            )}

            <div className="bg-white rounded-2xl border border-slate-200 overflow-x-auto">
              <table className="w-full text-xs text-right">
                <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                  <tr>
                    <th className="px-4 py-3">نام سازمان</th>
                    <th className="px-4 py-3">نوع / ارز</th>
                    <th className="px-4 py-3">سیاست انبار</th>
                    <th className="px-4 py-3">اشتراک</th>
                    <th className="px-4 py-3">اعضا</th>
                    <th className="px-4 py-3">وضعیت</th>
                    <th className="px-4 py-3">عملیات</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {orgs.map((o) => {
                    const sub = o.subscription as Record<string, unknown> | null;
                    return (
                      <tr key={String(o.id)} className="hover:bg-slate-50/60">
                        <td className="px-4 py-3">
                          <div className="font-semibold text-slate-900">{String(o.name)}</div>
                          <div className="text-[11px] text-slate-400">{String(o.legal_name || "—")}</div>
                        </td>
                        <td className="px-4 py-3 font-mono text-[11px]">
                          {String(o.business_type)} / {String(o.base_currency)}
                        </td>
                        <td className="px-4 py-3 text-[11px]">
                          <div>{String(o.costing_method)}</div>
                          <div className="text-slate-400">منفی: {String(o.negative_stock_policy)}</div>
                        </td>
                        <td className="px-4 py-3">
                          {sub ? (
                            <span
                              className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                                sub.status === "EXPIRED"
                                  ? "bg-amber-100 text-amber-800"
                                  : "bg-emerald-100 text-emerald-800"
                              }`}
                            >
                              {String(sub.plan_name_fa)} ({String(sub.status)})
                            </span>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="px-4 py-3 tabular-nums">{String(o.members_count ?? 0)}</td>
                        <td className="px-4 py-3">
                          <span
                            className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                              o.status === "ACTIVE"
                                ? "bg-emerald-50 text-emerald-700"
                                : "bg-rose-50 text-rose-700"
                            }`}
                          >
                            {o.status === "ACTIVE" ? "فعال" : "تعلیق"}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <button
                            type="button"
                            onClick={() => toggleOrgStatus(String(o.id), String(o.status))}
                            className="rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] hover:bg-slate-100 cursor-pointer"
                          >
                            {o.status === "ACTIVE" ? "تعلیق" : "فعال‌سازی"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* 3. USERS */}
        {tab === "users" && (
          <div className="space-y-4">
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setShowUserForm(!showUserForm)}
                className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 text-white px-4 py-2 text-xs font-medium cursor-pointer"
              >
                <Plus className="h-4 w-4" />
                <span>افزودن کاربر جدید</span>
              </button>
            </div>

            {showUserForm && (
              <form
                onSubmit={handleCreateUser}
                className="bg-white rounded-2xl border border-indigo-200 p-5 grid grid-cols-1 md:grid-cols-3 gap-4"
              >
                <input
                  required
                  placeholder="نام و نام خانوادگی"
                  value={userForm.fullName}
                  onChange={(e) => setUserForm({ ...userForm, fullName: e.target.value })}
                  className="rounded-xl border border-slate-200 px-3 py-2 text-xs"
                />
                <input
                  required
                  type="email"
                  dir="ltr"
                  placeholder="user@company.ir"
                  value={userForm.email}
                  onChange={(e) => setUserForm({ ...userForm, email: e.target.value })}
                  className="rounded-xl border border-slate-200 px-3 py-2 text-xs text-left"
                />
                <input
                  required
                  type="password"
                  dir="ltr"
                  placeholder="رمز عبور (حداقل ۶ کاراکتر)"
                  value={userForm.password}
                  onChange={(e) => setUserForm({ ...userForm, password: e.target.value })}
                  className="rounded-xl border border-slate-200 px-3 py-2 text-xs text-left"
                />
                <select
                  value={userForm.organizationId}
                  onChange={(e) => setUserForm({ ...userForm, organizationId: e.target.value })}
                  className="rounded-xl border border-slate-200 px-3 py-2 text-xs"
                >
                  <option value="">بدون عضویت سازمانی اولیه</option>
                  {orgs.map((o) => (
                    <option key={String(o.id)} value={String(o.id)}>
                      {String(o.name)}
                    </option>
                  ))}
                </select>
                <label className="flex items-center gap-2 text-xs text-slate-700">
                  <input
                    type="checkbox"
                    checked={userForm.isPlatformAdmin}
                    onChange={(e) => setUserForm({ ...userForm, isPlatformAdmin: e.target.checked })}
                  />
                  <span>دسترسی مدیر پلتفرم</span>
                </label>
                <div className="flex justify-end">
                  <button type="submit" className="rounded-xl bg-indigo-600 text-white px-5 py-2 text-xs font-medium cursor-pointer">
                    ایجاد کاربر
                  </button>
                </div>
              </form>
            )}

            <div className="bg-white rounded-2xl border border-slate-200 overflow-x-auto">
              <table className="w-full text-xs text-right">
                <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                  <tr>
                    <th className="px-4 py-3">نام و ایمیل / موبایل</th>
                    <th className="px-4 py-3">حوزه دسترسی</th>
                    <th className="px-4 py-3">عضویت در سازمان‌ها</th>
                    <th className="px-4 py-3">نقش‌ها</th>
                    <th className="px-4 py-3">آخرین ورود</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {usersList.map((u) => (
                    <tr key={String(u.id)}>
                      <td className="px-4 py-3">
                        <div className="font-semibold text-slate-900">{String(u.full_name)}</div>
                        <div dir="ltr" className="text-[11px] font-mono text-slate-400 text-right">
                          {String(u.email)} • {String(u.phone || "—")}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                            u.is_platform_admin
                              ? "bg-indigo-100 text-indigo-800"
                              : "bg-emerald-50 text-emerald-700"
                          }`}
                        >
                          {u.is_platform_admin ? "مدیر پلتفرم" : "کاربر سازمانی"}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {((u.memberships as Array<Record<string, unknown>>) ?? []).map((m) => (
                          <span
                            key={String(m.organization_id)}
                            className="inline-block ml-1 mb-1 bg-slate-100 text-slate-700 px-2 py-0.5 rounded-md text-[11px]"
                          >
                            {String(m.org_name)} {m.is_owner ? "(مالک)" : ""}
                          </span>
                        ))}
                      </td>
                      <td className="px-4 py-3">
                        {((u.roles as Array<Record<string, unknown>>) ?? []).map((r, i) => (
                          <span
                            key={i}
                            className="inline-block ml-1 mb-1 border border-slate-200 px-2 py-0.5 rounded-md text-[10px] text-slate-600"
                          >
                            {String(r.role_name)}
                          </span>
                        ))}
                      </td>
                      <td className="px-4 py-3 text-slate-500">
                        {formatDateTimeFa(u.last_login_at as string | null)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* 4. ROLES & PERMISSIONS MATRIX */}
        {tab === "roles" && rolesData && (
          <div className="bg-white rounded-2xl border border-slate-200 overflow-x-auto p-4">
            <p className="text-xs text-slate-500 mb-4">
              تغییر هر مجوز بلافاصله در پایگاه‌داده ذخیره و در لاگ ممیزی ثبت می‌شود.
            </p>
            <table className="w-full text-xs text-right border-collapse">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  <th className="p-2.5 text-slate-700 min-w-[200px]">مجوز (Permission)</th>
                  {rolesData.roles.map((r) => (
                    <th key={r.id} className="p-2.5 text-center">
                      <div className="font-bold text-slate-900">{r.name}</div>
                      <div className="text-[10px] font-mono text-slate-400">{r.scope}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rolesData.permissions.map((p) => (
                  <tr key={p.id} className="hover:bg-slate-50/70">
                    <td className="p-2.5">
                      <div className="font-medium text-slate-800">{p.label_fa}</div>
                      <div className="text-[10px] font-mono text-slate-400">
                        {p.code} • {p.scope}
                      </div>
                    </td>
                    {rolesData.roles.map((r) => {
                      const compatible = r.scope === p.scope;
                      const enabled = (r.permission_ids ?? []).includes(p.id);
                      return (
                        <td key={r.id} className="p-2.5 text-center">
                          {compatible ? (
                            <button
                              type="button"
                              onClick={() => toggleRolePermission(r.id, p.id, enabled)}
                              className={`h-6 w-6 rounded-lg inline-flex items-center justify-center transition-colors cursor-pointer ${
                                enabled
                                  ? "bg-indigo-600 text-white"
                                  : "bg-slate-100 text-slate-400 hover:bg-slate-200"
                              }`}
                            >
                              {enabled ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
                            </button>
                          ) : (
                            <span className="text-slate-300">—</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* 5. PLANS & ENTITLEMENTS */}
        {tab === "plans" && plansData && (
          <div className="space-y-5">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {((plansData.plans as Array<Record<string, unknown>>) ?? []).map((p) => (
                <div key={String(p.id)} className="bg-white rounded-2xl border border-slate-200 p-5">
                  <div className="flex items-center justify-between">
                    <h3 className="font-bold text-slate-900">{String(p.name_fa)}</h3>
                    <span className="font-mono text-[11px] px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700">
                      {String(p.code)}
                    </span>
                  </div>
                  <div className="mt-3 text-xl font-bold text-slate-900 tabular-nums">
                    {formatIrr(p.price_irr as string)} <span className="text-xs font-normal text-slate-500">ریال</span>
                  </div>
                  <div className="text-[11px] text-slate-400 font-mono mt-1">
                    SKU: {String(p.cafebazaar_sku || "—")} • {String(p.billing_days)} روزه
                  </div>
                  <ul className="mt-4 space-y-1.5 text-xs">
                    {((p.features as Array<Record<string, unknown>>) ?? []).map((pf) => {
                      const feat = pf.feature as Record<string, unknown> | undefined;
                      return (
                        <li key={String(pf.id)} className="flex items-center justify-between text-slate-600">
                          <span>{String(feat?.name_fa || "")}</span>
                          <span className={pf.enabled ? "text-emerald-600 font-semibold" : "text-slate-400"}>
                            {pf.enabled ? (pf.limit_value ? `تا ${pf.limit_value}` : "فعال") : "غیرفعال"}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>

            <div className="bg-white rounded-2xl border border-slate-200 p-5">
              <h3 className="text-sm font-bold text-slate-900 mb-3">وضعیت اشتراک سازمان‌ها</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-xs text-right">
                  <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                    <tr>
                      <th className="px-3 py-2.5">سازمان</th>
                      <th className="px-3 py-2.5">پلن</th>
                      <th className="px-3 py-2.5">منبع</th>
                      <th className="px-3 py-2.5">انقضا</th>
                      <th className="px-3 py-2.5">وضعیت</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {((plansData.subscriptions as Array<Record<string, unknown>>) ?? []).map((row, idx) => {
                      const sub = row.sub as Record<string, unknown>;
                      return (
                        <tr key={idx}>
                          <td className="px-3 py-2.5 font-medium">{String(row.org_name)}</td>
                          <td className="px-3 py-2.5">{String(row.plan_name_fa)}</td>
                          <td className="px-3 py-2.5 font-mono text-[11px]">{String(sub.source)}</td>
                          <td className="px-3 py-2.5">{formatDateFa(sub.expires_at as string)}</td>
                          <td className="px-3 py-2.5">
                            <span
                              className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                                sub.status === "EXPIRED"
                                  ? "bg-amber-100 text-amber-800"
                                  : "bg-emerald-100 text-emerald-800"
                              }`}
                            >
                              {String(sub.status)}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* 6. PAYMENTS */}
        {tab === "payments" && paymentsData && (
          <div className="space-y-5">
            <div className="bg-white rounded-2xl border border-slate-200 p-5 overflow-x-auto">
              <h3 className="text-sm font-bold text-slate-900 mb-3">تراکنش‌های پرداخت</h3>
              <table className="w-full text-xs text-right">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th className="px-3 py-2.5">سازمان</th>
                    <th className="px-3 py-2.5">پلن</th>
                    <th className="px-3 py-2.5">درگاه</th>
                    <th className="px-3 py-2.5">مبلغ (ریال)</th>
                    <th className="px-3 py-2.5">شناسه مرجع</th>
                    <th className="px-3 py-2.5">وضعیت</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {((paymentsData.payments as Array<Record<string, unknown>>) ?? []).map((row, idx) => {
                    const p = row.payment as Record<string, unknown>;
                    return (
                      <tr key={idx}>
                        <td className="px-3 py-2.5 font-medium">{String(row.org_name)}</td>
                        <td className="px-3 py-2.5">{String(row.plan_name_fa || "—")}</td>
                        <td className="px-3 py-2.5 font-mono text-[11px]">{String(p.provider)}</td>
                        <td className="px-3 py-2.5 tabular-nums font-semibold">{formatIrr(p.amount_irr as string)}</td>
                        <td className="px-3 py-2.5 font-mono text-[11px]">{String(p.external_ref || "—")}</td>
                        <td className="px-3 py-2.5">
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700">
                            {String(p.status)}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="bg-white rounded-2xl border border-slate-200 p-5 overflow-x-auto">
              <h3 className="text-sm font-bold text-slate-900 mb-3">رسیدهای اعتبارسنجی‌شده کافه‌بازار</h3>
              <table className="w-full text-xs text-right">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th className="px-3 py-2.5">سازمان</th>
                    <th className="px-3 py-2.5">پکیج / SKU</th>
                    <th className="px-3 py-2.5">وضعیت تایید سرور</th>
                    <th className="px-3 py-2.5">زمان تایید</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {((paymentsData.receipts as Array<Record<string, unknown>>) ?? []).map((row, idx) => {
                    const r = row.receipt as Record<string, unknown>;
                    return (
                      <tr key={idx}>
                        <td className="px-3 py-2.5 font-medium">{String(row.org_name)}</td>
                        <td className="px-3 py-2.5 font-mono text-[11px]">
                          {String(r.package_name)} / {String(r.sku)}
                        </td>
                        <td className="px-3 py-2.5">
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700">
                            {String(r.verification_status)}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-slate-500">{formatDateTimeFa(r.verified_at as string)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* 7. DEVICES & SYNC */}
        {tab === "devices" && devicesData && (
          <div className="space-y-5">
            <div className="bg-white rounded-2xl border border-slate-200 p-5 overflow-x-auto">
              <h3 className="text-sm font-bold text-slate-900 mb-3">دستگاه‌های اندروید متصل</h3>
              <table className="w-full text-xs text-right">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th className="px-3 py-2.5">نام دستگاه</th>
                    <th className="px-3 py-2.5">سازمان / کاربر</th>
                    <th className="px-3 py-2.5">نسخه اپ / OS</th>
                    <th className="px-3 py-2.5">آخرین Checkpoint</th>
                    <th className="px-3 py-2.5">آخرین Sync</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {((devicesData.devices as Array<Record<string, unknown>>) ?? []).map((row, i) => {
                    const d = row.device as Record<string, unknown>;
                    return (
                      <tr key={i}>
                        <td className="px-3 py-2.5">
                          <div className="font-semibold text-slate-900">{String(d.device_name)}</div>
                          <div className="text-[10px] font-mono text-slate-400">{String(d.device_uuid)}</div>
                        </td>
                        <td className="px-3 py-2.5">
                          <div>{String(row.org_name)}</div>
                          <div className="text-[11px] text-slate-400">{String(row.user_full_name)}</div>
                        </td>
                        <td className="px-3 py-2.5 font-mono text-[11px]">
                          {String(d.app_version || "—")} / {String(d.os_version || "—")}
                        </td>
                        <td className="px-3 py-2.5 font-mono tabular-nums">{String(d.last_checkpoint)}</td>
                        <td className="px-3 py-2.5 text-slate-500">{formatDateTimeFa(d.last_sync_at as string)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="bg-white rounded-2xl border border-slate-200 p-5">
              <h3 className="text-sm font-bold text-slate-900 mb-3">تعارض‌های همگام‌سازی (Sync Conflicts)</h3>
              <div className="space-y-3">
                {((devicesData.conflicts as Array<Record<string, unknown>>) ?? []).map((row, idx) => {
                  const c = row.conflict as Record<string, unknown>;
                  return (
                    <div key={idx} className="rounded-xl border border-slate-200 p-4 text-xs">
                      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                        <div className="font-semibold text-slate-900">
                          {String(row.org_name)} — {String(c.entity_type)} (دستگاه: {String(row.device_name)})
                        </div>
                        <span
                          className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                            c.status === "OPEN" ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-700"
                          }`}
                        >
                          {String(c.status)} {c.resolution_strategy ? `(${String(c.resolution_strategy)})` : ""}
                        </span>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 font-mono text-[11px]">
                        <div className="rounded-lg bg-slate-50 p-3 border border-slate-200">
                          <div className="font-sans font-semibold text-slate-600 mb-1">
                            داده سرور (نسخه {String(c.server_version)})
                          </div>
                          <pre dir="ltr" className="overflow-x-auto text-left text-slate-700">
                            {JSON.stringify(c.server_payload, null, 2)}
                          </pre>
                        </div>
                        <div className="rounded-lg bg-amber-50/50 p-3 border border-amber-200">
                          <div className="font-sans font-semibold text-amber-800 mb-1">
                            داده آفلاین اندروید (مبنا نسخه {String(c.client_version)})
                          </div>
                          <pre dir="ltr" className="overflow-x-auto text-left text-amber-900">
                            {JSON.stringify(c.client_payload, null, 2)}
                          </pre>
                        </div>
                      </div>
                      {Array.isArray(c.conflicting_fields) && c.conflicting_fields.length > 0 && (
                        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                          <span className="text-slate-500">فیلدهای متعارض ({String(c.conflict_type || "VERSION_MISMATCH")}):</span>
                          {(c.conflicting_fields as string[]).map((f) => (
                            <span key={f} className="font-mono bg-rose-50 text-rose-700 border border-rose-200 px-2 py-0.5 rounded-md">
                              {f}
                            </span>
                          ))}
                        </div>
                      )}
                      {c.status === "OPEN" && (
                        <div className="mt-3 flex flex-wrap gap-2 justify-end">
                          <button
                            type="button"
                            onClick={() => resolveConflict(String(c.id), "USE_SERVER")}
                            className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium hover:bg-slate-100 cursor-pointer"
                          >
                            USE_SERVER
                          </button>
                          <button
                            type="button"
                            onClick={() => resolveConflict(String(c.id), "MERGE")}
                            className="rounded-lg border border-indigo-300 bg-indigo-50 text-indigo-700 px-3 py-1.5 text-xs font-medium cursor-pointer"
                          >
                            MERGE
                          </button>
                          <button
                            type="button"
                            onClick={() => resolveConflict(String(c.id), "USE_LOCAL")}
                            className="rounded-lg bg-indigo-600 text-white px-3 py-1.5 text-xs font-medium hover:bg-indigo-700 cursor-pointer"
                          >
                            USE_LOCAL
                          </button>
                          <button
                            type="button"
                            onClick={() => resolveConflict(String(c.id), "RECREATE_AS_NEW")}
                            className="rounded-lg border border-teal-300 bg-teal-50 text-teal-800 px-3 py-1.5 text-xs font-medium cursor-pointer"
                          >
                            RECREATE_AS_NEW
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Prompt 04 §21 Sync Telemetry Logs */}
            <div className="bg-white rounded-2xl border border-slate-200 p-5 overflow-x-auto">
              <h3 className="text-sm font-bold text-slate-900 mb-3">
                گزارش پایش و تله‌متری Sync (sync_logs — بدون ثبت Payload حساس)
              </h3>
              <table className="w-full text-xs text-right">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th className="px-3 py-2">سازمان / دستگاه</th>
                    <th className="px-3 py-2">جهت</th>
                    <th className="px-3 py-2">Push / Pull</th>
                    <th className="px-3 py-2">موفق / خطا / تعارض</th>
                    <th className="px-3 py-2">زمان اجرا (ms)</th>
                    <th className="px-3 py-2">زمان</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 tabular-nums">
                  {((devicesData.sync_logs as Array<Record<string, unknown>>) ?? []).map((row, idx) => {
                    const l = row.log as Record<string, unknown>;
                    return (
                      <tr key={idx}>
                        <td className="px-3 py-2">
                          <div className="font-medium text-slate-900">{String(row.device_name)}</div>
                          <div className="text-[10px] text-slate-400">{String(row.org_name)}</div>
                        </td>
                        <td className="px-3 py-2 font-mono text-[11px]">{String(l.direction)}</td>
                        <td className="px-3 py-2 font-mono">{String(l.push_count)} / {String(l.pull_count)}</td>
                        <td className="px-3 py-2 font-mono">
                          <span className="text-emerald-700">{String(l.success_count)}</span> /{" "}
                          <span className="text-rose-700">{String(l.failure_count)}</span> /{" "}
                          <span className="text-amber-700">{String(l.conflict_count)}</span>
                        </td>
                        <td className="px-3 py-2 font-mono">{String(l.duration_ms)} ms</td>
                        <td className="px-3 py-2 text-slate-500">{formatDateTimeFa(l.started_at as string)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* 8. AUDIT LOGS */}
        {tab === "audit" && (
          <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-4">
            <div className="flex flex-wrap gap-2">
              {[
                { val: "", label: "همه رویدادها" },
                { val: "SECURITY", label: "رویدادهای امنیتی (SECURITY)" },
                { val: "PLATFORM", label: "پلتفرم (PLATFORM)" },
                { val: "ORGANIZATION", label: "عملیات سازمانی (ORGANIZATION)" },
              ].map((f) => (
                <button
                  key={f.val}
                  type="button"
                  onClick={() => setAuditScope(f.val)}
                  className={`px-3 py-1.5 rounded-xl text-xs font-medium cursor-pointer ${
                    auditScope === f.val
                      ? "bg-indigo-600 text-white"
                      : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-xs text-right">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th className="px-3 py-2.5">عملیات</th>
                    <th className="px-3 py-2.5">عامل / IP</th>
                    <th className="px-3 py-2.5">سازمان</th>
                    <th className="px-3 py-2.5">حوزه / سطح</th>
                    <th className="px-3 py-2.5">زمان</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {auditLogs.map((row, idx) => {
                    const l = row.log as Record<string, unknown>;
                    return (
                      <tr key={idx}>
                        <td className="px-3 py-2.5">
                          <div className="font-mono text-[11px] font-semibold text-slate-800">{String(l.action)}</div>
                          <div className="text-[10px] text-slate-400 font-mono truncate max-w-xs" dir="ltr">
                            {JSON.stringify(l.metadata)}
                          </div>
                        </td>
                        <td className="px-3 py-2.5">
                          <div>{String(l.actor_email || "system")}</div>
                          <div className="text-[10px] font-mono text-slate-400">{String(l.ip_address || "—")}</div>
                        </td>
                        <td className="px-3 py-2.5">{String(row.org_name || "پلتفرم")}</td>
                        <td className="px-3 py-2.5">
                          <span
                            className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                              l.severity === "CRITICAL"
                                ? "bg-rose-100 text-rose-700"
                                : l.severity === "WARN"
                                  ? "bg-amber-100 text-amber-800"
                                  : "bg-slate-100 text-slate-700"
                            }`}
                          >
                            {String(l.scope)} / {String(l.severity)}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-slate-500">{formatDateTimeFa(l.created_at as string)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* 9. ERROR REPORTS */}
        {tab === "errors" && (
          <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-3">
            {errorLogs.map((row, idx) => {
              const e = row.error as Record<string, unknown>;
              return (
                <div key={idx} className="rounded-xl border border-slate-200 p-4 flex flex-wrap items-center justify-between gap-3 text-xs">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[11px] font-bold text-rose-700">{String(e.error_code)}</span>
                      <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 text-[10px]">{String(e.source)}</span>
                      <span className="text-slate-400">{String(row.org_name || "کل سیستم")}</span>
                    </div>
                    <div className="text-slate-800 mt-1">{String(e.message)}</div>
                    <div className="text-[11px] text-slate-400 font-mono mt-0.5">{String(e.endpoint || "")}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="px-2.5 py-1 rounded-full text-[10px] font-semibold bg-amber-50 text-amber-800">
                      {String(e.status)}
                    </span>
                    {e.status !== "RESOLVED" && (
                      <button
                        type="button"
                        onClick={() => updateErrorStatus(String(e.id), "RESOLVED")}
                        className="rounded-lg bg-emerald-600 text-white px-3 py-1 text-[11px] cursor-pointer"
                      >
                        بستن خطا
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* SAAS CMS: ACADEMY TUTORIALS */}
        {tab === "academy" && <PlatformSaasAdmin mode="academy" onToast={onToast} />}

        {/* SAAS SMS GATEWAY: SMS.IR & KAVENEGAR */}
        {tab === "sms" && <PlatformSaasAdmin mode="sms" onToast={onToast} />}

        {/* SAAS CONTACT INQUIRIES */}
        {tab === "inquiries" && <PlatformSaasAdmin mode="inquiries" onToast={onToast} />}

        {/* 10. GENERAL SETTINGS + EMBEDDED SMS GATEWAY */}
        {tab === "settings" && (
          <div className="space-y-6">
            <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-3">
              <h3 className="text-sm font-bold text-slate-900 mb-2">تنظیمات عمومی هسته پلتفرم</h3>
              {settingsList.map((s) => (
                <div
                  key={String(s.id)}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-100 bg-slate-50/70 px-4 py-3 text-xs"
                >
                  <div>
                    <div className="font-semibold text-slate-900">{String(s.label_fa)}</div>
                    <div className="font-mono text-[11px] text-slate-400 mt-0.5">
                      {String(s.key)} • {String(s.category)}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      dir="ltr"
                      defaultValue={String(s.value)}
                      onBlur={async (e) => {
                        const val = e.target.value.trim();
                        if (val === String(s.value)) return;
                        try {
                          const parsed =
                            val === "true" ? true : val === "false" ? false : /^\d+$/.test(val) ? Number(val) : val;
                          await apiFetch("/api/v1/platform/settings", {
                            method: "PATCH",
                            body: JSON.stringify({ key: String(s.key), value: parsed }),
                          });
                          onToast(`تنظیم «${String(s.label_fa)}» ذخیره شد.`);
                          loadTab("settings");
                        } catch (err) {
                          onToast(err instanceof Error ? err.message : "خطا در ذخیره تنظیم", "error");
                        }
                      }}
                      className="font-mono text-xs font-semibold bg-white border border-slate-200 px-3 py-1 rounded-lg text-indigo-700 text-left w-56"
                    />
                  </div>
                </div>
              ))}
            </div>
            <PlatformSaasAdmin mode="sms" onToast={onToast} />
            <PlatformSaasAdmin mode="gateways" onToast={onToast} />
          </div>
        )}

        {/* 11. SUPPORT TICKETS */}
        {tab === "tickets" && (
          <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-3">
            {ticketsList.map((row, idx) => {
              const t = row.ticket as Record<string, unknown>;
              return (
                <div key={idx} className="rounded-xl border border-slate-200 p-4 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-bold text-slate-900">
                      <span className="font-mono text-indigo-600 ml-2">{String(t.ticket_number)}</span>
                      {String(t.subject)}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-100 text-slate-700">
                        اولویت: {String(t.priority)}
                      </span>
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-indigo-50 text-indigo-700">
                        {String(t.status)}
                      </span>
                    </div>
                  </div>
                  <p className="text-slate-600 mt-2">{String(t.description)}</p>
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400">
                    <span>
                      سازمان: {String(row.org_name || "—")} • کاربر: {String(row.user_full_name || "—")}
                    </span>
                    {t.status !== "RESOLVED" && (
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => updateTicketStatus(String(t.id), "IN_PROGRESS")}
                          className="rounded-lg border border-slate-200 px-3 py-1 text-slate-700 cursor-pointer"
                        >
                          در حال بررسی
                        </button>
                        <button
                          type="button"
                          onClick={() => updateTicketStatus(String(t.id), "RESOLVED")}
                          className="rounded-lg bg-emerald-600 text-white px-3 py-1 cursor-pointer"
                        >
                          علامت حل‌شده
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* 12. CONTRACTS & OPENAPI EXPLORER */}
        {tab === "contracts" && (
          <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-4">
            <div className="flex flex-wrap gap-2">
              {docsList.map((d) => (
                <button
                  key={d.key}
                  type="button"
                  onClick={() => setSelectedDocKey(d.key)}
                  className={`px-3 py-1.5 rounded-xl text-xs font-medium cursor-pointer ${
                    selectedDocKey === d.key
                      ? "bg-slate-900 text-white"
                      : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                  }`}
                >
                  {d.title_fa}
                </button>
              ))}
            </div>
            {docsList
              .filter((d) => d.key === selectedDocKey)
              .map((doc) => (
                <div key={doc.key} className="space-y-2">
                  <div className="flex items-center justify-between text-xs text-slate-500">
                    <span className="font-semibold text-slate-800">{doc.title_fa}</span>
                    <span dir="ltr" className="font-mono bg-slate-100 px-2.5 py-0.5 rounded-md">
                      {doc.path}
                    </span>
                  </div>
                  <pre
                    dir={doc.key === "openapi" ? "ltr" : "auto"}
                    className="rounded-xl bg-slate-950 text-slate-100 p-4 text-xs font-mono overflow-x-auto max-h-[560px] leading-relaxed whitespace-pre-wrap"
                  >
                    {doc.content}
                  </pre>
                </div>
              ))}
          </div>
        )}
      </section>
    </div>
  );
}

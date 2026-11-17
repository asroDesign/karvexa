export function formatIrr(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "۰";
  const num = typeof value === "number" ? value : Number(value);
  if (Number.isNaN(num)) return String(value);
  return new Intl.NumberFormat("fa-IR", {
    maximumFractionDigits: 2,
  }).format(num);
}

export function formatQty(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "۰";
  const num = typeof value === "number" ? value : Number(value);
  if (Number.isNaN(num)) return String(value);
  return new Intl.NumberFormat("fa-IR", {
    maximumFractionDigits: 4,
  }).format(num);
}

export function formatDateFa(value: string | Date | null | undefined): string {
  if (!value) return "—";
  try {
    const d = typeof value === "string" ? new Date(value) : value;
    if (Number.isNaN(d.getTime())) return String(value);
    return new Intl.DateTimeFormat("fa-IR", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  } catch {
    return String(value);
  }
}

export function formatDateTimeFa(value: string | Date | null | undefined): string {
  if (!value) return "—";
  try {
    const d = typeof value === "string" ? new Date(value) : value;
    if (Number.isNaN(d.getTime())) return String(value);
    return new Intl.DateTimeFormat("fa-IR", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(d);
  } catch {
    return String(value);
  }
}

export interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  meta?: {
    request_id?: string;
    timestamp?: string;
    pagination?: {
      page: number;
      per_page: number;
      total: number;
      last_page: number;
    };
    [key: string]: unknown;
  };
  error?: {
    code: string;
    message: string;
    details?: Array<{ field: string; code: string; message: string }>;
    request_id?: string;
  };
}

export async function apiFetch<T>(
  url: string,
  options?: RequestInit & { organizationId?: string | null }
): Promise<T> {
  const headers = new Headers(options?.headers);
  if (!headers.has("Content-Type") && options?.body) {
    headers.set("Content-Type", "application/json");
  }
  headers.set("X-Client-Version", "1.0.0");
  if (options?.organizationId) {
    headers.set("X-Organization-Id", options.organizationId);
  }

  const res = await fetch(url, {
    ...options,
    headers,
    credentials: "include",
  });

  const json = (await res.json().catch(() => ({}))) as ApiEnvelope<T>;
  if (!res.ok || !json.success) {
    const errMsg = json.error?.message || `خطا در ارتباط با سرور (${res.status})`;
    const errCode = json.error?.code || "REQUEST_FAILED";
    const err = new Error(errMsg) as Error & { code?: string; status?: number };
    err.code = errCode;
    err.status = res.status;
    throw err;
  }

  return json.data as T;
}

export interface SessionMeResponse {
  user: {
    id: string;
    email: string;
    mobile: string | null;
    full_name: string;
    is_platform_admin: boolean;
  };
  platform_permissions: string[];
  organizations: Array<{
    organization_id: string;
    name: string;
    legal_name: string | null;
    business_type: string;
    base_currency: string;
    status: string;
    is_owner: boolean;
    roles: Array<{ code: string; name: string }>;
  }>;
  active_organization: {
    organization_id: string;
    name: string;
    legal_name: string | null;
    business_type: string;
    base_currency: string;
    status: string;
    is_owner: boolean;
    roles: Array<{ code: string; name: string }>;
  } | null;
  organization_permissions: string[];
  subscription: {
    status: "ACTIVE" | "TRIAL" | "EXPIRED" | "NONE";
    plan_code: string;
    plan_name_fa: string;
    expires_at: string | null;
    entitlements: Record<string, { enabled: boolean; limit_value: number | null }>;
  } | null;
}

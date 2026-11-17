import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";

export interface ErrorDetailItem {
  field: string;
  code: string;
  message: string;
}

export class ApiError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly details?: ErrorDetailItem[];

  constructor(
    status: number,
    code: string,
    message: string,
    details?: ErrorDetailItem[]
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * Recursively converts object keys from camelCase to strict snake_case per Master Prompt 03 §2.
 * Preserves Date objects as ISO 8601 UTC strings and keeps Decimal Strings untouched.
 */
export function camelToSnakeKey(key: string): string {
  return key.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
}

export function toSnakeCase<T>(input: T): unknown {
  if (input === null || input === undefined) return input;
  if (typeof input === "bigint") return input.toString();
  if (input instanceof Date) return input.toISOString();
  if (Array.isArray(input)) return input.map((item) => toSnakeCase(item));
  if (typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[camelToSnakeKey(k)] = toSnakeCase(v);
    }
    return out;
  }
  return input;
}

export function newRequestId(): string {
  return crypto.randomUUID();
}

/**
 * Master Prompt 03 §3 — Standard Success Envelope
 * { success: true, data: {}, meta: { request_id, timestamp, ... } }
 */
export function ok<T>(
  data: T,
  status = 200,
  extraMeta?: Record<string, unknown>
) {
  const requestId = newRequestId();
  return NextResponse.json(
    {
      success: true,
      data: toSnakeCase(data),
      meta: {
        request_id: requestId,
        timestamp: new Date().toISOString(),
        ...(extraMeta ? (toSnakeCase(extraMeta) as Record<string, unknown>) : {}),
      },
    },
    {
      status,
      headers: { "X-Request-Id": requestId },
    }
  );
}

/**
 * Master Prompt 03 §3 — Standard Paginated List Envelope
 * { success: true, data: [], meta: { pagination: { page, per_page, total, last_page }, request_id, timestamp } }
 */
export function okList<T>(
  items: T[],
  pagination: { page: number; perPage: number; total: number },
  extraMeta?: Record<string, unknown>
) {
  const requestId = newRequestId();
  const lastPage = Math.max(1, Math.ceil(pagination.total / pagination.perPage));
  return NextResponse.json(
    {
      success: true,
      data: toSnakeCase(items),
      meta: {
        pagination: {
          page: pagination.page,
          per_page: pagination.perPage,
          total: pagination.total,
          last_page: lastPage,
        },
        request_id: requestId,
        timestamp: new Date().toISOString(),
        ...(extraMeta ? (toSnakeCase(extraMeta) as Record<string, unknown>) : {}),
      },
    },
    {
      status: 200,
      headers: { "X-Request-Id": requestId },
    }
  );
}

export function okNoContent() {
  return new NextResponse(null, {
    status: 204,
    headers: { "X-Request-Id": newRequestId() },
  });
}

/**
 * Master Prompt 03 §4 — Standard List & Search Query Parameters
 * Supports: page, per_page (max 100), search, sort_by, sort_direction,
 * created_from, created_to, updated_from, updated_to, status
 */
export interface ListQueryParams {
  page: number;
  perPage: number;
  search: string;
  sortBy: string;
  sortDirection: "asc" | "desc";
  createdFrom: string | null;
  createdTo: string | null;
  updatedFrom: string | null;
  updatedTo: string | null;
  status: string | null;
}

export function parseListQuery(req: NextRequest): ListQueryParams {
  const sp = req.nextUrl.searchParams;
  const rawPage = Number(sp.get("page") ?? 1);
  const rawPerPage = Number(sp.get("per_page") ?? 20);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;
  const perPage =
    Number.isFinite(rawPerPage) && rawPerPage >= 1
      ? Math.min(100, Math.floor(rawPerPage))
      : 20;

  return {
    page,
    perPage,
    search: (sp.get("search") ?? "").trim().toLowerCase(),
    sortBy: (sp.get("sort_by") ?? "created_at").trim(),
    sortDirection: sp.get("sort_direction") === "asc" ? "asc" : "desc",
    createdFrom: sp.get("created_from"),
    createdTo: sp.get("created_to"),
    updatedFrom: sp.get("updated_from"),
    updatedTo: sp.get("updated_to"),
    status: sp.get("status"),
  };
}

export function applyListFilterAndPaginate<T extends Record<string, unknown>>(
  rows: T[],
  query: ListQueryParams,
  searchFields: Array<keyof T> = []
) {
  let filtered = rows;

  if (query.status) {
    filtered = filtered.filter(
      (r) => String(r.status ?? "").toUpperCase() === query.status!.toUpperCase()
    );
  }

  if (query.search && searchFields.length > 0) {
    filtered = filtered.filter((r) =>
      searchFields.some((f) =>
        String(r[f] ?? "")
          .toLowerCase()
          .includes(query.search)
      )
    );
  }

  if (query.createdFrom) {
    const fromTs = Date.parse(query.createdFrom);
    if (!Number.isNaN(fromTs)) {
      filtered = filtered.filter((r) => {
        const v = r.createdAt ?? r.created_at;
        return v ? Date.parse(String(v)) >= fromTs : true;
      });
    }
  }
  if (query.createdTo) {
    const toTs = Date.parse(query.createdTo);
    if (!Number.isNaN(toTs)) {
      filtered = filtered.filter((r) => {
        const v = r.createdAt ?? r.created_at;
        return v ? Date.parse(String(v)) <= toTs : true;
      });
    }
  }

  const total = filtered.length;
  const offset = (query.page - 1) * query.perPage;
  const items = filtered.slice(offset, offset + query.perPage);
  return { items, total };
}

/**
 * Master Prompt 03 §21 — Client Version Compatibility Guard
 */
const MIN_SUPPORTED_MAJOR = 1;
export function checkClientVersion(req: NextRequest) {
  const clientVer = req.headers.get("x-client-version");
  if (!clientVer) return;
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(clientVer.trim());
  if (!match || Number(match[1]) < MIN_SUPPORTED_MAJOR) {
    throw new ApiError(
      400,
      "CLIENT_VERSION_INCOMPATIBLE",
      `نسخه کلاینت (${clientVer}) با نسخه v1 قرارداد API سازگار نیست. لطفاً اپلیکیشن را به‌روزرسانی کنید.`,
      [
        {
          field: "X-Client-Version",
          code: "INCOMPATIBLE_VERSION",
          message: `Minimum supported version is ${MIN_SUPPORTED_MAJOR}.0.0`,
        },
      ]
    );
  }
}

/**
 * Master Prompt 03 §3 — Standard Error Envelope
 * { success: false, error: { code, message, details: [...], request_id } }
 */
export function handleApiError(err: unknown) {
  const requestId = newRequestId();

  if (err instanceof ApiError) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: err.code,
          message: err.message,
          details: err.details ?? [],
          request_id: requestId,
        },
      },
      { status: err.status, headers: { "X-Request-Id": requestId } }
    );
  }

  if (err instanceof ZodError) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "خطا در اعتبارسنجی ورودی‌ها",
          details: err.issues.map((i) => ({
            field: i.path.map(String).map(camelToSnakeKey).join(".") || "body",
            code: i.code.toUpperCase(),
            message: i.message,
          })),
          request_id: requestId,
        },
      },
      { status: 422, headers: { "X-Request-Id": requestId } }
    );
  }

  const pgCode =
    typeof err === "object" && err !== null && "code" in err
      ? String((err as { code?: unknown }).code)
      : undefined;
  const causeCode =
    typeof err === "object" &&
    err !== null &&
    "cause" in err &&
    typeof (err as { cause?: { code?: unknown } }).cause === "object" &&
    (err as { cause?: { code?: unknown } }).cause !== null
      ? String((err as { cause: { code?: unknown } }).cause.code)
      : undefined;

  if (pgCode === "23505" || causeCode === "23505") {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "DUPLICATE_RESOURCE",
          message: "مقدار وارد شده تکراری است و قبلاً ثبت شده است.",
          details: [],
          request_id: requestId,
        },
      },
      { status: 409, headers: { "X-Request-Id": requestId } }
    );
  }

  if (pgCode === "22P02" || causeCode === "22P02") {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "INVALID_IDENTIFIER",
          message: "فرمت شناسه UUID ارسال‌شده نامعتبر است.",
          details: [{ field: "id", code: "INVALID_UUID", message: "Invalid UUID format" }],
          request_id: requestId,
        },
      },
      { status: 400, headers: { "X-Request-Id": requestId } }
    );
  }

  console.error("[API_UNHANDLED_ERROR]", requestId, err);
  return NextResponse.json(
    {
      success: false,
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "خطای داخلی سرور رخ داد.",
        details: [],
        request_id: requestId,
      },
    },
    { status: 500, headers: { "X-Request-Id": requestId } }
  );
}

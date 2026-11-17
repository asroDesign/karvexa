import { NextRequest } from "next/server";
import { ApiError, handleApiError } from "@/lib/errors";
import { handleAuthRoutes, handleDeviceRoutes } from "@/modules/auth/controller";
import { handleOrganizationRoutes, handleRbacRoutes } from "@/modules/organizations/controller";
import { handleCatalogRoutes, handleContactRoutes } from "@/modules/contacts/controller";
import { handleWarehouseAndInventoryRoutes } from "@/modules/inventory/controller";
import { handleCommerceRoutes } from "@/modules/commerce/controller";
import { handleChequeRoutes, handleTreasuryRoutes } from "@/modules/treasury/controller";
import {
  handleAccountingRoutes,
  handleExportRoute,
  handleReportRoutes,
} from "@/modules/accounting/controller";
import {
  handleFileRoutes,
  handlePaymentCallbackRoutes,
  handleSubscriptionRoutes,
  handleSyncRoutes,
} from "@/modules/subscription/controller";
import { handleOperatingModeRoutes } from "@/modules/offline-mode/controller";
import { handlePersonalFinanceRoutes } from "@/modules/personal-finance/controller";
import {
  handleQuickFinanceRoutes,
  handleQuotationsCrmEmployeesRoutes,
  handleVariantsAndReplenishmentRoutes,
} from "@/modules/advanced/controller";
import { handleDashboardRoutes } from "@/modules/dashboard/controller";
import { handleAccessManagementRoutes } from "@/modules/access/controller";
import { handleFiscalRoutes } from "@/modules/fiscal/controller";
import { handlePublicSaasRoutes } from "@/modules/saas/controller";

export const dynamic = "force-dynamic";

function extractSegments(req: NextRequest): string[] {
  const fromQuery = req.nextUrl.searchParams.get("__v1_path");
  if (fromQuery) {
    return fromQuery
      .split("/")
      .map((s) => decodeURIComponent(s).trim())
      .filter(Boolean);
  }
  const pathname = req.nextUrl.pathname;
  const stripped = pathname.replace(/^\/api\/v1\/?/, "");
  return stripped.split("/").filter(Boolean);
}

async function dispatch(req: NextRequest, method: string) {
  try {
    const segments = extractSegments(req);
    const root = segments[0] ?? "";

    switch (root) {
      case "auth":
        return await handleAuthRoutes(req, method, segments);
      case "devices":
        return await handleDeviceRoutes(req, method, segments);
      case "organizations":
        return await handleOrganizationRoutes(req, method, segments);
      case "roles":
      case "permissions":
      case "users":
        return await handleRbacRoutes(req, method, segments);
      case "contacts":
      case "contact-groups":
        return await handleContactRoutes(req, method, segments);
      case "products":
      case "categories":
      case "brands":
      case "units":
        return await handleCatalogRoutes(req, method, segments);
      case "warehouses":
      case "inventory":
      case "suppliers":
        return await handleWarehouseAndInventoryRoutes(req, method, segments);
      case "purchases":
      case "purchase-returns":
      case "sales":
      case "sales-returns":
      case "consignments":
        return await handleCommerceRoutes(req, method, segments);
      case "treasury":
        return await handleTreasuryRoutes(req, method, segments);
      case "cheques":
        return await handleChequeRoutes(req, method, segments);
      case "accounting":
        return await handleAccountingRoutes(req, method, segments);
      case "reports":
        return await handleReportRoutes(req, method, segments);
      case "export":
        return await handleExportRoute(req);
      case "subscription":
      case "subscriptions":
        return await handleSubscriptionRoutes(req, method, segments);
      case "files":
        return await handleFileRoutes(req, method, segments);
      case "sync":
        return await handleSyncRoutes(req, method, segments);
      case "personal":
      case "personal-finance":
        return await handlePersonalFinanceRoutes(req, method, segments);
      case "accounting-categories":
      case "quick-transactions":
      case "quick-cashflows":
        return await handleQuickFinanceRoutes(req, method, segments);
      case "variants":
      case "opening-stock":
      case "replenishment":
      case "purchase-orders":
        return await handleVariantsAndReplenishmentRoutes(req, method, segments);
      case "quotations":
      case "crm":
      case "employees":
      case "documents":
        return await handleQuotationsCrmEmployeesRoutes(req, method, segments);
      case "dashboard":
        return await handleDashboardRoutes(req, method, segments);
      case "access":
        return await handleAccessManagementRoutes(req, method, segments);
      case "fiscal":
        return await handleFiscalRoutes(req, method, segments);
      case "public":
        return await handlePublicSaasRoutes(req, method, segments);
      case "settings":
        return await handleOperatingModeRoutes(req, method, segments);
      case "payments":
        return await handlePaymentCallbackRoutes(req, method, segments);
      default:
        throw new ApiError(
          404,
          "ROUTE_NOT_FOUND",
          `مسیر API /api/v1/${segments.join("/")} در قرارداد نسخه v1 تعریف نشده است.`
        );
    }
  } catch (err) {
    return handleApiError(err);
  }
}

export async function GET(req: NextRequest) {
  return dispatch(req, "GET");
}

export async function POST(req: NextRequest) {
  return dispatch(req, "POST");
}

export async function PUT(req: NextRequest) {
  return dispatch(req, "PUT");
}

export async function PATCH(req: NextRequest) {
  return dispatch(req, "PATCH");
}

export async function DELETE(req: NextRequest) {
  return dispatch(req, "DELETE");
}

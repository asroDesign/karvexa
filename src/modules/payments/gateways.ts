import crypto from "crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  entitlements,
  features,
  notifications,
  organizations,
  paymentGatewaySettings,
  paymentOrders,
  paymentTransactions,
  planFeatures,
  plans,
  subscriptions,
} from "@/db/schema";
import { ensureSaasSeeded } from "@/db/seed-saas";
import { recordAuditLog } from "@/lib/audit";
import { ApiError } from "@/lib/errors";
import { resolveOrganizationEntitlements, withTenantTransaction } from "@/lib/tenant";

export type PaymentGatewayCode = "ZARINPAL" | "ZIBAL" | "BALLEH_PAY" | "SAMAN";

const ENTITLEMENT_SIGNING_SECRET =
  process.env.ENTITLEMENT_SIGNING_SECRET ||
  process.env.JWT_SECRET ||
  "karvexa-business-os-entitlement-hmac-secret-2026";

export interface GatewayInitResult {
  authority: string;
  paymentUrl: string;
  raw: Record<string, unknown>;
}

export interface GatewayVerifyResult {
  verified: boolean;
  refId: string | null;
  statusCode: string;
  raw: Record<string, unknown>;
}

export interface PaymentGatewayAdapter {
  readonly code: PaymentGatewayCode;
  requestPayment(params: {
    config: typeof paymentGatewaySettings.$inferSelect;
    amountIrr: number;
    paymentReference: string;
    description: string;
    callbackUrl: string;
    mobile?: string | null;
    email?: string | null;
  }): Promise<GatewayInitResult>;
  verifyPayment(params: {
    config: typeof paymentGatewaySettings.$inferSelect;
    order: typeof paymentOrders.$inferSelect;
    callbackParams: Record<string, string>;
  }): Promise<GatewayVerifyResult>;
  retrieveStatus?(params: {
    config: typeof paymentGatewaySettings.$inferSelect;
    order: typeof paymentOrders.$inferSelect;
  }): Promise<{ status: string; refId: string | null }>;
}

// ============================================================================
// 1. ZARINPAL ADAPTER (Official v4 REST API)
//    Request: POST https://api.zarinpal.com/pg/v4/payment/request.json
//    Verify:  POST https://api.zarinpal.com/pg/v4/payment/verify.json
// ============================================================================
const zarinpalAdapter: PaymentGatewayAdapter = {
  code: "ZARINPAL",
  async requestPayment({ config, amountIrr, paymentReference, description, callbackUrl, mobile, email }) {
    if (config.sandboxMode || !config.merchantId.trim()) {
      const authority = `A00000000000000000000000000${Date.now().toString().slice(-9)}`;
      return {
        authority,
        paymentUrl: `${callbackUrl}?Authority=${encodeURIComponent(authority)}&Status=OK&sandbox=1&ref=${encodeURIComponent(paymentReference)}`,
        raw: { mode: "SANDBOX", gateway: "ZARINPAL", authority },
      };
    }

    const extra = (config.extraConfig ?? {}) as Record<string, string>;
    const reqUrl = extra.request_url || "https://api.zarinpal.com/pg/v4/payment/request.json";
    const startPay = extra.start_pay_url || "https://www.zarinpal.com/pg/StartPay/";

    const res = await fetch(reqUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        merchant_id: config.merchantId.trim(),
        amount: Math.round(amountIrr),
        currency: "IRR",
        description,
        callback_url: callbackUrl,
        metadata: { order_id: paymentReference, ...(mobile ? { mobile } : {}), ...(email ? { email } : {}) },
      }),
    });
    const json = (await res.json().catch(() => ({}))) as {
      data?: { code?: number; authority?: string };
      errors?: unknown;
    };
    if (!res.ok || json.data?.code !== 100 || !json.data.authority) {
      throw new ApiError(502, "ZARINPAL_REQUEST_FAILED", "ایجاد درخواست پرداخت در درگاه زرین‌پال ناموفق بود.");
    }
    return {
      authority: json.data.authority,
      paymentUrl: `${startPay}${json.data.authority}`,
      raw: json as Record<string, unknown>,
    };
  },

  async verifyPayment({ config, order, callbackParams }) {
    const statusParam = callbackParams.Status || callbackParams.status || "";
    const authority = callbackParams.Authority || callbackParams.authority || order.gatewayAuthority || "";
    if (statusParam && statusParam.toUpperCase() !== "OK") {
      return { verified: false, refId: null, statusCode: "CANCELLED_BY_USER", raw: callbackParams };
    }
    if (config.sandboxMode || !config.merchantId.trim()) {
      const ok = authority === order.gatewayAuthority && statusParam.toUpperCase() === "OK";
      return {
        verified: ok,
        refId: ok ? `ZP-REF-${Date.now().toString().slice(-7)}` : null,
        statusCode: ok ? "100" : "INVALID_AUTHORITY",
        raw: { mode: "SANDBOX", authority, status: statusParam },
      };
    }

    const extra = (config.extraConfig ?? {}) as Record<string, string>;
    const verifyUrl = extra.verify_url || "https://api.zarinpal.com/pg/v4/payment/verify.json";
    const res = await fetch(verifyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        merchant_id: config.merchantId.trim(),
        amount: Math.round(Number(order.amountIrr)),
        authority,
      }),
    });
    const json = (await res.json().catch(() => ({}))) as { data?: { code?: number; ref_id?: number | string } };
    const verified = res.ok && (json.data?.code === 100 || json.data?.code === 101);
    return {
      verified,
      refId: verified ? String(json.data?.ref_id ?? "") : null,
      statusCode: String(json.data?.code ?? res.status),
      raw: json as Record<string, unknown>,
    };
  },
};

// ============================================================================
// 2. ZIBAL ADAPTER (Official v1 REST API)
//    Request: POST https://gateway.zibal.ir/v1/request
//    Verify:  POST https://gateway.zibal.ir/v1/verify
// ============================================================================
const zibalAdapter: PaymentGatewayAdapter = {
  code: "ZIBAL",
  async requestPayment({ config, amountIrr, paymentReference, description, callbackUrl, mobile }) {
    if (config.sandboxMode || !config.merchantId.trim()) {
      const trackId = `${Date.now().toString().slice(-10)}`;
      return {
        authority: trackId,
        paymentUrl: `${callbackUrl}?trackId=${encodeURIComponent(trackId)}&success=1&status=2&orderId=${encodeURIComponent(paymentReference)}&sandbox=1`,
        raw: { mode: "SANDBOX", gateway: "ZIBAL", trackId },
      };
    }

    const extra = (config.extraConfig ?? {}) as Record<string, string>;
    const reqUrl = extra.request_url || "https://gateway.zibal.ir/v1/request";
    const startPay = extra.start_pay_url || "https://gateway.zibal.ir/start/";

    const res = await fetch(reqUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        merchant: config.merchantId.trim(),
        amount: Math.round(amountIrr),
        callbackUrl,
        description,
        orderId: paymentReference,
        ...(mobile ? { mobile } : {}),
      }),
    });
    const json = (await res.json().catch(() => ({}))) as { result?: number; trackId?: number | string };
    if (!res.ok || json.result !== 100 || !json.trackId) {
      throw new ApiError(502, "ZIBAL_REQUEST_FAILED", "ایجاد درخواست پرداخت در درگاه زیبال ناموفق بود.");
    }
    return {
      authority: String(json.trackId),
      paymentUrl: `${startPay}${json.trackId}`,
      raw: json as Record<string, unknown>,
    };
  },

  async verifyPayment({ config, order, callbackParams }) {
    const success = callbackParams.success;
    const trackId = callbackParams.trackId || order.gatewayAuthority || "";
    if (success !== undefined && success !== "1") {
      return { verified: false, refId: null, statusCode: "CANCELLED_BY_USER", raw: callbackParams };
    }
    if (config.sandboxMode || !config.merchantId.trim()) {
      const ok = trackId === order.gatewayAuthority && success === "1";
      return {
        verified: ok,
        refId: ok ? `ZB-REF-${Date.now().toString().slice(-7)}` : null,
        statusCode: ok ? "100" : "INVALID_TRACK_ID",
        raw: { mode: "SANDBOX", trackId, success },
      };
    }

    const extra = (config.extraConfig ?? {}) as Record<string, string>;
    const verifyUrl = extra.verify_url || "https://gateway.zibal.ir/v1/verify";
    const res = await fetch(verifyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ merchant: config.merchantId.trim(), trackId: Number(trackId) || trackId }),
    });
    const json = (await res.json().catch(() => ({}))) as { result?: number; refNumber?: number | string; amount?: number };
    const verified =
      res.ok &&
      (json.result === 100 || json.result === 201) &&
      (!json.amount || Math.round(json.amount) === Math.round(Number(order.amountIrr)));
    return {
      verified,
      refId: verified ? String(json.refNumber ?? trackId) : null,
      statusCode: String(json.result ?? res.status),
      raw: json as Record<string, unknown>,
    };
  },
};

// ============================================================================
// 3. BALLEH PAY ADAPTER (Bale Wallet / Bot API)
//    Base: https://tapi.bale.ai/bot{secretToken}/... (inquireTransaction)
// ============================================================================
const ballehPayAdapter: PaymentGatewayAdapter = {
  code: "BALLEH_PAY",
  async requestPayment({ config, amountIrr, paymentReference, callbackUrl }) {
    if (config.sandboxMode || !config.secretToken.trim() || !config.merchantId.trim()) {
      const txId = `BALE-${Date.now().toString().slice(-8)}`;
      return {
        authority: txId,
        paymentUrl: `${callbackUrl}?transaction_id=${encodeURIComponent(txId)}&status=PAID&ref=${encodeURIComponent(paymentReference)}&sandbox=1`,
        raw: { mode: "SANDBOX", gateway: "BALLEH_PAY", transaction_id: txId, amount_irr: amountIrr },
      };
    }

    // Live Bale Pay deep checkout link / invoice token handoff
    const txId = `BALE-${paymentReference}`;
    const extra = (config.extraConfig ?? {}) as Record<string, string>;
    const payBase = extra.checkout_base_url || "https://ble.ir/pay";
    return {
      authority: txId,
      paymentUrl: `${payBase}?provider_token=${encodeURIComponent(config.merchantId)}&payload=${encodeURIComponent(paymentReference)}&amount=${Math.round(amountIrr)}&callback=${encodeURIComponent(callbackUrl)}`,
      raw: { gateway: "BALLEH_PAY", transaction_id: txId },
    };
  },

  async verifyPayment({ config, order, callbackParams }) {
    const txId = callbackParams.transaction_id || order.gatewayAuthority || "";
    const statusParam = (callbackParams.status || "").toUpperCase();
    if (statusParam && statusParam !== "PAID" && statusParam !== "OK" && statusParam !== "SUCCEED") {
      return { verified: false, refId: null, statusCode: statusParam, raw: callbackParams };
    }
    if (config.sandboxMode || !config.secretToken.trim()) {
      const ok = txId === order.gatewayAuthority && (statusParam === "PAID" || statusParam === "OK");
      return {
        verified: ok,
        refId: ok ? `BL-REF-${Date.now().toString().slice(-7)}` : null,
        statusCode: ok ? "PAID" : "INVALID_TX",
        raw: { mode: "SANDBOX", transaction_id: txId, status: statusParam },
      };
    }

    const extra = (config.extraConfig ?? {}) as Record<string, string>;
    const baseUrl = (extra.api_base_url || "https://tapi.bale.ai").replace(/\/$/, "");
    const res = await fetch(`${baseUrl}/bot${encodeURIComponent(config.secretToken.trim())}/inquireTransaction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transaction_id: txId }),
    });
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: { status?: string; id?: string; amount?: number };
    };
    const verified =
      res.ok &&
      json.ok === true &&
      json.result?.status === "succeed" &&
      (!json.result.amount || Math.round(json.result.amount) === Math.round(Number(order.amountIrr)));
    return {
      verified,
      refId: verified ? String(json.result?.id ?? txId) : null,
      statusCode: String(json.result?.status ?? res.status),
      raw: json as Record<string, unknown>,
    };
  },
};

// ============================================================================
// 4. SAMAN (SEP / Shaparak) ADAPTER
//    Token:  POST https://sep.shaparak.ir/onlinepg/onlinepg
//    Verify: POST https://sep.shaparak.ir/verifyTxnRandomSessionkey/ipg/VerifyTransaction
// ============================================================================
const samanAdapter: PaymentGatewayAdapter = {
  code: "SAMAN",
  async requestPayment({ config, amountIrr, paymentReference, callbackUrl, mobile }) {
    if (config.sandboxMode || !config.merchantId.trim()) {
      const token = `SEP-TKN-${Date.now().toString().slice(-8)}`;
      return {
        authority: token,
        paymentUrl: `${callbackUrl}?State=OK&Status=2&RefNum=${encodeURIComponent(token)}&ResNum=${encodeURIComponent(paymentReference)}&sandbox=1`,
        raw: { mode: "SANDBOX", gateway: "SAMAN", token },
      };
    }

    const extra = (config.extraConfig ?? {}) as Record<string, string>;
    const tokenUrl = extra.token_url || "https://sep.shaparak.ir/onlinepg/onlinepg";
    const sendTokenUrl = extra.send_token_url || "https://sep.shaparak.ir/OnlinePG/SendToken";

    const res = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "token",
        TerminalId: config.merchantId.trim(),
        Amount: Math.round(amountIrr),
        ResNum: paymentReference,
        RedirectUrl: callbackUrl,
        ...(mobile ? { CellNumber: mobile } : {}),
      }),
    });
    const json = (await res.json().catch(() => ({}))) as { status?: number; token?: string };
    if (!res.ok || json.status !== 1 || !json.token) {
      throw new ApiError(502, "SAMAN_TOKEN_FAILED", "دریافت توکن از درگاه پرداخت سامان (SEP) ناموفق بود.");
    }
    return {
      authority: json.token,
      paymentUrl: `${sendTokenUrl}?token=${encodeURIComponent(json.token)}`,
      raw: json as Record<string, unknown>,
    };
  },

  async verifyPayment({ config, order, callbackParams }) {
    const state = callbackParams.State || "";
    const refNum = callbackParams.RefNum || order.gatewayAuthority || "";
    if (state && state.toUpperCase() !== "OK") {
      return { verified: false, refId: null, statusCode: state, raw: callbackParams };
    }
    if (config.sandboxMode || !config.merchantId.trim()) {
      const ok = refNum === order.gatewayAuthority && state.toUpperCase() === "OK";
      return {
        verified: ok,
        refId: ok ? `SEP-REF-${Date.now().toString().slice(-7)}` : null,
        statusCode: ok ? "0" : "INVALID_REFNUM",
        raw: { mode: "SANDBOX", RefNum: refNum, State: state },
      };
    }

    const extra = (config.extraConfig ?? {}) as Record<string, string>;
    const verifyUrl =
      extra.verify_url || "https://sep.shaparak.ir/verifyTxnRandomSessionkey/ipg/VerifyTransaction";
    const res = await fetch(verifyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        RefNum: refNum,
        TerminalNumber: Number(config.merchantId.trim()) || config.merchantId.trim(),
      }),
    });
    const json = (await res.json().catch(() => ({}))) as {
      Success?: boolean;
      ResultCode?: number;
      TransactionDetail?: { AffectiveAmount?: number; RRN?: string };
    };
    const verified =
      res.ok &&
      json.Success === true &&
      json.ResultCode === 0 &&
      (!json.TransactionDetail?.AffectiveAmount ||
        Math.round(json.TransactionDetail.AffectiveAmount) === Math.round(Number(order.amountIrr)));

    return {
      verified,
      refId: verified ? String(json.TransactionDetail?.RRN ?? refNum) : null,
      statusCode: String(json.ResultCode ?? res.status),
      raw: json as Record<string, unknown>,
    };
  },
};

const GATEWAY_ADAPTERS: Record<PaymentGatewayCode, PaymentGatewayAdapter> = {
  ZARINPAL: zarinpalAdapter,
  ZIBAL: zibalAdapter,
  BALLEH_PAY: ballehPayAdapter,
  SAMAN: samanAdapter,
};

// ============================================================================
// VERSIONED & SIGNED ENTITLEMENT SNAPSHOT (Prompt 08 §2.13 + Prompt 09A §11)
// ============================================================================
export async function buildSignedEntitlementSnapshot(organizationId: string) {
  const [[org], subState] = await Promise.all([
    db.select().from(organizations).where(eq(organizations.id, organizationId)).limit(1),
    resolveOrganizationEntitlements(organizationId),
  ]);

  const entitlementVersion = org?.entitlementVersion ?? 1;
  const serverTime = new Date().toISOString();

  const enabledFeatures: string[] = [];
  const featureLimits: Record<string, number | null> = {};
  for (const [code, ent] of Object.entries(subState.entitlements)) {
    if (ent.enabled) enabledFeatures.push(code);
    featureLimits[code] = ent.limitValue;
  }

  const payload = {
    contract_version: "2.0",
    subscription_id: subState.subscription?.id ?? null,
    plan_id: subState.plan?.id ?? null,
    plan_code: subState.planCode,
    plan_name: subState.plan?.nameFa ?? "پلن رایگان پایه",
    plan_name_fa: subState.plan?.nameFa ?? "پلن رایگان پایه",
    status: subState.subscriptionStatus,
    subscription_status: subState.subscriptionStatus,
    activated_at: subState.subscription?.startsAt?.toISOString() ?? null,
    expires_at: subState.subscription?.expiresAt?.toISOString() ?? null,
    entitlement_version: entitlementVersion,
    organization_id: organizationId,
    operating_mode: org?.operatingMode ?? "CLOUD_SYNC",
    enabled_features: enabledFeatures,
    feature_limits: featureLimits,
    features: subState.entitlements,
    server_time: serverTime,
    issued_at: serverTime,
  };

  const signature = crypto
    .createHmac("sha256", ENTITLEMENT_SIGNING_SECRET)
    .update(JSON.stringify(payload))
    .digest("hex");

  return {
    ...payload,
    signature,
  };
}

// ============================================================================
// INITIATE PLAN UPGRADE ORDER (§2.14)
// ============================================================================
export async function initiateSubscriptionUpgrade(params: {
  organizationId: string;
  userId: string;
  userEmail: string;
  ipAddress?: string | null;
  planCode: string;
  gateway?: PaymentGatewayCode;
  returnDeepLink?: string;
  originUrl: string;
  idempotencyKey?: string | null;
}) {
  await ensureSaasSeeded();

  const [plan] = await db
    .select()
    .from(plans)
    .where(and(eq(plans.code, params.planCode.toUpperCase()), eq(plans.isActive, true)))
    .limit(1);
  if (!plan) {
    throw new ApiError(404, "PLAN_NOT_FOUND", `پلن اشتراک «${params.planCode}» یافت نشد.`);
  }
  const amountIrr = Number(plan.priceIrr);
  if (amountIrr <= 0) {
    throw new ApiError(422, "FREE_PLAN_NO_PAYMENT", "پلن رایگان نیازی به درگاه پرداخت ندارد.");
  }

  // Resolve configured & active payment gateway ordered by priority ASC (Prompt 09A §12)
  const allGateways = (await db.select().from(paymentGatewaySettings)).sort(
    (a, b) => a.priority - b.priority
  );
  const chosenGw = params.gateway
    ? allGateways.find((g) => g.gateway === params.gateway)
    : allGateways.find((g) => g.isDefault && g.isActive) ?? allGateways.find((g) => g.isActive);

  if (!chosenGw || !chosenGw.isActive) {
    throw new ApiError(
      422,
      "PAYMENT_GATEWAY_INACTIVE",
      `درگاه پرداخت انتخاب‌شده (${params.gateway ?? "پیش‌فرض"}) فعال یا پیکربندی نشده است.`
    );
  }

  const adapter = GATEWAY_ADAPTERS[chosenGw.gateway as PaymentGatewayCode];
  if (!adapter) {
    throw new ApiError(422, "PAYMENT_GATEWAY_UNSUPPORTED", `درگاه ${chosenGw.gateway} پشتیبانی نمی‌شود.`);
  }

  const paymentReference = `KRV-${Date.now().toString().slice(-8)}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
  const baseCallback = chosenGw.callbackBaseUrl.trim() || params.originUrl.replace(/\/$/, "");
  const callbackUrl = `${baseCallback}/api/v1/payments/callback/${chosenGw.gateway.toLowerCase()}`;

  const initRes = await adapter.requestPayment({
    config: chosenGw,
    amountIrr,
    paymentReference,
    description: `ارتقا اشتراک Business OS به ${plan.nameFa}`,
    callbackUrl,
    email: params.userEmail,
  });

  const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
  const [order] = await db
    .insert(paymentOrders)
    .values({
      organizationId: params.organizationId,
      userId: params.userId,
      planId: plan.id,
      gateway: chosenGw.gateway,
      paymentReference,
      gatewayAuthority: initRes.authority,
      amountIrr: plan.priceIrr,
      currency: "IRR",
      paymentUrl: initRes.paymentUrl,
      returnDeepLink: params.returnDeepLink || "karvexa://payment/result",
      status: "PENDING",
      idempotencyKey: params.idempotencyKey ?? null,
      expiresAt,
    })
    .returning();

  await recordAuditLog({
    organizationId: params.organizationId,
    actorUserId: params.userId,
    actorEmail: params.userEmail,
    scope: "ORGANIZATION",
    action: "SUBSCRIPTION_UPGRADE_ORDER_CREATED",
    entityType: "PAYMENT_ORDER",
    entityId: order.id,
    ipAddress: params.ipAddress,
    metadata: {
      planCode: plan.code,
      gateway: chosenGw.gateway,
      paymentReference,
      amountIrr: plan.priceIrr,
    },
  });

  return {
    order_id: order.id,
    payment_reference: order.paymentReference,
    gateway: order.gateway,
    gateway_authority: order.gatewayAuthority,
    amount_irr: order.amountIrr,
    payment_url: order.paymentUrl,
    return_deep_link: order.returnDeepLink,
    status: order.status,
    expires_at: order.expiresAt,
  };
}

// ============================================================================
// SERVER-SIDE GATEWAY CALLBACK VERIFICATION & ENTITLEMENT ACTIVATION (§2.14–2.15)
// Strictly idempotent — duplicate callbacks NEVER double-extend subscriptions!
// ============================================================================
export async function processPaymentGatewayCallback(params: {
  gatewayParam: string;
  callbackParams: Record<string, string>;
  ipAddress?: string | null;
}) {
  await ensureSaasSeeded();
  const gatewayCode = params.gatewayParam.toUpperCase() as PaymentGatewayCode;
  const adapter = GATEWAY_ADAPTERS[gatewayCode];
  if (!adapter) {
    throw new ApiError(404, "PAYMENT_GATEWAY_NOT_FOUND", `درگاه ${params.gatewayParam} یافت نشد.`);
  }

  const [gwConfig] = await db
    .select()
    .from(paymentGatewaySettings)
    .where(eq(paymentGatewaySettings.gateway, gatewayCode))
    .limit(1);
  if (!gwConfig) {
    throw new ApiError(404, "PAYMENT_GATEWAY_NOT_CONFIGURED", "پیکربندی درگاه یافت نشد.");
  }

  // Locate payment order by reference or gateway authority
  const candidateRef =
    params.callbackParams.ref ||
    params.callbackParams.orderId ||
    params.callbackParams.ResNum ||
    params.callbackParams.payment_reference ||
    "";
  const candidateAuth =
    params.callbackParams.Authority ||
    params.callbackParams.authority ||
    params.callbackParams.trackId ||
    params.callbackParams.transaction_id ||
    params.callbackParams.RefNum ||
    "";

  let order = null;
  if (candidateRef) {
    [order] = await db
      .select()
      .from(paymentOrders)
      .where(eq(paymentOrders.paymentReference, candidateRef))
      .limit(1);
  }
  if (!order && candidateAuth) {
    [order] = await db
      .select()
      .from(paymentOrders)
      .where(and(eq(paymentOrders.gateway, gatewayCode), eq(paymentOrders.gatewayAuthority, candidateAuth)))
      .limit(1);
  }
  if (!order) {
    throw new ApiError(404, "PAYMENT_ORDER_NOT_FOUND", "سفارش پرداخت متناظر با این بازگشت درگاه یافت نشد.");
  }

  // Duplicate Callback Protection (Idempotent!)
  if (order.status === "VERIFIED") {
    const snapshot = await buildSignedEntitlementSnapshot(order.organizationId);
    return {
      verified: true,
      already_verified: true,
      order,
      entitlements: snapshot,
      // Prompt 09A §13: Safe opaque reference ONLY — never trust client success flags!
      deep_link_url: `${order.returnDeepLink}?reference=${encodeURIComponent(order.paymentReference)}`,
    };
  }

  // Expired Payment Session Protection (Prompt 09A §12)
  if (order.expiresAt.getTime() <= Date.now()) {
    await db
      .update(paymentOrders)
      .set({ status: "EXPIRED", updatedAt: new Date() })
      .where(eq(paymentOrders.id, order.id));
    throw new ApiError(410, "PAYMENT_SESSION_EXPIRED", "مهلت زمانی این نشست پرداخت به پایان رسیده است.");
  }

  // Official Server-Side Verification via Gateway Adapter
  const verifyRes = await adapter.verifyPayment({
    config: gwConfig,
    order,
    callbackParams: params.callbackParams,
  });

  if (!verifyRes.verified) {
    const failStatus = verifyRes.statusCode === "CANCELLED_BY_USER" ? "CANCELLED" : "FAILED";
    const [failedOrder] = await db
      .update(paymentOrders)
      .set({
        status: failStatus,
        callbackPayload: verifyRes.raw,
        updatedAt: new Date(),
      })
      .where(eq(paymentOrders.id, order.id))
      .returning();

    await recordAuditLog({
      organizationId: order.organizationId,
      actorUserId: order.userId,
      scope: "SECURITY",
      action: "PAYMENT_CALLBACK_VERIFICATION_FAILED",
      entityType: "PAYMENT_ORDER",
      entityId: order.id,
      ipAddress: params.ipAddress,
      severity: "WARN",
      metadata: { gateway: gatewayCode, statusCode: verifyRes.statusCode },
    });

    return {
      verified: false,
      already_verified: false,
      order: failedOrder,
      entitlements: null,
      deep_link_url: `${order.returnDeepLink}?reference=${encodeURIComponent(order.paymentReference)}`,
    };
  }

  // Atomic Activation: PaymentTransaction + Subscription + Entitlements + Increment entitlement_version + Notification!
  const activated = await withTenantTransaction(order.organizationId, async (tx) => {
    const [plan] = await tx.select().from(plans).where(eq(plans.id, order.planId)).limit(1);
    if (!plan) throw new ApiError(404, "PLAN_NOT_FOUND", "پلن اشتراک یافت نشد.");

    const now = new Date();
    const [currentSub] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.organizationId, order.organizationId))
      .orderBy(desc(subscriptions.expiresAt))
      .limit(1);

    const baseStart =
      currentSub && currentSub.expiresAt.getTime() > now.getTime() ? currentSub.expiresAt : now;
    const newExpiresAt = new Date(baseStart.getTime() + plan.billingDays * 86400 * 1000);

    const [sub] = await tx
      .insert(subscriptions)
      .values({
        organizationId: order.organizationId,
        planId: plan.id,
        status: "ACTIVE",
        startsAt: now,
        expiresAt: newExpiresAt,
        autoRenew: false,
        source: gatewayCode,
      })
      .returning();

    const [payTx] = await tx
      .insert(paymentTransactions)
      .values({
        organizationId: order.organizationId,
        subscriptionId: sub.id,
        planId: plan.id,
        provider: gatewayCode,
        amountIrr: order.amountIrr,
        currency: order.currency,
        status: "VERIFIED",
        idempotencyKey: order.paymentReference,
        externalRef: verifyRes.refId ?? order.gatewayAuthority,
        paidAt: now,
      })
      .returning();

    // Update Org Entitlements from Plan Features
    const pFeats = await tx
      .select({
        code: features.code,
        enabled: planFeatures.enabled,
        limitValue: planFeatures.limitValue,
      })
      .from(planFeatures)
      .innerJoin(features, eq(planFeatures.featureId, features.id))
      .where(eq(planFeatures.planId, plan.id));

    for (const pf of pFeats) {
      await tx
        .insert(entitlements)
        .values({
          organizationId: order.organizationId,
          featureCode: pf.code,
          enabled: pf.enabled,
          limitValue: pf.limitValue,
          source: "PLAN",
        })
        .onConflictDoUpdate({
          target: [entitlements.organizationId, entitlements.featureCode],
          set: { enabled: pf.enabled, limitValue: pf.limitValue, source: "PLAN", updatedAt: now },
        });
    }

    // Increment authoritative entitlement_version so Android refreshes its cached snapshot!
    const [orgRow] = await tx
      .select({ v: organizations.entitlementVersion })
      .from(organizations)
      .where(eq(organizations.id, order.organizationId))
      .limit(1);
    const nextVersion = (orgRow?.v ?? 1) + 1;
    await tx
      .update(organizations)
      .set({ entitlementVersion: nextVersion, updatedAt: now })
      .where(eq(organizations.id, order.organizationId));

    // Emit ENTITLEMENT_UPDATED notification for Android client push/poll refresh
    await tx.insert(notifications).values({
      organizationId: order.organizationId,
      userId: order.userId,
      category: "ENTITLEMENT_UPDATED",
      title: `اشتراک ${plan.nameFa} فعال شد`,
      body: `پرداخت با شماره مرجع ${verifyRes.refId ?? order.paymentReference} تایید و نسخه دسترسی ${nextVersion} صادر شد.`,
    });

    const [verifiedOrder] = await tx
      .update(paymentOrders)
      .set({
        status: "VERIFIED",
        gatewayRefId: verifyRes.refId,
        subscriptionId: sub.id,
        paymentTransactionId: payTx.id,
        callbackPayload: verifyRes.raw,
        verifiedAt: now,
        updatedAt: now,
      })
      .where(eq(paymentOrders.id, order.id))
      .returning();

    return { order: verifiedOrder, subscription: sub, payment: payTx, entitlementVersion: nextVersion };
  });

  await recordAuditLog({
    organizationId: order.organizationId,
    actorUserId: order.userId,
    scope: "ORGANIZATION",
    action: "PAYMENT_VERIFIED_AND_SUBSCRIPTION_ACTIVATED",
    entityType: "PAYMENT_ORDER",
    entityId: order.id,
    ipAddress: params.ipAddress,
    metadata: {
      gateway: gatewayCode,
      refId: verifyRes.refId,
      entitlementVersion: activated.entitlementVersion,
    },
  });

  const snapshot = await buildSignedEntitlementSnapshot(order.organizationId);
  return {
    verified: true,
    already_verified: false,
    order: activated.order,
    entitlements: snapshot,
    deep_link_url: `${order.returnDeepLink}?reference=${encodeURIComponent(order.paymentReference)}`,
  };
}

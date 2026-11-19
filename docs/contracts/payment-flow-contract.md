# Karvexa Business OS — Subscription Upgrade & 4 Iranian Payment Gateway Adapters Contract

## 1. End-to-End Upgrade & Deep-Link Payment Flow (§2.14)
1. **Initiate Upgrade**: `POST /api/v1/subscription/upgrade` (`Idempotency-Key` required, Permission: `subscriptions.upgrade`)
   - Request: `{ "plan_code": "PRO", "gateway": "ZARINPAL" | "ZIBAL" | "BALLEH_PAY" | "SAMAN", "return_scheme": "karvexa://payment/result" }`
   - Server validates plan & active configured gateway, creates `payment_orders` (`PENDING`), invokes the gateway adapter, and returns `{ order_id, payment_reference, gateway, payment_url, expires_at }`.
2. **User Pays in Browser / Gateway Page**: Android opens `payment_url`.
3. **Merchant Server Callback & Verification**: `GET/POST /api/v1/payments/callback/{gateway}` (and browser result page `/payments/result/[reference]`):
   - Verifies payment directly with the gateway's verification API (or sandbox validator when `sandbox_mode = true`), protects against duplicate callbacks (`status === 'VERIFIED'` idempotently returns success without double-extending subscription), activates `subscriptions` + increments `entitlement_version`, and displays a **"بازگشت به اپلیکیشن"** button targeting `karvexa://payment/result?reference=<ref>` only. The app then queries the backend for authoritative payment and entitlement state; URL flags are never trusted.
4. **Authoritative Refresh**: Upon App Link resume, Android calls `GET /api/v1/subscription/payments/{reference}/status` and refreshes `GET /api/v1/subscription/entitlements` — NEVER trusting deep-link parameters alone! The payment-status request also refreshes a still-pending order from its gateway before returning the server-authoritative state.

## 2. Four Independent Gateway Adapters (`src/modules/payments/gateways.ts`)
| Gateway Code | Official Request Endpoint | Official Verify Endpoint | Auth Credential |
| --- | --- | --- | --- |
| `ZARINPAL` | `https://api.zarinpal.com/pg/v4/payment/request.json` | `https://api.zarinpal.com/pg/v4/payment/verify.json` | `merchant_id` |
| `ZIBAL` | `https://gateway.zibal.ir/v1/request` | `https://gateway.zibal.ir/v1/verify` | `merchant` |
| `BALLEH_PAY` | `https://tapi.bale.ai/bot{bot_token}/sendInvoice` | `https://tapi.bale.ai/bot{bot_token}/inquireTransaction` | `bot_token` + `provider_token` |
| `SAMAN` | `https://sep.shaparak.ir/onlinepg/onlinepg` | `https://sep.shaparak.ir/verifyTxnRandomSessionkey/ipg/VerifyTransaction` | `terminal_id` |

- Managed securely from Platform Admin (`/api/v1/platform/payment-gateways`) with secret masking (`••••`), active/default toggles, and sandbox mode.

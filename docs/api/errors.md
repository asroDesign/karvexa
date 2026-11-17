# Business OS — Standardized API Error Codes

All error responses strictly use the Prompt 03 §3 envelope:
`{ "success": false, "error": { "code": "...", "message": "...", "details": [{ "field", "code", "message" }], "request_id": "UUID" } }`

| HTTP | Code | Domain | Description & Client Handling |
| :---: | --- | --- | --- |
| 400 | `CLIENT_VERSION_INCOMPATIBLE` | Versioning | `X-Client-Version` is below minimum supported major version; force app update |
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | Reliability | Required `Idempotency-Key` header missing on payment or sync push |
| 400 | `CAFEBAZAAR_RECEIPT_INVALID` | Payments | Official server verification rejected forged or invalid CafeBazaar receipt |
| 401 | `AUTH_REQUIRED` / `TOKEN_EXPIRED` | Auth | Trigger silent `/api/v1/auth/refresh` |
| 401 | `REFRESH_TOKEN_REUSED` | Security | Revoked entire token family; Android MUST clear tokens and redirect to login |
| 402 | `SUBSCRIPTION_ENTITLEMENT_REQUIRED` | Subscription | Expired plan or locked feature; read & `/api/v1/export` remain accessible |
| 403 | `TENANT_ACCESS_DENIED` | Multi-Tenant | Cross-tenant access blocked and logged as `CRITICAL` security audit event |
| 403 | `PERMISSION_DENIED` | RBAC | Authenticated user lacks required module/action permission |
| 403 | `PLATFORM_ADMIN_REQUIRED` | Platform | Non-platform user attempted `/api/v1/platform/*` |
| 404 | `*_NOT_FOUND` | All | Resource missing or belongs to another organization (never leak existence) |
| 409 | `ACCOUNTING_UNBALANCED` | Accounting | `SUM(debit) != SUM(credit)` on voucher confirm |
| 409 | `ACCOUNTING_ENTRY_IMMUTABLE` | Accounting | Direct PATCH/DELETE on confirmed voucher blocked; use `/reverse` |
| 409 | `ACCOUNTING_PERIOD_CLOSED` | Accounting | Posting into closed accounting period blocked |
| 409 | `INVENTORY_NEGATIVE_STOCK_BLOCKED` | Inventory | Outbound stock exceeds Stock Ledger balance under `BLOCK` policy |
| 409 | `PAYMENT_RECEIPT_REPLAYED` | Payments | Duplicate CafeBazaar `purchase_token` replay blocked |
| 409 | `IDEMPOTENCY_PAYLOAD_MISMATCH` | Reliability | Same `Idempotency-Key` reused with a different request payload |
| 422 | `VALIDATION_ERROR` | Validation | Zod schema violation with per-field `details[]` |
| 422 | `OPENING_BALANCE_LOCKED` | Contacts | Direct mutation of `opening_balance` blocked after transactions exist |
| 429 | `RATE_LIMIT_EXCEEDED` | Security | Sliding-window rate limit exceeded; retry with exponential backoff |
| 500 | `INTERNAL_SERVER_ERROR` | System | Unexpected error logged with `request_id` |

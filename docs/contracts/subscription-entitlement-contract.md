# Karvexa Business OS — Versioned Server-Authoritative Subscription Entitlement Contract

- **Canonical Endpoint**: `GET /api/v1/subscription/entitlements` (and embedded in `/api/v1/auth/me` & `/api/v1/subscription/current`)
- **Versioned Snapshot Schema (`entitlement_version: integer`)**:
  ```json
  {
    "contract_version": "2.0",
    "entitlement_version": 4,
    "organization_id": "uuid",
    "plan_code": "PRO",
    "plan_name_fa": "پلن حرفه‌ای کسب‌وکار",
    "subscription_status": "ACTIVE",
    "activated_at": "2026-08-01T10:00:00.000Z",
    "expires_at": "2026-09-01T10:00:00.000Z",
    "issued_at": "2026-08-15T12:00:00.000Z",
    "signature": "hmac-sha256-hex",
    "features": {
      "multi_warehouse": { "enabled": true, "limit_value": 5 },
      "data_export": { "enabled": true, "limit_value": null }
    }
  }
  ```
- **Offline Caching Rules**:
  - Android persists the latest verified snapshot + `entitlement_version` + `signature` in encrypted Room storage.
  - While offline, Android evaluates features strictly from the cached snapshot as long as `now < expires_at`.
  - When a plan is upgraded, renewed, or overridden on the server, `organizations.entitlement_version` increments and a `notifications` event (`ENTITLEMENT_UPDATED`) is emitted so Android refreshes its snapshot immediately on next online request.
  - Deep-link query parameters NEVER grant or mutate local entitlements; Android MUST call `GET /api/v1/subscription/entitlements` after returning from browser payment.

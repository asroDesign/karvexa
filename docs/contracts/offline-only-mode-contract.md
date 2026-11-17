# Karvexa Business OS — OFFLINE_ONLY Operating Mode & Cloud Reactivation Contract

## 1. Operating Modes (`CLOUD_SYNC` | `OFFLINE_ONLY`)
- **Get Mode**: `GET /api/v1/settings/operating-mode`
- **Switch to OFFLINE_ONLY**: `POST /api/v1/settings/operating-mode`
  ```json
  {
    "mode": "OFFLINE_ONLY",
    "device_id": "uuid",
    "agreement_accepted": true,
    "agreement_version": "2026.08.v1"
  }
  ```
- **Enforcement Rules**:
  1. Switching to `OFFLINE_ONLY` REQUIRES `agreement_accepted === true` and non-empty `agreement_version`; server records timestamp & version in `organization_operating_modes` + `audit_logs`.
  2. When a device/organization is in `OFFLINE_ONLY`, `POST /api/v1/sync/push` and `GET /api/v1/sync/pull` reject background business sync with `409 OPERATING_MODE_OFFLINE_ONLY` so accidental sync uploads never occur.
  3. Existing cloud data is NEVER deleted when switching to `OFFLINE_ONLY`.
  4. Local Android Room continues operating offline using cached server-signed Entitlement Snapshot until expiry.

## 2. Controlled Cloud Reactivation & Resumable Initial Migration (§2.12)
Returning from `OFFLINE_ONLY` to `CLOUD_SYNC` MUST NOT blindly replay old Outbox rows:
1. `POST /api/v1/sync/cloud-migration/start` (with `Idempotency-Key`, `device_id`, `inventory_summary: { contacts, products, sales, purchases, journals }`):
   - Creates a resumable `cloud_migration_sessions` record (`status = 'PREPARING'`).
2. `POST /api/v1/sync/cloud-migration/{session_id}/upload-batch` (idempotent per `batch_index`, validates entity references & detects duplicates/conflicts before applying).
3. `POST /api/v1/sync/cloud-migration/{session_id}/complete`:
   - Verifies all uploaded batches & zero unresolved critical errors, marks migration `COMPLETED`, switches `operating_mode = 'CLOUD_SYNC'`, issues fresh `opaque_cursor`, and re-enables standard bidirectional sync!

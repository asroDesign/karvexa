# Business OS — Crash, Network & Multi-Device Recovery Strategy (15 Scenarios)

Zero silent data loss guarantee across all 15 required failure & recovery scenarios:

| # | Failure / Edge Scenario | Recovery Mechanism (Android + Backend) |
| :---: | --- | --- |
| 1 | **App killed mid-Push** | Outbox rows remain `PROCESSING` -> on next app startup, stale `PROCESSING` rows (>60s) revert to `RETRY` and re-send with exact same `idempotency_key`. |
| 2 | **Internet drops mid-Push** | HTTP client fails -> WorkManager schedules exponential backoff retry (`RETRY`). Server transaction either rolled back completely or committed with `sync_inbox` entry. |
| 3 | **Server committed, response lost before reaching Android** | Retry sends exact same `idempotency_key` + `payload_hash` -> `sync_inbox` detects match and returns previous result with `status: "DUPLICATE"` without creating duplicate invoices/payments/vouchers! |
| 4 | **Duplicate Batch resent** | Batch `Idempotency-Key` in `idempotency_keys` + per-event `sync_inbox` guarantee exact idempotent replay (`meta.replayed = true`). |
| 5 | **Pull interrupted mid-stream** | Because `opaque_cursor` is saved ONLY after Room Transaction commits each page, next Pull resumes cleanly from the last committed page cursor. |
| 6 | **Expired or corrupted Cursor** | Server returns `400 INVALID_SYNC_CURSOR` -> Android calls protected `POST /api/v1/sync/reset-checkpoint` (which preserves all local unsynced Outbox rows!) and performs full incremental catch-up Pull. |
| 7 | **Access Token expires during Sync** | API interceptor triggers `POST /api/v1/auth/refresh` (Refresh Token Rotation) once; if refresh succeeds, retries sync seamlessly; if refresh expired/reused, pauses WorkManager and prompts re-login WITHOUT wiping local Outbox! |
| 8 | **User switches Organization** | Room partitions all records and `sync_outbox` by `organization_id`. Switching org switches active WorkManager key without losing pending rows of Org A. |
| 9 | **User logs out** | Before clearing local DB, UI warns if `sync_outbox` has unsynced items and offers "Sync Now & Logout" or encrypted local retention. |
| 10 | **Android App Upgrade** | `X-Client-Version` header verified; incompatible versions receive `400 CLIENT_VERSION_INCOMPATIBLE` prompting Play/CafeBazaar update while keeping Room DB intact. |
| 11 | **Room Local DB Schema Migration** | Versioned `Migration(old, new)` scripts strictly preserve `sync_outbox` and draft documents; destructive migration disabled. |
| 12 | **Device Revoked from Admin Panel** | `POST /api/v1/devices/{id}/revoke` sets `devices.status = 'BLOCKED'`; next Push/Pull returns `403 DEVICE_REVOKED`, stopping sync and locking device UI. |
| 13 | **Server soft-deletes a record** | Server writes `operation = 'TOMBSTONE'` into `sync_change_log`; Android marks local row `is_deleted = 1` instead of dangling foreign keys. |
| 14 | **Two devices edit same Product/Contact offline** | First push succeeds (version `v -> v+1`). Second push sends stale `base_version = v` -> server detects `conflicting_fields[]` and creates `VERSION_MISMATCH` conflict instead of silently overwriting. |
| 15 | **Two devices sell the same limited Stock offline** | Both push draft sales (`ACCEPTED`). On `CONFIRM`, PostgreSQL `pg_advisory_xact_lock(org:wh:prod)` serializes Stock Ledger deduction: Device 1 succeeds (`CONFIRMED`); Device 2 hits `INVENTORY_NEGATIVE_STOCK_BLOCKED` -> captured as `STOCK_SHORTAGE` conflict (`business_status = REJECTED`), preserving 100% accurate central stock! |

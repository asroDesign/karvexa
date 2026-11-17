# Business OS — Bidirectional Local-First Sync Protocol (Master Prompt 04)

## 1. Core Architectural Guarantees
1. **Local-First UI**: Android Room serves all screens immediately offline; mutations write domain row + `sync_outbox` row atomically in one Room Transaction.
2. **Server-Authoritative Approval**: PostgreSQL is the sole authority for `CONFIRMED` commercial status, double-entry accounting vouchers, Stock Ledger balances, and server-side entitlements.
3. **Client UUID Continuity**: Client generates UUID v4 on creation; PostgreSQL stores that exact UUID as `id` so offline foreign key dependencies never remap or break.
4. **Inbox Idempotency**: PostgreSQL `sync_inbox` enforces `UNIQUE (organization_id, idempotency_key)`. Identical retries return `DUPLICATE`; payload-mutated key reuse returns `IDEMPOTENCY_KEY_REUSED`.
5. **Monotonic Opaque Cursor Pull**: PostgreSQL `sync_change_log` (`seq BIGSERIAL PK`) guarantees deterministic cursor pagination even under identical commit timestamps, with `UPSERT` and `TOMBSTONE` events.
6. **Zero Silent Data Loss**: No crash, timeout, token expiry, or checkpoint reset may ever silently delete unsynced local data.

---

## 2. Independent Sync Status vs Business Document Status
- **Sync Status (`sync_status`)**: `PENDING` | `SYNCING` | `SYNCED` | `FAILED` | `CONFLICT`
- **Business Status (`business_status`)**: `LOCAL_DRAFT` | `PENDING_SYNC` | `RECEIVED` | `VALIDATED` | `CONFIRMED` | `REJECTED` | `CANCELLED` | `REVERSED`
- A sales or purchase invoice can be `sync_status = SYNCED` while still `business_status = DRAFT` awaiting confirmation, or `business_status = REJECTED` due to central stock shortage.

---

## 3. 16-Step Server Push Algorithm (`POST /api/v1/sync/push`)
For each event in `events[]`:
1. Authenticate Bearer token & validate `X-Client-Version`.
2. Verify active `organization_members` membership for `X-Organization-Id`.
3. Verify `device_id` is registered to this organization and `status == 'ACTIVE'` (not revoked).
4. Verify RBAC permissions for the target entity & operation.
5. Lookup `(organization_id, event.idempotency_key)` in `sync_inbox`:
   - Same `payload_hash` -> return previous result with `status: "DUPLICATE"`.
   - Different `payload_hash` -> return `REJECTED` (`IDEMPOTENCY_KEY_REUSED`).
6. Validate payload schema & Decimal String precision.
7. Validate `dependencies[]` exist in `sync_inbox`, `sync_change_log`, or earlier succeeded events in the same batch.
8. Evaluate `base_version` against server `version`.
9. Execute domain rules (e.g., advisory lock on Stock Ledger, double-entry balance, closed accounting period check).
10. Execute inside `withTenantTransaction` (PostgreSQL RLS + ACID transaction).
11. Persist entity & child items using Client UUID.
12. Post Stock Ledger / Accounting Journal Entry if `CONFIRM` requested and approved.
13. Append immutable entry to `sync_change_log` (`UPSERT` or `TOMBSTONE`) and `audit_logs`.
14. Store result in `sync_inbox`.
15. Commit transaction.
16. Return independent per-event result (`ACCEPTED`, `CONFIRMED`, `REJECTED`, `CONFLICT`, `DUPLICATE`) + write telemetry to `sync_logs`.

---

## 4. Pull & Acknowledge Protocol (`GET /api/v1/sync/pull` + `POST /api/v1/sync/acknowledge`)
1. Android sends `GET /api/v1/sync/pull?device_id=<uuid>&cursor=<opaque>&limit=50&entity_types=contact,product,sales`.
2. Server verifies HMAC-signed cursor belongs to active `organization_id`, queries `sync_change_log WHERE seq > decodedSeq ORDER BY seq ASC LIMIT limit + 1`.
3. Android applies `changes[]` (`UPSERT` or `TOMBSTONE`) inside a single Room Transaction AND persists `next_cursor` locally ONLY on transaction commit.
4. Android calls `POST /api/v1/sync/acknowledge` with `{ device_id, cursor }` so the Admin Panel monitoring dashboard reflects real-time checkpoint lag.
5. Repeat while `has_more == true`.

---

## 5. Android WorkManager Algorithm
- **Unique Work Scope**: `ExistingWorkPolicy.KEEP` keyed by `"sync_${organizationId}_${deviceId}"` preventing parallel colliding syncs.
- **Constraints**: `NetworkType.CONNECTED`, valid authenticated session, active selected organization.
- **Pipeline**:
  1. Fetch `PENDING`/`RETRY` rows from `sync_outbox` (ordered by `created_at` respecting `dependency_ids`).
  2. Mark rows `PROCESSING`, send `POST /api/v1/sync/push` with batch + per-event `idempotency_key`.
  3. Update each Room row with returned `status`, `entity_version`, `business_status`, or save `local_sync_conflicts`.
  4. Loop `GET /api/v1/sync/pull` until `has_more == false`, committing each page + cursor atomically in Room, then calling `POST /api/v1/sync/acknowledge`.
  5. Update `last_synced_at` freshness timestamp and emit UI state update.
- **Backoff**: Exponential backoff (`5s, 15s, 45s, 2m, 5m`, max 8 retries) ONLY on HTTP 5xx / timeout / 429. Permanent 4xx validation/domain rejections mark outbox `FAILED` immediately without infinite retry loops.

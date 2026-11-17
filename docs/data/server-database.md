# Business OS — Server Authoritative Database Specification (PostgreSQL)

## 1. Authoritative Responsibilities
PostgreSQL (`src/db/schema.ts`) is the single authoritative source of truth for:
1. Strict Multi-Tenant Data Isolation (`organization_id` FK + PostgreSQL Row Level Security `src/db/rls-policies.sql`).
2. Double-Entry Accounting enforcement (`journal_entries` + `journal_entry_lines` with row lock on `fiscal_years` for race-free `entry_number` generation).
3. Central Stock Ledger (`stock_ledger` with deterministic PostgreSQL advisory locks `pg_advisory_xact_lock(hashtext(org:wh:prod))` preventing negative stock during multi-device concurrent sales).
4. Per-event Sync Inbox Idempotency (`sync_inbox` with `UNIQUE (organization_id, idempotency_key)`).
5. Monotonic Ordered Change Log (`sync_change_log` with `seq BIGSERIAL PRIMARY KEY`) solving identical-timestamp pagination gaps.
6. Immutable Audit Logs (`audit_logs`) & Sync Telemetry (`sync_logs` without sensitive payload exposure).

---

## 2. Sync Infrastructure Tables in PostgreSQL

### `sync_inbox` (Idempotent Event Ingestion)
- Enforces `UNIQUE (organization_id, idempotency_key)`.
- Stores SHA-256 `payload_hash` and serialized `result_payload`.
- **Replay Behavior**:
  - Same `idempotency_key` + same `payload_hash` => returns cached result with `status = 'DUPLICATE'`.
  - Same `idempotency_key` + different `payload_hash` => rejects event with `IDEMPOTENCY_KEY_REUSED`.

### `sync_change_log` (Pull Stream & Tombstones)
- Uses `seq BIGSERIAL PRIMARY KEY` so ordering is 100% strictly monotonic even when multiple transactions commit within the same millisecond.
- Records `operation = 'UPSERT'` for creates/updates and `operation = 'TOMBSTONE'` for soft-deletes.
- Pull cursors encode `{ seq, orgId }` signed with HMAC-SHA256 (`bos_c1_<base64url>.<sig>`), preventing cross-tenant cursor tampering.

### `sync_conflicts`
- Captures `conflict_type` (`VERSION_MISMATCH`, `STOCK_SHORTAGE`, `FINANCIAL_IMMUTABLE`, `PAYMENT_MISMATCH`, `DEPENDENCY_MISSING`), `conflicting_fields[]`, `client_payload`, and `server_payload`.
- Resolution enforces entity-domain constraints (e.g., `USE_LOCAL` forbidden for confirmed accounting vouchers).

### `sync_logs`
- Logs every Push and Pull cycle: `sync_id`, `device_id`, `organization_id`, `direction`, `started_at`, `finished_at`, `push_count`, `pull_count`, `success_count`, `failure_count`, `conflict_count`, `cursor_before`, `cursor_after`, `error_code`, `duration_ms`.

---

## 3. Incremental Migration & Backward Compatibility Policy
- All PostgreSQL schema changes are additive first (expand-and-contract pattern): add nullable/defaulted columns -> deploy backward-compatible API -> backfill -> enforce constraints.
- Never drop or rename columns consumed by active Android app versions (`X-Client-Version: 1.x`).
- Automated daily logical backups (`pg_dump --format=custom`) + WAL point-in-time recovery (PITR) for financial ledger durability.

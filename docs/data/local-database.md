# Business OS — Android Local-First Database Specification (Room / SQLite)

## 1. Responsibilities of Android Room
- Store UI-ready local projections of reference data (`contacts`, `products`, `warehouses`, `accounts`, `financial_accounts`, `units`).
- Support offline creation & editing of drafts (`purchase_documents`, `sales_documents`, `journal_entries`, `stock_counts`, `cheques`, `financial_transactions`) using client-generated UUID v4 primary keys.
- Maintain transactional **Outbox** (`sync_outbox`), **Sync Cursor** (`sync_cursor_state`), **Local Conflict Cache** (`local_sync_conflicts`), and **Sync Freshness Metadata** (`last_synced_at`).
- **Strict Rule**: Android Room NEVER promotes a financial or inventory document to `CONFIRMED` locally. Only the authoritative PostgreSQL server may set `business_status = 'CONFIRMED'`.

---

## 2. Base Sync Columns on Every Syncable Room Entity
```sql
id                TEXT PRIMARY KEY NOT NULL, -- Client UUID v4, preserved permanently after sync
organization_id   TEXT NOT NULL,
version           INTEGER NOT NULL DEFAULT 0,
is_deleted        INTEGER NOT NULL DEFAULT 0, -- Tombstone flag (0/1)
sync_status       TEXT NOT NULL DEFAULT 'PENDING', -- PENDING | SYNCING | SYNCED | FAILED | CONFLICT
business_status   TEXT NOT NULL DEFAULT 'LOCAL_DRAFT', -- LOCAL_DRAFT | PENDING_SYNC | RECEIVED | VALIDATED | CONFIRMED | REJECTED | CANCELLED | REVERSED
device_id         TEXT NOT NULL,
created_by        TEXT,
updated_by        TEXT,
created_at        TEXT NOT NULL, -- ISO 8601 UTC
updated_at        TEXT NOT NULL  -- ISO 8601 UTC
```

---

## 3. Outbox Table (`sync_outbox`)
Every offline mutation MUST write the domain entity AND insert its `sync_outbox` row inside a **single `database.withTransaction { ... }` block**. If either fails, both roll back atomically.

```sql
CREATE TABLE sync_outbox (
  id              TEXT PRIMARY KEY NOT NULL,
  event_id        TEXT NOT NULL UNIQUE,
  organization_id TEXT NOT NULL,
  device_id       TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  entity_type     TEXT NOT NULL,
  entity_id       TEXT NOT NULL,
  operation       TEXT NOT NULL, -- CREATE | UPDATE | DELETE | CONFIRM
  payload         TEXT NOT NULL, -- Canonical snake_case JSON
  base_version    INTEGER,
  idempotency_key TEXT NOT NULL UNIQUE,
  dependency_ids  TEXT NOT NULL DEFAULT '[]', -- JSON array of event_id / entity_id UUIDs
  created_at      TEXT NOT NULL,
  retry_count     INTEGER NOT NULL DEFAULT 0,
  next_retry_at   TEXT,
  status          TEXT NOT NULL DEFAULT 'PENDING', -- PENDING | PROCESSING | RETRY | FAILED | ACKNOWLEDGED | CONFLICT
  last_error      TEXT
);
CREATE INDEX idx_outbox_org_status_next ON sync_outbox(organization_id, status, next_retry_at);
```

---

## 4. Cursor & Sync State Table (`sync_cursor_state`)
```sql
CREATE TABLE sync_cursor_state (
  organization_id TEXT NOT NULL,
  device_id       TEXT NOT NULL,
  opaque_cursor   TEXT,
  last_pull_at    TEXT,
  last_push_at    TEXT,
  last_sync_error TEXT,
  PRIMARY KEY (organization_id, device_id)
);
```
- **Atomicity Rule**: `opaque_cursor` is updated ONLY inside the same Room Transaction that commits the pulled `changes[]` batch, followed by calling `POST /api/v1/sync/acknowledge`.

---

## 5. Room Migration & Schema Upgrade Rules
- `fallbackToDestructiveMigration()` is **STRICTLY FORBIDDEN** in production builds.
- Every schema version bump requires an explicit `Migration(from, to)` verified by `MigrationTestHelper` ensuring zero loss of unsynced `sync_outbox` rows or local drafts.
- All monetary/quantity columns are stored as exact `TEXT` (Decimal String) and converted via Kotlin `BigDecimal` only in domain logic.

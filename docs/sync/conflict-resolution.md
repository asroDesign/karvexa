# Business OS — Domain-Based Conflict Resolution Policy

**Golden Rule**: NEVER use blind Last-Write-Wins (LWW) for financial vouchers, inventory ledger movements, or payment transactions.

---

## 1. Conflict Policies by Domain

| Domain | Examples | Detection Mechanism | Automatic Behavior | Allowed Manual Resolutions |
| --- | --- | --- | --- | --- |
| **Reference Data** | `contact`, `product`, `category`, `warehouse` | `server.version > event.base_version` + field-level diff (`conflicting_fields[]`) | If only non-overlapping fields differ -> safe auto-merge; if same fields differ -> capture `VERSION_MISMATCH` conflict | `USE_SERVER`, `USE_LOCAL`, `MERGE`, `RECREATE_AS_NEW` |
| **Accounting Vouchers** | `journal_entry` | Confirmed entry is immutable (`status == CONFIRMED/POSTED`) | Reject/capture `FINANCIAL_IMMUTABLE` conflict; never overwrite | `USE_SERVER`, `RECREATE_AS_NEW` (**`USE_LOCAL` STRICTLY FORBIDDEN**) |
| **Inventory & Sales Confirm** | `sales`, `inventory_document`, `stock_transfer` | Central PostgreSQL Stock Ledger check under `pg_advisory_xact_lock` | If Stock < Requested under `BLOCK` policy -> capture `STOCK_SHORTAGE` conflict & set `business_status = REJECTED` | `USE_SERVER`, `RECREATE_AS_NEW` (adjust qty or restock first) |
| **Treasury & Payments** | `financial_transaction`, `cheque` | `sync_inbox` `idempotency_key` + account/amount check | Duplicate payment returns `DUPLICATE`; mismatch returns `PAYMENT_MISMATCH` | `USE_SERVER`, `RECREATE_AS_NEW` |
| **Deletes (Tombstones)** | Any synced entity | Physical delete forbidden | Soft delete sets `deleted_at` + emits `TOMBSTONE` to `sync_change_log`; financial docs with movements require reversal/return | `USE_SERVER` |

---

## 2. Conflict Resolution API Enforcement (`POST /api/v1/sync/conflicts/{id}/resolve`)
- Request body: `{ "resolution": "USE_SERVER" | "USE_LOCAL" | "MERGE" | "RECREATE_AS_NEW", "merged_payload": { ... } }`
- Server validates `resolution` against `getAllowedResolutions(entity_type, conflict_type)`.
- Attempting `USE_LOCAL` on a `journal_entry` or `STOCK_SHORTAGE` conflict returns `409 RESOLUTION_NOT_ALLOWED_FOR_ENTITY`.
- Every resolved conflict appends an updated `UPSERT` record to `sync_change_log` so all Android devices converge on the next Pull, and writes an immutable entry to `audit_logs`.

# Business OS — Unified Database Schema Specification (PostgreSQL + Room)

## 1. Precision & Data Type Standards
- **Identifiers**: `UUID` (v4 generated client-side on offline creation; preserved verbatim as server Primary Key).
- **Monetary Values**: `NUMERIC(18, 2)` / `NUMERIC(20, 4)` in PostgreSQL; stored as exact Decimal String (`TEXT`) in Android Room / SQLite and serialized as Decimal String in JSON. Zero IEEE-754 `Float`/`Double` usage.
- **Quantities & Unit Conversions**: `NUMERIC(18, 4)` / `NUMERIC(20, 6)` in PostgreSQL; exact `BigDecimal` in Kotlin and `BigInt` fixed-point in TypeScript.
- **Business Dates**: `DATE` (`YYYY-MM-DD`, no timezone offset). Interpreted in `organizations.timezone`.
- **System Timestamps**: `TIMESTAMPTZ` stored and transmitted strictly in ISO 8601 UTC (`...Z`).
- **Currency Context**: Every organization explicitly declares `base_currency` (`IRR`, `IRT`, `USD`, etc.) and `currency_scale`. Implicit currency conversions are prohibited.

---

## 2. Core Multi-Tenant & Domain Tables (PostgreSQL)
1. **Tenancy & Auth**: `organizations`, `users`, `organization_members`, `roles`, `permissions`, `role_permissions`, `user_roles`, `user_invitations`, `sessions`, `devices`.
2. **Contacts**: `contact_groups`, `contacts`, `contact_addresses`, `contact_accounts`, `contact_transactions`.
3. **Catalog**: `categories`, `brands`, `units`, `products`, `product_units`, `barcodes`, `product_prices`, `product_attributes`, `product_images`.
4. **Accounting (Double-Entry)**: `account_groups`, `accounts`, `fiscal_years`, `accounting_periods`, `cost_centers`, `journal_entries`, `journal_entry_lines`, `opening_balances`.
5. **Inventory (Ledger-Driven)**: `warehouses`, `stock_documents`, `stock_document_items`, `stock_ledger`, `stock_reservations`, `stock_counts`, `stock_count_items`, `stock_transfers`.
6. **Purchasing & Sales**: `purchase_orders`, `purchase_invoices`, `purchase_invoice_items`, `purchase_returns`, `sales_orders`, `sales_invoices`, `sales_invoice_items`, `sales_returns`.
7. **Treasury, Cheques & Consignment**: `financial_accounts`, `cashboxes`, `financial_transactions`, `bank_reconciliations`, `cheques`, `cheque_events`, `cheque_assignments`, `consignment_documents`, `consignment_items`, `consignor_settlements`.
8. **Subscriptions & Payments**: `plans`, `features`, `plan_features`, `subscriptions`, `entitlements`, `payment_transactions`, `purchase_receipts`.
9. **Bidirectional Sync Engine**:
   - `sync_inbox` (`UNIQUE (organization_id, idempotency_key)`)
   - `sync_change_log` (`seq BIGSERIAL PK`, `change_id UUID`, `operation UPSERT|TOMBSTONE`, `INDEX (organization_id, seq)`)
   - `sync_batches` (`UNIQUE (device_id, client_batch_id)`)
   - `sync_events`
   - `sync_conflicts` (`conflict_type`, `conflicting_fields`, `resolution_strategy`)
   - `sync_checkpoints` (`UNIQUE (organization_id, device_id)`, opaque `cursor`, `acknowledged_at`)
   - `sync_logs` (`started_at`, `finished_at`, `push_count`, `pull_count`, `duration_ms`, zero sensitive payloads)
   - `idempotency_keys` (`UNIQUE (organization_id, key)`)
10. **Governance**: `audit_logs`, `system_error_logs`, `notifications`, `files`, `support_tickets`, `platform_settings`.

---

## 3. Mandatory Constraints & Row Level Security
- Every business table enforces `organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE`.
- PostgreSQL Row Level Security (`src/db/rls-policies.sql`) is enabled on all 58 tenant tables binding every query to `current_setting('app.current_org_id', true)`.
- Sequential document uniqueness:
  - `UNIQUE (organization_id, fiscal_year_id, entry_number)` on `journal_entries`
  - `UNIQUE (organization_id, code)` on `contacts`, `accounts`, `warehouses`
  - `UNIQUE (organization_id, sku)` on `products`
  - `UNIQUE (provider, purchase_token)` on `purchase_receipts`
  - `UNIQUE (organization_id, idempotency_key)` on `sync_inbox`

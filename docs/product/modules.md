# Business OS — System Architecture, Modules, Domain Rules & Test Strategy

## 1. System Architecture (Modular Monolith)

Business OS follows a **Strict Modular Monolith** architecture with clear domain boundaries, avoiding premature microservices while ensuring each module can later be extracted if scale requires.

### Technology Blueprint
- **Application Runtime**: Modular Monolith TypeScript backend (Next.js App Router `/api/v1/*` + NestJS-aligned module boundaries `src/modules/<domain>/{service,dto,rules}.ts`)
- **Primary Database**: PostgreSQL 16 with Drizzle ORM, ACID transactions, `SELECT ... FOR UPDATE` row locks, and PostgreSQL Row Level Security (RLS)
- **Caching & Queue Pattern**: Redis-compatible idempotency/session/queue abstraction backed by PostgreSQL durability (`idempotency_keys`, `sync_batches`, `sync_events`)
- **Object Storage**: S3-compatible file metadata & signed URL contract (`files` table)
- **API Style**: Versioned REST API (`/api/v1`), OpenAPI 3.1 (`docs/api/openapi.yaml`), strict Zod DTO validation, standardized Persian/English error codes
- **Admin & Organization UI**: Next.js + TypeScript + Tailwind CSS (Persian RTL, component-driven, strict separation between Platform Admin Portal and Organization Workspace)
- **Offline Client**: Android application syncing via checkpointed batch push/pull protocol (`docs/sync/sync-protocol.md`)

---

## 2. Core Modules (20 Core + 8 Extension Modules)

### Core Modules
1. **Identity**: Authentication, JWT/Session management, Refresh Token Rotation, device registration, rate limiting.
2. **Organization**: Tenant lifecycle, fiscal configuration, base currency, timezone, valuation & negative stock settings.
3. **Users**: Global user identities, profile settings, multi-org memberships (`organization_members`).
4. **Roles & Permissions**: Platform-scoped and Organization-scoped RBAC with granular permission codes (`module.resource.action`).
5. **Contacts**: Customers, vendors, employees, groups, addresses, contact accounts, contact running ledger.
6. **Catalog**: Products, services, categories, brands, units, unit conversions, multi-barcodes, price lists, attributes, images.
7. **Accounting**: Chart of accounts, account groups, fiscal years, accounting periods, cost centers, double-entry journal vouchers, opening balances.
8. **Inventory**: Warehouses, stock documents, immutable stock ledger (source of truth), reservations, stock counts, atomic warehouse transfers.
9. **Purchasing**: Purchase orders, purchase invoices, purchase returns, automatic stock-in & accounting voucher integration.
10. **Sales**: Sales orders, sales invoices, sales returns, automatic stock-out, COGS & accounting voucher integration.
11. **Treasury**: Bank accounts, cashboxes, receipts/payments, transfers, bank reconciliations.
12. **Cheques**: Receivable/payable cheques, event timeline (registered, passed, bounced, assigned, cancelled), cheque assignments.
13. **Consignment**: Consignment-in/out documents, consignment item tracking, consignor settlements.
14. **Reports**: Trial Balance, Account Ledger, Profit & Loss, Stock Valuation, Contact Aging, Sales/Purchase summaries, non-restricted data export.
15. **Subscription**: Freemium plans, feature flags, server-side entitlements, trial/grace/expired lifecycle without data loss.
16. **Payments**: Payment transactions, CafeBazaar official receipt validation, idempotency, purchase restoration, anti-fraud replay prevention.
17. **Synchronization**: Offline-first Android batch push/pull, checkpoints, idempotency keys, optimistic concurrency conflict detection & resolution.
18. **Audit**: Immutable audit trail for all sensitive mutations with sanitized before/after payloads, actor, IP, org context.
19. **Notifications**: System alerts, cheque due reminders, sync conflict alerts, subscription expiry notices.
20. **Files & Attachments**: Secure upload metadata, MIME/size validation, S3 storage key mapping, entity attachments.

### Extension Modules (Roadmap-Ready Hooks)
- **POS** (Offline cashier terminal & thermal receipt sync)
- **Production** (BOM, work orders, raw material consumption to finished goods)
- **Fixed Assets** (Asset register, depreciation schedules)
- **CRM** (Leads, pipelines, follow-ups linked to Contacts)
- **Payroll** (Employee contracts, monthly salary vouchers)
- **Projects** (Project cost centers & profitability)
- **Tax** (Iranian Moadian e-invoicing, VAT reporting)
- **AI/OCR** (Invoice image OCR extraction to draft purchase invoices)

---

## 3. Multi-Tenancy Principles

1. Every business table carries a non-null `organization_id` foreign key to `organizations(id)` with composite indexes starting with `(organization_id, ...)`.
2. **Never trust client-supplied `organization_id`**: The active organization is extracted exclusively from the authenticated session + verified `organization_members` record (`status = 'ACTIVE'`). If a client sends an `X-Organization-Id` header or payload `organization_id` that does not match an active membership, the request is rejected with `403 TENANT_ACCESS_DENIED` and recorded in `audit_logs`.
3. **PostgreSQL Row Level Security (RLS)**: Tenant tables include RLS policies bound to `current_setting('app.current_org_id', true)`.
4. **Platform Admin vs Organization Workspace Separation**: Platform endpoints live under `/api/v1/platform/*` and require `is_platform_admin = true` plus explicit platform permissions. Organization endpoints live under `/api/v1/org/*` and require verified membership in the active tenant.

---

## 4. Accounting Rules (Non-Negotiable Invariants)

1. **Strict Double-Entry**: Every journal entry must have `SUM(debit) == SUM(credit)` and at least 2 non-zero lines before posting.
2. **Exact Decimal Arithmetic**: All monetary columns use PostgreSQL `NUMERIC(18, 2)` (rates/quantities `NUMERIC(18, 4)`). Application math uses fixed-point `BigInt` scaled arithmetic (`src/lib/decimal.ts`). Zero JavaScript `float` calculations.
3. **Immutability of Posted Vouchers**: Once `status = 'POSTED'`, a journal entry cannot be updated or deleted. Attempts return `409 ACCOUNTING_ENTRY_IMMUTABLE`.
4. **Correction via Reversal**: Corrections are performed only by creating a linked reversal entry (`reversed_entry_id`) that swaps debit and credit amounts and marks the original as `REVERSED`.
5. **Unique Voucher Numbering**: `(organization_id, fiscal_year_id, entry_number)` is enforced via unique database constraint.
6. **Closed Period Protection**: Posting into an `accounting_periods` row with `status = 'CLOSED'` is rejected with `409 ACCOUNTING_PERIOD_CLOSED` unless explicitly reopened by an authorized role with audit logging.
7. **Transactional Posting**: Vouchers and lines commit atomically inside a single PostgreSQL transaction.
8. **Ledger Reconstructibility**: Account balances and Trial Balance are always reconstructible directly from posted `journal_entry_lines`.

---

## 5. Inventory Rules (Non-Negotiable Invariants)

1. **Stock Ledger as Source of Truth**: Current on-hand quantities and valuations are derived from immutable `stock_ledger` entries.
2. **Traceable Movements**: Every stock ledger row references a `stock_document_id`, `movement_type`, `reason`, `warehouse_id`, and `product_id`.
3. **Atomic Warehouse Transfers**: Transfers execute exit from `source_warehouse_id` and entry into `target_warehouse_id` inside one ACID transaction with deterministic row locking.
4. **Stock Count Adjustments**: Approving a `stock_counts` document calculates `counted_qty - system_qty` and generates a formal `ADJUSTMENT` stock document + ledger delta.
5. **Costing Valuation**: Configurable at organization level (`FIFO` or `WEIGHTED_AVERAGE`) with product-level override support.
6. **Explicit Negative Stock Policy**: `ALLOW`, `WARN`, or `BLOCK` (default `BLOCK`). When `BLOCK`, outbound stock exceeding available quantity returns `409 INVENTORY_NEGATIVE_STOCK_BLOCKED`.

---

## 6. Subscription, Freemium & CafeBazaar Payment Rules

1. **Server-Side Entitlements**: Feature access (`max_warehouses`, `multi_user`, `advanced_reports`, `offline_sync_devices`, `cheques_module`, `consignment_module`) is computed strictly on the server from active `subscriptions` + `plan_features` + `entitlements`.
2. **CafeBazaar Verification**: Receipts (`purchase_token`, `sku`, `package_name`) are verified via server-side CafeBazaar verification gateway (supports live CafeBazaar Developer API credentials via env vars + deterministic signed verification validator in sandbox).
3. **Anti-Fraud & Idempotency**: `(provider, purchase_token)` has a unique constraint in `purchase_receipts`. Replayed tokens cannot activate multiple organizations; repeated identical requests with the same `Idempotency-Key` return the original response.
4. **Non-Destructive Expiry**: When a subscription expires, **zero user or accounting data is deleted**. Users retain full read access and full data export (`/api/v1/org/export`), while premium write/create features are gated cleanly with `402 SUBSCRIPTION_ENTITLEMENT_REQUIRED`.

---

## 7. Admin Screen Inventory

### Platform Admin Portal (`/platform/*` mode)
1. System Overview Dashboard (global KPIs, tenant growth, sync health, revenue, error telemetry)
2. Organizations & Businesses (create, edit, suspend/activate, plan assignment, tenant policies)
3. Users & Memberships (global user registry, org assignments, session revocation)
4. Roles & Permissions Matrix (platform & org roles, granular toggle matrix)
5. Subscriptions & Plans (plan pricing, feature limits, entitlements override)
6. Payments & CafeBazaar Receipts (transaction ledger, receipt verification status, fraud flags)
7. Android Devices & Sync Monitor (registered devices, sync batches, checkpoint lag, conflict resolver)
8. Audit Logs (searchable immutable trail with actor/org/action/before-after JSON)
9. Error Reports (server/sync error logs with stack traces & resolution status)
10. General Platform Settings (CafeBazaar config, rate limits, backup policy, retention)
11. Feature Flags & Entitlements (global toggles & org-specific overrides)
12. Support Tickets (user issue triage, tenant context inspection, status workflow)
13. API & Contract Explorer (live OpenAPI, ERD, Field Dictionary, Sync Protocol viewer)

### Organization Workspace (`/org/*` mode)
1. Organization Financial & Operational Dashboard
2. Accounting (Chart of Accounts, Fiscal Years/Periods, Journal Entries Builder, Reversals, Trial Balance & Account Ledger)
3. Inventory (Warehouses, Stock Ledger, Atomic Transfers, Stock Counts & Adjustments, Valuation & Negative Stock Policies)
4. Catalog (Products, Categories, Brands, Units, Barcodes, Prices)
5. Contacts (Customers, Vendors, Groups, Running Balances)
6. Sales & Purchasing (Invoices, Finalization with atomic Stock + Journal Entry posting)
7. Treasury & Cheques (Bank/Cash accounts, Transactions, Cheques lifecycle & events)
8. Consignment (Documents, Items, Consignor Settlements)
9. Reports & Data Export (Trial Balance, P&L, Stock Valuation, CSV/JSON full export)
10. Organization Subscription & CafeBazaar Upgrade/Restore
11. Offline Android Sync Simulator & Conflict Inspector

---

## 8. Test Strategy

| Layer | Scope | Verification Criteria |
| --- | --- | --- |
| **Unit Tests** | Decimal math, double-entry balance validator, costing calculator, entitlement evaluator | Zero floating-point drift; exact scale-4 precision; edge cases |
| **Integration Tests** | Accounting posting/immutability/reversal, closed periods, atomic transfers, stock counts, invoice finalization, CafeBazaar verification, Sync push/pull/idempotency | Real PostgreSQL transactions, constraint enforcement, rollbacks on error |
| **Cross-Tenant Security Tests** | User from Org A requesting/mutating Org B data with forged headers/IDs | 100% blocked with `403`/`404` + audit log recorded |
| **E2E API Tests** | Full lifecycle: Login -> Refresh -> Org Context -> Purchase -> Stock -> Sale -> Journal -> Trial Balance -> Sync Push/Pull -> Export | End-to-end HTTP status, DTO schema conformance, database consistency |

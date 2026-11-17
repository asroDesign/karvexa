# Business OS Backend — Master Prompt 07 Extension Completion Report

## 1. Initial State & Gaps Identified (Phase 0 Audit)
See full breakdown in `docs/development/backend-extension-audit.md`. Key gaps addressed:
- Atomic `POST /api/v1/auth/register` needed `DeviceRegistrationDto` inside the single registration transaction, duplicate normalized mobile blocking, `accounting_policies` + `branches` + `sync_checkpoints` initialization, `mobile_verified = false` distinction, and `Idempotency-Key` deduplication.
- Sales & Purchases needed full lifecycle separation between **Cancel** (draft or confirmed reversal without deleting history) and **Item-Level Partial/Full Return** (`/return`) with cumulative quantity verification against prior returns, Stock Ledger movements, and balanced double-entry accounting.
- Consignments needed 4 distinct document types (`CONSIGNMENT_IN`, `CONSIGNMENT_OUT`, `CONSIGNMENT_SALE`, `CONSIGNMENT_RETURN`), strict third-party ownership tracking via `consignment_ledger`, balance guards, and commission-accurate accounting.
- Advanced Accounting needed `GET/PUT /api/v1/accounting/policy` (`accounting_policies` non-retroactive snapshot), full `cost_centers` CRUD + P&L reporting, and `POST /api/v1/accounting/periods/lock` + `/unlock` independent from full Fiscal Year Closing.
- Personal Finance needed unified `POST /api/v1/personal/transfers` covering Business→Personal, Personal→Business, and Personal→Personal transfers with source balance validation and idempotency.
- Bidirectional Sync needed full support for all 14 Prompt 07 `SyncEntityType` values (`warehouse`, `account_code`, `branch`, `cost_center`, `cheque`, `treasury_account`, `treasury_transaction`, `journal_entry`, `quick_cashflow`, `personal_transaction`, `consignment_document`, `product_variant`, `employee`, `owner_withdrawal`).

## 2. Database Schema & RLS Migrations Applied
Non-destructive additive Drizzle schema updates (`src/db/schema.ts` + `src/db/rls-policies.sql`, applied via `npx drizzle-kit push --force`):
- **New Tables (all RLS-protected)**:
  - `accounting_policies` (`UNIQUE(organization_id)`)
  - `branches` (`UNIQUE(organization_id, code)`)
  - `sales_return_items`, `purchase_return_items` (FK to original invoice item + warehouse + variant)
  - `consignment_ledger` (independent third-party ownership ledger separate from owned `stock_ledger`)
- **Extended Existing Tables**:
  - `organizations`: `enabled_addons TEXT[]`, `ui_mode_default VARCHAR(32)`
  - `users`: `mobile_verified BOOLEAN`
  - `accounting_periods`: `locked_until`, `locked_by`, `locked_at`, `unlock_reason`
  - `cost_centers`: `type`, `version`, `deleted_at`, `created_at`, `updated_at`
  - `sales_invoices` & `purchase_invoices`: `related_document_id`, `related_document_type`, `cancellation_reason`, `cancelled_at`, `receipt_url`, `tax_rate_snapshot`, `is_tax_inclusive_snapshot`
  - `consignment_documents`: `document_type`, `ownership_scope`, `related_document_id`, `cancellation_reason`, `receipt_url`, `journal_entry_id`, `version`, `deleted_at`
  - `quick_transactions`: `receipt_url`, `version`, `deleted_at`, `updated_at`
  - `warehouses`, `accounts`, `financial_accounts`, `financial_transactions`, `cheques`, `owner_withdrawals`, `personal_transactions`, `product_variants`, `employees`: `version`, `deleted_at`, `updated_at`

## 3. New & Extended API Endpoints (`/api/v1/*`)
- `POST /api/v1/auth/register` — Atomic user + org + owner RBAC + `DeviceRegistrationDto` + policy + sync init + `Idempotency-Key`
- `POST /api/v1/sales/{id}/cancel` & `POST /api/v1/sales/{id}/return` (plus `/returns` compat) — `Idempotency-Key`
- `POST /api/v1/purchases/{id}/cancel` & `POST /api/v1/purchases/{id}/return` (plus `/returns` compat) — `Idempotency-Key`
- `GET /api/v1/consignments` (filters: `document_type`, `status`, `contact_id`, `warehouse_id`, `date_from`, `date_to`, `search`), `GET /api/v1/consignments/balances`, `POST /api/v1/consignments`, `POST /api/v1/consignments/{id}/confirm`
- `POST /api/v1/accounting/journal-entries/{id}/reverse` (`CancelDocumentRequestDto` + `Idempotency-Key`)
- `GET /api/v1/accounting/policy` & `PUT /api/v1/accounting/policy` (`TaxInvoicePolicyDto`)
- `GET/POST /api/v1/accounting/cost-centers`, `PATCH/DELETE /api/v1/accounting/cost-centers/{id}`, `GET /api/v1/accounting/cost-centers/{id}/profit-loss`
- `POST /api/v1/accounting/periods/lock` & `POST /api/v1/accounting/periods/{id}/unlock`
- `POST /api/v1/personal/transfers` (`PersonalTransferRequestDto` + `Idempotency-Key`)
- `GET/POST /api/v1/quick-cashflows` (alias to `quick-transactions` with `receipt_url` & active `cost_center_id` validation)
- `POST /api/v1/sync/push` & `GET /api/v1/sync/pull` expanded across all 14 Prompt 07 Entity Types

## 4. New Permissions Added (`src/db/seed-prompt05.ts` & `src/lib/tenant.ts`)
`purchases.return`, `consignments.create`, `consignments.confirm`, `consignments.return`, `accounting.journal_entries.reverse`, `accounting.policy.view`, `accounting.policy.update`, `accounting.cost_centers.view`, `accounting.cost_centers.create`, `accounting.cost_centers.update`, `accounting.periods.lock`, `accounting.periods.unlock`, `personal_finance.create`, `employees.view`, `sync.push`, `sync.pull`.

## 5. Sync Entity Types & Conflict Rules
Full manifest documented in `docs/sync/sync-entity-manifest.md` and `docs/sync/entity-dependencies.md`:
- Reference entities (`warehouse`, `branch`, `cost_center`, `product_variant`, `employee`) use version-checked updates with explicit conflict capture & `TOMBSTONE` soft deletes.
- `treasury_account` rejects offline LWW overwrites of `balance`.
- `account_code` protects system accounts and directs closures to `/api/v1/fiscal/accounts/{id}/close`.
- Financial & movement records (`journal_entry`, `treasury_transaction`, `quick_cashflow`, `owner_withdrawal`) are immutable once confirmed.
- `personal_transaction` and `owner_withdrawal` strictly enforce `personal_finance.manage` RBAC inside Sync Push.

## 6. Architecture Decision & Remaining Considerations for Production
- **Runtime Alignment**: The repository runs a Next.js App Router + TypeScript Modular Monolith (`src/modules/*`) rather than a standalone NestJS binary; all REST API `/api/v1/*` routes, Zod DTOs, snake_case envelopes, Decimal Strings, PostgreSQL RLS, and OpenAPI 3.1 contracts are 100% compatible with the Android client.
- **File Storage Security**: `receipt_url` references `/api/v1/files/{id}` metadata entries; production deployments should wire signed short-lived S3/MinIO URLs so financial receipts are never exposed on public buckets.

## 7. Commands to Run Migrations & Automated E2E Test Suite
```bash
npx drizzle-kit push --force
psql postgresql://postgres:postgres@127.0.0.1:5432/app_db -f src/db/rls-policies.sql
node scripts/test-business-os.mjs
```

## 8. Sample Requests (Master Prompt 07)
- **Register (`POST /api/v1/auth/register`)**:
  `{ "full_name": "علی رضایی", "mobile": "09123456789", "password": "Strong@123", "organization_name": "پخش نوین", "device": { "device_id": "uuid", "platform": "android", "device_name": "Pixel 8", "app_version": "1.2.0" } }`
- **Sales Return (`POST /api/v1/sales/{id}/return`)**:
  `{ "notes": "برگشت ۱ عدد معیوب", "items": [{ "original_item_id": "uuid", "product_id": "uuid", "quantity": "1.0000", "warehouse_id": "uuid", "reason": "آسیب‌دیدگی" }] }`
- **Personal Transfer (`POST /api/v1/personal/transfers`)**:
  `{ "from_account_id": "business-cash-uuid", "to_account_id": "personal-bank-uuid", "amount": "2000000.00", "description": "برداشت شخصی ماهانه" }`

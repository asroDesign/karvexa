# Karvexa Business OS — Master Prompt 09A Backend Audit & Implementation Plan

## 1. Existing Functionality Inventory (Baseline after Master Prompts 02–08)
- **Sales & Mixed Settlements**: `sales_invoices`, `sales_invoice_items`, `invoice_payment_allocations` supporting `CASH`, `BANK`, `CARD_TERMINAL`, `CHEQUE`, `CREDIT`, `ACCOUNT_BALANCE`, inline multi-cheque creation with Jalali due dates, and damaged/accepted split returns.
- **Incoming Receipts & Suppliers**: `stock_documents` with landed acquisition costing (`shipping_cost`, `customs_and_extra_cost`, `supplier_discount`, `paid_amount`, `remaining_payable`) + supplier profile & settlement posting (`DR AP / CR Cash-Bank`).
- **Warehouse Transfers**: `stock_transfers` & `stock_transfer_items` with `DRAFT -> IN_TRANSIT -> PARTIALLY_RECEIVED | RECEIVED | DISCREPANCY_REPORTED -> COMPLETED`.
- **Excel Exports**: `.xlsx` workbooks for Journal Book, Current Warehouse Stock (`/inventory/exports/stock`), and Movement History (`/inventory/exports/movements`).
- **Treasury & Cheques**: Cash/Bank/POS accounts, opening balance journal, transaction history, deletion guard, state-machine cheque lifecycle, and audited cheque amendments.
- **Offline-Only & Cloud Migration**: `organization_operating_modes`, `cloud_migration_sessions`, `sync_inbox`, `sync_change_log` with opaque cursor.
- **Subscriptions & 4 Payment Gateways**: Versioned signed entitlements + Zarinpal, Zibal, Balleh Pay, Saman adapters + `/payments/result/[reference]` browser return page.

## 2. Missing Gaps Identified Against Master Prompt 09A
1. **`invoice_payment_allocations`**: Missing `contact_id` & `cheque_id` FKs and explicit persistence of `CREDIT` / `ACCOUNT_BALANCE` settlement allocation rows alongside immediate allocations.
2. **Supplier Account Endpoints**: Need `GET /api/v1/suppliers/{id}/account`, `GET /api/v1/suppliers/{id}/transactions`, and `GET /api/v1/suppliers/{id}/settlements` (filterable by `date_from`, `date_to`, `payment_method`) in addition to `/profile` and `POST /settlements`.
3. **Warehouse Transfers**: Need distinct `POST /submit` (`DRAFT -> SUBMITTED`) separate from `POST /dispatch` (`IN_TRANSIT`), mandatory `Idempotency-Key` support on `/dispatch` & `/receive`, and item-level `discrepancy_type`, `rejected_quantity`, `evidence_attachment_ids` columns.
4. **Inventory Export Alias**: Add `GET /api/v1/inventory/exports/transactions` alongside `/movements`.
5. **Cheque Version Conflict Guard**: Enforce optimistic `version` check (`409 VERSION_CONFLICT`) on `PATCH /api/v1/cheques/{id}`.
6. **Treasury Accounts `PUT`**: Support `PUT /api/v1/treasury/accounts/{id}` in addition to `PATCH`.
7. **Initial Migration Endpoints (§10)**: Add canonical `POST /api/v1/sync/initial-migration`, `GET /api/v1/sync/initial-migration/{id}`, `POST /api/v1/sync/initial-migration/{id}/resume`, `POST /api/v1/sync/initial-migration/{id}/confirm` backed by `cloud_migration_sessions`.
8. **Subscriptions Plural Routes & Exact Entitlement Contract (§11)**: Support `/api/v1/subscriptions/*` alongside `/api/v1/subscription/*`; include `subscription_id`, `plan_id`, `plan_name`, `status`, `activated_at`, `expires_at`, `entitlement_version`, `enabled_features[]`, `feature_limits{}`, `server_time` + pull-fallback `GET /api/v1/subscriptions/entitlements/version`.
9. **Payment Gateways Priority, Expiry & Status Retrieval (§12)**: Add `priority` column on `payment_gateway_settings` (configurable in Admin Panel), enforce expired session guard (`410 PAYMENT_SESSION_EXPIRED`) on callback verification, and implement `retrieveStatus` across all 4 gateway adapters.
10. **Safe Deep-Link Return (§13)**: Strip `status=verified` from the App Link URL (`karvexa://payment/result?reference=<ref>` only) so Android NEVER trusts client-side URL flags and always queries the backend for authoritative status!

## 3. Non-Destructive Schema Migration Plan
- `ALTER TABLE invoice_payment_allocations ADD COLUMN contact_id UUID, ADD COLUMN cheque_id UUID`
- `ALTER TABLE stock_transfer_items ADD COLUMN quantity_rejected NUMERIC(18,4) DEFAULT 0, ADD COLUMN discrepancy_type VARCHAR(32), ADD COLUMN evidence_attachment_ids JSONB DEFAULT '[]'`
- `ALTER TABLE payment_gateway_settings ADD COLUMN priority INTEGER DEFAULT 10`
- Zero destructive drops; 100% backward compatible with existing data and Android v1.x clients.

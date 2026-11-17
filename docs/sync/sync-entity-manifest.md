# Business OS — Sync Entity Manifest (Master Prompt 07 §12 & §16)

All bidirectional entities synchronized over `POST /api/v1/sync/push` and `GET /api/v1/sync/pull`:

| Entity Type | PostgreSQL Table | PK | Org Scope | Version | Tombstone | Parent Dependencies | Push | Pull | Conflict Strategy | Immutable Fields | Required Permissions |
| --- | --- | :---: | :---: | :---: | :---: | --- | :---: | :---: | --- | --- | --- |
| `contact` | `contacts` | UUID | `organization_id` | `version` | `deleted_at` | `organization` | ✓ | ✓ | Field-diff Version Conflict | `id`, `organization_id`, `opening_balance` (after tx) | `contacts.create/update` |
| `product` | `products` | UUID | `organization_id` | `version` | `deleted_at` | `organization`, `unit` | ✓ | ✓ | Field-diff Version Conflict | `id`, `organization_id` | `catalog.create/update` |
| `product_variant` | `product_variants` | UUID | `organization_id` | `version` | `deleted_at` | `product` | ✓ | ✓ | Version Conflict | `id`, `product_id` | `catalog.create/update` |
| `warehouse` | `warehouses` | UUID | `organization_id` | `version` | `deleted_at` | `organization` | ✓ | ✓ | Version Conflict | `id`, `organization_id` | `inventory.confirm` |
| `branch` | `branches` | UUID | `organization_id` | `version` | `deleted_at` | `organization` | ✓ | ✓ | Version Conflict | `id`, `organization_id` | `org.settings.write` |
| `cost_center` | `cost_centers` | UUID | `organization_id` | `version` | `deleted_at` | `organization` | ✓ | ✓ | Version Conflict (soft-deactivate if used) | `id`, `code` (unique) | `accounting.cost_centers.*` |
| `account_code` | `accounts` | UUID | `organization_id` | `version` | `deleted_at` | `account_group` | ✓ | ✓ | Controlled Closure Only (System accounts protected) | `system_role`, `account_type` | `accounting.coa.manage` |
| `treasury_account` | `financial_accounts` | UUID | `organization_id` | `version` | `deleted_at` | `organization` | ✓ | ✓ | Metadata-only update (Balance server-authoritative!) | `balance` (never LWW) | `treasury.create` |
| `treasury_transaction` | `financial_transactions` | UUID | `organization_id` | `version` | `deleted_at` | `treasury_account` | CREATE | ✓ | Immutable (Reversal/Cancel command only) | `amount`, `account_id` | `treasury.create` |
| `cheque` | `cheques` | UUID | `organization_id` | `version` | `deleted_at` | `contact`, `treasury_account` | CREATE | ✓ | State-Machine Event Transitions Only | `amount`, `sayad_id` | `cheques.manage` |
| `journal_entry` | `journal_entries` | UUID | `organization_id` | `version` | None (Immutable) | `fiscal_year`, `account_code` | DRAFT CREATE | ✓ | Immutable once POSTED/CONFIRMED (`USE_LOCAL` forbidden) | All posted lines | `accounting.journal.create` |
| `sales` | `sales_invoices` | UUID | `organization_id` | `version` | Status `CANCELLED` | `contact`, `warehouse`, `product` | CREATE/CONFIRM | ✓ | Server Stock Lock (`STOCK_SHORTAGE` Conflict) | Confirmed totals & stock | `sales.create/confirm` |
| `purchase` | `purchase_invoices` | UUID | `organization_id` | `version` | Status `CANCELLED` | `contact`, `warehouse`, `product` | CREATE/CONFIRM | ✓ | Server Authoritative Confirm | Confirmed totals & stock | `purchases.create/confirm` |
| `consignment_document` | `consignment_documents` | UUID | `organization_id` | `version` | `deleted_at` | `contact`, `warehouse`, `product`, `related_document` | CREATE/CONFIRM | ✓ | Ownership & Consignment Balance Check | `ownership_scope` | `consignments.create/confirm` |
| `quick_cashflow` | `quick_transactions` | UUID | `organization_id` | `version` | `deleted_at` | `accounting_category`, `treasury_account`, `cost_center?` | CREATE | ✓ | Immutable once confirmed (Auto Journal) | `amount`, `journal_entry_id` | `treasury.create` |
| `personal_transaction` | `personal_transactions` | UUID | `organization_id` + `owner_user_id` | `version` | `deleted_at` | `personal_finance_profile` | CREATE/DELETE | ✓ | Strict Owner RBAC Isolation | `linked_withdrawal_id` | `personal_finance.manage` |
| `owner_withdrawal` | `owner_withdrawals` | UUID | `organization_id` + `owner_user_id` | `version` | `deleted_at` | `treasury_account` | CREATE | ✓ | Immutable (`DR Drawings 3201 / CR Cash-Bank`) | `amount`, `journal_entry_id` | `personal_finance.manage` |
| `employee` | `employees` | UUID | `organization_id` | `version` | `deleted_at` | `organization`, `role` | ✓ | ✓ | Server-authoritative RBAC validation | `user_id` | `employees.manage` |

# Business OS — Architecture Decision Records (ADRs)

## ADR-001: Modular Monolith with Shared Accounting & Inventory Core
- **Decision**: Maintain a single Modular Monolith codebase with isolated domain boundaries (`auth`, `organizations`, `contacts`, `inventory`, `commerce`, `treasury`, `accounting`, `personal-finance`, `subscription`, `sync`, `advanced`).
- **Rationale**: Eliminates distributed transaction hazards across accounting vouchers, stock ledger locks, and multi-payment allocations while preserving clean module separation.

## ADR-002: Strict Separation of Personal Finance Ledger vs Business P&L
- **Decision**: Owner withdrawals post `DR Owner Drawings (3201, Equity/Contra-Equity) / CR Cash or Bank`. Personal expenses live in `personal_transactions` (linked optionally via `linked_withdrawal_id`) and NEVER debit business operating expenses (`5xxx`).
- **Rationale**: Prevents personal living costs from distorting business profitability, taxes, and financial statements.

## ADR-003: Variant-Level Stock Ledger with Parent Projection
- **Decision**: `stock_ledger.variant_id` is nullable; base products track with `variant_id IS NULL`, while variant products track independently per `(organization_id, warehouse_id, product_id, variant_id)` under `pg_advisory_xact_lock`. Parent product stock is calculated strictly as the projection sum of its variants.

## ADR-004: Multi-Dimensional Invoice Status Model
- **Decision**: Sales invoices maintain 5 independent status columns (`status` commercial, `payment_status`, `accounting_status`, `stock_status`, `sync_status`) instead of overloading a single status enum.

## ADR-005: Automatic Account Mapping Fail-Safe
- **Decision**: Quick Expense/Income requires an active `category_account_mappings` row. If missing, the API fails explicitly with `422 CATEGORY_ACCOUNT_MAPPING_MISSING` rather than posting to an arbitrary suspense account.

## ADR-006: Strict Action-Level RBAC Without Unsafe Aliases
- **Decision**: `reports.profit.view`, `personal_finance.view`, `personal_finance.manage`, and `employees.manage` are NEVER aliased to broad read permissions. Every unauthorized access attempt logs a `SECURITY` audit record.

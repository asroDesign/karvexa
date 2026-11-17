# Karvexa Business OS — Multi-Row Journal Entry & Jalali Date Contract

- **Endpoint**: `POST /api/v1/accounting/journal-entries`
- **Fields**: `document_number` (server-assigned sequence per org+FY), `description`, `document_date` (canonical Gregorian `YYYY-MM-DD`) OR `document_date_jalali` (e.g., `1404/06/15`), `reference_type`, `reference_id`, `confirm_immediately`, `lines[]` (minimum 2 rows: `account_id`, `debit`, `credit`, `contact_id?`, `cost_center_id?`, `description?`).
- **Validation**:
  - `SUM(debit) == SUM(credit)` strictly verified via fixed-point BigInt Decimal arithmetic (`409 ACCOUNTING_UNBALANCED`).
  - Active postable account, open/unlocked accounting period, open fiscal year, and `accounting.journal.create` / `accounting.journal.confirm` permissions enforced server-side.
  - Response includes both `document_date` (`YYYY-MM-DD`) and `document_date_jalali` (`YYYY/MM/DD`).

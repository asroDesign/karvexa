# Karvexa Business OS — Treasury Accounts & Controlled Cheque Editing Contract

## 1. Treasury Accounts (`GET/POST/PATCH/DELETE /api/v1/treasury/accounts`)
- **Account Types**: `CASH` (alias `CASHBOX`), `BANK`, `CARD_TERMINAL` (alias `POS`), `WALLET`, `OTHER_TREASURY`.
- **Fields**: `id`, `organization_id`, `name`, `account_type`, `bank_name`, `account_number`, `iban`, `currency`, `opening_balance`, `balance` (current balance), `is_active`.
- **Transaction History**: `GET /api/v1/treasury/accounts/{id}/transactions?date_from=&date_to=&tx_type=` returns `opening_balance`, `current_balance`, and filtered `financial_transactions`.
- **Immutability & Deletion Guard**:
  - `PATCH /api/v1/treasury/accounts/{id}` edits ONLY metadata (`name`, `bank_name`, `account_number`, `iban`, `is_active`) — NEVER overwrites `balance` or historical transactions.
  - `DELETE /api/v1/treasury/accounts/{id}` rejects accounts with any `financial_transactions` or `invoice_payment_allocations` (`409 TREASURY_ACCOUNT_HAS_HISTORY`).

## 2. Controlled Cheque Editing (`PATCH /api/v1/cheques/{id}`)
- **Editable Fields**: `amount`, `cheque_number`, `serial_number`, `bank_name`, `branch_name`, `account_number`, `drawer_name`, `recipient_name`, `issue_date` (`issue_date_jalali`), `due_date` (`due_date_jalali`), `contact_id`, `related_document_type`, `related_document_id`, `notes`.
- **Financial Immutability Rules**:
  - **DRAFT / Unposted Cheque** (`status === 'DRAFT'` or no linked `journal_entry_id`): editable directly with full before/after audit log.
  - **Posted / Active Cheque** (`RECEIVED`, `ISSUED`, `IN_CUSTODY`, `DEPOSITED`, `IN_COLLECTION`): changing non-financial metadata (e.g., `notes`, `branch_name`) is audited; changing financial fields (`amount`, `due_date`, `cheque_number`, `bank_name`) requires `correction_reason` (min 5 chars), records a `cheque_events` `AMENDED` record + `audit_logs` before/after diff, and if `amount` changed posts a balanced adjustment journal entry!
  - **Settled / Terminal Cheque** (`CLEARED`, `CASHED`, `CANCELLED`): financial edits are STRICTLY BLOCKED (`409 CHEQUE_FINANCIALLY_SETTLED`).

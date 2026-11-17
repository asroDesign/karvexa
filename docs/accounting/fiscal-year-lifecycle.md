# Business OS — Chart of Accounts, Account Closure & Fiscal Year Lifecycle

## 1. Strict Separation of Operations (`/api/v1/fiscal/*`)
1. **Create Account (`POST /api/v1/fiscal/accounts`)**: Supports 4 hierarchical levels (`1=Group, 2=GL, 3=Subsidiary, 4=Detail`), unique code per organization, and `is_postable` guard.
2. **Opening Balances (`POST /api/v1/fiscal/opening-balances`)**: Always recorded via an idempotent, balanced `OPENING` journal voucher (`SUM(debit) == SUM(credit)`). Never directly mutates balance columns.
3. **Account Closure (`GET /accounts/{id}/closure-preview` & `POST /accounts/{id}/close`)**:
   - Accounts with historical activity are NEVER deleted.
   - Closing an account with a non-zero balance under `CLOSE_ONLY` is rejected (`409 ACCOUNT_BALANCE_NON_ZERO`).
   - Selecting `action_type = 'TRANSFER'` atomically posts a balanced balance-transfer voucher to `destination_account_id`, records `account_closures`, marks `account_status = 'CLOSED'` & `is_active = false`, preserves historical reports, and rejects any future postings (`409 ACCOUNT_CLOSED`).

## 2. Fiscal Year Opening, Closing, Carry-Forward & Reopening
1. **Pre-Closing Checklist (`GET /years/{id}/closing-checklist`)**: Evaluates Trial Balance equality (critical), Retained Earnings account configuration (critical), unposted draft journals (warning), unfinalized invoices (warning), and inventory valuation.
2. **Closing Preview (`GET /years/{id}/closing-preview`)**: Displays exact nominal balances (`REVENUE`, `EXPENSE`, `COGS`), computed Net Profit/Loss, and balanced closing journal lines into configured `RETAINED_EARNINGS` (`3301`).
3. **Execute Fiscal Year Closing (`POST /years/{id}/close`)**:
   - Idempotent via `Idempotency-Key`.
   - Posts immutable `CLOSING` journal closing all temporary Revenue & Expense accounts to `RETAINED_EARNINGS`.
   - Snapshots permanent (`ASSET`, `LIABILITY`, `EQUITY`) closing balances into `fiscal_year_closings.carry_forward_snapshot`.
   - Locks the Fiscal Year (`CLOSED`) and all its `accounting_periods` (`CLOSED`), blocking ordinary postings (`409 FISCAL_YEAR_CLOSED`).
4. **Next Fiscal Year Opening (`POST /years/{id}/prepare-next`)**:
   - Creates next Fiscal Year linked via `previous_fiscal_year_id`.
   - Posts balanced `OPENING` journal referencing `previous_fiscal_year.closing_journal_id`, carrying forward **ONLY Permanent Accounts (`ASSET`, `LIABILITY`, `EQUITY` including Retained Earnings)** — **ZERO nominal Revenue or Expense balances carried forward!**
5. **Controlled Auditable Reopening (`POST /years/{id}/reopen`)**:
   - Requires `accounting.fiscal.reopen` permission and mandatory `reason`.
   - Blocks unsafe reopening if next fiscal year already has posted operational transactions (`409 NEXT_FISCAL_YEAR_HAS_ACTIVITY`).
   - Reverses the closing journal via an immutable reversal voucher (NEVER deletes the closing journal!), transitions FY to `REOPENED`, and logs a `SECURITY` audit record.

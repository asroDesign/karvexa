# Business OS — Personal Finance Ledger, Owner Withdrawals & Recurring Obligations

## 1. Accounting Separation Invariant
- **Owner Withdrawal (`POST /api/v1/personal-finance/withdrawals`)**:
  - `DR 3201 Owner Withdrawals / Drawings (Equity, Normal Balance: DEBIT)`
  - `CR 1101 Cash / 1102 Bank`
  - **Zero impact on Business Operating Expenses (`5xxx`) or Business Net Profit.**
- **Owner Contribution (`POST /api/v1/personal-finance/contributions`)**:
  - `DR 1101 Cash / 1102 Bank`
  - `CR 3201 Owner Withdrawals / Drawings`
- **Personal Expenses (`POST /api/v1/personal-finance/transactions`)**:
  - Recorded strictly in `personal_transactions`.
  - May reference `linked_withdrawal_id` to trace how a withdrawal was spent (e.g., 3,000,000 IRR Household + 2,000,000 IRR Loan Installment linked to 5,000,000 IRR Withdrawal) with zero double counting.
  - If paid directly from `BUSINESS_CASH` or `BUSINESS_BANK` without an existing withdrawal, the server automatically creates the linked `owner_withdrawals` record + `DR Drawings / CR Cash` journal.

## 2. Recurring Obligations (`POST /api/v1/personal-finance/recurring`)
- Creating a recurring obligation registers its schedule (`DAILY | WEEKLY | MONTHLY | QUARTERLY | ANNUALLY | CUSTOM`) and `obligation_status = 'DUE'` WITHOUT automatically posting a payment or accounting journal.
- Paying via `POST /api/v1/personal-finance/recurring/{id}/pay` requires `Idempotency-Key` so retries never generate duplicate expenses or journals, advances `next_due_date`, and posts the linked accounting entry if funded from business accounts.

## 3. Access Control & Privacy
- Strictly gated by `personal_finance.view` / `personal_finance.manage` AND scoped by `(organization_id, owner_user_id)`. Sales, warehouse, and accountant employees cannot read or mutate owner personal finance records.

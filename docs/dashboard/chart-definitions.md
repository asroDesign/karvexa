# Business OS — Financial Dashboard Metrics & 3 Daily Charts Specification

## 1. Authoritative Calculation Rules (`/api/v1/dashboard/*`)
All dashboard metrics and charts derive strictly from PostgreSQL authoritative records scoped to `(organization_id)` and user permissions:

1. **Daily Revenue Chart (`GET /api/v1/dashboard/charts/revenue`)**:
   - **Default (`metric=recognized_revenue`)**: Sums `(credit - debit)` from posted `journal_entry_lines` on `REVENUE` accounts grouped by `entry_date`, excluding year-end `CLOSING` vouchers.
   - **Invariant**: Subsequent cash settlements of previous customer receivables (`DR Bank / CR AR`) DO NOT credit `REVENUE`, so they are NEVER falsely counted as newly recognized sales revenue!
   - **Optional (`metric=cash_received`)**: Switches to treasury inflow receipts (`financial_transactions` where `tx_type IN ('RECEIPT', 'INCOME')`).
2. **Daily Sales Chart (`GET /api/v1/dashboard/charts/sales`)**:
   - Aggregates ONLY `CONFIRMED` / `FINALIZED` `sales_invoices` grouped by `invoice_date`, subtracting `sales_returns` grouped by `return_date`.
   - Reports `invoices_count`, `gross_sales`, `discounts`, `returns`, `net_sales`, and `avg_invoice_value`. Draft and cancelled invoices are excluded.
3. **Daily Business Expense Chart (`GET /api/v1/dashboard/charts/expenses`)**:
   - Sums `(debit - credit)` from posted `journal_entry_lines` on `EXPENSE` accounts excluding `COGS` and `CLOSING` entries.
   - **Personal Finance Isolation**: Owner withdrawals (`3201` Equity) and `personal_transactions` NEVER appear in business operating expenses. Authorized owners (`personal_finance.view`) may optionally toggle `include_personal=true` to inspect a clearly separated secondary series.
4. **Interactive Drill-Down (`GET /api/v1/dashboard/charts/drilldown?metric=...&date=YYYY-MM-DD`)**:
   - Clicking any day point retrieves the exact underlying confirmed sales invoices or posted accounting journal lines for that date.

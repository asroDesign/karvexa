# Business OS — Master Prompt 05 Journal Posting Rules & Financial Integrity

Every confirmed financial event generates an atomic, balanced (`SUM(debit) == SUM(credit)`) double-entry journal voucher:

| Event | Debit Line(s) | Credit Line(s) |
| --- | --- | --- |
| **Mixed-Payment Sales Confirm** | Cash/POS/Bank (allocated payments), AR `1201` (unpaid balance), Sales Discount `4109` (if > 0), COGS `5101` | Sales Revenue `4101`, Tax Payable `2301` (if > 0), Inventory `1301` |
| **Subsequent Customer Payment** | Cash `1101` / Bank `1102` / POS | Accounts Receivable `1201` (linked to `contact_id`) |
| **Purchase Invoice Confirm** | Inventory `1301` | Accounts Payable `2101` (linked to `supplier_id`) |
| **Opening Stock Document** | Inventory `1301` | Owner Capital `3101` |
| **Quick Expense (Auto-Mapped)** | Mapped Expense Account (e.g., Transport `5202`, Rent `5203`) + Tax (if applicable) | Treasury Account GL (`1101` / `1102`) |
| **Quick Income (Auto-Mapped)** | Treasury Account GL (`1101` / `1102`) | Mapped Revenue Account (e.g., Service Revenue `4102`) + Tax Payable `2301` |
| **Owner Withdrawal** | Owner Drawings `3201` (Equity — NOT Operating Expense) | Business Cash `1101` / Bank `1102` |
| **Owner Contribution** | Business Cash `1101` / Bank `1102` | Owner Drawings `3201` |
| **Cheque Received (Receivable)** | Receivable Cheques `1202` | Accounts Receivable `1201` |
| **Cheque Deposited / In Collection** | Cheques In Collection `1203` | Receivable Cheques `1202` |
| **Cheque Cleared (Receivable)** | Bank `1102` (+ Treasury Bank balance update) | Cheques In Collection `1203` (or `1202`) |
| **Cheque Returned (Bounced)** | Accounts Receivable `1201` | Cheques In Collection `1203` (or `1202`) |

## Accounting Books & Exports
- `GET /api/v1/accounting/journal-book` + `GET /api/v1/accounting/journal-book/export` (Real `.xlsx` Excel binary workbook)
- `GET /api/v1/accounting/general-ledger`, `/subsidiary-ledger`, `/detail-ledger`
- `GET /api/v1/accounting/trial-balance`, `/balance-sheet`, `/profit-loss` (`reports.profit.view` required)

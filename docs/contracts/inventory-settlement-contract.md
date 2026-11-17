# Karvexa Business OS — Inventory, Receipts, Transfers, Sales Settlement & Supplier Settlement Contract

**Contract Version**: `v1.3.0` (Master Prompt 08)

## 1. Sales Invoice Mixed Settlements (§2.1 & §2.2)
- **Canonical Endpoint**: `POST /api/v1/sales/{id}/confirm` (or inline allocations)
- **Supported `payment_method` values**:
  - `CASH`, `BANK` (alias `BANK_TRANSFER`), `CARD_TERMINAL` (alias `POS`), `CHEQUE`, `CREDIT`, `ACCOUNT_BALANCE`
- **Rules**:
  1. When `CREDIT` or `ACCOUNT_BALANCE` is present, `customer_id` (real Contact) MUST be bound and remaining balance posts to `contact_transactions` + `accounts_receivable`.
  2. When `CHEQUE` is present, allocation may include `cheque: { cheque_number, serial_number, bank_name, branch_name?, drawer_name?, issue_date?, due_date | due_date_jalali }`. Multiple cheques + cash + bank + credit in one invoice are supported.
  3. Sum of non-credit immediate allocations + cheques must not exceed `grand_total` (`422 OVERPAYMENT_NOT_ALLOWED`). Remaining unpaid amount automatically posts to `AR`.
  4. **Invoice Form Layout Order**: (1) Customer selector + quick-create modal, (2) Items, (3) Total tax, (4) Overall discount, (5) Shipping cost, (6) Advanced details, (7) Mixed settlements.

## 2. Incoming Warehouse Receipt & Landed Costing (§2.3)
- **Canonical Endpoint**: `POST /api/v1/inventory/receipts` (and `GET /api/v1/inventory/receipts`)
- **Required & Optional Fields**:
  - `warehouse_id`, `supplier_id` (from Contacts), `supplier_invoice_number` (**mandatory**), `invoice_date` (or `invoice_date_jalali`), `shipping_cost`, `customs_and_extra_cost`, `supplier_discount`, `payment_bank_account_id`, `paid_amount`, `attachment_url`, `items[]` (`product_id`, `variant_id?`, `quantity`, `unit_price`).
- **Landed Cost Allocation Rule (Decimal-Safe)**:
  - `gross_items_total = SUM(quantity * unit_price)`
  - `net_acquisition_cost = gross_items_total + shipping_cost + customs_and_extra_cost - supplier_discount`
  - Each item receives proportional landed unit cost: `effective_unit_cost = (line_gross / gross_items_total) * net_acquisition_cost / quantity` (stored in `stock_ledger.unit_cost` & `value_delta`).
  - `remaining_payable = net_acquisition_cost - paid_amount`
  - **Double-Entry Accounting**:
    - `DR Inventory (1301): net_acquisition_cost`
    - `CR Treasury Bank/Cash (if paid_amount > 0): paid_amount`
    - `CR Accounts Payable (2101, contact_id = supplier_id, if remaining_payable > 0): remaining_payable`

## 3. Multi-Item Warehouse Transfers & Independent Partial Receiving (§2.4)
- **Lifecycle**: `DRAFT -> SUBMITTED -> IN_TRANSIT -> PARTIALLY_RECEIVED | RECEIVED | DISCREPANCY_REPORTED -> COMPLETED`
- **Endpoints**:
  - `POST /api/v1/inventory/transfers` (creates multi-item transfer with `source_warehouse_id`, `destination_warehouse_id`, `reason`, `source_responsible_name`, `destination_responsible_name`, `items[]`; optional `dispatch_immediately: true` moves to `IN_TRANSIT`).
  - `POST /api/v1/inventory/transfers/{id}/dispatch` (submits & issues stock OUT of source warehouse into `IN_TRANSIT` — zero duplication!).
  - `POST /api/v1/inventory/transfers/{id}/receive` (destination operator enters per-item `accepted_qty`, `missing_qty`, `damaged_qty`, `discrepancy_note`, `evidence_url`; **ONLY `accepted_qty` is added to destination `stock_ledger`**, discrepancies are logged cleanly without forcing full-transfer rejection!).
  - `POST /api/v1/inventory/transfers/{id}/complete` (finalizes transfer reconciliation).

## 4. Physical Acceptance on Sales Returns (§2.5)
- `POST /api/v1/sales/{id}/return` supports per-item `accepted_qty` (physically restocked to `stock_ledger`), `damaged_qty` (recorded separately as damaged/non-sellable — NEVER inflated into sellable stock), and `physically_received` boolean.

## 5. Supplier Accounts & Settlements (§2.6)
- `GET /api/v1/suppliers/{id}/profile` (purchase invoices, receipts, debts/credits, settlement history, live balance)
- `POST /api/v1/suppliers/{id}/settlements` (`Idempotency-Key`, records Treasury Payment + `contact_transactions` debit + balanced `DR AP / CR Cash-Bank` journal).

## 6. Inventory Excel Exports (§2.7)
- `GET /api/v1/inventory/exports/stock` (`.xlsx` filtered by `warehouse_id`, `product_id`, `category_id`, `stock_status`)
- `GET /api/v1/inventory/exports/movements` (`.xlsx` filtered by `warehouse_id`, `product_id`, `category_id`, `movement_type`, `date_from`, `date_to`)

-- Preserve purchase line discounts and tax allocations for exact returns.
-- Safe to apply repeatedly; the application schema also declares these columns.
ALTER TABLE purchase_invoice_items
  ADD COLUMN IF NOT EXISTS discount_amount numeric(18, 2) NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS tax_rate numeric(8, 2) NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS tax_amount numeric(18, 2) NOT NULL DEFAULT 0.00;

-- Existing confirmed invoices only stored header totals. Keep their per-line
-- return allocation compatible by leaving these columns at zero; the return
-- service proportionally allocates legacy header discount/tax when all rows
-- have zero snapshots.

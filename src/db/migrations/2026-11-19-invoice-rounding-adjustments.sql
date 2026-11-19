ALTER TABLE purchase_invoices
  ADD COLUMN IF NOT EXISTS rounding_adjustment numeric(18, 2) NOT NULL DEFAULT 0.00;

ALTER TABLE sales_invoices
  ADD COLUMN IF NOT EXISTS rounding_adjustment numeric(18, 2) NOT NULL DEFAULT 0.00;

-- Preserve invoice tax and the payment receipt tracking number on warehouse receipts.
ALTER TABLE stock_documents
  ADD COLUMN IF NOT EXISTS tax_amount numeric(18, 2) NOT NULL DEFAULT 0.00;

ALTER TABLE stock_documents
  ADD COLUMN IF NOT EXISTS payment_tracking_number varchar(80);

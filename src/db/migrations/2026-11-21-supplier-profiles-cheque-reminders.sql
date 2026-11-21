-- Persist supplier-specific commercial profile and cheque reminder/reference metadata.
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS supplier_category varchar(100),
  ADD COLUMN IF NOT EXISTS supplier_settlement_method varchar(24),
  ADD COLUMN IF NOT EXISTS supplier_payment_due_days integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS supplier_delivery_lead_time_days integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS supplier_bank_name varchar(100),
  ADD COLUMN IF NOT EXISTS supplier_card_number varchar(32),
  ADD COLUMN IF NOT EXISTS supplier_sheba varchar(32),
  ADD COLUMN IF NOT EXISTS supplier_bank_account_number varchar(64);

ALTER TABLE cheques
  ADD COLUMN IF NOT EXISTS reference_document_number varchar(120),
  ADD COLUMN IF NOT EXISTS reminder_date_epoch bigint;

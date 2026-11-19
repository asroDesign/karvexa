-- Preserve the exact product variant audited during a stock count or adjustment.
ALTER TABLE stock_count_items
  ADD COLUMN IF NOT EXISTS variant_id uuid;

CREATE INDEX IF NOT EXISTS idx_stock_count_items_variant
  ON stock_count_items (organization_id, variant_id);

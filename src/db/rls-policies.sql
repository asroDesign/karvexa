-- Business OS PostgreSQL Row Level Security (RLS) Policies
-- Enables database-level multi-tenant isolation bound to `app.current_org_id`
-- and allows platform admin bypass ONLY when `app.bypass_rls = 'on'` inside verified server transactions.

DO $$
DECLARE
  tbl TEXT;
  tenant_tables TEXT[] := ARRAY[
    'contacts', 'contact_groups', 'contact_addresses', 'contact_accounts', 'contact_transactions',
    'categories', 'brands', 'units', 'products', 'product_units', 'barcodes', 'product_prices',
    'account_groups', 'accounts', 'fiscal_years', 'accounting_periods', 'cost_centers',
    'journal_entries', 'journal_entry_lines', 'opening_balances',
    'warehouses', 'stock_documents', 'stock_document_items', 'stock_ledger',
    'stock_reservations', 'stock_counts', 'stock_count_items', 'stock_transfers',
    'purchase_orders', 'purchase_invoices', 'purchase_invoice_items', 'purchase_returns',
    'sales_orders', 'sales_invoices', 'sales_invoice_items', 'sales_returns',
    'financial_accounts', 'cashboxes', 'financial_transactions', 'bank_reconciliations',
    'cheques', 'cheque_events', 'cheque_assignments',
    'consignment_documents', 'consignment_items', 'consignor_settlements',
    'devices', 'sync_batches', 'sync_events', 'sync_conflicts', 'sync_checkpoints',
    'sync_inbox', 'sync_change_log', 'sync_logs',
    'subscriptions', 'entitlements', 'payment_transactions', 'purchase_receipts',
    'personal_finance_profiles', 'personal_accounts', 'personal_expense_categories',
    'owner_withdrawals', 'owner_contributions', 'personal_transactions', 'personal_recurring_transactions',
    'invoice_payment_allocations', 'quotations', 'quotation_items',
    'accounting_categories', 'category_account_mappings', 'quick_transactions',
    'product_variants', 'warehouse_stock_thresholds', 'purchase_suggestions', 'purchase_order_items',
    'loyalty_accounts', 'loyalty_transactions', 'employees', 'report_export_jobs',
    'account_closures', 'fiscal_year_closings', 'user_invitations',
    'accounting_policies', 'branches', 'sales_return_items', 'purchase_return_items', 'consignment_ledger',
    'stock_transfer_items', 'organization_operating_modes', 'cloud_migration_sessions', 'payment_orders'
  ];
BEGIN
  FOREACH tbl IN ARRAY tenant_tables
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', tbl);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_policy ON %I;', tbl);
    EXECUTE format(
      'CREATE POLICY tenant_isolation_policy ON %I USING (
         current_setting(''app.bypass_rls'', true) = ''on''
         OR organization_id::text = current_setting(''app.current_org_id'', true)
       ) WITH CHECK (
         current_setting(''app.bypass_rls'', true) = ''on''
         OR organization_id::text = current_setting(''app.current_org_id'', true)
       );',
      tbl
    );
  END LOOP;
END $$;

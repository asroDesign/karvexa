# Business OS — Cross-Layer Field Mapping (Android Kotlin <-> REST JSON <-> PostgreSQL)

Zero discrepancy policy: every field maps 1:1 across Android Room/Kotlin DTOs, snake_case REST API JSON, and PostgreSQL columns.

| Entity | REST API (`snake_case`) | PostgreSQL Column | PostgreSQL Type | Android Kotlin Type | Notes |
| --- | --- | --- | --- | --- | --- |
| All | `id` | `id` | `UUID` | `String` (UUID) | Primary Key |
| All Tenant | `organization_id` | `organization_id` | `UUID NOT NULL` | `String` | RLS & Tenant Guard |
| Documents | `client_document_id` | `client_document_id` | `UUID NULL` | `String?` | Offline idempotent creation |
| Organization | `base_currency` | `base_currency` | `VARCHAR(10)` | `String` | No implicit IRR/IRT conversion |
| Organization | `currency_scale` | `currency_scale` | `INTEGER` | `Int` | Default `2` |
| Contact | `display_name` | `name` | `VARCHAR(180)` | `String` | Display title |
| Contact | `type` | `contact_type` | `VARCHAR(24)` | `ContactType` enum | `CUSTOMER\|SUPPLIER\|BOTH\|EMPLOYEE\|OTHER` |
| Contact | `credit_limit` | `credit_limit` | `NUMERIC(18,2)` | `BigDecimal` / `String` | Decimal String in JSON |
| Product | `code` | `sku` | `VARCHAR(64)` | `String` | Unique per org |
| Product | `item_type` | `product_type` | `VARCHAR(24)` | `ItemType` enum | `PRODUCT\|SERVICE\|RAW_MATERIAL\|FINISHED_PRODUCT` |
| Product | `purchase_price` | `default_purchase_price` | `NUMERIC(18,2)` | `BigDecimal` | Decimal String |
| Product | `sale_price` | `default_sale_price` | `NUMERIC(18,2)` | `BigDecimal` | Decimal String |
| Product | `tax_rate` | `tax_rate` | `NUMERIC(8,2)` | `BigDecimal` | Decimal String (`"10.00"`) |
| Invoice | `document_number` | `invoice_number` | `VARCHAR(48)` | `String` | Sequential per org |
| Invoice | `document_date` | `invoice_date` | `DATE` | `LocalDate` (`YYYY-MM-DD`) | Business date, no time |
| Invoice | `grand_total` | `total_amount` | `NUMERIC(18,2)` | `BigDecimal` | Decimal String |
| Journal | `document_number` | `entry_number` | `INTEGER` | `Int` | Unique per org + fiscal year |
| Journal Line | `debit` / `credit` | `debit` / `credit` | `NUMERIC(18,2)` | `BigDecimal` | Exact scale-2 Decimal String |
| Stock Ledger | `quantity_delta` | `quantity_delta` | `NUMERIC(18,4)` | `BigDecimal` | Exact scale-4 Decimal String |
| Cheque | `cheque_number` | `sayad_id` | `VARCHAR(32)` | `String` | Unique Sayad ID per org |
| Cheque | `status` | `status` | `VARCHAR(24)` | `ChequeStatus` enum | `RECEIVED\|ISSUED\|ENDORSED\|DEPOSITED\|CASHED\|BOUNCED\|CANCELLED` |

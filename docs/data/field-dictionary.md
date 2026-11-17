# Business OS — Shared Field Dictionary (Backend + Admin Panel + Android)

This dictionary is the single source of truth for field names, Persian labels, types, validations, relations, permissions, API endpoints, and error codes shared between Backend, Admin Panel, and the Android offline client.

---

## 1. Organization (`organizations`) — `/api/v1/platform/organizations`
| Technical Name | عنوان فارسی | Type | Required | Default | Validation | Relation | Permission | Error Code |
| --- | --- | --- | :---: | --- | --- | --- | --- | --- |
| `name` | نام کسب‌وکار | string | ✓ | — | min:2, max:120 | — | `platform.organizations.write` | `ORG_NAME_INVALID` |
| `legal_name` | نام حقوقی رسمی | string | ✗ | null | max:180 | — | `platform.organizations.write` | `ORG_LEGAL_NAME_INVALID` |
| `business_type` | نوع کسب‌وکار | enum | ✓ | `RETAIL` | `RETAIL\|WHOLESALE\|SERVICES\|MANUFACTURING\|DISTRIBUTION` | — | `platform.organizations.write` | `ORG_TYPE_INVALID` |
| `economic_code` | کد اقتصادی | string | ✗ | null | regex `^[0-9]{10,14}$` | — | `platform.organizations.write` | `ORG_ECONOMIC_CODE_INVALID` |
| `national_id` | شناسه ملی | string | ✗ | null | regex `^[0-9]{10,11}$` | — | `platform.organizations.write` | `ORG_NATIONAL_ID_INVALID` |
| `phone` | تلفن تماس | string | ✗ | null | max:30 | — | `org.settings.write` | `PHONE_INVALID` |
| `email` | ایمیل سازمان | email | ✗ | null | valid email | — | `org.settings.write` | `EMAIL_INVALID` |
| `address` | نشانی کامل | text | ✗ | null | max:500 | — | `org.settings.write` | `ADDRESS_TOO_LONG` |
| `fiscal_year_start` | شروع سال مالی | string | ✓ | `01-01` | MM-DD | — | `org.settings.write` | `FISCAL_START_INVALID` |
| `base_currency` | ارز پایه | enum | ✓ | `IRR` | `IRR\|IRT\|USD\|EUR\|AED` | — | `org.settings.write` | `CURRENCY_INVALID` |
| `timezone` | منطقه زمانی | string | ✓ | `Asia/Tehran` | IANA TZ | — | `org.settings.write` | `TIMEZONE_INVALID` |
| `status` | وضعیت سازمان | enum | ✓ | `ACTIVE` | `ACTIVE\|SUSPENDED\|ARCHIVED` | — | `platform.organizations.write` | `ORG_STATUS_INVALID` |

---

## 2. Journal Entry (`journal_entries` & `journal_entry_lines`) — `/api/v1/org/accounting/journals`
| Technical Name | عنوان فارسی | Type | Required | Default | Validation | Relation | Permission | Error Code |
| --- | --- | --- | :---: | --- | --- | --- | --- | --- |
| `fiscal_year_id` | سال مالی | uuid | ✓ | active FY | must belong to org | `fiscal_years.id` | `accounting.write` | `FISCAL_YEAR_NOT_FOUND` |
| `accounting_period_id` | دوره مالی | uuid | ✓ | open period | must be `OPEN` on post | `accounting_periods.id` | `accounting.post` | `ACCOUNTING_PERIOD_CLOSED` |
| `entry_number` | شماره سند | integer | auto | sequence+1 | unique per org+FY | — | `accounting.write` | `ENTRY_NUMBER_CONFLICT` |
| `entry_date` | تاریخ سند | date | ✓ | today | ISO YYYY-MM-DD | — | `accounting.write` | `ENTRY_DATE_INVALID` |
| `description` | شرح سند | string | ✓ | — | min:3, max:500 | — | `accounting.write` | `DESCRIPTION_REQUIRED` |
| `status` | وضعیت سند | enum | auto | `DRAFT` | `DRAFT\|POSTED\|REVERSED` | — | `accounting.post` | `ACCOUNTING_ENTRY_IMMUTABLE` |
| `lines[].account_id` | حساب معین | uuid | ✓ | — | must belong to org & be postable | `accounts.id` | `accounting.write` | `ACCOUNT_NOT_FOUND` |
| `lines[].debit` | بدهکار | decimal(18,2) | ✓ | `0.00` | `>= 0`, string numeric | — | `accounting.write` | `AMOUNT_INVALID` |
| `lines[].credit` | بستانکار | decimal(18,2) | ✓ | `0.00` | `>= 0`, mutually exclusive with debit | — | `accounting.write` | `ACCOUNTING_UNBALANCED` |
| `lines[].cost_center_id` | مرکز هزینه | uuid | ✗ | null | must belong to org | `cost_centers.id` | `accounting.write` | `COST_CENTER_NOT_FOUND` |

---

## 3. Product (`products`) — `/api/v1/org/catalog/products`
| Technical Name | عنوان فارسی | Type | Required | Default | Validation | Relation | Permission | Error Code |
| --- | --- | --- | :---: | --- | --- | --- | --- | --- |
| `sku` | کد کالا (SKU) | string | ✓ | — | unique per org, max:64 | — | `catalog.write` | `PRODUCT_SKU_DUPLICATE` |
| `name` | نام کالا | string | ✓ | — | min:2, max:180 | — | `catalog.write` | `PRODUCT_NAME_REQUIRED` |
| `product_type` | نوع کالا | enum | ✓ | `GOODS` | `GOODS\|SERVICE\|CONSIGNMENT` | — | `catalog.write` | `PRODUCT_TYPE_INVALID` |
| `category_id` | دسته‌بندی | uuid | ✗ | null | must belong to org | `categories.id` | `catalog.write` | `CATEGORY_NOT_FOUND` |
| `brand_id` | برند | uuid | ✗ | null | must belong to org | `brands.id` | `catalog.write` | `BRAND_NOT_FOUND` |
| `base_unit_id` | واحد پایه | uuid | ✓ | — | must belong to org | `units.id` | `catalog.write` | `UNIT_NOT_FOUND` |
| `costing_method` | روش ارزش‌گذاری | enum | ✓ | `WEIGHTED_AVERAGE` | `FIFO\|WEIGHTED_AVERAGE` | — | `catalog.write` | `COSTING_METHOD_INVALID` |
| `default_sale_price` | قیمت فروش پایه | decimal(18,2) | ✓ | `0.00` | `>= 0` | — | `catalog.write` | `PRICE_INVALID` |
| `default_purchase_price` | قیمت خرید پایه | decimal(18,2) | ✓ | `0.00` | `>= 0` | — | `catalog.write` | `PRICE_INVALID` |
| `barcode` | بارکد اصلی | string | ✗ | null | unique per org | `barcodes` | `catalog.write` | `BARCODE_DUPLICATE` |

---

## 4. Warehouse Transfer (`stock_transfers`) — `/api/v1/org/inventory/transfers`
| Technical Name | عنوان فارسی | Type | Required | Default | Validation | Relation | Permission | Error Code |
| --- | --- | --- | :---: | --- | --- | --- | --- | --- |
| `source_warehouse_id` | انبار مبدأ | uuid | ✓ | — | must belong to org | `warehouses.id` | `inventory.write` | `WAREHOUSE_NOT_FOUND` |
| `target_warehouse_id` | انبار مقصد | uuid | ✓ | — | `!= source_warehouse_id` | `warehouses.id` | `inventory.write` | `TRANSFER_SAME_WAREHOUSE` |
| `product_id` | کالا | uuid | ✓ | — | must belong to org | `products.id` | `inventory.write` | `PRODUCT_NOT_FOUND` |
| `quantity` | مقدار انتقال | decimal(18,4) | ✓ | — | `> 0`, respects negative stock policy | — | `inventory.write` | `INVENTORY_NEGATIVE_STOCK_BLOCKED` |
| `transfer_date` | تاریخ انتقال | date | ✓ | today | ISO YYYY-MM-DD | — | `inventory.write` | `DATE_INVALID` |
| `notes` | توضیحات | string | ✗ | null | max:500 | — | `inventory.write` | `NOTES_TOO_LONG` |

---

## 5. Contact (`contacts`) — `/api/v1/org/contacts`
| Technical Name | عنوان فارسی | Type | Required | Default | Validation | Relation | Permission | Error Code |
| --- | --- | --- | :---: | --- | --- | --- | --- | --- |
| `code` | کد شخص | string | ✓ | — | unique per org | — | `contacts.write` | `CONTACT_CODE_DUPLICATE` |
| `name` | نام و نام خانوادگی / شرکت | string | ✓ | — | min:2, max:160 | — | `contacts.write` | `CONTACT_NAME_REQUIRED` |
| `contact_type` | نوع طرف‌حساب | enum | ✓ | `CUSTOMER` | `CUSTOMER\|VENDOR\|BOTH\|EMPLOYEE` | — | `contacts.write` | `CONTACT_TYPE_INVALID` |
| `group_id` | گروه اشخاص | uuid | ✗ | null | must belong to org | `contact_groups.id` | `contacts.write` | `CONTACT_GROUP_NOT_FOUND` |
| `mobile` | شماره همراه | string | ✗ | null | regex `^09[0-9]{9}$` | — | `contacts.write` | `MOBILE_INVALID` |
| `national_code` | کد ملی / شناسه | string | ✗ | null | 10-11 digits | — | `contacts.write` | `NATIONAL_CODE_INVALID` |
| `credit_limit` | سقف اعتبار | decimal(18,2) | ✓ | `0.00` | `>= 0` | — | `contacts.write` | `AMOUNT_INVALID` |

---

## 6. Sales & Purchase Invoice (`sales_invoices`, `purchase_invoices`)
| Technical Name | عنوان فارسی | Type | Required | Default | Validation | Relation | Permission | Error Code |
| --- | --- | --- | :---: | --- | --- | --- | --- | --- |
| `invoice_number` | شماره فاکتور | string | auto | sequential | unique per org | — | `sales.write` / `purchasing.write` | `INVOICE_NUMBER_DUPLICATE` |
| `contact_id` | طرف حساب | uuid | ✓ | — | must belong to org | `contacts.id` | `sales.write` / `purchasing.write` | `CONTACT_NOT_FOUND` |
| `warehouse_id` | انبار | uuid | ✓ | — | must belong to org | `warehouses.id` | `sales.write` / `purchasing.write` | `WAREHOUSE_NOT_FOUND` |
| `invoice_date` | تاریخ فاکتور | date | ✓ | today | ISO YYYY-MM-DD | — | `sales.write` / `purchasing.write` | `DATE_INVALID` |
| `items[].product_id` | کالا | uuid | ✓ | — | must belong to org | `products.id` | `sales.write` | `PRODUCT_NOT_FOUND` |
| `items[].quantity` | تعداد | decimal(18,4) | ✓ | — | `> 0` | — | `sales.write` | `QUANTITY_INVALID` |
| `items[].unit_price` | قیمت واحد | decimal(18,2) | ✓ | — | `>= 0` | — | `sales.write` | `AMOUNT_INVALID` |

---

## 7. CafeBazaar Receipt Verification (`/api/v1/org/payments/cafebazaar/verify`)
| Technical Name | عنوان فارسی | Type | Required | Default | Validation | Relation | Permission | Error Code |
| --- | --- | --- | :---: | --- | --- | --- | --- | --- |
| `package_name` | نام پکیج اندروید | string | ✓ | `ir.businessos.app` | matches configured package | — | `subscription.manage` | `PAYMENT_PACKAGE_MISMATCH` |
| `sku` | شناسه محصول پلن | string | ✓ | — | matches `plans.cafebazaar_sku` | `plans.cafebazaar_sku` | `subscription.manage` | `PLAN_SKU_NOT_FOUND` |
| `purchase_token` | توکن خرید کافه‌بازار | string | ✓ | — | min:16, unique across orgs | `purchase_receipts` | `subscription.manage` | `PAYMENT_RECEIPT_REPLAYED` |
| `Idempotency-Key` | کلید یکتاسازی (Header) | string | ✓ | — | min:8, max:128 | `idempotency_keys` | `subscription.manage` | `IDEMPOTENCY_KEY_REQUIRED` |

---

## 8. Offline Sync Batch Push (`/api/v1/sync/push`)
| Technical Name | عنوان فارسی | Type | Required | Default | Validation | Relation | Permission | Error Code |
| --- | --- | --- | :---: | --- | --- | --- | --- | --- |
| `device_id` | شناسه دستگاه اندروید | uuid | ✓ | — | registered to user+org | `devices.id` | `sync.execute` | `DEVICE_NOT_REGISTERED` |
| `client_batch_id` | شناسه دسته آفلاین | string | ✓ | — | unique per device | `sync_batches` | `sync.execute` | `SYNC_BATCH_DUPLICATE` |
| `events[].client_event_id` | شناسه رویداد کلاینت | string | ✓ | — | UUID | `sync_events` | `sync.execute` | `SYNC_EVENT_INVALID` |
| `events[].entity_type` | نوع موجودیت | enum | ✓ | — | `CONTACT\|PRODUCT\|SALES_INVOICE\|PURCHASE_INVOICE\|JOURNAL_ENTRY\|STOCK_COUNT` | — | `sync.execute` | `SYNC_ENTITY_UNSUPPORTED` |
| `events[].operation` | نوع عملیات | enum | ✓ | — | `CREATE\|UPDATE\|SOFT_DELETE` | — | `sync.execute` | `SYNC_OP_INVALID` |
| `events[].base_version` | نسخه مبنا | integer | ✓ | `0` | optimistic lock check | — | `sync.execute` | `SYNC_CONFLICT_DETECTED` |
| `events[].payload` | بدنه داده | json | ✓ | — | matches entity Field Dictionary | — | `sync.execute` | `VALIDATION_ERROR` |

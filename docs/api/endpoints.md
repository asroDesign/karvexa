# Business OS — Central API Endpoints Catalog (`/api/v1`)

All endpoints strictly follow Master Prompt 03:
- **Base Path**: `/api/v1`
- **Field Casing**: `snake_case`
- **Money / Qty / Tax**: Decimal String (zero floats)
- **Standard Envelope**: `{ "success": true, "data": ..., "meta": { "request_id", "timestamp", "pagination"? } }`
- **Required Mutating Headers**: `Authorization: Bearer TOKEN`, `X-Organization-Id: UUID`, `X-Device-Id: UUID` (mobile), `Idempotency-Key: UUID`, `X-Client-Version: 1.0.0`

## Modules & Canonical Routes
1. **Auth & Sessions (12 routes)**: `/auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/logout-all`, `/auth/forgot-password`, `/auth/reset-password`, `/auth/verify-mobile`, `/auth/resend-verification`, `/auth/me` (GET/PATCH), `/auth/sessions` (GET), `/auth/sessions/{id}` (DELETE).
2. **Devices (4 routes)**: `/devices/register`, `/devices`, `/devices/{id}`, `/devices/{id}/revoke`.
3. **Organizations (13 routes)**: `/organizations` (GET/POST), `/organizations/{id}` (GET/PATCH), `/organizations/{id}/settings` (GET/PATCH), `/organizations/{id}/members` (GET/POST), `/organizations/{id}/members/{member_id}` (PATCH/DELETE), `/organizations/{id}/fiscal-years` (GET/POST), `/organizations/{id}/fiscal-years/{year_id}/close` (POST).
4. **Users, Roles & Permissions (11 routes)**: `/roles` (GET/POST), `/roles/{id}` (GET/PATCH/DELETE), `/permissions` (GET), `/users` (GET), `/users/{id}` (GET), `/users/invitations` (POST), `/users/invitations/{id}/accept` (POST), `/users/{id}/roles` (PATCH).
5. **Contacts (12 routes)**: `/contacts` (GET/POST), `/contacts/{id}` (GET/PATCH/DELETE), `/contacts/{id}/transactions`, `/contacts/{id}/balance`, `/contacts/{id}/statement`, `/contact-groups` (GET/POST), `/contact-groups/{id}` (PATCH/DELETE).
6. **Catalog (17 routes)**: `/products` (GET/POST), `/products/{id}` (GET/PATCH/DELETE), `/products/{id}/stock`, `/products/{id}/movements`, `/products/{id}/prices` (GET/POST), `/products/barcode/{barcode}`, `/categories` (GET/POST), `/categories/{id}` (PATCH/DELETE), `/brands` (GET/POST), `/units` (GET/POST).
7. **Warehouses & Inventory (28 routes)**: `/warehouses` (GET/POST), `/warehouses/{id}` (GET/PATCH/DELETE), `/warehouses/{id}/stock`, `/inventory/movements`, `/inventory/stock`, `/inventory/receipts` (+ `{id}`, `/confirm`, `/cancel`), `/inventory/issues` (+ `{id}`, `/confirm`, `/cancel`), `/inventory/transfers` (+ `{id}`, `/confirm`, `/receive`, `/cancel`), `/inventory/counts` (+ `{id}`, `/submit`, `/confirm`).
8. **Purchasing (9 routes)**: `/purchases` (GET/POST), `/purchases/{id}` (GET/PATCH), `/purchases/{id}/confirm`, `/purchases/{id}/cancel`, `/purchases/{id}/returns`, `/purchase-returns`, `/purchase-returns/{id}`.
9. **Sales (11 routes)**: `/sales` (GET/POST), `/sales/{id}` (GET/PATCH), `/sales/{id}/confirm`, `/sales/{id}/cancel`, `/sales/{id}/returns`, `/sales/{id}/payments` (GET/POST), `/sales-returns`, `/sales-returns/{id}`.
10. **Consignments (9 routes)**: `/consignments` (GET/POST), `/consignments/{id}`, `/confirm`, `/returns`, `/sales`, `/settlements` (GET/POST), `/balance`.
11. **Treasury (12 routes)**: `/treasury/accounts` (GET/POST), `/treasury/accounts/{id}` (GET/PATCH), `/treasury/transactions` (GET), `/treasury/transactions/{id}` (GET), `/treasury/transactions/{id}/cancel`, `/treasury/receipts`, `/treasury/payments`, `/treasury/transfers`, `/treasury/expenses`, `/treasury/incomes`.
12. **Cheques (11 routes)**: `/cheques` (GET/POST), `/cheques/{id}` (GET/PATCH), `/cheques/due`, `/cheques/{id}/history`, `/cheques/{id}/{endorse|deposit|cash|bounce|cancel}`.
13. **Accounting (16 routes)**: `/accounting/accounts` (GET/POST), `/accounting/accounts/{id}` (GET/PATCH), `/accounting/journal-entries` (GET/POST), `/accounting/journal-entries/{id}` (GET/PATCH/DELETE), `/confirm`, `/reverse`, `/accounting/ledger`, `/accounting/trial-balance`, `/accounting/profit-loss`, `/accounting/balance-sheet`, `/accounting/account-statement`, `/accounting/fiscal-years`, `/accounting/periods/{id}` (PATCH).
14. **Reports & Export (14 routes)**: `/reports/{dashboard|sales|purchases|inventory|stock-card|contacts-balances|receivables|payables|cash-flow|cheques|trial-balance|profit-loss|balance-sheet}` + `/export`.
15. **Subscription & Payments (7 routes)**: `/subscription/plans`, `/subscription/current`, `/subscription/entitlements`, `/subscription/market/verify`, `/subscription/market/restore`, `/subscription/payments`, `/subscription/payments/{id}`.
16. **Files & Attachments (4 routes)**: `/files` (POST), `/files/{id}` (GET/DELETE), `/files/{id}/complete-upload` (POST).
17. **Sync (4 routes)**: `/sync/push`, `/sync/pull`, `/sync/conflicts`, `/sync/conflicts/{id}/resolve`.
18. **Platform Admin Portal (11 routes)**: `/platform/{overview|organizations|users|roles|plans|payments|devices|audit-logs|error-logs|settings|tickets}`.

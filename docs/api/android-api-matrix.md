# Business OS — Android Client API Consumption Matrix

Defines exact offline-first policies and commercial vs local sync status rules for the Android application.

| Module / Screen | Canonical Endpoint(s) | Offline Policy | Local Sync Statuses | Commercial Statuses |
| --- | --- | --- | --- | --- |
| Auth & Device Boot | `POST /auth/login`, `/auth/refresh`, `POST /devices/register` | Online required for initial login; cached encrypted token offline | — | — |
| Contacts | `GET/POST /contacts`, `PATCH /contacts/{id}` | **Full Offline Create/Update** via Room outbox -> `/sync/push` | `PENDING_SYNC`, `SYNCED`, `CONFLICT` | `ACTIVE`, `ARCHIVED` |
| Catalog & Barcode | `GET /products`, `GET /products/barcode/{barcode}` | **Offline Read & Barcode Scan** from Room cache | `SYNCED` | `ACTIVE` |
| Sales Invoice | `POST /sales`, `POST /sales/{id}/confirm` | **Offline Draft Create** with `client_document_id`; Confirm online or via sync queue | `PENDING_SYNC`, `SYNCING`, `SYNCED`, `FAILED` | `DRAFT`, `CONFIRMED`, `CANCELLED` |
| Purchase Invoice | `POST /purchases`, `POST /purchases/{id}/confirm` | **Offline Draft Create** with `client_document_id` | `PENDING_SYNC`, `SYNCED`, `FAILED` | `DRAFT`, `CONFIRMED`, `CANCELLED` |
| Stock Count | `POST /inventory/counts` | **Offline Barcode Count Capture**; variance adjustment confirmed server-side | `PENDING_SYNC`, `SYNCED` | `DRAFT`, `CONFIRMED` |
| Warehouse Transfer | `POST /inventory/transfers` | Online atomic transaction recommended (negative stock lock) | `PENDING_SYNC`, `SYNCED`, `FAILED` | `DRAFT`, `CONFIRMED`, `CANCELLED` |
| Treasury & Cheques | `POST /treasury/receipts`, `POST /cheques`, `POST /cheques/{id}/{action}` | Offline receipt draft + online confirmation | `PENDING_SYNC`, `SYNCED` | `RECEIVED`, `DEPOSITED`, `CASHED`, `BOUNCED` |
| Accounting Journals | `POST /accounting/journal-entries`, `/confirm`, `/reverse` | Offline draft creation allowed; **NO offline edit/delete of confirmed vouchers** | `PENDING_SYNC`, `SYNCED`, `FAILED` | `DRAFT`, `CONFIRMED`, `REVERSED` |
| CafeBazaar Billing | `POST /subscription/market/verify`, `/restore` | **Online Only** with mandatory `Idempotency-Key` | — | `ACTIVE`, `EXPIRED` |
| Sync Engine | `POST /sync/push`, `GET /sync/pull`, `POST /sync/conflicts/{id}/resolve` | Exponential backoff retry on 5xx/network; stop on 4xx | `SYNCING`, `SYNCED`, `CONFLICT` | Independent |

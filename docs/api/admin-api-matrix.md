# Business OS — Admin Web Panel API Matrix

Admin Web Panel NEVER connects directly to PostgreSQL — 100% of screens consume versioned `/api/v1/*` REST APIs with cookie/Bearer session isolation.

## 1. Platform Admin Portal Realm (`/api/v1/platform/*`)
Requires `is_platform_admin = true` + platform-scoped RBAC permission:

| Screen | Endpoints Consumed | Permission |
| --- | --- | --- |
| System Overview Dashboard | `GET /api/v1/platform/overview` | `platform.dashboard.read` |
| Organizations & Tenants | `GET/POST/PATCH /api/v1/platform/organizations` | `platform.organizations.read/write` |
| Global Users & Memberships | `GET/POST /api/v1/platform/users` | `platform.users.read/write` |
| Roles & Permissions Matrix | `GET/PATCH /api/v1/platform/roles` | `platform.roles.manage` |
| Subscriptions, Plans & Overrides | `GET/POST /api/v1/platform/plans` | `platform.plans.manage` |
| Payments & CafeBazaar Receipts | `GET /api/v1/platform/payments` | `platform.payments.read` |
| Android Devices & Sync Monitor | `GET /api/v1/platform/devices`, `POST /api/v1/sync/conflicts/{id}/resolve?realm=platform` | `platform.sync.read/resolve` |
| Audit Trail | `GET /api/v1/platform/audit-logs` | `platform.audit.read` |
| Error Reports | `GET/PATCH /api/v1/platform/error-logs` | `platform.errors.read/resolve` |
| Platform Settings | `GET/PATCH /api/v1/platform/settings` | `platform.settings.manage` |
| Support Tickets | `GET/PATCH /api/v1/platform/tickets` | `platform.tickets.manage` |
| API Contract Explorer | `GET /api/v1/docs` | Platform / Auth |

## 2. Organization Workspace Realm (`/api/v1/*`)
Requires verified `organization_members` (`ACTIVE`) + org-scoped RBAC permission:

| Module | Endpoints Consumed | Permission |
| --- | --- | --- |
| Organization Dashboard | `GET /api/v1/reports/dashboard` | `reports.financial.view` |
| Accounting & Reports | `GET/POST /api/v1/accounting/journal-entries`, `/confirm`, `/reverse`, `/accounts`, `/fiscal-years`, `/trial-balance`, `/profit-loss`, `/balance-sheet` | `accounting.*`, `reports.financial.view` |
| Inventory & Warehouses | `GET/POST /api/v1/warehouses`, `GET /api/v1/inventory/stock`, `/movements`, `POST /api/v1/inventory/transfers`, `/counts` | `inventory.*` |
| Catalog | `GET/POST /api/v1/products`, `/categories`, `/brands`, `/units`, `/products/barcode/{barcode}` | `catalog.*` |
| Contacts | `GET/POST /api/v1/contacts`, `/contacts/{id}/balance`, `/statement` | `contacts.*` |
| Sales & Purchasing | `GET/POST /api/v1/sales`, `/sales/{id}/confirm`, `GET/POST /api/v1/purchases`, `/purchases/{id}/confirm` | `sales.*`, `purchases.*` |
| Treasury, Cheques, Consignment | `GET/POST /api/v1/treasury/*`, `/cheques/*`, `/consignments/*` | `treasury.*`, `cheques.*`, `consignments.*` |
| Subscription & Data Export | `GET /api/v1/subscription/current`, `/plans`, `POST /api/v1/subscription/market/verify`, `/restore`, `GET /api/v1/export` | `subscription.manage`, `reports.export` |
| Offline Sync Simulator | `POST /api/v1/sync/push`, `GET /api/v1/sync/pull`, `GET /api/v1/sync/conflicts`, `POST /api/v1/sync/conflicts/{id}/resolve` | `sync.execute` |

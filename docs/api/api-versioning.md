# Business OS — API Versioning Policy & Change Log

## Versioning Policy
1. **URI Path Versioning**: Major contract version is anchored in the base path (`/api/v1`).
2. **Client Version Negotiation**: Clients send `X-Client-Version: <major>.<minor>.<patch>` (e.g., `1.0.0`).
   - Compatible clients (`major >= 1`) are processed normally.
   - Incompatible clients (`major < 1` or malformed) receive `400 CLIENT_VERSION_INCOMPATIBLE` with upgrade guidance.
3. **Backward-Compatible Additions**: Adding optional response fields or new endpoints does NOT break `v1`.
4. **Breaking Changes**: Renaming fields, changing types, removing enum values, or altering envelope structure requires `/api/v2` and a minimum 90-day deprecation window with `Deprecation` & `Sunset` headers.
5. **Cross-Agent Governance**: Neither Android nor Admin Panel may introduce uncontracted routes or fields without updating `docs/api/openapi.yaml` and recording an entry below.

---

## Change Log
### v1.0.0 (2026-04-01) — Central Implementation Contract Release
- Standardized strict `snake_case` JSON naming and Decimal String precision across all 18 domain modules.
- Enforced unified Response Envelope (`success`, `data`, `meta.request_id`, `meta.timestamp`, `meta.pagination`, `error.details[]`).
- Finalized canonical `/api/v1/*` routes for Auth, Devices, Organizations, RBAC, Contacts, Catalog, Warehouses, Inventory, Purchasing, Sales, Consignments, Treasury, Cheques, Accounting, Reports, Subscription/CafeBazaar, Files, Sync, and Platform Admin.
- Added `client_document_id`, `Idempotency-Key` deduplication, `X-Client-Version` compatibility check, and separation of commercial status (`DRAFT|CONFIRMED|CANCELLED|REVERSED|REJECTED`) vs local sync status (`PENDING_SYNC|SYNCING|SYNCED|FAILED|CONFLICT`).

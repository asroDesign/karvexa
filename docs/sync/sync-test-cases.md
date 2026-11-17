# Business OS — Mandatory Sync, Data & Financial Integration Test Cases

All critical test cases below are automated and executed live against PostgreSQL in `scripts/test-business-os.mjs`.

## 1. Critical End-to-End Offline Scenarios (Master Prompt 04 §22)
1. **Scenario 1 — Offline Purchase Full Lifecycle**:
   - Device creates Purchase Draft offline with Client UUID (`operation: CREATE`) -> Push -> Server accepts as `business_status = DRAFT` (Android cannot self-confirm).
   - Device pushes `operation: CONFIRM` depending on the draft UUID -> Server atomically posts Stock Receipt (increasing Stock Ledger qty + valuation) + Balanced Accounting Voucher (`DR Inventory / CR AP`) -> returns `status: CONFIRMED`, `business_status: CONFIRMED`.
   - Device executes `GET /api/v1/sync/pull` with opaque cursor -> receives updated purchase record -> calls `POST /api/v1/sync/acknowledge`.
2. **Scenario 2 — Offline Sale Full Lifecycle**:
   - Device creates Sales Draft offline -> Push (`DRAFT`) -> Push `CONFIRM` -> Server checks Stock Ledger under advisory lock -> deducts stock, calculates COGS, posts balanced `AR/Revenue + COGS/Inventory` Journal Entry -> returns `CONFIRMED`.
3. **Scenario 3 — Two Offline Devices Racing on Limited Stock (Multi-Device Conflict)**:
   - Device A & Device B both create offline sales for the same product where `qty_A + qty_B > warehouse_stock`, though each individually looks possible offline.
   - Device A confirms first -> `CONFIRMED`, stock reduced.
   - Device B attempts confirm -> PostgreSQL lock detects insufficient remaining stock under `BLOCK` policy -> returns `status: CONFLICT`, `business_status: REJECTED`, creates `STOCK_SHORTAGE` conflict record, and prevents negative stock!
4. **Scenario 4 — Network Drop After Server Commit & Replay Protection**:
   - Device sends Push Event with `idempotency_key = K1`. Server commits & saves to `sync_inbox`.
   - Connection drops; Device retries exact same event with `K1` -> Server returns `status: DUPLICATE` and original `server_id` (zero duplicate rows).
   - Malicious/buggy client reuses `K1` with modified payload -> Server rejects with `IDEMPOTENCY_KEY_REUSED`.

## 2. Additional Mandatory Test Coverage
- **Reference Data Field Conflict + `MERGE` Resolution**: Stale `base_version` captures exact `conflicting_fields[]`; resolving with `MERGE` updates server & streams change to `sync_change_log`.
- **Financial Immutability Conflict**: Offline `UPDATE` against a confirmed `journal_entry` captures `FINANCIAL_IMMUTABLE` conflict; attempting `USE_LOCAL` resolution is blocked with `409 RESOLUTION_NOT_ALLOWED_FOR_ENTITY`.
- **Tombstone Soft Delete**: `DELETE` emits `operation: TOMBSTONE` in `/api/v1/sync/pull`.
- **Opaque Cursor Tampering & Reset**: Tampered cursor returns `400 INVALID_SYNC_CURSOR`; `POST /api/v1/sync/reset-checkpoint` resets cursor non-destructively (`data_deleted: false`).
- **Device Revocation**: Revoking a device via `POST /api/v1/devices/{id}/revoke` immediately blocks subsequent Sync Push/Pull with `403 DEVICE_REVOKED`.
- **Tenant Isolation & RBAC**: Cross-tenant `X-Organization-Id` spoofing returns `403 TENANT_ACCESS_DENIED` + `CRITICAL` security audit log.

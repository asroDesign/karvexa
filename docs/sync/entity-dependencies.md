# Business OS — Sync Entity Dependency Order & Tombstone/Versioning Policy

## 1. Mandatory Sync Dependency Graph (Topological Push Order)
Android Outbox MUST flush events in dependency order, referencing parent `event_id` or `entity_id` in `dependencies[]`:

1. **Level 0 (Tenant Root)**: `organization`
2. **Level 1 (Structural Reference)**: `branch`, `warehouse`, `account_code`, `cost_center`, `treasury_account`, `contact`, `product`
3. **Level 2 (Child Reference)**: `product_variant` (depends on `product`), `employee` (depends on `organization`)
4. **Level 3 (Draft Commercial & Consignment Docs)**: `purchase`, `sales`, `consignment_document` (`CONSIGNMENT_IN`/`OUT`), `journal_entry` (DRAFT), `cheque`
5. **Level 4 (Authoritative Confirmations & Movements)**: `purchase` (`CONFIRM`), `sales` (`CONFIRM`), `consignment_document` (`CONSIGNMENT_SALE`/`RETURN` depending on root agreement), `treasury_transaction`, `quick_cashflow`, `owner_withdrawal`, `personal_transaction`

If a parent UUID is missing on the server, `POST /api/v1/sync/push` rejects ONLY that dependent event with `DEPENDENCY_NOT_SATISFIED` (keeping independent batch events intact) so Android retries once the parent syncs.

## 2. Tombstone & Versioning Policy
- Synced records are NEVER physically deleted (`DELETE` sets `deleted_at`, increments `version`, and emits `operation = "TOMBSTONE"` into `sync_change_log`).
- Posted financial documents (`journal_entry`, `sales`, `purchase`, `owner_withdrawal`, `quick_cashflow`) NEVER accept Tombstone deletes; corrections occur exclusively through controlled `/cancel`, `/return`, or `/reverse` commands.
- Pull cursors are HMAC-signed monotonic sequences (`bos_c1_...`) derived from `sync_change_log.seq BIGSERIAL`, never relying solely on `updated_at`.

# Business OS — Sync API Contract (`/api/v1/sync/*`)

All 9 Sync endpoints strictly require Bearer JWT, verified active `X-Organization-Id` membership, active non-revoked `device_id`, and `X-Client-Version: 1.0.0`.

| Method | Endpoint | Purpose | Required Headers / Params |
| --- | --- | --- | --- |
| `GET` | `/api/v1/sync/status` | Server UTC time, head seq/cursor, device lag, open conflicts count, and `sync_logs` telemetry | `Authorization`, `X-Organization-Id` |
| `POST` | `/api/v1/sync/push` | Push Outbox batch with per-event `sync_inbox` idempotency, dependency check, and domain rules | `Idempotency-Key`, body `{ device_id, batch_id, events[] }` |
| `GET` | `/api/v1/sync/pull` | Cursor-based monotonic change stream (`UPSERT` & `TOMBSTONE`) from `sync_change_log` | `?device_id=&cursor=&limit=50&entity_types=` |
| `POST` | `/api/v1/sync/acknowledge` | Persist server checkpoint ONLY after Android Room transaction commits pulled changes | body `{ device_id, cursor }` |
| `GET` | `/api/v1/sync/checkpoints` | List device sync checkpoints & acknowledged cursors | `Authorization`, `X-Organization-Id` |
| `POST` | `/api/v1/sync/reset-checkpoint` | Protected non-destructive cursor reset for corrupted/expired cursor recovery | body `{ device_id, reason }` |
| `GET` | `/api/v1/sync/conflicts` | List conflicts with `conflict_type`, `conflicting_fields[]`, `local_payload`, `server_payload`, `allowed_resolutions` | `Authorization`, `X-Organization-Id` |
| `GET` | `/api/v1/sync/conflicts/{id}` | Inspect single conflict details | `id` UUID |
| `POST` | `/api/v1/sync/conflicts/{id}/resolve` | Resolve conflict (`USE_SERVER`, `USE_LOCAL`, `MERGE`, `RECREATE_AS_NEW`) enforcing entity guards | body `{ resolution, merged_payload? }` |

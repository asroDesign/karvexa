# Business OS — Offline Capability Matrix & Data Freshness Rules

## 1. Operation Matrix

| Operation | Offline Capable | Local Room Save | Server Approval Required | Local Status Before Sync | Post-Sync Commercial Status |
| --- | :---: | :---: | :---: | --- | --- |
| **Create Contact** | Yes | Yes (Client UUID) | No | `PENDING` / `LOCAL_DRAFT` | `CONFIRMED` |
| **Update Contact** | Yes | Yes | Conflict Check (`version`) | `PENDING` | `CONFIRMED` or `CONFLICT` |
| **Create Product** | Yes | Yes (Client UUID) | Conflict Check (`sku` unique) | `PENDING` | `CONFIRMED` or `CONFLICT` |
| **Update Product** | Yes | Yes | Conflict Check (`version`) | `PENDING` | `CONFIRMED` or `CONFLICT` |
| **Create Purchase Draft** | Yes | Yes (`client_document_id`) | Yes | `PENDING` / `LOCAL_DRAFT` | `DRAFT` |
| **Confirm Purchase** | Conditional | Pending Request in Outbox | **Yes (Stock + Journal)** | `PENDING` / `PENDING_SYNC` | `CONFIRMED` or `REJECTED` |
| **Create Sales Draft** | Yes | Yes (`client_document_id`) | Yes | `PENDING` / `LOCAL_DRAFT` | `DRAFT` |
| **Confirm Sales** | Conditional | Pending Request in Outbox | **Yes (Stock Lock + COGS)** | `PENDING` / `PENDING_SYNC` | `CONFIRMED` or `CONFLICT` (`STOCK_SHORTAGE`) |
| **Inventory Transfer** | Yes | Pending Request | **Yes (Atomic Source/Dest Lock)** | `PENDING` / `PENDING_SYNC` | `CONFIRMED` or `REJECTED` |
| **Stock Count** | Yes | Yes (Offline Barcode Scan) | **Yes (Variance Adjustment)** | `PENDING` / `PENDING_SYNC` | `CONFIRMED` |
| **Journal Entry Draft** | Yes | Yes (Double-Entry Check) | Yes | `PENDING` / `LOCAL_DRAFT` | `DRAFT` |
| **Confirm Journal Entry** | No final approval offline | Pending Request | **Yes (Period + Balance + Immutability)** | `PENDING` / `PENDING_SYNC` | `CONFIRMED` or `REJECTED` |
| **Cash Receipt / Payment** | Conditional | Pending Request (`idempotency_key`) | **Yes (Anti-Duplicate Check)** | `PENDING` / `PENDING_SYNC` | `CONFIRMED` or `DUPLICATE` |
| **Cheque Registration** | Yes | Pending Request | Yes | `PENDING` / `PENDING_SYNC` | `RECEIVED` |
| **Reports (Financial / Stock)** | Local Snapshot | Yes (from Room Projection) | Depends on freshness | Marked with `last_synced_at` | Live when synced |
| **CafeBazaar Purchase Verify** | **No (Online Only)** | No | **Yes (Official Server Gateway)** | — | `ACTIVE` |

---

## 2. UI Freshness & Dual-Badge Requirements
1. Every Android screen and local report displays a **Sync Freshness Banner**:
   - Green: synced `< 5m` ago, zero pending outbox, zero open conflicts.
   - Amber: offline or `last_synced_at` stale, showing `"آخرین همگام‌سازی: ... — داده‌های محلی ممکن است قطعی نباشند"`.
   - Red: open `CONFLICT` items requiring user review.
2. Every document card renders **two independent badges**:
   - Commercial Badge (`پیش‌نویس`, `تایید قطعی`, `رد شده`, `معکوس شده`)
   - Sync Badge (`در انتظار ارسال`, `همگام‌شده`, `دارای تعارض`)

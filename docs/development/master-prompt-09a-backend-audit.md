# Karvexa Business OS — Master Prompt 09A Backend Audit & Implementation Plan

## 1. Existing Functionality Inventory (Baseline after Master Prompts 02–08)
- **Sales & Mixed Settlements**: `sales_invoices`, `sales_invoice_items`, `invoice_payment_allocations` supporting `CASH`, `BANK`, `CARD_TERMINAL`, `CHEQUE`, `CREDIT`, `ACCOUNT_BALANCE`, inline multi-cheque creation with Jalali due dates, and damaged/accepted split returns.
- **Incoming Receipts & Suppliers**: `stock_documents` with landed acquisition costing (`shipping_cost`, `customs_and_extra_cost`, `supplier_discount`, `paid_amount`, `remaining_payable`) + supplier profile & settlement posting (`DR AP / CR Cash-Bank`).
- **Warehouse Transfers**: `stock_transfers` & `stock_transfer_items` with `DRAFT -> IN_TRANSIT -> PARTIALLY_RECEIVED | RECEIVED | DISCREPANCY_REPORTED -> COMPLETED`.
- **Excel Exports**: `.xlsx` workbooks for Journal Book, Current Warehouse Stock (`/inventory/exports/stock`), and Movement History (`/inventory/exports/movements`).
- **Treasury & Cheques**: Cash/Bank/POS accounts, opening balance journal, transaction history, deletion guard, state-machine cheque lifecycle, and audited cheque amendments.
- **Offline-Only & Cloud Migration**: `organization_operating_modes`, `cloud_migration_sessions`, `sync_inbox`, `sync_change_log` with opaque cursor.
- **Subscriptions & 4 Payment Gateways**: Versioned signed entitlements + Zarinpal, Zibal, Balleh Pay, Saman adapters + `/payments/result/[reference]` browser return page.

## 2. Verified Status Against Master Prompt 09A (2026-11-19)

The original gap list below was stale. A source review of the current backend found these requirements implemented:

| Requirement | Status | Current implementation evidence |
|---|---|---|
| Persist contact and cheque references, including credit/account-balance allocations | Implemented | `src/db/schema.ts`; `src/modules/commerce/service.ts` |
| Supplier account, transaction, settlement list and create APIs | Implemented | `src/modules/inventory/controller.ts`; supplier account/settlement services |
| Submit, dispatch, partial receive, discrepancies, evidence, idempotency | Implemented | `src/modules/inventory/controller.ts`; `src/modules/inventory/service.ts`; `src/db/schema.ts` |
| Stock and transaction Excel exports, including `/exports/transactions` alias | Implemented | `src/modules/inventory/controller.ts` |
| Cheque optimistic version conflict guard | Implemented | cheque update handler in `src/modules/treasury/controller.ts` |
| Treasury metadata `PUT`/`PATCH` with immutable history | Implemented | treasury account handler in `src/modules/treasury/controller.ts` |
| Cloud/initial migration start, resume, status, and confirmation aliases | Implemented | `src/modules/offline-mode/controller.ts`; route delegation in `src/modules/subscription/controller.ts` |
| Plural subscription routes, entitlement snapshot and version polling fallback | Implemented | `src/modules/subscription/controller.ts`; `buildSignedEntitlementSnapshot` in `src/modules/payments/gateways.ts` |
| Gateway priority, callback expiry guard, and four provider status adapters | Implemented | `src/db/schema.ts`; `src/app/api/v1/platform/payment-gateways/route.ts`; `src/modules/payments/gateways.ts` |
| Safe opaque payment return link and server-side status lookup | Implemented | callback results in `src/modules/payments/gateways.ts`; status route in `src/modules/subscription/controller.ts` |

The status endpoint now queries a pending order through its adapter's existing provider verification/inquiry operation. Only a verified result enters the subscription activation path. Activation locks the payment-order row and rechecks its state inside the transaction so a simultaneous callback or status request cannot extend the subscription twice. It does not trust app-link query flags or add provider endpoint paths.

## 3. Remaining Validation and Risks

- TypeScript typecheck and ESLint pass for the payment gateway and subscription controller changes.
- Live end-to-end payment verification remains unverified because merchant credentials and provider sandbox transactions are not available in this checkout.
- The backend production build previously ended with a Next.js `SecurityFatalError` after static generation. No dependency/security upgrade has been applied; rerun that build after its approval and environment investigation.
- Payment status refresh keeps an unverified provider response pending and reports provider unavailability without activating an entitlement.

No additional schema migration is indicated by this source review. The historical zero-destructive migration plan has therefore been removed from the current gap list.

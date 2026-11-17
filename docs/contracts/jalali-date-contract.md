# Karvexa Business OS — Canonical Date, Jalali Calendar & Timezone Contract

1. **Canonical Storage & Transport**: All PostgreSQL business dates use `DATE` (`YYYY-MM-DD`, Gregorian ISO). All system timestamps use `TIMESTAMPTZ` in UTC (`ISO 8601 ...Z`).
2. **Jalali Input Support**: APIs accepting business dates (e.g., `due_date_jalali` on cheques, `invoice_date_jalali` on warehouse receipts, `document_date_jalali` on journal entries) accept Persian Solar Hijri strings (`YYYY/MM/DD` or `YYYY-MM-DD`, Latin or Persian digits) and convert deterministically via `src/lib/jalali.ts` into canonical Gregorian `YYYY-MM-DD` before persistence.
3. **Jalali Display Output**: Responses return canonical `*_date` alongside `*_date_jalali` (e.g., `due_date: "2025-09-15"`, `due_date_jalali: "1404/06/24"`), ensuring exact parity across Android UI, Web Admin, PDF invoices, and Excel exports.
4. **Timezone**: Business day cutoffs follow `organizations.timezone` (default `Asia/Tehran`, UTC+03:30).

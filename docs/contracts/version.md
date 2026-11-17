# Business OS — Shared Contract Version Registry

- **API Contract Version**: `v1.1.0` (100% backward-compatible with `v1.0.0`, `X-Client-Version: >= 1.0.0`)
- **PostgreSQL Schema Version**: `2026.05.01` (95 relational tables + 79 RLS-protected tenant tables)
- **Android Room Compatibility**: Schema `v2` (additive tables & nullable columns only; zero breaking renames)
- **Covered Master Prompts**:
  - Master Prompt 02 — Modular Monolith Backend & Dual-Realm Admin Panel
  - Master Prompt 03 — Central API Contract (`snake_case`, Decimal Strings, Unified Envelope)
  - Master Prompt 04 — Local-First Room ↔ PostgreSQL Bidirectional Sync Engine (Outbox, Inbox, Change Log, Opaque Cursor, Domain Conflicts)
  - Master Prompt 05 — Personal Finance, Mixed Payments, Quotations, Quick Expense/Income Mapping, Variants, Smart Replenishment, CRM Loyalty, Employees/RBAC, Cheque Analytics, XLSX Journal Book & RTL PDF

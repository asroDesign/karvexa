# Graph Report - karvexa  (2026-11-21)

## Corpus Check
- 117 files · ~212,253 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 4 file(s) not represented in the graph (top: (none) 1, .ico 1, .css 1)

## Summary
- 1510 nodes · 4947 edges · 144 communities (79 shown, 65 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 27 edges (avg confidence: 0.91)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `485b14e4`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- ApiError
- ok
- auth/controller.ts
- apiFetch
- auth/controller.ts
- schema.ts
- OrgWorkspace.tsx
- sync/service.ts
- subscription/controller.ts
- ensureSeeded
- seed.ts
- subscription/controller.ts
- react
- Sync Entity Manifest
- sync/service.ts
- compilerOptions
- Master Prompt 05 Acceptance Criteria (Scenarios A–K)
- Central API Contract
- Sync Conflict Handling
- Runtime Dependencies
- Background Sync Scheduling
- Module Status Tracker
- Architecture Decisions
- react
- Current Module Status & Coordination Tracker
- Decisions
- Inventory Settlement Contract
- Server Sync Persistence
- 2026-11-18-advanced-support-tickets.sql
- Backend Extension Audit
- API Request Examples
- Financial Dashboard Metrics
- Crash, Network, and Multi-Device Recovery Strategy
- Jalali Date Conversion and Display
- API Versioning Policy
- Server-Authoritative Database
- Shared Field Dictionary
- Backend Extension Decisions
- Server-Authoritative Entitlement Snapshot
- Product Catalog ERD
- Personal Finance Boundaries
- Core Module Invariants
- Organization Sync Authorization
- Crypto and Spreadsheet Exports
- Journal Posting Rules
- Brand Typography
- Balanced Double-Entry Journal Voucher
- Android Room Sync Protocol
- Personal Finance Ledger
- Graph first codebase exploration
- Fiscal Year Lifecycle
- Fiscal Year Lifecycle
- Invitation Security
- Financial Conflict Resolution
- Stock Ledger
- Android Offline-First API Consumption
- Karvexa Graphify maintenance workflow
- Project Scripts
- Platform API Access Matrix
- Treasury and Cheque Rules
- Domain-Based Conflict Resolution Policy
- Treasury Account Contract
- sms/service.ts
- Cross platform API, offline sync, and accounting flows
- Room and PostgreSQL Mapping
- xlsx
- scripts
- treasury/controller.ts
- Database Platform Schema
- Unified Database Schema
- Sales Invoices
- Conflict Resolution API
- idx_stock_count_items_variant
- PostgreSQL Contacts Table
- Purchase Document Mapping
- Sales Document Mapping
- Stock Ledger Mapping
- PostgreSQL Sales Invoices Table
- Tenant Isolation Policies
- Cheque Entity Relations
- Consignment Entity Relations
- Contact Entity Relations
- Purchase Invoice Relations
- Sync Batch Relations
- Signed Cursors and Tombstones
- Business and Sync Status
- PostCSS Configuration
- PostgreSQL Sync Conflicts
- Business Date Rules
- Sync Change Log
- Accounting Core Module
- package.json
- Catalog Core Module
- Consignment Core Module
- Files and Attachments Core Module
- Inventory Core Module
- Notifications Core Module
- Organization Core Module
- Payments Core Module
- Purchasing Core Module
- Reports Core Module
- Roles and Permissions Core Module
- Sales Core Module
- Subscription Core Module
- Synchronization Core Module
- Treasury Core Module
- Users Core Module
- AI/OCR Extension Module
- CRM Extension Module
- Fixed Assets Extension Module
- Payroll Extension Module
- POS Extension Module
- Production Extension Module
- Projects Extension Module
- Tax Extension Module
- Row Level Security Policies
- Roles and Permissions Core Module
- Sales Core Module
- Subscription Core Module
- Synchronization Core Module
- Treasury Core Module
- Users Core Module
- accounting/controller.ts
- seed.ts
- sitemap.ts
- bootstrapOrganizationDefaults
- @types/react@19.2.14
- @types/react-dom@19.2.3

## God Nodes (most connected - your core abstractions)
1. `ApiError` - 152 edges
2. `recordAuditLog()` - 107 edges
3. `apiFetch()` - 107 edges
4. `ok()` - 103 edges
5. `ensureSeeded()` - 73 edges
6. `withTenantTransaction()` - 73 edges
7. `parseDecimal()` - 66 edges
8. `formatDecimal()` - 66 edges
9. `drizzle-orm` - 65 edges
10. `db` - 63 edges

## Surprising Connections (you probably didn't know these)
- `Shared Modular Monolith Core` --semantically_similar_to--> `Modular Monolith`  [INFERRED] [semantically similar]
  docs/architecture/decisions.md → README.md
- `Variant-Level Stock Ledger with Parent Projection` --semantically_similar_to--> `Atomic Stock Ledger`  [INFERRED] [semantically similar]
  docs/architecture/decisions.md → README.md
- `Tenant Access Denial` --conceptually_related_to--> `Multi-Tenant PostgreSQL Row Level Security`  [INFERRED]
  docs/api/errors.md → README.md
- `Warehouse Transfer Lifecycle` --conceptually_related_to--> `Atomic Stock Ledger`  [INFERRED]
  docs/contracts/inventory-settlement-contract.md → README.md
- `Accounting Integrity Error Handling` --conceptually_related_to--> `Balanced Double-Entry Journal Voucher`  [INFERRED]
  docs/api/errors.md → docs/accounting/journal-posting-rules.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Bidirectional Local-First Sync Flow** — docs_sync_sync_protocol_server_push_algorithm, docs_sync_sync_protocol_pull_acknowledge_protocol, docs_sync_sync_protocol_android_workmanager_algorithm, docs_sync_sync_protocol_sync_outbox, docs_sync_sync_protocol_sync_inbox, docs_sync_sync_protocol_sync_change_log [EXTRACTED 1.00]
- **Mandatory Offline Sync End-to-End Scenarios** — docs_sync_sync_test_cases_mandatory_sync_data_financial_integration_test_cases, docs_sync_sync_test_cases_scenario_1_offline_purchase_full_lifecycle, docs_sync_sync_test_cases_scenario_2_offline_sale_full_lifecycle, docs_sync_sync_test_cases_scenario_3_two_offline_devices_racing_on_limited_stock, docs_sync_sync_test_cases_scenario_4_network_drop_after_server_commit_replay_protection [EXTRACTED 1.00]
- **Master Prompt 05 Acceptance Scenario Suite** — docs_testing_acceptance_criteria_master_prompt_05_acceptance_criteria_scenarios_a_k, docs_testing_acceptance_criteria_scenario_a_owner_withdrawal, docs_testing_acceptance_criteria_scenario_b_mixed_sales_payment, docs_testing_acceptance_criteria_scenario_c_subsequent_customer_payment, docs_testing_acceptance_criteria_scenario_d_product_variants, docs_testing_acceptance_criteria_scenario_e_minimum_stock_smart_purchase, docs_testing_acceptance_criteria_scenario_f_recurring_expenses, docs_testing_acceptance_criteria_scenario_g_cheque_lifecycle, docs_testing_acceptance_criteria_scenario_h_accounting_reports_xlsx_export, docs_testing_acceptance_criteria_scenario_i_rbac, docs_testing_acceptance_criteria_scenario_j_offline_synchronization, docs_testing_acceptance_criteria_scenario_k_tenant_isolation [EXTRACTED 1.00]
- **Web and Android project graphs used together to trace cross-platform flows** — agents_karvexa_web_project_graph, agents_karvexa_os_android_project_graph, agents_cross_platform_api_offline_sync_accounting_flows [EXTRACTED 1.00]
- **20 Core Business OS Modules** — docs_product_modules_core_identity, docs_product_modules_core_organization, docs_product_modules_core_users, docs_product_modules_core_roles_permissions, docs_product_modules_core_contacts, docs_product_modules_core_catalog, docs_product_modules_core_accounting, docs_product_modules_core_inventory, docs_product_modules_core_purchasing, docs_product_modules_core_sales, docs_product_modules_core_treasury, docs_product_modules_core_cheques, docs_product_modules_core_consignment, docs_product_modules_core_reports, docs_product_modules_core_subscription, docs_product_modules_core_payments, docs_product_modules_core_synchronization, docs_product_modules_core_audit, docs_product_modules_core_notifications, docs_product_modules_core_files [EXTRACTED 1.00]
- **8 Roadmap Extension Modules** — docs_product_modules_ext_pos, docs_product_modules_ext_production, docs_product_modules_ext_fixed_assets, docs_product_modules_ext_crm, docs_product_modules_ext_payroll, docs_product_modules_ext_projects, docs_product_modules_ext_tax, docs_product_modules_ext_ai_ocr [EXTRACTED 1.00]
- **Offline to Cloud Reactivation Flow** — docs_contracts_offline_only_mode_contract_cloud_sync_and_offline_only_operating_modes, docs_contracts_offline_only_mode_contract_resumable_cloud_reactivation_migration, docs_contracts_offline_only_mode_contract_cloud_migration_completion [EXTRACTED 1.00]
- **Subscription Upgrade and Verification Flow** — docs_contracts_payment_flow_contract_subscription_upgrade_initiation, docs_contracts_payment_flow_contract_payment_gateway_callback_verification, docs_contracts_payment_flow_contract_authoritative_subscription_refresh [EXTRACTED 1.00]
- **Bidirectional Sync Entity Manifest** — docs_sync_sync_entity_manifest_contact, docs_sync_sync_entity_manifest_product, docs_sync_sync_entity_manifest_product_variant, docs_sync_sync_entity_manifest_warehouse, docs_sync_sync_entity_manifest_branch, docs_sync_sync_entity_manifest_cost_center, docs_sync_sync_entity_manifest_account_code, docs_sync_sync_entity_manifest_treasury_account, docs_sync_sync_entity_manifest_treasury_transaction, docs_sync_sync_entity_manifest_cheque, docs_sync_sync_entity_manifest_journal_entry, docs_sync_sync_entity_manifest_sales, docs_sync_sync_entity_manifest_purchase, docs_sync_sync_entity_manifest_consignment, docs_sync_sync_entity_manifest_quick_cashflow, docs_sync_sync_entity_manifest_personal_transaction, docs_sync_sync_entity_manifest_owner_withdrawal, docs_sync_sync_entity_manifest_employee [EXTRACTED 1.00]

## Communities (144 total, 65 thin omitted)

### Community 0 - "ApiError"
Cohesion: 0.08
Nodes (144): accounts, contacts, contactTransactions, fiscalYearClosings, invoicePaymentAllocations, journalEntries, ownerWithdrawals, products (+136 more)

### Community 1 - "ok"
Cohesion: 0.05
Nodes (105): nextConfig, drizzle-orm, next, zod, dynamic, CONTRACT_FILES, GET(), createArticleSchema (+97 more)

### Community 2 - "auth/controller.ts"
Cohesion: 0.14
Nodes (28): ACCESS_COOKIE_NAME, AccessTokenPayload, attachAuthCookies(), base64UrlDecode(), base64UrlEncode(), checkRateLimit(), clearAuthCookies(), createSessionTokens() (+20 more)

### Community 3 - "apiFetch"
Cohesion: 0.07
Nodes (50): AdvancedModulesPanel(), handleConvertQuotation(), handleConvertSuggestionToPo(), handleCreateEmployee(), handleCreateRecurring(), handleCreateVariantWithOpeningStock(), handleOwnerWithdrawal(), handlePayRecurring() (+42 more)

### Community 4 - "auth/controller.ts"
Cohesion: 0.07
Nodes (48): AccountingParityPanel(), createCenter(), CommerceParityPanel(), createPurchase(), openReturn(), submitReturn(), downloadReport(), InventoryParityPanel() (+40 more)

### Community 5 - "schema.ts"
Cohesion: 0.06
Nodes (30): accountClosures, chequeAssignments, cloudMigrationSessions, consignmentLedger, consignorSettlements, contactAccounts, contactAddresses, contactInquiries (+22 more)

### Community 6 - "OrgWorkspace.tsx"
Cohesion: 0.12
Nodes (19): AdvancedSubTab, BusinessSupportTickets(), sendReply(), Department, Detail, Event, Message, priorityFa (+11 more)

### Community 7 - "sync/service.ts"
Cohesion: 0.13
Nodes (26): lucide-react, AboutPage(), dynamic, AcademyIndexPage(), dynamic, AcademyArticleDetailPage(), dynamic, ContactPage() (+18 more)

### Community 8 - "subscription/controller.ts"
Cohesion: 0.10
Nodes (30): features, notifications, paymentGatewaySettings, paymentOrders, planFeatures, syncCheckpoints, extractAccessToken(), getClientIp() (+22 more)

### Community 9 - "ensureSeeded"
Cohesion: 0.19
Nodes (30): DELETE(), dispatch(), dynamic, extractSegments(), GET(), PATCH(), POST(), PUT() (+22 more)

### Community 10 - "seed.ts"
Cohesion: 0.14
Nodes (27): AdvancedModulesPanelProps, FiscalLifecyclePanelProps, fa(), JalaliDatePicker(), JalaliMonthPicker(), jalaliToIsoSafe(), MONTHS, normalizeJalali() (+19 more)

### Community 11 - "subscription/controller.ts"
Cohesion: 0.22
Nodes (16): digits(), InvoiceLine, lineDraft(), moneyString(), numberValue(), PaymentLine, paymentOptions, quantityString() (+8 more)

### Community 12 - "react"
Cohesion: 0.11
Nodes (22): Account Code Sync Entity, Branch Sync Entity, Cheque Sync Entity, Consignment Document Sync Entity, Contact Sync Entity, Cost Center Sync Entity, Employee Sync Entity, Journal Entry Sync Entity (+14 more)

### Community 13 - "Sync Entity Manifest"
Cohesion: 0.15
Nodes (13): devDependencies, drizzle-kit@0.31.10, eslint@9.39.4, eslint-config-next@16.4.2, postcss@8.5.23, @types/pg@8.18.0, typescript@5.9.3, drizzle-kit (+5 more)

### Community 14 - "sync/service.ts"
Cohesion: 0.15
Nodes (29): syncChangeLog, PaymentAllocationInput, decodeSyncCursor(), encodeSyncCursor(), SyncCursorData, acknowledgeSyncCursor(), chequeSyncPayload(), contactSyncPayload() (+21 more)

### Community 15 - "compilerOptions"
Cohesion: 0.10
Nodes (19): compilerOptions, allowJs, baseUrl, esModuleInterop, incremental, isolatedModules, jsx, lib (+11 more)

### Community 16 - "Master Prompt 05 Acceptance Criteria (Scenarios A–K)"
Cohesion: 0.12
Nodes (19): Double-Entry Accounting, Accounting Reports and XLSX Export, Business P&L, Cheque Lifecycle, Loyalty Points, Master Prompt 05 Acceptance Criteria (Scenarios A–K), OWNER_DRAWINGS (3201), Partial Payment Status (+11 more)

### Community 17 - "Central API Contract"
Cohesion: 0.16
Nodes (18): Canonical API Modules, Central API Contract, Decimal String Data Contract, Endpoints, Mutating Request Headers, Unified Response Envelope, Accounting Integrity Error Handling, Errors (+10 more)

### Community 18 - "Sync Conflict Handling"
Cohesion: 0.12
Nodes (15): Sync Acknowledgement, Sync Cursor State, Android Local-First Database, Offline Draft Documents, Local Reference Data Projections, Android Room, Sync Acknowledge Endpoint, Sync Checkpoints Endpoint (+7 more)

### Community 19 - "Runtime Dependencies"
Cohesion: 0.15
Nodes (16): Base Version Conflict Detection, Dependency Validation, Idempotency Key, sync_inbox, Sync Telemetry, Financial Immutability Conflict, FINANCIAL_IMMUTABLE Conflict, Mandatory Sync, Data & Financial Integration Test Cases (+8 more)

### Community 20 - "Background Sync Scheduling"
Cohesion: 0.13
Nodes (13): normalizeSmsLineForCompare(), PlatformSaasAdmin(), deleteArticle(), saveArticle(), saveSmsProvider(), updateInquiryStatus(), PlatformSaasAdminProps, SmsIrLineLookup (+5 more)

### Community 21 - "Module Status Tracker"
Cohesion: 0.11
Nodes (19): PlatformAdminPortalProps, PlatformTab, TABS, Agent, Department, Detail, Event, eventLabel (+11 more)

### Community 22 - "Architecture Decisions"
Cohesion: 0.12
Nodes (16): dependencies, bcryptjs@^3.0.3, dotenv@17.3.1, drizzle-orm@0.45.2, lucide-react@^1.73.0, next@16.4.2, pg@8.20.0, react@19.2.6 (+8 more)

### Community 23 - "react"
Cohesion: 0.12
Nodes (19): react, AppPortalPage(), dynamic, BusinessOsShell(), handleLogout(), switchOrg(), LoginView(), doLogin() (+11 more)

### Community 24 - "Current Module Status & Coordination Tracker"
Cohesion: 0.18
Nodes (9): Atomic Room Cursor Checkpoint, Checkpoint Acknowledgment, HMAC-Signed Cursor, sync_change_log, sync_outbox, Non-Destructive Checkpoint Reset, Opaque Cursor Tampering & Reset, Tombstone Soft Delete (+1 more)

### Community 25 - "Decisions"
Cohesion: 0.13
Nodes (15): Accounting Engine (Double-Entry, Books, XLSX), Advanced Cheque Lifecycle & Daily Bar Analytics, CRM Profiles, Segmentation & Loyalty Ledger, Current Module Status & Coordination Tracker, Employees & Strict Scoped RBAC, Identity, Auth, Refresh Rotation & Devices, Inventory, Stock Ledger, Transfers & Counts, Multi-Tenancy, RLS & Platform Admin Portal (+7 more)

### Community 26 - "Inventory Settlement Contract"
Cohesion: 0.21
Nodes (6): Decisions, Atomic Stock Ledger, Business OS Platform, Business OS Project Overview, Double-Entry Accounting, Offline Android Bidirectional Sync

### Community 27 - "Server Sync Persistence"
Cohesion: 0.16
Nodes (14): Decimal-Safe Landed Cost Allocation, Incoming Warehouse Receipt, Inventory Excel Exports, Inventory Settlement Contract, Physical Sales Return Acceptance, Sales Invoice Mixed Settlements, Supplier Debt Settlement, Warehouse Transfer Lifecycle (+6 more)

### Community 28 - "2026-11-18-advanced-support-tickets.sql"
Cohesion: 0.16
Nodes (13): Room Sync Outbox, Transactional Sync Outbox, Pull Cursor Recovery, Idempotent Replay, Organization-Partitioned Local Data, Outbox Retry, Logout with Pending Outbox, Crash, Network, and Multi-Device Recovery Strategy (+5 more)

### Community 29 - "Backend Extension Audit"
Cohesion: 0.18
Nodes (14): idx_support_ticket_departments_active_order, idx_support_ticket_events_ticket_created, idx_support_ticket_messages_ticket_created, idx_support_tickets_department_activity, idx_support_tickets_org_activity, idx_support_tickets_status_activity, support_ticket_departments, support_ticket_events (+6 more)

### Community 30 - "API Request Examples"
Cohesion: 0.17
Nodes (12): Accountant Role, Billing Admin Role, Business OS Permission Matrix, Organization Authorization Realm, Owner Role, Platform Ops Role, Platform Authorization Realm, Salesperson Role (+4 more)

### Community 31 - "Financial Dashboard Metrics"
Cohesion: 0.17
Nodes (7): PostgreSQL Sync Inbox, Double-Entry Accounting, Point-in-Time Recovery, PostgreSQL, Sync Conflicts, Sync Inbox, Sync Logs

### Community 32 - "Crash, Network, and Multi-Device Recovery Strategy"
Cohesion: 0.17
Nodes (8): Glass Data Surface, Glass Input Surface, Glass Modal Surface, Glass Navigation Surface, Glass Primary Surface, Glass Secondary Surface, Radial Mesh Background, Light, Dark, and System Themes

### Community 33 - "Jalali Date Conversion and Display"
Cohesion: 0.17
Nodes (12): API Endpoint Extensions, Backend Extension Audit, Backend Extension Completion Report, Drizzle Migration, Business OS E2E Tests, File Storage Security, New Permissions, Personal Transfer API (+4 more)

### Community 34 - "API Versioning Policy"
Cohesion: 0.24
Nodes (11): Journal Entry Request Example, Paginated Contacts Response Contract, Request Response Examples, Canonical Gregorian Business Date Storage, Jalali Date Contract, Jalali Date Conversion and Display, Organization Timezone Business Day, Fixed-Point Balanced Journal Validation (+3 more)

### Community 35 - "Server-Authoritative Database"
Cohesion: 0.22
Nodes (11): Financial Dashboard Metrics, Interactive Drill-Down, Daily Business Expense Chart, Financial Transactions, Posted Journal Entry Lines, Owner Withdrawals, Personal Transactions, Daily Revenue Chart (+3 more)

### Community 36 - "Shared Field Dictionary"
Cohesion: 0.18
Nodes (9): Master Prompt 09A Backend Audit and Implementation Plan, Existing Functionality Inventory, Subscription Entitlement Contract, Payment Gateway Status Retrieval, Initial Migration Endpoints, Invoice Payment Allocations, Supplier Account Endpoints, Warehouse Transfer Workflow (+1 more)

### Community 37 - "Backend Extension Decisions"
Cohesion: 0.22
Nodes (8): Offline Capability Matrix, Offline Contact Operations, Offline Journal Entry Lifecycle, Local Snapshot Reports, Offline Product Operations, Offline Purchase Lifecycle, Offline Sales Lifecycle, Offline Cash Receipt and Payment

### Community 38 - "Server-Authoritative Entitlement Snapshot"
Cohesion: 0.22
Nodes (13): ProductPickerModal(), ProductRow, valueOf(), decimalValue(), englishDigits(), ITEM_TYPES, ItemType, normalizeLabel() (+5 more)

### Community 39 - "Product Catalog ERD"
Cohesion: 0.33
Nodes (9): Api Versioning, Backward-Compatible API Additions, Breaking API Change Policy, Client Version Negotiation, Cross-Agent API Contract Governance, Android Room Schema Version 2, API Contract Version 1.1.0, Shared Contract Version Registry (+1 more)

### Community 40 - "Personal Finance Boundaries"
Cohesion: 0.36
Nodes (9): Authoritative Subscription Refresh, Iranian Payment Gateway Adapters, Payment Flow Contract, Payment Gateway Callback Verification, Subscription Upgrade Initiation, Encrypted Offline Entitlement Cache, Entitlement Versioning, Server-Authoritative Entitlement Snapshot (+1 more)

### Community 41 - "Core Module Invariants"
Cohesion: 0.20
Nodes (9): Contact Fields, Shared Field Dictionary, Sales and Purchase Invoice Fields, Journal Entry Fields, Organization Fields, Product Fields, CafeBazaar Receipt Verification, Offline Sync Batch Push (+1 more)

### Community 42 - "Organization Sync Authorization"
Cohesion: 0.20
Nodes (10): Advanced Accounting Extensions, Atomic User and Organization Registration, Backend Extension Audit, Modular Monolith Backend Baseline, Consignment Ledger Extension, Backend Extension Gaps, Personal Transfer Endpoint, Item-Level Sales and Purchase Returns (+2 more)

### Community 43 - "Crypto and Spreadsheet Exports"
Cohesion: 0.25
Nodes (9): Brands, Categories, Product Units, Products, Stock Document Items, Stock Documents, Stock Ledger, Units (+1 more)

### Community 44 - "Journal Posting Rules"
Cohesion: 0.33
Nodes (7): Business Journal Entry, Owner Contribution, Personal Expenses, Personal Finance Ledger, Personal Transactions, Recurring Obligations, Owner Withdrawal

### Community 45 - "Brand Typography"
Cohesion: 0.22
Nodes (4): Identity Core Module, Organization Workspace, Platform Admin Portal, Business OS System Architecture

### Community 46 - "Balanced Double-Entry Journal Voucher"
Cohesion: 0.22
Nodes (9): Organization Membership and Device Authorization, Role-Based Access Control (RBAC), Tenant Transaction, Device Revocation, Tenant Isolation & RBAC, Scenario I — RBAC, Scenario K — Tenant Isolation, Security Audit Logs (+1 more)

### Community 47 - "Android Room Sync Protocol"
Cohesion: 0.46
Nodes (6): Customer Receivable Payment Posting, Journal Posting Rules, Mixed-Payment Sales Posting, Purchase Invoice Posting, Quick Expense and Income Account Mapping, Receivable Cheque Journal Lifecycle

### Community 48 - "Personal Finance Ledger"
Cohesion: 0.29
Nodes (6): AsroTravel Production Assets, IRANSansWeb, Persian Typography Integration Specification, Typography Scale, Vazirmatn, Yekan Bakh

### Community 49 - "Graph first codebase exploration"
Cohesion: 0.25
Nodes (7): Authoritative Confirmations and Movements, Child Reference Entities, Sync Entity Dependency Order, Draft Commercial and Consignment Documents, Parent Dependency Check, Structural Reference Entities, Organization Tenant Root

### Community 50 - "Fiscal Year Lifecycle"
Cohesion: 0.25
Nodes (6): Android Room, PostgreSQL, Server-Side Entitlements, Stock Ledger, Independent Product Variants, Scenario D — Product Variants

### Community 51 - "Fiscal Year Lifecycle"
Cohesion: 0.36
Nodes (5): metadata, RootLayout(), vazirmatn, PwaRegistration(), ThemeProvider()

### Community 52 - "Invitation Security"
Cohesion: 0.29
Nodes (3): Graphify project knowledge graph, graphify query command, graphify update command

### Community 53 - "Financial Conflict Resolution"
Cohesion: 0.52
Nodes (7): Account Closure, Controlled Fiscal Year Reopening, Fiscal Year Closing, Fiscal Year Lifecycle, Opening Balance Journal Voucher, Permanent Account Carry-Forward, Retained Earnings Account

### Community 54 - "Stock Ledger"
Cohesion: 0.43
Nodes (7): Android Changelog V1.2, Invoice Return Integrity Guard, Organization Registration Bootstrap, OTP Authentication Security Flow, Public Academy Content API, Public Android API, SMS.ir and Kavenegar Providers

### Community 55 - "Android Offline-First API Consumption"
Cohesion: 0.29
Nodes (5): Security Audit Trail, Single-Use Expiring Invitation, Member Suspension, Organization Membership Lifecycle, Session Revocation

### Community 56 - "Karvexa Graphify maintenance workflow"
Cohesion: 0.38
Nodes (3): Payment Mismatch Conflict, Reference Data Conflicts, Stock Shortage Conflict

### Community 57 - "Project Scripts"
Cohesion: 0.60
Nodes (6): Android Api Matrix, Android Offline-First API Consumption, Commercial Document Status, Local Sync Status, Online-Only CafeBazaar Billing, Room Outbox and Cache

### Community 58 - "Platform API Access Matrix"
Cohesion: 0.60
Nodes (6): Cached Entitlement Snapshot for Offline Use, Cloud Migration Completion, CLOUD_SYNC and OFFLINE_ONLY Operating Modes, Offline Only Mode Contract, Offline-Only Sync Blocking, Resumable Cloud Reactivation Migration

### Community 59 - "Treasury and Cheque Rules"
Cohesion: 0.33
Nodes (6): Monotonic Sync Change Log, Sync Checkpoints, Idempotency Keys, Sync Conflicts, Bidirectional Sync Engine, Sync Inbox

### Community 60 - "Domain-Based Conflict Resolution Policy"
Cohesion: 0.29
Nodes (4): xlsx@^0.18.5, xlsx, req(), run()

### Community 61 - "Treasury Account Contract"
Cohesion: 0.33
Nodes (6): scripts, build, dev, lint, start, typecheck

### Community 62 - "sms/service.ts"
Cohesion: 0.20
Nodes (16): otpCodes, smsLogs, smsSettings, DEFAULT_ACADEMY_ARTICLES, DEFAULT_PAYMENT_GATEWAYS, DEFAULT_SMS_PROVIDERS, ensureSaasSeeded(), getSmsIrLineNumbers() (+8 more)

### Community 63 - "Cross platform API, offline sync, and accounting flows"
Cohesion: 0.80
Nodes (4): Admin Api Matrix, Organization Workspace Realm, Platform Admin Portal Realm, Realm-Scoped RBAC

### Community 64 - "Room and PostgreSQL Mapping"
Cohesion: 0.60
Nodes (3): Controlled Cheque Editing, Treasury Account Contract, Treasury Accounts

### Community 65 - "xlsx"
Cohesion: 0.40
Nodes (5): Accounting Periods, Accounts, Fiscal Years, Journal Entries, Journal Entry Lines

### Community 66 - "scripts"
Cohesion: 0.50
Nodes (5): Devices, Organization Memberships, Organizations, Sessions, Users

### Community 67 - "treasury/controller.ts"
Cohesion: 0.11
Nodes (20): accountingCategories, bankReconciliations, categoryAccountMappings, cheques, employees, financialAccounts, financialTransactions, idempotencyKeys (+12 more)

### Community 68 - "Database Platform Schema"
Cohesion: 0.67
Nodes (4): Cross-platform API, offline-sync, and accounting flows, graphify merge-graphs command, Karvexa OS Android project graph, Karvexa web project graph

### Community 69 - "Unified Database Schema"
Cohesion: 0.83
Nodes (3): PostgreSQL Database, REST API Contract, Android Room Database

### Community 71 - "Sales Invoices"
Cohesion: 0.67
Nodes (3): PostgreSQL Sync Change Log, Monotonic Ordered Change Log, HMAC-Signed Pull Cursor

### Community 72 - "Conflict Resolution API"
Cohesion: 0.67
Nodes (3): PostgreSQL, Android Room / SQLite, Unified Database Schema

### Community 73 - "idx_stock_count_items_variant"
Cohesion: 0.67
Nodes (3): Permissions, Role Permissions, Roles

### Community 74 - "PostgreSQL Contacts Table"
Cohesion: 0.67
Nodes (3): Sales Invoices, Sales Invoice Items, Sales Returns

### Community 75 - "Purchase Document Mapping"
Cohesion: 0.67
Nodes (3): Allowed Manual Resolutions, Conflict Resolution API, Conflict Resolution Audit Trail

### Community 93 - "package.json"
Cohesion: 0.18
Nodes (10): @types/bcryptjs@^2.4.6, tailwindcss@4.1.17, @tailwindcss/postcss@4.1.17, @types/node@22.19.15, name, private, tailwindcss, @tailwindcss/postcss (+2 more)

### Community 136 - "accounting/controller.ts"
Cohesion: 0.11
Nodes (19): accountGroups, accountingPeriods, accountingPolicies, branches, costCenters, devices, fiscalYears, journalEntryLines (+11 more)

### Community 137 - "seed.ts"
Cohesion: 0.14
Nodes (16): barcodes, brands, cashboxes, categories, chequeEvents, consignmentDocuments, consignmentItems, contactGroups (+8 more)

### Community 139 - "bootstrapOrganizationDefaults"
Cohesion: 0.50
Nodes (4): bootstrapOrganizationDefaults(), dayBeforeIso(), ensurePrompt05Seeded(), runSeed()

## Knowledge Gaps
- **231 isolated node(s):** `Audit Core Module`, `Catalog Core Module`, `Cheques Core Module`, `Consignment Core Module`, `Contacts Core Module` (+226 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 513 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **65 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Work-memory lessons

**Preferred sources** — corroborated by past sessions; start here.
- `accounting/controller.ts` (2× useful, score=1.998021584) _(code changed — re-verify)_

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `apiFetch()` connect `apiFetch` to `auth/controller.ts`, `OrgWorkspace.tsx`, `sync/service.ts`, `Server-Authoritative Entitlement Snapshot`, `seed.ts`, `subscription/controller.ts`, `Background Sync Scheduling`, `Module Status Tracker`, `react`?**
  _High betweenness centrality (0.059) - this node is a cross-community bridge._
- **What connects `Audit Core Module`, `Catalog Core Module`, `Cheques Core Module` to the rest of the system?**
  _231 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `ApiError` be split into smaller, more focused modules?**
  _Cohesion score 0.08351245919910835 - nodes in this community are weakly interconnected._
- **Why does `next` connect `ok` to `ApiError`, `auth/controller.ts`, `treasury/controller.ts`, `sync/service.ts`, `accounting/controller.ts`, `ensureSeeded`, `sitemap.ts`, `seed.ts`, `subscription/controller.ts`, `Fiscal Year Lifecycle`, `Architecture Decisions`, `react`, `package.json`?**
  _High betweenness centrality (0.050) - this node is a cross-community bridge._
- **Should `ok` be split into smaller, more focused modules?**
  _Cohesion score 0.05466364621294199 - nodes in this community are weakly interconnected._
- **Why does `drizzle-orm` connect `ok` to `ApiError`, `auth/controller.ts`, `treasury/controller.ts`, `schema.ts`, `sync/service.ts`, `accounting/controller.ts`, `seed.ts`, `sitemap.ts`, `ensureSeeded`, `subscription/controller.ts`, `sync/service.ts`, `Architecture Decisions`, `package.json`, `sms/service.ts`?**
  _High betweenness centrality (0.022) - this node is a cross-community bridge._
- **Should `auth/controller.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.135632183908046 - nodes in this community are weakly interconnected._
# Graph Report - karvexa  (2026-11-18)

## Corpus Check
- 154 files · ~188,890 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 3 file(s) not represented in the graph (top: (none) 1, .css 1, .tsbuildinfo 1)

## Summary
- 1389 nodes · 4510 edges · 131 communities (77 shown, 54 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 27 edges (avg confidence: 0.91)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `17a51c9b`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Core Finance Records
- ok
- ApiError
- schema.ts
- Advanced Business Operations
- tenant.ts
- saas/controller.ts
- lucide-react
- errors.ts
- PlatformSaasAdmin
- Sync Entity Manifest
- Advanced Modules UI
- Build Toolchain
- personal-finance/service.ts
- TypeScript Configuration
- Accounting and Reports
- API Contracts
- Offline Database State
- Sync Conflict Handling
- Runtime Dependencies
- Background Sync Scheduling
- Module Status Tracker
- Architecture Decisions
- Inventory Settlement
- Sync Outbox Recovery
- BusinessParityPanels.tsx
- Roles and Permissions
- Server Sync Persistence
- Glassmorphism Design System
- Backend Extension Audit
- API Request Examples
- Financial Dashboard Metrics
- Backend Audit Plan
- Offline Capability Matrix
- API Versioning Policy
- Android Offline-First API Consumption
- Shared Field Dictionary
- Backend Extension Decisions
- Q: MASTER PROMPT 06 — GLASSMORPHISM UI REDESIGN, ASROTRAVEL TYPOGRAPHY, FINANCIAL DASHBOARD, USER ACCESS MANAGEMENT & FISCAL YEAR LIFECYCLE
- Product Catalog ERD
- Personal Finance Boundaries
- Core Module Invariants
- Organization Sync Authorization
- Crypto and Spreadsheet Exports
- Journal Posting Rules
- Brand Typography
- Sync Entity Ordering
- Android Room Sync Protocol
- gregorianIsoToJalali
- Graph first codebase exploration
- Fiscal Year Lifecycle
- Android API Changes
- Invitation Security
- Financial Conflict Resolution
- PlatformAdminPortal
- layout.tsx
- Sync Database Tables
- Project Scripts
- Platform API Access Matrix
- Treasury and Cheque Rules
- Accounting Entity Relations
- Identity Entity Relations
- LoginView.tsx
- Cross platform API, offline sync, and accounting flows
- Room and PostgreSQL Mapping
- Q: personal finance withdrawal invoice replenishment loyalty employee cheque accounting report dashboard permission
- Change Log and Pull Cursor
- Database Platform Schema
- RBAC Entity Relations
- Sales Document Relations
- Conflict Resolution API
- Contact Data Mapping
- Journal Entry Mapping
- Product Data Mapping
- Purchase Document Mapping
- Sales Document Mapping
- Stock Ledger Mapping
- Tenant Isolation Policies
- Cheque Entity Relations
- Consignment Entity Relations
- Contact Entity Relations
- Financial Transaction Relations
- Purchase Invoice Relations
- Sync Batch Relations
- Signed Cursors and Tombstones
- Business and Sync Status
- PostCSS Configuration
- PostgreSQL Sync Conflicts
- Sync Change Log
- Accounting Core Module
- Audit Core Module
- Catalog Core Module
- Cheques Core Module
- Consignment Core Module
- Contacts Core Module
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
- payment-gateways/route.ts
- postcss@8.5.23
- Cross-Layer Field Mapping
- Q: MASTER PROMPT 07 — audit backend API registration, invoice returns, consignment, accounting policy and sync
- Q: MASTER PROMPT 08 — audit shared Backend inventory, settlement, transfer, treasury, offline mode and subscription contracts
- Q: Compare Karvexa backend to MASTER PROMPT 09A
- Q: Check Android Prompt 09B integration dependencies against Karvexa Backend

## God Nodes (most connected - your core abstractions)
1. `ApiError` - 135 edges
2. `recordAuditLog()` - 100 edges
3. `apiFetch()` - 96 edges
4. `ok()` - 92 edges
5. `ensureSeeded()` - 73 edges
6. `formatDecimal()` - 65 edges
7. `withTenantTransaction()` - 63 edges
8. `parseDecimal()` - 62 edges
9. `addDec()` - 61 edges
10. `drizzle-orm` - 60 edges

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

## Communities (131 total, 54 thin omitted)

### Community 0 - "Core Finance Records"
Cohesion: 0.07
Nodes (160): accountGroups, accountingCategories, accountingPeriods, accountingPolicies, accounts, branches, categoryAccountMappings, chequeEvents (+152 more)

### Community 1 - "ok"
Cohesion: 0.14
Nodes (42): GET(), DELETE(), GET(), PATCH(), POST(), GET(), GET(), GET() (+34 more)

### Community 2 - "ApiError"
Cohesion: 0.06
Nodes (96): DELETE(), dispatch(), dynamic, extractSegments(), GET(), PATCH(), POST(), PUT() (+88 more)

### Community 3 - "schema.ts"
Cohesion: 0.06
Nodes (51): accountClosures, bankReconciliations, barcodes, brands, cashboxes, categories, chequeAssignments, cloudMigrationSessions (+43 more)

### Community 4 - "Advanced Business Operations"
Cohesion: 0.07
Nodes (46): AdvancedModulesPanel(), handleConvertQuotation(), handleConvertSuggestionToPo(), handleCreateAndConfirmMixedSale(), handleCreateEmployee(), handleCreateQuotation(), handleCreateRecurring(), handleCreateVariantWithOpeningStock() (+38 more)

### Community 5 - "tenant.ts"
Cohesion: 0.10
Nodes (35): drizzle-orm, zod, dynamic, patchErrorSchema, patchSchema, toggleSchema, patchSettingSchema, createUserSchema (+27 more)

### Community 6 - "saas/controller.ts"
Cohesion: 0.24
Nodes (9): overrideEntitlementSchema, contactInquiries, entitlements, features, planFeatures, purchaseReceipts, recordSystemError(), callCafeBazaarOfficialVerifier() (+1 more)

### Community 7 - "lucide-react"
Cohesion: 0.12
Nodes (24): nextConfig, next, AboutPage(), dynamic, AcademyIndexPage(), dynamic, AcademyArticleDetailPage(), dynamic (+16 more)

### Community 8 - "errors.ts"
Cohesion: 0.22
Nodes (7): CONTRACT_FILES, camelToSnakeKey(), ErrorDetailItem, ListQueryParams, newRequestId(), okNoContent(), toSnakeCase()

### Community 9 - "PlatformSaasAdmin"
Cohesion: 0.16
Nodes (10): PlatformSaasAdmin(), deleteArticle(), saveArticle(), saveSmsProvider(), updateInquiryStatus(), RichTextEditor(), handleInsertImageUrl(), handleInsertLink() (+2 more)

### Community 10 - "Sync Entity Manifest"
Cohesion: 0.11
Nodes (22): Account Code Sync Entity, Branch Sync Entity, Cheque Sync Entity, Consignment Document Sync Entity, Contact Sync Entity, Cost Center Sync Entity, Employee Sync Entity, Journal Entry Sync Entity (+14 more)

### Community 11 - "Advanced Modules UI"
Cohesion: 0.11
Nodes (29): lucide-react, react, recharts, AdvancedModulesPanelProps, AdvancedSubTab, FiscalLifecyclePanelProps, DateRangeKey, GlassDashboard() (+21 more)

### Community 12 - "Build Toolchain"
Cohesion: 0.12
Nodes (23): devDependencies, drizzle-kit@0.31.10, eslint@9.39.4, eslint-config-next@16.4.2, tailwindcss@4.1.17, @tailwindcss/postcss@4.1.17, @types/node@22.19.15, @types/pg@8.18.0 (+15 more)

### Community 13 - "personal-finance/service.ts"
Cohesion: 0.27
Nodes (17): ownerContributions, ownerWithdrawals, personalAccounts, personalExpenseCategories, personalFinanceProfiles, personalRecurringTransactions, personalTransactions, addRecurrenceInterval() (+9 more)

### Community 14 - "TypeScript Configuration"
Cohesion: 0.10
Nodes (19): compilerOptions, allowJs, baseUrl, esModuleInterop, incremental, isolatedModules, jsx, lib (+11 more)

### Community 15 - "Accounting and Reports"
Cohesion: 0.12
Nodes (19): Double-Entry Accounting, Accounting Reports and XLSX Export, Business P&L, Cheque Lifecycle, Loyalty Points, Master Prompt 05 Acceptance Criteria (Scenarios A–K), OWNER_DRAWINGS (3201), Partial Payment Status (+11 more)

### Community 16 - "API Contracts"
Cohesion: 0.24
Nodes (12): Canonical API Modules, Central API Contract, Decimal String Data Contract, Endpoints, Mutating Request Headers, Unified Response Envelope, Accounting Integrity Error Handling, Errors (+4 more)

### Community 17 - "Offline Database State"
Cohesion: 0.12
Nodes (15): Sync Acknowledgement, Sync Cursor State, Android Local-First Database, Offline Draft Documents, Local Reference Data Projections, Android Room, Sync Acknowledge Endpoint, Sync Checkpoints Endpoint (+7 more)

### Community 18 - "Sync Conflict Handling"
Cohesion: 0.15
Nodes (16): Base Version Conflict Detection, Dependency Validation, Idempotency Key, sync_inbox, Sync Telemetry, Financial Immutability Conflict, FINANCIAL_IMMUTABLE Conflict, Mandatory Sync, Data & Financial Integration Test Cases (+8 more)

### Community 19 - "Runtime Dependencies"
Cohesion: 0.12
Nodes (17): dependencies, bcryptjs@^3.0.3, dotenv@17.3.1, drizzle-orm@0.45.2, lucide-react@^1.73.0, next@16.4.2, pg@8.20.0, react@19.2.6 (+9 more)

### Community 20 - "Background Sync Scheduling"
Cohesion: 0.18
Nodes (9): Atomic Room Cursor Checkpoint, Checkpoint Acknowledgment, HMAC-Signed Cursor, sync_change_log, sync_outbox, Non-Destructive Checkpoint Reset, Opaque Cursor Tampering & Reset, Tombstone Soft Delete (+1 more)

### Community 21 - "Module Status Tracker"
Cohesion: 0.13
Nodes (15): Accounting Engine (Double-Entry, Books, XLSX), Advanced Cheque Lifecycle & Daily Bar Analytics, CRM Profiles, Segmentation & Loyalty Ledger, Current Module Status & Coordination Tracker, Employees & Strict Scoped RBAC, Identity, Auth, Refresh Rotation & Devices, Inventory, Stock Ledger, Transfers & Counts, Multi-Tenancy, RLS & Platform Admin Portal (+7 more)

### Community 22 - "Architecture Decisions"
Cohesion: 0.21
Nodes (6): Decisions, Atomic Stock Ledger, Business OS Platform, Business OS Project Overview, Double-Entry Accounting, Offline Android Bidirectional Sync

### Community 23 - "Inventory Settlement"
Cohesion: 0.16
Nodes (14): Decimal-Safe Landed Cost Allocation, Incoming Warehouse Receipt, Inventory Excel Exports, Inventory Settlement Contract, Physical Sales Return Acceptance, Sales Invoice Mixed Settlements, Supplier Debt Settlement, Warehouse Transfer Lifecycle (+6 more)

### Community 24 - "Sync Outbox Recovery"
Cohesion: 0.16
Nodes (13): Room Sync Outbox, Transactional Sync Outbox, Pull Cursor Recovery, Idempotent Replay, Organization-Partitioned Local Data, Outbox Retry, Logout with Pending Outbox, Crash, Network, and Multi-Device Recovery Strategy (+5 more)

### Community 25 - "BusinessParityPanels.tsx"
Cohesion: 0.09
Nodes (38): AccountingParityPanel(), createCenter(), CommerceParityPanel(), createPurchase(), openReturn(), submitReturn(), downloadReport(), InventoryParityPanel() (+30 more)

### Community 26 - "Roles and Permissions"
Cohesion: 0.17
Nodes (12): Accountant Role, Billing Admin Role, Business OS Permission Matrix, Organization Authorization Realm, Owner Role, Platform Ops Role, Platform Authorization Realm, Salesperson Role (+4 more)

### Community 27 - "Server Sync Persistence"
Cohesion: 0.17
Nodes (7): PostgreSQL Sync Inbox, Double-Entry Accounting, Point-in-Time Recovery, PostgreSQL, Sync Conflicts, Sync Inbox, Sync Logs

### Community 28 - "Glassmorphism Design System"
Cohesion: 0.17
Nodes (8): Glass Data Surface, Glass Input Surface, Glass Modal Surface, Glass Navigation Surface, Glass Primary Surface, Glass Secondary Surface, Radial Mesh Background, Light, Dark, and System Themes

### Community 29 - "Backend Extension Audit"
Cohesion: 0.17
Nodes (12): API Endpoint Extensions, Backend Extension Audit, Backend Extension Completion Report, Drizzle Migration, Business OS E2E Tests, File Storage Security, New Permissions, Personal Transfer API (+4 more)

### Community 30 - "API Request Examples"
Cohesion: 0.21
Nodes (12): Journal Entry Request Example, Login Request and Response Contract, Paginated Contacts Response Contract, Request Response Examples, Canonical Gregorian Business Date Storage, Jalali Date Contract, Jalali Date Conversion and Display, Organization Timezone Business Day (+4 more)

### Community 31 - "Financial Dashboard Metrics"
Cohesion: 0.22
Nodes (11): Financial Dashboard Metrics, Interactive Drill-Down, Daily Business Expense Chart, Financial Transactions, Posted Journal Entry Lines, Owner Withdrawals, Personal Transactions, Daily Revenue Chart (+3 more)

### Community 32 - "Backend Audit Plan"
Cohesion: 0.18
Nodes (9): Master Prompt 09A Backend Audit and Implementation Plan, Existing Functionality Inventory, Subscription Entitlement Contract, Payment Gateway Status Retrieval, Initial Migration Endpoints, Invoice Payment Allocations, Supplier Account Endpoints, Warehouse Transfer Workflow (+1 more)

### Community 33 - "Offline Capability Matrix"
Cohesion: 0.22
Nodes (8): Offline Capability Matrix, Offline Contact Operations, Offline Journal Entry Lifecycle, Local Snapshot Reports, Offline Product Operations, Offline Purchase Lifecycle, Offline Sales Lifecycle, Offline Cash Receipt and Payment

### Community 34 - "API Versioning Policy"
Cohesion: 0.33
Nodes (9): Api Versioning, Backward-Compatible API Additions, Breaking API Change Policy, Client Version Negotiation, Cross-Agent API Contract Governance, Android Room Schema Version 2, API Contract Version 1.1.0, Shared Contract Version Registry (+1 more)

### Community 35 - "Android Offline-First API Consumption"
Cohesion: 0.16
Nodes (21): Android Api Matrix, Android Offline-First API Consumption, Commercial Document Status, Local Sync Status, Online-Only CafeBazaar Billing, Room Outbox and Cache, Cached Entitlement Snapshot for Offline Use, Cloud Migration Completion (+13 more)

### Community 36 - "Shared Field Dictionary"
Cohesion: 0.20
Nodes (9): Contact Fields, Shared Field Dictionary, Sales and Purchase Invoice Fields, Journal Entry Fields, Organization Fields, Product Fields, CafeBazaar Receipt Verification, Offline Sync Batch Push (+1 more)

### Community 37 - "Backend Extension Decisions"
Cohesion: 0.20
Nodes (10): Advanced Accounting Extensions, Atomic User and Organization Registration, Backend Extension Audit, Modular Monolith Backend Baseline, Consignment Ledger Extension, Backend Extension Gaps, Personal Transfer Endpoint, Item-Level Sales and Purchase Returns (+2 more)

### Community 38 - "Q: MASTER PROMPT 06 — GLASSMORPHISM UI REDESIGN, ASROTRAVEL TYPOGRAPHY, FINANCIAL DASHBOARD, USER ACCESS MANAGEMENT & FISCAL YEAR LIFECYCLE"
Cohesion: 0.40
Nodes (4): Answer, Outcome, Q: MASTER PROMPT 06 — GLASSMORPHISM UI REDESIGN, ASROTRAVEL TYPOGRAPHY, FINANCIAL DASHBOARD, USER ACCESS MANAGEMENT & FISCAL YEAR LIFECYCLE, Source Nodes

### Community 39 - "Product Catalog ERD"
Cohesion: 0.25
Nodes (9): Brands, Categories, Product Units, Products, Stock Document Items, Stock Documents, Stock Ledger, Units (+1 more)

### Community 40 - "Personal Finance Boundaries"
Cohesion: 0.33
Nodes (7): Business Journal Entry, Owner Contribution, Personal Expenses, Personal Finance Ledger, Personal Transactions, Recurring Obligations, Owner Withdrawal

### Community 41 - "Core Module Invariants"
Cohesion: 0.22
Nodes (4): Identity Core Module, Organization Workspace, Platform Admin Portal, Business OS System Architecture

### Community 42 - "Organization Sync Authorization"
Cohesion: 0.22
Nodes (9): Organization Membership and Device Authorization, Role-Based Access Control (RBAC), Tenant Transaction, Device Revocation, Tenant Isolation & RBAC, Scenario I — RBAC, Scenario K — Tenant Isolation, Security Audit Logs (+1 more)

### Community 43 - "Crypto and Spreadsheet Exports"
Cohesion: 0.25
Nodes (4): xlsx@^0.18.5, xlsx, req(), run()

### Community 44 - "Journal Posting Rules"
Cohesion: 0.46
Nodes (6): Customer Receivable Payment Posting, Journal Posting Rules, Mixed-Payment Sales Posting, Purchase Invoice Posting, Quick Expense and Income Account Mapping, Receivable Cheque Journal Lifecycle

### Community 45 - "Brand Typography"
Cohesion: 0.29
Nodes (6): AsroTravel Production Assets, IRANSansWeb, Persian Typography Integration Specification, Typography Scale, Vazirmatn, Yekan Bakh

### Community 46 - "Sync Entity Ordering"
Cohesion: 0.25
Nodes (7): Authoritative Confirmations and Movements, Child Reference Entities, Sync Entity Dependency Order, Draft Commercial and Consignment Documents, Parent Dependency Check, Structural Reference Entities, Organization Tenant Root

### Community 47 - "Android Room Sync Protocol"
Cohesion: 0.25
Nodes (6): Android Room, PostgreSQL, Server-Side Entitlements, Stock Ledger, Independent Product Variants, Scenario D — Product Variants

### Community 48 - "gregorianIsoToJalali"
Cohesion: 0.24
Nodes (19): fa(), JalaliDatePicker(), JalaliMonthPicker(), jalaliToIsoSafe(), MONTHS, normalizeJalali(), pad(), valueToJalali() (+11 more)

### Community 49 - "Graph first codebase exploration"
Cohesion: 0.29
Nodes (3): Graphify project knowledge graph, graphify query command, graphify update command

### Community 50 - "Fiscal Year Lifecycle"
Cohesion: 0.52
Nodes (7): Account Closure, Controlled Fiscal Year Reopening, Fiscal Year Closing, Fiscal Year Lifecycle, Opening Balance Journal Voucher, Permanent Account Carry-Forward, Retained Earnings Account

### Community 51 - "Android API Changes"
Cohesion: 0.43
Nodes (7): Android Changelog V1.2, Invoice Return Integrity Guard, Organization Registration Bootstrap, OTP Authentication Security Flow, Public Academy Content API, Public Android API, SMS.ir and Kavenegar Providers

### Community 52 - "Invitation Security"
Cohesion: 0.29
Nodes (5): Security Audit Trail, Single-Use Expiring Invitation, Member Suspension, Organization Membership Lifecycle, Session Revocation

### Community 53 - "Financial Conflict Resolution"
Cohesion: 0.38
Nodes (3): Payment Mismatch Conflict, Reference Data Conflicts, Stock Shortage Conflict

### Community 54 - "PlatformAdminPortal"
Cohesion: 0.15
Nodes (13): AppPortalPage(), dynamic, BusinessOsShell(), handleLogout(), switchOrg(), PlatformAdminPortal(), handleCreateOrg(), handleCreateUser() (+5 more)

### Community 55 - "layout.tsx"
Cohesion: 0.36
Nodes (5): metadata, RootLayout(), vazirmatn, PwaRegistration(), ThemeProvider()

### Community 56 - "Sync Database Tables"
Cohesion: 0.33
Nodes (6): Monotonic Sync Change Log, Sync Checkpoints, Idempotency Keys, Sync Conflicts, Bidirectional Sync Engine, Sync Inbox

### Community 57 - "Project Scripts"
Cohesion: 0.33
Nodes (6): scripts, build, dev, lint, start, typecheck

### Community 58 - "Platform API Access Matrix"
Cohesion: 0.80
Nodes (4): Admin Api Matrix, Organization Workspace Realm, Platform Admin Portal Realm, Realm-Scoped RBAC

### Community 59 - "Treasury and Cheque Rules"
Cohesion: 0.60
Nodes (3): Controlled Cheque Editing, Treasury Account Contract, Treasury Accounts

### Community 60 - "Accounting Entity Relations"
Cohesion: 0.40
Nodes (5): Accounting Periods, Accounts, Fiscal Years, Journal Entries, Journal Entry Lines

### Community 61 - "Identity Entity Relations"
Cohesion: 0.50
Nodes (5): Devices, Organization Memberships, Organizations, Sessions, Users

### Community 62 - "LoginView.tsx"
Cohesion: 0.22
Nodes (8): LoginView(), doLogin(), requestOtp(), submitOtp(), LoginViewProps, PRESENTATION_SLIDES, PresentationSlide, SlideVisualStage()

### Community 63 - "Cross platform API, offline sync, and accounting flows"
Cohesion: 0.67
Nodes (4): Cross-platform API, offline-sync, and accounting flows, graphify merge-graphs command, Karvexa OS Android project graph, Karvexa web project graph

### Community 64 - "Room and PostgreSQL Mapping"
Cohesion: 0.83
Nodes (3): PostgreSQL Database, REST API Contract, Android Room Database

### Community 66 - "Q: personal finance withdrawal invoice replenishment loyalty employee cheque accounting report dashboard permission"
Cohesion: 0.40
Nodes (4): Answer, Outcome, Q: personal finance withdrawal invoice replenishment loyalty employee cheque accounting report dashboard permission, Source Nodes

### Community 67 - "Change Log and Pull Cursor"
Cohesion: 0.67
Nodes (3): PostgreSQL Sync Change Log, Monotonic Ordered Change Log, HMAC-Signed Pull Cursor

### Community 68 - "Database Platform Schema"
Cohesion: 0.67
Nodes (3): PostgreSQL, Android Room / SQLite, Unified Database Schema

### Community 69 - "RBAC Entity Relations"
Cohesion: 0.67
Nodes (3): Permissions, Role Permissions, Roles

### Community 70 - "Sales Document Relations"
Cohesion: 0.67
Nodes (3): Sales Invoices, Sales Invoice Items, Sales Returns

### Community 71 - "Conflict Resolution API"
Cohesion: 0.67
Nodes (3): Allowed Manual Resolutions, Conflict Resolution API, Conflict Resolution Audit Trail

### Community 120 - "payment-gateways/route.ts"
Cohesion: 0.12
Nodes (16): notifications, paymentGatewaySettings, paymentOrders, smsSettings, DEFAULT_ACADEMY_ARTICLES, DEFAULT_PAYMENT_GATEWAYS, DEFAULT_SMS_PROVIDERS, ballehPayAdapter (+8 more)

### Community 123 - "Cross-Layer Field Mapping"
Cohesion: 0.70
Nodes (5): Cross-Layer Field Mapping, Decimal Precision Mapping, Field Mapping, Offline Client Document ID, Organization ID Tenant Mapping

### Community 125 - "Q: MASTER PROMPT 07 — audit backend API registration, invoice returns, consignment, accounting policy and sync"
Cohesion: 0.40
Nodes (4): Answer, Outcome, Q: MASTER PROMPT 07 — audit backend API registration, invoice returns, consignment, accounting policy and sync, Source Nodes

### Community 126 - "Q: MASTER PROMPT 08 — audit shared Backend inventory, settlement, transfer, treasury, offline mode and subscription contracts"
Cohesion: 0.40
Nodes (4): Answer, Outcome, Q: MASTER PROMPT 08 — audit shared Backend inventory, settlement, transfer, treasury, offline mode and subscription contracts, Source Nodes

### Community 127 - "Q: Compare Karvexa backend to MASTER PROMPT 09A"
Cohesion: 0.40
Nodes (4): Answer, Outcome, Q: Compare Karvexa backend to MASTER PROMPT 09A, Source Nodes

### Community 128 - "Q: Check Android Prompt 09B integration dependencies against Karvexa Backend"
Cohesion: 0.40
Nodes (4): Answer, Outcome, Q: Check Android Prompt 09B integration dependencies against Karvexa Backend, Source Nodes

## Knowledge Gaps
- **231 isolated node(s):** `Account Code Sync Entity`, `Branch Sync Entity`, `Cheque Sync Entity`, `Consignment Document Sync Entity`, `Cost Center Sync Entity` (+226 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 476 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **54 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Work-memory lessons

**Preferred sources** — corroborated by past sessions; start here.
- `accounting/controller.ts` (2× useful, score=1.998021584) _(code changed — re-verify)_

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `apiFetch()` connect `Advanced Business Operations` to `lucide-react`, `PlatformSaasAdmin`, `Advanced Modules UI`, `PlatformAdminPortal`, `BusinessParityPanels.tsx`, `LoginView.tsx`?**
  _High betweenness centrality (0.044) - this node is a cross-community bridge._
- **What connects `Account Code Sync Entity`, `Branch Sync Entity`, `Cheque Sync Entity` to the rest of the system?**
  _231 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Core Finance Records` be split into smaller, more focused modules?**
  _Cohesion score 0.0665904907001841 - nodes in this community are weakly interconnected._
- **Why does `next` connect `lucide-react` to `Core Finance Records`, `ok`, `ApiError`, `schema.ts`, `tenant.ts`, `saas/controller.ts`, `errors.ts`, `Build Toolchain`, `personal-finance/service.ts`, `Runtime Dependencies`, `layout.tsx`, `LoginView.tsx`?**
  _High betweenness centrality (0.042) - this node is a cross-community bridge._
- **Should `ok` be split into smaller, more focused modules?**
  _Cohesion score 0.1391304347826087 - nodes in this community are weakly interconnected._
- **Why does `drizzle-orm` connect `tenant.ts` to `Core Finance Records`, `ok`, `ApiError`, `schema.ts`, `saas/controller.ts`, `lucide-react`, `Build Toolchain`, `personal-finance/service.ts`, `Runtime Dependencies`, `payment-gateways/route.ts`?**
  _High betweenness centrality (0.023) - this node is a cross-community bridge._
- **Should `ApiError` be split into smaller, more focused modules?**
  _Cohesion score 0.06073674752920036 - nodes in this community are weakly interconnected._
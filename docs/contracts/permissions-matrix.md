# Karvexa Business OS — Prompt 08 Granular Permissions Matrix

| Permission Code | Scope | Description | Default Roles |
| --- | --- | --- | --- |
| `sales.settlement.manage` | ORG | Allocate mixed sales settlements (Cash, Bank, Card Terminal, Cheque, Credit, Account Balance) | Owner, Accountant, Salesperson |
| `inventory.receipts.create` | ORG | Create landed-cost incoming warehouse receipts with supplier payables | Owner, Accountant, Warehouse Mgr |
| `inventory.transfers.create` | ORG | Create & dispatch multi-item warehouse transfers (`IN_TRANSIT`) | Owner, Warehouse Mgr |
| `inventory.transfers.receive` | ORG | Independently receive transfers at destination with partial qty & item discrepancies | Owner, Warehouse Mgr |
| `inventory.exports` | ORG | Export filtered warehouse stock & movement history to `.xlsx` | Owner, Accountant, Warehouse Mgr |
| `suppliers.view` | ORG | View supplier profiles, purchase invoices, debts & ledger | Owner, Accountant, Warehouse Mgr |
| `suppliers.settle` | ORG | Record supplier debt settlements generating Treasury + Accounting entries | Owner, Accountant |
| `cheques.update` | ORG | Edit draft cheques or apply audited corrections to active cheques | Owner, Accountant |
| `treasury.accounts.manage` | ORG | Create, edit metadata, and manage Cash/Bank/POS treasury accounts | Owner, Accountant |
| `treasury.transactions.view` | ORG | Inspect treasury account transaction history & opening/current balances | Owner, Accountant |
| `subscriptions.upgrade` | ORG | Initiate subscription plan upgrade & online gateway checkout | Owner |
| `settings.offline_mode.manage` | ORG | Switch between `CLOUD_SYNC` / `OFFLINE_ONLY` and execute cloud reactivation migration | Owner |
| `platform.gateways.manage` | PLATFORM | Configure Zarinpal, Zibal, Balleh Pay & Saman payment gateway adapters | Super Admin, Billing Admin |

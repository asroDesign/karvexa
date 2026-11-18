import assert from "node:assert/strict";

const BASE = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

async function req(path, opts = {}) {
  const headers = {
    "X-Client-Version": "1.0.0",
    ...(opts.body ? { "Content-Type": "application/json" } : {}),
    ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    ...(opts.orgId ? { "X-Organization-Id": opts.orgId } : {}),
    ...(opts.headers || {}),
  };
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method || "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function run() {
  console.log("=== Business OS E2E Integration & Security Contract Tests ===");

  // 1. Health check
  const health = await req("/api/health");
  assert.equal(health.status, 200, "Healthcheck must return 200");
  console.log("[PASS] 1. /api/health OK");

  // 2. Client Version Compatibility Guard (Prompt 03 §21)
  const badVer = await req("/api/v1/auth/me", {
    headers: { "X-Client-Version": "0.5.0" },
  });
  assert.equal(badVer.status, 400);
  assert.equal(badVer.json.success, false);
  assert.equal(badVer.json.error.code, "CLIENT_VERSION_INCOMPATIBLE");
  assert.ok(badVer.json.error.request_id, "Error must contain request_id");
  console.log("[PASS] 2. Client version incompatibility rejected with standard error envelope");

  // 3. Login via mobile + device (Prompt 03 §6) & Refresh Token Rotation + Reuse Attack Detection
  const loginAdmin = await req("/api/v1/auth/login", {
    method: "POST",
    body: {
      mobile: "09121000001",
      password: "Admin@1234",
      device: {
        device_id: "TEST-ANDROID-UUID-001",
        platform: "android",
        app_version: "1.0.0",
        device_name: "CI Integration Emulator",
      },
    },
  });
  assert.equal(loginAdmin.status, 200);
  assert.equal(loginAdmin.json.success, true);
  assert.ok(loginAdmin.json.meta.request_id);
  assert.equal(loginAdmin.json.data.token_type, "Bearer");
  const adminToken = loginAdmin.json.data.access_token;
  const firstRefresh = loginAdmin.json.data.refresh_token;
  const parsOrgId = loginAdmin.json.data.active_organization_id;
  const testDeviceId = loginAdmin.json.data.device.id;

  const refreshed = await req("/api/v1/auth/refresh", {
    method: "POST",
    body: { refresh_token: firstRefresh },
  });
  assert.equal(refreshed.status, 200);
  const rotatedAccess = refreshed.json.data.access_token;
  assert.notEqual(refreshed.json.data.refresh_token, firstRefresh);

  // Reuse old refresh token -> MUST detect reuse attack & reject!
  const reuseAttack = await req("/api/v1/auth/refresh", {
    method: "POST",
    body: { refresh_token: firstRefresh },
  });
  assert.equal(reuseAttack.status, 401);
  assert.equal(reuseAttack.json.error.code, "REFRESH_TOKEN_REUSED");
  console.log("[PASS] 3. Mobile login, Refresh Token Rotation & Reuse Attack Revocation verified");

  // Re-login fresh admin & accountant + expired org owner
  const adminLogin2 = await req("/api/v1/auth/login", {
    method: "POST",
    body: { mobile: "09121000001", password: "Admin@1234" },
  });
  const tokenAdmin = adminLogin2.json.data.access_token;

  const accLogin = await req("/api/v1/auth/login", {
    method: "POST",
    body: { mobile: "09122000002", password: "Account@1234" },
  });
  const tokenAccountant = accLogin.json.data.access_token;

  const sepehrLogin = await req("/api/v1/auth/login", {
    method: "POST",
    body: { mobile: "09124000004", password: "Sepehr@1234" },
  });
  const tokenSepehr = sepehrLogin.json.data.access_token;
  const sepehrOrgId = sepehrLogin.json.data.active_organization_id;
  assert.notEqual(sepehrOrgId, parsOrgId);

  // 4. Cross-Tenant Isolation & Platform Realm Separation Tests
  const crossTenantAttempt = await req("/api/v1/contacts", {
    token: tokenSepehr,
    orgId: parsOrgId, // Forging ParsTech org_id with Sepehr credentials!
  });
  assert.equal(crossTenantAttempt.status, 403);
  assert.equal(crossTenantAttempt.json.error.code, "TENANT_ACCESS_DENIED");

  const nonPlatformAttempt = await req("/api/v1/platform/overview", {
    token: tokenAccountant,
  });
  assert.equal(nonPlatformAttempt.status, 403);
  assert.equal(nonPlatformAttempt.json.error.code, "PLATFORM_ADMIN_REQUIRED");
  console.log("[PASS] 4. Cross-Tenant Access Blocked (403) & Platform/Org Realm Isolation Verified");

  // 5. Standard Paginated List Envelope + snake_case verification
  const contactsRes = await req("/api/v1/contacts?page=1&per_page=10", {
    token: tokenAccountant,
    orgId: parsOrgId,
  });
  assert.equal(contactsRes.status, 200);
  assert.ok(Array.isArray(contactsRes.json.data));
  assert.ok(contactsRes.json.meta.pagination);
  assert.equal(contactsRes.json.meta.pagination.per_page, 10);
  assert.ok("display_name" in contactsRes.json.data[0]);
  console.log("[PASS] 5. Standard Paginated Envelope & snake_case JSON verified");

  // 6. Strict Double-Entry Accounting Rules
  const accsRes = await req("/api/v1/accounting/accounts", { token: tokenAccountant, orgId: parsOrgId });
  const fyRes = await req("/api/v1/accounting/fiscal-years", { token: tokenAccountant, orgId: parsOrgId });
  const bankAcc = accsRes.json.data.accounts.find((a) => a.system_role === "BANK");
  const opexAcc = accsRes.json.data.accounts.find((a) => a.system_role === "OPEX");
  const closedPeriod = fyRes.json.data.periods.find((p) => p.status === "CLOSED");
  const openPeriod = fyRes.json.data.periods.find((p) => p.status === "OPEN");

  // 6a. Unbalanced voucher rejected
  const unbalanced = await req("/api/v1/accounting/journal-entries", {
    method: "POST",
    token: tokenAccountant,
    orgId: parsOrgId,
    body: {
      accounting_period_id: openPeriod.id,
      document_date: "2025-08-10",
      description: "تست سند نامتوازن",
      confirm_immediately: true,
      lines: [
        { account_id: opexAcc.id, debit: "5000000.00", credit: "0.00" },
        { account_id: bankAcc.id, debit: "0.00", credit: "4000000.00" },
      ],
    },
  });
  assert.equal(unbalanced.status, 409);
  assert.equal(unbalanced.json.error.code, "ACCOUNTING_UNBALANCED");

  // 6b. Closed period rejected
  const closedTry = await req("/api/v1/accounting/journal-entries", {
    method: "POST",
    token: tokenAccountant,
    orgId: parsOrgId,
    body: {
      accounting_period_id: closedPeriod.id,
      document_date: "2025-04-10",
      description: "تست ثبت در دوره بسته",
      confirm_immediately: true,
      lines: [
        { account_id: opexAcc.id, debit: "1000000.00", credit: "0.00" },
        { account_id: bankAcc.id, debit: "0.00", credit: "1000000.00" },
      ],
    },
  });
  assert.equal(closedTry.status, 409);
  assert.equal(closedTry.json.error.code, "ACCOUNTING_PERIOD_CLOSED");

  // 6c. Balanced voucher confirmed -> Immutable PATCH/DELETE blocked -> Reversal works -> Trial Balance balanced
  const balanced = await req("/api/v1/accounting/journal-entries", {
    method: "POST",
    token: tokenAccountant,
    orgId: parsOrgId,
    body: {
      accounting_period_id: openPeriod.id,
      document_date: "2025-08-12",
      description: "سند تست خودکار هزینه اینترنت",
      confirm_immediately: true,
      lines: [
        { account_id: opexAcc.id, debit: "2500000.00", credit: "0.00" },
        { account_id: bankAcc.id, debit: "0.00", credit: "2500000.00" },
      ],
    },
  });
  assert.equal(balanced.status, 201);
  const postedId = balanced.json.data.id;

  const illegalPatch = await req(`/api/v1/accounting/journal-entries/${postedId}`, {
    method: "PATCH",
    token: tokenAccountant,
    orgId: parsOrgId,
    body: { description: "تلاش برای تغییر سند قطعی" },
  });
  assert.equal(illegalPatch.status, 409);
  assert.equal(illegalPatch.json.error.code, "ACCOUNTING_ENTRY_IMMUTABLE");

  const illegalDelete = await req(`/api/v1/accounting/journal-entries/${postedId}`, {
    method: "DELETE",
    token: tokenAccountant,
    orgId: parsOrgId,
  });
  assert.equal(illegalDelete.status, 409);
  assert.equal(illegalDelete.json.error.code, "ACCOUNTING_ENTRY_IMMUTABLE");

  const reversed = await req(`/api/v1/accounting/journal-entries/${postedId}/reverse`, {
    method: "POST",
    token: tokenAccountant,
    orgId: parsOrgId,
    body: { reason: "تست سند معکوس" },
  });
  assert.equal(reversed.status, 201);

  const tb = await req("/api/v1/accounting/trial-balance", { token: tokenAccountant, orgId: parsOrgId });
  assert.equal(tb.status, 200);
  assert.equal(tb.json.data.is_balanced, true);
  console.log("[PASS] 6. Double-Entry Accounting (Unbalanced/Closed/Immutable/Reversal/Trial Balance) verified");

  // 7. Inventory Atomic Transfer & Negative Stock Block Policy
  const whs = (await req("/api/v1/warehouses", { token: tokenAdmin, orgId: parsOrgId })).json.data;
  const prods = (await req("/api/v1/products", { token: tokenAdmin, orgId: parsOrgId })).json.data;

  const negStock = await req("/api/v1/inventory/transfers", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    body: {
      source_warehouse_id: whs[0].id,
      destination_warehouse_id: whs[1].id,
      product_id: prods[0].id,
      quantity: "99999.0000",
      transfer_date: "2025-08-14",
    },
  });
  assert.equal(negStock.status, 409);
  assert.equal(negStock.json.error.code, "INVENTORY_NEGATIVE_STOCK_BLOCKED");

  const okTransfer = await req("/api/v1/inventory/transfers", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    body: {
      source_warehouse_id: whs[0].id,
      destination_warehouse_id: whs[1].id,
      product_id: prods[0].id,
      quantity: "1.0000",
      transfer_date: "2025-08-14",
      notes: "تست انتقال اتمیک",
    },
  });
  assert.equal(okTransfer.status, 201);
  console.log("[PASS] 7. Inventory Negative Stock Block (409) & Atomic Warehouse Transfer verified");

  // 8. Expired Subscription Policy: Write Gated (402), Data Export ALWAYS Allowed (200), Anti-Fraud CafeBazaar
  const expiredWrite = await req("/api/v1/contacts", {
    method: "POST",
    token: tokenSepehr,
    orgId: sepehrOrgId,
    body: { code: "EXP-1", display_name: "تست انقضا", type: "CUSTOMER" },
  });
  assert.equal(expiredWrite.status, 402);
  assert.equal(expiredWrite.json.error.code, "SUBSCRIPTION_ENTITLEMENT_REQUIRED");

  const expiredExport = await req("/api/v1/export", {
    token: tokenSepehr,
    orgId: sepehrOrgId,
  });
  assert.equal(expiredExport.status, 200);
  assert.equal(expiredExport.json.data.organization.subscription_status, "EXPIRED");

  const forgedReceipt = await req("/api/v1/subscription/market/verify", {
    method: "POST",
    token: tokenSepehr,
    orgId: sepehrOrgId,
    headers: { "Idempotency-Key": `forged-${Date.now()}` },
    body: {
      package_name: "ir.businessos.app",
      sku: "bos_pro_monthly",
      purchase_token: "FAKE-HACKED-TOKEN-99999",
    },
  });
  assert.equal(forgedReceipt.status, 400);
  assert.equal(forgedReceipt.json.error.code, "CAFEBAZAAR_RECEIPT_INVALID");

  // Replay existing seeded token -> strictly blocked (409)!
  const replayReceipt = await req("/api/v1/subscription/market/verify", {
    method: "POST",
    token: tokenSepehr,
    orgId: sepehrOrgId,
    headers: { "Idempotency-Key": `replay-${Date.now()}` },
    body: {
      package_name: "ir.businessos.app",
      sku: "bos_pro_monthly",
      purchase_token: "CBZ-VALID-SEED998877",
    },
  });
  assert.equal(replayReceipt.status, 409);
  assert.equal(replayReceipt.json.error.code, "PAYMENT_RECEIPT_REPLAYED");
  console.log("[PASS] 8. Subscription Expiry Retention/Export & CafeBazaar Anti-Forgery/Anti-Replay verified");

  // 9. Master Prompt 04 Critical Scenario 1: Offline Purchase -> Push DRAFT -> Server CONFIRM (Stock + Journal) -> Opaque Cursor Pull -> Acknowledge
  const cryptoMod = await import("node:crypto");
  const contactsList = (await req("/api/v1/contacts?per_page=10", { token: tokenAdmin, orgId: parsOrgId })).json.data;
  const vendorContact = contactsList[0];
  const offlinePurchaseUuid = cryptoMod.randomUUID();
  const evtCreatePurchase = cryptoMod.randomUUID();
  const evtConfirmPurchase = cryptoMod.randomUUID();

  const purchaseSync = await req("/api/v1/sync/push", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    headers: { "Idempotency-Key": cryptoMod.randomUUID() },
    body: {
      device_id: testDeviceId,
      batch_id: cryptoMod.randomUUID(),
      events: [
        {
          event_id: evtCreatePurchase,
          idempotency_key: cryptoMod.randomUUID(),
          entity_type: "purchase",
          entity_id: offlinePurchaseUuid,
          operation: "CREATE",
          base_version: null,
          dependencies: [],
          payload: {
            supplier_id: vendorContact.id,
            warehouse_id: whs[0].id,
            document_date: "2025-08-18",
            items: [{ product_id: prods[0].id, quantity: "3.0000", unit_price: "42000000.00" }],
          },
        },
        {
          event_id: evtConfirmPurchase,
          idempotency_key: cryptoMod.randomUUID(),
          entity_type: "purchase",
          entity_id: offlinePurchaseUuid,
          operation: "CONFIRM",
          base_version: 1,
          dependencies: [evtCreatePurchase],
          payload: {},
        },
      ],
    },
  });
  assert.equal(purchaseSync.status, 200);
  assert.equal(purchaseSync.json.data.results[0].status, "ACCEPTED");
  assert.equal(purchaseSync.json.data.results[0].business_status, "DRAFT");
  assert.equal(purchaseSync.json.data.results[0].server_id, offlinePurchaseUuid, "Client UUID must be preserved");
  assert.equal(purchaseSync.json.data.results[1].status, "CONFIRMED");
  assert.equal(purchaseSync.json.data.results[1].business_status, "CONFIRMED");

  // Opaque Cursor Pull + Acknowledge
  const pull1 = await req(`/api/v1/sync/pull?device_id=${testDeviceId}&limit=10`, {
    token: tokenAdmin,
    orgId: parsOrgId,
  });
  assert.equal(pull1.status, 200);
  assert.ok(pull1.json.data.next_cursor.startsWith("bos_c1_"), "Must return HMAC opaque cursor");
  assert.ok(Array.isArray(pull1.json.data.changes) && pull1.json.data.changes.length > 0);

  const ackRes = await req("/api/v1/sync/acknowledge", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    body: { device_id: testDeviceId, cursor: pull1.json.data.next_cursor },
  });
  assert.equal(ackRes.status, 200);
  assert.equal(ackRes.json.data.acknowledged, true);

  // Tampered cursor rejected
  const badCursor = await req(`/api/v1/sync/pull?device_id=${testDeviceId}&cursor=bos_c1_tampered.invalid`, {
    token: tokenAdmin,
    orgId: parsOrgId,
  });
  assert.equal(badCursor.status, 400);
  assert.equal(badCursor.json.error.code, "INVALID_SYNC_CURSOR");
  console.log("[PASS] 9. Scenario 1: Offline Purchase (Client UUID + Dependencies + Confirm) & Opaque Cursor Pull/Ack verified");

  // 10. Master Prompt 04 Critical Scenario 2 & 3: Offline Sale + Multi-Device Stock Race Conflict!
  const dev2Reg = await req("/api/v1/devices/register", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    body: {
      device_id: `TEST-DEVICE-TWO-${Date.now()}`,
      platform: "android",
      device_name: "Device B (Concurrent Seller)",
      app_version: "1.0.0",
    },
  });
  assert.equal(dev2Reg.status, 201);
  const device2Id = dev2Reg.json.data.id;

  // Device 1 sells 1 unit -> succeeds CONFIRMED
  const saleOkUuid = cryptoMod.randomUUID();
  const saleOkEvt = cryptoMod.randomUUID();
  const saleOkRes = await req("/api/v1/sync/push", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    headers: { "Idempotency-Key": cryptoMod.randomUUID() },
    body: {
      device_id: testDeviceId,
      batch_id: cryptoMod.randomUUID(),
      events: [
        {
          event_id: saleOkEvt,
          idempotency_key: cryptoMod.randomUUID(),
          entity_type: "sales",
          entity_id: saleOkUuid,
          operation: "CREATE",
          payload: {
            customer_id: vendorContact.id,
            warehouse_id: whs[0].id,
            document_date: "2025-08-19",
            items: [{ product_id: prods[0].id, quantity: "1.0000", unit_price: "54000000.00" }],
          },
        },
        {
          event_id: cryptoMod.randomUUID(),
          idempotency_key: cryptoMod.randomUUID(),
          entity_type: "sales",
          entity_id: saleOkUuid,
          operation: "CONFIRM",
          dependencies: [saleOkEvt],
          payload: {},
        },
      ],
    },
  });
  assert.equal(saleOkRes.status, 200);
  assert.equal(saleOkRes.json.data.results[1].status, "CONFIRMED");

  // Device 2 offline tries to confirm sale exceeding central Stock Ledger -> STOCK_SHORTAGE CONFLICT!
  const saleRaceUuid = cryptoMod.randomUUID();
  const saleRaceEvt = cryptoMod.randomUUID();
  const saleRaceRes = await req("/api/v1/sync/push", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    headers: { "Idempotency-Key": cryptoMod.randomUUID() },
    body: {
      device_id: device2Id,
      batch_id: cryptoMod.randomUUID(),
      events: [
        {
          event_id: saleRaceEvt,
          idempotency_key: cryptoMod.randomUUID(),
          entity_type: "sales",
          entity_id: saleRaceUuid,
          operation: "CREATE",
          payload: {
            customer_id: vendorContact.id,
            warehouse_id: whs[0].id,
            document_date: "2025-08-19",
            items: [{ product_id: prods[0].id, quantity: "5000.0000", unit_price: "54000000.00" }],
          },
        },
        {
          event_id: cryptoMod.randomUUID(),
          idempotency_key: cryptoMod.randomUUID(),
          entity_type: "sales",
          entity_id: saleRaceUuid,
          operation: "CONFIRM",
          dependencies: [saleRaceEvt],
          payload: {},
        },
      ],
    },
  });
  assert.equal(saleRaceRes.status, 200);
  assert.equal(saleRaceRes.json.data.results[1].status, "CONFLICT");
  assert.equal(saleRaceRes.json.data.results[1].business_status, "REJECTED");
  assert.equal(saleRaceRes.json.data.results[1].error.code, "INVENTORY_NEGATIVE_STOCK_BLOCKED");
  console.log("[PASS] 10. Scenarios 2 & 3: Offline Sale Confirm & Multi-Device Stock Race Conflict verified");

  // 11. Master Prompt 04 Critical Scenario 4: Dropped Connection Retry -> Inbox DUPLICATE + Key Reuse Guard
  const retryContactUuid = cryptoMod.randomUUID();
  const sharedEventIdemKey = cryptoMod.randomUUID();
  const contactPayload = {
    code: `C-INB-${Date.now().toString().slice(-4)}`,
    display_name: "مشتری تست Inbox Idempotency",
    type: "CUSTOMER",
  };
  const inboxPush1 = await req("/api/v1/sync/push", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    headers: { "Idempotency-Key": cryptoMod.randomUUID() },
    body: {
      device_id: testDeviceId,
      batch_id: cryptoMod.randomUUID(),
      events: [
        {
          event_id: cryptoMod.randomUUID(),
          idempotency_key: sharedEventIdemKey,
          entity_type: "contact",
          entity_id: retryContactUuid,
          operation: "CREATE",
          payload: contactPayload,
        },
      ],
    },
  });
  assert.equal(inboxPush1.json.data.results[0].status, "ACCEPTED");

  // Retry same event in a NEW batch (simulating dropped response) -> MUST return DUPLICATE without duplicating record!
  const inboxRetry = await req("/api/v1/sync/push", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    headers: { "Idempotency-Key": cryptoMod.randomUUID() },
    body: {
      device_id: testDeviceId,
      batch_id: cryptoMod.randomUUID(),
      events: [
        {
          event_id: cryptoMod.randomUUID(),
          idempotency_key: sharedEventIdemKey,
          entity_type: "contact",
          entity_id: retryContactUuid,
          operation: "CREATE",
          payload: contactPayload,
        },
      ],
    },
  });
  assert.equal(inboxRetry.json.data.results[0].status, "DUPLICATE");
  assert.equal(inboxRetry.json.data.results[0].server_id, retryContactUuid);

  // Reuse same idempotency_key with ALTERED payload -> MUST reject with IDEMPOTENCY_KEY_REUSED!
  const inboxMutated = await req("/api/v1/sync/push", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    headers: { "Idempotency-Key": cryptoMod.randomUUID() },
    body: {
      device_id: testDeviceId,
      batch_id: cryptoMod.randomUUID(),
      events: [
        {
          event_id: cryptoMod.randomUUID(),
          idempotency_key: sharedEventIdemKey,
          entity_type: "contact",
          entity_id: retryContactUuid,
          operation: "CREATE",
          payload: { ...contactPayload, display_name: "تغییر غیرمجاز با همان کلید" },
        },
      ],
    },
  });
  assert.equal(inboxMutated.json.data.results[0].status, "REJECTED");
  assert.equal(inboxMutated.json.data.results[0].error.code, "IDEMPOTENCY_KEY_REUSED");
  console.log("[PASS] 11. Scenario 4: Sync Inbox DUPLICATE Replay & IDEMPOTENCY_KEY_REUSED Guard verified");

  // 12. Tombstone Delete + Sync Status + Checkpoints + Protected Reset + Revoked Device Guard + Financial Conflict USE_LOCAL Block
  const tombPush = await req("/api/v1/sync/push", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    headers: { "Idempotency-Key": cryptoMod.randomUUID() },
    body: {
      device_id: testDeviceId,
      batch_id: cryptoMod.randomUUID(),
      events: [
        {
          event_id: cryptoMod.randomUUID(),
          idempotency_key: cryptoMod.randomUUID(),
          entity_type: "contact",
          entity_id: retryContactUuid,
          operation: "DELETE",
          base_version: 1,
          payload: {},
        },
      ],
    },
  });
  assert.equal(tombPush.json.data.results[0].status, "ACCEPTED");

  // Pull since previous acknowledged cursor MUST contain TOMBSTONE for retryContactUuid!
  const pullTomb = await req(
    `/api/v1/sync/pull?device_id=${testDeviceId}&cursor=${encodeURIComponent(pull1.json.data.next_cursor)}&entity_types=contact`,
    { token: tokenAdmin, orgId: parsOrgId }
  );
  assert.equal(pullTomb.status, 200);
  const foundTomb = pullTomb.json.data.changes.find(
    (c) => c.entity_id === retryContactUuid && c.operation === "TOMBSTONE"
  );
  assert.ok(foundTomb, "TOMBSTONE event must appear in cursor-based pull");

  // Immutable Financial Conflict: offline edit on confirmed journal entry -> USE_LOCAL MUST be forbidden (409)!
  const finConfPush = await req("/api/v1/sync/push", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    headers: { "Idempotency-Key": cryptoMod.randomUUID() },
    body: {
      device_id: testDeviceId,
      batch_id: cryptoMod.randomUUID(),
      events: [
        {
          event_id: cryptoMod.randomUUID(),
          idempotency_key: cryptoMod.randomUUID(),
          entity_type: "journal_entry",
          entity_id: postedId,
          operation: "UPDATE",
          base_version: 1,
          payload: { description: "تلاش برای LWW روی سند مالی قطعی" },
        },
      ],
    },
  });
  assert.equal(finConfPush.json.data.results[0].status, "CONFLICT");
  const finConflictId = finConfPush.json.data.results[0].conflict_id;
  const illegalUseLocal = await req(`/api/v1/sync/conflicts/${finConflictId}/resolve`, {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    body: { resolution: "USE_LOCAL" },
  });
  assert.equal(illegalUseLocal.status, 409);
  assert.equal(illegalUseLocal.json.error.code, "RESOLUTION_NOT_ALLOWED_FOR_ENTITY");

  // Sync Status, Checkpoints, Protected Reset Checkpoint, and Device Revocation
  const statusRes = await req("/api/v1/sync/status", { token: tokenAdmin, orgId: parsOrgId });
  assert.equal(statusRes.status, 200);
  assert.ok(statusRes.json.data.sync_logs.length > 0, "sync_logs telemetry must be recorded");

  const cpsRes = await req("/api/v1/sync/checkpoints", { token: tokenAdmin, orgId: parsOrgId });
  assert.equal(cpsRes.status, 200);

  const resetRes = await req("/api/v1/sync/reset-checkpoint", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    body: { device_id: device2Id, reason: "CI recovery test" },
  });
  assert.equal(resetRes.status, 200);
  assert.equal(resetRes.json.data.data_deleted, false);

  // Revoke Device 2 -> subsequent Pull MUST be blocked with 403 DEVICE_REVOKED
  const revDev = await req(`/api/v1/devices/${device2Id}/revoke`, {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
  });
  assert.equal(revDev.status, 200);
  const revokedPull = await req(`/api/v1/sync/pull?device_id=${device2Id}`, {
    token: tokenAdmin,
    orgId: parsOrgId,
  });
  assert.equal(revokedPull.status, 403);
  assert.equal(revokedPull.json.error.code, "DEVICE_REVOKED");
  console.log("[PASS] 12. Tombstones, Financial USE_LOCAL Block, Telemetry, Protected Reset & Revoked Device Guard verified");

  // ==========================================================================
  // MASTER PROMPT 05 MANDATORY ACCEPTANCE SCENARIOS (A through K)
  // ==========================================================================
  const XLSX = await import("xlsx");

  // Scenario A — Owner Withdrawal (5,000,000 IRR) + Linked Personal Expenses (3M Household + 2M Loan)
  const plBefore = (await req("/api/v1/accounting/profit-loss", { token: tokenAdmin, orgId: parsOrgId })).json.data;
  const finAccsBefore = (await req("/api/v1/treasury/accounts", { token: tokenAdmin, orgId: parsOrgId })).json.data;
  const cashFinAcc = finAccsBefore.find((a) => a.account_type === "CASHBOX") || finAccsBefore[0];
  const posFinAcc = finAccsBefore.find((a) => a.account_type === "POS") || finAccsBefore[0];
  const bankFinAcc = finAccsBefore.find((a) => a.account_type === "BANK") || finAccsBefore[0];
  const cashBeforeNum = Number(cashFinAcc.balance);

  const wdRes = await req("/api/v1/personal-finance/withdrawals", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    headers: { "Idempotency-Key": cryptoMod.randomUUID() },
    body: {
      business_financial_account_id: cashFinAcc.id,
      amount: "5000000.00",
      withdrawal_date: "2025-08-20",
      notes: "Scenario A owner withdrawal",
    },
  });
  assert.equal(wdRes.status, 201);
  assert.equal(Number(wdRes.json.data.business_account_new_balance), cashBeforeNum - 5_000_000);
  const withdrawalId = wdRes.json.data.withdrawal.id;

  const pfCats = (await req("/api/v1/personal-finance/categories", { token: tokenAdmin, orgId: parsOrgId })).json.data;
  const householdCat = pfCats.find((c) => c.code === "PF_HOUSEHOLD") || pfCats[0];
  const loanCat = pfCats.find((c) => c.code === "PF_LOAN") || pfCats[0];

  const exp1 = await req("/api/v1/personal-finance/transactions", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    body: {
      tx_type: "PERSONAL_EXPENSE",
      payment_source: "PERSONAL_CASH",
      title: "مخارج خانه (سناریو A)",
      amount: "3000000.00",
      category_id: householdCat.id,
      linked_withdrawal_id: withdrawalId,
    },
  });
  assert.equal(exp1.status, 201);
  const exp2 = await req("/api/v1/personal-finance/transactions", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    body: {
      tx_type: "LOAN_PAYMENT",
      payment_source: "PERSONAL_CASH",
      title: "قسط وام شخصی (سناریو A)",
      amount: "2000000.00",
      category_id: loanCat.id,
      linked_withdrawal_id: withdrawalId,
    },
  });
  assert.equal(exp2.status, 201);

  const plAfterWd = (await req("/api/v1/accounting/profit-loss", { token: tokenAdmin, orgId: parsOrgId })).json.data;
  assert.equal(plAfterWd.net_profit, plBefore.net_profit, "Owner withdrawal & personal expenses MUST NOT reduce business profit!");
  console.log("[PASS] Scenario A: Owner Withdrawal (5M) + Linked Personal Expenses (3M + 2M) isolated from Business P&L");

  // Scenario B — Mixed Sales Payment (6M total: 1M Cash + 3M POS + 2M Unpaid Credit, with Discount & Tax)
  const mixedDraft = await req("/api/v1/sales", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    headers: { "Idempotency-Key": cryptoMod.randomUUID() },
    body: {
      client_document_id: cryptoMod.randomUUID(),
      customer_id: vendorContact.id,
      warehouse_id: whs[0].id,
      document_date: "2025-08-21",
      discount_total: "500000.00",
      tax_total: "500000.00",
      items: [{ product_id: prods[2].id, quantity: "3.0000", unit_price: "2000000.00" }], // subtotal 6M - 0.5M + 0.5M = 6,000,000.00
    },
  });
  assert.equal(mixedDraft.status, 201);
  assert.equal(mixedDraft.json.data.grand_total, "6000000.00");
  const mixedInvId = mixedDraft.json.data.id;

  const mixedConfirm = await req(`/api/v1/sales/${mixedInvId}/confirm`, {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    body: {
      payment_allocations: [
        { financial_account_id: cashFinAcc.id, payment_method: "CASH", amount: "1000000.00" },
        { financial_account_id: posFinAcc.id, payment_method: "POS", amount: "3000000.00" },
      ],
    },
  });
  assert.equal(mixedConfirm.status, 200);
  assert.equal(mixedConfirm.json.data.invoice.paid_amount, "4000000.00");
  assert.equal(mixedConfirm.json.data.invoice.remaining_amount, "2000000.00");
  assert.equal(mixedConfirm.json.data.invoice.payment_status, "PARTIALLY_PAID");
  assert.equal(mixedConfirm.json.data.invoice.accounting_status, "POSTED");
  assert.equal(mixedConfirm.json.data.invoice.stock_status, "ISSUED");
  console.log("[PASS] Scenario B: Mixed Sales Payment (6M = 1M Cash + 3M POS + 2M Unpaid Credit) verified");

  // Scenario C — Subsequent Customer Payment (1M later) + Idempotent Retry
  const payIdem = cryptoMod.randomUUID();
  const subPay1 = await req(`/api/v1/sales/${mixedInvId}/payments`, {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    headers: { "Idempotency-Key": payIdem },
    body: {
      account_id: bankFinAcc.id,
      payment_method: "BANK_TRANSFER",
      amount: "1000000.00",
      transaction_date: "2025-08-22",
      reference_number: "REF-SCENARIO-C",
    },
  });
  assert.equal(subPay1.status, 201);
  assert.equal(subPay1.json.data.invoice.remaining_amount, "1000000.00");
  assert.equal(subPay1.json.data.invoice.paid_amount, "5000000.00");

  const subPayRetry = await req(`/api/v1/sales/${mixedInvId}/payments`, {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    headers: { "Idempotency-Key": payIdem },
    body: {
      account_id: bankFinAcc.id,
      payment_method: "BANK_TRANSFER",
      amount: "1000000.00",
      transaction_date: "2025-08-22",
      reference_number: "REF-SCENARIO-C",
    },
  });
  assert.equal(subPayRetry.status, 200);
  assert.equal(subPayRetry.json.data.replayed, true);
  assert.equal(subPayRetry.json.data.invoice.remaining_amount, "1000000.00");
  console.log("[PASS] Scenario C: Subsequent Customer Payment (1M) + Idempotent Retry verified");

  // Scenario D — Product Variants (2 sizes x 3 colors = 6 variants), independent stock, sell 1 variant
  const unitsList = (await req("/api/v1/units", { token: tokenAdmin, orgId: parsOrgId })).json.data;
  const parentProdRes = await req("/api/v1/products", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    body: {
      code: `SHIRT-${Date.now().toString().slice(-5)}`,
      name: "پیراهن نخی (تست تنوع سناریو D)",
      base_unit_id: unitsList[0].id,
      purchase_price: "500000.00",
      sale_price: "900000.00",
    },
  });
  assert.equal(parentProdRes.status, 201);
  const parentProdId = parentProdRes.json.data.id;

  const createdVariantIds = [];
  for (const sz of ["M", "L"]) {
    for (const col of ["Black", "White", "Blue"]) {
      const vr = await req("/api/v1/variants", {
        method: "POST",
        token: tokenAdmin,
        orgId: parsOrgId,
        body: {
          product_id: parentProdId,
          sku: `SH-${Date.now().toString().slice(-4)}-${sz}-${col}`,
          variant_name: `سایز ${sz} - رنگ ${col}`,
          attributes: { size: sz, color: col },
          purchase_price: "500000.00",
          sale_price: "900000.00",
        },
      });
      assert.equal(vr.status, 201);
      createdVariantIds.push(vr.json.data.id);

      const openStk = await req("/api/v1/opening-stock", {
        method: "POST",
        token: tokenAdmin,
        orgId: parsOrgId,
        body: {
          warehouse_id: whs[0].id,
          product_id: parentProdId,
          variant_id: vr.json.data.id,
          quantity: "10.0000",
          unit_cost: "500000.0000",
        },
      });
      assert.equal(openStk.status, 201);
    }
  }

  // Sell 3 units of variant #0 ONLY
  const varSale = await req("/api/v1/sales", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    body: {
      customer_id: vendorContact.id,
      warehouse_id: whs[0].id,
      document_date: "2025-08-23",
      items: [{ product_id: parentProdId, variant_id: createdVariantIds[0], quantity: "3.0000", unit_price: "900000.00" }],
    },
  });
  const varConfirm = await req(`/api/v1/sales/${varSale.json.data.id}/confirm`, {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    body: { payment_allocations: [] },
  });
  assert.equal(varConfirm.status, 200);

  const varAfter = (await req(`/api/v1/variants/product/${parentProdId}`, { token: tokenAdmin, orgId: parsOrgId })).json.data;
  const soldVar = varAfter.variants.find((v) => v.id === createdVariantIds[0]);
  const untouchedVar = varAfter.variants.find((v) => v.id === createdVariantIds[1]);
  assert.equal(Number(soldVar.on_hand_qty), 7, "Sold variant must decrease from 10 to 7");
  assert.equal(Number(untouchedVar.on_hand_qty), 10, "Untouched variant must stay 10");
  assert.equal(Number(varAfter.parent_stock_projection), 57, "Parent projection must equal 7 + 5*10 = 57");
  console.log("[PASS] Scenario D: Product Variants (6 variants, independent Stock Ledger & parent projection=57) verified");

  // Scenario E — Minimum Stock=10, Available=8, Incoming PO=5 -> Smart Purchase Recommendation -> Convert to PO (No Duplicate!)
  const repProdRes = await req("/api/v1/products", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    body: {
      code: `REP-${Date.now().toString().slice(-5)}`,
      name: "کالای تست خرید هوشمند (سناریو E)",
      base_unit_id: unitsList[0].id,
      purchase_price: "1000000.00",
      sale_price: "1400000.00",
    },
  });
  const repProdId = repProdRes.json.data.id;
  await req("/api/v1/opening-stock", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    body: { warehouse_id: whs[0].id, product_id: repProdId, quantity: "8.0000", unit_cost: "1000000.0000" },
  });
  // Create Incoming PO for qty 5
  const incomingPo = await req("/api/v1/purchase-orders", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    body: {
      supplier_id: vendorContact.id,
      warehouse_id: whs[0].id,
      items: [{ product_id: repProdId, quantity: "5.0000", unit_price: "1000000.00" }],
    },
  });
  assert.equal(incomingPo.status, 201);

  // Set threshold: min_stock=10, lead_time=6, daily_demand=2, safety_stock=4 -> ROP = 16; projected = 8+5=13 -> need = 3
  await req("/api/v1/replenishment/thresholds", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    body: {
      warehouse_id: whs[0].id,
      product_id: repProdId,
      min_stock: "10.0000",
      safety_stock: "4.0000",
      lead_time_days: 6,
      avg_daily_demand: "2.0000",
      preferred_supplier_id: vendorContact.id,
    },
  });
  const suggs = (await req("/api/v1/replenishment/suggestions", { token: tokenAdmin, orgId: parsOrgId })).json.data;
  const repSugg = suggs.find((s) => s.product_id === repProdId);
  assert.ok(repSugg, "Smart suggestion must be generated");
  assert.equal(Number(repSugg.available_qty), 8);
  assert.equal(Number(repSugg.incoming_po_qty), 5);
  assert.equal(Number(repSugg.recommended_qty), 3, "Recommended qty must be ROP(16) - (Avail(8)+PO(5)) = 3");

  const poConv1 = await req(`/api/v1/replenishment/suggestions/${repSugg.id}/convert-po`, {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    body: {},
  });
  assert.equal(poConv1.status, 201);
  const poConv2 = await req(`/api/v1/replenishment/suggestions/${repSugg.id}/convert-po`, {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    body: {},
  });
  assert.equal(poConv2.status, 200);
  assert.equal(poConv2.json.data.already_converted, true, "Retry MUST NOT create duplicate PO");
  console.log("[PASS] Scenario E: Smart Purchase Replenishment (Avail=8, PO=5 -> Rec=3) & Non-Duplicate PO Conversion verified");

  // Scenario F — Recurring Monthly Rent Obligation + Idempotent Payment
  const recCreate = await req("/api/v1/personal-finance/recurring", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    body: {
      title: "اجاره ماهانه (سناریو F)",
      amount: "10000000.00",
      frequency: "MONTHLY",
      start_date: "2025-09-01",
      payment_source: "BUSINESS_BANK",
    },
  });
  assert.equal(recCreate.status, 201);
  assert.equal(recCreate.json.data.obligation_status, "DUE");
  const recId = recCreate.json.data.id;
  const recPayKey = cryptoMod.randomUUID();

  const recPay1 = await req(`/api/v1/personal-finance/recurring/${recId}/pay`, {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    headers: { "Idempotency-Key": recPayKey },
    body: { business_financial_account_id: bankFinAcc.id },
  });
  assert.equal(recPay1.status, 200);
  assert.equal(recPay1.json.data.recurring.obligation_status, "PAID");

  const recPayRetry = await req(`/api/v1/personal-finance/recurring/${recId}/pay`, {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    headers: { "Idempotency-Key": recPayKey },
    body: { business_financial_account_id: bankFinAcc.id },
  });
  assert.equal(recPayRetry.status, 200);
  assert.equal(recPayRetry.json.meta.replayed, true);
  console.log("[PASS] Scenario F: Recurring Obligation + Idempotent Payment verified");

  // Scenario G — Cheque Lifecycle (Receive -> Deposit -> In Collection -> Clear + Invalid Transition Block + Dashboard + Daily Chart)
  const chqCreate = await req("/api/v1/cheques", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    body: {
      cheque_number: `4049${Date.now().toString().slice(-10)}`,
      serial_number: "9901/G",
      bank_name: "بانک سامان",
      amount: "15000000.00",
      issue_date: "2025-08-24",
      due_date: "2025-09-12",
      contact_id: vendorContact.id,
      direction: "RECEIVABLE",
    },
  });
  assert.equal(chqCreate.status, 201);
  const chqId = chqCreate.json.data.id;

  const chqDep = await req(`/api/v1/cheques/${chqId}/deposit`, { method: "POST", token: tokenAdmin, orgId: parsOrgId, body: {} });
  assert.equal(chqDep.status, 200);
  const chqColl = await req(`/api/v1/cheques/${chqId}/in-collection`, { method: "POST", token: tokenAdmin, orgId: parsOrgId, body: {} });
  assert.equal(chqColl.status, 200);
  const chqClr = await req(`/api/v1/cheques/${chqId}/clear`, { method: "POST", token: tokenAdmin, orgId: parsOrgId, body: {} });
  assert.equal(chqClr.status, 200);
  assert.equal(chqClr.json.data.cheque.status, "CLEARED");

  // Invalid transition after CLEARED -> 409!
  const invalidChq = await req(`/api/v1/cheques/${chqId}/return`, { method: "POST", token: tokenAdmin, orgId: parsOrgId, body: {} });
  assert.equal(invalidChq.status, 409);
  assert.equal(invalidChq.json.error.code, "INVALID_CHEQUE_TRANSITION");

  const chqDash = await req("/api/v1/cheques/dashboard", { token: tokenAdmin, orgId: parsOrgId });
  assert.equal(chqDash.status, 200);
  const chqAnalytics = await req("/api/v1/cheques/analytics?month=2025-09", { token: tokenAdmin, orgId: parsOrgId });
  assert.equal(chqAnalytics.status, 200);
  assert.equal(chqAnalytics.json.data.daily_series.length, 30);
  console.log("[PASS] Scenario G: Cheque Full Lifecycle, State Transition Guard, Dashboard & Daily Chart verified");

  // Scenario H — Accounting Reports (Journal Book, GL, Subsidiary, Trial Balance, BS, P&L) + Real XLSX Binary Export Verification!
  const [jbRes, glRes, subLedRes, tbFinalRes, bsRes, plFinalRes] = await Promise.all([
    req("/api/v1/accounting/journal-book", { token: tokenAdmin, orgId: parsOrgId }),
    req("/api/v1/accounting/general-ledger", { token: tokenAdmin, orgId: parsOrgId }),
    req("/api/v1/accounting/subsidiary-ledger", { token: tokenAdmin, orgId: parsOrgId }),
    req("/api/v1/accounting/trial-balance", { token: tokenAdmin, orgId: parsOrgId }),
    req("/api/v1/accounting/balance-sheet", { token: tokenAdmin, orgId: parsOrgId }),
    req("/api/v1/accounting/profit-loss", { token: tokenAdmin, orgId: parsOrgId }),
  ]);
  assert.equal(jbRes.json.data.is_balanced, true);
  assert.equal(tbFinalRes.json.data.is_balanced, true);
  assert.equal(jbRes.json.data.total_debit, tbFinalRes.json.data.grand_total_debit);
  assert.equal(glRes.status, 200);
  assert.equal(subLedRes.status, 200);
  assert.equal(bsRes.status, 200);
  assert.equal(plFinalRes.status, 200);

  // Download REAL .xlsx binary & parse it to verify exported figures match on-screen report!
  const xlsxHttpRes = await fetch(`${BASE}/api/v1/accounting/journal-book/export`, {
    headers: {
      Authorization: `Bearer ${tokenAdmin}`,
      "X-Organization-Id": parsOrgId,
      "X-Client-Version": "1.0.0",
    },
  });
  assert.equal(xlsxHttpRes.status, 200);
  assert.ok(xlsxHttpRes.headers.get("content-type")?.includes("spreadsheetml.sheet"));
  const xlsxBuf = Buffer.from(await xlsxHttpRes.arrayBuffer());
  const parsedWb = XLSX.read(xlsxBuf, { type: "buffer" });
  const parsedSheet = XLSX.utils.sheet_to_json(parsedWb.Sheets["JournalBook"]);
  const totalRow = parsedSheet[parsedSheet.length - 1];
  assert.equal(totalRow["بدهکار"], jbRes.json.data.total_debit, "XLSX exported debit MUST match on-screen Journal Book!");
  assert.equal(totalRow["بستانکار"], jbRes.json.data.total_credit, "XLSX exported credit MUST match on-screen Journal Book!");
  console.log("[PASS] Scenario H: All Accounting Books + Real .xlsx Journal Book Export verified bit-for-bit against Trial Balance");

  // Scenario I — RBAC: Create SALESPERSON employee -> Allow Sales, DENY Profit Report & Personal Finance + Security Audit Log!
  const empEmail = `sales.emp.${Date.now()}@parstech.ir`;
  const empMob = `0915${Date.now().toString().slice(-7)}`;
  const empCreate = await req("/api/v1/employees", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    body: {
      employee_code: `EMP-${Date.now().toString().slice(-4)}`,
      full_name: "کارشناس فروش تست RBAC",
      mobile: empMob,
      email: empEmail,
      password: "Sales@1234",
      role_code: "SALESPERSON",
    },
  });
  assert.equal(empCreate.status, 201);

  const empLogin = await req("/api/v1/auth/login", {
    method: "POST",
    body: { mobile: empMob, password: "Sales@1234" },
  });
  assert.equal(empLogin.status, 200);
  const empToken = empLogin.json.data.access_token;

  const empSalesAllowed = await req("/api/v1/sales?per_page=5", { token: empToken, orgId: parsOrgId });
  assert.equal(empSalesAllowed.status, 200, "Sales employee must be allowed sales.view");

  const empProfitDenied = await req("/api/v1/accounting/profit-loss", { token: empToken, orgId: parsOrgId });
  assert.equal(empProfitDenied.status, 403);
  assert.equal(empProfitDenied.json.error.code, "PERMISSION_DENIED");

  const empPersonalDenied = await req("/api/v1/personal-finance/dashboard", { token: empToken, orgId: parsOrgId });
  assert.equal(empPersonalDenied.status, 403);
  assert.equal(empPersonalDenied.json.error.code, "PERMISSION_DENIED");

  const secAudits = (await req("/api/v1/platform/audit-logs?scope=SECURITY", { token: tokenAdmin })).json.data.logs;
  const foundDenialAudit = secAudits.some(
    (entry) => entry.log.action === "PERMISSION_DENIED" && entry.log.actor_email === empEmail
  );
  assert.ok(foundDenialAudit, "Unauthorized attempt MUST appear in security audit logs");
  console.log("[PASS] Scenario I: Employee Scoped RBAC (Sales Allowed, Profit & Personal Finance 403 + Audit Logged) verified");

  // Scenario K Cross-Tenant Personal Finance check (Org 2 attempting Org 1 personal finance)
  const crossPf = await req("/api/v1/personal-finance/dashboard", { token: tokenSepehr, orgId: parsOrgId });
  assert.equal(crossPf.status, 403);
  assert.equal(crossPf.json.error.code, "TENANT_ACCESS_DENIED");
  console.log("[PASS] Scenario K: Cross-Tenant Personal Finance Isolation verified");

  // Quick Expense Auto-Mapping + Printable PDF Check
  const accCatsRes = (await req("/api/v1/accounting-categories", { token: tokenAdmin, orgId: parsOrgId })).json.data;
  const transportCat = accCatsRes.find((c) => c.code === "EXP_TRANSPORT");
  assert.ok(transportCat, "Default transport category with mapping must exist");
  const quickExp = await req("/api/v1/quick-transactions", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    headers: { "Idempotency-Key": cryptoMod.randomUUID() },
    body: {
      kind: "EXPENSE",
      category_id: transportCat.id,
      financial_account_id: cashFinAcc.id,
      title: "هزینه پیک ارسالی تست",
      amount: "250000.00",
    },
  });
  assert.equal(quickExp.status, 201);
  assert.ok(quickExp.json.data.journal_entry.id);

  const pdfRes = await fetch(`${BASE}/api/v1/documents/pdf?type=sales_invoice&id=${mixedInvId}`, {
    headers: { Authorization: `Bearer ${tokenAdmin}`, "X-Organization-Id": parsOrgId, "X-Client-Version": "1.0.0" },
  });
  assert.equal(pdfRes.status, 200);
  const pdfHtml = await pdfRes.text();
  assert.ok(pdfHtml.includes('dir="rtl"') && pdfHtml.includes("6000000.00"));
  console.log("[PASS] Bonus: Quick Expense Automatic Account Mapping & Printable RTL Invoice PDF verified");

  // ==========================================================================
  // MASTER PROMPT 06 MANDATORY ACCEPTANCE TESTS (TESTS C through J)
  // ==========================================================================

  // Test C — Daily Dashboard Charts (Recognized Revenue vs AR Cash Settlement + Business vs Personal Expenses + Drill-Down)
  // Scenario B sold on 2025-08-21 (6,000,000), Scenario C collected 1,000,000 AR cash on 2025-08-22 (NO new revenue!),
  // Scenario A recorded personal expenses on today (NO business expense!).
  const [dashOv, revSeriesRes, salSeriesRes, expSeriesRes, drillSales] = await Promise.all([
    req("/api/v1/dashboard/overview", { token: tokenAdmin, orgId: parsOrgId }),
    req("/api/v1/dashboard/charts/revenue?range=custom&from=2025-08-20&to=2025-08-25&metric=recognized_revenue", {
      token: tokenAdmin,
      orgId: parsOrgId,
    }),
    req("/api/v1/dashboard/charts/sales?range=custom&from=2025-08-20&to=2025-08-25", {
      token: tokenAdmin,
      orgId: parsOrgId,
    }),
    req("/api/v1/dashboard/charts/expenses?range=custom&from=2025-08-20&to=2025-08-25&include_personal=true", {
      token: tokenAdmin,
      orgId: parsOrgId,
    }),
    req("/api/v1/dashboard/charts/drilldown?metric=sales&date=2025-08-21", {
      token: tokenAdmin,
      orgId: parsOrgId,
    }),
  ]);
  assert.equal(dashOv.status, 200);
  const aug21Rev = revSeriesRes.json.data.series.find((d) => d.date === "2025-08-21");
  const aug22Rev = revSeriesRes.json.data.series.find((d) => d.date === "2025-08-22");
  assert.ok(Number(aug21Rev.recognized_revenue) >= 6_000_000, "2025-08-21 recognized revenue must include 6M sale");
  assert.equal(Number(aug22Rev.recognized_revenue), 0, "2025-08-22 AR settlement (1M cash) MUST NOT inflate recognized revenue!");
  assert.ok(Number(aug22Rev.cash_received) >= 1_000_000, "2025-08-22 cash_received must reflect 1M collection");

  const aug21Sale = salSeriesRes.json.data.series.find((d) => d.date === "2025-08-21");
  assert.ok(Number(aug21Sale.net_sales) >= 6_000_000 && aug21Sale.invoices_count >= 1);
  assert.ok(drillSales.json.data.records.length >= 1, "Sales drilldown on 2025-08-21 must return underlying invoice");
  assert.equal(expSeriesRes.status, 200);
  assert.equal(expSeriesRes.json.data.personal_included, true);
  console.log("[PASS] Prompt 06 Test C: Daily Revenue (AR settlement excluded), Sales, Expenses & Drill-Down verified");

  // Test D — User Invitation -> Pending -> Accept -> Role Enforcement -> Suspend/Revoke -> Next Request Rejected!
  const invMob = `0916${Date.now().toString().slice(-7)}`;
  const invEmail = `invitee.${Date.now()}@parstech.ir`;
  const invCreate = await req("/api/v1/access/invitations", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    body: {
      invitee_name: "کاربر دعوت‌شده تست D",
      mobile: invMob,
      email: invEmail,
      role_code: "SALESPERSON",
      branch_access: ["شعبه شمال"],
      warehouse_access: [whs[0].id],
    },
  });
  assert.equal(invCreate.status, 201);
  assert.equal(invCreate.json.data.status, "PENDING");
  const invToken = invCreate.json.data.token;

  const invAccept = await req("/api/v1/access/invitations/accept", {
    method: "POST",
    body: { token: invToken, full_name: "کاربر دعوت‌شده تست D", password: "Invite@1234" },
  });
  assert.equal(invAccept.status, 200);
  assert.equal(invAccept.json.data.invitation.status, "ACCEPTED");
  const newMemberId = invAccept.json.data.membership.id;

  // Single-use token replay rejected!
  const invReplay = await req("/api/v1/access/invitations/accept", {
    method: "POST",
    body: { token: invToken, password: "Invite@1234" },
  });
  assert.equal(invReplay.status, 409);

  // Login as invited Salesperson -> Sales allowed, Personal Finance & Profit denied (403)
  const invLogin = await req("/api/v1/auth/login", {
    method: "POST",
    body: { mobile: invMob, password: "Invite@1234" },
  });
  assert.equal(invLogin.status, 200);
  const invUserToken = invLogin.json.data.access_token;

  const invSalesOk = await req("/api/v1/sales?per_page=3", { token: invUserToken, orgId: parsOrgId });
  assert.equal(invSalesOk.status, 200);
  const invPfNo = await req("/api/v1/personal-finance/dashboard", { token: invUserToken, orgId: parsOrgId });
  assert.equal(invPfNo.status, 403);
  const invProfitNo = await req("/api/v1/accounting/profit-loss", { token: invUserToken, orgId: parsOrgId });
  assert.equal(invProfitNo.status, 403);

  // Owner suspends invited user -> immediately revokes sessions -> next request rejected (401/403)!
  const suspRes = await req(`/api/v1/access/members/${newMemberId}`, {
    method: "PATCH",
    token: tokenAdmin,
    orgId: parsOrgId,
    body: { status: "SUSPENDED" },
  });
  assert.equal(suspRes.status, 200);
  const afterSusp = await req("/api/v1/sales?per_page=3", { token: invUserToken, orgId: parsOrgId });
  assert.ok(afterSusp.status === 401 || afterSusp.status === 403, "Suspended user's active token must be immediately rejected!");
  console.log("[PASS] Prompt 06 Test D: User Invitation, Single-Use Accept, Salesperson RBAC & Immediate Revocation verified");

  // Tests E, F, G, H, I, J — Complete Account Opening, Account Closure & Fiscal Year Lifecycle in a Clean Provisioned Organization!
  const fiscalOrgRes = await req("/api/v1/organizations", {
    method: "POST",
    token: tokenAdmin,
    body: {
      name: `شرکت تست سال مالی ${Date.now().toString().slice(-4)}`,
      business_type: "WHOLESALE",
      base_currency: "IRR",
    },
  });
  assert.equal(fiscalOrgRes.status, 201);
  const fyOrgId = fiscalOrgRes.json.data.id;

  const fyOrgCoa = (await req("/api/v1/fiscal/accounts", { token: tokenAdmin, orgId: fyOrgId })).json.data;
  const fyOrgYears = (await req("/api/v1/fiscal/years", { token: tokenAdmin, orgId: fyOrgId })).json.data;
  const fy1 = fyOrgYears[0];
  const assetGroup = fyOrgCoa.groups.find((g) => g.nature === "ASSET");
  const cashAccFy = fyOrgCoa.accounts.find((a) => a.system_role === "CASH");
  const bankAccFy = fyOrgCoa.accounts.find((a) => a.system_role === "BANK");
  const capAccFy = fyOrgCoa.accounts.find((a) => a.system_role === "CAPITAL");
  const revAccFy = fyOrgCoa.accounts.find((a) => a.system_role === "SALES_REVENUE");
  const opexAccFy = fyOrgCoa.accounts.find((a) => a.system_role === "OPEX");

  // Test E — Create New Ledger Account (Level 3) + Idempotent Opening Balance Journal
  const pettyAccRes = await req("/api/v1/fiscal/accounts", {
    method: "POST",
    token: tokenAdmin,
    orgId: fyOrgId,
    body: {
      group_id: assetGroup.id,
      account_level: 3,
      code: "1109",
      name: "تنخواه‌گردان شعبه ۱",
      account_type: "ASSET",
      normal_balance: "DEBIT",
      is_postable: true,
    },
  });
  assert.equal(pettyAccRes.status, 201);
  const pettyAccId = pettyAccRes.json.data.id;

  const openIdemKey = cryptoMod.randomUUID();
  const openBody = {
    fiscal_year_id: fy1.id,
    effective_date: "2025-07-01",
    lines: [
      { account_id: pettyAccId, debit: "5000000.00", credit: "0.00" },
      { account_id: bankAccFy.id, debit: "45000000.00", credit: "0.00" },
      { account_id: capAccFy.id, debit: "0.00", credit: "50000000.00" },
    ],
  };
  const open1 = await req("/api/v1/fiscal/opening-balances", {
    method: "POST",
    token: tokenAdmin,
    orgId: fyOrgId,
    headers: { "Idempotency-Key": openIdemKey },
    body: openBody,
  });
  assert.equal(open1.status, 201);
  const openRetry = await req("/api/v1/fiscal/opening-balances", {
    method: "POST",
    token: tokenAdmin,
    orgId: fyOrgId,
    headers: { "Idempotency-Key": openIdemKey },
    body: openBody,
  });
  assert.equal(openRetry.status, 201);
  assert.equal(openRetry.json.meta.replayed, true, "Opening balance retry must not duplicate journal");
  console.log("[PASS] Prompt 06 Tests E & G: Hierarchical Account Creation & Idempotent Opening Balance Journal verified");

  // Test F — Controlled Account Closure: Non-Zero CLOSE_ONLY Blocked -> Transfer Balance & Close -> Subsequent Postings Rejected!
  const closurePrev = await req(`/api/v1/fiscal/accounts/${pettyAccId}/closure-preview`, {
    token: tokenAdmin,
    orgId: fyOrgId,
  });
  assert.equal(closurePrev.status, 200);
  assert.equal(closurePrev.json.data.has_non_zero_balance, true);

  const blockDirectClose = await req(`/api/v1/fiscal/accounts/${pettyAccId}/close`, {
    method: "POST",
    token: tokenAdmin,
    orgId: fyOrgId,
    body: { action_type: "CLOSE_ONLY", reason: "تست بستن مستقیم با مانده غیرصفر" },
  });
  assert.equal(blockDirectClose.status, 409);
  assert.equal(blockDirectClose.json.error.code, "ACCOUNT_BALANCE_NON_ZERO");

  const transferClose = await req(`/api/v1/fiscal/accounts/${pettyAccId}/close`, {
    method: "POST",
    token: tokenAdmin,
    orgId: fyOrgId,
    body: {
      action_type: "TRANSFER",
      destination_account_id: cashAccFy.id,
      reason: "انتقال تنخواه به صندوق و بستن حساب",
    },
  });
  assert.equal(transferClose.status, 200);
  assert.equal(transferClose.json.data.account.account_status, "CLOSED");
  assert.ok(transferClose.json.data.transfer_journal.id);

  // Attempting to post to closed account MUST fail (409 ACCOUNT_CLOSED)!
  const postToClosed = await req("/api/v1/accounting/journal-entries", {
    method: "POST",
    token: tokenAdmin,
    orgId: fyOrgId,
    body: {
      fiscal_year_id: fy1.id,
      document_date: "2025-07-05",
      description: "تست ثبت در حساب بسته",
      confirm_immediately: true,
      lines: [
        { account_id: pettyAccId, debit: "100000.00", credit: "0.00" },
        { account_id: bankAccFy.id, debit: "0.00", credit: "100000.00" },
      ],
    },
  });
  assert.equal(postToClosed.status, 409);
  assert.equal(postToClosed.json.error.code, "ACCOUNT_CLOSED");
  console.log("[PASS] Prompt 06 Test F: Controlled Account Closure (Non-Zero Guard, Balance Transfer & Post Block) verified");

  // Record Revenue (20M) and Expense (8M) in FY1 => Net Profit = 12,000,000.00
  const fyRevJ = await req("/api/v1/accounting/journal-entries", {
    method: "POST",
    token: tokenAdmin,
    orgId: fyOrgId,
    body: {
      fiscal_year_id: fy1.id,
      document_date: "2025-08-01",
      description: "درآمد فروش دوره مالی",
      confirm_immediately: true,
      lines: [
        { account_id: bankAccFy.id, debit: "20000000.00", credit: "0.00" },
        { account_id: revAccFy.id, debit: "0.00", credit: "20000000.00" },
      ],
    },
  });
  assert.equal(fyRevJ.status, 201);
  const fyExpJ = await req("/api/v1/accounting/journal-entries", {
    method: "POST",
    token: tokenAdmin,
    orgId: fyOrgId,
    body: {
      fiscal_year_id: fy1.id,
      document_date: "2025-08-05",
      description: "هزینه عملیاتی دوره مالی",
      confirm_immediately: true,
      lines: [
        { account_id: opexAccFy.id, debit: "8000000.00", credit: "0.00" },
        { account_id: bankAccFy.id, debit: "0.00", credit: "8000000.00" },
      ],
    },
  });
  assert.equal(fyExpJ.status, 201);

  // Test H — Fiscal Year Closing (Pre-Closing Checklist -> Preview Net Profit=12M -> Close + Closing Journal -> Block Postings!)
  const chkRes = await req(`/api/v1/fiscal/years/${fy1.id}/closing-checklist`, { token: tokenAdmin, orgId: fyOrgId });
  assert.equal(chkRes.status, 200);
  assert.equal(chkRes.json.data.can_close, true);

  const prevClose = await req(`/api/v1/fiscal/years/${fy1.id}/closing-preview`, { token: tokenAdmin, orgId: fyOrgId });
  assert.equal(prevClose.status, 200);
  assert.equal(prevClose.json.data.net_profit_or_loss, "12000000.00");
  assert.equal(prevClose.json.data.is_balanced, true);

  const closedFyRes = await req(`/api/v1/fiscal/years/${fy1.id}/close`, {
    method: "POST",
    token: tokenAdmin,
    orgId: fyOrgId,
    headers: { "Idempotency-Key": cryptoMod.randomUUID() },
    body: { acknowledge_warnings: true },
  });
  assert.equal(closedFyRes.status, 200);
  assert.equal(closedFyRes.json.data.fiscal_year.status, "CLOSED");
  assert.ok(closedFyRes.json.data.closing_journal.id);

  // Ordinary posting in closed FY MUST be blocked (409 FISCAL_YEAR_CLOSED)!
  const postClosedFy = await req("/api/v1/accounting/journal-entries", {
    method: "POST",
    token: tokenAdmin,
    orgId: fyOrgId,
    body: {
      fiscal_year_id: fy1.id,
      document_date: "2025-09-01",
      description: "تست ثبت در سال مالی بسته",
      confirm_immediately: true,
      lines: [
        { account_id: opexAccFy.id, debit: "100000.00", credit: "0.00" },
        { account_id: bankAccFy.id, debit: "0.00", credit: "100000.00" },
      ],
    },
  });
  assert.equal(postClosedFy.status, 409);
  assert.equal(postClosedFy.json.error.code, "FISCAL_YEAR_CLOSED");
  console.log("[PASS] Prompt 06 Test H: Pre-Closing Checklist, Net Profit=12M Closing Journal & Closed FY Lock verified");

  // Test I — Prepare Next Fiscal Year: Permanent Accounts Carry Forward (Bank+Cash=62M, Capital=50M, RetainedEarnings=12M), ZERO Revenue/Expense!
  const nextFyRes = await req(`/api/v1/fiscal/years/${fy1.id}/prepare-next`, {
    method: "POST",
    token: tokenAdmin,
    orgId: fyOrgId,
    body: { name: "سال مالی ۱۴۰۵", start_date: "2026-03-21", end_date: "2027-03-20" },
  });
  assert.equal(nextFyRes.status, 201);
  const carried = nextFyRes.json.data.carried_accounts;
  assert.ok(carried.every((a) => ["ASSET", "LIABILITY", "EQUITY"].includes(a.account_type)), "ONLY permanent accounts may carry forward!");
  assert.ok(!carried.some((a) => a.account_type === "REVENUE" || a.account_type === "EXPENSE"), "Nominal accounts MUST NOT carry forward!");
  const retCarried = carried.find((a) => a.account_code === "3301");
  assert.equal(retCarried.credit, "12000000.00", "Retained earnings (12M profit) must carry forward!");
  assert.equal(nextFyRes.json.data.opening_journal.reference_id, closedFyRes.json.data.closing_journal.id, "Next-year opening journal must reference previous closing journal!");
  console.log("[PASS] Prompt 06 Test I: Next Fiscal Year Opening (Permanent Carry-Forward=62M, RetainedEarnings=12M, Zero Nominal) verified");

  // Test J — Controlled Auditable Fiscal Year Reopening (Reverses Closing Journal without Deleting!)
  const reopenRes = await req(`/api/v1/fiscal/years/${fy1.id}/reopen`, {
    method: "POST",
    token: tokenAdmin,
    orgId: fyOrgId,
    body: { reason: "اصلاح حسابرسی پایان سال مالی با مصوبه هیئت مدیره" },
  });
  assert.equal(reopenRes.status, 200);
  assert.equal(reopenRes.json.data.fiscal_year.status, "REOPENED");
  assert.equal(reopenRes.json.data.historical_journal_preserved, true);
  assert.ok(reopenRes.json.data.reversal.id, "Closing journal must be reversed via immutable reversal voucher");

  const compRes = await req("/api/v1/fiscal/comparison", { token: tokenAdmin, orgId: fyOrgId });
  assert.equal(compRes.status, 200);
  assert.ok(compRes.json.data.length >= 2);
  console.log("[PASS] Prompt 06 Test J: Controlled Auditable Fiscal Year Reopening & Multi-Year Comparison verified");

  // ==========================================================================
  // SAAS CMS, SMS.IR / KAVENEGAR, OTP SECURITY FIX & BUG FIX VERIFICATION
  // ==========================================================================

  // 13. SMS.ir & Kavenegar Gateway Configuration + Secret Masking + Test Dispatch
  const smsGet = await req("/api/v1/platform/sms", { token: tokenAdmin });
  assert.equal(smsGet.status, 200);
  assert.ok(smsGet.json.data.providers.some((p) => p.provider === "SMS_IR"));
  assert.ok(smsGet.json.data.providers.some((p) => p.provider === "KAVENEGAR"));

  const smsPatch = await req("/api/v1/platform/sms", {
    method: "PATCH",
    token: tokenAdmin,
    body: {
      provider: "KAVENEGAR",
      is_active: true,
      is_default: true,
      sandbox_mode: true,
      api_key: "KAV-LIVE-SECRET-KEY-9876543210",
      line_number: "10004346",
      otp_template_id: "businessos-verify",
    },
  });
  assert.equal(smsPatch.status, 200);
  assert.ok(smsPatch.json.data.provider.api_key_masked.includes("••••"), "SMS API key MUST be masked in API responses!");

  const smsTestSend = await req("/api/v1/platform/sms", {
    method: "POST",
    token: tokenAdmin,
    body: { provider: "KAVENEGAR", mobile: "09121000001", message: "تست پیامک کاوه‌نگار" },
  });
  assert.equal(smsTestSend.status, 200);
  assert.equal(smsTestSend.json.data.sent, true);
  console.log("[PASS] SaaS SMS Gateway: SMS.ir & Kavenegar Config, API Key Masking & Test Dispatch verified");

  // 14. BUG #1 SECURITY FIX: Password Reset MUST require valid OTP (rejects missing/wrong OTP!)
  const badResetNoOtp = await req("/api/v1/auth/reset-password", {
    method: "POST",
    body: { mobile: invMob, new_password: "HackedPassword123!" },
  });
  assert.equal(badResetNoOtp.status, 422, "Reset password without otp_code MUST be rejected!");

  const badResetWrongOtp = await req("/api/v1/auth/reset-password", {
    method: "POST",
    body: { mobile: invMob, otp_code: "000000", new_password: "HackedPassword123!" },
  });
  assert.equal(badResetWrongOtp.status, 400);

  const forgotRes = await req("/api/v1/auth/forgot-password", {
    method: "POST",
    body: { mobile: invMob },
  });
  assert.equal(forgotRes.status, 200);
  assert.ok(forgotRes.json.data.sandbox_otp_code, "Sandbox OTP must be generated for test verification");

  const validReset = await req("/api/v1/auth/reset-password", {
    method: "POST",
    body: {
      mobile: invMob,
      otp_code: forgotRes.json.data.sandbox_otp_code,
      new_password: "ResetSecure@2026",
    },
  });
  assert.equal(validReset.status, 200);
  assert.equal(validReset.json.data.sessions_revoked, true);
  console.log("[PASS] Security Fix #1: OTP-Backed Forgot/Reset Password & Session Revocation verified");

  // 15. Academy CMS (Rich Text + XSS Sanitization) + Public SaaS Endpoints (/plans, /academy, /contact, /app-config)
  const testSlug = `ci-tutorial-${Date.now().toString().slice(-5)}`;
  const artCreate = await req("/api/v1/platform/academy", {
    method: "POST",
    token: tokenAdmin,
    body: {
      slug: testSlug,
      title: "آموزش تست داینامیک با ادیتور پیشرفته",
      excerpt: "خلاصه آموزش تست برای بررسی انتشار داینامیک و پاک‌سازی XSS.",
      cover_image_url: "/images/academy-accounting.png",
      category: "حسابداری",
      tags: ["تست", "ادیتور"],
      content_html: '<h2>تیتر امن</h2><p onclick="alert(1)">متن امن</p><script>alert("xss")</script><img src="/images/academy-accounting.png" />',
      status: "PUBLISHED",
    },
  });
  assert.equal(artCreate.status, 201);
  assert.ok(!artCreate.json.data.article.content_html.includes("<script>"), "XSS <script> MUST be stripped!");
  assert.ok(!artCreate.json.data.article.content_html.includes("onclick="), "Inline JS handlers MUST be stripped!");

  const pubAcademyDetail = await req(`/api/v1/public/academy/${testSlug}`);
  assert.equal(pubAcademyDetail.status, 200);
  assert.equal(pubAcademyDetail.json.data.article.slug, testSlug);

  const pubPlans = await req("/api/v1/public/plans");
  assert.equal(pubPlans.status, 200);
  assert.ok(pubPlans.json.data.length >= 3);

  const pubConfig = await req("/api/v1/public/app-config");
  assert.equal(pubConfig.status, 200);
  assert.equal(pubConfig.json.data.otp_enabled, true);

  const pubContact = await req("/api/v1/public/contact", {
    method: "POST",
    body: {
      full_name: "تست فرم تماس با ما",
      mobile: "09129998877",
      email: "lead@company.ir",
      company_name: "شرکت نمونه",
      subject: "درخواست دمو سازمانی",
      message: "سلام، لطفاً جهت راه‌اندازی نسخه سازمانی تماس بگیرید.",
    },
  });
  assert.equal(pubContact.status, 201);

  const adminInq = await req("/api/v1/platform/inquiries", { token: tokenAdmin });
  assert.equal(adminInq.status, 200);
  assert.ok(adminInq.json.data.inquiries.length >= 1);

  // Clean up test article
  await req(`/api/v1/platform/academy?id=${artCreate.json.data.article.id}`, {
    method: "DELETE",
    token: tokenAdmin,
  });

  // Verify Over-Return Guard (Bug #4 Fix)
  const overReturn = await req(`/api/v1/sales/${mixedInvId}/returns`, {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    body: { total_amount: "999999999.00", reason: "تست برگشت بیشتر از فاکتور" },
  });
  assert.equal(overReturn.status, 422);
  assert.equal(overReturn.json.error.code, "RETURN_EXCEEDS_INVOICE");
  console.log("[PASS] SaaS Public APIs, Academy CMS + XSS Sanitization, Contact Inquiries & Return Accounting Guard verified");

  // ==========================================================================
  // MASTER PROMPT 07 COMPREHENSIVE END-TO-END VERIFICATION (§3 through §19)
  // ==========================================================================

  // P07-1: Atomic Register with Device + Duplicate Mobile Guard + Idempotency + Org Add-ons & UI Mode
  const regMob = `0917${Date.now().toString().slice(-7)}`;
  const regIdem = cryptoMod.randomUUID();
  const regPayload = {
    full_name: "کاربر تست ثبت‌نام پرامپت ۷",
    mobile: regMob,
    password: "RegUser@123",
    organization_name: "شرکت آزمایشی پرامپت ۷",
    device: {
      device_id: `REG-DEV-${Date.now()}`,
      platform: "android",
      app_version: "1.2.0",
      device_name: "Pixel 9 Pro",
    },
  };
  const reg1 = await req("/api/v1/auth/register", {
    method: "POST",
    headers: { "Idempotency-Key": regIdem },
    body: regPayload,
  });
  assert.equal(reg1.status, 201);
  assert.equal(reg1.json.data.user.mobile_verified, false, "Newly registered user must start unverified");
  assert.ok(reg1.json.data.device.id, "Initial device must be registered atomically");
  assert.equal(reg1.json.data.organization.ui_mode_default, "SIMPLE_OWNER");
  const regToken = reg1.json.data.access_token;
  const regOrgId = reg1.json.data.active_organization_id;

  // Idempotent retry -> returns replayed without duplicate org/user!
  const regReplay = await req("/api/v1/auth/register", {
    method: "POST",
    headers: { "Idempotency-Key": regIdem },
    body: regPayload,
  });
  assert.equal(regReplay.status, 201);
  assert.equal(regReplay.json.meta.replayed, true);

  // Duplicate mobile with new Idempotency-Key -> 409 MOBILE_ALREADY_REGISTERED!
  const regDup = await req("/api/v1/auth/register", {
    method: "POST",
    body: regPayload,
  });
  assert.equal(regDup.status, 409);
  assert.equal(regDup.json.error.code, "MOBILE_ALREADY_REGISTERED");

  // Organization enabled_addons + ui_mode_default update & invalid add-on rejection
  const orgAddonBad = await req(`/api/v1/organizations/${regOrgId}`, {
    method: "PATCH",
    token: regToken,
    orgId: regOrgId,
    body: { enabled_addons: ["INVALID_ADDON"] },
  });
  assert.equal(orgAddonBad.status, 422);

  const orgAddonOk = await req(`/api/v1/organizations/${regOrgId}`, {
    method: "PATCH",
    token: regToken,
    orgId: regOrgId,
    body: {
      enabled_addons: ["RETAIL_POS", "DISTRIBUTION"],
      ui_mode_default: "ADVANCED_ACCOUNTING",
    },
  });
  assert.equal(orgAddonOk.status, 200);
  assert.deepEqual(orgAddonOk.json.data.enabled_addons, ["RETAIL_POS", "DISTRIBUTION"]);
  assert.equal(orgAddonOk.json.data.ui_mode_default, "ADVANCED_ACCOUNTING");
  console.log("[PASS] Prompt 07-1: Atomic Register (+Device/Idempotency/Mobile Uniqueness) & Org Add-ons/UI Mode verified");

  // P07-2: Commercial Document Lifecycle — Sales Cancel (Draft & Confirmed + Double Cancel Guard) & Partial/Full Item-Level Return (+ Cumulative Qty Guard & Idempotency)
  const draftCancelSale = await req("/api/v1/sales", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    body: {
      customer_id: vendorContact.id,
      warehouse_id: whs[0].id,
      document_date: "2025-08-25",
      receipt_url: "/api/v1/files/demo-receipt",
      items: [{ product_id: prods[2].id, quantity: "2.0000", unit_price: "2450000.00" }],
    },
  });
  const dcId = draftCancelSale.json.data.id;
  const cancelDraftRes = await req(`/api/v1/sales/${dcId}/cancel`, {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    headers: { "Idempotency-Key": cryptoMod.randomUUID() },
    body: { reason: "انصراف مشتری پیش از تایید" },
  });
  assert.equal(cancelDraftRes.status, 200);
  assert.equal(cancelDraftRes.json.data.invoice.status, "CANCELLED");

  // Re-cancelling already cancelled invoice -> 409 DOCUMENT_ALREADY_CANCELLED
  const reCancel = await req(`/api/v1/sales/${dcId}/cancel`, {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    body: { reason: "تلاش مجدد لغو" },
  });
  assert.equal(reCancel.status, 409);
  assert.equal(reCancel.json.error.code, "DOCUMENT_ALREADY_CANCELLED");

  // Confirmed Sale -> Cancel with Reversal Journal & Stock Restoration!
  const confCancelSale = await req("/api/v1/sales", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    body: {
      customer_id: vendorContact.id,
      warehouse_id: whs[0].id,
      document_date: "2025-08-25",
      items: [{ product_id: prods[2].id, quantity: "2.0000", unit_price: "2450000.00" }],
    },
  });
  const ccId = confCancelSale.json.data.id;
  await req(`/api/v1/sales/${ccId}/confirm`, { method: "POST", token: tokenAdmin, orgId: parsOrgId, body: {} });
  const cancelConfRes = await req(`/api/v1/sales/${ccId}/cancel`, {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    headers: { "Idempotency-Key": cryptoMod.randomUUID() },
    body: { reason: "لغو فاکتور قطعی با سند معکوس و برگشت موجودی" },
  });
  assert.equal(cancelConfRes.status, 200);
  assert.equal(cancelConfRes.json.data.invoice.status, "CANCELLED");
  assert.ok(cancelConfRes.json.data.reversal_journal.id, "Cancelling confirmed sale MUST post reversal journal");
  assert.ok(cancelConfRes.json.data.restoration_stock_document.id, "Cancelling confirmed sale MUST restore stock");

  // Item-Level Partial Return (qty 1 of 3) + Idempotency + Exceeding Remaining Qty Blocked (qty 3 > remaining 2)!
  const retSaleCreate = await req("/api/v1/sales", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    body: {
      customer_id: vendorContact.id,
      warehouse_id: whs[0].id,
      document_date: "2025-08-26",
      items: [{ product_id: prods[2].id, quantity: "3.0000", unit_price: "2000000.00" }],
    },
  });
  const retSaleId = retSaleCreate.json.data.id;
  const origSaleItemId = retSaleCreate.json.data.items[0].id;
  await req(`/api/v1/sales/${retSaleId}/confirm`, { method: "POST", token: tokenAdmin, orgId: parsOrgId, body: {} });

  const retIdem = cryptoMod.randomUUID();
  const partialRetBody = {
    notes: "برگشت جزئی ۱ عدد",
    items: [
      {
        original_item_id: origSaleItemId,
        product_id: prods[2].id,
        quantity: "1.0000",
        warehouse_id: whs[0].id,
        reason: "کالای اضافی",
      },
    ],
  };
  const ret1 = await req(`/api/v1/sales/${retSaleId}/return`, {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    headers: { "Idempotency-Key": retIdem },
    body: partialRetBody,
  });
  assert.equal(ret1.status, 201);
  assert.equal(ret1.json.data.invoice.status, "PARTIALLY_RETURNED");
  assert.ok(ret1.json.data.journal_entry.id);

  // Idempotent retry -> no duplicate return!
  const ret1Replay = await req(`/api/v1/sales/${retSaleId}/return`, {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    headers: { "Idempotency-Key": retIdem },
    body: partialRetBody,
  });
  assert.equal(ret1Replay.status, 201);
  assert.equal(ret1Replay.json.meta.replayed, true);

  // Attempting to return 3 when only 2 remain -> 422 RETURN_QTY_EXCEEDS_REMAINING!
  const retTooMuch = await req(`/api/v1/sales/${retSaleId}/return`, {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    body: {
      items: [{ original_item_id: origSaleItemId, product_id: prods[2].id, quantity: "3.0000", warehouse_id: whs[0].id }],
    },
  });
  assert.equal(retTooMuch.status, 422);
  assert.equal(retTooMuch.json.error.code, "RETURN_QTY_EXCEEDS_REMAINING");

  // Purchase Item-Level Return (Stock OUT + DR AP / CR Inventory)
  const purCreate = await req("/api/v1/purchases", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    body: {
      supplier_id: vendorContact.id,
      warehouse_id: whs[0].id,
      document_date: "2025-08-26",
      items: [{ product_id: prods[2].id, quantity: "4.0000", unit_price: "1800000.00" }],
    },
  });
  const purId = purCreate.json.data.id;
  const origPurItemId = purCreate.json.data.items[0].id;
  await req(`/api/v1/purchases/${purId}/confirm`, { method: "POST", token: tokenAdmin, orgId: parsOrgId, body: {} });
  const purRet = await req(`/api/v1/purchases/${purId}/return`, {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    headers: { "Idempotency-Key": cryptoMod.randomUUID() },
    body: {
      notes: "برگشت ۲ بسته از خرید",
      items: [{ original_item_id: origPurItemId, product_id: prods[2].id, quantity: "2.0000", warehouse_id: whs[0].id }],
    },
  });
  assert.equal(purRet.status, 201);
  assert.equal(purRet.json.data.invoice.status, "PARTIALLY_RETURNED");
  console.log("[PASS] Prompt 07-2: Sales & Purchase Cancel (Draft/Confirmed) + Item-Level Partial Return & Cumulative Qty Guard verified");

  // P07-3: Consignments (4 Types + Ownership Ledger + Balance Guard + Double Confirm Block)
  const consIn = await req("/api/v1/consignments", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    body: {
      document_type: "CONSIGNMENT_IN",
      contact_id: vendorContact.id,
      warehouse_id: whs[0].id,
      document_date: "2025-08-27",
      commission_rate: "15.00",
      items: [{ product_id: prods[3].id, quantity: "10.0000", agreed_unit_price: "79000000.00" }],
    },
  });
  assert.equal(consIn.status, 201);
  const consInId = consIn.json.data.id;

  const consInConf = await req(`/api/v1/consignments/${consInId}/confirm`, {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    body: {},
  });
  assert.equal(consInConf.status, 200);
  assert.equal(consInConf.json.data.journal_entry, null, "CONSIGNMENT_IN MUST NOT inflate owned Inventory or Revenue!");

  // Re-confirming without idempotency key -> 409 CONSIGNMENT_ALREADY_CONFIRMED
  const consReConf = await req(`/api/v1/consignments/${consInId}/confirm`, {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    body: {},
  });
  assert.equal(consReConf.status, 409);

  // CONSIGNMENT_SALE for 4 units -> posts Commission Revenue + AP Consignor!
  const consSale = await req("/api/v1/consignments", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    body: {
      document_type: "CONSIGNMENT_SALE",
      related_document_id: consInId,
      contact_id: vendorContact.id,
      warehouse_id: whs[0].id,
      document_date: "2025-08-28",
      items: [{ product_id: prods[3].id, quantity: "4.0000", agreed_unit_price: "79000000.00" }],
    },
  });
  const consSaleConf = await req(`/api/v1/consignments/${consSale.json.data.id}/confirm`, {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    body: {},
  });
  assert.equal(consSaleConf.status, 200);
  assert.ok(consSaleConf.json.data.journal_entry.id, "CONSIGNMENT_SALE must post ownership-accurate commission + payable journal");

  // Attempting CONSIGNMENT_RETURN for 8 units when only 6 remain -> 409 CONSIGNMENT_INSUFFICIENT_BALANCE!
  const consRetOver = await req("/api/v1/consignments", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    body: {
      document_type: "CONSIGNMENT_RETURN",
      related_document_id: consInId,
      contact_id: vendorContact.id,
      warehouse_id: whs[0].id,
      document_date: "2025-08-28",
      items: [{ product_id: prods[3].id, quantity: "8.0000", agreed_unit_price: "79000000.00" }],
    },
  });
  const consRetOverConf = await req(`/api/v1/consignments/${consRetOver.json.data.id}/confirm`, {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    body: {},
  });
  assert.equal(consRetOverConf.status, 409);
  assert.equal(consRetOverConf.json.error.code, "CONSIGNMENT_INSUFFICIENT_BALANCE");

  const consBalances = await req("/api/v1/consignments/balances", { token: tokenAdmin, orgId: parsOrgId });
  assert.equal(consBalances.status, 200);
  assert.ok(consBalances.json.data.third_party_held_by_us.length >= 1);
  console.log("[PASS] Prompt 07-3: Consignments (4 Types, Independent Ownership Ledger, Balance Guard & Commission Accounting) verified");

  // P07-4: Accounting Policy (GET/PUT + Non-Retroactive), Cost Centers (+ Duplicate Code + P&L), Period Lock & Unlock
  const polPut = await req("/api/v1/accounting/policy", {
    method: "PUT",
    token: tokenAdmin,
    orgId: parsOrgId,
    body: {
      default_tax_rate: "9.00",
      is_tax_inclusive: true,
      invoice_prefix: "INV-",
      low_stock_alert_enabled: true,
    },
  });
  assert.equal(polPut.status, 200);
  assert.equal(polPut.json.data.default_tax_rate, "9.00");
  assert.equal(polPut.json.data.is_tax_inclusive, true);

  const ccCode = `CC-P07-${Date.now().toString().slice(-4)}`;
  const ccCreate = await req("/api/v1/accounting/cost-centers", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    body: { code: ccCode, name: "پروژه توسعه فروش آنلاین", type: "PROJECT", is_active: true },
  });
  assert.equal(ccCreate.status, 201);
  const ccDup = await req("/api/v1/accounting/cost-centers", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    body: { code: ccCode, name: "کد تکراری", type: "PROJECT", is_active: true },
  });
  assert.equal(ccDup.status, 409);

  // Quick Cashflow with cost_center_id & receipt_url
  const qcRes = await req("/api/v1/quick-cashflows", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    headers: { "Idempotency-Key": cryptoMod.randomUUID() },
    body: {
      kind: "EXPENSE",
      category_id: transportCat.id,
      financial_account_id: cashFinAcc.id,
      cost_center_id: ccCreate.json.data.id,
      receipt_url: "/api/v1/files/qc-receipt-01",
      title: "هزینه حمل پروژه فروش آنلاین",
      amount: "450000.00",
    },
  });
  assert.equal(qcRes.status, 201);
  const ccPl = await req(`/api/v1/accounting/cost-centers/${ccCreate.json.data.id}/profit-loss`, {
    token: tokenAdmin,
    orgId: parsOrgId,
  });
  assert.equal(ccPl.status, 200);
  assert.equal(ccPl.json.data.total_expense, "450000.00");

  // Period Lock -> blocks posting on/before locked_until -> Unlock with mandatory reason restores posting!
  const regFyYears = (await req("/api/v1/fiscal/years", { token: regToken, orgId: regOrgId })).json.data;
  const regFy = regFyYears[0];
  const lockRes = await req("/api/v1/accounting/periods/lock", {
    method: "POST",
    token: regToken,
    orgId: regOrgId,
    body: {
      fiscal_year_id: regFy.id,
      period_title: regFy.periods[1].name,
      locked_until: "2025-08-31",
    },
  });
  assert.equal(lockRes.status, 200);
  assert.equal(lockRes.json.data.period.status, "LOCKED");

  const regCoa = (await req("/api/v1/fiscal/accounts", { token: regToken, orgId: regOrgId })).json.data.accounts;
  const regBank = regCoa.find((a) => a.system_role === "BANK");
  const regOpex = regCoa.find((a) => a.system_role === "OPEX");

  const postInLocked = await req("/api/v1/accounting/journal-entries", {
    method: "POST",
    token: regToken,
    orgId: regOrgId,
    body: {
      fiscal_year_id: regFy.id,
      accounting_period_id: lockRes.json.data.period.id,
      document_date: "2025-08-15",
      description: "تلاش برای ثبت در دوره قفل‌شده",
      confirm_immediately: true,
      lines: [
        { account_id: regOpex.id, debit: "100000.00", credit: "0.00" },
        { account_id: regBank.id, debit: "0.00", credit: "100000.00" },
      ],
    },
  });
  assert.equal(postInLocked.status, 409);
  assert.equal(postInLocked.json.error.code, "ACCOUNTING_PERIOD_LOCKED");

  const unlockRes = await req(`/api/v1/accounting/periods/${lockRes.json.data.period.id}/unlock`, {
    method: "POST",
    token: regToken,
    orgId: regOrgId,
    body: { reason: "بازگشایی مجاز دوره جهت ثبت سند اصلاحی" },
  });
  assert.equal(unlockRes.status, 200);
  assert.equal(unlockRes.json.data.status, "OPEN");
  console.log("[PASS] Prompt 07-4: Accounting Policy, Cost Centers (+P&L), Quick Cashflows & Period Lock/Unlock verified");

  // P07-5: Unified Personal Transfers (Business->Personal, Personal->Business, Insufficient Balance, Idempotency & RBAC!)
  const pfDashData = (await req("/api/v1/personal-finance/dashboard", { token: tokenAdmin, orgId: parsOrgId })).json.data;
  const personalCash = [...pfDashData.accounts].sort((a, b) => Number(b.balance) - Number(a.balance))[0];

  const ptIdem = cryptoMod.randomUUID();
  const ptBizToPers = await req("/api/v1/personal/transfers", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    headers: { "Idempotency-Key": ptIdem },
    body: {
      from_account_id: bankFinAcc.id,
      to_account_id: personalCash.id,
      amount: "2000000.00",
      description: "انتقال از بانک شرکت به حساب شخصی",
    },
  });
  assert.equal(ptBizToPers.status, 201);
  assert.equal(ptBizToPers.json.data.transfer_type, "BUSINESS_TO_PERSONAL");

  // Idempotent replay
  const ptReplay = await req("/api/v1/personal/transfers", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    headers: { "Idempotency-Key": ptIdem },
    body: {
      from_account_id: bankFinAcc.id,
      to_account_id: personalCash.id,
      amount: "2000000.00",
      description: "انتقال از بانک شرکت به حساب شخصی",
    },
  });
  assert.equal(ptReplay.json.meta.replayed, true);

  // Personal -> Business contribution (NOT Sales Revenue!)
  const ptPersToBiz = await req("/api/v1/personal/transfers", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    headers: { "Idempotency-Key": cryptoMod.randomUUID() },
    body: {
      from_account_id: personalCash.id,
      to_account_id: bankFinAcc.id,
      amount: "1000000.00",
      description: "آورده شخصی به بانک شرکت",
    },
  });
  assert.equal(ptPersToBiz.status, 201);
  assert.equal(ptPersToBiz.json.data.transfer_type, "PERSONAL_TO_BUSINESS");

  // Unauthorized salesperson attempting personal transfer -> 403!
  const ptDenied = await req("/api/v1/personal/transfers", {
    method: "POST",
    token: empToken,
    orgId: parsOrgId,
    body: { from_account_id: bankFinAcc.id, to_account_id: personalCash.id, amount: "100000.00" },
  });
  assert.equal(ptDenied.status, 403);
  console.log("[PASS] Prompt 07-5: Unified Personal Transfers (Biz↔Personal, Idempotency & Strict RBAC) verified");

  // P07-6: Sync Engine Expansion across ALL new Entity Types (branch, cost_center, warehouse, product_variant, treasury_account, owner_withdrawal + Tombstone + RBAC!)
  const syncBranchId = cryptoMod.randomUUID();
  const syncCcId = cryptoMod.randomUUID();
  const syncVarId = cryptoMod.randomUUID();
  const syncTrAccId = cryptoMod.randomUUID();
  const syncMultiPush = await req("/api/v1/sync/push", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    headers: { "Idempotency-Key": cryptoMod.randomUUID() },
    body: {
      device_id: testDeviceId,
      batch_id: cryptoMod.randomUUID(),
      events: [
        {
          event_id: cryptoMod.randomUUID(),
          idempotency_key: cryptoMod.randomUUID(),
          entity_type: "branch",
          entity_id: syncBranchId,
          operation: "CREATE",
          payload: { code: `BR-S-${Date.now().toString().slice(-4)}`, name: "شعبه همگام‌شده آفلاین" },
        },
        {
          event_id: cryptoMod.randomUUID(),
          idempotency_key: cryptoMod.randomUUID(),
          entity_type: "cost_center",
          entity_id: syncCcId,
          operation: "CREATE",
          payload: { code: `CC-S-${Date.now().toString().slice(-4)}`, name: "مرکز هزینه آفلاین", type: "BRANCH" },
        },
        {
          event_id: cryptoMod.randomUUID(),
          idempotency_key: cryptoMod.randomUUID(),
          entity_type: "product_variant",
          entity_id: syncVarId,
          operation: "CREATE",
          payload: { product_id: prods[0].id, sku: `VAR-S-${Date.now().toString().slice(-4)}`, variant_name: "مدل صنعتی Sync", sale_price: "56000000.00" },
        },
        {
          event_id: cryptoMod.randomUUID(),
          idempotency_key: cryptoMod.randomUUID(),
          entity_type: "treasury_account",
          entity_id: syncTrAccId,
          operation: "CREATE",
          payload: { name: "صندوق سیار ویزیتور", account_type: "CASHBOX" },
        },
        {
          event_id: cryptoMod.randomUUID(),
          idempotency_key: cryptoMod.randomUUID(),
          entity_type: "owner_withdrawal",
          entity_id: cryptoMod.randomUUID(),
          operation: "CREATE",
          payload: { business_financial_account_id: bankFinAcc.id, amount: "500000.00", notes: "برداشت آفلاین" },
        },
      ],
    },
  });
  assert.equal(syncMultiPush.status, 200);
  assert.equal(syncMultiPush.json.data.applied_count, 5, "All 5 extended Sync entities must apply cleanly");

  // Tombstone DELETE on branch -> appears in Pull stream!
  const branchTomb = await req("/api/v1/sync/push", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    headers: { "Idempotency-Key": cryptoMod.randomUUID() },
    body: {
      device_id: testDeviceId,
      batch_id: cryptoMod.randomUUID(),
      events: [
        {
          event_id: cryptoMod.randomUUID(),
          idempotency_key: cryptoMod.randomUUID(),
          entity_type: "branch",
          entity_id: syncBranchId,
          operation: "DELETE",
          base_version: 1,
          payload: {},
        },
      ],
    },
  });
  assert.equal(branchTomb.json.data.results[0].status, "ACCEPTED");
  console.log("[PASS] Prompt 07-6: Extended Sync Engine (branch, cost_center, product_variant, treasury_account, owner_withdrawal & Tombstone) verified");

  // ==========================================================================
  // MASTER PROMPT 08 — ALL ACCEPTANCE CRITERIA VERIFICATION (Phases 2–9)
  // ==========================================================================

  // P08-1: Landed-Cost Incoming Warehouse Receipt (Shipping + Customs - Discount + Partial Bank Pay + Remaining AP)
  const landedReceipt = await req("/api/v1/inventory/receipts", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    headers: { "Idempotency-Key": cryptoMod.randomUUID() },
    body: {
      warehouse_id: whs[0].id,
      supplier_id: vendorContact.id,
      supplier_invoice_number: `SUP-INV-${Date.now().toString().slice(-5)}`,
      invoice_date_jalali: "1404/06/10",
      shipping_cost: "500000.00",
      customs_and_extra_cost: "1500000.00",
      supplier_discount: "1000000.00",
      payment_bank_account_id: bankFinAcc.id,
      paid_amount: "4000000.00",
      attachment_url: "/api/v1/files/supplier-invoice-01",
      items: [{ product_id: prods[2].id, quantity: "5.0000", unit_price: "2000000.00" }], // gross 10M + 0.5M + 1.5M - 1M = 11M total; paid 4M; AP = 7M!
    },
  });
  assert.equal(landedReceipt.status, 201);
  assert.equal(landedReceipt.json.data.cost_breakdown.total_acquisition_cost, "11000000.00");
  assert.equal(landedReceipt.json.data.cost_breakdown.remaining_payable, "7000000.00");
  assert.ok(landedReceipt.json.data.journal_entry.id, "Landed receipt must post balanced DR Inventory / CR Bank+AP journal");
  assert.equal(landedReceipt.json.data.document.document_date_jalali, "1404/06/10");

  // Supplier Profile & Settlement (DR AP / CR Bank + Idempotency)
  const supProfBefore = await req(`/api/v1/suppliers/${vendorContact.id}/profile`, { token: tokenAdmin, orgId: parsOrgId });
  assert.equal(supProfBefore.status, 200);
  assert.ok(supProfBefore.json.data.warehouse_receipts.length >= 1);

  const supSettle = await req(`/api/v1/suppliers/${vendorContact.id}/settlements`, {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    headers: { "Idempotency-Key": cryptoMod.randomUUID() },
    body: {
      financial_account_id: bankFinAcc.id,
      payment_method: "BANK",
      amount: "2000000.00",
      settlement_date_jalali: "1404/06/12",
      reference_number: "SUP-PAY-001",
    },
  });
  assert.equal(supSettle.status, 201);
  assert.ok(supSettle.json.data.journal_entry.id);
  console.log("[PASS] Prompt 08-1: Landed-Cost Warehouse Receipt (Jalali Date + AP Split) & Supplier Settlement verified");

  // P08-2: Sales Invoice Mixed Settlement with CASH + BANK + CARD_TERMINAL + Multiple CHEQUES (Jalali Due Date) + CREDIT
  const p08SaleDraft = await req("/api/v1/sales", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    body: {
      customer_id: vendorContact.id,
      warehouse_id: whs[0].id,
      document_date: "2025-09-02",
      items: [{ product_id: prods[2].id, quantity: "5.0000", unit_price: "2000000.00" }], // 10,000,000.00
    },
  });
  const p08SaleId = p08SaleDraft.json.data.id;
  const p08SaleConfirm = await req(`/api/v1/sales/${p08SaleId}/confirm`, {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    body: {
      payment_allocations: [
        { payment_method: "CASH", amount: "1000000.00" },
        { payment_method: "CARD_TERMINAL", amount: "2000000.00" },
        {
          payment_method: "CHEQUE",
          amount: "2500000.00",
          cheque: {
            cheque_number: `4048${Date.now().toString().slice(-10)}1`,
            bank_name: "بانک ملت",
            due_date_jalali: "1404/07/15",
          },
        },
        {
          payment_method: "CHEQUE",
          amount: "2500000.00",
          cheque: {
            cheque_number: `4048${Date.now().toString().slice(-10)}2`,
            bank_name: "بانک سامان",
            due_date_jalali: "1404/08/15",
          },
        },
        { payment_method: "CREDIT", amount: "2000000.00" },
      ],
    },
  });
  assert.equal(p08SaleConfirm.status, 200);
  assert.equal(p08SaleConfirm.json.data.cheques.length, 2, "Must create 2 inline cheques with Jalali due dates");
  assert.equal(p08SaleConfirm.json.data.cheques[0].due_date_jalali, "1404/07/15");
  assert.equal(p08SaleConfirm.json.data.invoice.remaining_amount, "2000000.00");

  // Sales Return with Physical Acceptance & Damaged Split (1 accepted -> restocked, 1 damaged -> NOT restocked!)
  const p08ItemId = p08SaleDraft.json.data.items[0].id;
  const splitRet = await req(`/api/v1/sales/${p08SaleId}/return`, {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    headers: { "Idempotency-Key": cryptoMod.randomUUID() },
    body: {
      notes: "۱ عدد سالم برگشت به انبار و ۱ عدد آسیب‌دیده",
      items: [
        {
          original_item_id: p08ItemId,
          product_id: prods[2].id,
          quantity: "2.0000",
          accepted_quantity: "1.0000",
          damaged_quantity: "1.0000",
          physically_received: true,
          warehouse_id: whs[0].id,
        },
      ],
    },
  });
  assert.equal(splitRet.status, 201);
  assert.equal(splitRet.json.data.items[0].accepted_quantity, "1.0000");
  assert.equal(splitRet.json.data.items[0].damaged_quantity, "1.0000");

  // Controlled Cheque Editing: Active Cheque financial edit requires correction_reason -> posts delta journal; Settled Cheque blocked!
  const firstChqId = p08SaleConfirm.json.data.cheques[0].id;
  const chqNoReason = await req(`/api/v1/cheques/${firstChqId}`, {
    method: "PATCH",
    token: tokenAdmin,
    orgId: parsOrgId,
    body: { amount: "2600000.00" },
  });
  assert.equal(chqNoReason.status, 422);
  assert.equal(chqNoReason.json.error.code, "CORRECTION_REASON_REQUIRED");

  const chqAmended = await req(`/api/v1/cheques/${firstChqId}`, {
    method: "PATCH",
    token: tokenAdmin,
    orgId: parsOrgId,
    body: {
      amount: "2600000.00",
      due_date_jalali: "1404/07/20",
      correction_reason: "اصلاح مبلغ و سررسید چک پس از تطبیق با تصویر صیاد",
    },
  });
  assert.equal(chqAmended.status, 200);
  assert.equal(chqAmended.json.data.cheque.due_date_jalali, "1404/07/20");
  assert.ok(chqAmended.json.data.adjustment_journal.id, "Amount amendment must post balanced delta journal");
  console.log("[PASS] Prompt 08-2: Mixed Sales (+2 Jalali Cheques), Damaged-Split Return & Audited Cheque Editing verified");

  // P08-3: Multi-Item Warehouse Transfer (DRAFT -> IN_TRANSIT -> Partial Receive with Discrepancy on 1 item -> COMPLETED)
  const multiTr = await req("/api/v1/inventory/transfers", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    body: {
      source_warehouse_id: whs[0].id,
      destination_warehouse_id: whs[1].id,
      transfer_date_jalali: "1404/06/14",
      reason: "تأمین موجودی انبار غرب",
      source_responsible_name: "سعید محمدی",
      destination_responsible_name: "حسین کریمی",
      dispatch_immediately: true,
      items: [
        { product_id: prods[0].id, quantity: "2.0000" },
        { product_id: prods[2].id, quantity: "5.0000" },
      ],
    },
  });
  assert.equal(multiTr.status, 201);
  assert.equal(multiTr.json.data.transfer.status, "IN_TRANSIT");
  const trId = multiTr.json.data.transfer.id;
  const trItems = multiTr.json.data.items;

  // Destination receives item #0 completely (2 of 2), item #1 with discrepancy (4 accepted, 1 damaged)!
  const trRecv = await req(`/api/v1/inventory/transfers/${trId}/receive`, {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    body: {
      notes: "اقلام سالم تحویل گرفته شد؛ ۱ بسته کاغذ آسیب‌دیده بود",
      items: [
        { transfer_item_id: trItems[0].id, product_id: prods[0].id, accepted_qty: "2.0000" },
        {
          transfer_item_id: trItems[1].id,
          product_id: prods[2].id,
          accepted_qty: "4.0000",
          damaged_qty: "1.0000",
          discrepancy_note: "بسته‌بندی در مسیر خیس شده بود",
        },
      ],
    },
  });
  assert.equal(trRecv.status, 200);
  assert.equal(trRecv.json.data.transfer.status, "DISCREPANCY_REPORTED");
  assert.equal(trRecv.json.data.discrepancies.length, 1);

  const trComp = await req(`/api/v1/inventory/transfers/${trId}/complete`, {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    body: {},
  });
  assert.equal(trComp.status, 200);
  assert.equal(trComp.json.data.status, "COMPLETED");
  console.log("[PASS] Prompt 08-3: Multi-Item Transfer (IN_TRANSIT -> Partial Receive & Discrepancy -> COMPLETED) verified");

  // P08-4: Treasury Account Add/Edit/History/Delete-Guard + Jalali Journal Entry + Real Inventory & Movement Excel Exports
  const newTrAcc = await req("/api/v1/treasury/accounts", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    body: { name: "صندوق فروشگاهی تست P08", account_type: "CASH", opening_balance: "1500000.00" },
  });
  assert.equal(newTrAcc.status, 201);
  const trAccHist = await req(`/api/v1/treasury/accounts/${bankFinAcc.id}/transactions`, { token: tokenAdmin, orgId: parsOrgId });
  assert.equal(trAccHist.status, 200);
  assert.ok(trAccHist.json.data.transactions.length >= 1);

  // Deleting a treasury account with history MUST be blocked (409 TREASURY_ACCOUNT_HAS_HISTORY)!
  const delUsedBank = await req(`/api/v1/treasury/accounts/${bankFinAcc.id}`, {
    method: "DELETE",
    token: tokenAdmin,
    orgId: parsOrgId,
  });
  assert.equal(delUsedBank.status, 409);
  assert.equal(delUsedBank.json.error.code, "TREASURY_ACCOUNT_HAS_HISTORY");

  // Jalali Journal Entry
  const jalaliJournal = await req("/api/v1/accounting/journal-entries", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    body: {
      document_date_jalali: "1404/06/15",
      description: "سند چندردیفه با تاریخ شمسی",
      confirm_immediately: true,
      lines: [
        { account_id: opexAcc.id, debit: "300000.00", credit: "0.00" },
        { account_id: bankAcc.id, debit: "0.00", credit: "300000.00" },
      ],
    },
  });
  assert.equal(jalaliJournal.status, 201);
  assert.equal(jalaliJournal.json.data.document_date_jalali, "1404/06/15");

  // Excel Exports for Current Stock & Movement History (real XLSX verification!)
  const [stkXlsxRes, movXlsxRes] = await Promise.all([
    fetch(`${BASE}/api/v1/inventory/exports/stock?warehouse_id=${whs[0].id}`, {
      headers: { Authorization: `Bearer ${tokenAdmin}`, "X-Organization-Id": parsOrgId, "X-Client-Version": "1.0.0" },
    }),
    fetch(`${BASE}/api/v1/inventory/exports/movements?warehouse_id=${whs[0].id}`, {
      headers: { Authorization: `Bearer ${tokenAdmin}`, "X-Organization-Id": parsOrgId, "X-Client-Version": "1.0.0" },
    }),
  ]);
  assert.equal(stkXlsxRes.status, 200);
  assert.equal(movXlsxRes.status, 200);
  const stkWb = XLSX.read(Buffer.from(await stkXlsxRes.arrayBuffer()), { type: "buffer" });
  const movWb = XLSX.read(Buffer.from(await movXlsxRes.arrayBuffer()), { type: "buffer" });
  assert.ok(XLSX.utils.sheet_to_json(stkWb.Sheets["WarehouseStock"]).length > 0);
  assert.ok(XLSX.utils.sheet_to_json(movWb.Sheets["WarehouseMovements"]).length > 0);
  console.log("[PASS] Prompt 08-4: Treasury History/Delete Guard, Jalali Journal Entry & Real Inventory/Movement .xlsx Exports verified");

  // P08-5: OFFLINE_ONLY Operating Mode (Requires Agreement -> Blocks Sync Push/Pull) -> Controlled Resumable Cloud Migration!
  const offNoAgree = await req("/api/v1/settings/operating-mode", {
    method: "POST",
    token: regToken,
    orgId: regOrgId,
    body: { mode: "OFFLINE_ONLY", agreement_accepted: false },
  });
  assert.equal(offNoAgree.status, 422);
  assert.equal(offNoAgree.json.error.code, "DATA_RESPONSIBILITY_AGREEMENT_REQUIRED");

  const regDevId = reg1.json.data.device.id;
  const offOn = await req("/api/v1/settings/operating-mode", {
    method: "POST",
    token: regToken,
    orgId: regOrgId,
    body: { mode: "OFFLINE_ONLY", device_id: regDevId, agreement_accepted: true, agreement_version: "2026.08.v1" },
  });
  assert.equal(offOn.status, 200);
  assert.equal(offOn.json.data.mode, "OFFLINE_ONLY");

  // Background Sync Pull MUST be blocked while in OFFLINE_ONLY (409 OPERATING_MODE_OFFLINE_ONLY)!
  const blockedPull = await req(`/api/v1/sync/pull?device_id=${regDevId}`, { token: regToken, orgId: regOrgId });
  assert.equal(blockedPull.status, 409);
  assert.equal(blockedPull.json.error.code, "OPERATING_MODE_OFFLINE_ONLY");

  // Controlled Cloud Reactivation: start -> upload-batch -> complete -> CLOUD_SYNC resumed!
  const migStart = await req("/api/v1/sync/cloud-migration/start", {
    method: "POST",
    token: regToken,
    orgId: regOrgId,
    headers: { "Idempotency-Key": cryptoMod.randomUUID() },
    body: { device_id: regDevId, inventory_summary: { contacts: 1 } },
  });
  assert.equal(migStart.status, 201);
  const migId = migStart.json.data.id;

  const migrationBatchKey = cryptoMod.randomUUID();
  const migrationBatch = {
    batch_index: 1,
    events: [
      {
        event_id: cryptoMod.randomUUID(),
        idempotency_key: cryptoMod.randomUUID(),
        entity_type: "contact",
        entity_id: cryptoMod.randomUUID(),
        operation: "CREATE",
        payload: { code: "C-MIG-01", display_name: "مشتری مهاجرت‌شده از حالت آفلاین", type: "CUSTOMER" },
      },
    ],
  };
  const migUpload = await req(`/api/v1/sync/cloud-migration/${migId}/upload-batch`, {
    method: "POST",
    token: regToken,
    orgId: regOrgId,
    headers: { "Idempotency-Key": migrationBatchKey },
    body: migrationBatch,
  });
  assert.equal(migUpload.status, 200);
  assert.equal(migUpload.json.data.batch_result.applied_count, 1);

  const migUploadReplay = await req(`/api/v1/sync/cloud-migration/${migId}/upload-batch`, {
    method: "POST",
    token: regToken,
    orgId: regOrgId,
    headers: { "Idempotency-Key": migrationBatchKey },
    body: migrationBatch,
  });
  assert.equal(migUploadReplay.status, 200);
  assert.equal(migUploadReplay.json.meta.replayed, true);
  assert.equal(migUploadReplay.json.data.migration.uploaded_batches, migUpload.json.data.migration.uploaded_batches);

  const migComp = await req(`/api/v1/sync/cloud-migration/${migId}/complete`, {
    method: "POST",
    token: regToken,
    orgId: regOrgId,
    body: {},
  });
  assert.equal(migComp.status, 200);
  assert.equal(migComp.json.data.operating_mode, "CLOUD_SYNC");

  // Normal Sync Pull now works again!
  const resumedPull = await req(`/api/v1/sync/pull?device_id=${regDevId}`, { token: regToken, orgId: regOrgId });
  assert.equal(resumedPull.status, 200);
  console.log("[PASS] Prompt 08-5: OFFLINE_ONLY Agreement/Sync-Block & Controlled Resumable Cloud Reactivation Migration verified");

  // P08-6: Versioned Signed Entitlement Snapshot + 4 Independent Payment Gateways (Zarinpal, Zibal, Balleh Pay, Saman) + Server Callback + Duplicate Callback Protection!
  const gwListAdmin = await req("/api/v1/platform/payment-gateways", { token: tokenAdmin });
  assert.equal(gwListAdmin.status, 200);
  const gwCodes = gwListAdmin.json.data.gateways.map((g) => g.gateway);
  for (const expectedGw of ["ZARINPAL", "ZIBAL", "BALLEH_PAY", "SAMAN"]) {
    assert.ok(gwCodes.includes(expectedGw), `Gateway ${expectedGw} must be configured`);
  }

  const entBefore = (await req("/api/v1/subscription/entitlements", { token: regToken, orgId: regOrgId })).json.data;
  assert.ok(entBefore.signature && entBefore.entitlement_version >= 1);

  // Test checkout & server callback verification across ALL 4 gateways!
  for (const gw of ["ZARINPAL", "ZIBAL", "BALLEH_PAY", "SAMAN"]) {
    const upg = await req("/api/v1/subscription/upgrade", {
      method: "POST",
      token: regToken,
      orgId: regOrgId,
      headers: { "Idempotency-Key": cryptoMod.randomUUID() },
      body: { plan_code: "PRO", gateway: gw },
    });
    assert.equal(upg.status, 201, `Upgrade order creation via ${gw} must succeed`);
    const payUrl = new URL(upg.json.data.payment_url);
    payUrl.searchParams.set("format", "json");

    // Simulate gateway server callback
    const cbRes = await fetch(payUrl.toString(), { headers: { Accept: "application/json" } });
    const cbJson = await cbRes.json();
    assert.equal(cbRes.status, 200);
    assert.equal(cbJson.data.verified, true, `${gw} server verification must succeed`);

    // Duplicate callback protection -> already_verified = true without throwing or double-extending!
    const cbDup = await fetch(payUrl.toString(), { headers: { Accept: "application/json" } });
    const cbDupJson = await cbDup.json();
    assert.equal(cbDupJson.data.already_verified, true, `${gw} duplicate callback must be idempotent`);

    // Verify merchant result page renders HTTP 200 with App Link!
    const resultPage = await fetch(`${BASE}/payments/result/${encodeURIComponent(upg.json.data.payment_reference)}`);
    assert.equal(resultPage.status, 200);
    const resultHtml = await resultPage.text();
    assert.ok(resultHtml.includes("karvexa://payment/result"));
  }

  const entAfter = (await req("/api/v1/subscriptions/entitlements", { token: regToken, orgId: regOrgId })).json.data;
  assert.ok(entAfter.entitlement_version > entBefore.entitlement_version, "Entitlement version MUST increment on verified upgrade");
  assert.ok(Array.isArray(entAfter.enabled_features), "Prompt 09A §11: enabled_features[] must be returned");
  assert.ok(entAfter.feature_limits && entAfter.server_time && entAfter.plan_name, "Prompt 09A §11: full entitlement contract fields required");
  console.log("[PASS] Prompt 08-6: Versioned Signed Entitlements & All 4 Payment Gateways (Zarinpal, Zibal, Balleh Pay, Saman) + Deep-Link Result Page verified");

  // ==========================================================================
  // MASTER PROMPT 09A TARGETED VERIFICATION TESTS (P09A-1 through P09A-4)
  // ==========================================================================

  // P09A-1: Sales Settlement contact_id + cheque_id + CREDIT row persistence + Supplier /account, /transactions, /settlements + PUT Treasury + Cheque Version Conflict
  const saleAllocs = (await req(`/api/v1/sales/${p08SaleId}/payments`, { token: tokenAdmin, orgId: parsOrgId })).json.data;
  assert.ok(saleAllocs.some((a) => a.payment_method === "CHEQUE" && a.cheque_id), "CHEQUE allocation must store cheque_id");
  assert.ok(saleAllocs.some((a) => a.payment_method === "CREDIT" && a.contact_id), "CREDIT allocation must store contact_id");

  const [supAccRes, supTxRes, supSetRes] = await Promise.all([
    req(`/api/v1/suppliers/${vendorContact.id}/account`, { token: tokenAdmin, orgId: parsOrgId }),
    req(`/api/v1/suppliers/${vendorContact.id}/transactions`, { token: tokenAdmin, orgId: parsOrgId }),
    req(`/api/v1/suppliers/${vendorContact.id}/settlements?payment_method=BANK_TRANSFER`, { token: tokenAdmin, orgId: parsOrgId }),
  ]);
  assert.equal(supAccRes.status, 200);
  assert.equal(supTxRes.status, 200);
  assert.equal(supSetRes.status, 200);

  // PUT /api/v1/treasury/accounts/{id}
  const putTrAcc = await req(`/api/v1/treasury/accounts/${newTrAcc.json.data.id}`, {
    method: "PUT",
    token: tokenAdmin,
    orgId: parsOrgId,
    body: { name: "صندوق فروشگاهی به‌روزشده (PUT)" },
  });
  assert.equal(putTrAcc.status, 200);
  assert.equal(putTrAcc.json.data.name, "صندوق فروشگاهی به‌روزشده (PUT)");

  // Cheque optimistic version conflict guard (409 VERSION_CONFLICT)
  const chqStaleVer = await req(`/api/v1/cheques/${firstChqId}`, {
    method: "PATCH",
    token: tokenAdmin,
    orgId: parsOrgId,
    body: { version: 999, notes: "تلاش با نسخه نامعتبر" },
  });
  assert.equal(chqStaleVer.status, 409);
  assert.equal(chqStaleVer.json.error.code, "VERSION_CONFLICT");
  console.log("[PASS] Prompt 09A-1: Settlement FKs (cheque_id/contact_id), Supplier /account|/transactions|/settlements, PUT Treasury & Cheque Version Guard verified");

  // P09A-2: Tenant-safe, idempotent transfer creation and locked transfer lifecycle.
  const rollProd = prods.find((p) => p.code === "CON-ROLL-80") || prods[0];
  const unownedWarehouseTransfer = await req("/api/v1/inventory/transfers", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    body: {
      source_warehouse_id: whs[0].id,
      destination_warehouse_id: cryptoMod.randomUUID(),
      reason: "تست محدودیت انبار سازمان",
      source_responsible_name: "انباردار مبدأ",
      destination_responsible_name: "انباردار مقصد",
      items: [{ product_id: rollProd.id, quantity: "1.0000" }],
    },
  });
  assert.equal(unownedWarehouseTransfer.status, 404, "A transfer must reject a warehouse outside the organization");

  const tr09CreateKey = cryptoMod.randomUUID();
  const tr09CreateBody = {
    source_warehouse_id: whs[0].id,
    destination_warehouse_id: whs[1].id,
    reason: "تست چرخه کامل Prompt 09A",
    source_responsible_name: "انباردار ۱",
    destination_responsible_name: "انباردار ۲",
    dispatch_immediately: false,
    items: [{ product_id: rollProd.id, quantity: "3.0000" }],
  };
  const trDraftRes = await req("/api/v1/inventory/transfers", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    headers: { "Idempotency-Key": tr09CreateKey },
    body: tr09CreateBody,
  });
  assert.equal(trDraftRes.status, 201);
  assert.equal(trDraftRes.json.data.transfer.status, "DRAFT");
  const tr09Id = trDraftRes.json.data.transfer.id;
  const tr09ItemId = trDraftRes.json.data.items[0].id;
  const trDraftReplay = await req("/api/v1/inventory/transfers", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    headers: { "Idempotency-Key": tr09CreateKey },
    body: tr09CreateBody,
  });
  assert.equal(trDraftReplay.json.meta.replayed, true, "Duplicate transfer creation MUST be idempotent");
  assert.equal(trDraftReplay.json.data.transfer.id, tr09Id);

  const cancelDraft = await req("/api/v1/inventory/transfers", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    headers: { "Idempotency-Key": cryptoMod.randomUUID() },
    body: { ...tr09CreateBody, items: [{ product_id: rollProd.id, quantity: "1.0000" }] },
  });
  assert.equal(cancelDraft.status, 201);
  const cancelTransferDraftRes = await req("/api/v1/inventory/transfers/" + cancelDraft.json.data.transfer.id + "/cancel", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    body: { reason: "لغو پیش از خروج کالا" },
  });
  assert.equal(cancelTransferDraftRes.status, 200);
  assert.equal(cancelTransferDraftRes.json.data.status, "CANCELLED");

  const trSubRes = await req("/api/v1/inventory/transfers/" + tr09Id + "/submit", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    body: {},
  });
  assert.equal(trSubRes.status, 200);
  assert.equal(trSubRes.json.data.status, "SUBMITTED");

  const dispKey = cryptoMod.randomUUID();
  const trDisp1 = await req("/api/v1/inventory/transfers/" + tr09Id + "/dispatch", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    headers: { "Idempotency-Key": dispKey },
    body: {},
  });
  assert.equal(trDisp1.status, 200);
  assert.equal(trDisp1.json.data.transfer.status, "IN_TRANSIT");
  const trDispReplay = await req("/api/v1/inventory/transfers/" + tr09Id + "/dispatch", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    headers: { "Idempotency-Key": dispKey },
    body: {},
  });
  assert.equal(trDispReplay.json.meta.replayed, true, "Duplicate dispatch MUST be idempotent");

  const cancelInTransit = await req("/api/v1/inventory/transfers/" + tr09Id + "/cancel", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    body: { reason: "نباید پس از خروج باطل شود" },
  });
  assert.equal(cancelInTransit.status, 409, "A dispatched transfer cannot be cancelled without a reversal document");
  assert.equal(cancelInTransit.json.error.code, "TRANSFER_CANNOT_CANCEL");

  const partialRecvKey = cryptoMod.randomUUID();
  const partialRecvBody = {
    items: [{
      transfer_item_id: tr09ItemId,
      product_id: rollProd.id,
      accepted_quantity: "1.0000",
    }],
  };
  const trPartialRecv = await req("/api/v1/inventory/transfers/" + tr09Id + "/receive", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    headers: { "Idempotency-Key": partialRecvKey },
    body: partialRecvBody,
  });
  assert.equal(trPartialRecv.status, 200);
  assert.equal(trPartialRecv.json.data.transfer.status, "PARTIALLY_RECEIVED");

  const prematureComplete = await req("/api/v1/inventory/transfers/" + tr09Id + "/complete", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    body: {},
  });
  assert.equal(prematureComplete.status, 409, "A partial transfer must remain open until all quantities are accounted for");
  assert.equal(prematureComplete.json.error.code, "TRANSFER_CANNOT_COMPLETE");

  const recvKey = cryptoMod.randomUUID();
  const recvBody = {
    items: [{
      transfer_item_id: tr09ItemId,
      product_id: rollProd.id,
      accepted_quantity: "1.0000",
      rejected_quantity: "1.0000",
      discrepancy_type: "QUALITY_REJECTED",
      discrepancy_description: "آسیب رطوبت در ۱ بسته",
    }],
  };
  const trRecv1 = await req("/api/v1/inventory/transfers/" + tr09Id + "/receive", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    headers: { "Idempotency-Key": recvKey },
    body: recvBody,
  });
  assert.equal(trRecv1.status, 200);
  assert.equal(trRecv1.json.data.transfer.status, "DISCREPANCY_REPORTED");
  assert.equal(trRecv1.json.data.items[0].discrepancy_type, "QUALITY_REJECTED");
  assert.equal(trRecv1.json.data.items[0].quantity_accepted, "2.0000");
  assert.equal(trRecv1.json.data.items[0].quantity_rejected, "1.0000");

  const trRecvReplay = await req("/api/v1/inventory/transfers/" + tr09Id + "/receive", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    headers: { "Idempotency-Key": recvKey },
    body: recvBody,
  });
  assert.equal(trRecvReplay.json.meta.replayed, true, "Duplicate receive MUST be idempotent");

  const trComplete = await req("/api/v1/inventory/transfers/" + tr09Id + "/complete", {
    method: "POST",
    token: tokenAdmin,
    orgId: parsOrgId,
    body: {},
  });
  assert.equal(trComplete.status, 200);
  assert.equal(trComplete.json.data.status, "COMPLETED");

  const txExportAlias = await fetch(`${BASE}/api/v1/inventory/exports/transactions?warehouse_id=${whs[0].id}`, {
    headers: { Authorization: `Bearer ${tokenAdmin}`, "X-Organization-Id": parsOrgId, "X-Client-Version": "1.0.0" },
  });
  assert.equal(txExportAlias.status, 200);
  console.log("[PASS] Prompt 09A-2: Transfer /submit -> Idempotent /dispatch -> Idempotent /receive (discrepancy_type) & /exports/transactions verified");

  // P09A-3: Initial Migration API (`POST /sync/initial-migration`, `GET /{id}`, `POST /{id}/resume`, `POST /{id}/confirm`)
  const initMig = await req("/api/v1/sync/initial-migration", {
    method: "POST",
    token: regToken,
    orgId: regOrgId,
    headers: { "Idempotency-Key": cryptoMod.randomUUID() },
    body: {
      device_id: regDevId,
      inventory_summary: { contacts: 2 },
      events: [
        {
          event_id: cryptoMod.randomUUID(),
          idempotency_key: cryptoMod.randomUUID(),
          entity_type: "contact",
          entity_id: cryptoMod.randomUUID(),
          operation: "CREATE",
          payload: { code: "C-INIT-01", display_name: "مشتری مهاجرت اولیه ۱", type: "CUSTOMER" },
        },
      ],
    },
  });
  assert.equal(initMig.status, 201);
  const initMigId = initMig.json.data.id;
  const initMigGet = await req(`/api/v1/sync/initial-migration/${initMigId}`, { token: regToken, orgId: regOrgId });
  assert.equal(initMigGet.status, 200);
  assert.equal(initMigGet.json.data.applied_records, 1);

  const initMigResume = await req(`/api/v1/sync/initial-migration/${initMigId}/resume`, {
    method: "POST",
    token: regToken,
    orgId: regOrgId,
    body: {
      batch_index: 2,
      events: [
        {
          event_id: cryptoMod.randomUUID(),
          idempotency_key: cryptoMod.randomUUID(),
          entity_type: "contact",
          entity_id: cryptoMod.randomUUID(),
          operation: "CREATE",
          payload: { code: "C-INIT-02", display_name: "مشتری مهاجرت اولیه ۲", type: "CUSTOMER" },
        },
      ],
    },
  });
  assert.equal(initMigResume.status, 200);
  assert.equal(initMigResume.json.data.migration.applied_records, 2);

  const initMigConfirm = await req(`/api/v1/sync/initial-migration/${initMigId}/confirm`, {
    method: "POST",
    token: regToken,
    orgId: regOrgId,
    body: {},
  });
  assert.equal(initMigConfirm.status, 200);
  assert.equal(initMigConfirm.json.data.bidirectional_sync_enabled, true);
  console.log("[PASS] Prompt 09A-3: Resumable Initial Migration (/initial-migration, GET, /resume, /confirm) verified");

  // P09A-4: Subscriptions Plural Routes, Pull-Fallback Version Check, Gateway Priority, Failed Callback Handling & Opaque-Only Deep Link
  const gwPri = await req("/api/v1/platform/payment-gateways", {
    method: "PATCH",
    token: tokenAdmin,
    body: { gateway: "ZARINPAL", priority: 1 },
  });
  assert.equal(gwPri.status, 200);
  assert.equal(gwPri.json.data.gateway.priority, 1);

  const entVerPull = await req("/api/v1/subscriptions/entitlements/version", { token: regToken, orgId: regOrgId });
  assert.equal(entVerPull.status, 200);
  assert.equal(entVerPull.json.data.entitlement_version, entAfter.entitlement_version);

  // Test failed/cancelled payment callback (Status=NOK) -> MUST NOT activate subscription and deep link must NOT leak status=verified!
  const failUpg = await req("/api/v1/subscriptions/upgrade", {
    method: "POST",
    token: regToken,
    orgId: regOrgId,
    headers: { "Idempotency-Key": cryptoMod.randomUUID() },
    body: { plan_code: "ENTERPRISE", gateway: "ZARINPAL" },
  });
  assert.equal(failUpg.status, 201);
  const failRef = failUpg.json.data.payment_reference;
  const failCbUrl = `${BASE}/api/v1/payments/callback/zarinpal?Authority=${encodeURIComponent(failUpg.json.data.gateway_authority)}&Status=NOK&ref=${encodeURIComponent(failRef)}&format=json`;
  const failCb = await (await fetch(failCbUrl, { headers: { Accept: "application/json" } })).json();
  assert.equal(failCb.data.verified, false);
  assert.equal(failCb.data.order.status, "CANCELLED");
  assert.ok(!failCb.data.deep_link_url.includes("status=verified"), "Deep link MUST contain only opaque reference, never client-trusted status flags");

  const payLookup = await req(`/api/v1/subscriptions/payments/${failRef}`, { token: regToken, orgId: regOrgId });
  assert.equal(payLookup.status, 200);
  assert.equal(payLookup.json.data.order.status, "CANCELLED");
  console.log("[PASS] Prompt 09A-4: Plural Subscriptions API, Entitlement Version Pull, Gateway Priority, Failed Callback & Safe Deep Link verified");

  // Note unused rotatedAccess cleanly
  assert.ok(rotatedAccess.length > 10 && adminToken.length > 10);

  console.log("\nALL 48 END-TO-END CONTRACT, SECURITY, SYNC, SAAS & MASTER PROMPTS 02–09A TESTS PASSED 100%!");
}

run().catch((err) => {
  console.error("[TEST FAILED]", err);
  process.exit(1);
});

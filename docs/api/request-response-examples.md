# Business OS — Request & Response Examples (Master Prompt 03 Contract)

## 1. Login (`POST /api/v1/auth/login`)
**Request**:
```json
{
  "mobile": "09121000001",
  "password": "Admin@1234",
  "device": {
    "device_id": "550e8400-e29b-41d4-a716-446655440000",
    "platform": "android",
    "app_version": "1.0.0",
    "device_name": "Samsung Galaxy S24"
  }
}
```
**Response (`200 OK`)**:
```json
{
  "success": true,
  "data": {
    "user": {
      "id": "uuid",
      "full_name": "امیرحسین رضایی",
      "email": "admin@businessos.ir",
      "mobile": "09121000001",
      "is_platform_admin": true
    },
    "access_token": "eyJhbGciOiJIUzI1NiIs...",
    "refresh_token": "raw_rotating_refresh_token",
    "expires_in": 7200,
    "token_type": "Bearer"
  },
  "meta": {
    "request_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
    "timestamp": "2026-11-13T12:00:00.000Z"
  }
}
```

## 2. Paginated Contacts (`GET /api/v1/contacts?page=1&per_page=20&search=افرا`)
**Response (`200 OK`)**:
```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "organization_id": "uuid",
      "code": "C-1001",
      "type": "CUSTOMER",
      "display_name": "فروشگاه دیجیتال افرا",
      "credit_limit": "250000000.00",
      "opening_balance": "0.00",
      "running_balance": "342000000.00",
      "is_active": true
    }
  ],
  "meta": {
    "pagination": { "page": 1, "per_page": 20, "total": 1, "last_page": 1 },
    "request_id": "uuid",
    "timestamp": "2026-11-13T12:00:00.000Z"
  }
}
```

## 3. Double-Entry Journal Entry (`POST /api/v1/accounting/journal-entries`)
**Request**:
```json
{
  "client_document_id": "a7b8c9d0-1234-4567-8901-abcdef123456",
  "document_date": "2025-08-15",
  "description": "ثبت هزینه اینترنت و زیرساخت ابری",
  "confirm_immediately": true,
  "lines": [
    { "account_id": "opex-uuid", "debit": "15000000.00", "credit": "0.00" },
    { "account_id": "bank-uuid", "debit": "0.00", "credit": "15000000.00" }
  ]
}
```

## 4. Validation / Domain Error (`422` / `409`)
```json
{
  "success": false,
  "error": {
    "code": "ACCOUNTING_UNBALANCED",
    "message": "سند تراز نیست! جمع بدهکار با جمع بستانکار برابر نیست.",
    "details": [],
    "request_id": "uuid"
  }
}
```

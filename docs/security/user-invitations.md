# Business OS — User Invitations, Organization Membership & Scoped Access Security

## 1. Single-Use Expiring Invitation Flow (`/api/v1/access/invitations`)
1. Authorized owner/admin (`users.invite`) creates an invitation specifying `email` or `mobile`, `role_code`, `branch_access[]`, `warehouse_access[]`, and `expires_in_hours`.
2. Server generates a cryptographically random single-use token (`inv_<32-char-base64url>`) stored uniquely in `user_invitations`.
3. Status starts as `PENDING` — **zero access is granted prior to acceptance**.
4. Invitee accepts via `POST /api/v1/access/invitations/accept` with `token` (plus password if creating a new account):
   - Validates token exists, `status == 'PENDING'`, and `expires_at > NOW()`.
   - Creates/links global user account, creates `organization_members` (`ACTIVE`) with scoped branch/warehouse arrays, assigns `user_roles`, and transitions invitation to `ACCEPTED` (single-use).
5. Resend regenerates token & extends expiry; Revoke transitions to `REVOKED` immediately.

## 2. Membership Lifecycle & Session Revocation (`/api/v1/access/members`)
- **Suspend Member**: Sets `organization_members.status = 'SUSPENDED'` AND immediately revokes all active `sessions` for that user so stale JWTs fail immediately on the next request (`401 SESSION_REVOKED` / `403`).
- **Remove Membership (`DELETE`)**: Removes `organization_members` & org-scoped `user_roles` and revokes sessions WITHOUT deleting the user's global `users` account.
- **Personal Finance Boundary**: No employee role (`SALESPERSON`, `WAREHOUSE_MGR`, `ACCOUNTANT`) receives `personal_finance.view` or `personal_finance.manage`.
- **Audit Trail**: Every invitation create/accept/revoke, role change, suspend/reactivate, session revoke, and membership removal is recorded in `audit_logs` under `scope = 'SECURITY'`.

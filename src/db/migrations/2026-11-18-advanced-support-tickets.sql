-- Advanced customer and platform support workflow. Safe to apply repeatedly.
CREATE TABLE IF NOT EXISTS support_ticket_departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar(48) NOT NULL,
  name varchar(100) NOT NULL,
  description varchar(300),
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_support_ticket_departments_code ON support_ticket_departments (code);
CREATE INDEX IF NOT EXISTS idx_support_ticket_departments_active_order ON support_ticket_departments (is_active, sort_order);

ALTER TABLE support_tickets
  ADD COLUMN IF NOT EXISTS department_id uuid REFERENCES support_ticket_departments(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS assigned_to_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS last_activity_at timestamptz,
  ADD COLUMN IF NOT EXISTS closed_at timestamptz;

UPDATE support_tickets
SET last_activity_at = COALESCE(updated_at, created_at, now())
WHERE last_activity_at IS NULL;
ALTER TABLE support_tickets
  ALTER COLUMN last_activity_at SET DEFAULT now(),
  ALTER COLUMN last_activity_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_support_tickets_org_activity ON support_tickets (organization_id, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status_activity ON support_tickets (status, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_tickets_department_activity ON support_tickets (department_id, last_activity_at DESC);

CREATE TABLE IF NOT EXISTS support_ticket_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  ticket_id uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  sender_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  sender_type varchar(16) NOT NULL CHECK (sender_type IN ('CUSTOMER', 'ADMIN')),
  sender_name varchar(200) NOT NULL,
  body text NOT NULL,
  is_internal boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_support_ticket_messages_ticket_created ON support_ticket_messages (ticket_id, created_at);

CREATE TABLE IF NOT EXISTS support_ticket_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  ticket_id uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_name varchar(200) NOT NULL,
  event_type varchar(48) NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_support_ticket_events_ticket_created ON support_ticket_events (ticket_id, created_at);

-- Keep the tenant key on child records so PostgreSQL RLS can isolate every thread row.
UPDATE support_ticket_messages AS message
SET organization_id = ticket.organization_id
FROM support_tickets AS ticket
WHERE message.ticket_id = ticket.id AND message.organization_id IS DISTINCT FROM ticket.organization_id;
UPDATE support_ticket_events AS event
SET organization_id = ticket.organization_id
FROM support_tickets AS ticket
WHERE event.ticket_id = ticket.id AND event.organization_id IS DISTINCT FROM ticket.organization_id;

-- Preserve the original ticket description as the first public message for legacy tickets.
INSERT INTO support_ticket_messages (organization_id, ticket_id, sender_user_id, sender_type, sender_name, body, is_internal, created_at)
SELECT ticket.organization_id, ticket.id, ticket.user_id, 'CUSTOMER',
       COALESCE(customer.full_name, customer.email, 'کاربر'), ticket.description, false, ticket.created_at
FROM support_tickets AS ticket
LEFT JOIN users AS customer ON customer.id = ticket.user_id
WHERE NOT EXISTS (
  SELECT 1 FROM support_ticket_messages AS message WHERE message.ticket_id = ticket.id
);

INSERT INTO support_ticket_events (organization_id, ticket_id, actor_user_id, actor_name, event_type, details, created_at)
SELECT ticket.organization_id, ticket.id, ticket.user_id,
       COALESCE(customer.full_name, customer.email, 'کاربر'), 'CREATED',
       jsonb_build_object('legacy', true), ticket.created_at
FROM support_tickets AS ticket
LEFT JOIN users AS customer ON customer.id = ticket.user_id
WHERE NOT EXISTS (
  SELECT 1 FROM support_ticket_events AS event WHERE event.ticket_id = ticket.id
);

INSERT INTO support_ticket_departments (code, name, description, sort_order) VALUES
  ('GENERAL', 'پشتیبانی عمومی', 'راهنمایی عمومی و پیگیری درخواست‌ها', 10),
  ('ORDERS', 'سفارش‌ها و اسناد', 'فاکتور، خرید، فروش و سفارش‌ها', 20),
  ('ACCOUNTING', 'مالی و حسابداری', 'دفترکل، خزانه، چک و گزارش‌ها', 30),
  ('INVENTORY', 'انبار و کالا', 'کالا، موجودی، رسید و حواله', 40),
  ('TECHNICAL', 'فنی و همگام‌سازی', 'ورود، آفلاین، اتصال و همگام‌سازی', 50),
  ('SUBSCRIPTION', 'اشتراک و پرداخت', 'پلن، تمدید و پرداخت', 60)
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, sort_order = EXCLUDED.sort_order, is_active = true;

-- Keep the ticket records tenant-isolated while allowing verified platform admins
-- to operate across tenants through `withPlatformTransaction`.
DO $$
DECLARE
  tbl TEXT;
  ticket_tables TEXT[] := ARRAY['support_tickets', 'support_ticket_messages', 'support_ticket_events'];
BEGIN
  FOREACH tbl IN ARRAY ticket_tables
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', tbl);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_policy ON %I;', tbl);
    EXECUTE format(
      'CREATE POLICY tenant_isolation_policy ON %I USING (
         current_setting(''app.bypass_rls'', true) = ''on''
         OR organization_id::text = current_setting(''app.current_org_id'', true)
       ) WITH CHECK (
         current_setting(''app.bypass_rls'', true) = ''on''
         OR organization_id::text = current_setting(''app.current_org_id'', true)
       );',
      tbl
    );
  END LOOP;
END $$;

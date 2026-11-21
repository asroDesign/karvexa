-- Persist customer profile fields used by the Android CRM and web workspace.
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS birth_date_epoch bigint,
  ADD COLUMN IF NOT EXISTS gender varchar(20) NOT NULL DEFAULT 'UNSPECIFIED',
  ADD COLUMN IF NOT EXISTS customer_tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS awareness_source varchar(80),
  ADD COLUMN IF NOT EXISTS marketing_consent boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS province varchar(80),
  ADD COLUMN IF NOT EXISTS city varchar(80),
  ADD COLUMN IF NOT EXISTS branch_local_id varchar(36),
  ADD COLUMN IF NOT EXISTS membership_date_epoch bigint,
  ADD COLUMN IF NOT EXISTS customer_segment varchar(32) NOT NULL DEFAULT 'REGULAR';

CREATE TABLE IF NOT EXISTS loyalty_membership_tiers (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name varchar(80) NOT NULL,
  minimum_points numeric(18, 2) NOT NULL DEFAULT 0.00,
  color_hex varchar(7) NOT NULL DEFAULT '#78909C',
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  sync_seq bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_loyalty_tier_org_name UNIQUE (organization_id, name)
);

CREATE INDEX IF NOT EXISTS idx_loyalty_tier_org_sync
  ON loyalty_membership_tiers (organization_id, sync_seq);

CREATE TABLE IF NOT EXISTS loyalty_program_settings (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  purchase_amount_per_point numeric(18, 2) NOT NULL DEFAULT 1000000.00,
  version integer NOT NULL DEFAULT 1,
  sync_seq bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_loyalty_program_settings_org_sync
  ON loyalty_program_settings (organization_id, sync_seq);

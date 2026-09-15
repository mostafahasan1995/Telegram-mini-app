-- Staff link their Telegram account with a one-time code (owner decision 4, 2026-09-15): the console
-- shows a short code, the staff member sends `/link <code>` to the operator's bot in a private chat,
-- and the sender's Telegram id is stored on that staff account. It is the only way
-- `admin_users.telegram_user_id` is set; the staff directory still refuses the field.
--
-- One new tenant-scoped table, holding an HMAC digest of each code and never the code.
--
-- Safe on a populated database:
--  - the table is new (CREATE TABLE IF NOT EXISTS), so no existing row is read, rewritten or locked
--    beyond the brief locks the two foreign keys take on `tenants` and `admin_users`;
--  - nothing existing changes: `admin_users.telegram_user_id` keeps its type, its nullability, its
--    per-operator unique index and every value it holds.
CREATE TABLE IF NOT EXISTS "admin_telegram_link_codes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "admin_user_id" UUID NOT NULL,
    "code_digest" VARCHAR(64) NOT NULL,
    "issued_by_admin_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "used_by_telegram_user_id" BIGINT,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_telegram_link_codes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "admin_telegram_link_codes_code_digest_key"
  ON "admin_telegram_link_codes"("code_digest");
CREATE INDEX IF NOT EXISTS "admin_telegram_link_codes_tenant_id_admin_user_id_created_at_idx"
  ON "admin_telegram_link_codes"("tenant_id", "admin_user_id", "created_at");
CREATE INDEX IF NOT EXISTS "admin_telegram_link_codes_tenant_id_idx"
  ON "admin_telegram_link_codes"("tenant_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'admin_telegram_link_codes_admin_user_id_fkey'
  ) THEN
    ALTER TABLE "admin_telegram_link_codes"
      ADD CONSTRAINT "admin_telegram_link_codes_admin_user_id_fkey"
      FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'admin_telegram_link_codes_tenant_id_fkey'
  ) THEN
    ALTER TABLE "admin_telegram_link_codes"
      ADD CONSTRAINT "admin_telegram_link_codes_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

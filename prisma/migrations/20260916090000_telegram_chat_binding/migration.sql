-- The staff and feed group of an operator are bound from Telegram itself (owner decisions,
-- 2026-09-15): an operator is created with no staff group and stays SUSPENDED until one is bound,
-- through a one-time "Add bot to staff group" link or by picking a group the bot was seen in.
--
-- Two new tenant-scoped tables and three enums:
--  - telegram_discovered_chats: every group or channel an operator's bot was seen in, from
--    my_chat_member, because Telegram volunteers a private group's id only in an update;
--  - telegram_chat_bind_links: the one-time links, holding a sha256 of the nonce and never the nonce.
--
-- Safe on a populated database:
--  - every enum is created only when missing;
--  - both tables are new (CREATE TABLE IF NOT EXISTS), so no existing row is read, rewritten or locked
--    beyond the brief lock a foreign key to `tenants` takes;
--  - nothing existing changes: `tenants.admin_chat_id` keeps its NOT NULL and its 0 "not configured"
--    value, which is exactly what an operator with no staff group holds.
DO $$
BEGIN
  CREATE TYPE "telegram_chat_type" AS ENUM ('GROUP', 'SUPERGROUP', 'CHANNEL');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "telegram_bot_chat_status" AS ENUM (
    'CREATOR', 'ADMINISTRATOR', 'MEMBER', 'RESTRICTED', 'LEFT', 'KICKED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "telegram_chat_purpose" AS ENUM ('STAFF', 'FEED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "telegram_discovered_chats" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "chat_id" BIGINT NOT NULL,
    "chat_type" "telegram_chat_type" NOT NULL,
    "title" TEXT,
    "username" TEXT,
    "status" "telegram_bot_chat_status" NOT NULL,
    "is_administrator" BOOLEAN NOT NULL,
    "is_present" BOOLEAN NOT NULL,
    "can_post" BOOLEAN NOT NULL,
    "last_changed_by_telegram_user_id" BIGINT,
    "last_changed_by_username" TEXT,
    "migrated_to_chat_id" BIGINT,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "telegram_discovered_chats_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "telegram_discovered_chats_tenant_id_chat_id_key"
  ON "telegram_discovered_chats"("tenant_id", "chat_id");
CREATE INDEX IF NOT EXISTS "telegram_discovered_chats_tenant_id_last_seen_at_idx"
  ON "telegram_discovered_chats"("tenant_id", "last_seen_at");
CREATE INDEX IF NOT EXISTS "telegram_discovered_chats_tenant_id_idx"
  ON "telegram_discovered_chats"("tenant_id");

CREATE TABLE IF NOT EXISTS "telegram_chat_bind_links" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "purpose" "telegram_chat_purpose" NOT NULL,
    "nonce_hash" VARCHAR(64) NOT NULL,
    "issued_by_admin_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "used_chat_id" BIGINT,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telegram_chat_bind_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "telegram_chat_bind_links_nonce_hash_key"
  ON "telegram_chat_bind_links"("nonce_hash");
CREATE INDEX IF NOT EXISTS "telegram_chat_bind_links_tenant_id_purpose_created_at_idx"
  ON "telegram_chat_bind_links"("tenant_id", "purpose", "created_at");
CREATE INDEX IF NOT EXISTS "telegram_chat_bind_links_tenant_id_idx"
  ON "telegram_chat_bind_links"("tenant_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'telegram_discovered_chats_tenant_id_fkey'
  ) THEN
    ALTER TABLE "telegram_discovered_chats"
      ADD CONSTRAINT "telegram_discovered_chats_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'telegram_chat_bind_links_tenant_id_fkey'
  ) THEN
    ALTER TABLE "telegram_chat_bind_links"
      ADD CONSTRAINT "telegram_chat_bind_links_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

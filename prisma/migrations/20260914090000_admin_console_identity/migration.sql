-- =============================================================================
-- ADMIN CONSOLE IDENTITY
--
-- A console admin is a username and a password. A Telegram id is optional: it is what lets an
-- existing row keep working the bot, and it is no longer how an HTTP request identifies anybody
-- (admin access tokens carry tid + sub = admin_users.id).
--
-- SAFE ON A POPULATED DATABASE. Both statements only RELAX or NORMALISE existing data:
--
--   1. DROP NOT NULL is a catalog change. No row is rewritten, and every existing row keeps its
--      Telegram id. The unique index admin_users_tenant_id_telegram_user_id_key stays exactly as
--      it is: a plain (NULLS DISTINCT) unique index lets any number of NULLs coexist in one tenant,
--      and `telegram_user_id = <any value>` is never true for a NULL, so a console-only row can
--      never answer a Telegram lookup. Do NOT recreate that index with NULLS NOT DISTINCT — it
--      would allow exactly one console-only admin per operator.
--
--   2. Usernames are lower-cased on write from now on, so an existing mixed-case username would
--      never be found by a sign-in that lower-cases what was typed. They are normalised here —
--      except where two rows in one tenant differ only by case, which lower-casing would turn into
--      a unique violation that aborts the whole migration. Those (expected: none) are left as they
--      are for an operator to rename; nothing else depends on them.
--
-- password_hash already exists (TEXT, nullable) since the init migration, so no column is added.
-- prisma/sql/002 and 006 do not reference telegram_user_id or username, so neither needs changing.
-- =============================================================================

ALTER TABLE "admin_users" ALTER COLUMN "telegram_user_id" DROP NOT NULL;

UPDATE "admin_users" AS a
SET "username" = lower(a."username")
WHERE a."username" IS NOT NULL
  AND a."username" <> lower(a."username")
  AND NOT EXISTS (
    SELECT 1
    FROM "admin_users" AS other
    WHERE other."tenant_id" = a."tenant_id"
      AND other."id" <> a."id"
      AND lower(other."username") = lower(a."username")
  );

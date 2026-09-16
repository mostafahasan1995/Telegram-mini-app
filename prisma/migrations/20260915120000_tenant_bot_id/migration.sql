-- One Telegram bot belongs to at most one operator. Telegram keeps exactly one webhook URL per bot,
-- so a bot attached to two operators delivers to whichever registered last: the other goes silent,
-- and once both are ACTIVE its players are served in the wrong operator's books. The platform routes
-- (create, replace bot) refuse a bot another operator holds; this index is what makes two requests
-- racing with the same token collide instead of both landing.
--
-- The bot id is the public number a token starts with (and getMe's `id`). The token itself is sealed
-- with a random IV, so no index can be put on `bot_token_enc`.
--
-- Safe on a populated database: one nullable column with no default (no table rewrite), then a
-- unique index over values that are all NULL, which Postgres does not compare. Existing rows are
-- NOT backfilled: their tokens are sealed and cannot be opened in SQL. The application checks those
-- rows by opening their tokens until each is written again by a create or a bot replace.
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "bot_id" BIGINT;

CREATE UNIQUE INDEX IF NOT EXISTS "tenants_bot_id_key" ON "tenants"("bot_id");

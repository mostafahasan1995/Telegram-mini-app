-- Players that were never a Telegram account (dashboard API-CONTRACT.md, "Players that were never a
-- Telegram account"). The import of an operator's existing Ichancy players writes rows that have an
-- Ichancy id and login but no Telegram id, so `telegram_user_id` becomes nullable and every row says
-- which door it came in through.
--
-- Safe on a populated database:
--  - the enum is created only when missing;
--  - ADD COLUMN with a constant default is a catalogue change on Postgres 11+, not a table rewrite,
--    and every existing row reads 'TELEGRAM', which is what each of them is;
--  - DROP NOT NULL only relaxes a constraint and touches no row. The unique index on
--    (tenant_id, telegram_user_id) stays as it is: Postgres does not compare NULLs in a unique
--    index, so any number of imported rows can coexist while a Telegram id still belongs to one
--    player per operator.
DO $$
BEGIN
  CREATE TYPE "player_source" AS ENUM ('TELEGRAM', 'ICHANCY_IMPORT', 'ADMIN');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "players" ADD COLUMN IF NOT EXISTS "source" "player_source" NOT NULL DEFAULT 'TELEGRAM';

ALTER TABLE "players" ALTER COLUMN "telegram_user_id" DROP NOT NULL;

-- Bookkeeping for the worker-only registration backfill (PlayerLinkBackfillService).
--
-- WHY: on 2026-08-20 a Cloudflare outage left a player at PENDING_ICHANCY with a NULL
-- ichancy_player_id for nineteen hours, because nothing in this system ever retries a failed
-- registration. The backfill that fixes that needs durable per-player backoff: a Redis-only counter
-- is lost on restart, which means re-hammering rows Ichancy has permanently refused and driving the
-- IP's Cloudflare trust score further down — the exact mechanism that turned twenty minutes of
-- failure into hours.
--
-- Every column is nullable or defaulted, so no existing INSERT or UPDATE path has to change.
ALTER TABLE "players"
  ADD COLUMN "ichancy_link_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "ichancy_link_last_attempt_at" TIMESTAMPTZ(6),
  ADD COLUMN "ichancy_link_next_attempt_at" TIMESTAMPTZ(6),
  ADD COLUMN "ichancy_link_last_error" TEXT;

-- The backfill's selector: PENDING_ICHANCY rows whose next attempt is due.
CREATE INDEX "players_status_ichancy_link_next_attempt_at_idx"
  ON "players" ("status", "ichancy_link_next_attempt_at");

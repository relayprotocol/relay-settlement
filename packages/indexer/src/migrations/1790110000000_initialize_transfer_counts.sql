-- Up Migration
-- Pause ingestion, retries and admin/CLI replays before this migration, and
-- replace every old writer before resuming. Old recounts can overwrite increments.
LOCK TABLE events, tokens IN SHARE ROW EXCLUSIVE MODE;
UPDATE tokens SET transfers = 0;
UPDATE tokens SET transfers = counts.transfers
FROM (
  SELECT token_id, COUNT(*)::int AS transfers FROM events GROUP BY token_id
) counts WHERE tokens.token_id = counts.token_id;

-- Down Migration
-- Keep the accurate baseline when rolling back application code.
SELECT 1;

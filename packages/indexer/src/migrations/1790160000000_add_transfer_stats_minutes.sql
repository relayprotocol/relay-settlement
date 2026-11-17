-- Up Migration
CREATE TABLE transfer_stats_minutes (
  token_id TEXT NOT NULL,
  minute_start BIGINT NOT NULL CHECK (minute_start % 60 = 0),
  transfers BIGINT NOT NULL CHECK (transfers >= 0),
  PRIMARY KEY (token_id, minute_start)
);
CREATE INDEX idx_transfer_stats_minutes_start ON transfer_stats_minutes (minute_start);

-- Populated only by the explicit backfill, after all event writers are updated.
CREATE TABLE transfer_stats_backfill (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  next_timestamp BIGINT NOT NULL,
  end_timestamp BIGINT NOT NULL,
  after_minute BIGINT,
  after_token_id TEXT,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Down Migration
DROP TABLE transfer_stats_backfill;
DROP TABLE transfer_stats_minutes;

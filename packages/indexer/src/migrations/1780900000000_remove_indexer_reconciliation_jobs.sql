-- Up Migration
DROP TABLE IF EXISTS "indexer_reconciliation_jobs";

-- Down Migration
CREATE TABLE "indexer_reconciliation_jobs" (
  "id" BIGSERIAL PRIMARY KEY,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "source_audit_run_id" BIGINT REFERENCES "indexer_audit_runs"("id") ON DELETE SET NULL,
  "token_id" TEXT NOT NULL,
  "address" TEXT NOT NULL,
  "source_latest_event_block" BIGINT,
  "source_indexed_balance" NUMERIC(78,0),
  "source_chain_balance" NUMERIC(78,0),
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "last_error" TEXT,
  "started_at" TIMESTAMPTZ,
  "completed_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "indexer_reconciliation_jobs_kind_token_address_unique"
    UNIQUE ("kind", "token_id", "address")
);

CREATE INDEX "idx_indexer_reconciliation_jobs_status"
  ON "indexer_reconciliation_jobs" ("status", "updated_at", "id");
CREATE INDEX "idx_indexer_reconciliation_jobs_audit_run"
  ON "indexer_reconciliation_jobs" ("source_audit_run_id");

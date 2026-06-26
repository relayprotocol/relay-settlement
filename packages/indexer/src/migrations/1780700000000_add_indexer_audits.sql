-- Up Migration
CREATE TABLE "indexer_audit_runs" (
  "id" BIGSERIAL PRIMARY KEY,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "started_at" TIMESTAMPTZ NOT NULL,
  "completed_at" TIMESTAMPTZ,
  "audit_block" BIGINT,
  "latest_chain_block" BIGINT,
  "checked_count" INTEGER NOT NULL DEFAULT 0,
  "confirmed_count" INTEGER NOT NULL DEFAULT 0,
  "pending_count" INTEGER NOT NULL DEFAULT 0,
  "error" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE "indexer_audit_findings" (
  "id" BIGSERIAL PRIMARY KEY,
  "run_id" BIGINT NOT NULL REFERENCES "indexer_audit_runs"("id") ON DELETE CASCADE,
  "kind" TEXT NOT NULL,
  "classification" TEXT NOT NULL,
  "token_id" TEXT,
  "token_name" TEXT,
  "address" TEXT,
  "indexed_balance" NUMERIC(78,0),
  "chain_balance" NUMERIC(78,0),
  "latest_event_block" BIGINT,
  "block_number" BIGINT,
  "tx_hash" TEXT,
  "log_index" INTEGER,
  "details_json" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX "idx_indexer_audit_runs_kind_completed"
  ON "indexer_audit_runs" ("kind", "completed_at" DESC, "id" DESC);
CREATE INDEX "idx_indexer_audit_runs_status"
  ON "indexer_audit_runs" ("status", "started_at" DESC);
CREATE INDEX "idx_indexer_audit_findings_run"
  ON "indexer_audit_findings" ("run_id");
CREATE INDEX "idx_indexer_audit_findings_kind_classification"
  ON "indexer_audit_findings" ("kind", "classification");
CREATE INDEX "idx_indexer_audit_findings_token_address"
  ON "indexer_audit_findings" ("token_id", "address");

-- Down Migration
DROP TABLE IF EXISTS "indexer_audit_findings";
DROP TABLE IF EXISTS "indexer_audit_runs";

-- Up Migration
CREATE TABLE "events" (
  "id" BIGSERIAL PRIMARY KEY,
  "block_number" BIGINT NOT NULL,
  "tx_hash" TEXT NOT NULL,
  "log_index" INTEGER NOT NULL,
  "operator" TEXT NOT NULL,
  "from_addr" TEXT NOT NULL,
  "to_addr" TEXT NOT NULL,
  "token_id" TEXT NOT NULL,
  "amount" NUMERIC(78,0) NOT NULL,
  "timestamp" BIGINT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "events_tx_hash_log_index_unique" UNIQUE ("tx_hash", "log_index")
);

CREATE TABLE "balances" (
  "address" TEXT NOT NULL,
  "token_id" TEXT NOT NULL,
  "balance" NUMERIC(78,0) NOT NULL,
  "balance_scaled" DOUBLE PRECISION,
  "last_transfer_at" BIGINT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("address", "token_id")
);

CREATE TABLE "tokens" (
  "token_id" TEXT PRIMARY KEY,
  "name" TEXT,
  "symbol" TEXT,
  "decimals" INTEGER,
  "total_supply" NUMERIC(78,0) NOT NULL,
  "holders" INTEGER NOT NULL DEFAULT 0,
  "transfers" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE "meta" (
  "key" TEXT PRIMARY KEY,
  "value" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE "failed_events" (
  "id" BIGSERIAL PRIMARY KEY,
  "contract_address" TEXT NOT NULL,
  "block_number" BIGINT NOT NULL,
  "tx_hash" TEXT NOT NULL,
  "log_index" INTEGER NOT NULL,
  "data" TEXT NOT NULL,
  "error" TEXT NOT NULL,
  "retry_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "failed_events_contract_block_log_tx_unique"
    UNIQUE ("contract_address", "block_number", "log_index", "tx_hash")
);

CREATE TABLE "role_events" (
  "id" BIGSERIAL PRIMARY KEY,
  "contract_address" TEXT NOT NULL,
  "block_number" BIGINT NOT NULL,
  "tx_hash" TEXT NOT NULL,
  "log_index" INTEGER NOT NULL,
  "event_type" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "account" TEXT,
  "sender" TEXT,
  "previous_admin_role" TEXT,
  "new_admin_role" TEXT,
  "timestamp" BIGINT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "role_events_contract_tx_log_unique"
    UNIQUE ("contract_address", "tx_hash", "log_index")
);

CREATE TABLE "role_members" (
  "contract_address" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "account" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("contract_address", "role", "account")
);

CREATE TABLE "role_admins" (
  "contract_address" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "admin_role" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("contract_address", "role")
);

CREATE TABLE "oracle_executions" (
  "tx_hash" TEXT NOT NULL,
  "block_number" BIGINT NOT NULL,
  "log_index" INTEGER NOT NULL,
  "timestamp" BIGINT NOT NULL,
  "oracle_contract_address" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "actions_json" TEXT NOT NULL,
  "submitted_oracle_address" TEXT,
  "aggregated_signature" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("tx_hash", "log_index")
);

CREATE INDEX "idx_events_token_id" ON "events" ("token_id");
CREATE INDEX "idx_events_address" ON "events" ("from_addr", "to_addr");
CREATE INDEX "idx_events_block_order" ON "events" ("block_number" DESC, "log_index" DESC);
CREATE INDEX "idx_events_token_block" ON "events" ("token_id", "block_number" DESC, "log_index" DESC);
CREATE INDEX "idx_events_from_block" ON "events" ("from_addr", "block_number" DESC, "log_index" DESC);
CREATE INDEX "idx_events_to_block" ON "events" ("to_addr", "block_number" DESC, "log_index" DESC);
CREATE INDEX "idx_events_timestamp" ON "events" ("timestamp");
CREATE INDEX "idx_events_token_timestamp" ON "events" ("token_id", "timestamp");
CREATE INDEX "idx_balances_token_id" ON "balances" ("token_id");
CREATE INDEX "idx_balances_token_scaled" ON "balances" ("token_id", "balance_scaled" DESC);
CREATE INDEX "idx_balances_address" ON "balances" ("address");
CREATE INDEX "idx_balances_address_last_transfer" ON "balances" ("address", "last_transfer_at" DESC);
CREATE INDEX "idx_tokens_name" ON "tokens" (LOWER("name"));
CREATE INDEX "idx_role_events_contract_block" ON "role_events" ("contract_address", "block_number" DESC, "log_index" DESC);
CREATE INDEX "idx_role_events_contract_role" ON "role_events" ("contract_address", "role");
CREATE INDEX "idx_role_events_contract_account" ON "role_events" ("contract_address", "account");
CREATE INDEX "idx_role_members_contract_role" ON "role_members" ("contract_address", "role");
CREATE INDEX "idx_role_members_contract_account" ON "role_members" ("contract_address", "account");
CREATE INDEX "idx_role_admins_contract_role" ON "role_admins" ("contract_address", "role");
CREATE INDEX "idx_oracle_executions_tx_hash" ON "oracle_executions" ("tx_hash");
CREATE INDEX "idx_oracle_executions_idempotency_key" ON "oracle_executions" ("idempotency_key");

-- Down Migration
DROP TABLE IF EXISTS "oracle_executions";
DROP TABLE IF EXISTS "role_admins";
DROP TABLE IF EXISTS "role_members";
DROP TABLE IF EXISTS "role_events";
DROP TABLE IF EXISTS "failed_events";
DROP TABLE IF EXISTS "meta";
DROP TABLE IF EXISTS "tokens";
DROP TABLE IF EXISTS "balances";
DROP TABLE IF EXISTS "events";

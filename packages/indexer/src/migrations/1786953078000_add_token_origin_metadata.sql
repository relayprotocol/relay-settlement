-- Up Migration
ALTER TABLE "tokens"
  ADD COLUMN "origin_family" TEXT,
  ADD COLUMN "origin_chain_id" TEXT,
  ADD COLUMN "origin_asset" TEXT;

-- Down Migration
ALTER TABLE "tokens"
  DROP COLUMN IF EXISTS "origin_asset",
  DROP COLUMN IF EXISTS "origin_chain_id",
  DROP COLUMN IF EXISTS "origin_family";

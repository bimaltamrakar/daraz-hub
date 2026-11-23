-- Order Management fields: normalized status group, totals, and resumable order backfill.
ALTER TABLE "StoreOrder"
  ADD COLUMN "statusGroup" TEXT,
  ADD COLUMN "amount" DECIMAL(14, 2),
  ADD COLUMN "itemCount" INTEGER;

ALTER TABLE "Store"
  ADD COLUMN "orderBackfillCursor" TIMESTAMP(3),
  ADD COLUMN "orderBackfillDone" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "StoreOrder_storeId_statusGroup_idx" ON "StoreOrder"("storeId", "statusGroup");

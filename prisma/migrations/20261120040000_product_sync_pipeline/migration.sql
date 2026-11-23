-- Standalone, resumable product catalog sync for normal sellers.
ALTER TABLE "Store"
  ADD COLUMN "productSyncNextAt" TIMESTAMP(3),
  ADD COLUMN "productSyncOffset" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "productSyncLockId" TEXT,
  ADD COLUMN "productSyncLockUntil" TIMESTAMP(3),
  ADD COLUMN "productSyncError" TEXT;

CREATE INDEX "Store_productSyncNextAt_idx" ON "Store"("productSyncNextAt");

-- Queue an initial catalog pass for already-connected normal sellers.
UPDATE "Store"
SET "productSyncNextAt" = CURRENT_TIMESTAMP
WHERE "storeType" <> 'choice' AND EXISTS (SELECT 1 FROM "StoreToken" WHERE "StoreToken"."storeId" = "Store"."id");

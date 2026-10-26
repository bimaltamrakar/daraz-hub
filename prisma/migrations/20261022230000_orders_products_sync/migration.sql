CREATE TYPE "OrderSyncFrequency" AS ENUM ('manual', 'every_15_minutes', 'hourly', 'every_6_hours', 'daily');

ALTER TABLE "Store"
ADD COLUMN "orderSyncFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN "orderSyncFrequency" "OrderSyncFrequency" NOT NULL DEFAULT 'hourly',
ADD COLUMN "orderSyncLastAt" TIMESTAMP(3),
ADD COLUMN "productSyncLastAt" TIMESTAMP(3),
ADD COLUMN "orderSyncNextAt" TIMESTAMP(3),
ADD COLUMN "orderSyncLockId" TEXT,
ADD COLUMN "orderSyncLockUntil" TIMESTAMP(3),
ADD COLUMN "orderSyncError" TEXT;

UPDATE "Store"
SET "orderSyncNextAt" = CURRENT_TIMESTAMP
WHERE EXISTS (SELECT 1 FROM "StoreToken" WHERE "StoreToken"."storeId" = "Store"."id");

CREATE INDEX "Store_orderSyncNextAt_idx" ON "Store"("orderSyncNextAt");

CREATE TABLE "StoreOrder" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "darazOrderId" TEXT NOT NULL,
    "customerName" TEXT,
    "orderCreatedAt" TIMESTAMP(3) NOT NULL,
    "orderUpdatedAt" TIMESTAMP(3),
    "orderStatus" TEXT,
    "deliveryStatus" TEXT,
    "trackingNumber" TEXT,
    "rawDetails" JSONB NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StoreOrder_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProductMaster" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "darazItemId" TEXT NOT NULL,
    "sellerSku" TEXT,
    "name" TEXT,
    "status" TEXT,
    "rawDetails" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProductMaster_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StoreOrder_storeId_darazOrderId_key" ON "StoreOrder"("storeId", "darazOrderId");
CREATE INDEX "StoreOrder_storeId_orderCreatedAt_idx" ON "StoreOrder"("storeId", "orderCreatedAt");
CREATE INDEX "StoreOrder_storeId_orderUpdatedAt_idx" ON "StoreOrder"("storeId", "orderUpdatedAt");
CREATE INDEX "StoreOrder_orderStatus_idx" ON "StoreOrder"("orderStatus");
CREATE INDEX "StoreOrder_deliveryStatus_idx" ON "StoreOrder"("deliveryStatus");
CREATE UNIQUE INDEX "ProductMaster_storeId_darazItemId_key" ON "ProductMaster"("storeId", "darazItemId");
CREATE INDEX "ProductMaster_storeId_sellerSku_idx" ON "ProductMaster"("storeId", "sellerSku");
CREATE INDEX "ProductMaster_storeId_name_idx" ON "ProductMaster"("storeId", "name");

ALTER TABLE "StoreOrder" ADD CONSTRAINT "StoreOrder_storeId_fkey"
FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductMaster" ADD CONSTRAINT "ProductMaster_storeId_fkey"
FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

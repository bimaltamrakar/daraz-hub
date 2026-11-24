-- Order change history recorded when refreshing order details from Daraz.
CREATE TABLE "OrderChangeLog" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "storeId" TEXT NOT NULL,
  "field" TEXT NOT NULL,
  "oldValue" TEXT,
  "newValue" TEXT,
  "changedById" TEXT,
  "changedByName" TEXT,
  "source" TEXT NOT NULL DEFAULT 'daraz_refresh',
  "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderChangeLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OrderChangeLog_orderId_changedAt_idx" ON "OrderChangeLog"("orderId", "changedAt");
CREATE INDEX "OrderChangeLog_storeId_changedAt_idx" ON "OrderChangeLog"("storeId", "changedAt");

ALTER TABLE "OrderChangeLog" ADD CONSTRAINT "OrderChangeLog_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "StoreOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

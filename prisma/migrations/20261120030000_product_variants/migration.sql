-- Product catalog: pricing, stock, images, and variants per store.
ALTER TABLE "StoreOrder" ADD COLUMN "itemsSyncedAt" TIMESTAMP(3);

ALTER TABLE "ProductMaster"
  ADD COLUMN "brand" TEXT,
  ADD COLUMN "imageUrl" TEXT,
  ADD COLUMN "price" DECIMAL(14, 2),
  ADD COLUMN "specialPrice" DECIMAL(14, 2),
  ADD COLUMN "quantity" INTEGER,
  ADD COLUMN "variation" JSONB,
  ADD COLUMN "syncedFrom" TEXT;

CREATE TABLE "ProductVariant" (
  "id" TEXT NOT NULL,
  "storeId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "sku" TEXT NOT NULL,
  "darazSkuId" TEXT,
  "name" TEXT,
  "color" TEXT,
  "size" TEXT,
  "price" DECIMAL(14, 2),
  "specialPrice" DECIMAL(14, 2),
  "quantity" INTEGER,
  "status" TEXT,
  "imageUrl" TEXT,
  "rawDetails" JSONB,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProductVariant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProductVariant_storeId_sku_key" ON "ProductVariant"("storeId", "sku");
CREATE INDEX "ProductVariant_productId_idx" ON "ProductVariant"("productId");

ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "ProductMaster"("id") ON DELETE CASCADE ON UPDATE CASCADE;

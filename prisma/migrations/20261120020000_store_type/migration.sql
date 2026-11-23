-- Seller type: normal sellers print AWB labels; Choice sellers are fulfilled by Daraz.
CREATE TYPE "StoreType" AS ENUM ('normal', 'choice');
ALTER TABLE "Store" ADD COLUMN "storeType" "StoreType" NOT NULL DEFAULT 'normal';

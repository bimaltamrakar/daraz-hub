-- Active/inactive stores: inactive stores are hidden from lists, reports and syncs.
ALTER TABLE "Store" ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;

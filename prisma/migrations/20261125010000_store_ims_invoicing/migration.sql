-- Per-store IMS tax invoicing switch and payment mode.
ALTER TABLE "Store"
  ADD COLUMN "imsInvoicingEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "imsPaymentMode" TEXT;

-- IMS tax invoice integration: encrypted settings, invoice records, tracking uniqueness.

CREATE TABLE "ImsSetting" (
  "id" TEXT NOT NULL DEFAULT 'default',
  "baseUrl" TEXT NOT NULL DEFAULT 'https://ecomapi.imssoftware.com.np/api',
  "companyId" TEXT NOT NULL,
  "branchCode" TEXT NOT NULL,
  "imsUser" TEXT NOT NULL,
  "warehouse" TEXT NOT NULL DEFAULT 'Main Warehouse',
  "paymentMode" TEXT NOT NULL DEFAULT 'cash',
  "voucherType" TEXT NOT NULL DEFAULT 'TI',
  "apiKeyEnc" TEXT,
  "usernameEnc" TEXT,
  "passwordEnc" TEXT,
  "apiSecretEnc" TEXT,
  "tokenEnc" TEXT,
  "tokenExpiresAt" TIMESTAMP(3),
  "lastTestedAt" TIMESTAMP(3),
  "lastSuccessAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ImsSetting_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ImsInvoice" (
  "id" TEXT NOT NULL,
  "trackingNumber" TEXT NOT NULL,
  "trackingNormalized" TEXT NOT NULL,
  "imsInvoiceNumber" TEXT,
  "invoiceDate" TIMESTAMP(3),
  "generatedAt" TIMESTAMP(3),
  "generatedById" TEXT,
  "generatedByName" TEXT,
  "pdfPath" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "imsResponse" JSONB,
  "error" TEXT,
  "verifiedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ImsInvoice_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ImsInvoiceOrder" (
  "invoiceId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  CONSTRAINT "ImsInvoiceOrder_pkey" PRIMARY KEY ("invoiceId", "orderId")
);

CREATE UNIQUE INDEX "ImsInvoice_trackingNormalized_key" ON "ImsInvoice"("trackingNormalized");
CREATE INDEX "ImsInvoice_imsInvoiceNumber_idx" ON "ImsInvoice"("imsInvoiceNumber");
CREATE INDEX "ImsInvoice_status_idx" ON "ImsInvoice"("status");
CREATE INDEX "ImsInvoice_generatedAt_idx" ON "ImsInvoice"("generatedAt");
CREATE UNIQUE INDEX "ImsInvoiceOrder_orderId_key" ON "ImsInvoiceOrder"("orderId");

ALTER TABLE "ImsInvoiceOrder" ADD CONSTRAINT "ImsInvoiceOrder_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "ImsInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ImsInvoiceOrder" ADD CONSTRAINT "ImsInvoiceOrder_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "StoreOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

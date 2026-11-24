-- An order can have multiple packages/tracking numbers, each with its own IMS invoice.
DROP INDEX IF EXISTS "ImsInvoiceOrder_orderId_key";

export type JsonRecord = Record<string, unknown>;

export type NormalizedOrder = {
  darazOrderId: string;
  customerName: string | null;
  orderCreatedAt: Date;
  orderUpdatedAt: Date | null;
  orderStatus: string | null;
  deliveryStatus: string | null;
  trackingNumber: string | null;
};

const record = (value: unknown): JsonRecord | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;

const scalarString = (value: unknown): string | null =>
  typeof value === "string" || typeof value === "number" ? String(value) : null;

const fieldString = (value: unknown): string | null =>
  Array.isArray(value) ? value.map(scalarString).filter((part): part is string => Boolean(part)).join(", ") || null : scalarString(value);

const first = (object: JsonRecord, ...keys: string[]) => {
  for (const key of keys) {
    const value = object[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
};

function dateValue(value: unknown, field: string, required = false): Date | null {
  if (value === undefined || value === null || value === "") {
    if (required) throw new Error(`Daraz order is missing ${field}.`);
    return null;
  }
  const date = new Date(typeof value === "number" ? value : String(value));
  if (Number.isNaN(date.getTime())) throw new Error(`Daraz order has an invalid ${field}.`);
  return date;
}

export function orderCreatedAt(order: JsonRecord): Date | null {
  return dateValue(first(order, "created_at", "createdAt", "order_created_at"), "created_at");
}

export function orderRecords(response: unknown): JsonRecord[] {
  const body = record(response);
  const dataList = Array.isArray(body?.data) ? body.data : null;
  const data = record(body?.data);
  const payload = data ?? body ?? {};
  const entries = Array.isArray(response)
    ? response
    : dataList
      ? dataList
    : Array.isArray(payload) ? payload
      : first(payload, "orders", "order_list", "order");
  if (!Array.isArray(entries)) throw new Error("Daraz orders API returned an unexpected response.");
  return entries.map((entry) => {
    const result = record(entry);
    if (!result) throw new Error("Daraz orders API returned an invalid order entry.");
    return result;
  });
}

export function orderDetailRecord(response: unknown): JsonRecord {
  const body = record(response);
  const dataList = Array.isArray(body?.data) ? record(body.data[0]) : null;
  const data = record(body?.data) ?? dataList ?? body ?? {};
  const nested = record(first(data, "order", "order_detail"));
  if (nested) return nested;
  if (first(data, "order_id", "orderId", "id") !== undefined) return data;
  throw new Error("Daraz order detail API returned an unexpected response.");
}

export function normalizeOrder(order: JsonRecord, fallbackOrderId?: string): NormalizedOrder {
  const orderId = scalarString(first(order, "order_id", "orderId", "id")) ?? fallbackOrderId;
  if (!orderId) throw new Error("Daraz order detail is missing its order ID.");

  const firstName = scalarString(first(order, "customer_first_name", "first_name"));
  const lastName = scalarString(first(order, "customer_last_name", "last_name"));
  const customer = record(first(order, "customer", "buyer"));
  const recipient = record(first(order, "recipient", "shipping_address", "address_shipping"));
  const customerName = scalarString(first(order, "customer_name", "buyer_name", "recipient_name"))
    ?? scalarString(first(customer ?? {}, "name", "full_name"))
    ?? scalarString(first(recipient ?? {}, "name", "full_name"))
    ?? ([firstName, lastName].filter(Boolean).join(" ") || null);

  const items = first(order, "order_items", "orderItems", "items");
  const itemRecords = Array.isArray(items) ? items.map(record).filter((item): item is JsonRecord => item !== null) : [];
  const tracking = scalarString(first(order, "tracking_number", "tracking_code", "trackingNumber"))
    ?? scalarString(first(record(first(order, "shipment", "parcel")) ?? {}, "tracking_number", "tracking_code"))
    ?? ([...new Set(itemRecords.map((item) => scalarString(first(item, "tracking_number", "tracking_code"))).filter((value): value is string => Boolean(value)))].join(", ") || null);
  const deliveryStatus = scalarString(first(order, "delivery_status", "shipment_status", "shipping_status"))
    ?? ([...new Set(itemRecords.map((item) => scalarString(first(item, "delivery_status", "shipment_status", "shipping_status", "status"))).filter((value): value is string => Boolean(value)))].join(", ") || null);

  return {
    darazOrderId: orderId,
    customerName,
    orderCreatedAt: dateValue(first(order, "created_at", "createdAt", "order_created_at"), "created_at", true)!,
    orderUpdatedAt: dateValue(first(order, "updated_at", "updatedAt", "order_updated_at"), "updated_at"),
    orderStatus: fieldString(first(order, "statuses", "status", "order_status")),
    deliveryStatus,
    trackingNumber: tracking,
  };
}

export function productDetailRecord(response: unknown): JsonRecord {
  const body = record(response);
  const dataList = Array.isArray(body?.data) ? record(body.data[0]) : null;
  const data = record(body?.data) ?? dataList ?? body ?? {};
  const nested = record(first(data, "item", "product", "product_item"));
  if (nested) return nested;
  if (first(data, "item_id", "itemId", "id") !== undefined) return data;
  throw new Error("Daraz product detail API returned an unexpected response.");
}

export function productRecords(response: unknown): JsonRecord[] {
  const body = record(response);
  const dataList = Array.isArray(body?.data) ? body.data : null;
  const data = record(body?.data) ?? body ?? {};
  if (dataList) return dataList.map((entry) => {
    const result = record(entry);
    if (!result) throw new Error("Daraz products API returned an invalid product entry.");
    return result;
  });
  const entries = first(data, "products", "items", "product");
  if (!Array.isArray(entries)) throw new Error("Daraz products API returned an unexpected response.");
  return entries.map((entry) => {
    const result = record(entry);
    if (!result) throw new Error("Daraz products API returned an invalid product entry.");
    return result;
  });
}

export function productIdOf(summary: JsonRecord) {
  return scalarString(first(summary, "item_id", "itemId", "product_id", "id"));
}

export function productIdentity(product: JsonRecord, fallbackItemId: string) {
  return {
    darazItemId: scalarString(first(product, "item_id", "itemId", "id")) ?? fallbackItemId,
    sellerSku: scalarString(first(product, "seller_sku", "SellerSku", "sellerSku", "sku")),
    name: scalarString(first(product, "name", "item_name", "product_name")),
    status: scalarString(first(product, "status", "item_status")),
  };
}

export function productItemIds(order: JsonRecord): string[] {
  const entries = first(order, "order_items", "orderItems", "items");
  if (!Array.isArray(entries)) return [];
  return [...new Set(entries.flatMap((entry) => {
    const item = record(entry);
    if (!item) return [];
    const itemId = scalarString(first(item, "product_id", "item_id", "itemId"));
    return itemId ? [itemId] : [];
  }))];
}

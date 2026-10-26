import { describe, expect, it } from "vitest";
import {
  normalizeOrder,
  orderCreatedAt,
  orderDetailRecord,
  orderRecords,
  productDetailRecord,
  productIdentity,
  productItemIds,
  productRecords,
} from "./order-data";

describe("Daraz order response mapping", () => {
  it("reads paged orders and normalizes detail fields", () => {
    const summaries = orderRecords({ data: { orders: [{ order_id: 123 }] } });
    expect(summaries).toEqual([{ order_id: 123 }]);
    const detail = orderDetailRecord({
      data: {
        order: {
          order_id: 123,
          customer_first_name: "Asha",
          customer_last_name: "Rai",
          created_at: "2026-10-20T10:00:00Z",
          updated_at: "2026-10-21T10:00:00Z",
          statuses: "pending",
          shipping_status: "ready_to_ship",
          tracking_number: "TRACK-123",
          order_items: [{ item_id: 456 }],
        },
      },
    });
    expect(normalizeOrder(detail)).toEqual({
      darazOrderId: "123",
      customerName: "Asha Rai",
      orderCreatedAt: new Date("2026-10-20T10:00:00Z"),
      orderUpdatedAt: new Date("2026-10-21T10:00:00Z"),
      orderStatus: "pending",
      deliveryStatus: "ready_to_ship",
      trackingNumber: "TRACK-123",
    });
    expect(productItemIds(detail)).toEqual(["456"]);
  });

  it("rejects malformed orders instead of silently dropping them", () => {
    expect(() => orderRecords({ data: { unexpected: [] } })).toThrow("unexpected response");
    expect(() => normalizeOrder({ order_id: "1" })).toThrow("missing created_at");
  });

  it("normalizes array statuses and shipment fields from order items", () => {
    const order = normalizeOrder({
      order_id: "O-2",
      created_at: "2026-10-20T10:00:00Z",
      statuses: ["pending", "ready_to_ship"],
      order_items: [
        { status: "packed", tracking_code: "TRACK-A" },
        { status: "packed", tracking_code: "TRACK-B" },
      ],
    });
    expect(order.orderStatus).toBe("pending, ready_to_ship");
    expect(order.deliveryStatus).toBe("packed");
    expect(order.trackingNumber).toBe("TRACK-A, TRACK-B");
  });

  it("extracts the created timestamp used as the next CreatedAfter cursor", () => {
    expect(orderCreatedAt({ created_at: "2026-10-21T08:45:12Z" })).toEqual(new Date("2026-10-21T08:45:12Z"));
    expect(() => orderCreatedAt({ created_at: "not-a-date" })).toThrow("invalid created_at");
  });
});

describe("Daraz product response mapping", () => {
  it("reads product pages and preserves normalized master fields", () => {
    const products = productRecords({ data: { products: [{ item_id: 77 }] } });
    expect(products).toEqual([{ item_id: 77 }]);
    const detail = productDetailRecord({ data: { item: { item_id: 77, SellerSku: "SKU-77", name: "Bag", status: "Live" } } });
    expect(productIdentity(detail, "fallback")).toEqual({
      darazItemId: "77",
      sellerSku: "SKU-77",
      name: "Bag",
      status: "Live",
    });
  });

  it("rejects unexpected product response shapes", () => {
    expect(() => productRecords({ data: {} })).toThrow("unexpected response");
    expect(() => productDetailRecord({ data: {} })).toThrow("unexpected response");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchDarazOrderDetails, fetchDarazOrders, fetchDarazProductDetails, fetchDarazProducts } from "./daraz";

describe("Daraz order and product requests", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses signed order and product listing/detail endpoints", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ data: {} }), { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);

    await fetchDarazOrders("NP", "access-secret", { createdAfter: "2026-01-01T00:00:00.000Z", limit: 100, offset: 0 });
    await fetchDarazOrders("NP", "access-secret", { createdAfter: "2026-01-02T00:00:00.000Z", limit: 100, offset: 100 });
    await fetchDarazOrderDetails("NP", "access-secret", "order-1");
    await fetchDarazProducts("NP", "access-secret", { updatedAfter: "2026-01-02T00:00:00.000Z", limit: 50, offset: 0 });
    await fetchDarazProductDetails("NP", "access-secret", "item-1");

    const urls = fetchMock.mock.calls.map(([url]) => new URL(String(url)));
    expect(urls.map((url) => url.pathname)).toEqual([
      "/rest/orders/get",
      "/rest/orders/get",
      "/rest/order/get",
      "/rest/products/get",
      "/rest/product/item/get",
    ]);
    expect(urls[0].searchParams.get("CreatedAfter")).toBe("2026-01-01T00:00:00.000Z");
    expect(urls[0].searchParams.has("created_after")).toBe(false);
    expect(urls[0].searchParams.get("limit")).toBe("100");
    expect(urls[0].searchParams.get("offset")).toBe("0");
    expect(urls[0].searchParams.get("sort_by")).toBe("updated_at");
    expect(urls[1].searchParams.get("CreatedAfter")).toBe("2026-01-02T00:00:00.000Z");
    expect(urls[2].searchParams.get("order_id")).toBe("order-1");
    expect(urls[3].searchParams.get("filter")).toBe("all");
    expect(urls[3].searchParams.get("limit")).toBe("50");
    expect(urls[3].searchParams.get("update_after")).toBe("2026-01-02T00:00:00.000Z");
    expect(urls[4].searchParams.get("item_id")).toBe("item-1");
    expect(urls.every((url) => url.searchParams.has("sign"))).toBe(true);
    expect(urls.every((url) => url.searchParams.get("access_token") === "access-secret")).toBe(true);
  });
});

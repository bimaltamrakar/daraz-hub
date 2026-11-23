import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { fetchAccessToken } from "./src/lib/access-token";
import { fetchDarazOrders } from "./src/lib/daraz";
import { orderRecords } from "./src/lib/order-data";

const db = new PrismaClient();

async function main() {
  const store = await db.store.findFirstOrThrow({ where: { label: "FashionAMH" }, include: { tokens: true } });
  const token = await fetchAccessToken(store);
  const api = new Map<string, { status: string; createdAt: string }>();
  let offset = 0;
  for (let page = 0; page < 100; page++) {
    const response = await fetchDarazOrders(store.country, token, {
      createdAfter: "2020-01-01T00:00:00.000Z",
      limit: 100,
      offset,
    });
    const rows = orderRecords(response);
    for (const row of rows) {
      const id = String(row.order_id ?? "");
      if (!id) continue;
      api.set(id, {
        status: String(row.statuses?.[0] ?? row.status ?? ""),
        createdAt: String(row.created_at ?? ""),
      });
    }
    if (rows.length < 100) break;
    offset += rows.length;
  }

  const dbOrders = await db.storeOrder.findMany({
    where: { storeId: store.id },
    select: { darazOrderId: true, statusGroup: true, orderStatus: true, orderCreatedAt: true },
  });
  const dbIds = new Set(dbOrders.map((order) => order.darazOrderId));
  const missing = [...api.keys()].filter((id) => !dbIds.has(id));
  const extra = dbOrders.filter((order) => !api.has(order.darazOrderId)).map((order) => order.darazOrderId);

  console.log("API unique orders:", api.size);
  console.log("DB orders:", dbOrders.length);
  console.log("missing in DB:", missing.length, missing.slice(0, 10));
  console.log("extra in DB:", extra.length, extra.slice(0, 10));
  console.log("DB by statusGroup:", JSON.stringify(await db.storeOrder.groupBy({ by: ["statusGroup"], where: { storeId: store.id }, _count: { _all: true } })));
  console.log("DB min/max:", (await db.storeOrder.aggregate({ where: { storeId: store.id }, _min: { orderCreatedAt: true }, _max: { orderCreatedAt: true } })));
  console.log("API sample dates:", [...api.values()].slice(0, 3));
  console.log("store:", { syncFrom: store.orderSyncFrom.toISOString(), backfillDone: store.orderBackfillDone, lastSync: store.orderSyncLastAt?.toISOString() ?? null, error: store.orderSyncError });
}

main().finally(() => db.$disconnect());

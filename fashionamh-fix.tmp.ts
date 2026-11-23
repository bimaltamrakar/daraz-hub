import "dotenv/config";
import { Prisma, PrismaClient } from "@prisma/client";
import { fetchAccessToken } from "./src/lib/access-token";
import { fetchDarazOrders } from "./src/lib/daraz";
import { normalizeOrder, orderRecords } from "./src/lib/order-data";

const db = new PrismaClient();
const jsonValue = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

async function main() {
  const store = await db.store.findFirstOrThrow({ where: { label: "FashionAMH" }, include: { tokens: true } });
  const token = await fetchAccessToken(store);
  const api = new Map<string, { status: string; createdAt: string; summary: Record<string, unknown> }>();
  let offset = 0;
  for (let page = 0; page < 100; page++) {
    const response = await fetchDarazOrders(store.country, token, { createdAfter: "2020-01-01T00:00:00.000Z", limit: 100, offset });
    const rows = orderRecords(response);
    for (const row of rows) {
      const id = String(row.order_id ?? "");
      if (!id) continue;
      api.set(id, {
        status: String(row.statuses?.[0] ?? row.status ?? ""),
        createdAt: String(row.created_at ?? ""),
        summary: row,
      });
    }
    if (rows.length < 100) break;
    offset += rows.length;
  }
  const dbOrders = await db.storeOrder.findMany({ where: { storeId: store.id }, select: { darazOrderId: true, orderCreatedAt: true } });
  const dbIds = new Set(dbOrders.map((order) => order.darazOrderId));
  const missing = [...api.entries()].filter(([id]) => !dbIds.has(id));
  console.log("API", api.size, "DB", dbOrders.length, "missing", missing.length);
  for (const [id, info] of missing) console.log("MISSING", id, info.status, info.createdAt);

  let upserted = 0;
  for (const [id, info] of missing) {
    const normalized = normalizeOrder(info.summary, id);
    await db.storeOrder.upsert({
      where: { storeId_darazOrderId: { storeId: store.id, darazOrderId: id } },
      create: { storeId: store.id, ...normalized, rawDetails: jsonValue(info.summary) },
      update: { ...normalized, syncedAt: new Date() },
    });
    upserted += 1;
  }
  console.log("upserted", upserted);
  console.log("DB after:", await db.storeOrder.count({ where: { storeId: store.id } }));
  console.log("missing after:", missing.filter(([id]) => !dbIds.has(id)).length);
}

main().finally(() => db.$disconnect());

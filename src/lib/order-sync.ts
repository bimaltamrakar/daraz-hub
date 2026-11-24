import { randomBytes } from "node:crypto";
import type { OrderSyncFrequency, Prisma } from "@prisma/client";
import { db } from "./db";
import { fetchDarazOrderItems, fetchDarazOrders, safeDarazErrorMessage } from "./daraz";
import { fetchAccessToken } from "./access-token";
import { normalizeOrder, orderCreatedAt, orderRecords, orderUpdatedAt } from "./order-data";
import { upsertProductsFromOrderItems } from "./product-sync";

const pageSize = 100;
const maxOrderPagesPerRun = 100; // 10,000 orders per pass; backfill resumes from a created-at cursor
const lockDurationMs = 30 * 60 * 1000;
const overlapMs = 60 * 1000;
const backfillResumeMs = 60 * 1000;

const frequencyMs: Record<Exclude<OrderSyncFrequency, "manual">, number> = {
  every_15_minutes: 15 * 60 * 1000,
  hourly: 60 * 60 * 1000,
  every_6_hours: 6 * 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
};

export const orderSyncFrequencies: OrderSyncFrequency[] = [
  "manual",
  "every_15_minutes",
  "hourly",
  "every_6_hours",
  "daily",
];

const nextSyncDate = (frequency: OrderSyncFrequency, now: Date) =>
  frequency === "manual" ? null : new Date(now.getTime() + frequencyMs[frequency]);

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function orderIdOf(summary: Record<string, unknown>) {
  const id = summary.order_id ?? summary.orderId ?? summary.id;
  return typeof id === "string" || typeof id === "number" ? String(id) : null;
}

async function renewLock(storeId: string, lockId: string) {
  const result = await db.store.updateMany({
    where: { id: storeId, orderSyncLockId: lockId },
    data: { orderSyncLockUntil: new Date(Date.now() + lockDurationMs) },
  });
  if (result.count !== 1) throw new Error("Order sync lease expired or was replaced.");
}

async function syncStore(storeId: string, lockId: string) {
  const store = await db.store.findUnique({
    where: { id: storeId },
    include: { tokens: true },
  });
  if (!store) throw new Error("Store was removed before its order sync started.");

  const accessToken = await fetchAccessToken(store);
  const from = store.orderSyncFrom;
  const backfilling = !store.orderBackfillDone;
  const now = new Date();
  // Backfill walks one-day windows using created_after + created_before. Daraz caps /orders/get
  // at 5,000 offset rows per query, so a single created_after scan silently truncates busy stores.
  let windowStart = backfilling ? new Date(store.orderBackfillCursor ?? from) : null;
  let windowSpanMs = 24 * 60 * 60 * 1000;
  const incrementalFrom = new Date((store.orderSyncCursor ?? from).getTime() - overlapMs);
  let highestUpdatedAt = store.orderSyncCursor;
  let offset = 0;
  let page = 0;
  let reachedEnd = false;
  const seenOrders = new Set<string>();

  while (page < maxOrderPagesPerRun) {
    await renewLock(storeId, lockId);
    const windowEnd = windowStart ? new Date(Math.min(windowStart.getTime() + windowSpanMs, now.getTime())) : null;
    const response = await fetchDarazOrders(store.country, accessToken, {
      ...(backfilling && windowStart && windowEnd
        ? { createdAfter: windowStart.toISOString(), createdBefore: windowEnd.toISOString() }
        : { updatedAfter: incrementalFrom.toISOString() }),
      limit: pageSize,
      offset,
    });
    const summaries = orderRecords(response);

    if (summaries.length === 0) {
      if (!backfilling || !windowStart || !windowEnd) {
        reachedEnd = true;
        break;
      }
      // A capped query returns an empty page at offset 5,000: split the window and retry.
      if (offset >= 5000) {
        windowSpanMs = Math.max(60 * 60 * 1000, Math.floor(windowSpanMs / 2));
        offset = 0;
        continue;
      }
      windowStart = windowEnd;
      windowSpanMs = 24 * 60 * 60 * 1000;
      offset = 0;
      if (windowStart.getTime() >= now.getTime()) {
        reachedEnd = true;
        break;
      }
      await db.store.updateMany({
        where: { id: storeId, orderSyncLockId: lockId },
        data: { orderBackfillCursor: windowStart, orderSyncNextAt: new Date(Date.now() + backfillResumeMs) },
      });
      continue;
    }

    const pageOrders: Array<{ summary: Record<string, unknown>; normalized: ReturnType<typeof normalizeOrder> }> = [];
    for (const summary of summaries) {
      const orderId = orderIdOf(summary);
      if (!orderId) throw new Error("Daraz orders API returned an order without an order ID.");
      if (seenOrders.has(orderId)) continue;
      seenOrders.add(orderId);

      const summaryUpdatedAt = orderUpdatedAt(summary);
      if (summaryUpdatedAt && (!highestUpdatedAt || summaryUpdatedAt > highestUpdatedAt)) {
        highestUpdatedAt = summaryUpdatedAt;
      }

      const normalized = normalizeOrder(summary, orderId);
      if (normalized.orderCreatedAt < from) continue;
      pageOrders.push({ summary, normalized });
    }

    // Upserts are batched so large backfills are bounded by network latency, not one round-trip per order.
    for (let index = 0; index < pageOrders.length; index += 20) {
      await Promise.all(pageOrders.slice(index, index + 20).map(({ summary, normalized }) =>
        db.storeOrder.upsert({
          where: { storeId_darazOrderId: { storeId, darazOrderId: normalized.darazOrderId } },
          create: { storeId, ...normalized, rawDetails: jsonValue(summary) },
          update: { ...normalized, syncedAt: new Date() },
        }),
      ));
    }

    page += 1;
    offset += summaries.length;
    if (summaries.length < pageSize) {
      if (!backfilling || !windowStart || !windowEnd) {
        reachedEnd = true;
        break;
      }
      windowStart = windowEnd;
      windowSpanMs = 24 * 60 * 60 * 1000;
      offset = 0;
      if (windowStart.getTime() >= now.getTime()) {
        reachedEnd = true;
        break;
      }
      await db.store.updateMany({
        where: { id: storeId, orderSyncLockId: lockId },
        data: { orderBackfillCursor: windowStart, orderSyncNextAt: new Date(Date.now() + backfillResumeMs) },
      });
    }
  }

  const backfillPartial = backfilling && !reachedEnd;

  if (backfilling) {
    await db.store.updateMany({
      where: { id: storeId, orderSyncLockId: lockId },
      data: {
        orderBackfillDone: reachedEnd,
        orderBackfillCursor: reachedEnd ? null : (windowStart ?? from),
        ...(highestUpdatedAt ? { orderSyncCursor: highestUpdatedAt } : {}),
        ...(reachedEnd ? {} : { orderSyncNextAt: new Date(Date.now() + backfillResumeMs) }),
      },
    });
  } else if (highestUpdatedAt && (!store.orderSyncCursor || highestUpdatedAt > store.orderSyncCursor)) {
    await db.store.updateMany({
      where: { id: storeId, orderSyncLockId: lockId },
      data: { orderSyncCursor: highestUpdatedAt },
    });
  }

  // Make sure the SKUs referenced by new/active orders exist in the product catalog. This also
  // covers Choice sellers, whose products API is not available.
  try {
    const candidates = await db.storeOrder.findMany({
      where: {
        storeId,
        itemsSyncedAt: null,
        OR: [
          { statusGroup: { in: ["unpaid", "to_ship", "shipping"] } },
          { orderCreatedAt: { gte: new Date(Date.now() - 30 * 86400000) } },
        ],
      },
      orderBy: { orderCreatedAt: "desc" },
      take: 25,
      select: { id: true, darazOrderId: true, rawDetails: true },
    });
    let syncedOrders = 0;
    for (const candidate of candidates) {
      await renewLock(storeId, lockId);
      const itemsBody = await fetchDarazOrderItems(store.country, accessToken, candidate.darazOrderId);
      const items = Array.isArray((itemsBody as { data?: unknown }).data)
        ? (itemsBody as { data: Record<string, unknown>[] }).data
        : [];
      await upsertProductsFromOrderItems(storeId, items);
      const raw = (candidate.rawDetails ?? {}) as Record<string, unknown>;
      const base = (raw.data ?? raw) as Record<string, unknown>;
      await db.storeOrder.update({
        where: { id: candidate.id },
        data: {
          itemsSyncedAt: new Date(),
          rawDetails: jsonValue({ data: { ...base, order_items: items } }),
        },
      });
      syncedOrders += 1;
    }
    if (syncedOrders) console.log(`Synced products from ${syncedOrders} order(s) for store ${storeId}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown order item product sync error.";
    console.warn(`Order item product sync skipped for store ${storeId}: ${safeDarazErrorMessage(store.country, message)}`);
  }

  const completedAt = new Date();
  const latestSettings = await db.store.findUnique({ where: { id: storeId }, select: { orderSyncFrequency: true } });
  if (!latestSettings) throw new Error("Store was removed during order sync.");
  await db.store.updateMany({
    where: { id: storeId, orderSyncLockId: lockId },
    data: {
      orderSyncLastAt: completedAt,
      orderSyncNextAt: backfillPartial
        ? new Date(Date.now() + backfillResumeMs)
        : nextSyncDate(latestSettings.orderSyncFrequency, completedAt),
      orderSyncError: null,
    },
  });
}

async function runClaimedStore(storeId: string, lockId: string) {
  try {
    await syncStore(storeId, lockId);
  } catch (error) {
    const databaseError = error instanceof Error && error.name.startsWith("PrismaClient");
    const message = databaseError
      ? "A database error occurred during order sync. Check the server logs."
      : error instanceof Error ? error.message : "Unknown order sync error.";
    const store = await db.store.findUnique({ where: { id: storeId }, select: { country: true, orderSyncFrequency: true } });
    const reason = store ? safeDarazErrorMessage(store.country, message) : message.slice(0, 500);
    console.error(`Daraz order sync failed for store ${storeId}:`, databaseError ? error.name : reason);
    if (store) {
      const completedAt = new Date();
      await db.store.updateMany({
        where: { id: storeId, orderSyncLockId: lockId },
        data: {
          orderSyncNextAt: nextSyncDate(store.orderSyncFrequency, completedAt),
          orderSyncError: reason,
        },
      });
    }
  } finally {
    await db.store.updateMany({
      where: { id: storeId, orderSyncLockId: lockId },
      data: { orderSyncLockId: null, orderSyncLockUntil: null },
    });
  }
}

let workerRunning = false;

/** Runs an order-sync pass for one store immediately, claiming the lease first. */
export async function runStoreOrderSyncNow(storeId: string) {
  const lockId = randomBytes(16).toString("hex");
  const claimed = await db.store.updateMany({
    where: {
      id: storeId,
      OR: [{ orderSyncLockUntil: null }, { orderSyncLockUntil: { lt: new Date() } }],
    },
    data: {
      orderSyncLockId: lockId,
      orderSyncLockUntil: new Date(Date.now() + lockDurationMs),
      orderSyncNextAt: new Date(),
    },
  });
  if (claimed.count !== 1) return false;
  await runClaimedStore(storeId, lockId);
  return true;
}

export async function runDueOrderSyncs() {
  if (workerRunning) return;
  workerRunning = true;
  try {
    const now = new Date();
    const dueStores = await db.store.findMany({
      where: {
        orderSyncNextAt: { lte: now },
        tokens: { isNot: null },
        isActive: true,
      },
      orderBy: { orderSyncNextAt: "asc" },
      take: 5,
      select: { id: true },
    });
    for (const store of dueStores) {
      const lockId = randomBytes(16).toString("hex");
      const claimed = await db.store.updateMany({
        where: {
          id: store.id,
          orderSyncNextAt: { lte: now },
          isActive: true,
          OR: [{ orderSyncLockUntil: null }, { orderSyncLockUntil: { lt: now } }],
        },
        data: {
          orderSyncLockId: lockId,
          orderSyncLockUntil: new Date(now.getTime() + lockDurationMs),
        },
      });
      if (claimed.count === 1) await runClaimedStore(store.id, lockId);
    }
  } finally {
    workerRunning = false;
  }
}

export function startOrderSyncWorker() {
  // Stores repaired outside the scheduler can end up with a null next run while still on a timed
  // frequency. Re-arm them so scheduled incremental updates (update_after cursor) resume.
  void db.store.updateMany({
    where: { isActive: true, orderSyncFrequency: { not: "manual" }, orderSyncNextAt: null, tokens: { isNot: null } },
    data: { orderSyncNextAt: new Date() },
  }).catch((error: unknown) => console.error("Could not arm scheduled order syncs:", error instanceof Error ? error.message : error));
  const timer = setInterval(() => {
    void runDueOrderSyncs().catch((error: unknown) => {
      console.error("Order sync worker failed:", error instanceof Error ? error.message : "Unknown worker error.");
    });
  }, 15_000);
  timer.unref();
  void runDueOrderSyncs().catch((error: unknown) => {
    console.error("Order sync worker failed:", error instanceof Error ? error.message : "Unknown worker error.");
  });
}

export async function queueStoreOrderSync(storeId: string) {
  const now = new Date();
  const store = await db.store.findUnique({ where: { id: storeId }, select: { orderSyncLockUntil: true, isActive: true } });
  if (!store || !store.isActive) return false;
  if (store.orderSyncLockUntil && store.orderSyncLockUntil > now) return false;
  await db.store.update({ where: { id: storeId }, data: { orderSyncNextAt: now, orderSyncError: null } });
  void runDueOrderSyncs().catch((error: unknown) => {
    console.error("Manual order sync could not be started:", error instanceof Error ? error.message : "Unknown worker error.");
  });
  return true;
}

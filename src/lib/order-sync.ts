import { randomBytes } from "node:crypto";
import type { OrderSyncFrequency, Prisma } from "@prisma/client";
import { db } from "./db";
import { decrypt, encrypt } from "./crypto";
import {
  fetchDarazOrderDetails,
  fetchDarazOrders,
  fetchDarazProductDetails,
  fetchDarazProducts,
  refreshDarazToken,
  safeDarazErrorMessage,
} from "./daraz";
import { isRefreshTokenUsable } from "./policies";
import {
  normalizeOrder,
  orderCreatedAt,
  orderDetailRecord,
  orderRecords,
  productDetailRecord,
  productIdOf,
  productIdentity,
  productItemIds,
  productRecords,
} from "./order-data";

const pageSize = 100;
const productPageSize = 50;
const maxPagesPerRun = 500;
const lockDurationMs = 30 * 60 * 1000;
const overlapMs = 60 * 1000;

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

async function fetchAccessToken(store: {
  country: string;
  tokens: { storeId: string; accessTokenEnc: string; refreshTokenEnc: string; accessExpiresAt: Date; refreshExpiresAt: Date } | null;
}) {
  if (!store.tokens) throw new Error("Store has no Daraz token. Connect the store before syncing orders.");
  let accessToken = decrypt(store.tokens.accessTokenEnc);
  if (store.tokens.accessExpiresAt.getTime() > Date.now() + 60_000) return accessToken;
  if (!isRefreshTokenUsable(store.tokens.refreshExpiresAt)) {
    throw new Error("Daraz access token has expired and its refresh token is no longer valid. Reconnect the store.");
  }

  const refreshed = await refreshDarazToken(store.country, decrypt(store.tokens.refreshTokenEnc));
  accessToken = refreshed.accessToken;
  await db.storeToken.update({
    where: { storeId: store.tokens.storeId },
    data: {
      accessTokenEnc: encrypt(refreshed.accessToken),
      refreshTokenEnc: encrypt(refreshed.refreshToken),
      accessExpiresAt: refreshed.accessExpiresAt,
      refreshExpiresAt: refreshed.refreshExpiresAt,
      lastRefreshedAt: new Date(),
      lastError: null,
    },
  });
  await db.store.update({ where: { id: store.tokens.storeId }, data: { status: "connected" } });
  return accessToken;
}

async function syncStore(storeId: string, lockId: string) {
  const store = await db.store.findUnique({
    where: { id: storeId },
    include: { tokens: true },
  });
  if (!store) throw new Error("Store was removed before its order sync started.");

  const accessToken = await fetchAccessToken(store);
  const from = store.orderSyncFrom;
  const createdAfter = store.orderSyncCursor ?? from;
  let highestOrderCreatedAt = store.orderSyncCursor;
  let offset = 0;
  let page = 0;
  const productIds = new Set<string>();
  const seenOrders = new Set<string>();

  while (page < maxPagesPerRun) {
    await renewLock(storeId, lockId);
    const response = await fetchDarazOrders(store.country, accessToken, {
      createdAfter: createdAfter.toISOString(),
      limit: pageSize,
      offset,
    });
    const summaries = orderRecords(response);
    if (summaries.length === 0) break;

    for (const summary of summaries) {
      const summaryCreatedAt = orderCreatedAt(summary);
      if (summaryCreatedAt && (!highestOrderCreatedAt || summaryCreatedAt > highestOrderCreatedAt)) {
        highestOrderCreatedAt = summaryCreatedAt;
      }
      const orderId = orderIdOf(summary);
      if (!orderId) throw new Error("Daraz orders API returned an order without an order ID.");
      if (seenOrders.has(orderId)) continue;
      seenOrders.add(orderId);

      await renewLock(storeId, lockId);
      const detailResponse = await fetchDarazOrderDetails(store.country, accessToken, orderId);
      const detail = orderDetailRecord(detailResponse);
      const normalized = normalizeOrder({ ...summary, ...detail }, orderId);
      if (normalized.orderCreatedAt < from) continue;

      await db.storeOrder.upsert({
        where: { storeId_darazOrderId: { storeId, darazOrderId: normalized.darazOrderId } },
        create: { storeId, ...normalized, rawDetails: jsonValue(detailResponse) },
        update: { ...normalized, rawDetails: jsonValue(detailResponse), syncedAt: new Date() },
      });

      for (const itemId of productItemIds(detail)) productIds.add(itemId);
    }

    page += 1;
    if (summaries.length < pageSize) break;
    offset += summaries.length;
  }

  if (page === maxPagesPerRun) {
    throw new Error(`Order sync reached the ${maxPagesPerRun}-page safety limit. Reduce the date range or sync more frequently.`);
  }

  if (highestOrderCreatedAt && (!store.orderSyncCursor || highestOrderCreatedAt > store.orderSyncCursor)) {
    await db.store.updateMany({
      where: { id: storeId, orderSyncLockId: lockId },
      data: { orderSyncCursor: highestOrderCreatedAt },
    });
  }

  let productOffset = 0;
  let productPage = 0;
  while (productPage < maxPagesPerRun) {
    await renewLock(storeId, lockId);
    const response = await fetchDarazProducts(store.country, accessToken, {
      ...(store.productSyncLastAt
        ? { updatedAfter: new Date(store.productSyncLastAt.getTime() - overlapMs).toISOString() }
        : {}),
      limit: productPageSize,
      offset: productOffset,
    });
    const summaries = productRecords(response);
    if (summaries.length === 0) break;
    for (const summary of summaries) {
      const itemId = productIdOf(summary);
      if (!itemId) throw new Error("Daraz products API returned a product without an item ID.");
      productIds.add(itemId);
    }
    productPage += 1;
    if (summaries.length < productPageSize) break;
    productOffset += summaries.length;
  }
  if (productPage === maxPagesPerRun) {
    throw new Error(`Product sync reached the ${maxPagesPerRun}-page safety limit. Sync more frequently.`);
  }

  const productErrors: string[] = [];
  for (const itemId of productIds) {
    let response: Record<string, unknown>;
    try {
      await renewLock(storeId, lockId);
      response = await fetchDarazProductDetails(store.country, accessToken, itemId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown product detail error.";
      productErrors.push(`${itemId}: ${message.slice(0, 200)}`);
      continue;
    }
    const product = productDetailRecord(response);
    const identity = productIdentity(product, itemId);
    await db.productMaster.upsert({
      where: { storeId_darazItemId: { storeId, darazItemId: identity.darazItemId } },
      create: { storeId, ...identity, rawDetails: jsonValue(response) },
      update: { ...identity, rawDetails: jsonValue(response), fetchedAt: new Date() },
    });
  }
  const completedAt = new Date();
  const latestSettings = await db.store.findUnique({ where: { id: storeId }, select: { orderSyncFrequency: true } });
  if (!latestSettings) throw new Error("Store was removed during order sync.");
  const productError = productErrors.length
    ? safeDarazErrorMessage(store.country, `Unable to fetch ${productErrors.length} product detail(s): ${productErrors.slice(0, 5).join("; ")}`)
    : null;
  await db.store.updateMany({
    where: { id: storeId, orderSyncLockId: lockId },
    data: {
      orderSyncLastAt: completedAt,
      ...(productError ? {} : { productSyncLastAt: completedAt }),
      orderSyncNextAt: nextSyncDate(latestSettings.orderSyncFrequency, completedAt),
      orderSyncError: productError,
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

export async function runDueOrderSyncs() {
  if (workerRunning) return;
  workerRunning = true;
  try {
    const now = new Date();
    const dueStores = await db.store.findMany({
      where: {
        orderSyncNextAt: { lte: now },
        tokens: { isNot: null },
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
  const store = await db.store.findUnique({ where: { id: storeId }, select: { orderSyncLockUntil: true } });
  if (!store) return false;
  if (store.orderSyncLockUntil && store.orderSyncLockUntil > now) return false;
  await db.store.update({ where: { id: storeId }, data: { orderSyncNextAt: now, orderSyncError: null } });
  void runDueOrderSyncs().catch((error: unknown) => {
    console.error("Manual order sync could not be started:", error instanceof Error ? error.message : "Unknown worker error.");
  });
  return true;
}

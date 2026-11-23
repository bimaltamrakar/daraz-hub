import { randomBytes } from "node:crypto";
import type { OrderSyncFrequency, Prisma } from "@prisma/client";
import { db } from "./db";
import { fetchAccessToken } from "./access-token";
import { fetchDarazProductDetails, fetchDarazProducts, safeDarazErrorMessage } from "./daraz";
import { productDetailRecord, productIdOf, productRecords } from "./order-data";
import { productFromDetail, productFromOrderItem, type ProductData } from "./product-data";

const productPageSize = 50;
const maxPagesPerRun = 20;
const maxDetailsPerRun = 150;
const productLockMs = 15 * 60 * 1000;
const overlapMs = 60 * 1000;
const resumeMs = 60 * 1000;

const frequencyMs: Record<Exclude<OrderSyncFrequency, "manual">, number> = {
  every_15_minutes: 15 * 60 * 1000,
  hourly: 60 * 60 * 1000,
  every_6_hours: 6 * 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
};

const nextProductSyncAt = (frequency: OrderSyncFrequency, now: Date) =>
  frequency === "manual" ? null : new Date(now.getTime() + frequencyMs[frequency]);

const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

/**
 * Upserts a product and its variants for a store. Catalog sync overwrites price/stock; order-derived
 * records only fill missing descriptive fields so a later catalog sync stays authoritative.
 */
export async function upsertProductData(
  storeId: string,
  product: ProductData,
  raw: unknown,
  source: "catalog" | "order",
) {
  const existing = await db.productMaster.findUnique({
    where: { storeId_darazItemId: { storeId, darazItemId: product.darazItemId } },
    select: { id: true },
  });

  const master = await db.productMaster.upsert({
    where: { storeId_darazItemId: { storeId, darazItemId: product.darazItemId } },
    create: {
      storeId,
      darazItemId: product.darazItemId,
      sellerSku: product.variants[0]?.sku ?? null,
      name: product.name,
      brand: product.brand,
      status: product.status,
      imageUrl: product.imageUrl,
      price: product.price,
      specialPrice: product.specialPrice,
      quantity: product.quantity,
      ...(product.variation == null ? {} : { variation: json(product.variation) }),
      syncedFrom: source,
      rawDetails: json(raw),
    },
    update: {
      ...(product.name ? { name: product.name } : {}),
      ...(product.brand ? { brand: product.brand } : {}),
      ...(product.status ? { status: product.status } : {}),
      ...(product.imageUrl ? { imageUrl: product.imageUrl } : {}),
      ...(source === "catalog" ? {
        price: product.price,
        specialPrice: product.specialPrice,
        quantity: product.quantity,
        rawDetails: json(raw),
        syncedFrom: "catalog",
        ...(product.variation == null ? {} : { variation: json(product.variation) }),
      } : {}),
      ...(existing ? {} : { syncedFrom: "order" }),
      fetchedAt: new Date(),
    },
  });

  for (const variant of product.variants) {
    if (!variant.sku || variant.sku === "unknown-sku") continue;
    await db.productVariant.upsert({
      where: { storeId_sku: { storeId, sku: variant.sku } },
      create: {
        storeId,
        productId: master.id,
        sku: variant.sku,
        darazSkuId: variant.darazSkuId,
        name: variant.name,
        color: variant.color,
        size: variant.size,
        price: variant.price,
        specialPrice: variant.specialPrice,
        quantity: variant.quantity,
        status: variant.status,
        imageUrl: variant.imageUrl,
        rawDetails: json(variant.raw),
      },
      update: {
        productId: master.id,
        ...(variant.darazSkuId ? { darazSkuId: variant.darazSkuId } : {}),
        ...(variant.name ? { name: variant.name } : {}),
        ...(variant.color ? { color: variant.color } : {}),
        ...(variant.size ? { size: variant.size } : {}),
        ...(variant.status ? { status: variant.status } : {}),
        ...(variant.imageUrl ? { imageUrl: variant.imageUrl } : {}),
        ...(source === "catalog" ? {
          price: variant.price,
          specialPrice: variant.specialPrice,
          quantity: variant.quantity,
          rawDetails: json(variant.raw),
        } : {}),
      },
    });
  }

  return master;
}

/** Creates/fills products for the SKUs referenced by an order's line items. */
export async function upsertProductsFromOrderItems(storeId: string, items: Record<string, unknown>[]) {
  for (const item of items) {
    const product = productFromOrderItem(item);
    if (!product) continue;
    await upsertProductData(storeId, product, item, "order");
  }
}

async function renewProductLock(storeId: string, lockId: string) {
  const result = await db.store.updateMany({
    where: { id: storeId, productSyncLockId: lockId },
    data: { productSyncLockUntil: new Date(Date.now() + productLockMs) },
  });
  if (result.count !== 1) throw new Error("Product sync lease expired or was replaced.");
}

/** Standalone catalog sync: full initial pass (resumable via offset) then update_after increments. */
export async function syncStoreProducts(storeId: string, lockId: string) {
  const store = await db.store.findUnique({ where: { id: storeId }, include: { tokens: true } });
  if (!store) throw new Error("Store was removed before its product sync started.");
  if (store.storeType === "choice") throw new Error("Choice sellers cannot use the Daraz products API.");
  const accessToken = await fetchAccessToken(store);

  const incremental = Boolean(store.productSyncLastAt) && store.productSyncOffset === 0;
  const startOffset = incremental ? 0 : store.productSyncOffset;
  let offset = startOffset;
  let details = 0;
  let pages = 0;
  let reachedEnd = false;
  let failure: string | null = null;

  while (pages < maxPagesPerRun && details < maxDetailsPerRun) {
    await renewProductLock(storeId, lockId);
    const response = await fetchDarazProducts(store.country, accessToken, {
      ...(incremental && store.productSyncLastAt
        ? { updatedAfter: new Date(store.productSyncLastAt.getTime() - overlapMs) }
        : {}),
      limit: productPageSize,
      offset,
    });
    const summaries = productRecords(response);
    if (summaries.length === 0) {
      reachedEnd = true;
      break;
    }

    let processed = 0;
    for (const summary of summaries) {
      if (details >= maxDetailsPerRun) break;
      const itemId = productIdOf(summary);
      if (!itemId) {
        processed += 1;
        continue;
      }
      try {
        await renewProductLock(storeId, lockId);
        const detail = await fetchDarazProductDetails(store.country, accessToken, itemId);
        const item = productDetailRecord(detail);
        const product = productFromDetail(item, itemId);
        await upsertProductData(storeId, product, detail, "catalog");
        processed += 1;
        details += 1;
      } catch (error) {
        failure = safeDarazErrorMessage(store.country, error instanceof Error ? error.message : "Unknown product detail error.");
        console.warn(`Product ${itemId} failed for store ${storeId}: ${failure}`);
        break;
      }
      // Keep Daraz's per-app call rate comfortable on large catalogs.
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    offset += processed;
    pages += 1;
    await db.store.updateMany({
      where: { id: storeId, productSyncLockId: lockId },
      data: { productSyncOffset: offset, ...(failure ? { productSyncError: failure } : {}) },
    });
    if (failure || processed < summaries.length) break;
    if (summaries.length < productPageSize) {
      reachedEnd = true;
      break;
    }
  }

  const completedAt = new Date();
  const latest = await db.store.findUnique({ where: { id: storeId }, select: { orderSyncFrequency: true } });
  if (!latest) throw new Error("Store was removed during product sync.");

  if (reachedEnd && !failure) {
    await db.store.updateMany({
      where: { id: storeId, productSyncLockId: lockId },
      data: {
        productSyncLastAt: completedAt,
        productSyncOffset: 0,
        productSyncNextAt: nextProductSyncAt(latest.orderSyncFrequency, completedAt),
        productSyncError: null,
      },
    });
  } else if (incremental && !failure) {
    await db.store.updateMany({
      where: { id: storeId, productSyncLockId: lockId },
      data: {
        productSyncLastAt: completedAt,
        productSyncOffset: 0,
        productSyncNextAt: nextProductSyncAt(latest.orderSyncFrequency, completedAt),
        productSyncError: null,
      },
    });
  } else {
    await db.store.updateMany({
      where: { id: storeId, productSyncLockId: lockId },
      data: {
        productSyncOffset: incremental ? 0 : offset,
        productSyncNextAt: new Date(Date.now() + resumeMs),
        productSyncError: failure,
      },
    });
  }
  console.log(`Product sync for store ${storeId}: ${details} product(s), offset ${startOffset} to ${offset}${reachedEnd ? " (complete)" : " (continues)"}.`);
}

async function runClaimedProductStore(storeId: string, lockId: string) {
  try {
    await syncStoreProducts(storeId, lockId);
  } catch (error) {
    const store = await db.store.findUnique({ where: { id: storeId }, select: { country: true, orderSyncFrequency: true } });
    const databaseError = error instanceof Error && error.name.startsWith("PrismaClient");
    const message = databaseError
      ? "A database error occurred during product sync. Check the server logs."
      : error instanceof Error ? error.message : "Unknown product sync error.";
    const reason = store ? safeDarazErrorMessage(store.country, message) : message.slice(0, 500);
    console.error(`Daraz product sync failed for store ${storeId}:`, databaseError ? error.name : reason);
    if (store) {
      await db.store.updateMany({
        where: { id: storeId, productSyncLockId: lockId },
        data: { productSyncNextAt: nextProductSyncAt(store.orderSyncFrequency, new Date()), productSyncError: reason },
      });
    }
  } finally {
    await db.store.updateMany({
      where: { id: storeId, productSyncLockId: lockId },
      data: { productSyncLockId: null, productSyncLockUntil: null },
    });
  }
}

let productWorkerRunning = false;

export async function runDueProductSyncs() {
  if (productWorkerRunning) return;
  productWorkerRunning = true;
  try {
    const now = new Date();
    const dueStores = await db.store.findMany({
      where: { productSyncNextAt: { lte: now }, tokens: { isNot: null }, storeType: { not: "choice" }, isActive: true },
      orderBy: { productSyncNextAt: "asc" },
      take: 2,
      select: { id: true },
    });
    for (const store of dueStores) {
      const lockId = randomBytes(16).toString("hex");
      const claimed = await db.store.updateMany({
        where: {
          id: store.id,
          productSyncNextAt: { lte: now },
          storeType: { not: "choice" },
          isActive: true,
          OR: [{ productSyncLockUntil: null }, { productSyncLockUntil: { lt: now } }],
        },
        data: { productSyncLockId: lockId, productSyncLockUntil: new Date(now.getTime() + productLockMs) },
      });
      if (claimed.count === 1) await runClaimedProductStore(store.id, lockId);
    }
  } finally {
    productWorkerRunning = false;
  }
}

export function startProductSyncWorker() {
  const timer = setInterval(() => {
    void runDueProductSyncs().catch((error: unknown) => {
      console.error("Product sync worker failed:", error instanceof Error ? error.message : "Unknown worker error.");
    });
  }, 15_000);
  timer.unref();
  void runDueProductSyncs().catch((error: unknown) => {
    console.error("Product sync worker failed:", error instanceof Error ? error.message : "Unknown worker error.");
  });
}

export async function queueProductSync(storeId: string) {
  const store = await db.store.findUnique({ where: { id: storeId }, select: { productSyncLockUntil: true, isActive: true } });
  if (!store || !store.isActive) return false;
  if (store.productSyncLockUntil && store.productSyncLockUntil > new Date()) return false;
  await db.store.update({ where: { id: storeId }, data: { productSyncNextAt: new Date(), productSyncError: null } });
  void runDueProductSyncs().catch((error: unknown) => {
    console.error("Product sync could not be started:", error instanceof Error ? error.message : "Unknown worker error.");
  });
  return true;
}

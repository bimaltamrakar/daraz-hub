import { Prisma } from "@prisma/client";
import { db } from "./db";

const PAID_GROUPS = ["to_ship", "shipping", "delivered"];

const storeStatus = (store: { status: string; tokens?: { accessExpiresAt: Date; refreshExpiresAt: Date } | null }) => {
  if (!store.tokens) return store.status;
  const now = Date.now();
  if (store.tokens.accessExpiresAt.getTime() <= now || store.tokens.refreshExpiresAt.getTime() <= now) return "expired";
  if (store.status === "error") return "error";
  if (store.tokens.refreshExpiresAt.getTime() <= now + 7 * 86400000) return "expiring_soon";
  return "connected";
};

const percentChange = (current: number, previous: number): number | null =>
  previous > 0 ? ((current - previous) / previous) * 100 : null;

const round2 = (value: number) => Math.round(value * 100) / 100;

export type DashboardStats = Awaited<ReturnType<typeof buildDashboardStats>>;

/**
 * Aggregates dashboard metrics for the user's active stores, optionally limited to a single store.
 * Order/sales metrics honour the `days` window; catalog/stock figures are current snapshots.
 */
export async function buildDashboardStats(userId: string, days: number, storeId?: string) {
  const stores = await db.store.findMany({
    where: { userId, isActive: true, ...(storeId ? { id: storeId } : {}) },
    include: { tokens: true },
    orderBy: { createdAt: "asc" },
  });
  const storeOptions = await db.store.findMany({
    where: { userId, isActive: true },
    select: { id: true, label: true },
    orderBy: { createdAt: "asc" },
  });

  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  since.setUTCDate(since.getUTCDate() - (days - 1));
  const previousSince = new Date(since);
  previousSince.setUTCDate(previousSince.getUTCDate() - days);

  const storeIds = stores.map((store) => store.id);
  if (!storeIds.length) {
    return {
      range: { days, from: since.toISOString(), storeId: storeId ?? null },
      totals: { sales: 0, paidOrders: 0, orders: 0, products: 0, variants: 0, stores: 0, connected: 0, units: 0, aov: 0, unitsPerOrder: 0 },
      previous: { sales: 0, paidOrders: 0, orders: 0, units: 0, aov: 0 },
      comparison: { salesPct: null, ordersPct: null, aovPct: null, unitsPct: null },
      windows: { today: 0, last7: 0 },
      trend: { days, points: [] },
      statusTrend: [],
      ordersByGroup: {},
      stores: [],
      storeOptions,
      topProducts: [],
      categories: [],
      stock: { outOfStock: 0, lowStock: 0, deadStock: 0, lowStockVariants: [], deadProducts: [] },
      heatmap: [],
      recentActivity: [],
      generatedAt: new Date().toISOString(),
    };
  }

  const [currentGroups, previousGroupCounts, currentSales, previousSales, products, variants, statusDayRows, heatRows, topRows, categoryRows, unitsRows, previousUnitsRows, soldRows] = await Promise.all([
    db.storeOrder.groupBy({
      by: ["storeId", "statusGroup"],
      where: { storeId: { in: storeIds }, statusGroup: { not: "canceled" }, orderCreatedAt: { gte: since } },
      _count: { _all: true },
    }),
    db.storeOrder.groupBy({
      by: ["storeId"],
      where: { storeId: { in: storeIds }, statusGroup: { not: "canceled" }, orderCreatedAt: { gte: previousSince, lt: since } },
      _count: { _all: true },
    }),
    db.storeOrder.groupBy({
      by: ["storeId"],
      where: { storeId: { in: storeIds }, statusGroup: { in: PAID_GROUPS }, orderCreatedAt: { gte: since } },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    db.storeOrder.groupBy({
      by: ["storeId"],
      where: { storeId: { in: storeIds }, statusGroup: { in: PAID_GROUPS }, orderCreatedAt: { gte: previousSince, lt: since } },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    db.productMaster.groupBy({ by: ["storeId"], where: { storeId: { in: storeIds } }, _count: { _all: true } }),
    db.productVariant.groupBy({ by: ["storeId"], where: { storeId: { in: storeIds } }, _count: { _all: true } }),
    db.$queryRaw<Array<{ day: Date; orders: number; canceled: number; returned: number }>>`
      SELECT DATE("orderCreatedAt") AS day,
             COUNT(*)::int AS orders,
             0 AS canceled,
             COUNT(*) FILTER (WHERE "statusGroup" = 'returned')::int AS returned
      FROM "StoreOrder"
      WHERE "storeId" IN (${Prisma.join(storeIds)}) AND "orderCreatedAt" >= ${since} AND "statusGroup" <> 'canceled'
      GROUP BY 1
      ORDER BY 1
    `,
    db.$queryRaw<Array<{ dow: number; hour: number; revenue: number; orders: number }>>`
      SELECT EXTRACT(DOW FROM "orderCreatedAt")::int AS dow,
             EXTRACT(HOUR FROM "orderCreatedAt")::int AS hour,
             COALESCE(SUM("amount"), 0)::float8 AS revenue,
             COUNT(*)::int AS orders
      FROM "StoreOrder"
      WHERE "storeId" IN (${Prisma.join(storeIds)})
        AND "statusGroup" IN (${Prisma.join(PAID_GROUPS)})
        AND "orderCreatedAt" >= ${since}
      GROUP BY 1, 2
    `,
    db.$queryRaw<Array<{ item_id: string; name: string | null; sku: string | null; image_url: string | null; revenue: number; units: number }>>`
      SELECT item->>'product_id' AS item_id,
             MAX(item->>'name') AS name,
             MAX(COALESCE(item->>'shop_sku', item->>'sku')) AS sku,
             MAX(p."imageUrl") AS image_url,
             SUM(COALESCE(NULLIF(item->>'paid_price', '')::numeric, 0) * COALESCE(NULLIF(item->>'quantity', '')::int, 1))::float8 AS revenue,
             SUM(COALESCE(NULLIF(item->>'quantity', '')::int, 1))::int AS units
      FROM "StoreOrder" o
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(o."rawDetails"->'data'->'order_items', '[]'::jsonb)) AS item
      LEFT JOIN "ProductMaster" p ON p."storeId" = o."storeId" AND p."darazItemId" = item->>'product_id'
      WHERE o."storeId" IN (${Prisma.join(storeIds)})
        AND o."statusGroup" IN (${Prisma.join(PAID_GROUPS)})
        AND o."orderCreatedAt" >= ${since}
      GROUP BY 1
      ORDER BY revenue DESC
      LIMIT 10
    `,
    db.$queryRaw<Array<{ category: string; revenue: number; units: number }>>`
      SELECT COALESCE(p."rawDetails"->'data'->>'primary_category', p."rawDetails"->>'primary_category', 'Uncategorised') AS category,
             SUM(COALESCE(NULLIF(item->>'paid_price', '')::numeric, 0) * COALESCE(NULLIF(item->>'quantity', '')::int, 1))::float8 AS revenue,
             SUM(COALESCE(NULLIF(item->>'quantity', '')::int, 1))::int AS units
      FROM "StoreOrder" o
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(o."rawDetails"->'data'->'order_items', '[]'::jsonb)) AS item
      LEFT JOIN "ProductMaster" p ON p."storeId" = o."storeId" AND p."darazItemId" = item->>'product_id'
      WHERE o."storeId" IN (${Prisma.join(storeIds)})
        AND o."statusGroup" IN (${Prisma.join(PAID_GROUPS)})
        AND o."orderCreatedAt" >= ${since}
      GROUP BY 1
      ORDER BY revenue DESC
      LIMIT 10
    `,
    db.$queryRaw<Array<{ units: number }>>`
      SELECT COALESCE(SUM(COALESCE("itemCount", 0)), 0)::int AS units
      FROM "StoreOrder"
      WHERE "storeId" IN (${Prisma.join(storeIds)})
        AND "statusGroup" IN (${Prisma.join(PAID_GROUPS)})
        AND "orderCreatedAt" >= ${since}
    `,
    db.$queryRaw<Array<{ units: number }>>`
      SELECT COALESCE(SUM(COALESCE("itemCount", 0)), 0)::int AS units
      FROM "StoreOrder"
      WHERE "storeId" IN (${Prisma.join(storeIds)})
        AND "statusGroup" IN (${Prisma.join(PAID_GROUPS)})
        AND "orderCreatedAt" >= ${previousSince}
        AND "orderCreatedAt" < ${since}
    `,
    db.$queryRaw<Array<{ item_id: string }>>`
      SELECT DISTINCT item->>'product_id' AS item_id
      FROM "StoreOrder" o
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(o."rawDetails"->'data'->'order_items', '[]'::jsonb)) AS item
      WHERE o."storeId" IN (${Prisma.join(storeIds)})
        AND o."statusGroup" IN (${Prisma.join(PAID_GROUPS)})
        AND o."orderCreatedAt" >= ${since}
    `,
  ]);

  const recentActivity = await db.auditLog.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 10,
    include: { store: { select: { label: true } } },
  });

  const soldIds = [...new Set(soldRows.map((row) => row.item_id).filter(Boolean))].slice(0, 5000);
  const stockWhere = { storeId: { in: storeIds }, quantity: { gt: 0, lte: 5 } } as const;
  const deadWhere = soldIds.length
    ? { storeId: { in: storeIds }, quantity: { gt: 0 }, product: { darazItemId: { notIn: soldIds } } }
    : { storeId: { in: storeIds }, quantity: { gt: 0 } };

  const [outOfStock, lowStock, deadStock, lowStockVariants, deadProducts] = await Promise.all([
    db.productVariant.count({ where: { storeId: { in: storeIds }, quantity: { lte: 0 } } }),
    db.productVariant.count({ where: stockWhere }),
    db.productVariant.count({ where: deadWhere }),
    db.productVariant.findMany({
      where: stockWhere,
      orderBy: { quantity: "asc" },
      take: 5,
      select: { id: true, sku: true, quantity: true, product: { select: { name: true } }, store: { select: { label: true } } },
    }),
    db.productVariant.findMany({
      where: deadWhere,
      take: 5,
      select: { id: true, sku: true, quantity: true, product: { select: { name: true } }, store: { select: { label: true } } },
    }),
  ]);

  const sumByStore = (rows: Array<{ storeId: string; _count: { _all: number } }>) =>
    Object.fromEntries(rows.map((row) => [row.storeId, row._count._all]));
  const salesRow = (rows: typeof currentSales, id: string) => rows.find((row) => row.storeId === id);
  const groupsFor = (id: string) => currentGroups.filter((row) => row.storeId === id);
  const groupCount = (id: string, group: string) => groupsFor(id).find((row) => row.statusGroup === group)?._count._all ?? 0;

  const currentTotals = stores.map((store) => {
    const current = salesRow(currentSales, store.id);
    const previous = salesRow(previousSales, store.id);
    return {
      id: store.id,
      sales: Number(current?._sum.amount ?? 0),
      paidOrders: current?._count._all ?? 0,
      previousSales: Number(previous?._sum.amount ?? 0),
      previousPaidOrders: previous?._count._all ?? 0,
    };
  });
  const totalSales = currentTotals.reduce((total, row) => total + row.sales, 0);

  const ranked = [...currentTotals].sort((a, b) => b.sales - a.sales);
  const previousRanked = [...currentTotals].sort((a, b) => b.previousSales - a.previousSales);

  const units = Number(unitsRows[0]?.units ?? 0);
  const previousUnits = Number(previousUnitsRows[0]?.units ?? 0);
  const orders = currentGroups.reduce((total, row) => total + row._count._all, 0);
  const previousOrders = previousGroupCounts.reduce((total, row) => total + row._count._all, 0);
  const paidOrders = currentSales.reduce((total, row) => total + row._count._all, 0);
  const previousSalesTotal = previousSales.reduce((total, row) => total + Number(row._sum.amount ?? 0), 0);
  const previousPaidOrders = previousSales.reduce((total, row) => total + row._count._all, 0);
  const ordersByGroup: Record<string, number> = {};
  for (const row of currentGroups) {
    const key = row.statusGroup ?? "other";
    ordersByGroup[key] = (ordersByGroup[key] ?? 0) + row._count._all;
  }

  const statusByDay = new Map(statusDayRows.map((row) => [row.day.toISOString().slice(0, 10), row]));
  const statusTrend = Array.from({ length: days }, (_, index) => {
    const date = new Date(since);
    date.setUTCDate(since.getUTCDate() + index);
    const key = date.toISOString().slice(0, 10);
    const row = statusByDay.get(key);
    return { date: key, orders: Number(row?.orders ?? 0), canceled: Number(row?.canceled ?? 0), returned: Number(row?.returned ?? 0) };
  });

  const trendPoints = Array.from({ length: days }, (_, index) => {
    const date = new Date(since);
    date.setUTCDate(since.getUTCDate() + index);
    return { date: date.toISOString().slice(0, 10), total: 0, byStore: {} as Record<string, number> };
  });
  // Daily trend per store, aggregated from the same orders used by the chart.
  const trendRows = await db.$queryRaw<Array<{ day: Date; storeId: string; total: number }>>`
    SELECT DATE("orderCreatedAt") AS day, "storeId", COALESCE(SUM("amount"), 0)::float8 AS total
    FROM "StoreOrder"
    WHERE "storeId" IN (${Prisma.join(storeIds)})
      AND "statusGroup" IN (${Prisma.join(PAID_GROUPS)})
      AND "orderCreatedAt" >= ${since}
    GROUP BY 1, 2
  `;
  for (const row of trendRows) {
    const key = row.day.toISOString().slice(0, 10);
    const point = trendPoints.find((entry) => entry.date === key);
    if (!point) continue;
    const amount = Number(row.total ?? 0);
    point.total += amount;
    point.byStore[row.storeId] = amount;
  }

  const todayKey = new Date().toISOString().slice(0, 10);
  const today = trendPoints.find((point) => point.date === todayKey)?.total ?? 0;
  const last7 = trendPoints.slice(-7).reduce((total, point) => total + point.total, 0);
  const aov = paidOrders ? totalSales / paidOrders : 0;
  const previousAov = previousPaidOrders ? previousSalesTotal / previousPaidOrders : 0;
  const now = new Date();
  const categories = categoryRows.map((row) => ({
    category: row.category,
    revenue: Number(row.revenue ?? 0),
    units: Number(row.units ?? 0),
    share: 0,
  }));
  const categoryRevenue = categories.reduce((total, row) => total + row.revenue, 0);
  for (const category of categories) category.share = categoryRevenue ? round2((category.revenue / categoryRevenue) * 100) : 0;

  return {
    range: { days, from: since.toISOString(), storeId: storeId ?? null },
    totals: {
      sales: totalSales,
      paidOrders,
      orders,
      products: products.reduce((total, row) => total + row._count._all, 0),
      variants: variants.reduce((total, row) => total + row._count._all, 0),
      stores: stores.length,
      connected: stores.filter((store) => storeStatus(store) === "connected").length,
      units,
      aov: round2(aov),
      unitsPerOrder: paidOrders ? round2(units / paidOrders) : 0,
    },
    previous: {
      sales: previousSalesTotal,
      paidOrders: previousPaidOrders,
      orders: previousOrders,
      units: previousUnits,
      aov: round2(previousAov),
    },
    comparison: {
      salesPct: percentChange(totalSales, previousSalesTotal),
      ordersPct: percentChange(orders, previousOrders),
      aovPct: percentChange(aov, previousAov),
      unitsPct: percentChange(units, previousUnits),
    },
    windows: { today, last7 },
    trend: { days, points: trendPoints },
    statusTrend,
    ordersByGroup,
    stores: stores.map((store) => {
      const current = currentTotals.find((row) => row.id === store.id);
      const currentRank = ranked.findIndex((row) => row.id === store.id) + 1;
      const previousRank = previousRanked.findIndex((row) => row.id === store.id) + 1;
      const orderTotal = groupsFor(store.id).reduce((total, row) => total + row._count._all, 0);
      const ageHours = store.orderSyncLastAt ? (now.getTime() - store.orderSyncLastAt.getTime()) / 3_600_000 : null;
      let score = 100;
      if (ageHours === null) score = 40;
      else score -= Math.min(50, ageHours / 2);
      if (store.orderSyncError) score -= 20;
      if (store.productSyncError) score -= 10;
      score = Math.max(0, Math.round(score));
      return {
        id: store.id,
        label: store.label,
        country: store.country,
        storeType: store.storeType,
        status: storeStatus(store),
        orders: orderTotal,
        paidOrders: current?.paidOrders ?? 0,
        sales: current?.sales ?? 0,
        previousSales: current?.previousSales ?? 0,
        salesDeltaPct: percentChange(current?.sales ?? 0, current?.previousSales ?? 0),
        salesShare: totalSales ? round2(((current?.sales ?? 0) / totalSales) * 100) : 0,
        canceled: groupCount(store.id, "canceled"),
        returned: groupCount(store.id, "returned"),
        products: products.find((row) => row.storeId === store.id)?._count._all ?? 0,
        variants: variants.find((row) => row.storeId === store.id)?._count._all ?? 0,
        lastOrderSyncAt: store.orderSyncLastAt,
        lastProductSyncAt: store.productSyncLastAt,
        orderSyncError: store.orderSyncError,
        productSyncError: store.productSyncError,
        syncHealth: { score, lastOrderAgeHours: ageHours === null ? null : round2(ageHours) },
        rank: currentRank,
        previousRank,
      };
    }),
    storeOptions,
    topProducts: topRows.map((row) => ({
      itemId: row.item_id,
      name: row.name,
      sku: row.sku,
      imageUrl: row.image_url,
      revenue: Number(row.revenue ?? 0),
      units: Number(row.units ?? 0),
    })),
    categories,
    stock: {
      outOfStock,
      lowStock,
      deadStock,
      lowStockVariants: lowStockVariants.map((variant) => ({
        id: variant.id, sku: variant.sku, quantity: variant.quantity,
        name: variant.product?.name ?? null, storeLabel: variant.store.label,
      })),
      deadProducts: deadProducts.map((variant) => ({
        id: variant.id, sku: variant.sku, quantity: variant.quantity,
        name: variant.product?.name ?? null, storeLabel: variant.store.label,
      })),
    },
    heatmap: heatRows.map((row) => ({
      dow: Number(row.dow ?? 0),
      hour: Number(row.hour ?? 0),
      revenue: Number(row.revenue ?? 0),
      orders: Number(row.orders ?? 0),
    })),
    recentActivity: recentActivity.map((entry) => ({
      id: entry.id,
      action: entry.action,
      meta: entry.meta,
      createdAt: entry.createdAt,
      storeLabel: entry.store?.label ?? null,
    })),
    generatedAt: new Date().toISOString(),
  };
}

const csvCell = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;

export function dashboardCsv(stats: DashboardStats) {
  const rows: Array<Array<unknown>> = [];
  rows.push(["Daraz Store Hub report"]);
  rows.push(["Range", `${stats.range.days} days`, "From", stats.range.from, "Store", stats.range.storeId ?? "All stores"]);
  rows.push([]);
  rows.push(["KPI", "Value", "Previous period", "Change %"]);
  rows.push(["Net sales", stats.totals.sales, stats.previous.sales, stats.comparison.salesPct ?? ""]);
  rows.push(["Orders", stats.totals.orders, stats.previous.orders, stats.comparison.ordersPct ?? ""]);
  rows.push(["Paid orders", stats.totals.paidOrders, stats.previous.paidOrders, ""]);
  rows.push(["AOV", stats.totals.aov, stats.previous.aov, stats.comparison.aovPct ?? ""]);
  rows.push(["Units", stats.totals.units, stats.previous.units, stats.comparison.unitsPct ?? ""]);
  rows.push(["Units per order", stats.totals.unitsPerOrder]);
  rows.push([]);
  rows.push(["Status", "Orders"]);
  for (const [group, count] of Object.entries(stats.ordersByGroup)) rows.push([group, count]);
  rows.push([]);
  rows.push(["Store", "Orders", "Paid orders", "Sales", "Share %", "Prev sales", "Change %", "Canceled", "Returned", "Rank", "Prev rank", "Sync health"]);
  for (const store of stats.stores) {
    rows.push([store.label, store.orders, store.paidOrders, store.sales, store.salesShare, store.previousSales, store.salesDeltaPct ?? "", store.canceled, store.returned, store.rank, store.previousRank, store.syncHealth.score]);
  }
  rows.push([]);
  rows.push(["Top products", "SKU", "Units", "Revenue"]);
  for (const product of stats.topProducts) rows.push([product.name ?? product.itemId, product.sku ?? "", product.units, product.revenue]);
  rows.push([]);
  rows.push(["Category", "Units", "Revenue", "Share %"]);
  for (const category of stats.categories) rows.push([category.category, category.units, category.revenue, category.share]);
  rows.push([]);
  rows.push(["Stock alerts", "Count"]);
  rows.push(["Out of stock", stats.stock.outOfStock]);
  rows.push(["Low stock", stats.stock.lowStock]);
  rows.push(["Dead stock (no sales in range)", stats.stock.deadStock]);
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}

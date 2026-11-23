import type { JsonRecord } from "./order-data";

export type ProductVariantData = {
  sku: string;
  darazSkuId: string | null;
  name: string | null;
  color: string | null;
  size: string | null;
  price: string | null;
  specialPrice: string | null;
  quantity: number | null;
  status: string | null;
  imageUrl: string | null;
  raw: JsonRecord;
};

export type ProductData = {
  darazItemId: string;
  name: string | null;
  brand: string | null;
  status: string | null;
  imageUrl: string | null;
  price: string | null;
  specialPrice: string | null;
  quantity: number | null;
  variation: unknown;
  variants: ProductVariantData[];
};

const record = (value: unknown): JsonRecord | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;

const scalar = (value: unknown): string | null =>
  typeof value === "string" || typeof value === "number" ? String(value) : null;

const decimal = (value: unknown): string | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value.toFixed(2);
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value).toFixed(2);
  return null;
};

const integer = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number.parseInt(value, 10);
  return null;
};

const imageOf = (value: unknown): string | null => {
  if (Array.isArray(value)) {
    const first = value.find((entry) => typeof entry === "string" && entry.length > 0);
    return typeof first === "string" ? first : null;
  }
  return typeof value === "string" && value.length > 0 ? value : null;
};

function variationOf(item: JsonRecord): { color: string | null; size: string | null; raw: unknown } {
  let raw = item.variation ?? item.saleProp ?? null;
  if (typeof raw === "string") {
    const text = raw.trim();
    try {
      raw = JSON.parse(text);
    } catch {
      const parts = Object.fromEntries(text.split(/[;,]/).map((part) => {
        const [key, ...rest] = part.split(":");
        return [key.trim(), rest.join(":").trim()];
      }));
      raw = parts;
    }
  }
  const recordValue = record(raw) ?? {};
  const color = scalar(recordValue.color_family ?? recordValue.color ?? recordValue.Colour ?? null);
  const size = scalar(recordValue.size ?? recordValue.Size ?? null);
  return { color, size, raw };
}

function variantFromSku(sku: JsonRecord, fallbackImage: string | null): ProductVariantData {
  const identifiers = [sku.SellerSku, sku.ShopSku, sku.SkuId, sku.sku_id].map(scalar).filter((value): value is string => Boolean(value));
  return {
    sku: identifiers[0] ?? "unknown-sku",
    darazSkuId: scalar(sku.SkuId ?? sku.sku_id),
    name: scalar(sku.name ?? sku.Name),
    color: scalar(sku.color ?? sku.color_family ?? record(sku.saleProp)?.color_family ?? null),
    size: scalar(sku.size ?? record(sku.saleProp)?.size ?? null),
    price: decimal(sku.price ?? sku.special_price ?? sku.sale_price),
    specialPrice: decimal(sku.special_price ?? sku.specialPrice ?? sku.sale_price),
    quantity: integer(sku.quantity ?? sku.Available ?? sku.available),
    status: scalar(sku.Status ?? sku.status),
    imageUrl: imageOf(sku.Images ?? sku.images) ?? fallbackImage,
    raw: sku,
  };
}

/** Maps a `/product/item/get` payload (or its data object) into product + variant rows. */
export function productFromDetail(item: JsonRecord, fallbackItemId: string): ProductData {
  const attributes = record(item.attributes) ?? {};
  const images = imageOf(item.images);
  const skus = Array.isArray(item.skus) ? item.skus.map(record).filter((entry): entry is JsonRecord => entry !== null) : [];
  const variants = skus.map((sku) => variantFromSku(sku, images));
  const firstPrice = variants.find((variant) => variant.price)?.price ?? null;
  const firstSpecial = variants.find((variant) => variant.specialPrice)?.specialPrice ?? null;
  const quantities = variants.map((variant) => variant.quantity).filter((value): value is number => value !== null && value >= 0);
  return {
    darazItemId: scalar(item.item_id ?? item.itemId ?? item.id) ?? fallbackItemId,
    name: scalar(attributes.name ?? item.name),
    brand: scalar(attributes.brand ?? item.brand),
    status: scalar(item.status ?? item.Status),
    imageUrl: images,
    price: decimal(item.price ?? item.sale_price) ?? firstPrice,
    specialPrice: decimal(item.special_price ?? item.specialPrice) ?? firstSpecial,
    quantity: quantities.length ? quantities.reduce((total, value) => total + value, 0) : null,
    variation: item.variation ?? null,
    variants,
  };
}

/**
 * Maps an `/order/items/get` line item into a product/variant so SKUs from new orders exist in the
 * catalog even when the products API is unavailable (Choice sellers).
 */
export function productFromOrderItem(item: JsonRecord): ProductData | null {
  const itemId = scalar(item.product_id ?? item.item_id ?? item.productId);
  if (!itemId) return null;
  const variation = variationOf(item);
  const sku = scalar(item.sku ?? item.seller_sku ?? item.shop_sku ?? item.order_item_id) ?? `order-item-${itemId}`;
  const image = scalar(item.product_main_image ?? item.product_image);
  const price = decimal(item.paid_price ?? item.unit_price ?? item.item_price);
  const variant: ProductVariantData = {
    sku,
    darazSkuId: scalar(item.sku_id ?? null),
    name: scalar(item.name),
    color: variation.color,
    size: variation.size,
    price,
    specialPrice: null,
    quantity: null,
    status: scalar(item.status),
    imageUrl: image,
    raw: item,
  };
  return {
    darazItemId: itemId,
    name: scalar(item.name),
    brand: null,
    status: scalar(item.status),
    imageUrl: image,
    price,
    specialPrice: null,
    quantity: null,
    variation: variation.raw,
    variants: [variant],
  };
}

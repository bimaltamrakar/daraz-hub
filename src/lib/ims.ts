import { randomUUID } from "node:crypto";
import { decrypt, encrypt } from "./crypto";
import { db } from "./db";
import type { ImsSetting, StoreOrder } from "@prisma/client";

export class ImsError extends Error {
  constructor(message: string, readonly code = "ims_error") {
    super(message);
    this.name = "ImsError";
  }
}

const normalizeBase = (baseUrl: string) => baseUrl.replace(/\/+$/, "").replace(/\/api$/, "");
export const normalizeTracking = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, "").trim().toUpperCase();

export type ImsConfig = {
  baseUrl: string;
  companyId: string;
  branchCode: string;
  imsUser: string;
  warehouse: string;
  paymentMode: string;
  voucherType: string;
  apiKey: string;
  username: string;
  password: string;
  apiSecret: string;
};

export async function getImsConfig(): Promise<ImsConfig> {
  const setting = await db.imsSetting.findUnique({ where: { id: "default" } });
  if (!setting) throw new ImsError("IMS is not configured yet. Add the API settings first.", "not_configured");
  const apiKey = setting.apiKeyEnc ? decrypt(setting.apiKeyEnc) : "";
  if (!setting.companyId || !setting.branchCode || !setting.imsUser || !apiKey) {
    throw new ImsError("IMS settings are incomplete. Company ID, branch, IMS user and API key are required.", "not_configured");
  }
  return {
    baseUrl: normalizeBase(setting.baseUrl),
    companyId: setting.companyId,
    branchCode: setting.branchCode,
    imsUser: setting.imsUser,
    warehouse: setting.warehouse,
    paymentMode: setting.paymentMode,
    voucherType: setting.voucherType || "TI",
    apiKey,
    username: setting.usernameEnc ? decrypt(setting.usernameEnc) : "",
    password: setting.passwordEnc ? decrypt(setting.passwordEnc) : "",
    apiSecret: setting.apiSecretEnc ? decrypt(setting.apiSecretEnc) : "",
  };
}

export function encryptSecret(value: string | undefined | null) {
  return value ? encrypt(value) : undefined;
}

async function request(path: string, init: RequestInit, token?: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const response = await fetch(path, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: "application/json, application/pdf",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new ImsError(`IMS API ${response.status}: ${text.slice(0, 300) || response.statusText}`, "http_error");
    }
    return response;
  } catch (error) {
    if (error instanceof ImsError) throw error;
    if (error instanceof Error && error.name === "AbortError") throw new ImsError("IMS request timed out.", "timeout");
    throw new ImsError(error instanceof Error ? error.message : "IMS request failed.", "network_error");
  } finally {
    clearTimeout(timer);
  }
}

const findString = (value: unknown, keys: string[], depth = 0): string | null => {
  if (!value || typeof value !== "object" || depth > 4) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findString(item, keys, depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (keys.some((candidate) => candidate.toLowerCase() === key.toLowerCase()) && typeof entry === "string" && entry.trim()) return entry;
  }
  for (const entry of Object.values(value as Record<string, unknown>)) {
    const found = findString(entry, keys, depth + 1);
    if (found) return found;
  }
  return null;
};

export async function getImsToken(config: ImsConfig): Promise<string> {
  const response = await request(`${config.baseUrl}/api/getAccessToken`, { method: "POST", body: JSON.stringify({ companyId: config.companyId, apiKey: config.apiKey }) });
  const body = await response.json();
  const token = findString(body, ["access_token", "accessToken", "token", "bearerToken"]);
  if (!token) throw new ImsError("IMS did not return an access token.", "token_missing");
  return token;
}

/** Looks up a previously saved IMS bill by our reference (the Daraz tracking number). */
export async function lookupImsBill(config: ImsConfig, reference: string): Promise<{ vchrno: string; raw: unknown } | null> {
  const token = await getImsToken(config);
  const url = new URL(`${config.baseUrl}/api/getThirdPartytranByRef`);
  url.searchParams.set("companyId", config.companyId);
  url.searchParams.set("referenceBill", reference);
  const response = await request(url.toString(), { method: "GET" }, token);
  const body = await response.json();
  const vchrno = findString(body, ["vchrno", "voucherNo", "invoiceNo", "billNo"]);
  return vchrno ? { vchrno, raw: body } : null;
}

export type ImsOrderItem = {
  itemCode: string;
  itemName: string;
  unit: string;
  quantity: number;
  rate: number;
  inRate?: number;
  remarks?: string;
};

export async function createImsBill(config: ImsConfig, input: {
  trackingNumber: string;
  orderNumber: string;
  customerName: string;
  address: string;
  mobile: string;
  pan: string;
  amount: number;
  items: ImsOrderItem[];
  remarks: string;
  paymentMode?: string;
}) {
  const now = new Date();
  const dateParts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kathmandu", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const pick = (type: string) => dateParts.find((part) => part.type === type)?.value ?? "";
  const timeParts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kathmandu", hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
  const token = await getImsToken(config);
  const payload = {
    branchCode: config.branchCode,
    user: config.imsUser,
    tender: input.amount,
    paymentMode: input.paymentMode || config.paymentMode,
    partyName: input.customerName,
    address: input.address,
    vatNo: input.pan,
    mobileNo: input.mobile,
    guid: randomUUID(),
    voucherType: config.voucherType,
    referenceBillNo: input.trackingNumber,
    remarks: input.remarks,
    transactionDate: `${pick("year")}-${pick("month")}-${pick("day")}`,
    transactionTime: timeParts,
    companyId: config.companyId,
    MWarehouse: config.warehouse,
    prod: input.items,
  };
  const response = await request(`${config.baseUrl}/api/thirdPartyBillSave`, { method: "POST", body: JSON.stringify(payload) }, token);
  const body = await response.json().catch(() => ({}));
  return { body, payload };
}

/** Fetches the original IMS PDF. Accepts PDF bytes directly or a JSON base64/url payload. */
export async function fetchImsInvoicePdf(config: ImsConfig, vchrno: string): Promise<Buffer> {
  const token = await getImsToken(config);
  const url = new URL(`${config.baseUrl}/api/printThirdPartyTransaction`);
  url.searchParams.set("vchrno", vchrno);
  url.searchParams.set("companyId", config.companyId);
  const response = await request(url.toString(), { method: "POST" }, token);
  const contentType = response.headers.get("content-type") ?? "";
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.subarray(0, 5).toString() === "%PDF-") return buffer;
  if (contentType.includes("application/pdf")) return buffer;
  let body: any = null;
  try { body = JSON.parse(buffer.toString("utf8")); } catch { /* not JSON */ }
  const base64 = findString(body, ["pdf", "pdfBase64", "base64", "file"]);
  if (base64) {
    const decoded = Buffer.from(base64.replace(/^data:application\/pdf;base64,/, ""), "base64");
    if (decoded.subarray(0, 5).toString() === "%PDF-") return decoded;
  }
  const pdfUrl = findString(body, ["pdfUrl", "url", "fileUrl"]);
  if (pdfUrl) {
    const pdfResponse = await fetch(pdfUrl);
    if (pdfResponse.ok) {
      const pdfBuffer = Buffer.from(await pdfResponse.arrayBuffer());
      if (pdfBuffer.subarray(0, 5).toString() === "%PDF-") return pdfBuffer;
    }
  }
  throw new ImsError("IMS returned an invoice but no PDF content.", "pdf_missing");
}

export function invoiceNumberFromResponse(body: unknown): string | null {
  return findString(body, ["vchrno", "voucherNo", "invoiceNo", "billNo", "invoice_number"]);
}

export function invoiceDateFromResponse(body: unknown): Date | null {
  const raw = findString(body, ["transactionDate", "invoiceDate", "date"]);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function buildOrderItems(order: StoreOrder, rawDetails: unknown): ImsOrderItem[] {
  const data = (rawDetails as any)?.data ?? rawDetails ?? {};
  const items: any[] = Array.isArray(data.order_items) ? data.order_items : [];
  return items.map((item) => {
    const quantity = Number(item.quantity ?? 1) || 1;
    const rate = Number(item.paid_price ?? item.unit_price ?? 0) || 0;
    return {
      itemCode: String(item.shop_sku ?? item.sku ?? item.order_item_id ?? ""),
      itemName: String(item.name ?? "Daraz item"),
      unit: "Pcs",
      quantity,
      rate,
      remarks: `Daraz order ${order.darazOrderId}`,
    };
  }).filter((item) => item.itemCode);
}

export function buildBillPayloadSummary(order: StoreOrder, config: ImsConfig, items: ImsOrderItem[]) {
  return {
    orderNumber: order.darazOrderId,
    trackingNumber: normalizeTracking(order.trackingNumber),
    customerName: order.customerName ?? "Daraz customer",
    amount: Number(order.amount ?? 0),
    companyId: config.companyId,
    branchCode: config.branchCode,
    warehouse: config.warehouse,
    itemCount: items.length,
  };
}

export type ImsSettingRow = ImsSetting;

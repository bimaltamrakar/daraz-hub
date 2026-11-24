import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(process.cwd(), "private", "ims-invoices");

export const sanitizeTracking = (tracking: string) => tracking.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120) || "invoice";

function kathmanduParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kathmandu", year: "numeric", month: "2-digit" }).formatToParts(date);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return { year: pick("year"), month: pick("month") };
}

/** Saves the original IMS PDF under private/ims-invoices/YYYY/MM and returns a relative path. */
export async function saveInvoicePdf(trackingNumber: string, pdf: Buffer, date = new Date()) {
  if (pdf.subarray(0, 5).toString() !== "%PDF-") throw new Error("IMS PDF response is not a valid PDF.");
  const { year, month } = kathmanduParts(date);
  const directory = path.join(ROOT, year, month);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = `${sanitizeTracking(trackingNumber)}.pdf`;
  const absolute = path.join(directory, filename);
  await writeFile(absolute, pdf, { mode: 0o600 });
  return path.relative(ROOT, absolute).split(path.sep).join("/");
}

/** Resolves a stored relative path and rejects traversal outside the private invoice root. */
export function resolveInvoicePath(relativePath: string) {
  const absolute = path.resolve(ROOT, relativePath);
  if (absolute !== ROOT && !absolute.startsWith(`${ROOT}${path.sep}`)) throw new Error("Invalid invoice path.");
  return absolute;
}

export async function readInvoicePdf(relativePath: string) {
  const absolute = resolveInvoicePath(relativePath);
  const pdf = await readFile(absolute);
  if (pdf.subarray(0, 5).toString() !== "%PDF-") throw new Error("Stored invoice is not a valid PDF.");
  return { pdf, absolute };
}

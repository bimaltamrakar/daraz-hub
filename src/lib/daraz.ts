import { createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import { darazRegions } from "./config";

const idSchema = z.union([z.string(), z.number()]).transform((value) => String(value));
const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive(),
  refresh_expires_in: z.number().int().nonnegative().default(0),
  country: z.string().optional(),
  account: z.string().optional(),
  account_platform: z.string().optional(),
  account_id: idSchema.optional(),
  country_user_info: z.array(z.object({
    country: z.string().optional(),
    seller_id: idSchema.optional(),
    user_id: idSchema.optional(),
    short_code: z.string().optional(),
  }).passthrough()).optional(),
}).passthrough();

const sellerProfileSchema = z.object({
  seller_id: idSchema.optional(),
  name: z.string().optional(),
  name_company: z.string().optional(),
  email: z.string().optional(),
  short_code: z.string().optional(),
  status: z.string().optional(),
  verified: z.union([z.boolean(), z.string()]).optional(),
  location: z.string().optional(),
  cb: z.union([z.boolean(), z.string()]).optional(),
}).passthrough();

export type DarazTokenResponse = {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
  sellerId?: string;
  /** Daraz login account (usually the seller's email). */
  account?: string;
  accountPlatform?: string;
  /** Country reported by Daraz for this authorization, lower-cased by Daraz (e.g. "np"). */
  country?: string;
  darazUserId?: string;
  shortCode?: string;
};

export type DarazSellerProfile = {
  sellerId?: string;
  name?: string;
  companyName?: string;
  email?: string;
  shortCode?: string;
  status?: string;
  verified?: boolean;
  location?: string;
  crossBorder?: boolean;
  /** Full profile payload as returned by Daraz, for display and future use. */
  raw: Record<string, unknown>;
};

export function regionFor(country: string) {
  const region = darazRegions[country.toUpperCase()];
  if (!region) throw new Error(`Daraz integration is not configured for ${country.toUpperCase()}.`);
  return region;
}

/**
 * Daraz serves its REST gateway per marketplace (for example https://api.daraz.com.np/rest).
 * The generic api.daraz.com host used in older docs does not resolve, so when no apiBaseUrl is
 * configured we derive the gateway from the marketplace's authorize URL host.
 */
export function apiBaseUrl(country: string) {
  const region = regionFor(country);
  if (region.apiBaseUrl) return region.apiBaseUrl.replace(/\/+$/, "");
  return `${new URL(region.authorizeUrl).origin}/rest`;
}

export function createOAuthState() {
  return randomBytes(32).toString("base64url");
}

export function authorizationUrl(country: string, state: string) {
  const region = regionFor(country);
  const url = new URL(region.authorizeUrl);
  url.searchParams.set("client_id", region.appKey);
  url.searchParams.set("redirect_uri", region.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("force_auth", "true");
  url.searchParams.set("state", state);
  return url.toString();
}

export function signLazopRequest(path: string, parameters: Record<string, string>, secret: string) {
  const canonical = Object.keys(parameters)
    .filter((key) => key !== "sign")
    .sort()
    .map((key) => `${key}${parameters[key]}`)
    .join("");
  return createHmac("sha256", secret)
    .update(`${path}${canonical}`, "utf8")
    .digest("hex")
    .toUpperCase();
}

export function safeDarazErrorMessage(country: string, message: string, sensitiveValues: string[] = []) {
  const region = darazRegions[country.toUpperCase()];
  const secrets = [region?.appKey, region?.appSecret, ...sensitiveValues].filter((value): value is string => Boolean(value));
  let safeMessage = message.slice(0, 500);
  for (const secret of secrets) safeMessage = safeMessage.split(secret).join("[redacted]");
  return safeMessage.replace(
    /(?:app_secret|app_key|access_token|refresh_token|code|sign)=([^&\s]+)/gi,
    (match) => `${match.slice(0, match.indexOf("=") + 1)}[redacted]`,
  );
}

/** Performs a signed Lazop call and returns the parsed JSON body after Daraz-level error checks. */
async function callDaraz(
  country: string,
  path: string,
  method: "GET" | "POST",
  apiParameters: Record<string, string>,
  sensitiveValues: string[],
): Promise<Record<string, unknown>> {
  const region = regionFor(country);
  const parameters = {
    ...apiParameters,
    app_key: region.appKey,
    sign_method: "sha256",
    timestamp: Date.now().toString(),
  };
  const form = new URLSearchParams({ ...parameters, sign: signLazopRequest(path, parameters, region.appSecret) });
  const label = `Daraz ${path} API`;
  const endpoint = `${apiBaseUrl(country)}${path}`;
  let response: Response;
  try {
    response = method === "GET"
      ? await fetch(`${endpoint}?${form}`, { method, signal: AbortSignal.timeout(15000) })
      : await fetch(endpoint, {
        method,
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: form,
        signal: AbortSignal.timeout(15000),
      });
  } catch (error) {
    const cause = error instanceof Error && "cause" in error ? error.cause : undefined;
    const causeCode = cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string"
      ? cause.code
      : undefined;
    const reason = error instanceof Error && error.name === "TimeoutError"
      ? "request timed out"
      : causeCode
        ? `network error ${causeCode}`
        : "network request failed";
    throw new Error(`${label} ${reason} (host ${new URL(endpoint).host}). Check outbound HTTPS connectivity, DNS, and TLS from the app container.`);
  }

  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}.`);

  let responseBody: unknown;
  try {
    responseBody = await response.json();
  } catch {
    throw new Error(`${label} returned an invalid JSON response.`);
  }

  if (!responseBody || typeof responseBody !== "object" || Array.isArray(responseBody)) {
    throw new Error(`${label} returned an invalid response.`);
  }

  const body = responseBody as Record<string, unknown>;
  if (body.code !== undefined && body.code !== 0 && body.code !== "0") {
    const detail = typeof body.message === "string" ? ` ${body.message.slice(0, 200)}` : "";
    throw new Error(safeDarazErrorMessage(country, `${label} rejected the request (${String(body.code)}).${detail}`, sensitiveValues));
  }
  return body;
}

const dataOf = (body: Record<string, unknown>) =>
  body.data && typeof body.data === "object" && !Array.isArray(body.data) ? body.data as Record<string, unknown> : body;

async function requestToken(country: string, path: string, tokenParameter: "code" | "refresh_token", value: string): Promise<DarazTokenResponse> {
  const body = await callDaraz(country, path, "POST", { [tokenParameter]: value }, [value]);
  const parsed = tokenResponseSchema.safeParse(dataOf(body));
  if (!parsed.success) throw new Error("Daraz token API response is missing valid token or expiry fields.");

  if (parsed.data.refresh_expires_in > 0 && !parsed.data.refresh_token) {
    throw new Error("Daraz token API response is missing a refresh token.");
  }

  const now = Date.now();
  // Daraz returns one entry per marketplace the account can access. Prefer the entry for this
  // store's marketplace and fall back to the first entry (cross-border accounts report "cb").
  const entries = parsed.data.country_user_info ?? [];
  const countryInfo = entries.find((entry) => entry.country?.toUpperCase() === country.toUpperCase()) ?? entries[0];
  const token: DarazTokenResponse = {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token ?? "",
    accessExpiresAt: new Date(now + parsed.data.expires_in * 1000),
    refreshExpiresAt: new Date(now + parsed.data.refresh_expires_in * 1000),
  };
  const sellerId = countryInfo?.seller_id;
  const darazUserId = countryInfo?.user_id ?? parsed.data.account_id;
  const tokenCountry = countryInfo?.country ?? parsed.data.country;
  if (sellerId !== undefined) token.sellerId = sellerId;
  if (darazUserId !== undefined) token.darazUserId = darazUserId;
  if (countryInfo?.short_code) token.shortCode = countryInfo.short_code;
  if (tokenCountry) token.country = tokenCountry;
  if (parsed.data.account) token.account = parsed.data.account;
  if (parsed.data.account_platform) token.accountPlatform = parsed.data.account_platform;
  return token;
}

export function exchangeAuthorizationCode(country: string, code: string) {
  return requestToken(country, "/auth/token/create", "code", code);
}

export function refreshDarazToken(country: string, refreshToken: string) {
  return requestToken(country, "/auth/token/refresh", "refresh_token", refreshToken);
}

export function fetchDarazOrders(
  country: string,
  accessToken: string,
  options: { createdAfter: string; limit: number; offset: number },
) {
  return callDaraz(country, "/orders/get", "GET", {
    access_token: accessToken,
    CreatedAfter: options.createdAfter,
    limit: String(options.limit),
    offset: String(options.offset),
    sort_by: "updated_at",
  }, [accessToken]);
}

export function fetchDarazOrderDetails(country: string, accessToken: string, orderId: string) {
  return callDaraz(country, "/order/get", "GET", { access_token: accessToken, order_id: orderId }, [accessToken]);
}

export function fetchDarazProductDetails(country: string, accessToken: string, itemId: string) {
  return callDaraz(country, "/product/item/get", "GET", { access_token: accessToken, item_id: itemId }, [accessToken]);
}

export function fetchDarazProducts(
  country: string,
  accessToken: string,
  options: { updatedAfter?: string; limit: number; offset: number },
) {
  return callDaraz(country, "/products/get", "GET", {
    access_token: accessToken,
    filter: "all",
    ...(options.updatedAfter ? { update_after: options.updatedAfter } : {}),
    limit: String(options.limit),
    offset: String(options.offset),
  }, [accessToken]);
}

const toBoolean = (value: boolean | string | undefined) =>
  value === undefined ? undefined : typeof value === "boolean" ? value : value.toLowerCase() === "true";

/** Fetches the authorized seller's profile (GET /seller/get) using a valid access token. */
export async function fetchSellerProfile(country: string, accessToken: string): Promise<DarazSellerProfile> {
  const body = await callDaraz(country, "/seller/get", "GET", { access_token: accessToken }, [accessToken]);
  const raw = dataOf(body);
  const parsed = sellerProfileSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Daraz /seller/get API returned an unexpected seller profile.");
  const profile: DarazSellerProfile = { raw };
  if (parsed.data.seller_id !== undefined) profile.sellerId = parsed.data.seller_id;
  if (parsed.data.name) profile.name = parsed.data.name;
  if (parsed.data.name_company) profile.companyName = parsed.data.name_company;
  if (parsed.data.email) profile.email = parsed.data.email;
  if (parsed.data.short_code) profile.shortCode = parsed.data.short_code;
  if (parsed.data.status) profile.status = parsed.data.status;
  if (parsed.data.location) profile.location = parsed.data.location;
  const verified = toBoolean(parsed.data.verified);
  if (verified !== undefined) profile.verified = verified;
  const crossBorder = toBoolean(parsed.data.cb);
  if (crossBorder !== undefined) profile.crossBorder = crossBorder;
  return profile;
}

export function documentedHmac(secret: string, value: string) {
  return createHmac("sha256", secret).update(value, "utf8").digest("hex").toUpperCase();
}

import { createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import { darazRegions } from "./config";

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive(),
  refresh_expires_in: z.number().int().nonnegative().default(0),
  country_user_info: z.array(z.object({
    country: z.string().optional(),
    seller_id: z.union([z.string(), z.number()]).optional(),
  }).passthrough()).optional(),
}).passthrough();

export type DarazTokenResponse = {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
  sellerId?: string;
};

export function regionFor(country: string) {
  const region = darazRegions[country.toUpperCase()];
  if (!region) throw new Error(`Daraz integration is not configured for ${country.toUpperCase()}.`);
  return region;
}

function apiBaseUrl(country: string) {
  const region = regionFor(country);
  return (region.apiBaseUrl ?? "https://api.daraz.com/rest").replace(/\/+$/, "");
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

async function requestToken(country: string, path: string, tokenParameter: "code" | "refresh_token", value: string): Promise<DarazTokenResponse> {
  const region = regionFor(country);
  const parameters = {
    app_key: region.appKey,
    [tokenParameter]: value,
    sign_method: "sha256",
    timestamp: Date.now().toString(),
  };
  const form = new URLSearchParams({
    ...parameters,
    sign: signLazopRequest(path, parameters, region.appSecret),
  });
  const response = await fetch(`${apiBaseUrl(country)}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: form,
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) throw new Error(`Daraz token API returned HTTP ${response.status}.`);

  let responseBody: unknown;
  try {
    responseBody = await response.json();
  } catch {
    throw new Error("Daraz token API returned an invalid JSON response.");
  }

  if (!responseBody || typeof responseBody !== "object" || Array.isArray(responseBody)) {
    throw new Error("Daraz token API returned an invalid response.");
  }

  const body = responseBody as Record<string, unknown>;
  if (body.code !== undefined && body.code !== 0 && body.code !== "0") {
    const detail = typeof body.message === "string" ? ` ${body.message.slice(0, 200)}` : "";
    throw new Error(`Daraz token API rejected the request (${String(body.code)}).${detail}`);
  }
  const tokenData = body.data && typeof body.data === "object" && !Array.isArray(body.data)
    ? body.data
    : body;
  const parsed = tokenResponseSchema.safeParse(tokenData);
  if (!parsed.success) throw new Error("Daraz token API response is missing valid token or expiry fields.");

  if (parsed.data.refresh_expires_in > 0 && !parsed.data.refresh_token) {
    throw new Error("Daraz token API response is missing a refresh token.");
  }

  const now = Date.now();
  const countryInfo = parsed.data.country_user_info?.find((entry) => entry.country?.toUpperCase() === country.toUpperCase());
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token ?? "",
    accessExpiresAt: new Date(now + parsed.data.expires_in * 1000),
    refreshExpiresAt: new Date(now + parsed.data.refresh_expires_in * 1000),
    ...(countryInfo?.seller_id !== undefined ? { sellerId: String(countryInfo.seller_id) } : {}),
  };
}

export function exchangeAuthorizationCode(country: string, code: string) {
  return requestToken(country, "/auth/token/create", "code", code);
}

export function refreshDarazToken(country: string, refreshToken: string) {
  return requestToken(country, "/auth/token/refresh", "refresh_token", refreshToken);
}

export function documentedHmac(secret: string, value: string) {
  return createHmac("sha256", secret).update(value, "utf8").digest("hex").toUpperCase();
}

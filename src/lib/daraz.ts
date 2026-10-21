import { createHmac, randomBytes } from "node:crypto";
import { darazRegions } from "./config";

export function regionFor(country: string) {
  const region = darazRegions[country.toUpperCase()];
  if (!region) throw new Error(`Daraz integration is not configured for ${country.toUpperCase()}.`);
  return region;
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
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeAuthorizationCode(country: string, code: string): Promise<never> {
  const region = regionFor(country);
  if (region.signingMode !== "daraz-docs-confirmed") {
    throw new Error("OAuth token exchange is disabled until the Daraz signing rules are verified for this app.");
  }
  // Signing is intentionally not implemented from an inferred convention.
  // Confirm the exact canonicalization and response fields in the app's Daraz documentation first.
  void region;
  void code;
  throw new Error("Daraz token exchange requires the verified signing adapter.");
}

export async function refreshDarazToken(country: string, refreshToken: string): Promise<never> {
  const region = regionFor(country);
  if (region.signingMode !== "daraz-docs-confirmed") {
    throw new Error("Token refresh is disabled until the Daraz signing rules are verified for this app.");
  }
  void region;
  void refreshToken;
  throw new Error("Daraz token refresh requires the verified signing adapter.");
}

export function documentedHmac(secret: string, value: string) {
  return createHmac("sha256", secret).update(value, "utf8").digest("hex").toUpperCase();
}

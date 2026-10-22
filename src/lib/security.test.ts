import { afterEach, describe, expect, it, vi } from "vitest";
import { decrypt, encrypt } from "./crypto";
import { createOAuthState, documentedHmac, exchangeAuthorizationCode, refreshDarazToken, regionFor, signLazopRequest } from "./daraz";
import { isOAuthStateUsable, isRefreshTokenUsable, ownedStoreFilter } from "./policies";

describe("secret handling", () => {
  it("encrypts tokens with authenticated encryption and decrypts them", () => {
    const token = "sensitive-access-token";
    const ciphertext = encrypt(token);
    expect(ciphertext).not.toContain(token);
    expect(decrypt(ciphertext)).toBe(token);
  });

  it("supports encrypting an empty refresh token when Daraz disables refresh", () => {
    expect(decrypt(encrypt(""))).toBe("");
  });

  it("rejects tampered ciphertext", () => {
    const ciphertext = encrypt("sensitive-refresh-token").split(".");
    ciphertext[2] = `${ciphertext[2].slice(0, -2)}AA`;
    expect(() => decrypt(ciphertext.join("."))).toThrow();
  });
});

describe("Daraz integration configuration", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("creates unpredictable OAuth states", () => {
    const first = createOAuthState();
    const second = createOAuthState();
    expect(first).not.toBe(second);
    expect(first.length).toBeGreaterThanOrEqual(40);
  });

  describe("OAuth and authorization policies", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");

    it("consumes only unused and unexpired OAuth state", () => {
      expect(isOAuthStateUsable({ used: false, expiresAt: new Date(now.getTime() + 1000) }, now)).toBe(true);
      expect(isOAuthStateUsable({ used: true, expiresAt: new Date(now.getTime() + 1000) }, now)).toBe(false);
      expect(isOAuthStateUsable({ used: false, expiresAt: now }, now)).toBe(false);
    });

    it("allows refresh only while its refresh credential is unexpired", () => {
      expect(isRefreshTokenUsable(new Date(now.getTime() + 1), now)).toBe(true);
      expect(isRefreshTokenUsable(now, now)).toBe(false);
    });

    it("scopes store queries to both the requested store and its owner", () => {
      expect(ownedStoreFilter("store-a", "user-a")).toEqual({ id: "store-a", userId: "user-a" });
      expect(ownedStoreFilter("store-a", "user-b").userId).not.toBe("user-a");
    });
  });

  it("fails closed for an unconfigured marketplace", () => {
    expect(() => regionFor("XX")).toThrow(/not configured/i);
  });

  it("uses HMAC-SHA256 with uppercase hex digest", () => {
    expect(documentedHmac("secret", "message")).toBe("8B5F48702995C1598C573DB1E21866A9B825D4A794D169D7060A03605796360B");
  });

  it("signs sorted Lazop parameters with the API path", () => {
    const params = { timestamp: "123", app_key: "key", sign_method: "sha256", code: "abc" };
    expect(signLazopRequest("/auth/token/create", params, "secret")).toBe(
      documentedHmac("secret", "/auth/token/createapp_keykeycodeabcsign_methodsha256timestamp123"),
    );
  });

  it("exchanges authorization codes and persists Daraz's token response shape", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: "access",
      refresh_token: "refresh",
      expires_in: 3600,
      refresh_expires_in: 86400,
      country_user_info: [{ country: "np", seller_id: 123 }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const token = await exchangeAuthorizationCode("NP", "auth-code");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const form = new URLSearchParams(String(init.body));
    expect(url).toBe("https://api.daraz.com/rest/auth/token/create");
    expect(init.method).toBe("POST");
    expect(form.get("app_key")).toBe("test-app-key");
    expect(form.get("code")).toBe("auth-code");
    expect(form.get("sign_method")).toBe("sha256");
    expect(form.get("sign")).toBe(signLazopRequest("/auth/token/create", {
      app_key: "test-app-key",
      code: "auth-code",
      sign_method: "sha256",
      timestamp: form.get("timestamp")!,
    }, "test-app-secret"));
    expect(token).toMatchObject({
      accessToken: "access",
      refreshToken: "refresh",
      sellerId: "123",
    });
    expect(token.accessExpiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(token.refreshExpiresAt.getTime()).toBeGreaterThan(token.accessExpiresAt.getTime());
  });

  it("refreshes using the latest refresh token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600,
      refresh_expires_in: 7200,
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const token = await refreshDarazToken("NP", "old-refresh");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URLSearchParams(String(init.body)).get("refresh_token")).toBe("old-refresh");
    expect(token).toMatchObject({ accessToken: "new-access", refreshToken: "new-refresh" });
  });

  it("rejects failed Lazop responses without exposing response tokens", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: "IllegalAccessToken",
      message: "authorization code is invalid",
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(exchangeAuthorizationCode("NP", "bad-code")).rejects.toThrow(/IllegalAccessToken/);
  });

  it("accepts a token response that explicitly disables refresh", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: "access",
      expires_in: 3600,
      refresh_expires_in: 0,
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const token = await exchangeAuthorizationCode("NP", "auth-code");
    expect(token.refreshToken).toBe("");
    expect(token.refreshExpiresAt.getTime()).toBeLessThanOrEqual(Date.now());
  });
});

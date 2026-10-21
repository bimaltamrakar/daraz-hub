import { describe, expect, it } from "vitest";
import { decrypt, encrypt } from "./crypto";
import { createOAuthState, documentedHmac, regionFor } from "./daraz";
import { isOAuthStateUsable, isRefreshTokenUsable, ownedStoreFilter } from "./policies";

describe("secret handling", () => {
  it("encrypts tokens with authenticated encryption and decrypts them", () => {
    const token = "sensitive-access-token";
    const ciphertext = encrypt(token);
    expect(ciphertext).not.toContain(token);
    expect(decrypt(ciphertext)).toBe(token);
  });

  it("rejects tampered ciphertext", () => {
    const ciphertext = encrypt("sensitive-refresh-token").split(".");
    ciphertext[2] = `${ciphertext[2].slice(0, -2)}AA`;
    expect(() => decrypt(ciphertext.join("."))).toThrow();
  });
});

describe("Daraz integration configuration", () => {
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
    expect(() => regionFor("NP")).toThrow(/not configured/i);
  });

  it("uses HMAC-SHA256 with uppercase hex digest", () => {
    expect(documentedHmac("secret", "message")).toBe("8B5F48702995C1598C573DB1E21866A9B825D4A794D169D7060A03605796360B");
  });
});

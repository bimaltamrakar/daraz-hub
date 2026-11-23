import { encrypt, decrypt } from "./crypto";
import { refreshDarazToken } from "./daraz";
import { isRefreshTokenUsable } from "./policies";
import { db } from "./db";

/** Returns a usable Daraz access token, refreshing and persisting it when it is about to expire. */
export async function fetchAccessToken(store: {
  country: string;
  tokens: { storeId: string; accessTokenEnc: string; refreshTokenEnc: string; accessExpiresAt: Date; refreshExpiresAt: Date } | null;
}) {
  if (!store.tokens) throw new Error("Store has no Daraz token. Connect the store before syncing.");
  let accessToken = decrypt(store.tokens.accessTokenEnc);
  if (store.tokens.accessExpiresAt.getTime() > Date.now() + 60_000) return accessToken;
  if (!isRefreshTokenUsable(store.tokens.refreshExpiresAt)) {
    throw new Error("Daraz access token has expired and its refresh token is no longer valid. Reconnect the store.");
  }

  const refreshed = await refreshDarazToken(store.country, decrypt(store.tokens.refreshTokenEnc));
  accessToken = refreshed.accessToken;
  await db.storeToken.update({
    where: { storeId: store.tokens.storeId },
    data: {
      accessTokenEnc: encrypt(refreshed.accessToken),
      refreshTokenEnc: encrypt(refreshed.refreshToken),
      accessExpiresAt: refreshed.accessExpiresAt,
      refreshExpiresAt: refreshed.refreshExpiresAt,
      lastRefreshedAt: new Date(),
      lastError: null,
    },
  });
  await db.store.update({ where: { id: store.tokens.storeId }, data: { status: "connected" } });
  return accessToken;
}

import { Prisma } from "@prisma/client";

export function ownedStoreFilter(storeId: string, userId: string): Prisma.StoreWhereInput {
  return { id: storeId, userId };
}

export function isOAuthStateUsable(state: { used: boolean; expiresAt: Date }, now = new Date()) {
  return !state.used && state.expiresAt > now;
}

export function isRefreshTokenUsable(refreshExpiresAt: Date, now = new Date()) {
  return refreshExpiresAt > now;
}

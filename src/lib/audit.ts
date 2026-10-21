import { Prisma } from "@prisma/client";
import { db } from "./db";

export function audit(action: string, userId?: string, storeId?: string, meta?: Prisma.InputJsonObject) {
  return db.auditLog.create({
    data: {
      action,
      ...(userId ? { user: { connect: { id: userId } } } : {}),
      ...(storeId ? { store: { connect: { id: storeId } } } : {}),
      ...(meta ? { meta } : {}),
    },
  });
}

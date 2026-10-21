import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { db } from "./db";
import { config } from "./config";

export type AuthUser = { id: string; role: "admin" | "user"; mustChangePassword: boolean };
declare global {
  namespace Express { interface Request { auth?: AuthUser } }
}

export function authenticate(req: Request, res: Response, next: NextFunction) {
  const token = req.header("authorization")?.replace(/^Bearer /i, "");
  if (!token) return res.status(401).json({ error: "Authentication required." });
  try {
    req.auth = jwt.verify(token, config.JWT_ACCESS_SECRET) as AuthUser;
    return next();
  } catch {
    return res.status(401).json({ error: "Session expired. Please sign in again." });
  }
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.auth?.role !== "admin") return res.status(403).json({ error: "Admin access required." });
  return next();
}

export async function activeUser(req: Request, res: Response, next: NextFunction) {
  const user = await db.user.findUnique({ where: { id: req.auth!.id } });
  if (!user?.isActive) return res.status(403).json({ error: "Account is inactive." });
  if (user.mustChangePassword && req.path !== "/auth/password") {
    return res.status(403).json({ error: "Change your password before continuing.", code: "PASSWORD_CHANGE_REQUIRED" });
  }
  return next();
}

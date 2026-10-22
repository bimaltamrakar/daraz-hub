import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { db } from "./lib/db";
import { config } from "./lib/config";
import { audit } from "./lib/audit";
import { encrypt, sha256 } from "./lib/crypto";
import { authenticate, activeUser, requireAdmin } from "./lib/auth";
import { authorizationUrl, createOAuthState, exchangeAuthorizationCode, refreshDarazToken, type DarazTokenResponse } from "./lib/daraz";
import { isOAuthStateUsable, isRefreshTokenUsable, ownedStoreFilter } from "./lib/policies";

const app = express();
app.set("trust proxy", 1);
app.use(helmet());
app.use(cors({ origin: config.APP_ORIGIN, credentials: true }));
app.use(express.json({ limit: "32kb" }));
app.use(cookieParser());

const rateLimits = new Map<string, { count: number; resetAt: number }>();
function rateLimit(limit: number, windowMs: number) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    const entry = rateLimits.get(key);
    if (!entry || entry.resetAt <= now) rateLimits.set(key, { count: 1, resetAt: now + windowMs });
    else if (++entry.count > limit) return res.status(429).json({ error: "Too many requests. Try again later." });
    return next();
  };
}

function issueAccessToken(user: { id: string; role: "admin" | "user"; mustChangePassword: boolean }) {
  return jwt.sign(user, config.JWT_ACCESS_SECRET, { expiresIn: config.ACCESS_TOKEN_TTL as jwt.SignOptions["expiresIn"] });
}
function setRefreshCookie(res: express.Response, token: string) {
  res.cookie("refresh_token", token, {
    httpOnly: true, secure: config.COOKIE_SECURE === "true", sameSite: "strict",
    path: "/api/auth", maxAge: config.REFRESH_TOKEN_TTL_DAYS * 86400000,
  });
}
async function newSession(userId: string, res: express.Response) {
  const raw = randomBytes(48).toString("base64url");
  await db.session.create({
    data: { userId, tokenHash: sha256(raw), expiresAt: new Date(Date.now() + config.REFRESH_TOKEN_TTL_DAYS * 86400000) },
  });
  setRefreshCookie(res, raw);
}
const publicUser = (user: { id: string; name: string; email: string; role: string; mustChangePassword: boolean }) => ({
  id: user.id, name: user.name, email: user.email, role: user.role, mustChangePassword: user.mustChangePassword,
});
function displayStoreStatus(store: { status: string; tokens?: { accessExpiresAt: Date; refreshExpiresAt: Date } | null }) {
  if (!store.tokens) return store.status;
  const now = Date.now();
  if (store.tokens.accessExpiresAt.getTime() <= now || store.tokens.refreshExpiresAt.getTime() <= now) return "expired";
  if (store.status === "error") return "error";
  if (store.tokens.refreshExpiresAt.getTime() <= now + 7 * 86400000) return "expiring_soon";
  return "connected";
}
async function saveDarazTokens(storeId: string, tokens: DarazTokenResponse, refreshed: boolean) {
  const tokenData = {
    accessTokenEnc: encrypt(tokens.accessToken),
    refreshTokenEnc: encrypt(tokens.refreshToken),
    accessExpiresAt: tokens.accessExpiresAt,
    refreshExpiresAt: tokens.refreshExpiresAt,
    lastRefreshedAt: refreshed ? new Date() : null,
    lastError: null,
  };
  await db.$transaction([
    db.storeToken.upsert({
      where: { storeId },
      create: { storeId, ...tokenData },
      update: tokenData,
    }),
    db.store.update({
      where: { id: storeId },
      data: { status: "connected", ...(tokens.sellerId ? { sellerId: tokens.sellerId } : {}) },
    }),
  ]);
}
const passwordSchema = z.string().min(12).max(128).regex(/[a-z]/).regex(/[A-Z]/).regex(/[0-9]/).regex(/[^A-Za-z0-9]/);
const authRouter = express.Router();

authRouter.post("/signup", rateLimit(5, 3600000), async (req, res) => {
  const parsed = z.object({ name: z.string().trim().min(1).max(100), email: z.string().email().max(254), password: passwordSchema }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Provide a valid name, email and strong password." });
  const email = parsed.data.email.toLowerCase();
  if (await db.user.findUnique({ where: { email } })) return res.status(409).json({ error: "An account with this email already exists." });
  const { password, ...profile } = parsed.data;
  const user = await db.user.create({ data: { ...profile, email, passwordHash: await bcrypt.hash(password, 12) } });
  await audit("signup", user.id);
  await newSession(user.id, res);
  return res.status(201).json({ accessToken: issueAccessToken({ id: user.id, role: user.role, mustChangePassword: false }), user: publicUser(user) });
});

authRouter.post("/login", rateLimit(8, 900000), async (req, res) => {
  const parsed = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(128) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid email or password." });
  const user = await db.user.findUnique({ where: { email: parsed.data.email.toLowerCase() } });
  if (!user || !user.isActive || !(await bcrypt.compare(parsed.data.password, user.passwordHash))) {
    return res.status(401).json({ error: "Invalid email or password." });
  }
  await audit("login", user.id);
  await newSession(user.id, res);
  return res.json({ accessToken: issueAccessToken({ id: user.id, role: user.role, mustChangePassword: user.mustChangePassword }), user: publicUser(user) });
});

authRouter.post("/refresh", rateLimit(20, 60000), async (req, res) => {
  const raw = req.cookies.refresh_token;
  if (!raw) return res.status(401).json({ error: "Sign in again to continue." });
  const session = await db.session.findUnique({ where: { tokenHash: sha256(raw) }, include: { user: true } });
  if (!session || session.expiresAt <= new Date() || !session.user.isActive) {
    res.clearCookie("refresh_token", { path: "/api/auth" });
    return res.status(401).json({ error: "Sign in again to continue." });
  }
  await db.session.delete({ where: { id: session.id } });
  await newSession(session.userId, res);
  return res.json({ accessToken: issueAccessToken({ id: session.user.id, role: session.user.role, mustChangePassword: session.user.mustChangePassword }), user: publicUser(session.user) });
});

authRouter.post("/logout", async (req, res) => {
  const raw = req.cookies.refresh_token;
  if (raw) await db.session.deleteMany({ where: { tokenHash: sha256(raw) } });
  res.clearCookie("refresh_token", { path: "/api/auth" });
  return res.status(204).end();
});

authRouter.post("/password", authenticate, async (req, res) => {
  const parsed = z.object({ currentPassword: z.string().min(1), newPassword: passwordSchema }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "New password must be at least 12 characters and include upper/lowercase, a number and a symbol." });
  const user = await db.user.findUniqueOrThrow({ where: { id: req.auth!.id } });
  if (!(await bcrypt.compare(parsed.data.currentPassword, user.passwordHash))) return res.status(400).json({ error: "Current password is incorrect." });
  await db.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(parsed.data.newPassword, 12), mustChangePassword: false } });
  await db.session.deleteMany({ where: { userId: user.id } });
  await newSession(user.id, res);
  return res.json({ accessToken: issueAccessToken({ id: user.id, role: user.role, mustChangePassword: false }) });
});
app.use("/api/auth", authRouter);

app.get("/api/oauth/daraz/callback", async (req, res) => {
  const parsed = z.object({ code: z.string().min(1).optional(), state: z.string().min(1), error: z.string().optional() })
    .refine(({ code, error }) => Boolean(code || error)).safeParse(req.query);
  if (!parsed.success) return res.status(400).send("Invalid OAuth callback.");
  const saved = await db.oAuthState.findUnique({ where: { state: parsed.data.state }, include: { store: true } });
  if (!saved || !isOAuthStateUsable(saved)) return res.status(400).send("OAuth state is invalid or expired.");
  const consumed = await db.oAuthState.updateMany({ where: { state: saved.state, used: false, expiresAt: { gt: new Date() } }, data: { used: true } });
  if (consumed.count !== 1) return res.status(400).send("OAuth state has already been used.");
  if (parsed.data.error) {
    await db.store.update({ where: { id: saved.storeId }, data: { status: "error" } });
    await audit("store_connection_failed", saved.userId, saved.storeId);
    return res.redirect(`${config.APP_ORIGIN}/stores?error=daraz_authorization_denied`);
  }
  if (!parsed.data.code) return res.status(400).send("OAuth callback did not include an authorization code.");
  try {
    const tokens = await exchangeAuthorizationCode(saved.store.country, parsed.data.code);
    await saveDarazTokens(saved.storeId, tokens, false);
    await audit("store_connected", saved.userId, saved.storeId);
    return res.redirect(`${config.APP_ORIGIN}/stores?connected=true`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Daraz token exchange error.";
    console.error("Daraz token exchange failed:", message.slice(0, 500));
    await db.store.update({ where: { id: saved.storeId }, data: { status: "error" } });
    await db.storeToken.updateMany({ where: { storeId: saved.storeId }, data: { lastError: message.slice(0, 500) } });
    await audit("store_connection_failed", saved.userId, saved.storeId);
    return res.redirect(`${config.APP_ORIGIN}/stores?error=daraz_connection_failed`);
  }
});

app.get("/api/openapi.yaml", (_req, res) => res.sendFile(path.resolve(__dirname, "../openapi.yaml")));
app.get("/api/openapi.json", (_req, res) => res.json({
  openapi: "3.1.0", info: { title: "Daraz Store Hub API", version: "1.0.0" },
  servers: [{ url: "/api" }],
  paths: {
    "/auth/signup": { post: { summary: "Register account" } },
    "/auth/login": { post: { summary: "Sign in" } },
    "/stores": { get: { summary: "List own stores" }, post: { summary: "Add store" } },
    "/stores/{id}/connect": { post: { summary: "Start Daraz OAuth" } },
    "/stores/{id}/refresh": { post: { summary: "Refresh store token" } },
    "/admin/users": { get: { summary: "Admin: list users" } },
  },
}));

const api = express.Router();
api.use(authenticate, activeUser);
api.get("/me", async (req, res) => res.json({ user: await db.user.findUniqueOrThrow({ where: { id: req.auth!.id }, select: { id: true, name: true, email: true, role: true, mustChangePassword: true } }) }));
api.get("/stores", async (req, res) => {
  const stores = await db.store.findMany({ where: { userId: req.auth!.id }, include: { tokens: true }, orderBy: { createdAt: "desc" } });
  return res.json(stores.map(({ tokens, ...store }) => ({ ...store, status: displayStoreStatus({ status: store.status, tokens }), accessExpiresAt: tokens?.accessExpiresAt ?? null, refreshExpiresAt: tokens?.refreshExpiresAt ?? null, lastRefreshedAt: tokens?.lastRefreshedAt ?? null, lastError: tokens?.lastError ?? null })));
});
api.post("/stores", async (req, res) => {
  const parsed = z.object({ label: z.string().trim().min(1).max(100), country: z.string().trim().length(2).transform((s) => s.toUpperCase()) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Store label and two-letter country code are required." });
  const store = await db.store.create({ data: { ...parsed.data, userId: req.auth!.id } });
  await audit("store_added", req.auth!.id, store.id);
  return res.status(201).json(store);
});
api.delete("/stores/:id", async (req, res) => {
  const id = typeof req.params.id === "string" ? req.params.id : "";
  const store = await db.store.findFirst({ where: ownedStoreFilter(id, req.auth!.id) });
  if (!store) return res.status(404).json({ error: "Store not found." });
  await db.store.delete({ where: { id: store.id } });
  await audit("store_removed", req.auth!.id, undefined, { label: store.label });
  return res.status(204).end();
});
api.post("/stores/:id/connect", async (req, res) => {
  const id = typeof req.params.id === "string" ? req.params.id : "";
  const store = await db.store.findFirst({ where: ownedStoreFilter(id, req.auth!.id) });
  if (!store) return res.status(404).json({ error: "Store not found." });
  try {
    const state = createOAuthState();
    const expiresAt = new Date(Date.now() + config.OAUTH_STATE_TTL_MINUTES * 60000);
    await db.oAuthState.create({ data: { state, userId: req.auth!.id, storeId: store.id, expiresAt } });
    return res.json({ authorizationUrl: authorizationUrl(store.country, state) });
  } catch (error) {
    await db.store.update({ where: { id: store.id }, data: { status: "error" } });
    return res.status(503).json({ error: error instanceof Error ? error.message : "Daraz integration is unavailable." });
  }
});
api.post("/stores/:id/refresh", rateLimit(10, 60000), async (req, res) => {
  const id = typeof req.params.id === "string" ? req.params.id : "";
  const store = await db.store.findFirst({ where: ownedStoreFilter(id, req.auth!.id), include: { tokens: true } });
  if (!store) return res.status(404).json({ error: "Store not found." });
  if (!store.tokens || !isRefreshTokenUsable(store.tokens.refreshExpiresAt)) return res.status(409).json({ error: "Refresh token has expired. Reconnect this store." });
  try {
    const currentRefresh = (await import("./lib/crypto")).decrypt(store.tokens.refreshTokenEnc);
    const token = await refreshDarazToken(store.country, currentRefresh);
    await saveDarazTokens(store.id, token, true);
    return res.json({ status: "connected", accessExpiresAt: token.accessExpiresAt, refreshExpiresAt: token.refreshExpiresAt });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Daraz token refresh failed.";
    await db.store.update({ where: { id: store.id }, data: { status: "error" } });
    await db.storeToken.update({ where: { storeId: store.id }, data: { lastError: message.slice(0, 500) } });
    await audit("token_refresh_failed", req.auth!.id, store.id, { reason: message.slice(0, 200) });
    return res.status(502).json({ error: message });
  }
});
api.get("/dashboard", async (req, res) => {
  const stores = await db.store.findMany({ where: { userId: req.auth!.id }, include: { tokens: true } });
  const now = Date.now();
  const summary = { total: stores.length, connected: 0, expiringSoon: 0, expired: 0 };
  for (const store of stores) {
    const status = displayStoreStatus(store);
    if (status === "connected") summary.connected++;
    else if (status === "expiring_soon") summary.expiringSoon++;
    else if (status === "expired") summary.expired++;
  }
  return res.json(summary);
});

api.get("/admin/users", requireAdmin, async (_req, res) => {
  const users = await db.user.findMany({ select: { id: true, name: true, email: true, role: true, isActive: true, createdAt: true, _count: { select: { stores: true } } }, orderBy: { createdAt: "desc" } });
  return res.json(users);
});
api.patch("/admin/users/:id", requireAdmin, async (req, res) => {
  const id = typeof req.params.id === "string" ? req.params.id : "";
  const parsed = z.object({ isActive: z.boolean().optional(), password: passwordSchema.optional() }).safeParse(req.body);
  if (!parsed.success || (parsed.data.isActive === undefined && !parsed.data.password)) return res.status(400).json({ error: "Provide isActive or a strong password." });
  const data: { isActive?: boolean; passwordHash?: string; mustChangePassword?: boolean } = {};
  if (parsed.data.isActive !== undefined) data.isActive = parsed.data.isActive;
  if (parsed.data.password) { data.passwordHash = await bcrypt.hash(parsed.data.password, 12); data.mustChangePassword = true; }
  if (!id) return res.status(400).json({ error: "Invalid user ID." });
  const user = await db.user.update({ where: { id }, data, select: { id: true, name: true, email: true, role: true, isActive: true } });
  if (parsed.data.isActive === false || parsed.data.password) await db.session.deleteMany({ where: { userId: user.id } });
  return res.json(user);
});
api.get("/admin/stores", requireAdmin, async (_req, res) => {
  const stores = await db.store.findMany({ include: { user: { select: { name: true, email: true } }, tokens: true }, orderBy: { createdAt: "desc" } });
  return res.json(stores.map(({ tokens, ...store }) => ({ ...store, status: displayStoreStatus({ status: store.status, tokens }), accessExpiresAt: tokens?.accessExpiresAt ?? null, refreshExpiresAt: tokens?.refreshExpiresAt ?? null, lastError: tokens?.lastError ?? null })));
});
api.get("/admin/audit", requireAdmin, async (_req, res) => res.json(await db.auditLog.findMany({ include: { user: { select: { email: true } }, store: { select: { label: true } } }, orderBy: { createdAt: "desc" }, take: 250 })));
app.use("/api", api);

if (config.NODE_ENV === "production") {
  const webRoot = path.resolve(__dirname, "../web");
  app.use(express.static(webRoot, { index: false, maxAge: "1h" }));
  app.get("/{*path}", (req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    return res.sendFile(path.join(webRoot, "index.html"));
  });
}

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof Error) console.error("Unhandled request error:", err.name, err.message.split("\n")[0]);
  else console.error("Unhandled request error: unknown error");
  return res.status(500).json({ error: "An unexpected error occurred." });
});
app.listen(config.PORT, () => console.log(`Daraz Store Hub API listening on ${config.PORT}`));

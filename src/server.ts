import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { OrderSyncFrequency, Prisma, StoreType, type StoreToken } from "@prisma/client";
import { db } from "./lib/db";
import { config } from "./lib/config";
import { audit } from "./lib/audit";
import { decrypt, encrypt, sha256 } from "./lib/crypto";
import { authenticate, activeUser, requireAdmin } from "./lib/auth";
import { authorizationUrl, createOAuthState, createOrderPackages, exchangeAuthorizationCode, fetchDarazOrderDetails, fetchDarazOrderItems, fetchPackageAwbDocuments, fetchSellerProfile, markPackagesReadyToShip, refreshDarazToken, safeDarazErrorMessage, type DarazTokenResponse } from "./lib/daraz";
import { isOAuthStateUsable, isRefreshTokenUsable, ownedStoreFilter } from "./lib/policies";
import { fetchAccessToken } from "./lib/access-token";
import { orderSyncFrequencies, queueStoreOrderSync, startOrderSyncWorker } from "./lib/order-sync";
import { startProductSyncWorker, queueProductSync, upsertProductsFromOrderItems } from "./lib/product-sync";
import { normalizeOrder, orderDetailRecord } from "./lib/order-data";
import { buildDashboardStats, dashboardCsv } from "./lib/dashboard";

const app = express();
app.set("trust proxy", 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      // Product images are served from Daraz CDNs.
      "img-src": ["'self'", "data:", "https:"],
    },
  },
}));
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
/** Drops undefined values so partial Daraz responses never overwrite saved details with null. */
const defined = <T extends object>(object: T) =>
  Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined)) as { [K in keyof T]?: Exclude<T[K], undefined> };
/** Store representation returned to the browser: every column except token ciphertext. */
function publicStore<T extends { tokens: StoreToken | null; status: string }>({ tokens, ...store }: T) {
  const { orderSyncLockId, orderSyncLockUntil, productSyncLockId, productSyncLockUntil, ...visibleStore } = store as T & {
    orderSyncLockId?: string | null; orderSyncLockUntil?: Date | null;
    productSyncLockId?: string | null; productSyncLockUntil?: Date | null;
  };
  return {
    ...visibleStore,
    orderSyncRunning: Boolean(orderSyncLockUntil && orderSyncLockUntil > new Date()),
    productSyncRunning: Boolean(productSyncLockUntil && productSyncLockUntil > new Date()),
    status: displayStoreStatus({ status: store.status, tokens }),
    accessExpiresAt: tokens?.accessExpiresAt ?? null,
    refreshExpiresAt: tokens?.refreshExpiresAt ?? null,
    lastRefreshedAt: tokens?.lastRefreshedAt ?? null,
    lastError: tokens?.lastError ?? null,
  };
}
const storeActivity = { orderBy: { createdAt: "desc" }, take: 20, select: { id: true, action: true, meta: true, createdAt: true } } as const;
async function saveDarazTokens(storeId: string, tokens: DarazTokenResponse, refreshed: boolean) {
  const syncSettings = refreshed ? null : await db.store.findUniqueOrThrow({
    where: { id: storeId },
    select: { orderSyncFrequency: true, storeType: true },
  });
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
      data: {
        status: "connected",
        ...(refreshed ? {} : { connectedAt: new Date() }),
        ...(!refreshed ? { orderSyncNextAt: syncSettings?.orderSyncFrequency === "manual" ? null : new Date() } : {}),
        ...(!refreshed && syncSettings?.storeType !== "choice" ? { productSyncNextAt: new Date() } : {}),
        // Seller identity reported by Daraz alongside the token; saved at authorization time.
        ...defined({
          sellerId: tokens.sellerId,
          account: tokens.account,
          accountPlatform: tokens.accountPlatform,
          darazCountry: tokens.country?.toUpperCase(),
          darazUserId: tokens.darazUserId,
          shortCode: tokens.shortCode,
        }),
      },
    }),
  ]);
}
/** Fetches and stores the seller profile. Failures are recorded on the store but never block the connection. */
async function syncSellerProfile(store: { id: string; country: string }, accessToken: string, userId: string) {
  try {
    const profile = await fetchSellerProfile(store.country, accessToken);
    await db.store.update({
      where: { id: store.id },
      data: {
        ...defined({
          sellerId: profile.sellerId,
          sellerName: profile.name,
          companyName: profile.companyName,
          sellerEmail: profile.email,
          shortCode: profile.shortCode,
          sellerStatus: profile.status,
          verified: profile.verified,
          location: profile.location,
        }),
        profile: profile.raw as Prisma.InputJsonObject,
        profileFetchedAt: new Date(),
        profileError: null,
      },
    });
    return { ok: true as const };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Daraz seller profile error.";
    const reason = safeDarazErrorMessage(store.country, message, [accessToken]);
    console.error("Daraz seller profile fetch failed:", reason);
    await db.store.update({ where: { id: store.id }, data: { profileError: reason } });
    await audit("store_profile_fetch_failed", userId, store.id, { phase: "seller_profile", reason });
    return { ok: false as const, reason };
  }
}
// Binds an OAuth state to the browser that started it, so an attacker cannot hand a victim an
// authorization link whose state points at the attacker's store. Lax is required because Daraz
// returns the seller via a cross-site top-level redirect.
const OAUTH_STATE_COOKIE = "daraz_oauth_state";
const oauthStateCookieOptions = { httpOnly: true, secure: config.COOKIE_SECURE === "true", sameSite: "lax" as const, path: "/api/oauth/daraz" };
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
  const saved = await db.oAuthState.findUnique({ where: { state: parsed.data.state }, include: { store: true, user: { select: { isActive: true } } } });
  if (!saved || !isOAuthStateUsable(saved)) return res.status(400).send("OAuth state is invalid or expired.");
  const consumed = await db.oAuthState.updateMany({ where: { state: saved.state, used: false, expiresAt: { gt: new Date() } }, data: { used: true } });
  if (consumed.count !== 1) return res.status(400).send("OAuth state has already been used.");
  const browserState = typeof req.cookies[OAUTH_STATE_COOKIE] === "string" ? req.cookies[OAUTH_STATE_COOKIE] : "";
  res.clearCookie(OAUTH_STATE_COOKIE, oauthStateCookieOptions);
  const storePage = `${config.APP_ORIGIN}/stores/${saved.storeId}`;
  if (browserState !== saved.state) {
    // Outside production the app and callback may live on different hosts (Vite + tunnel), so only warn there.
    if (config.NODE_ENV === "production") {
      await audit("store_connection_failed", saved.userId, saved.storeId, { phase: "authorization", reason: "OAuth state did not originate from this browser session." });
      return res.status(400).send("OAuth state does not belong to this browser session. Start the connection again from the hub.");
    }
    console.warn("Daraz OAuth callback arrived without the browser state cookie; allowed because NODE_ENV is not production.");
  }
  if (!saved.user.isActive) return res.status(403).send("This account is inactive.");
  if (parsed.data.error) {
    await db.store.update({ where: { id: saved.storeId }, data: { status: "error" } });
    await audit("store_connection_failed", saved.userId, saved.storeId, {
      phase: "authorization",
      reason: safeDarazErrorMessage(saved.store.country, `Seller authorization was denied (${parsed.data.error}).`),
    });
    return res.redirect(`${storePage}?error=daraz_authorization_denied`);
  }
  if (!parsed.data.code) return res.status(400).send("OAuth callback did not include an authorization code.");
  let tokens: DarazTokenResponse;
  try {
    tokens = await exchangeAuthorizationCode(saved.store.country, parsed.data.code);
    await saveDarazTokens(saved.storeId, tokens, false);
    await audit("store_connected", saved.userId, saved.storeId, defined({ sellerId: tokens.sellerId, account: tokens.account }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Daraz token exchange error.";
    const reason = safeDarazErrorMessage(saved.store.country, message, [parsed.data.code]);
    console.error("Daraz token exchange failed:", reason);
    await db.store.update({ where: { id: saved.storeId }, data: { status: "error" } });
    await db.storeToken.updateMany({ where: { storeId: saved.storeId }, data: { lastError: reason } });
    await audit("store_connection_failed", saved.userId, saved.storeId, { phase: "token_exchange", reason });
    return res.redirect(`${storePage}?error=daraz_connection_failed`);
  }
  // Capture the seller's profile while the fresh access token is in hand.
  const profile = await syncSellerProfile({ id: saved.storeId, country: saved.store.country }, tokens.accessToken, saved.userId);
  return res.redirect(`${storePage}?connected=${profile.ok ? "true" : "partial"}`);
});

app.get("/api/openapi.yaml", (_req, res) => res.sendFile(path.resolve(process.cwd(), "openapi.yaml")));
app.get("/api/openapi.json", (_req, res) => res.json({
  openapi: "3.1.0", info: { title: "Daraz Store Hub API", version: "1.0.0" },
  servers: [{ url: "/api" }],
  paths: {
    "/auth/signup": { post: { summary: "Register account" } },
    "/auth/login": { post: { summary: "Sign in" } },
    "/stores": { get: { summary: "List own stores" }, post: { summary: "Add store" } },
    "/stores/{id}": { get: { summary: "Store details and recent activity" }, delete: { summary: "Remove store" } },
    "/stores/{id}/tokens": { get: { summary: "Reveal tokens for an owned store on demand" } },
    "/stores/{id}/connect": { post: { summary: "Start Daraz OAuth" } },
    "/stores/{id}/refresh": { post: { summary: "Refresh store token" } },
    "/stores/{id}/profile": { post: { summary: "Re-fetch seller profile from Daraz" } },
    "/stores/{id}/order-sync-settings": { patch: { summary: "Configure order sync" } },
    "/stores/{id}/type": { patch: { summary: "Set seller type (normal or Choice)" } },
    "/stores/{id}/orders/sync": { post: { summary: "Queue order and product sync" } },
    "/orders": { get: { summary: "Search, filter, sort, and paginate owned orders" } },
    "/orders/summary": { get: { summary: "Status-lane and per-store counts for the current filters" } },
    "/orders/export": { get: { summary: "Export filtered orders as CSV" } },
    "/orders/{id}": { get: { summary: "Get an owned order with Daraz detail and line items" } },
    "/orders/{id}/awb": { get: { summary: "Fetch Daraz's official AWB PDF for an order" } },
    "/orders/{id}/package": { post: { summary: "Create the fulfillment package and tracking number" } },
    "/orders/{id}/rts": { post: { summary: "Mark the order's packages ready to ship (RTS)" } },
    "/products": { get: { summary: "Search and paginate owned product master" } },
    "/products/{id}": { get: { summary: "Get an owned product and its full Daraz details" } },
    "/admin/users": { get: { summary: "Admin: list users" } },
    "/admin/stores": { get: { summary: "Admin: list stores" } },
    "/admin/stores/{id}": { get: { summary: "Admin: store details" } },
  },
}));

const api = express.Router();
api.use(authenticate, activeUser);
api.get("/me", async (req, res) => res.json({ user: await db.user.findUniqueOrThrow({ where: { id: req.auth!.id }, select: { id: true, name: true, email: true, role: true, mustChangePassword: true } }) }));
api.get("/stores", async (req, res) => {
  const includeInactive = req.query.includeInactive === "1";
  const stores = await db.store.findMany({
    where: { userId: req.auth!.id, ...(includeInactive ? {} : { isActive: true }) },
    include: { tokens: true },
    orderBy: { createdAt: "desc" },
  });
  return res.json(stores.map(publicStore));
});
api.patch("/stores/:id/order-sync-settings", async (req, res) => {
  const id = typeof req.params.id === "string" ? req.params.id : "";
  const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value && parsed <= new Date();
  });
  const parsed = z.object({
    fromDate: dateSchema,
    frequency: z.nativeEnum(OrderSyncFrequency),
  }).safeParse(req.body);
  if (!parsed.success || !orderSyncFrequencies.includes(parsed.data.frequency)) {
    return res.status(400).json({ error: "Provide a valid sync start date and frequency." });
  }
  const store = await db.store.findFirst({ where: ownedStoreFilter(id, req.auth!.id) });
  if (!store) return res.status(404).json({ error: "Store not found." });
  if (store.orderSyncLockUntil && store.orderSyncLockUntil > new Date()) {
    return res.status(409).json({ error: "Wait for the current order sync to finish before changing its settings." });
  }
  const fromDate = new Date(`${parsed.data.fromDate}T00:00:00.000Z`);
  const updateResult = await db.store.updateMany({
    where: {
      id: store.id,
      userId: req.auth!.id,
      OR: [{ orderSyncLockUntil: null }, { orderSyncLockUntil: { lt: new Date() } }],
    },
    data: {
      orderSyncFrom: fromDate,
      orderSyncFrequency: parsed.data.frequency,
      ...(store.orderSyncFrom.getTime() !== fromDate.getTime() ? { orderSyncCursor: null, orderSyncLastAt: null, orderBackfillCursor: null, orderBackfillDone: false } : {}),
      orderSyncNextAt: parsed.data.frequency === "manual" ? null : new Date(),
      orderSyncError: null,
    },
  });
  if (updateResult.count !== 1) return res.status(409).json({ error: "Wait for the current order sync to finish before changing its settings." });
  const updated = await db.store.findUniqueOrThrow({ where: { id: store.id }, include: { tokens: true } });
  return res.json(publicStore(updated));
});
api.post("/stores/:id/orders/sync", rateLimit(5, 60000), async (req, res) => {
  const id = typeof req.params.id === "string" ? req.params.id : "";
  const store = await db.store.findFirst({ where: ownedStoreFilter(id, req.auth!.id), include: { tokens: true } });
  if (!store) return res.status(404).json({ error: "Store not found." });
  if (!store.tokens) return res.status(409).json({ error: "Connect this store before syncing orders." });
  if (!store.isActive) return res.status(409).json({ error: "This store is inactive. Activate it in store settings before syncing." });
  if (!(await queueStoreOrderSync(store.id))) return res.status(409).json({ error: "An order sync is already running for this store." });
  return res.status(202).json({ status: "queued", message: "Order and product sync has been queued." });
});
api.patch("/stores/:id/active", async (req, res) => {
  const id = typeof req.params.id === "string" ? req.params.id : "";
  const parsed = z.object({ isActive: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Provide isActive (true or false)." });
  const store = await db.store.findFirst({ where: ownedStoreFilter(id, req.auth!.id) });
  if (!store) return res.status(404).json({ error: "Store not found." });
  const updated = await db.store.update({
    where: { id: store.id },
    data: {
      isActive: parsed.data.isActive,
      ...(parsed.data.isActive ? {} : { orderSyncNextAt: null, productSyncNextAt: null, orderSyncLockId: null, orderSyncLockUntil: null, productSyncLockId: null, productSyncLockUntil: null }),
    },
    include: { tokens: true },
  });
  await audit(parsed.data.isActive ? "store_activated" : "store_deactivated", req.auth!.id, store.id);
  return res.json(publicStore(updated));
});
api.patch("/stores/:id/type", async (req, res) => {
  const id = typeof req.params.id === "string" ? req.params.id : "";
  const parsed = z.object({ storeType: z.nativeEnum(StoreType) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Provide a valid seller type (normal or choice)." });
  const store = await db.store.findFirst({ where: ownedStoreFilter(id, req.auth!.id) });
  if (!store) return res.status(404).json({ error: "Store not found." });
  const updated = await db.store.update({
    where: { id: store.id },
    data: { storeType: parsed.data.storeType },
    include: { tokens: true },
  });
  await audit("store_type_updated", req.auth!.id, store.id, { storeType: parsed.data.storeType });
  return res.json(publicStore(updated));
});
api.post("/stores/:id/products/sync", rateLimit(5, 60000), async (req, res) => {
  const id = typeof req.params.id === "string" ? req.params.id : "";
  const store = await db.store.findFirst({ where: ownedStoreFilter(id, req.auth!.id), include: { tokens: true } });
  if (!store) return res.status(404).json({ error: "Store not found." });
  if (!store.tokens) return res.status(409).json({ error: "Connect this store before syncing products." });
  if (store.storeType === "choice") {
    return res.status(409).json({ error: "Choice sellers cannot use the Daraz products API. Their SKUs are added automatically from orders." });
  }
  if (!store.isActive) return res.status(409).json({ error: "This store is inactive. Activate it in store settings before syncing products." });
  if (!(await queueProductSync(store.id))) return res.status(409).json({ error: "A product sync is already running for this store." });
  return res.status(202).json({ status: "queued", message: "Product catalog sync queued." });
});
api.post("/stores/:id/products/resync", rateLimit(5, 60000), async (req, res) => {
  const id = typeof req.params.id === "string" ? req.params.id : "";
  const store = await db.store.findFirst({ where: ownedStoreFilter(id, req.auth!.id), include: { tokens: true } });
  if (!store) return res.status(404).json({ error: "Store not found." });
  if (!store.tokens) return res.status(409).json({ error: "Connect this store before resyncing products." });
  if (store.storeType === "choice") {
    return res.status(409).json({ error: "Choice sellers cannot use the Daraz products API. Their SKUs are added automatically from orders." });
  }
  if (!store.isActive) return res.status(409).json({ error: "This store is inactive. Activate it in store settings before resyncing products." });
  if (store.productSyncLockUntil && store.productSyncLockUntil > new Date()) {
    return res.status(409).json({ error: "A product sync is already running for this store." });
  }
  await db.store.update({
    where: { id: store.id },
    data: {
      productSyncLastAt: null,
      productSyncOffset: 0,
      productSyncNextAt: new Date(),
      productSyncError: null,
      productSyncLockId: null,
      productSyncLockUntil: null,
    },
  });
  await audit("store_products_full_resync", req.auth!.id, store.id);
  void queueProductSync(store.id).catch((error: unknown) => {
    console.error("Full product resync could not start:", error instanceof Error ? error.message : "Unknown worker error.");
  });
  return res.status(202).json({ status: "queued", message: "Full product resync queued from the start of the catalog." });
});
api.get("/stores/:id", async (req, res) => {
  const id = typeof req.params.id === "string" ? req.params.id : "";
  const store = await db.store.findFirst({ where: ownedStoreFilter(id, req.auth!.id), include: { tokens: true, auditLogs: storeActivity, _count: { select: { orders: true, products: true } } } });
  if (!store) return res.status(404).json({ error: "Store not found." });
  const { auditLogs, ...rest } = store;
  return res.json({ ...publicStore(rest), activity: auditLogs });
});
api.get("/stores/:id/tokens", rateLimit(10, 60000), async (req, res) => {
  res.set("Cache-Control", "no-store, private");
  res.set("Pragma", "no-cache");
  const id = typeof req.params.id === "string" ? req.params.id : "";
  const store = await db.store.findFirst({
    where: ownedStoreFilter(id, req.auth!.id),
    include: { tokens: true },
  });
  if (!store) return res.status(404).json({ error: "Store not found." });
  if (!store.tokens) return res.status(409).json({ error: "This store has no Daraz tokens. Connect it first." });

  const accessToken = decrypt(store.tokens.accessTokenEnc);
  const refreshToken = decrypt(store.tokens.refreshTokenEnc);
  await audit("store_tokens_viewed", req.auth!.id, store.id);
  return res.json({ accessToken, refreshToken });
});
api.post("/stores/:id/profile", rateLimit(10, 60000), async (req, res) => {
  const id = typeof req.params.id === "string" ? req.params.id : "";
  const store = await db.store.findFirst({ where: ownedStoreFilter(id, req.auth!.id), include: { tokens: true } });
  if (!store) return res.status(404).json({ error: "Store not found." });
  if (!store.tokens || store.tokens.accessExpiresAt <= new Date()) return res.status(409).json({ error: "A valid access token is required. Get a new access token or reconnect this store first." });
  const result = await syncSellerProfile(store, decrypt(store.tokens.accessTokenEnc), req.auth!.id);
  if (!result.ok) return res.status(502).json({ error: result.reason });
  const updated = await db.store.findUniqueOrThrow({ where: { id: store.id }, include: { tokens: true } });
  return res.json(publicStore(updated));
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
    res.cookie(OAUTH_STATE_COOKIE, state, { ...oauthStateCookieOptions, maxAge: config.OAUTH_STATE_TTL_MINUTES * 60000 });
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
  let currentRefresh = "";
  try {
    currentRefresh = decrypt(store.tokens.refreshTokenEnc);
    const token = await refreshDarazToken(store.country, currentRefresh);
    await saveDarazTokens(store.id, token, true);
    return res.json({ status: "connected", accessExpiresAt: token.accessExpiresAt, refreshExpiresAt: token.refreshExpiresAt });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Daraz token refresh failed.";
    const reason = safeDarazErrorMessage(store.country, message, [currentRefresh]);
    await db.store.update({ where: { id: store.id }, data: { status: "error" } });
    await db.storeToken.update({ where: { storeId: store.id }, data: { lastError: reason } });
    await audit("token_refresh_failed", req.auth!.id, store.id, { phase: "token_refresh", reason });
    return res.status(502).json({ error: reason });
  }
});
api.get("/dashboard", async (req, res) => {
  const stores = await db.store.findMany({ where: { userId: req.auth!.id, isActive: true }, include: { tokens: true } });
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
api.get("/dashboard/stats", async (req, res) => {
  const parsed = z.object({ days: z.coerce.number().int().min(7).max(90).default(14), storeId: z.string().optional() }).safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Invalid dashboard range." });
  if (parsed.data.storeId) {
    const store = await db.store.findFirst({ where: { id: parsed.data.storeId, userId: req.auth!.id, isActive: true } });
    if (!store) return res.status(404).json({ error: "Store not found." });
  }
  return res.json(await buildDashboardStats(req.auth!.id, parsed.data.days, parsed.data.storeId));
});
api.get("/dashboard/export", async (req, res) => {
  const parsed = z.object({ days: z.coerce.number().int().min(7).max(90).default(14), storeId: z.string().optional() }).safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Invalid dashboard range." });
  if (parsed.data.storeId) {
    const store = await db.store.findFirst({ where: { id: parsed.data.storeId, userId: req.auth!.id, isActive: true } });
    if (!store) return res.status(404).json({ error: "Store not found." });
  }
  const stats = await buildDashboardStats(req.auth!.id, parsed.data.days, parsed.data.storeId);
  const label = parsed.data.storeId ? stats.stores[0]?.label ?? "store" : "all-stores";
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="daraz-report-${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${stats.range.days}d.csv"`);
  return res.send(dashboardCsv(stats));
});
const orderStatusGroups = ["unpaid", "to_ship", "shipping", "delivered", "failed_delivery", "canceled", "returned"] as const;
const orderListFilters = z.object({
  storeId: z.string().trim().max(100).optional(),
  statusGroup: z.enum(orderStatusGroups).optional(),
  orderStatus: z.string().trim().max(100).optional(),
  search: z.string().trim().max(200).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
const orderSortFields = {
  customerName: "customerName",
  orderId: "darazOrderId",
  createdAt: "orderCreatedAt",
  updatedAt: "orderUpdatedAt",
  orderStatus: "orderStatus",
  deliveryStatus: "deliveryStatus",
  trackingNumber: "trackingNumber",
  amount: "amount",
} as const;
const ownsStore = async (storeId: string, userId: string) =>
  Boolean(await db.store.findFirst({ where: { id: storeId, userId, isActive: true }, select: { id: true } }));
function orderWhere(filters: z.infer<typeof orderListFilters>, userId: string): Prisma.StoreOrderWhereInput {
  const where: Prisma.StoreOrderWhereInput = {
    store: { userId, isActive: true, ...(filters.storeId ? { id: filters.storeId } : {}) },
  };
  const and: Prisma.StoreOrderWhereInput[] = [];
  // Daraz's To Ship lane contains pending (to pack), packed (to arrange shipment) and
  // ready_to_ship (to handover) orders, even when the raw status list also includes delivered.
  if (filters.statusGroup === "to_ship") {
    and.push({ OR: [
      { statusGroup: "unpaid", orderStatus: { contains: "pending", mode: "insensitive" } },
      { statusGroup: "to_ship", orderStatus: { contains: "packed", mode: "insensitive" } },
      { orderStatus: { contains: "ready_to_ship", mode: "insensitive" } },
    ] });
  } else if (filters.statusGroup === "unpaid") {
    where.statusGroup = "unpaid";
    and.push({ NOT: { orderStatus: { contains: "pending", mode: "insensitive" } } });
  } else if (filters.statusGroup) {
    where.statusGroup = filters.statusGroup;
  }

  if (filters.orderStatus) {
    switch (filters.orderStatus) {
      case "to_pack":
        where.statusGroup = "unpaid";
        and.push({ orderStatus: { contains: "pending", mode: "insensitive" } });
        break;
      case "to_arrange":
        where.statusGroup = "to_ship";
        and.push({ orderStatus: { contains: "packed", mode: "insensitive" } });
        break;
      case "to_handover":
        and.push({ orderStatus: { contains: "ready_to_ship", mode: "insensitive" } });
        break;
      default:
        and.push({ orderStatus: { contains: filters.orderStatus, mode: "insensitive" } });
    }
  }

  if (filters.from || filters.to) {
    where.orderCreatedAt = {
      ...(filters.from ? { gte: filters.from } : {}),
      ...(filters.to ? { lt: new Date(filters.to.getTime() + 86_400_000) } : {}),
    };
  }
  if (filters.search) {
    and.push({ OR: [
      { darazOrderId: { contains: filters.search, mode: "insensitive" } },
      { customerName: { contains: filters.search, mode: "insensitive" } },
      { trackingNumber: { contains: filters.search, mode: "insensitive" } },
      { orderStatus: { contains: filters.search, mode: "insensitive" } },
    ] });
  }
  if (and.length) where.AND = and;
  return where;
}
api.get("/orders", async (req, res) => {
  const parsed = orderListFilters.extend({
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
    sortBy: z.enum(["customerName", "orderId", "createdAt", "updatedAt", "orderStatus", "deliveryStatus", "trackingNumber", "amount"]).default("createdAt"),
    sortOrder: z.enum(["asc", "desc"]).default("desc"),
  }).safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Invalid order list filters." });
  const filters = parsed.data;
  if (filters.from && filters.to && filters.from > filters.to) return res.status(400).json({ error: "The start date must be before the end date." });
  if (filters.storeId && !(await ownsStore(filters.storeId, req.auth!.id))) return res.status(404).json({ error: "Store not found." });
  const where = orderWhere(filters, req.auth!.id);
  const [total, orders] = await Promise.all([
    db.storeOrder.count({ where }),
    db.storeOrder.findMany({
      where,
      orderBy: [{ [orderSortFields[filters.sortBy]]: filters.sortOrder }, { id: "asc" }],
      skip: (filters.page - 1) * filters.pageSize,
      take: filters.pageSize,
      select: {
        id: true, storeId: true, darazOrderId: true, customerName: true,
        orderCreatedAt: true, orderUpdatedAt: true, orderStatus: true, statusGroup: true,
        deliveryStatus: true, trackingNumber: true, amount: true, itemCount: true, syncedAt: true,
        store: { select: { label: true, country: true, storeType: true } },
      },
    }),
  ]);
  return res.json({ orders, page: filters.page, pageSize: filters.pageSize, total, totalPages: Math.ceil(total / filters.pageSize) });
});
api.get("/orders/summary", async (req, res) => {
  const parsed = orderListFilters.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Invalid order filters." });
  const filters = parsed.data;
  if (filters.storeId && !(await ownsStore(filters.storeId, req.auth!.id))) return res.status(404).json({ error: "Store not found." });
  // Lane counts are only useful once a store is selected; skip the aggregate entirely for "All stores"
  // so the page does not scan the whole order table on every load.
  if (!filters.storeId) return res.json({ groups: {} });
  const where = orderWhere({ ...filters, statusGroup: undefined, orderStatus: undefined }, req.auth!.id);
  const rows = await db.storeOrder.groupBy({
    by: ["statusGroup", "orderStatus"],
    where,
    _count: { _all: true },
  });
  let unpaid = 0;
  let toPack = 0;
  let toArrange = 0;
  let toHandover = 0;
  let shipping = 0;
  for (const row of rows) {
    if (row.statusGroup === "canceled") continue;
    const raw = (row.orderStatus ?? "").toLowerCase();
    const count = row._count._all;
    if (row.statusGroup === "unpaid") {
      if (raw.includes("pending")) toPack += count;
      else unpaid += count;
    } else if (row.statusGroup === "to_ship") {
      if (raw.includes("packed")) toArrange += count;
      else if (raw.includes("ready_to_ship")) toHandover += count;
    } else if (raw.includes("ready_to_ship")) {
      toHandover += count;
    }
    if (row.statusGroup === "shipping") shipping += count;
  }
  return res.json({
    groups: { unpaid, to_ship: toPack + toArrange + toHandover, shipping },
    toShip: { to_pack: toPack, to_arrange: toArrange, to_handover: toHandover },
  });
});
api.get("/orders/export", rateLimit(10, 60000), async (req, res) => {
  const parsed = orderListFilters.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Invalid order filters." });
  const filters = parsed.data;
  if (filters.storeId && !(await ownsStore(filters.storeId, req.auth!.id))) return res.status(404).json({ error: "Store not found." });
  const orders = await db.storeOrder.findMany({
    where: orderWhere(filters, req.auth!.id),
    orderBy: { orderCreatedAt: "desc" },
    select: {
      darazOrderId: true, customerName: true, orderCreatedAt: true, orderStatus: true,
      deliveryStatus: true, trackingNumber: true, amount: true, itemCount: true,
      store: { select: { label: true } },
    },
  });
  const header = ["Order ID", "Store", "Customer", "Created (UTC)", "Status", "Delivery", "Tracking", "Amount", "Items"];
  const rows = orders.map((order) => [
    order.darazOrderId, order.store.label, order.customerName ?? "", order.orderCreatedAt.toISOString(),
    order.orderStatus ?? "", order.deliveryStatus ?? "", order.trackingNumber ?? "",
    order.amount?.toString() ?? "", order.itemCount ?? "",
  ]);
  const csv = [header, ...rows]
    .map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(","))
    .join("\r\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="daraz-orders-${new Date().toISOString().slice(0, 10)}.csv"`);
  return res.send(csv);
});
api.get("/orders/:id", rateLimit(30, 60000), async (req, res) => {
  const id = typeof req.params.id === "string" ? req.params.id : "";
  const order = await db.storeOrder.findFirst({ where: { id, store: { userId: req.auth!.id, isActive: true } } });
  if (!order) return res.status(404).json({ error: "Order not found." });
  // List sync stores the order summary; the full detail (items, address, tracking) is loaded on
  // first view and then cached in rawDetails. `?refresh=1` forces a re-fetch from Daraz.
  const raw = order.rawDetails as { data?: { order_items?: unknown } } | null;
  const cachedItems = raw && typeof raw === "object" ? raw.data?.order_items : undefined;
  if (req.query.refresh !== "1" && Array.isArray(cachedItems) && cachedItems.length > 0) return res.json(order);
  const store = await db.store.findFirst({ where: { id: order.storeId }, include: { tokens: true } });
  if (!store?.tokens) return res.status(409).json({ error: "Reconnect this store to load order details." });
  try {
    const accessToken = await fetchAccessToken(store);
    const detailBody = await fetchDarazOrderDetails(store.country, accessToken, order.darazOrderId);
    let items: Record<string, unknown>[] = [];
    try {
      const itemsBody = await fetchDarazOrderItems(store.country, accessToken, order.darazOrderId);
      items = Array.isArray((itemsBody as { data?: unknown }).data) ? (itemsBody as { data: Record<string, unknown>[] }).data : [];
    } catch {
      items = [];
    }
    const detail = orderDetailRecord(detailBody);
    const detailData = (detailBody as { data?: Record<string, unknown> }).data ?? {};
    const mergedRaw = { ...(detailBody as Record<string, unknown>), data: { ...detailData, order_items: items } };
    const normalized = normalizeOrder({ ...detail, order_items: items }, order.darazOrderId);
    const updated = await db.storeOrder.update({
      where: { id: order.id },
      data: { ...normalized, rawDetails: mergedRaw as Prisma.InputJsonValue, itemsSyncedAt: new Date(), syncedAt: new Date() },
    });
    await upsertProductsFromOrderItems(order.storeId, items);
    return res.json(updated);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load order details from Daraz.";
    return res.status(502).json({ error: safeDarazErrorMessage(store.country, message) });
  }
});
api.get("/orders/:id/awb", rateLimit(20, 60000), async (req, res) => {
  const id = typeof req.params.id === "string" ? req.params.id : "";
  const order = await db.storeOrder.findFirst({
    where: { id, store: { userId: req.auth!.id } },
    include: { store: { include: { tokens: true } } },
  });
  if (!order) return res.status(404).json({ error: "Order not found." });
  if (!order.store.tokens) return res.status(409).json({ error: "Reconnect this store before printing an AWB." });
  if (!order.store.isActive) return res.status(409).json({ error: "This store is inactive. Activate it before printing AWBs." });
  if (order.store.storeType === "choice") return res.status(409).json({ error: "This is a Choice seller store; Daraz handles fulfilment and AWB printing.", choiceSeller: true });

  let accessToken: string;
  let items: Record<string, unknown>[] = [];
  try {
    accessToken = await fetchAccessToken(order.store);
    const itemsBody = await fetchDarazOrderItems(order.store.country, accessToken, order.darazOrderId);
    items = Array.isArray((itemsBody as { data?: unknown }).data) ? (itemsBody as { data: Record<string, unknown>[] }).data : [];
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load this order from Daraz.";
    return res.status(502).json({ error: safeDarazErrorMessage(order.store.country, message) });
  }

  const packages = [...new Set(items.map((item) => String(item.package_id ?? "")).filter(Boolean))];
  if (!packages.length) {
    return res.status(409).json({ error: "Daraz has not created a package or tracking number for this order yet.", canMarkShipping: false });
  }

  try {
    const documentBody = await fetchPackageAwbDocuments(order.store.country, accessToken, packages);
    const result = (documentBody as { result?: { success?: boolean; error_msg?: string; error_code?: string; data?: { pdf_url?: string } } }).result;
    if (result?.success && result.data?.pdf_url) {
      return res.json({ source: "daraz", pdfUrl: result.data.pdf_url, packages, trackingNumber: order.trackingNumber ?? null });
    }
    const message = result?.error_msg ?? "Daraz did not return an AWB PDF for this order.";
    return res.status(result?.error_code === "30017" ? 409 : 502).json({
      error: safeDarazErrorMessage(order.store.country, message),
      code: result?.error_code ?? null,
      canMarkShipping: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Daraz did not return an AWB PDF for this order.";
    return res.status(502).json({ error: safeDarazErrorMessage(order.store.country, message) });
  }
});
api.post("/orders/:id/package", rateLimit(10, 60000), async (req, res) => {
  const id = typeof req.params.id === "string" ? req.params.id : "";
  const order = await db.storeOrder.findFirst({
    where: { id, store: { userId: req.auth!.id } },
    include: { store: { include: { tokens: true } } },
  });
  if (!order) return res.status(404).json({ error: "Order not found." });
  if (!order.store.tokens) return res.status(409).json({ error: "Reconnect this store before creating a package." });
  if (!order.store.isActive) return res.status(409).json({ error: "This store is inactive. Activate it before creating packages." });
  if (order.store.storeType === "choice") return res.status(409).json({ error: "This is a Choice seller store; Daraz handles fulfilment and AWB printing.", choiceSeller: true });

  let accessToken: string;
  let items: Record<string, unknown>[] = [];
  try {
    accessToken = await fetchAccessToken(order.store);
    const itemsBody = await fetchDarazOrderItems(order.store.country, accessToken, order.darazOrderId);
    items = Array.isArray((itemsBody as { data?: unknown }).data) ? (itemsBody as { data: Record<string, unknown>[] }).data : [];
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load this order from Daraz.";
    return res.status(502).json({ error: safeDarazErrorMessage(order.store.country, message) });
  }

  const packages = [...new Set(items.map((item) => String(item.package_id ?? "")).filter(Boolean))];
  if (packages.length) {
    return res.json({ created: false, message: "This order already has a package and tracking number.", packages, trackingNumber: order.trackingNumber ?? null });
  }
  const itemIds = items.map((item) => String(item.order_item_id ?? "")).filter(Boolean);
  if (!itemIds.length) return res.status(409).json({ error: "Daraz returned no order items, so a package cannot be created." });

  try {
    const body = await createOrderPackages(order.store.country, accessToken, order.darazOrderId, itemIds);
    const result = (body as { result?: { success?: boolean; error_msg?: string; error_code?: string; data?: Record<string, unknown> } }).result;
    if (!result?.success) {
      return res.status(502).json({
        error: safeDarazErrorMessage(order.store.country, result?.error_msg ?? "Daraz rejected the package request."),
        code: result?.error_code ?? null,
      });
    }
    const createdPackages = Array.isArray((result.data as { packages?: unknown })?.packages)
      ? ((result.data as { packages: Array<Record<string, unknown>> }).packages)
      : [];
    await audit("order_package_created", req.auth!.id, order.storeId, { orderId: order.darazOrderId, packages: createdPackages as Prisma.InputJsonValue });
    return res.json({ created: true, data: result.data ?? {}, packages: createdPackages });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Daraz rejected the package request.";
    return res.status(502).json({ error: safeDarazErrorMessage(order.store.country, message) });
  }
});
api.post("/orders/:id/rts", rateLimit(10, 60000), async (req, res) => {
  const id = typeof req.params.id === "string" ? req.params.id : "";
  const order = await db.storeOrder.findFirst({
    where: { id, store: { userId: req.auth!.id } },
    include: { store: { include: { tokens: true } } },
  });
  if (!order) return res.status(404).json({ error: "Order not found." });
  if (!order.store.tokens) return res.status(409).json({ error: "Reconnect this store before changing its shipping status." });
  if (!order.store.isActive) return res.status(409).json({ error: "This store is inactive. Activate it before changing shipping status." });
  if (order.store.storeType === "choice") return res.status(409).json({ error: "This is a Choice seller store; Daraz handles fulfilment and AWB printing.", choiceSeller: true });

  let accessToken: string;
  let packages: string[] = [];
  try {
    accessToken = await fetchAccessToken(order.store);
    const itemsBody = await fetchDarazOrderItems(order.store.country, accessToken, order.darazOrderId);
    const items = Array.isArray((itemsBody as { data?: unknown }).data) ? (itemsBody as { data: Record<string, unknown>[] }).data : [];
    packages = [...new Set(items.map((item) => String(item.package_id ?? "")).filter(Boolean))];
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load this order from Daraz.";
    return res.status(502).json({ error: safeDarazErrorMessage(order.store.country, message) });
  }
  if (!packages.length) {
    return res.status(409).json({ error: "Create a package first â€” this order has no tracking number yet." });
  }

  try {
    const rtsBody = await markPackagesReadyToShip(order.store.country, accessToken, packages);
    const result = (rtsBody as { result?: { success?: boolean; error_msg?: string; data?: { packages?: Array<{ package_id?: string; msg?: string; item_err_code?: string }> } } }).result;
    const failed = (result?.data?.packages ?? []).filter((entry) => String(entry.item_err_code ?? "0") !== "0");
    if (!result?.success || failed.length) {
      const reason = failed.map((entry) => `${entry.package_id ?? "package"}: ${entry.msg ?? "failed"}`).join("; ") || result?.error_msg || "Daraz rejected the ready-to-ship request.";
      return res.status(502).json({ error: safeDarazErrorMessage(order.store.country, reason) });
    }
    await audit("order_marked_ready_to_ship", req.auth!.id, order.storeId, { orderId: order.darazOrderId, packages });
    return res.json({ marked: true, packages });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Daraz rejected the ready-to-ship request.";
    return res.status(502).json({ error: safeDarazErrorMessage(order.store.country, message) });
  }
});
api.get("/products", async (req, res) => {
  const parsed = z.object({
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
    storeId: z.string().optional(),
    search: z.string().trim().max(200).optional(),
  }).safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Invalid product list filters." });
  const { page, pageSize, storeId, search } = parsed.data;
  if (storeId && !(await db.store.findFirst({ where: ownedStoreFilter(storeId, req.auth!.id), select: { id: true } }))) {
    return res.status(404).json({ error: "Store not found." });
  }
  const where: Prisma.ProductMasterWhereInput = {
    store: { userId: req.auth!.id, isActive: true, ...(storeId ? { id: storeId } : {}) },
    ...(search ? { OR: [
      { darazItemId: { contains: search, mode: "insensitive" } },
      { sellerSku: { contains: search, mode: "insensitive" } },
      { name: { contains: search, mode: "insensitive" } },
      { variants: { some: { sku: { contains: search, mode: "insensitive" } } } },
    ] } : {}),
  };
  const [total, products] = await Promise.all([
    db.productMaster.count({ where }),
    db.productMaster.findMany({
      where, orderBy: { name: "asc" }, skip: (page - 1) * pageSize, take: pageSize,
      select: {
        id: true, storeId: true, darazItemId: true, sellerSku: true, name: true, brand: true, status: true,
        imageUrl: true, price: true, specialPrice: true, quantity: true, syncedFrom: true, fetchedAt: true,
        _count: { select: { variants: true } },
        store: { select: { label: true, country: true, storeType: true } },
      },
    }),
  ]);
  return res.json({ products, page, pageSize, total, totalPages: Math.ceil(total / pageSize) });
});
api.get("/products/:id", async (req, res) => {
  const id = typeof req.params.id === "string" ? req.params.id : "";
  const product = await db.productMaster.findFirst({
    where: { id, store: { userId: req.auth!.id, isActive: true } },
    include: {
      variants: { orderBy: [{ size: "asc" }, { sku: "asc" }] },
      store: { select: { label: true, country: true, storeType: true } },
    },
  });
  if (!product) return res.status(404).json({ error: "Product not found." });
  return res.json(product);
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
api.get("/admin/logs", requireAdmin, async (req, res) => {
  const storeId = typeof req.query.storeId === "string" && req.query.storeId ? req.query.storeId : undefined;
  const stores = await db.store.findMany({
    select: {
      id: true, label: true, country: true, storeType: true, isActive: true, status: true,
      orderSyncLastAt: true, orderSyncNextAt: true, orderSyncLockUntil: true, orderSyncError: true,
      orderBackfillDone: true, orderBackfillCursor: true, orderSyncFrequency: true,
      productSyncLastAt: true, productSyncNextAt: true, productSyncLockUntil: true, productSyncError: true, productSyncOffset: true,
      user: { select: { name: true, email: true } },
      tokens: { select: { accessExpiresAt: true, refreshExpiresAt: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  const scoped = storeId ? stores.filter((store) => store.id === storeId) : stores;
  const [productCounts] = await Promise.all([
    db.productMaster.groupBy({ by: ["storeId"], where: { storeId: { in: stores.map((store) => store.id) } }, _count: { _all: true } }),
  ]);
  const productCount = (id: string) => productCounts.find((row) => row.storeId === id)?._count._all ?? 0;
  const logs = await db.auditLog.findMany({
    where: storeId ? { storeId } : {},
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { user: { select: { email: true } }, store: { select: { label: true } } },
  });
  const now = new Date();
  const jobs: Array<Record<string, unknown>> = [];
  const syncState = (lastAt: Date | null, nextAt: Date | null, lockUntil: Date | null, error: string | null) => {
    if (lockUntil && lockUntil > now) return "running";
    if (error) return "failed";
    if (nextAt && nextAt <= now) return "queued";
    if (nextAt) return "scheduled";
    return "idle";
  };
  for (const store of scoped) {
    jobs.push({
      id: `${store.id}:orders`,
      storeId: store.id,
      storeLabel: store.label,
      kind: "orders",
      state: syncState(store.orderSyncLastAt, store.orderSyncNextAt, store.orderSyncLockUntil, store.orderSyncError),
      lastAt: store.orderSyncLastAt,
      nextAt: store.orderSyncNextAt,
      lockUntil: store.orderSyncLockUntil,
      error: store.orderSyncError,
      progress: store.orderBackfillDone
        ? "Backfill complete"
        : store.orderBackfillCursor
          ? `Backfill resumes from ${store.orderBackfillCursor.toISOString().slice(0, 10)}`
          : "Waiting for first backfill",
    });
    if (store.storeType !== "choice") {
      jobs.push({
        id: `${store.id}:products`,
        storeId: store.id,
        storeLabel: store.label,
        kind: "products",
        state: syncState(store.productSyncLastAt, store.productSyncNextAt, store.productSyncLockUntil, store.productSyncError),
        lastAt: store.productSyncLastAt,
        nextAt: store.productSyncNextAt,
        lockUntil: store.productSyncLockUntil,
        error: store.productSyncError,
        progress: store.productSyncOffset > 0 ? `${store.productSyncOffset} products processed` : "Catalog sync idle",
      });
    }
  }
  return res.json({
    generatedAt: now.toISOString(),
    storeOptions: stores.map((store) => ({ id: store.id, label: store.label, isActive: store.isActive })),
    stores: scoped.map((store) => ({
      id: store.id,
      label: store.label,
      country: store.country,
      storeType: store.storeType,
      isActive: store.isActive,
      owner: store.user,
      status: displayStoreStatus(store),
      orders: null,
      products: productCount(store.id),
      orderSync: {
        lastAt: store.orderSyncLastAt,
        nextAt: store.orderSyncNextAt,
        lockUntil: store.orderSyncLockUntil,
        running: Boolean(store.orderSyncLockUntil && store.orderSyncLockUntil > now),
        backfillDone: store.orderBackfillDone,
        backfillCursor: store.orderBackfillCursor,
        frequency: store.orderSyncFrequency,
        error: store.orderSyncError,
      },
      productSync: {
        lastAt: store.productSyncLastAt,
        nextAt: store.productSyncNextAt,
        lockUntil: store.productSyncLockUntil,
        running: Boolean(store.productSyncLockUntil && store.productSyncLockUntil > now),
        offset: store.productSyncOffset,
        error: store.productSyncError,
      },
    })),
    jobs,
    logs: logs.map((entry) => ({
      id: entry.id,
      action: entry.action,
      createdAt: entry.createdAt,
      userEmail: entry.user?.email ?? null,
      storeLabel: entry.store?.label ?? null,
      meta: entry.meta,
    })),
  });
});
api.get("/admin/stores", requireAdmin, async (_req, res) => {
  const stores = await db.store.findMany({ include: { user: { select: { name: true, email: true } }, tokens: true }, orderBy: { createdAt: "desc" } });
  return res.json(stores.map(publicStore));
});
api.get("/admin/stores/:id", requireAdmin, async (req, res) => {
  const id = typeof req.params.id === "string" ? req.params.id : "";
  const store = id ? await db.store.findUnique({ where: { id }, include: { user: { select: { name: true, email: true } }, tokens: true, auditLogs: storeActivity } }) : null;
  if (!store) return res.status(404).json({ error: "Store not found." });
  const { auditLogs, ...rest } = store;
  return res.json({ ...publicStore(rest), activity: auditLogs });
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
  if (err instanceof Error) {
    const rawCode = (err as unknown as { code?: unknown }).code;
    const code = typeof rawCode === "string" ? ` [${rawCode}]` : "";
    console.error("Unhandled request error:", err.name + code, err.message.split("\n")[0]);
  } else {
    console.error("Unhandled request error: unknown error");
  }
  return res.status(500).json({ error: "An unexpected error occurred." });
});
app.listen(config.PORT, () => {
  console.log(`Daraz Store Hub API listening on ${config.PORT}`);
  startOrderSyncWorker();
  startProductSyncWorker();
});

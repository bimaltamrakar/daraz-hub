# Daraz Store Hub

Daraz Store Hub is a web application for managing Daraz seller-store connections and synchronizing seller orders and product details. Users can register, add stores for supported marketplaces, connect them through Daraz OAuth, inspect seller details and token health, configure order sync, and browse synced orders. Administrators can manage users, inspect stores, and review recent audit events.

The application is multi-user: each user sees and manages their own stores. Daraz credentials stay on the server and are encrypted before they are stored.

## Contents

- [Features](#features)
- [Technology and architecture](#technology-and-architecture)
- [Project layout](#project-layout)
- [Requirements](#requirements)
- [Local development](#local-development)
- [Configuration reference](#configuration-reference)
- [Database and administrator account](#database-and-administrator-account)
- [Daraz Open Platform setup](#daraz-open-platform-setup)
- [Using the application](#using-the-application)
- [API reference](#api-reference)
- [Production deployment](#production-deployment)
- [Security and operations](#security-and-operations)
- [Tests and build](#tests-and-build)

## Features

- Account registration, sign-in, sign-out, password changes, and refresh-session rotation.
- Seeded administrator account with a required first-login password change.
- Store creation, removal, Daraz OAuth connection, and manual token refresh.
- Seller identity and profile retrieval, including a retry action when profile retrieval fails.
- Per-store settings page: order-sync start date, frequency, sync-now, backfill state, counts, and last error.
- Per-store **Active/Inactive** switch. Inactive stores, and their orders/products, are hidden from every list, report, dashboard count and sync worker until reactivated; **Show inactive** on My stores reveals them for management.
- Daraz-style order management across all stores: status lanes (Unpaid, To Ship, Shipping, Delivered, Failed Delivery, Cancellation, Return or Refund). **The All lane includes canceled orders**, while dashboard metrics still exclude them. **To Ship has To Pack / To Arrange Shipment / To Handover sub-lanes**, and lane counts are only computed for Unpaid, To Ship and Shipping after a store is selected.
- Official AWB printing with separate fulfilment actions: **Print AWB** fetches Daraz's shipping-label PDF; **Create package** calls Daraz's pack API to assign a tracking number when none exists; **Mark RTS** separately marks the packages ready to ship. No action runs automatically. **Choice seller stores are orders-only**: their orders and full details are synced for billing, with no package, RTS or AWB actions.
- Fast order sync from Daraz list responses plus on-demand order detail/item enrichment, with resumable backfill for very large stores.
- Store-wise product catalog with variants (colour/size), image URLs, price, offer price, and stock; includes a Products page with thumbnails, filters, and a variant drawer.
- Live analytics dashboard: net sales, order-lane counts, SKU totals, sales trend line chart, per-store sales bar comparison, sync health, and recent activity.
- Catalog sync for normal sellers via `GET /products/get` + `/product/item/get`; Choice sellers skip the products API (Daraz forbids it) and have SKUs created from order line items instead.
- New/active order items are synced into the catalog automatically, so SKUs from incoming orders exist even before a catalog sync runs.
- Store status and access/refresh token expiry metadata.
- Administrator views for users, stores, individual store details, and the latest 250 audit events.
- OpenAPI YAML document and a runtime JSON endpoint index.

The application does not provide order fulfillment, inventory editing, or sales analytics.

## Technology and architecture

| Area | Implementation |
| --- | --- |
| Web client | React 19, TypeScript, Vite |
| API | Express 5, TypeScript, Zod validation |
| Database | PostgreSQL, intended for Supabase-hosted PostgreSQL |
| Data access | Prisma ORM and checked-in migrations |
| Password storage | bcryptjs password hashes |
| Store-token storage | AES-256-GCM encrypted Daraz access and refresh tokens |
| User sessions | Short-lived signed JWT access tokens and rotating, opaque refresh tokens |
| Runtime | Node.js 22; Docker image and Docker Compose configuration are provided |

In development, Vite serves the web client on port 5173 and proxies `/api` requests to the API on port 4000. In production, the Express process serves the built web client as well as the API. PostgreSQL is external: the Compose file does not run a database container.

## Project layout

```text
.
├── prisma/
│   ├── migrations/         # Database migration history
│   ├── schema.prisma       # Database models and enums
│   └── seed.ts             # Idempotent administrator creation
├── src/
│   ├── lib/                # Auth, configuration, database, Daraz and security helpers
│   ├── test/               # Vitest test setup
│   ├── web/                # React application and styles
│   ├── main.tsx            # Web entry point
│   └── server.ts           # Express API and production static-file server
├── Dockerfile              # Multi-stage production image
├── docker-compose.yml      # Single application service
├── nginx.conf              # Optional TLS reverse-proxy example
├── openapi.yaml            # OpenAPI 3.1 API document
├── package.json            # Scripts and dependencies
└── vite.config.ts          # Vite configuration and development API proxy
```

## Requirements

- Node.js 22 or later and npm.
- A reachable PostgreSQL database. The documented configuration uses Supabase PostgreSQL and its Supavisor poolers.
- Daraz Open Platform application credentials for any marketplace you intend to connect.
- Docker Engine and the Docker Compose plugin only if you plan to use the container deployment.

The API validates its required environment variables at startup. A usable database is needed for migrations, seeding, and normal application operation.

## Local development

1. Create a PostgreSQL database. For Supabase, obtain the transaction-pooler and session-pooler connection strings from **Project Settings → Database → Connection string**.
2. Copy `.env.example` to `.env`. Replace the database placeholders and all example secrets/passwords with values for your environment. Keep `.env` private and out of source control.
3. Install dependencies and generate the Prisma client:

   ```sh
   npm install
   npm run db:generate
   ```

4. Apply migrations and create the administrator:

   ```sh
   npm run db:migrate
   npm run db:seed
   ```

5. Configure `DARAZ_REGIONS_JSON` for the marketplace(s) you will connect. See [Daraz Open Platform setup](#daraz-open-platform-setup).
6. Start the API and Vite development server:

   ```sh
   npm run dev
   ```

   The web application is at `http://localhost:5173`; the API listens at `http://localhost:4000`. Open the Vite URL to use the application.

The development API can also be started independently with `npm run dev:api`; the web client can be started independently with `npm run dev:web`.

## Configuration reference

Set these variables in the server's `.env` file. `npm run dev` loads `.env` through the server configuration; Vite proxies requests to that server. Do not put server secrets in client-side variables.

| Variable | Required | Description |
| --- | --- | --- |
| `NODE_ENV` | No | `development`, `test`, or `production`. Defaults to `development`. Production requires `COOKIE_SECURE=true`. |
| `PORT` | No | API listen port. Defaults to `4000`. |
| `APP_ORIGIN` | Yes | Full browser-facing origin used for credentialed CORS and OAuth callback redirects, e.g. `http://localhost:5173`. |
| `DATABASE_URL` | Yes | PostgreSQL URL used by the running application. With Supabase, use the Supavisor transaction pooler. |
| `DIRECT_URL` | Yes | PostgreSQL URL used by Prisma migrations. With Supabase, use the Supavisor session pooler. |
| `JWT_ACCESS_SECRET` | Yes | Secret used to sign access JWTs; must be at least 32 characters. |
| `TOKEN_ENCRYPTION_KEY` | Yes | 32-byte AES key encoded as exactly 64 hexadecimal characters. Losing or changing this key without re-encrypting tokens makes stored Daraz credentials unreadable. |
| `ACCESS_TOKEN_TTL` | No | Access-JWT lifetime accepted by `jsonwebtoken`. Defaults to `15m`. |
| `REFRESH_TOKEN_TTL_DAYS` | No | Refresh-session lifetime in days. Defaults to `30`. |
| `OAUTH_STATE_TTL_MINUTES` | No | Lifetime of a pending Daraz OAuth state. Defaults to `10`. |
| `COOKIE_SECURE` | No | `true` sets the refresh and OAuth-state cookies' Secure flag. Defaults to `false`; must be `true` in production. |
| `DARAZ_REGIONS_JSON` | No | Valid, one-line JSON object containing Daraz application configuration keyed by marketplace code. Defaults to `{}` (no Daraz integrations configured); invalid JSON or region entries prevent the API from starting. |
| `ADMIN_EMAIL` | Required for seed | Email address of the administrator created by `npm run db:seed` and by the container entrypoint. |
| `ADMIN_PASSWORD` | Required for seed | Initial administrator password; the seed requires at least 12 characters. Replace the example with a unique, strong password. It must be changed at first sign-in. |

Generate secrets using Node.js:

```sh
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64'))"
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Use the first command's output for `JWT_ACCESS_SECRET` and the second for `TOKEN_ENCRYPTION_KEY`.

### Supabase connection notes

- Use the transaction-mode pooler URL for `DATABASE_URL`; the Supabase transaction pooler commonly uses port `6543` and may require `pgbouncer=true`.
- Use the session-mode pooler URL for `DIRECT_URL`; the session pooler commonly uses port `5432`.
- Both URLs must target the same project and database. URL-encode reserved characters in the database password.
- Allow network access from the development machine or production host if Supabase database network restrictions are enabled.
- This project connects directly to PostgreSQL using Prisma. It does not use Supabase Auth, the Supabase REST/Data API, or browser-side Supabase credentials.

## Database and administrator account

The Prisma schema defines these models:

| Model | Purpose |
| --- | --- |
| `User` | User identity, bcrypt password hash, role, account activation, and forced password-change flag. |
| `Session` | Hashed refresh-token sessions and their expiry. Raw refresh tokens are only sent in an HttpOnly cookie. |
| `Store` | Marketplace, owner, seller identity/profile details, connection status, and timestamps. |
| `StoreToken` | AES-256-GCM ciphertext for access and refresh tokens, expiry dates, and the latest refresh error. |
| `StoreOrder` | Normalized, searchable order fields and the complete JSON response from Daraz's order-detail endpoint. |
| `ProductMaster` | Per-store product identity, name, brand, image URL, price, offer price, stock, variation, and the complete JSON response from Daraz's product-detail endpoint. |
| `ProductVariant` | Per-store SKU variants with colour, size, price, offer price, stock, status, image URL, and raw SKU JSON. |
| Store sync fields | Per-store start date, frequency, last/next sync, product catalog cursor, lock lease, and sanitized error. |
| `OAuthState` | Single-use, expiring OAuth state associated with the initiating user and store. |
| `AuditLog` | Administrative and store activity records. |

`npm run db:migrate` applies checked-in migrations using `DIRECT_URL`. `npm run db:generate` regenerates the Prisma client from the schema.

The seed reads `ADMIN_EMAIL` and `ADMIN_PASSWORD`, hashes the password with bcrypt, and creates an administrator only if that email does not already exist. It is safe to run repeatedly, but it does not update an existing account's password, role, or other fields. The newly seeded administrator must change the initial password before accessing the rest of the application. New self-registered accounts have the regular user role.

## Daraz Open Platform setup

1. Register an application in the [Daraz Open Platform console](https://open.daraz.com/app/index.htm) and request the seller permissions needed for your use case.
2. Configure the application's callback URL to match the public URL exactly:

   ```text
   https://YOUR_PUBLIC_HOST/api/oauth/daraz/callback
   ```

3. Add a region entry to `DARAZ_REGIONS_JSON`. The setting must be valid JSON on one line; use your actual application key and secret:

   ```json
   {"NP":{"authorizeUrl":"https://api.daraz.com.np/oauth/authorize","apiBaseUrl":"https://api.daraz.com.np/rest","appKey":"YOUR_DARAZ_APP_KEY","appSecret":"YOUR_DARAZ_APP_SECRET","redirectUri":"https://YOUR_PUBLIC_HOST/api/oauth/daraz/callback"}}
   ```

   Each region entry requires `authorizeUrl`, `appKey`, `appSecret`, and `redirectUri`. `apiBaseUrl` is optional: if omitted, the REST gateway is derived from the origin of `authorizeUrl` with `/rest` appended. Use the marketplace-specific gateway and authorization host supplied for your Daraz application. Examples used by this project include `api.daraz.com.np`, `api.daraz.pk`, `api.daraz.com.bd`, `api.daraz.lk`, and `api.shop.com.mm`; the generic `api.daraz.com` host may not resolve for a marketplace.

4. Restart the API after changing the environment. A store can be created for a marketplace even when its integration is not configured, but starting OAuth for that store will fail until a matching region is configured.

The client currently offers `NP`, `PK`, `BD`, `LK`, and `MM` in the region selector. The server looks up integration settings by the store's two-letter country code.

### OAuth and seller profile flow

1. A signed-in user creates a store with a label and marketplace code.
2. The API creates a random OAuth state, stores it with an expiry and user/store association, and redirects the browser to Daraz's authorization page.
3. Daraz redirects to `/api/oauth/daraz/callback`. The server validates and consumes the state once, exchanges the code at `/auth/token/create`, and stores the returned tokens encrypted.
4. The server saves seller identity fields from the token response and calls `GET /seller/get` to retrieve the seller profile.
5. The browser returns to the store details page. If profile retrieval failed, the connection still succeeds; the error is recorded and profile retrieval can be retried from the page.

Daraz REST calls use Lazop signing: request parameters are sorted by key, concatenated with the API path, and signed with HMAC-SHA256 using the application secret. Token exchange, refresh, and seller-profile requests have a 15-second timeout. The authorization code expires after 30 minutes.

Order sync pages through the signed `GET /orders/get` list endpoint and stores each order summary (status, customer, amount, item count) without a detail request per order. Daraz's gateway only recognises the snake_case parameters `created_after`/`created_before` and `update_after` (camelCase variants are ignored and rejected with error `E018`), together with `limit`, `offset`, and `sort_by`. The first pass for a store is a resumable backfill that walks **one-day windows** (`created_after` + `created_before`) because Daraz caps `offset` at 5,000 rows per query — a single wide scan silently truncates busy stores. It advances a saved window cursor and is capped at 10,000 fetched rows per pass; later passes ask for orders updated since the stored cursor minus a one-minute overlap, so status changes on existing orders are picked up. The update cursor is the greatest `updated_at` timestamp seen; changing the configured start date resets both cursors and restarts the backfill. Full order detail and line items are fetched lazily by `GET /api/orders/:id` and cached in `rawDetails`.

Product catalog sync is a **standalone pipeline for normal sellers** (Choice sellers cannot use the products API): a worker claims due stores, pages `GET /products/get` (`filter=all`, 50 per page) and requests `GET /product/item/get` for the listings, storing product fields and every SKU as a `ProductVariant`. Initial full syncs are resumable via a saved offset (150 products per pass, then it continues automatically); later passes use `update_after` with a one-minute overlap. Syncs are scheduled from the store's order frequency and can be queued with **Sync products** on the Products page or Store settings. New/active order line items are still upserted into the catalog separately, so incoming-order SKUs exist even for Choice stores. Product-catalog failures (permission, timeout, rate limit, unexpected shape) are recorded on the store and never block order sync.

OAuth state is single-use and expires according to `OAUTH_STATE_TTL_MINUTES`. It is also bound to the initiating browser using the short-lived, HttpOnly `daraz_oauth_state` cookie. In production, callbacks without the matching browser cookie are rejected. In non-production environments the mismatch is logged instead, to support development setups where the callback tunnel and Vite run on different hosts.

## Using the application

### User workspace

- **Overview (`/`)** — live analytics dashboard with a **store selector** (All stores or one store) and global date range (7/14/30/90 days). KPIs: net sales, orders, AOV, units/order, SKUs — each with previous-period deltas. Includes orders-by-status counts, per-store sales trend, a **store-wise orders-per-day line chart**, sales-by-store bars with share, top products by revenue/units, category performance, returns trend, stock alerts (out-of-stock/low-stock/no-sales), a weekday × hour sales heatmap, a ranked store leaderboard (share, change, sync health), **Sync orders** for the selected store (queues a sync and reports new/total orders), and **CSV export** of the selected range. Auto-refreshes every 30s with a Live toggle.
- **My stores (`/stores`)** — add, list, connect, refresh, and remove your stores.
- **Store details (`/stores/:id`)** — inspect seller profile, token expiry, errors, and recent activity; retry seller-profile retrieval; connect, refresh, or remove the store; configure order sync start date and frequency; view sync status; and queue a manual sync.
- **Store settings (`/stores/:id/settings`)** — per-store order-sync schedule (start date and frequency), seller type (normal or Choice), manual sync, initial-backfill progress, synced order/product counts, and the last sync error.
- **Order management (`/orders`)** — every connected store in one queue with Seller Center-style status lanes. Counts appear only for Unpaid, To Ship and Shipping, and only after selecting a store; To Ship expands into **To Pack / To Arrange Shipment / To Handover** sub-lanes. The **All** lane includes canceled orders; dashboard KPIs still exclude canceled orders. Filter by store, order/customer/tracking text, or created-date range; sort, page, and export CSV. Selecting an order opens a drawer with line items, SKU, quantity, amount, delivery/tracking, customer and shipping address, plus a refresh action that loads the latest detail from Daraz.
- **Products (`/products`)** — store-wise catalog with image thumbnails, price, offer price, stock, status, and variant counts. Select a product to see its variants (SKU, colour/size, price, offer, stock, image). New-order SKUs are added automatically; Choice stores show order-derived products only. **Sync products** refreshes incrementally; **Full resync** clears the catalog cursor/offset and re-fetches everything from the start.
- **Account** — sign up or sign in, change the password, and sign out.

Store status is computed from saved status and token expiry:

| Status | Meaning |
| --- | --- |
| `pending` | No token record exists and the store has not entered an error state. |
| `connected` | Tokens exist, are not expired, and the refresh token expires in more than seven days. |
| `expiring_soon` | Tokens exist and the refresh token expires within seven days. |
| `expired` | Either the access token or refresh token has expired. Reconnect may be required. |
| `error` | A Daraz connection or token operation recorded an error (unless expiry makes the displayed status `expired`). |

Order and product sync runs in the application process every 15 seconds for stores that are due. Sync frequency is configurable per store: manual, every 15 minutes, hourly, every six hours, or daily. A database lease prevents two application processes from syncing the same store at once. The initial sync starts at the configured date; later order fetches use an overlapping update-time cursor, and product catalog fetches use an overlapping product-update cursor. The overlap makes retries safe; records are upserted by store plus Daraz order/item ID.

For each order returned by Daraz's order-list endpoint, the sync stores the summary JSON in `StoreOrder.rawDetails` along with normalized fields and a status lane. Opening an order replaces that payload with the merged `/order/get` + `/order/items/get` response, so line items, tracking, and shipping address are available without making the backfill pay for a detail call per order. Product master records are scoped to a store, since seller listing data and inventory are marketplace/store-specific. Raw payloads can contain customer or seller data and are only returned by the owner-scoped order/product detail API.

If the access token expires, the worker attempts to refresh it with the stored refresh token before syncing. Failures are sanitized and displayed in the store's order-sync status; automatic retry follows the selected schedule. For a manual-only schedule, use **Sync now** to retry.

Token refresh outside order sync is initiated by the user; the application does not run a separate token refresh scheduler. The dashboard's summary counts total, connected, expiring-soon, and expired stores. Pending and error stores are included in the total but not in those three status counts.

### Administrator workspace

Users with the `admin` role also see:

- **Users & stores (`/admin`)** — list users and all stores, open store details, activate/deactivate users, and set temporary passwords. Setting a password or deactivating a user removes that user's refresh sessions; a temporary password forces a password change at next sign-in.
- **Audit log (`/audit`)** — view the latest 250 audit events.
- **Admin store details (`/admin/stores/:id`)** — inspect any store's profile, owner, token metadata, and recent activity. Token values remain hidden from administrators.

## API reference

All API routes are under `/api`. JSON request bodies use `Content-Type: application/json`. Unless stated otherwise, protected routes require an access token in the `Authorization: Bearer <access-token>` header. Refresh tokens are not bearer tokens: they are sent only in the `refresh_token` HttpOnly cookie.

The complete checked-in API document is [`openapi.yaml`](./openapi.yaml), available at `GET /api/openapi.yaml`. `GET /api/openapi.json` returns a compact runtime endpoint index; it is not the full OpenAPI document.

### Authentication

| Method and path | Access | Request | Success |
| --- | --- | --- | --- |
| `POST /api/auth/signup` | Public | `{ "name": "Name", "email": "name@example.com", "password": "StrongPassword1!" }` | `201`; returns `accessToken` and `user`, sets the refresh cookie. Password must be 12–128 characters and include lowercase, uppercase, a number, and a symbol. |
| `POST /api/auth/login` | Public | `{ "email": "name@example.com", "password": "..." }` | `200`; returns `accessToken` and `user`, sets the refresh cookie. |
| `POST /api/auth/refresh` | Refresh cookie | No body | `200`; rotates the refresh cookie and returns a new access token and user. |
| `POST /api/auth/logout` | Refresh cookie, if present | No body | `204`; revokes the current refresh session and clears the cookie. |
| `POST /api/auth/password` | Access token | `{ "currentPassword": "...", "newPassword": "StrongPassword1!" }` | `200`; updates the password, revokes existing refresh sessions, and returns a new access token. |
| `GET /api/me` | Access token | No body | `200`; current user's public profile. |

Sign-up is limited to five requests per IP per hour; login to eight per IP per 15 minutes; refresh to 20 per IP per minute. Invalid or expired authentication returns `401`; a required initial password change blocks other protected API routes until the password is changed.

### Dashboard and user stores

| Method and path | Request | Success |
| --- | --- | --- |
| `GET /api/dashboard` | No body | `200`; `{ "total": 0, "connected": 0, "expiringSoon": 0, "expired": 0 }` (counts vary with the user's stores). |
| `GET /api/dashboard/stats` | Query: `days` (7–90, default 14) and optional `storeId`. | `200`; period-scoped KPIs (sales, orders, AOV, units, previous-period comparison), status counts/trend, per-store trend and leaderboard data (share, rank, deltas, sync health), top products and categories from cached order line items, stock alerts, weekday/hour heatmap, and recent activity. |
| `GET /api/dashboard/export` | Query: `days`, optional `storeId`. | `200`; CSV report with KPIs, status counts, store leaderboard, top products, categories and stock alerts. |
| `GET /api/stores` | Optional `includeInactive=1`. | `200`; current user's stores (inactive ones are omitted by default), with token values omitted. |
| `POST /api/stores` | `{ "label": "Kathmandu Outlet", "country": "NP" }` | `201`; creates a pending store. Label is required (1–100 characters); country is a two-letter code and is normalized to uppercase. |
| `GET /api/stores/:id` | No body | `200`; owned store details and up to 20 recent activity entries; `404` if absent or not owned by the user. |
| `GET /api/stores/:id/tokens` | No body | `200`; returns plaintext credentials only after an explicit request by the store owner. Rate-limited and non-cacheable. |
| `DELETE /api/stores/:id` | No body | `204`; deletes the owned store and its dependent credentials. |
| `POST /api/stores/:id/connect` | No body | `200`; `{ "authorizationUrl": "..." }`. Returns `404` if the store is not owned/found and `503` if the region is not configured or OAuth cannot be started. |
| `POST /api/stores/:id/refresh` | No body | `200`; updated token expiry metadata only. Returns `404` if not found, `409` if a usable refresh token is unavailable, or `502` if Daraz rejects/fails the refresh. |
| `POST /api/stores/:id/profile` | No body | `200`; updated store profile. Returns `404` if not found, `409` if there is no valid access token, or `502` if Daraz profile retrieval fails. |
| `PATCH /api/stores/:id/order-sync-settings` | `{ "fromDate": "2026-01-01", "frequency": "hourly" }` | `200`; updated store sync settings. Frequencies: `manual`, `every_15_minutes`, `hourly`, `every_6_hours`, `daily`. Dates are UTC calendar dates and cannot be in the future. |
| `PATCH /api/stores/:id/type` | `{ "storeType": "normal" }` or `{ "storeType": "choice" }` | `200`; updated store. Choice stores are fulfilled by Daraz and cannot print AWBs or be marked ready to ship from this app. |
| `PATCH /api/stores/:id/active` | `{ "isActive": false }` or `{ "isActive": true }` | `200`; updated store. Deactivating clears sync schedules and hides the store and its orders/products from lists, dashboard and reports; reactivating restores them. |
| `POST /api/stores/:id/orders/sync` | No body | `202`; queues an order and product sync. Returns `409` if the store is not connected or a sync is already running. |
| `POST /api/stores/:id/products/sync` | No body | `202`; queues the product catalog sync for a normal seller. `409` for Choice sellers (products API not allowed), unconnected stores, or an already-running sync. |
| `POST /api/stores/:id/products/resync` | No body | `202`; clears the catalog cursor/offset and queues a full catalog re-fetch from the beginning. `409` for Choice sellers or a running sync. |

### Orders and product master

| Method and path | Request | Success |
| --- | --- | --- |
| `GET /api/orders` | Query: `page`, `pageSize` (max 100), `storeId`, `search`, `statusGroup` (`unpaid`, `to_ship`, `shipping`, `delivered`, `failed_delivery`, `canceled`, `returned`), `orderStatus`, `deliveryStatus`, `from`, `to`, `sortBy`, `sortOrder`. | `200`; `{ orders, page, pageSize, total, totalPages }`. Search matches order ID, customer name, and tracking number. Sorting uses an allowlisted normalized field. All rows are restricted to the signed-in user's stores. |
| `GET /api/orders/summary` | `storeId` (required for counts), plus search/date filters. | `200`; `{ groups: { unpaid, to_ship, shipping }, toShip: { pending, ready_to_ship, packed } }`; empty groups when no store is selected. |
| `GET /api/orders/export` | Same filters as `/api/orders`. | `200`; CSV of all matching orders (canceled excluded unless `statusGroup=canceled`). |
| `GET /api/orders/:id` | Optional `refresh=1`. | `200`; normalized fields plus the Daraz order detail and line items in `rawDetails`. The first view fetches `/order/get` and `/order/items/get` from Daraz and caches the merged payload; later views are served from the database. |
| `GET /api/orders/:id/awb` | No body | `200`; `{ source: "daraz", pdfUrl, packages, trackingNumber }` with Daraz's official AWB PDF URL. `409` when the order has no package/tracking yet; `409` with Daraz's reason for warehouse-fulfilled orders. |
| `POST /api/orders/:id/package` | No body | Creates the fulfillment package(s) for an unpacked order via Daraz's pack API (`/order/fulfill/pack`), returning `{ created, packages, data }`. Returns `created: false` when a package already exists. |
| `POST /api/orders/:id/rts` | No body | Marks the order's packages ready to ship via `/order/package/rts`, records an audit event, and returns `{ marked: true, packages }`. `409` when no package exists. |
| `GET /api/products` | Query: `page`, `pageSize` (max 100), `storeId`, `search`. | `200`; paginated products with image URL, price, offer price, stock, brand, source (`catalog`/`order`), and variant count. Search matches item ID, seller SKU, product name, or variant SKU. |
| `GET /api/products/:id` | No body | `200`; product record with `variants` (SKU, colour, size, price, offer price, stock, status, image URL) and the raw product payload in `rawDetails`. |

Raw details are the complete JSON response body received from Daraz's detail endpoint (including its response envelope), not a whitelist of selected properties. Daraz list endpoint response bodies are used for pagination and cursors; detail endpoint payloads are retained in JSONB.

Store refresh and profile requests are each limited to ten per IP/store route per minute. Normal store responses can include `accessExpiresAt`, `refreshExpiresAt`, `lastRefreshedAt`, and a sanitized `lastError`, but never include encrypted or plaintext token values.

`GET /api/stores/:id/tokens` is a separate, owner-only, rate-limited endpoint used by the store detail page's **Show tokens** action. It returns decrypted token values only on request and sets `Cache-Control: no-store, private`; each reveal is recorded in the audit log. Treat both values as secrets.

### OAuth callback

| Method and path | Access | Request | Result |
| --- | --- | --- | --- |
| `GET /api/oauth/daraz/callback` | Public Daraz redirect | `code` and `state` query parameters, or `error` and `state` if authorization was denied | Valid success redirects to the store page with `connected=true` or `connected=partial`. Failures may redirect with an error query or return `400`/`403`. |

The callback state must exist, be unexpired, unused, and associated with the store and user that started authorization. In production it must also match the initiating browser's OAuth-state cookie.

### Administrator routes

| Method and path | Request | Success |
| --- | --- | --- |
| `GET /api/admin/users` | No body | `200`; user list and each user's store count. |
| `PATCH /api/admin/users/:id` | `{ "isActive": false }`, `{ "password": "TemporaryPassword1!" }`, or both | `200`; updated public user fields. Passwords must meet the strong-password policy. Deactivation and password resets revoke the user's refresh sessions. |
| `GET /api/admin/stores` | No body | `200`; all stores with owner details and token metadata; no token values. |
| `GET /api/admin/stores/:id` | No body | `200`; store, owner, and up to 20 recent activity entries; `404` if not found. |
| `GET /api/admin/audit` | No body | `200`; latest 250 audit events with associated user email and store label where available. |

All administrator routes require both a valid active user and the `admin` role; non-admin users receive `403`.

## Production deployment

The provided Compose configuration starts **only the application container**. It does not define a `production` profile, nginx service, or database service. Configure PostgreSQL and Daraz using the same environment variables as local development, and provide a `.env` file beside `docker-compose.yml`.

Before deploying:

1. Set `NODE_ENV=production`, a production `APP_ORIGIN` using HTTPS, and `COOKIE_SECURE=true`.
2. Use unique, strong `JWT_ACCESS_SECRET`, `TOKEN_ENCRYPTION_KEY`, and administrator credentials. Configure production database URLs and Daraz application credentials.
3. Configure a TLS-terminating reverse proxy in front of port 4000. The included [`nginx.conf`](./nginx.conf) is an example configuration only: it expects externally provided certificate files and an upstream named `app`; it is not started by the included Compose file.
4. Ensure the proxy forwards the original host and HTTPS protocol, and configure `APP_ORIGIN` to exactly match the browser-facing site origin.
5. Ensure the host can reach the database and Daraz marketplace endpoints over HTTPS, and configure database backups.

Build and start the app:

```sh
docker compose up --build -d
docker compose logs -f app
```

On container startup, the image runs `prisma migrate deploy`, seeds the administrator, and starts the Express server. The built web client is served by Express. Port 4000 is exposed by the container; place the TLS reverse proxy in front of it rather than exposing an unsecured production endpoint directly to users.

To stop the application without deleting database data:

```sh
docker compose down
```

There is no local database volume in this Compose project; the configured PostgreSQL instance remains external.

### Automatic deploys from GitHub

The repository includes [`scripts/deploy.sh`](./scripts/deploy.sh) and a GitHub Actions workflow ([`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml)) that deploys on every push to `main`. The workflow is inert until the repository variable **`DEPLOY_ENABLED=true`** is set (so it does not fail before the server is configured).

First-time server setup (PM2):

```sh
sudo mkdir -p /var/www && sudo chown "$USER" /var/www
git clone https://github.com/bimaltamrakar/daraz-hub.git /var/www/daraz-hub
cd /var/www/daraz-hub
cp .env.example .env && nano .env
npm ci --include=dev
npx prisma generate
npx prisma migrate deploy
npm run build
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

Docker alternative: `DEPLOY_MODE=docker` and bring it up once with `docker compose up -d --build`; the deploy script then rebuilds it on each push (the image runs migrations at startup).

Allow GitHub to SSH in with a dedicated key:

```sh
ssh-keygen -t ed25519 -C github-deploy -f ~/.ssh/github_deploy
cat ~/.ssh/github_deploy.pub >> ~/.ssh/authorized_keys
cat ~/.ssh/github_deploy   # paste as the SSH_PRIVATE_KEY secret
```

Configure **GitHub → Settings → Secrets and variables → Actions**:

| Name | Type | Value |
|---|---|---|
| `SSH_HOST` | Secret | Server hostname/IP |
| `SSH_USER` | Secret | SSH user (ideally a deploy user) |
| `SSH_PRIVATE_KEY` | Secret | Private key generated above |
| `SSH_PORT` | Secret (optional) | SSH port, default `22` |
| `DEPLOY_ENABLED` | Variable | `true` to enable the workflow |
| `APP_DIR` | Variable | Repo path on the server, e.g. `/var/www/daraz-hub` |
| `BRANCH` | Variable (optional) | `main` |
| `PM2_APP` | Variable (optional) | `daraz-hub` |
| `SERVICE` | Variable (optional) | systemd service name instead of PM2 |
| `DEPLOY_MODE` | Variable (optional) | `pm2`, `systemd` or `docker`; blank auto-detects |
| `PORT` | Variable (optional) | Health-check port, default `4000` |
| `RELOAD_NGINX` | Variable (optional) | `1` to run `nginx -t && systemctl reload nginx` |

Each deploy pulls `origin/main`, installs with `npm ci --include=dev`, runs `prisma generate` + `prisma migrate deploy`, builds API/web, reloads the process (PM2/systemd or Docker Compose), optionally reloads nginx, then health-checks `/api/openapi.json`. Manual runs: `cd /var/www/daraz-hub && bash scripts/deploy.sh` (append `--skip-git` after pulling yourself). Keep **one** server instance running the sync workers against the database, and back up the database before applying migrations.



## Security and operations

- Passwords are stored as bcrypt hashes. Access JWTs are held in browser memory; refresh credentials are held in an HttpOnly cookie and represented in the database by a SHA-256 hash.
- Daraz access and refresh tokens are encrypted with AES-256-GCM before database storage. They are omitted from ordinary API responses and exposed only through the owner-only on-demand token endpoint; administrator views do not reveal them. Token reveals are recorded in the audit log.
- OAuth state is random, expiring, single-use, bound to a user/store, and bound to the initiating browser in production.
- Store operations enforce ownership in database queries; administrator operations additionally enforce the admin role.
- The API uses Helmet, credentialed CORS restricted to `APP_ORIGIN`, JSON request-size limits, and rate limits on authentication and Daraz refresh/profile operations.
- Daraz errors are sanitized before logging or returning to clients. Never commit `.env`, database URLs, JWT secrets, encryption keys, or Daraz app secrets.
- Keep the encryption key available to restore access to existing encrypted tokens. Back up the database and key securely together. A key rotation requires decrypting and re-encrypting existing tokens before replacing the old key.
- Refresh tokens are not refreshed in the background. Monitor expiry metadata and use the application's refresh/reconnect actions.

## Tests and build

```sh
npm test       # Run Vitest tests
npm run build  # TypeScript check and optimized Vite production build
```

Other project commands:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run API and Vite concurrently. |
| `npm run dev:api` | Run the API in watch mode. |
| `npm run dev:web` | Run the Vite web client. |
| `npm run start` | Start the compiled server from `dist`. |
| `npm run db:generate` | Generate the Prisma client. |
| `npm run db:migrate` | Apply committed migrations. |
| `npm run db:seed` | Create the initial administrator if it does not already exist. |

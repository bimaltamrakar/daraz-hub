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
- Scheduled and manual order sync with per-store start date and frequency settings.
- Paginated orders page with store, status, date, and text filters plus sortable columns.
- Product master populated from the Daraz seller catalog and order items.
- Complete raw JSON payload retention for each Daraz order-detail and product-detail response.
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
| `ProductMaster` | Per-store product identity and searchable fields plus the complete JSON response from Daraz's product-detail endpoint. |
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

Order sync uses the signed `GET /orders/get` list endpoint followed by `GET /order/get` for each order. Every order-list request includes Daraz's case-sensitive `CreatedAfter` parameter, together with `limit`, `offset`, and `sort_by`. The initial cursor is the configured sync start date; after a successful order-list pass, the greatest `created_at` timestamp in its responses is saved as the cursor and reused for the next run. Changing the configured start date resets this cursor. Product master sync pages through `GET /products/get` with `filter=all` and a page limit of 50, then requests `GET /product/item/get` for catalog products and products referenced by changed orders. Product catalog updates use `update_after` with a one-minute overlap. Confirm that the Daraz application has order and product read permissions enabled for each marketplace.

OAuth state is single-use and expires according to `OAUTH_STATE_TTL_MINUTES`. It is also bound to the initiating browser using the short-lived, HttpOnly `daraz_oauth_state` cookie. In production, callbacks without the matching browser cookie are rejected. In non-production environments the mismatch is logged instead, to support development setups where the callback tunnel and Vite run on different hosts.

## Using the application

### User workspace

- **Overview (`/`)** — store totals and a summary of connected, expiring-soon, and expired stores; shows up to three recent stores.
- **My stores (`/stores`)** — add, list, connect, refresh, and remove your stores.
- **Store details (`/stores/:id`)** — inspect seller profile, token expiry, errors, and recent activity; retry seller-profile retrieval; connect, refresh, or remove the store; configure order sync start date and frequency; view sync status; and queue a manual sync.
- **Orders (`/orders`)** — browse your synced orders with store, text, order status, delivery status, and created-date filters; sortable columns and server-side pagination.
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

For each order returned by Daraz's order-list endpoint, the sync fetches order details and stores the full JSON response in `StoreOrder.rawDetails`, along with normalized fields used by the Orders list. It pages through the store's seller product catalog and fetches product details for catalog items and order line items; each full JSON response is stored in `ProductMaster.rawDetails`. Product master records are scoped to a store, since seller listing data and inventory are marketplace/store-specific. Raw payloads can contain customer or seller data and are only returned by the owner-scoped order/product detail API.

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
| `GET /api/stores` | No body | `200`; current user's stores, with token values omitted. |
| `POST /api/stores` | `{ "label": "Kathmandu Outlet", "country": "NP" }` | `201`; creates a pending store. Label is required (1–100 characters); country is a two-letter code and is normalized to uppercase. |
| `GET /api/stores/:id` | No body | `200`; owned store details and up to 20 recent activity entries; `404` if absent or not owned by the user. |
| `GET /api/stores/:id/tokens` | No body | `200`; returns plaintext credentials only after an explicit request by the store owner. Rate-limited and non-cacheable. |
| `DELETE /api/stores/:id` | No body | `204`; deletes the owned store and its dependent credentials. |
| `POST /api/stores/:id/connect` | No body | `200`; `{ "authorizationUrl": "..." }`. Returns `404` if the store is not owned/found and `503` if the region is not configured or OAuth cannot be started. |
| `POST /api/stores/:id/refresh` | No body | `200`; updated token expiry metadata only. Returns `404` if not found, `409` if a usable refresh token is unavailable, or `502` if Daraz rejects/fails the refresh. |
| `POST /api/stores/:id/profile` | No body | `200`; updated store profile. Returns `404` if not found, `409` if there is no valid access token, or `502` if Daraz profile retrieval fails. |
| `PATCH /api/stores/:id/order-sync-settings` | `{ "fromDate": "2026-01-01", "frequency": "hourly" }` | `200`; updated store sync settings. Frequencies: `manual`, `every_15_minutes`, `hourly`, `every_6_hours`, `daily`. Dates are UTC calendar dates and cannot be in the future. |
| `POST /api/stores/:id/orders/sync` | No body | `202`; queues an order and product sync. Returns `409` if the store is not connected or a sync is already running. |

### Orders and product master

| Method and path | Request | Success |
| --- | --- | --- |
| `GET /api/orders` | Query: `page`, `pageSize` (max 100), `storeId`, `search`, `orderStatus`, `deliveryStatus`, `from`, `to`, `sortBy`, `sortOrder`. | `200`; `{ orders, page, pageSize, total, totalPages }`. Search matches order ID, customer name, and tracking number. Sorting uses an allowlisted normalized field. All rows are restricted to the signed-in user's stores. |
| `GET /api/orders/:id` | No body | `200`; normalized fields and complete Daraz order-detail JSON in `rawDetails`. |
| `GET /api/products` | Query: `page`, `pageSize` (max 100), `storeId`, `search`. | `200`; paginated product master fields, scoped to the signed-in user's stores. Search matches Daraz item ID, seller SKU, and product name. |
| `GET /api/products/:id` | No body | `200`; product master record including the complete Daraz product-detail response in `rawDetails`. |

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
